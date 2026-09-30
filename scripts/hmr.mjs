#!/usr/bin/env node
/**
 * 开关 profile 的「插件模块热重载」。
 *
 * 背景（读 DSH 自带文档与源码得到的事实）：
 *   - `@deepseek-ai/dsh-base` 的 patch 里，`hmr` 条目在带 profileContext 的 profile
 *     （desktop 就是）默认启用，但 `config.root: []` —— 只监听 profile 配置文件，
 *     **不监听模块**，所以改插件代码必须重启 DSH。
 *   - `@deepseek-ai/dsh-hmr` 支持把关心的目录加进 `root`；条目配置来自 profile patch
 *     时是「整份 config 替换」而不是合并，所以 root 和 ignored 必须一起给全。
 *   - `ignored` 的默认值里含一条排除 node_modules 的 glob，且是按「相对 base 目录」
 *     做 picomatch 匹配 —— 插件恰好装在 `node_modules/dsh-codearts`，正好被默认值
 *     排除掉，所以覆盖行里必须把 ignored 显式写成空表。
 *   - 改动只有落到**已加载模块的原地覆盖**上才会被热重载（hmr 只监听 chokidar 的
 *     `change`，不处理 add/unlink），所以 deploy 用的是原地同步。
 *
 * 用法：
 *   node scripts/hmr.mjs on      [profileDir]   # 打开本插件的模块监听（写入覆盖行）
 *   node scripts/hmr.mjs off     [profileDir]   # 关掉，回到 base 默认（只监听配置）
 *   node scripts/hmr.mjs status  [profileDir]   # 看当前状态
 *
 * 写盘一律走 fs.writeFileSync（无 BOM）。profile 里任何 manifest/YAML 沾上 BOM
 * 都会让宿主裸 JSON.parse 崩在启动阶段，所以本脚本写完会复查前 3 字节。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultProfileDir } from './deploy.mjs'

/** 本插件在 profile 里的包名，也是要在 hmr 里监听的目录名。 */
const PKG_NAME = 'dsh-codearts'
/** hmr 条目的 id 与 name（name 与 base 组合包保持一致）。 */
const HMR_ID = 'hmr'
const HMR_NAME = '@deepseek-ai/dsh-hmr'

/**
 * 覆盖行的标记注释。放在条目**内部**，不放条目前面：
 * 按顶层 `- ` 切分时，行前面的注释会被算进上一个条目，于是重复 on 会重复一遍注释、
 * off 又会把注释孤儿化留在文件里。
 */
const MARKER = '# dsh-codearts dev'

/**
 * 要写进 profile patch 的覆盖行。
 * @param {string} eol 与原文件一致的换行符（不把 LF 文件改成 CRLF，也不反过来）
 * @returns {string}
 */
function overrideRow(eol = '\n') {
  return (
    [
      `- id: ${HMR_ID}`,
      `  name: '${HMR_NAME}'`,
      `  disabled: false`,
      `  config:`,
      `    ${MARKER}: 只盯本插件的目录，让宿主侧插件代码改动热重载（scripts/hmr.mjs 写入）。`,
      `    # 关掉用 \`node scripts/hmr.mjs off\`；本条目删掉即回到 base 默认的只监听配置。`,
      `    root:`,
      `      - node_modules/${PKG_NAME}`,
      `    # 必须显式给空表：默认的 ignored 里有一条排除 node_modules 的 glob，会把插件自己排除掉。`,
      `    ignored: []`,
    ].join(eol) + eol
  )
}

/**
 * 按顶层 `- ` 行（第 0 列）切分 YAML 数组文本。
 *
 * 不能用 `text.split(/\r?\n/)` 再重组：末尾换行会切出一个空串，重组时又多写一个，
 * 于是每跑一次就多一个空行（而且每次都判定成「有变化」）。这里按顶层行的起始下标切片，
 * 原件首尾原样保留。
 *
 * @param {string} text
 * @returns {{head: string, eol: string, rows: {text: string, id: string | undefined}[]}}
 */
function splitRows(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const starts = []
  const re = /^-(\s|$)/gm
  let match
  while ((match = re.exec(text)) !== null) starts.push(match.index)
  const head = starts.length > 0 ? text.slice(0, starts[0]) : text
  const rows = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : text.length
    const raw = text.slice(start, end)
    const row = { text: raw, id: undefined }
    const m = /^-\s*id:\s*['"]?([^'"\s]+)['"]?/.exec(raw)
    row.id = m?.[1]
    return row
  })
  return { head, eol, rows }
}

/**
 * 渲染回 YAML 文本：每个条目块去掉尾部空行后统一补一个 eol，保证同样的输入得到同样的
 * 输出（幂等，不产生无谓写盘）。
 *
 * 同时清掉粘在**别的条目**里的本脚本标记行 —— 早期版本把注释写在条目前面，会被切分
 * 逻辑算进上一条；这里顺手把历史遗留收拾干净（本条目自己的标记保留）。
 */
function render(head, rows, eol) {
  const body = rows
    .map((row) => {
      const cleaned =
        row.id === HMR_ID
          ? row.text
          : row.text
              .split(/\r?\n/)
              .filter((line) => !line.includes(MARKER))
              .join(eol)
      return cleaned.replace(/[\s]+$/, '') + eol
    })
    .join('')
  return head + body
}

/**
 * 读 patch 文件；顺手把可能存在的 BOM 去掉（我们自己不写 BOM，但别人可能写进去）。
 * @param {string} path
 */
function readPatch(path) {
  if (!existsSync(path)) {
    throw new Error(`profile patch 不存在: ${path}（这个 profile 还没初始化过？）`)
  }
  let text = readFileSync(path, 'utf8')
  let strippedBom = false
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
    strippedBom = true
  }
  return { text, strippedBom }
}

/** 落盘（无 BOM）并复查。内容没变则不写、不备份。 */
function writePatch(path, next, previous) {
  if (next === previous) return { changed: false }
  const backupPath = `${path}.bak-codearts-${Date.now()}`
  copyFileSync(path, backupPath)
  writeFileSync(path, next, 'utf8')
  const b = readFileSync(path)
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    throw new Error(`写入后检测到 BOM: ${path} —— 已中止，备份在 ${backupPath}`)
  }
  return { changed: true, backup: backupPath }
}

/**
 * @param {'on'|'off'|'status'} action
 * @param {{profileDir?: string}} [options]
 */
export function hmr(action, options = {}) {
  const profileDir = options.profileDir ?? defaultProfileDir()
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const packageDir = join(profileDir, 'node_modules', PKG_NAME)
  const { text, strippedBom } = readPatch(patchPath)
  const { head, eol, rows } = splitRows(text)
  const index = rows.findIndex((row) => row.id === HMR_ID)
  const existing = index >= 0 ? rows[index] : undefined

  if (action === 'status') {
    return {
      profileDir,
      patchPath,
      packageDir,
      packageInstalled: existsSync(packageDir),
      override: existing?.text ?? null,
      strippedBom,
    }
  }

  if (action === 'on') {
    const row = { text: overrideRow(eol), id: HMR_ID }
    const list = [...rows]
    if (index >= 0) list[index] = row
    else list.push(row)
    // render 是幂等的：已经是目标形态时 next === text，writePatch 直接跳过（不写盘、不备份）
    const result = writePatch(patchPath, render(head, list, eol), text)
    return { ...result, profileDir, patchPath, action }
  }

  if (action === 'off') {
    if (index < 0) return { changed: false, profileDir, patchPath, action, absent: true }
    const list = rows.filter((_, i) => i !== index)
    const result = writePatch(patchPath, render(head, list, eol), text)
    return { ...result, profileDir, patchPath, action }
  }

  throw new Error(`未知动作: ${action}（可用 on / off / status）`)
}

/** CLI 入口。 */
function main(argv) {
  const action = argv.find((arg) => !arg.startsWith('--')) ?? 'status'
  const profileDir = argv.filter((arg) => !arg.startsWith('--'))[1] ?? defaultProfileDir()
  if (!['on', 'off', 'status'].includes(action)) {
    console.error(`未知动作: ${action}（可用 on / off / status）`)
    process.exitCode = 1
    return
  }
  try {
    const result = hmr(action, { profileDir })
    if (action === 'status') {
      console.log(`profile:      ${result.profileDir}`)
      console.log(`patch:        ${result.patchPath}${result.strippedBom ? '（读到 BOM，已忽略）' : ''}`)
      console.log(`插件已部署:   ${result.packageInstalled ? '是' : '否（先跑 pnpm run deploy）'}`)
      if (result.override) {
        console.log('模块监听:     已启用（profile patch 里有 hmr 覆盖行）\n')
        console.log(result.override.replace(/^/gm, '  '))
      } else {
        console.log('模块监听:     未启用（hmr 走 base 默认：只监听 profile 配置）')
        console.log(`              打开：node scripts/hmr.mjs on`)
      }
      return
    }
    if (action === 'on') {
      if (result.changed) {
        console.log(`✓ 已写入 hmr 覆盖行（备份：${result.backup}）`)
        console.log('  首次启用可能需要重启一次 DSH；此后改代码只需 pnpm run dev。')
      } else {
        console.log('· 已经是启用状态，无需改动。')
      }
      return
    }
    if (result.absent) console.log('· 本来就没有覆盖行，无需改动。')
    else console.log(`✓ 已移除 hmr 覆盖行（备份：${result.backup}），回到 base 默认：只监听配置。`)
  } catch (error) {
    console.error(`失败: ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
