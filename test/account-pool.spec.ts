import { describe, expect, it } from 'vitest'
import { CAPPED_HINT_MS, CodeArtsAccountPool } from '../src/account-pool.ts'

/** 可推进的假时钟，让冷却/提示的时间判断可测。 */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function poolOf(ids: string[], maxConcurrent = 1): CodeArtsAccountPool {
  const clockRef = clock()
  return new CodeArtsAccountPool(ids, { maxConcurrent, now: clockRef.now })
}

describe('selection', () => {
  it('prefers the account used longest ago', () => {
    const pool = poolOf(['a', 'b'])
    expect(pool.pick()).toBe('a')
    // a 刚被用过，下一次该轮到 b。
    pool.acquire('a')
    pool.release('a')
    expect(pool.pick()).toBe('b')
  })

  it('skips accounts whose slots are all taken', () => {
    const pool = poolOf(['a', 'b'], 1)
    expect(pool.acquire('a')).toBe(true)
    // 满了就再占不到
    expect(pool.acquire('a')).toBe(false)
    expect(pool.pick()).toBe('b')
  })

  it('honours the exclude set', () => {
    const pool = poolOf(['a', 'b'])
    expect(pool.pick(new Set(['a']))).toBe('b')
    expect(pool.pick(new Set(['a', 'b']))).toBeUndefined()
  })

  it('returns undefined when there are no accounts at all', () => {
    const pool = poolOf([])
    expect(pool.pick()).toBeUndefined()
    expect(pool.hasUsable()).toBe(false)
  })

  it('release never drives the count below zero', () => {
    const pool = poolOf(['a'])
    pool.release('a')
    pool.release('a')
    expect(pool.get('a')?.activeConcurrent).toBe(0)
  })
})

describe('concurrency cap', () => {
  it('deprioritises an account that just hit the cap', () => {
    const pool = poolOf(['a', 'b'])
    pool.noteConcurrencyCap('a')
    // 即便 a 最久没用，也该先挑没撞上限的 b。
    expect(pool.pick()).toBe('b')
  })

  it('still picks a capped account when it is the only option', () => {
    const pool = poolOf(['a'])
    pool.noteConcurrencyCap('a')
    // 排它的队，总比直接失败强。
    expect(pool.pick()).toBe('a')
  })

  // 账号没坏，只是会话槽位暂时满了。冷却会让它一分钟内彻底不可用，误伤后续请求。
  it('does not disable or cool down the account', () => {
    const pool = poolOf(['a'])
    pool.noteConcurrencyCap('a')
    const account = pool.get('a')
    expect(account?.disabled).toBe(false)
    expect(account?.coolUntil).toBe(0)
    expect(pool.healthy('a')).toBe(true)
  })

  it('lets the preference expire', () => {
    const clockRef = clock()
    const pool = new CodeArtsAccountPool(['a', 'b'], { maxConcurrent: 1, now: clockRef.now })
    pool.noteConcurrencyCap('a')
    clockRef.advance(CAPPED_HINT_MS + 1)
    // 提示过期后 a 重新参与「最久未用」排序。
    expect(pool.pick()).toBe('a')
  })
})

describe('health', () => {
  it('skips a disabled account', () => {
    const pool = poolOf(['a', 'b'])
    pool.disable('a', 'token rejected')
    expect(pool.pick()).toBe('b')
    expect(pool.healthy('a')).toBe(false)
  })

  it('skips an account in cooldown, and brings it back when it expires', () => {
    const clockRef = clock()
    const pool = new CodeArtsAccountPool(['a', 'b'], { maxConcurrent: 1, now: clockRef.now })
    pool.cooldown('a', 30_000, 'upstream 500')
    expect(pool.pick()).toBe('b')
    clockRef.advance(30_001)
    expect(pool.healthy('a')).toBe(true)
  })

  it('cools an account down after repeated errors', () => {
    const pool = poolOf(['a', 'b'])
    pool.noteError('a', 3, 60_000, 'boom')
    pool.noteError('a', 3, 60_000, 'boom')
    expect(pool.healthy('a')).toBe(true)
    pool.noteError('a', 3, 60_000, 'boom')
    expect(pool.healthy('a')).toBe(false)
  })

  it('a success clears the error count and cooldown', () => {
    const pool = poolOf(['a'])
    pool.cooldown('a', 60_000, 'boom')
    pool.noteError('a', 3, 60_000, 'boom')
    pool.noteSuccess('a')
    const account = pool.get('a')
    expect(account?.coolUntil).toBe(0)
    expect(account?.errorCount).toBe(0)
    expect(account?.lastError).toBeUndefined()
  })
})

describe('sync', () => {
  it('adds new accounts and drops removed ones, keeping runtime state', () => {
    const pool = poolOf(['a', 'b'])
    pool.noteConcurrencyCap('a')
    pool.sync(['a', 'c'])

    expect(pool.get('b')).toBeUndefined()
    expect(pool.get('c')).toBeDefined()
    // 已有账号的运行时状态要保留（刚记的上限提示不能因为一次 sync 就没了）。
    expect(pool.get('a')?.cappedUntil).toBeGreaterThan(0)
  })
})
