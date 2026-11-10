/**
 * dsh-codearts 凭证守护进程（独立入口，由 DSH 用 `ELECTRON_RUN_AS_NODE=1` 拉起）。
 *
 * 它只做一件事：**在 DSH 关掉之后，继续把 refresh_token 续下去**，这样第二天打开
 * DSH 不必重新登录。DSH 开着的时候它同样活着，但续期的**独占权**在它手里
 * （见 `keeper.ts` 的模块注释：refresh_token 一次性，两边同时刷会把号刷成 stale）。
 *
 * 进程形态上的三条硬要求，缺一条这个功能就不成立：
 *
 *  1. `detached: true` —— 不跟着 DSH 的进程组一起被回收；
 *  2. `child.unref()` —— 父进程的事件循环不为它续命；
 *  3. `stdio: 'ignore'` —— 父进程退出后管道断了，子孙进程写 stdout 会 EPIPE。
 *
 * 三条都在 `keeper.ts` 的 `spawnKeeper` 里。本文件只被当作独立入口跑，
 * **不要从插件主流程 import 它**（import 会顺手执行监听逻辑）。
 *
 * @module dsh-codearts/keeper-main
 */

import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
import {
  KEEPER_HEARTBEAT_MS,
  KEEPER_TICK_MS,
  clearKeeperState,
  keeperLogPath,
  keeperStatePath,
  readKeeperState,
  stopRequested,
  writeKeeperState,
  type CodeArtsKeeperState,
} from './keeper.ts'
import { readAccountDocument, writeJsonAtomic, codeartsAccountsPath } from './auth.ts'
import { refreshToken, defaultLoginConfig } from './oauth.ts'

/** 单次续期的预算：慢请求不能把整轮堵死。 */
const REFRESH_TIMEOUT_MS = 30_000

/** 距过期不足这么久就续（与服务端插件保持一致）。 */
const REFRESH_SKEW_MS = 30 * 60 * 1000

function parseHomeArg(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--home')
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]
  return undefined
}

const home = parseHomeArg(process.argv.slice(2))
const logPath = keeperLogPath(home)

/** 只往日志里写人能看懂的一行；绝不写 token/refresh_token/私钥。 */
function log(message: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
  } catch {
    // 日志写不进去也不能死：续期才是主业。
  }
}

/**
 * 只有一份守护进程。
 *
 * 从卡片连点两次、或同时开两个 DSH 窗口时，第二次 spawn 必须让路 —— 两个进程同时
 * 刷 refresh_token 就是上面说的那个翻车场景。
 */
function alreadyRunning(): number | undefined {
  const state = readKeeperState(home)
  if (state === undefined) return undefined
  if (state.pid === process.pid) return undefined
  try {
    process.kill(state.pid, 0)
    return state.pid
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM' ? state.pid : undefined
  }
}

/**
 * 一轮续期：读文档 → 逐个续 → 写回。
 *
 * 每轮都重新读盘，而不是启动时读一次：DSH 在运行期间会登录新账号、删账号、写新
 * 凭证，守护进程必须看见这些变化，否则会把一份过期的内存快照写回去，把刚登录的
 * 号覆盖掉。
 */
async function tick(state: CodeArtsKeeperState): Promise<void> {
  const accountsPath = codeartsAccountsPath(home)
  const doc = await readAccountDocument(accountsPath)
  if (doc === undefined) {
    state.lastPass = { at: Date.now(), checked: 0, refreshed: 0, needsLogin: [] }
    return
  }
  const needsLogin: string[] = []
  let refreshed = 0
  let checked = 0
  let dirty = false

  for (const id of doc.order) {
    const cred = doc.accounts[id]
    if (cred === undefined) continue
    if (cred.stale === true) {
      needsLogin.push(id)
      continue
    }
    // 没有续期材料就不是这个进程能救的（比如手工粘贴的裸 token）。
    if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) continue
    const exp = cred.expiration ? Date.parse(cred.expiration) : NaN
    // 过期时间读不出来就别乱刷：宁可等 DSH 那边真正要用的时候走 invalid_iam_token 兜底。
    if (Number.isNaN(exp)) continue
    // 还没进续期窗口：跳过。refresh_token 一次性，多余的刷新只会多一次失败风险。
    if (exp - Date.now() >= REFRESH_SKEW_MS) continue

    checked += 1
    try {
      const next = await refreshToken(defaultLoginConfig(), {
        userId: cred.userId ?? '',
        userName: cred.userName ?? '',
        domainId: '',
        securityToken: cred.token,
        accessKeyId: cred.accessKeyId ?? '',
        secretAccessKey: cred.secretAccessKey ?? '',
        expiration: cred.expiration ?? '',
        refreshToken: cred.refreshToken,
        clientId: cred.clientId,
        dpopPrivateKey: cred.dpopPrivateKey,
      })
      doc.accounts[id] = {
        ...cred,
        token: next.securityToken,
        accessKeyId: next.accessKeyId,
        secretAccessKey: next.secretAccessKey,
        refreshToken: next.refreshToken === '' ? cred.refreshToken : next.refreshToken,
        dpopPrivateKey: next.dpopPrivateKey,
        clientId: next.clientId,
        expiration: next.expiration,
        storedAt: Date.now(),
        stale: false,
      }
      dirty = true
      refreshed += 1
      log(`refreshed ${id.slice(0, 12)} → expires ${next.expiration}`)
    } catch (error: unknown) {
      // 续期失败标记 stale 落库：让卡片明确提示「要重新登录」，而不是拿过期凭证硬用。
      doc.accounts[id] = { ...cred, stale: true }
      dirty = true
      needsLogin.push(id)
      log(`refresh FAILED ${id.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (dirty) {
    // 整份写回：DSH 可能刚也在写同一个文件，这里读-改-写的时间窗很窄，且两侧都走
    // 同一个原子写（writeJsonAtomic），最坏情况是某一方的改动被下一次读到补齐。
    await writeJsonAtomic(accountsPath, doc)
  }
  state.lastPass = { at: Date.now(), checked, refreshed, needsLogin }
  if (refreshed > 0 || needsLogin.length > 0) {
    log(`pass done: checked=${checked} refreshed=${refreshed} needsLogin=${needsLogin.length}`)
  }
}

async function main(): Promise<void> {
  // 单实例：已经有一份在跑就立刻退出，别让两个进程抢同一个 refresh_token。
  const other = alreadyRunning()
  if (other !== undefined) {
    log(`another keeper is already running (pid ${other}); exiting`)
    process.exit(0)
  }

  const state: CodeArtsKeeperState = {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    ...process.env.DSH_CODEARTS_PLUGIN_VERSION === undefined
      ? {}
      : { pluginVersion: process.env.DSH_CODEARTS_PLUGIN_VERSION },
  }
  // 起来先写一次：卡片那边可能正好在这时读，早一点有 pid 显示比晚一点好。
  writeKeeperState(state, home)
  log(`keeper started pid=${process.pid}`)

  let stopped = false
  const shutdown = (reason: string): void => {
    if (stopped) return
    stopped = true
    log(`keeper stopping: ${reason}`)
    clearKeeperState(home)
    process.exit(0)
  }

  // 被 kill（正是用户会按的那个按钮）时也尽量把状态文件清掉。SIGKILL 抓不住，
  // 所以插件那边判活用「心跳 + pid 存活」，不只靠文件在不在。
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => shutdown(`signal ${signal}`))
  }
  process.on('exit', () => {
    // exit 里只能做同步操作，clearKeeperState 是同步的，可以调。
    if (!stopped) clearKeeperState(home)
  })

  /** 心跳：卡片据此判断「这个 pid 还活着」，也是插件判断能不能让路的依据。 */
  setInterval(() => {
    state.heartbeatAt = Date.now()
    writeKeeperState(state, home)
    // 顺手看一眼停止标记：插件那边点「关闭」就是写这个文件。
    if (stopRequested(home)) shutdown('stop requested by plugin')
  }, KEEPER_HEARTBEAT_MS)
  // 这里**不能** unref：unref 过的定时器不算「还有事要做」，tick 跑完、事件循环空了，
  // node 会立刻正常退出 —— 守护进程活几秒就消失，状态文件都来不及被读到。
  // unref 的用途在父进程侧（`spawnKeeper`），不在守护进程自己身上。

  // 立刻跑一轮：DSH 刚启动时凭证可能已经过期，等 20 分钟才刷就白等了。
  let timer: ReturnType<typeof setTimeout> | undefined
  const loop = async (): Promise<void> => {
    if (stopped) return
    if (stopRequested(home)) {
      shutdown('stop requested by plugin')
      return
    }
    try {
      await tick(state)
    } catch (error: unknown) {
      log(`pass failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    state.heartbeatAt = Date.now()
    writeKeeperState(state, home)
    if (stopped) return
    timer = setTimeout(() => void loop(), KEEPER_TICK_MS)
  }
  void loop()
}

main().catch(error => {
  log(`keeper fatal: ${error instanceof Error ? error.message : String(error)}`)
  // 起不来就把状态文件清掉，否则插件会以为「守护进程在跑」而永远不自己续期。
  try {
    if (existsSync(keeperStatePath(home))) unlinkSync(keeperStatePath(home))
  } catch {
    // 尽力而为。
  }
  process.exit(1)
})
