import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KEEPER_STALE_MS,
  keeperLogPath,
  keeperStatePath,
  pidAlive,
  keeperScriptPath,
  keeperStats,
  readKeeperState,
  spawnKeeper,
  stopKeeper,
  writeKeeperState,
  type CodeArtsKeeperState,
} from '../src/keeper.ts'

/**
 * 守护进程协议层的测试：状态文件的读写、判活、以及「结束」这件事的语义。
 *
 * 这里刻意不真的去 spawn 一个常驻进程 —— 那会把测试变成有副作用的后台泄漏。
 * spawn 只验「脚本不存在时老实报错」这条失败路径，这正是打包漏了 keeper-main
 * 时用户会撞上的情形。
 */

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codearts-keeper-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function state(overrides: Partial<CodeArtsKeeperState> = {}): CodeArtsKeeperState {
  return {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    ...overrides,
  }
}

describe('keeper state file', () => {
  it('round-trips the pid and heartbeat', () => {
    writeKeeperState(state({ pid: 4242, lastPass: { at: 1, checked: 2, refreshed: 1, needsLogin: ['a'] } }), home)
    const read = readKeeperState(home)
    expect(read?.pid).toBe(4242)
    expect(read?.lastPass?.refreshed).toBe(1)
    expect(read?.lastPass?.needsLogin).toEqual(['a'])
  })

  it('answers undefined for a missing or malformed file', async () => {
    expect(readKeeperState(home)).toBeUndefined()
    await writeFile(keeperStatePath(home), '{not json', 'utf8')
    expect(readKeeperState(home)).toBeUndefined()
    await writeFile(keeperStatePath(home), '{"pid":"nope"}', 'utf8')
    expect(readKeeperState(home)).toBeUndefined()
  })

  it('parses Windows-style paths without mangling the drive letter', () => {
    // keeperScriptPath 以前是手撕 URL.pathname，Windows 上会得到 `/F:/...`。
    expect(keeperScriptPath()).not.toMatch(/^\/[A-Za-z]:/)
    expect(keeperScriptPath().replace(/\\/g, '/')).toMatch(/keeper-main\.mjs$/)
  })

  it('keeps the log next to the state file', () => {
    expect(keeperLogPath(home)).toBe(join(home, '.codearts-keeper.log'))
    expect(keeperStatePath(home)).toBe(join(home, '.codearts-keeper.json'))
  })
})

describe('keeperStats', () => {
  // 判活必须同时看心跳和 pid：进程被 SIGKILL 时来不及改心跳，只剩新鲜的心跳会让
  // 插件以为「守护还在」，于是自己永不让路，凭证就一直不续。
  it('needs both a fresh heartbeat and a live pid', () => {
    writeKeeperState(state({ pid: process.pid }), home)
    expect(keeperStats(home).alive).toBe(true)
  })

  it('calls a stale heartbeat dead', () => {
    writeKeeperState(state({ pid: process.pid, heartbeatAt: Date.now() - KEEPER_STALE_MS - 1 }), home)
    expect(keeperStats(home).alive).toBe(false)
  })

  it('calls a recycled pid dead even with a fresh heartbeat', () => {
    // 0 是 Windows 的 System Idle Process，永远「在」，用来模拟「心跳很新但进程不是我们的」。
    writeKeeperState(state({ pid: 0 }), home)
    expect(keeperStats(home).alive).toBe(false)
  })

  it('does not treat an idle process as alive', () => {
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(process.pid)).toBe(true)
  })
})

describe('spawnKeeper', () => {
  it('refuses to start when the bundle is missing the entry file', () => {
    const outcome = spawnKeeper({ scriptPath: join(home, 'keeper-main.mjs') })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('keeper script missing')
  })
})

describe('stopKeeper', () => {
  // 用户按「结束」时状态文件里可能还留着一个早就没了的 pid；这种情况下「停掉」是
  // 成功，不是失败 —— 目标状态就是「没有守护进程」。
  it('reports success and cleans up when nothing is running', async () => {
    writeKeeperState(state({ pid: 0 }), home)
    const outcome = await stopKeeper(home)
    expect(outcome.ok).toBe(true)
    expect(readKeeperState(home)).toBeUndefined()
    await expect(readFile(join(home, '.codearts-keeper.stop'), 'utf8')).rejects.toThrow()
  })

  it('leaves no state file behind so the switch cannot be flipped on by a ghost', async () => {
    await mkdir(home, { recursive: true })
    // 不能用 process.pid 当假 pid：stopKeeper 会认真地把「那个进程」杀掉，测试进程
    // 自己就成了靶子。用 0（Windows 的 System Idle Process）当「早就没了的 pid」。
    writeKeeperState(state({ pid: 0 }), home)
    await stopKeeper(home)
    expect(readKeeperState(home)).toBeUndefined()
  })
})
