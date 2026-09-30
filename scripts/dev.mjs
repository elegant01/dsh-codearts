#!/usr/bin/env node
/**
 * 一条命令的开发循环：tsdown watch → 包客户端 bundle → 原地部署进 profile。
 *
 * 为什么不是 `pnpm run build && node scripts/deploy.mjs`：
 *   改一次代码就要手动重跑两步、再退出 DSH 重启，非常费事。本脚本把手动步骤压成
 *   「存盘」，剩下的交给 DSH 自己的两条热重载链路：
 *
 *   宿主侧（provider / shim / 工具等 src/*.ts）：
 *     靠 `@deepseek-ai/dsh-hmr` 的模块监听。需要先用 `node scripts/hmr.mjs on`
 *     把插件部署目录加进 hmr 的 `root`，否则 hmr 只盯着 profile 配置。
 *     hmr 只认 chokidar 的 `change` 事件，所以 deploy 必须**原地覆盖**写文件。
 *
 *   客户端侧（src/client/*.tsx 卡片 UI）：
 *     靠 `@deepseek-ai/dsh-client-hmr`。它 stat 轮询插件声明的客户端产物
 *     （lib/client/index.js），mtime/大小一变就通过 /plugins/events 通知浏览器
 *     重新执行 bundle —— 不用刷新页面，也不用重启 DSH。
 *
 * 仍然需要重启 DSH 的情况：改 package.json 的 dsh.* 清单、新增/删除插件条目、
 * 换包版本。改这些时本脚本会照常部署，但宿主只在重启时重新读取。
 *
 * 用法：
 *   pnpm run dev                 # 监听 + 自动部署（Ctrl-C 退出）
 *   pnpm run dev -- --once       # 只构建并部署一次（等价于旧的 build + deploy）
 *   pnpm run dev -- <profileDir> # 指定 profile，默认 <用户目录>/.dsh/profiles/desktop
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { SOURCE_DIR, defaultProfileDir, deploy } from './deploy.mjs'

const argv = process.argv.slice(2)
const once = argv.includes('--once')
const profileDir = argv.find((arg) => !arg.startsWith('--')) ?? defaultProfileDir()
const isWindows = process.platform === 'win32'
const SRC_LIB = join(SOURCE_DIR, 'lib')

/** 定位 tsdown 可执行文件：优先本地 .bin，退回到 PATH。 */
function tsdownCommand() {
  const bin = join(SOURCE_DIR, 'node_modules', '.bin', isWindows ? 'tsdown.cmd' : 'tsdown')
  return existsSync(bin) ? bin : 'tsdown'
}

/** 跑 wrap-client，把 CJS 产物包成 DSH 期望的自注册形态。 */
function wrapClient() {
  const cjs = join(SRC_LIB, 'client', 'index.cjs')
  if (!existsSync(cjs)) return false // 这轮还没产出 client（或已包过），跳过
  const result = spawnSync(process.execPath, [join(SOURCE_DIR, 'scripts', 'wrap-client.mjs')], {
    stdio: 'inherit',
    cwd: SOURCE_DIR,
  })
  return result.status === 0
}

/** lib/ 的粗略指纹（文件名 + 大小 + mtime），用来判断产物是否真的变了。 */
function fingerprint() {
  const parts = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else parts.push(`${name}:${st.size}:${st.mtimeMs}`)
    }
  }
  if (existsSync(SRC_LIB)) walk(SRC_LIB)
  return parts.sort().join('|')
}

let lastFingerprint = ''

/** 一次「构建产物 → 部署」的收尾。产物没变就直接返回，不 spawn、不部署、不刷屏。 */
function settle(reason, options = {}) {
  const force = options.force === true
  if (!existsSync(SRC_LIB) || readdirSync(SRC_LIB).length === 0) {
    if (force) console.log('· lib/ 还没产物（首次构建进行中），稍后自动重试')
    return { changed: false, skipped: 'no-lib' }
  }
  const current = fingerprint()
  if (!force && current === lastFingerprint && lastFingerprint !== '') {
    return { changed: false, skipped: 'unchanged' }
  }
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  try {
    wrapClient() // 会往 lib/client 写自注册产物，所以指纹在它之后再取
    const summary = deploy({ profileDir, quiet: true })
    const { added, updated, pruned, unchanged } = summary.files
    const touched = added + updated + pruned
    if (touched === 0 && unchanged > 0) {
      console.log(`[${stamp}] ${reason} → 产物无有效变化，跳过部署`)
      lastFingerprint = fingerprint()
      return { changed: false, skipped: 'no-effective-change' }
    }
    console.log(`[${stamp}] ${reason} → 已部署（新增 ${added} / 覆盖 ${updated} / 清理 ${pruned}）`)
    lastFingerprint = fingerprint()
    return { changed: true }
  } catch (error) {
    console.error(`[${stamp}] ${reason} → 部署失败: ${error.message}`)
    return { changed: false, error: error.message }
  }
}

/** 一次性模式：构建一次，然后收尾退出。 */
function runOnce() {
  console.log('→ 单次构建（tsdown，非 watch）…')
  const build = spawnSync(tsdownCommand(), [], { stdio: 'inherit', cwd: SOURCE_DIR, shell: isWindows })
  if (build.status !== 0) {
    console.error('构建失败，未部署。')
    process.exit(build.status ?? 1)
  }
  settle('单次构建完成', { force: true })
  return 0
}

/**
 * 监听 lib/ 的变化（Windows/macOS 用递归 watch，其他平台退回轮询）。
 *
 * 两个实测踩过的坑，这里都绕开了：
 *  1. 防抖不能「每来一个事件就顺延」，否则重建期间事件连成一串时结算会被无限推迟，
 *     deploy 永远不执行 —— 改成第一个事件排期、期间事件只记一次 pending。
 *  2. 事件数不等于产物变化：构建清理目录时能瞬间刷出上万个 rename 事件，
 *     若每个事件都触发一次 spawn + 部署，就成了空转。所以结算前先比对内容指纹，
 *     指纹没变就直接返回，并逐次退避（400ms → 最多 5s），空转时安静下来。
 */
function startLibWatcher(onSettled) {
  const debug = process.env.DSH_CODEARTS_DEV_DEBUG === '1'
  const BASE_MS = 400
  const MAX_MS = 5000
  let delay = BASE_MS
  let timer
  let running = false
  let pending = false
  let eventCount = 0
  let stormReported = false

  const run = () => {
    timer = undefined
    if (running) {
      pending = true
      return
    }
    running = true
    const burst = eventCount
    eventCount = 0
    try {
      const result = onSettled()
      if (result?.changed) {
        delay = BASE_MS // 真的部署了，回到最灵敏的节奏
        stormReported = false
      } else {
        delay = Math.min(delay * 2, MAX_MS) // 空转就退避，别白白刷盘
        if (burst > 500 && !stormReported) {
          stormReported = true
          if (debug) {
            console.log(
              `[debug] 一轮收到 ${burst} 个产物事件但内容没变，已退避到 ${delay}ms（构建清理目录时的正常现象）`,
            )
          }
        }
      }
    } finally {
      running = false
      if (pending) {
        pending = false
        schedule()
      }
    }
  }

  const schedule = () => {
    if (timer !== undefined) return // 已有排期就不推迟，保证一定会跑到
    timer = setTimeout(run, delay)
  }

  try {
    const watcher = watch(SRC_LIB, { recursive: true }, (event, file) => {
      eventCount++
      if (debug) console.log(`[debug] fs.watch ${event} ${file}`)
      schedule()
    })
    if (debug) console.log(`[debug] 已监听 ${SRC_LIB}（基础间隔 ${BASE_MS}ms）`)
    return () => watcher.close()
  } catch (error) {
    console.log(`· 递归 watch 不可用（${error.message}），退回 1s 轮询。`)
    let snapshot = fingerprint()
    const pollTimer = setInterval(() => {
      const next = fingerprint()
      if (next === snapshot) return
      snapshot = next
      eventCount++
      schedule()
    }, 1000)
    return () => clearInterval(pollTimer)
  }
}

function main() {
  if (once) process.exit(runOnce())

  console.log('dsh-codearts dev')
  console.log(`  profile:    ${profileDir}`)
  console.log('  宿主侧改动: 需要 hmr 模块监听（node scripts/hmr.mjs on）才会热重载')
  console.log('  客户端改动: 由 dsh-client-hmr 自动替换，无需刷新页面')
  console.log('  改 package.json 的 dsh.* / 换版本仍然要重启 DSH')
  console.log('')

  const tsdown = spawn(tsdownCommand(), ['--watch'], {
    stdio: 'inherit',
    cwd: SOURCE_DIR,
    shell: isWindows,
  })
  tsdown.on('exit', (code) => {
    if (code !== 0) {
      console.error(`tsdown --watch 退出（code ${code}）；若提示找不到 tsdown，请改用 pnpm run dev。`)
    }
    process.exit(code ?? 0)
  })

  const stopWatching = startLibWatcher(() => settle('检测到产物变化'))
  const shutdown = () => {
    stopWatching()
    tsdown.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
