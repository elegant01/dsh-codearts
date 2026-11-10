/**
 * 凭证守护进程：把 refresh_token 交给一个**常驻子进程**去续期。
 *
 * ## 为什么需要它
 *
 * CodeArts 签发的 STS token 有效期是**固定的 2 小时**（实测，见 `auth.ts` 的
 * `REFRESH_SKEW_MS` 注释），而 refresh_token 有 30 天。插件自己的 `keepAliveLoop`
 * 只在 DSH 运行时能跑 —— 用户晚上关掉 DSH，凭证两小时后就过期，第二天打开又要重新
 * 登录。要跨过「DSH 没开」这段时间，续期动作必须发生在 DSH 之外，所以这里起一个
 * 独立的常驻进程。
 *
 * ## 进程形态
 *
 * DSH Desktop 是 Electron，宿主 exe 可以直接当 Node 用：设置
 * `ELECTRON_RUN_AS_NODE=1` 后启动它就是 node 24.21.0（已实测）。所以不依赖用户
 * 装没装 node，也不引入任何原生依赖。启动后 `detached` + `unref` + `stdio:'ignore'`，
 * DSH 退出它不跟着退出（同样已实测）。
 *
 * ## 谁有权续期（重要）
 *
 * refresh_token 是**一次性的**：刷一次就轮换，另一份旧的就作废。如果守护进程和 DSH
 * 插件同时续期，后刷的那次会拿着已作废的 token 失败，并把账号写成 `stale` —— 正是
 * 「隔天就要重新登录」这个症状的成因之一。所以两者**互斥**：
 *
 * - 守护进程活着且心跳新鲜时，**由它独占续期**，插件自己不再刷，只从磁盘重读它写回
 *   的结果；
 * - 守护进程不在（被 kill、崩溃、从未开启）时，插件恢复自己刷。
 *
 * 判据就是心跳文件 `~/.dsh/.codearts-keeper.json` 的 `heartbeatAt` 与那个 `pid` 是否
 * 还在 —— 光看文件不够，进程被 kill 时来不及写任何东西，文件会留成「看起来很新鲜」。
 *
 * @module dsh-codearts/keeper
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 心跳超过这么久没更新，就认为守护进程已经不在（它每 30 秒写一次）。 */
export const KEEPER_STALE_MS = 90_000

/** 心跳写入间隔。 */
export const KEEPER_HEARTBEAT_MS = 30_000

/** 守护进程的续期节奏：每 20 分钟过一遍，与插件里的 `KEEP_ALIVE_INTERVAL_MS` 对齐。 */
export const KEEPER_TICK_MS = 20 * 60 * 1000

/** 距过期不足这么久就提前续（与 `auth.ts` 的 `REFRESH_SKEW_MS` 对齐）。 */
export const KEEPER_REFRESH_SKEW_MS = 30 * 60 * 1000

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 心跳/状态文件：`~/.dsh/.codearts-keeper.json`。 */
export function keeperStatePath(home?: string): string {
  return join(home ?? dshHome(), '.codearts-keeper.json')
}

/** 守护进程自己的日志（stdout 被 ignore 了，出问题只能看这里）。 */
export function keeperLogPath(home?: string): string {
  return join(home ?? dshHome(), '.codearts-keeper.log')
}

/**
 * 守护进程的状态文件内容。
 *
 * 刻意只放「能给人看」的字段：绝不落 token、refresh_token 或任何私钥材料。
 */
export interface CodeArtsKeeperState {
  version: 1
  /** 守护进程的 pid（卡片上显示它，kill 也用它）。 */
  pid: number
  /** 启动时刻（epoch ms）。 */
  startedAt: number
  /** 最后一次心跳（epoch ms）。 */
  heartbeatAt: number
  /** 写这个文件的插件版本，升级后便于对不上时排查。 */
  pluginVersion?: string
  /** 最近一轮续期：检查了几个、续了几个、哪些号需要重新登录。 */
  lastPass?: {
    at: number
    checked: number
    refreshed: number
    needsLogin: string[]
  }
}

/** 读状态文件；读不到/格式不对都返回 undefined（不抛）。 */
export function readKeeperState(home?: string): CodeArtsKeeperState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(keeperStatePath(home), 'utf8')) as Partial<CodeArtsKeeperState>
    if (typeof parsed.pid !== 'number' || typeof parsed.heartbeatAt !== 'number') return undefined
    return {
      version: 1,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : parsed.heartbeatAt,
      heartbeatAt: parsed.heartbeatAt,
      ...parsed.pluginVersion === undefined ? {} : { pluginVersion: parsed.pluginVersion },
      ...parsed.lastPass === undefined ? {} : { lastPass: parsed.lastPass },
    }
  } catch {
    return undefined
  }
}

export function writeKeeperState(state: CodeArtsKeeperState, home?: string): void {
  try {
    writeFileSync(keeperStatePath(home), JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch {
    // 心跳写不进去不该让守护进程自杀：续期本身还在正常工作。
  }
}

/** 进程还在吗。信号 0 只探活，不真的发信号（Windows 上同样适用）。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM = 进程在，只是不归我们管；ESRCH 才是真的没了。
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  }
}

/** 状态文件的 mtime（用来判断账号文档是不是被守护进程改过）。 */
export function keeperStats(home?: string): { alive: boolean; state?: CodeArtsKeeperState } {
  const state = readKeeperState(home)
  if (state === undefined) return { alive: false }
  const fresh = Date.now() - state.heartbeatAt <= KEEPER_STALE_MS
  // 两个条件都要满足：心跳新鲜，且那个 pid 真的还在。进程被 kill 时来不及更新心跳，
  // 只看心跳会把一个死进程当成活的，然后插件就再也不自己续期了。
  return { alive: fresh && pidAlive(state.pid), state }
}

/** 守护进程的脚本路径：和当前 bundle 同目录的 `keeper-main.mjs`（tsdown 入口名）。 */
export function keeperScriptPath(): string {
  // 主 bundle 跑起来时 import.meta.url 指向 lib/index.mjs，keeper-main.mjs 就在旁边。
  // 用 fileURLToPath 而不是手撕 pathname：Windows 上 pathname 带前导斜杠和百分号转义。
  return fileURLToPath(new URL('./keeper-main.mjs', import.meta.url))
}

/**
 * 拿 `ELECTRON_RUN_AS_NODE` 这条路启动 node 所需的 exe。
 *
 * 优先级：宿主自己给的 `DSH_DESKTOP_NODE_EXECUTABLE`（Desktop 注入，最准）→
 * `process.execPath`（Electron 自己或普通 node 都适用）→ PATH 里的 `node`。
 */
export function nodeLauncher(): { command: string; env: NodeJS.ProcessEnv } {
  const desktop = process.env.DSH_DESKTOP_NODE_EXECUTABLE
  if (desktop !== undefined && desktop !== '' && existsSync(desktop)) {
    return { command: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  // process.execPath 在 Electron 里是宿主 exe，配 ELECTRON_RUN_AS_NODE 就是 node；
  // 在普通 node 里本来就是 node，多这个环境变量也无害。
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

export interface KeeperSpawnResult {
  ok: boolean
  pid?: number
  reason?: string
}

/**
 * 起一个守护进程。已经在跑就返回现有的那个（幂等，不重复起）。
 *
 * `detached` + `unref` + `stdio:'ignore'` 三件套缺一不可：少了任何一个，DSH 退出时
 * 子进程会被一起带走（Windows 上尤其明显），守护也就没有意义了。
 */
export function spawnKeeper(options: { scriptPath: string; pluginVersion?: string }): KeeperSpawnResult {
  // 先判脚本、再判「是否已在跑」。反过来的话，本机恰好有一个健康的守护进程时，
  // 「产物缺了 keeper-main.mjs」这种打包事故会被前面的判活吞掉、谎报成功。
  if (!existsSync(options.scriptPath)) {
    return { ok: false, reason: `keeper script missing: ${options.scriptPath}` }
  }
  const running = keeperStats()
  if (running.alive && running.state !== undefined) {
    return { ok: true, pid: running.state.pid }
  }
  const { command, env } = nodeLauncher()
  try {
    const child = spawn(command, [options.scriptPath, '--home', dshHome()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        ...options.pluginVersion === undefined ? {} : { DSH_CODEARTS_PLUGIN_VERSION: options.pluginVersion },
      },
    })
    child.unref()
    if (child.pid === undefined) return { ok: false, reason: 'spawn produced no pid' }
    return { ok: true, pid: child.pid }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 停掉守护进程。
 *
 * 先礼后兵：先请它自己退（它能顺手把状态文件标成已停），等一小会儿还在就直杀。
 * 不管走哪条路，最后都把状态文件删掉 —— 留着它只会让下一次启动以为「已经在跑」。
 */
export async function stopKeeper(home?: string): Promise<{ ok: boolean; pid?: number; reason?: string }> {
  const state = readKeeperState(home)
  if (state === undefined || !pidAlive(state.pid)) {
    clearKeeperState(home)
    return { ok: true }
  }
  // 标记文件：守护进程每轮都会看一眼，看到就自己退出并清理现场。
  try {
    writeFileSync(join(home ?? dshHome(), '.codearts-keeper.stop'), String(Date.now()), { mode: 0o600 })
  } catch {
    // 写不进去就直接杀。
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && pidAlive(state.pid)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ESRCH') {
        return { ok: false, pid: state.pid, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  clearKeeperState(home)
  return { ok: true, pid: state.pid }
}

/** 删掉状态文件与停止标记。 */
export function clearKeeperState(home?: string): void {
  for (const path of [keeperStatePath(home), join(home ?? dshHome(), '.codearts-keeper.stop')]) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // 删不掉也不阻断：下一次 spawn 会先探活，进程没了就正常重起。
    }
  }
}

/** 停止标记存在吗（守护进程每轮自查）。 */
export function stopRequested(home?: string): boolean {
  return existsSync(join(home ?? dshHome(), '.codearts-keeper.stop'))
}

/** 账号文档的最后修改时间，用来判断「守护进程刚写过一次」。 */
export function accountsDocMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 账号文档所在目录（守护进程用它找文件名）。 */
export function accountsDocDir(path: string): string {
  return dirname(path)
}
