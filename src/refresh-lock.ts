/**
 * 跨进程的续期互斥锁。
 *
 * ## 为什么需要它
 *
 * refresh_token 是**一次性**的：刷一次上游就轮换一次，旧的立刻作废。本机同时有
 * 两个写入方 —— DSH 里的插件（`auth.ts` 的 `AccountSlot.runRefresh`）和常驻守护进程
 * （`keeper-main.ts` 的 `tick`）。两者只要在同一秒各刷一次，后刷的那个必然拿到
 * `HTTP 400 STS5.1806 the refresh token has been used`，然后被当成「凭证坏了」判死。
 *
 * 2026-11-18 00:06（UTC 11-17T16:06:57Z）就是这样：两个账号同时续期成功写回
 * `expires 02:06`，同一秒两边又各刷一次，4 条 `STS5.1806` 之后两条路径都走
 * `markStale`，只能全部重新登录。
 *
 * ## 为什么不是「心跳判活」
 *
 * 之前靠 `keeperStats()`（心跳 90 秒内 + pid 存活）猜「守护进程在不在，该不该让路」。
 * 那是**估计**，永远有竞态：心跳是 30 秒一写的独立定时器，一轮 tick 只有几毫秒，
 * 两个判据在边界上对不齐就会同时动手。而且它管不了「谁先谁后」，只管「谁该让」。
 *
 * 换成锁之后语义就硬了：**同一时刻只有一个进程能拿 refresh_token 去撞上游**，
 * 另一方最多等 `WAIT_MS`，等不到就放弃这一轮（下一轮再来）。拿锁的一方写盘之后，
 * 等锁的一方重读磁盘就能拿到新令牌，不再会「撞上已用过的旧令牌」。
 *
 * ## 锁的实现
 *
 * `open(path, 'wx')` 在 NTFS 和 POSIX 上都是原子的「不存在才创建」，所以谁创建成功
 * 谁拿锁。进程被 kill 时锁文件会留在盘上，靠里面的 `{ pid, at }` 判定过期：
 *
 *  - `at` 超过 `STALE_MS`：过期（正常续期一次最多几秒，给到 90 秒）；
 *  - pid 已经不在了：过期（Windows 上 pid 会被复用，所以还要求 `at` 别太新）；
 *  - 两种都成立才删，删之前再核对一次内容，避免把别人刚拿到的新锁删掉。
 *
 * 锁超时/写失败都只是「这一轮别刷」，**绝不允许**抛到续期主流程里把账号判死。
 *
 * @module dsh-codearts/refresh-lock
 */

import { execFileSync } from 'node:child_process'
import { open, readFile, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 锁文件里长期不更新就算陈旧的时长（一次续期正常只需几秒）。 */
export const REFRESH_LOCK_STALE_MS = 90_000

/** 抢锁时最多等多久。等不到就放弃这一轮 —— 刷新不是必须当场完成的事。 */
export const REFRESH_LOCK_WAIT_MS = 20_000

/** Windows 上探活要起一次 tasklist：超时按毫秒给足，卡住就按「活着」处理。 */
const PID_PROBE_TIMEOUT_MS = 5_000

/** 抢锁的轮询间隔（带上少量抖动，避免两个进程同拍重试）。 */
const POLL_MS = 60

/** 持锁期间的重申间隔：一次续期里超过这个时长没重申，别人就可以认定我们死了。 */
const RENEW_MS = 20_000

export interface RefreshLockFile {
  /** 持锁进程的 pid。 */
  pid: number
  /** 拿锁时刻（epoch ms）。 */
  at: number
}

/** 锁文件路径：与账号文档同目录，保证同一份凭证只有一个锁。 */
export function refreshLockPath(home: string): string {
  return join(home, '.codearts-refresh.lock')
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 判断某个 pid 是否还活着。
 *
 * **绝不能用 `process.kill(pid, 0)`**：这个技巧只在 POSIX 上成立。Windows 上 Node 的
 * 实现不看信号值，直接用 `TerminateProcess` —— `kill(pid, 0)` 会把那个进程**直接杀掉**
 * （实测：同步执行的两段代码互相探活，持锁那一段被当场干掉，锁一直留到 90 秒超时）。
 * 续期锁要探的正是插件自己或守护进程，杀掉它们就是杀掉登录态本身。
 *
 * 这里改用 Windows 自带的 tasklist 查表；POSIX 上继续用 `kill(pid, 0)`。
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0)
      return true
    } catch (error: unknown) {
      // EPERM = 进程在，只是不归我们管；ESRCH 才是真的没了。
      return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
    }
  }
  if (pid === process.pid) return true
  try {
    // 只过滤、不看输出内容：`/FI "PID eq N"` 命中时 tasklist 退出码仍是 0，
    // 所以判据是「有输出行」而不是退出码。
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PID_PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    return /\b\d+/.test(out) && out.includes(String(pid))
  } catch {
    // 查不到就当活着：宁可让调用方多等一个 REFRESH_LOCK_STALE_MS 后靠时间判陈旧，
    // 也不要因为一次 tasklist 失败就去删别人的锁。
    return true
  }
}

/** 读锁文件；读不到/内容坏掉都返回 undefined（坏锁当成「可以清掉」）。 */
async function readLock(path: string): Promise<RefreshLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<RefreshLockFile>
    if (typeof parsed.pid === 'number' && typeof parsed.at === 'number') {
      return { pid: parsed.pid, at: parsed.at }
    }
  } catch {
    // 文件不存在，或内容是半截 JSON（写锁时被杀）。都走下面的清理。
  }
  return undefined
}

/**
 * 这个锁还能不能算数。
 *
 * pid 复用是 Windows 上的真实风险：被 kill 的进程留下的 pid 很快会分给新进程，
 * 只看 `pidAlive` 会把死锁当成活锁，永远抢不到。所以「pid 还活着」也要配上
 * `at` 在合理范围内才算活着。
 */
function isStale(lock: RefreshLockFile, now: number): boolean {
  if (now - lock.at > REFRESH_LOCK_STALE_MS) return true
  return !pidAlive(lock.pid)
}

/**
 * 清掉一个陈旧锁。
 *
 * 删之前重读一次内容、和刚才判定时逐字段比对：中间可能有人刚抢到新锁，
 * 那就不许删（删了会让两个进程同时持锁，比不加锁更糟）。
 */
async function breakStale(path: string, seen: RefreshLockFile | undefined): Promise<void> {
  const now = await readLock(path)
  // 内容和当初判定时不一样 ⇒ 现在是别人的新锁。
  if (now !== undefined && seen !== undefined && (now.pid !== seen.pid || now.at !== seen.at)) return
  // 读回来 undefined 也可能是「已经被人删掉了」，unlink 失败是正常的。
  try {
    await unlink(path)
  } catch {
    // 别人先删了：下一轮再抢就是。
  }
}

/**
 * 抢锁。拿到了返回释放函数，等不到返回 undefined。
 *
 * 调用方**必须**在 `finally` 里释放（或依赖它自己超时 —— 不释放只是让别人多等
 * 一个 `REFRESH_LOCK_STALE_MS`，不会把锁永久卡死）。
 */
export async function acquireRefreshLock(
  path: string,
  options: { waitMs?: number; now?: () => number } = {},
): Promise<(() => Promise<void>) | undefined> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.waitMs ?? REFRESH_LOCK_WAIT_MS)
  for (;;) {
    const payload: RefreshLockFile = { pid: process.pid, at: now() }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(payload))
      await handle.close()
      handle = undefined
      return releaser(path, payload)
    } catch (error: unknown) {
      await handle?.close().catch(() => {})
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'EEXIST') {
        // 目录不存在之类的「拿不到锁」：这一轮别刷，但别把错误抛进续期主流程。
        return undefined
      }
    }
    const held = await readLock(path)
    if (held === undefined || isStale(held, now())) {
      await breakStale(path, held)
      continue
    }
    if (now() >= deadline) return undefined
    await sleep(POLL_MS + Math.floor(Math.random() * POLL_MS))
  }
}

function releaser(path: string, payload: RefreshLockFile): () => Promise<void> {
  let released = false
  // 续期可能超过 REFRESH_LOCK_STALE_MS（慢请求 + 重试），持锁期间定期重申「我还在」。
  //
  // 必须把 `at` 真的写回文件，只是 `utimes` 不够：陈旧判定读的是文件内容里的 `at`。
  // 原地重写自己那份是安全的 —— 这个文件只有持锁者会碰。
  const renew = setInterval(() => {
    if (released) return
    payload.at = Date.now()
    void writeFile(path, JSON.stringify(payload), { mode: 0o600 })
      .then(() => utimes(path, new Date(), new Date()))
      .catch(() => {})
  }, RENEW_MS)
  renew.unref?.()
  return async (): Promise<void> => {
    if (released) return
    released = true
    clearInterval(renew)
    // 只删自己的锁：中间超时被别人抢走的话，这里删的就是别人的。
    const now_ = await readLock(path)
    if (now_ !== undefined && now_.pid !== payload.pid) return
    try {
      await unlink(path)
    } catch {
      // 已经没了。
    }
  }
}

/**
 * 拿着锁做一件事。
 *
 * 拿不到锁返回 `undefined` —— 调用方据此知道「这一轮没轮到我们，什么都不用做」，
 * 而不是把「没刷成」当成「刷新失败」（后者会误判 stale）。
 */
export async function withRefreshLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { waitMs?: number; onBusy?: () => void } = {},
): Promise<T | undefined> {
  const release = await acquireRefreshLock(path, options)
  if (release === undefined) {
    options.onBusy?.()
    return undefined
  }
  try {
    return await fn()
  } finally {
    await release()
  }
}
