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

import { appendFileSync, existsSync, unlinkSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KEEPER_HEARTBEAT_MS,
  KEEPER_TICK_MS,
  clearKeeperHandoff,
  clearKeeperState,
  isDshInstallerTempDir,
  keeperLogPath,
  keeperStats,
  keeperStatePath,
  stopRequested,
  writeKeeperHandoff,
  writeKeeperState,
  type CodeArtsKeeperState,
} from './keeper.ts'
import { readAccountDocument, writeJsonAtomic, codeartsAccountsPath } from './auth.ts'
import { refreshToken, defaultLoginConfig, OAuthTokenError } from './oauth.ts'
import { refreshLockPath, withRefreshLock } from './refresh-lock.ts'

/** 单次续期的预算：慢请求不能把整轮堵死。 */
const REFRESH_TIMEOUT_MS = 30_000

/** 距过期不足这么久就续（与服务端插件保持一致）。 */
const REFRESH_SKEW_MS = 30 * 60 * 1000

/**
 * `STS5.1806` 连续撞上几次才判死（与 `auth.ts` 的 `REFRESH_USED_MAX_STREAK` 对齐）。
 *
 * 这个码只说明「这个 refresh_token 已经被用掉了」，最常见的原因是插件刚刚先刷了
 * 一次。磁盘上若已经有新令牌，重读就行；磁盘还没更新（对方正在写）时也会撞上，
 * 那更不能判死 —— 下一轮就恢复正常了。
 */
const USED_MAX_STREAK = 3

/** 睡眠看门狗的检查间隔：机器醒过来最多 30 秒就会补跑一轮。 */
const SLEEP_WATCHDOG_MS = 30_000

/** 超过一个 tick 周期再多这么久还没跑，就认为是睡过去了（给慢机器留余量）。 */
const SLEEP_GAP_GRACE_MS = 5 * 60 * 1000

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
 *
 * 判据用 `keeperStats`（心跳 + pid 都算），不能只看 pid：上一份 keeper 被强杀后
 * 状态文件会留在盘上，而 Windows 很快就把那个 pid 发给别的进程 —— 只探 pid 会
 * 把一个正常的新进程当成「已有 keeper」，于是每次启动都立刻退出（2026-11-16 实测）。
 */
function alreadyRunning(): number | undefined {
  const stats = keeperStats(home)
  if (!stats.alive || stats.state === undefined) return undefined
  if (stats.state.pid === process.pid) return undefined
  return stats.state.pid
}

/**
 * 一轮续期：读文档 → 逐个续 → 写回。
 *
 * 每轮都重新读盘，而不是启动时读一次：DSH 在运行期间会登录新账号、删账号、写新
 * 凭证，守护进程必须看见这些变化，否则会把一份过期的内存快照写回去，把刚登录的
 * 号覆盖掉。
 */

/** 每个账号连续撞上「令牌已被用掉」的次数；成功续上一次就清零。 */
const usedStreak = new Map<string, number>()

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
    // 上面已确认三样续期材料都在，收窄类型给闭包用。
    const refreshTokenValue = cred.refreshToken
    const clientIdValue = cred.clientId
    const dpopPrivateKeyValue = cred.dpopPrivateKey
    if (refreshTokenValue === undefined || clientIdValue === undefined || dpopPrivateKeyValue === undefined) continue
    // 和插件抢同一把锁：refresh_token 一次性，两边同时刷必有一方拿到已作废的值。
    // 拿不到锁说明插件正在刷，这一轮跳过就好 —— 它写回之后下一轮我们能读到新令牌。
    const locked = await withRefreshLock(
      refreshLockPath(dirname(accountsPath)),
      () => refreshToken(defaultLoginConfig(), {
        userId: cred.userId ?? '',
        userName: cred.userName ?? '',
        domainId: '',
        securityToken: cred.token,
        accessKeyId: cred.accessKeyId ?? '',
        secretAccessKey: cred.secretAccessKey ?? '',
        expiration: cred.expiration ?? '',
        refreshToken: refreshTokenValue,
        clientId: clientIdValue,
        dpopPrivateKey: dpopPrivateKeyValue,
      }),
      { onBusy: () => log(`refresh SKIPPED ${id.slice(0, 12)} (plugin holds the refresh lock)`) },
    )
    if (locked === undefined) continue
    try {
      const next = locked
      usedStreak.delete(id)
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
      // refresh token 一次性：插件那边先刷了，我们手里的就是「已用掉」。重读一次
      // 文档看有没有更新的令牌；有就留到下一轮，别把刚写好的新令牌判死。
      const used = error instanceof OAuthTokenError && error.refreshTokenUsed
      let markStale = false
      if (used) {
        const fresh = await readAccountDocument(accountsPath)
        const advanced = fresh !== undefined && fresh.accounts[id]?.refreshToken !== undefined
          && fresh.accounts[id]?.refreshToken !== cred.refreshToken
        const streak = (usedStreak.get(id) ?? 0) + 1
        usedStreak.set(id, streak)
        // 早先这里「磁盘没有更新的令牌」就直接判死，正是 2026-11-18 00:06 两个账号
        // 同时失效的直接原因：插件正在刷、还没写回磁盘的那一小会儿，守护进程读到的
        // 还是旧令牌，于是把两个号一起标成了需要重新登录。现在只有连续撞满
        // USED_MAX_STREAK 轮才认账。
        markStale = !advanced && streak >= USED_MAX_STREAK
        log(`refresh SKIPPED ${id.slice(0, 12)} (refresh token already used${advanced ? ', newer token on disk' : ''}, streak ${streak}/${USED_MAX_STREAK})`)
      } else {
        usedStreak.delete(id)
        // 只有 invalid_grant 这一类才把号判死。网络/超时/5xx/429 留到下一轮（20 分钟）
        // 再试 —— 任何失败就写 stale 会让一次网络抖动变成「必须重新登录」（issue #8）。
        markStale = error instanceof OAuthTokenError && error.permanent
      }
      if (markStale) {
        doc.accounts[id] = { ...cred, stale: true }
        dirty = true
        needsLogin.push(id)
      }
      const reason = error instanceof OAuthTokenError
        ? `HTTP ${error.status} ${error.body.slice(0, 200)}`
        : error instanceof Error ? error.message : String(error)
      log(`refresh FAILED ${id.slice(0, 12)} (${markStale ? 'permanent, marked stale' : 'transient, retry next pass'}): ${reason}`)
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

/**
 * 更新安装器一出现就通知调用方让路。
 *
 * 为什么需要：安装器启动后会枚举进程判断「应用是否已关闭」，keeper 只要还在跑就
 * 可能被当成应用本身，更新在十秒左右中止、也不把应用拉回来（`keeper.ts` 的
 * `bundledNodeExecutable` 注释里有完整现场）。换 node.exe 是主路，这里是双保险 —
 * 安装器就算按安装路径匹配也挡不住。
 *
 * 实现上用 `fs.watch` 盯 `%TEMP%`（事件驱动，不轮询）：只有新出现的 `ns*.tmp`
 * 目录里真有安装器的 `window-frame.dll` 才算数，用户装别的软件不会误伤。
 */
function watchForUpdateInstaller(onSeen: () => void): void {
  if (process.platform !== 'win32') return
  const root = process.env.TEMP ?? process.env.TMP
  if (root === undefined || root === '') return
  const confirm = (name: string, attempt: number): void => {
    if (!name.toLowerCase().startsWith('ns')) return
    const dir = join(root, name)
    if (isDshInstallerTempDir(dir)) {
      onSeen()
      return
    }
    // 插件目录先出现、dll 晚一拍落盘：隔一会儿再看两次。
    if (attempt < 2) setTimeout(() => confirm(name, attempt + 1), 500)
  }
  try {
    watch(root, (_event, filename) => {
      if (filename === null) return
      confirm(String(filename), 0)
    })
  } catch (error: unknown) {
    // 盯不上不影响续期主业，只是少了这层保险。
    log(`installer watch unavailable: ${error instanceof Error ? error.message : String(error)}`)
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

  // 新的一份 keeper 起来了：上一次「为更新让路」的标记已经过时。
  clearKeeperHandoff(home)

  /**
   * 为更新安装让路。
   *
   * 和 `shutdown` 的区别只有一条：留一个「让路」标记。插件看到它会知道这是预期内
   * 的退出，不把「常驻保活」开关关掉 —— 新版应用起来后开关还开着，keeper 会照常被
   * 拉起，用户不会发现自己"被关了保活"。
   */
  const stepAside = (reason: string): void => {
    if (stopped) return
    log(`keeper stepping aside: ${reason}`)
    writeKeeperHandoff(reason, home)
    clearKeeperState(home)
    stopped = true
    process.exit(0)
  }
  watchForUpdateInstaller(() => stepAside('update installer detected'))

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
  let lastPassAt = 0
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
    lastPassAt = Date.now()
    state.heartbeatAt = lastPassAt
    writeKeeperState(state, home)
    if (stopped) return
    timer = setTimeout(() => void loop(), KEEPER_TICK_MS)
  }

  /**
   * 睡眠/休眠补偿：setTimeout 只保证「不早于」，机器睡过去的那段时间它是停摆的。
   *
   * 2026-11-18 的现场：守护进程 pid 全程活着，日志却在 06:46–08:06 之间缺了 4 轮
   * tick —— 机器睡了，定时器跟着停。而插件那边看到心跳文件在、pid 也活，就按
   * `keeperRunning()` 让路，于是两边一起不刷，等醒过来凭证已经过期。
   *
   * 这里每 30 秒对一次表：超过一个 tick 周期没跑过一轮就立刻补一轮。补跑会重排
   * 定时器，所以睡醒后不会连撞两次。
   */
  setInterval(() => {
    if (stopped || timer === undefined) return
    if (Date.now() - lastPassAt < KEEPER_TICK_MS + SLEEP_GAP_GRACE_MS) return
    clearTimeout(timer)
    log(`wake-from-sleep: no pass for ${Math.round((Date.now() - lastPassAt) / 1000)}s, running one now`)
    void loop()
  }, SLEEP_WATCHDOG_MS)

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
