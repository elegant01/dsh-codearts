import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  acquireRefreshLock,
  refreshLockPath,
  REFRESH_LOCK_STALE_MS,
  withRefreshLock,
} from '../src/refresh-lock.ts'

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-lock-'))
  lockPath = refreshLockPath(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('acquireRefreshLock', () => {
  it('writes a lock file next to the account document', async () => {
    const release = await acquireRefreshLock(lockPath)
    expect(release).toBeDefined()
    expect(existsSync(lockPath)).toBe(true)
    const payload = JSON.parse(await readFile(lockPath, 'utf8'))
    expect(payload.pid).toBe(process.pid)
    expect(typeof payload.at).toBe('number')
    await release?.()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('makes a second acquirer wait and then give up', async () => {
    const release = await acquireRefreshLock(lockPath)
    const started = Date.now()
    const second = await acquireRefreshLock(lockPath, { waitMs: 200 })
    expect(second).toBeUndefined()
    // 真的等过了 waitMs，而不是立刻放弃（立刻放弃会让两边都不会重试）。
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    await release?.()
  })

  it('takes over a lock whose holder is long gone', async () => {
    // pid 一定不存在的一个值：1 是 init/System，探活会返回「活着」，这里用极端值。
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_991, at: Date.now() }), 'utf8')
    const release = await acquireRefreshLock(lockPath, { waitMs: 1_000 })
    expect(release).toBeDefined()
    await release?.()
  })

  it('takes over a lock that stopped being renewed', async () => {
    // 持锁进程还活着（自己），但时间戳太旧 ⇒ 陈旧。pid 复用是 Windows 上的真实风险，
    // 只靠 pidAlive 会把死锁当成活锁。
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - REFRESH_LOCK_STALE_MS - 1 }), 'utf8')
    const release = await acquireRefreshLock(lockPath, { waitMs: 1_000 })
    expect(release).toBeDefined()
    await release?.()
  })

  it('does not delete a lock somebody else took over', async () => {
    const release = await acquireRefreshLock(lockPath)
    // 模拟「我们超时、被别人抢走了」：文件内容换成别人的。
    const other = { pid: 999_999_992, at: Date.now() }
    await writeFile(lockPath, JSON.stringify(other), 'utf8')
    await release?.()
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(other.pid)
  })

  // Windows 上 Node 的 process.kill(pid, 0) 会 TerminateProcess 真的把进程杀掉。
  // 探活用错了实现的话，这条会以「进程无故消失」的形式暴露出来。
  it('probing a live pid does not kill it', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - REFRESH_LOCK_STALE_MS - 1 }), 'utf8')
    const release = await acquireRefreshLock(lockPath, { waitMs: 1_000 })
    await release?.()
    expect(process.pid).toBeGreaterThan(0)
  })
})

describe('withRefreshLock', () => {
  it('runs the work while holding the lock and reports busy to the caller', async () => {
    let busy = 0
    const release = await acquireRefreshLock(lockPath)
    const skipped = await withRefreshLock(lockPath, async () => 'ran', {
      waitMs: 100,
      onBusy: () => { busy += 1 },
    })
    expect(skipped).toBeUndefined()
    expect(busy).toBe(1)
    await release?.()

    const ran = await withRefreshLock(lockPath, async () => 'ran', { waitMs: 1_000 })
    expect(ran).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('releases the lock even when the work throws', async () => {
    await expect(withRefreshLock(lockPath, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('serializes two concurrent callers into one lock', async () => {
    const order: string[] = []
    const [a, b] = await Promise.all([
      withRefreshLock(lockPath, async () => {
        order.push('a-start')
        await new Promise(resolve => setTimeout(resolve, 30))
        order.push('a-end')
        return 'a'
      }, { waitMs: 2_000 }),
      (async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return withRefreshLock(lockPath, async () => {
          order.push('b-start')
          order.push('b-end')
          return 'b'
        }, { waitMs: 2_000 })
      })(),
    ])
    expect([a, b]).toEqual(['a', 'b'])
    // b 不可能插进 a 中间：这正是一次性 refresh_token 必须保住的东西。
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })
})
