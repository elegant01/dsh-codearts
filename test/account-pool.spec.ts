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

  // 重新登录的语义就是「这个号现在该能用了」：凭据换新后把禁用/冷却一并清掉。
  // 以前 disabled 没有任何清理路径，重新登录也救不回来（issue #1）。
  it('revive clears disable, cooldown, cap hint and error count', () => {
    const pool = poolOf(['a'])
    pool.noteConcurrencyCap('a')
    pool.noteError('a', 3, 60_000, 'boom')
    pool.cooldown('a', 60_000, 'boom')
    pool.disable('a', 'token rejected')
    expect(pool.healthy('a')).toBe(false)

    pool.revive('a')

    const account = pool.get('a')
    expect(account?.disabled).toBe(false)
    expect(account?.coolUntil).toBe(0)
    expect(account?.cappedUntil).toBe(0)
    expect(account?.errorCount).toBe(0)
    expect(account?.lastError).toBeUndefined()
    expect(pool.healthy('a')).toBe(true)
  })

  it('revive on an unknown id is a no-op', () => {
    const pool = poolOf(['a'])
    pool.revive('nope')
    expect(pool.get('nope')).toBeUndefined()
    expect(pool.healthy('a')).toBe(true)
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

describe('cap 窗口按实测自适应', () => {
  function poolOne(start = 1_000_000): { pool: CodeArtsAccountPool; clockRef: { now: () => number; advance: (ms: number) => void } } {
    const clockRef = clock(start)
    return { pool: new CodeArtsAccountPool(['a', 'b'], { maxConcurrent: 1, now: clockRef.now }), clockRef }
  }

  // 52 秒是实测均值，不是每个号每次都一样；量到过就别再用固定 30 秒（窗口一过就
  // 白打一次上游、再记一次 cap，而每次 cap 又把窗口重置成 30 秒，永远学不到）。
  it('uses the measured release time for the next cap window', () => {
    const { pool, clockRef } = poolOne()
    pool.noteConcurrencyCap('a')
    clockRef.advance(52_000)
    pool.noteCapRelease('a')
    expect(pool.get('a')?.capSamples).toEqual([52_000])

    clockRef.advance(1)
    pool.noteConcurrencyCap('a')
    expect((pool.get('a')?.cappedUntil ?? 0) - clockRef.now()).toBe(52_000)
  })

  it('takes the median so one long sample cannot stretch the window', () => {
    const { pool, clockRef } = poolOne()
    for (const ms of [40_000, 52_000, 90_000]) {
      pool.noteConcurrencyCap('a')
      clockRef.advance(ms)
      pool.noteCapRelease('a')
    }
    expect(pool.get('a')?.capSamples).toEqual([40_000, 52_000, 90_000])

    clockRef.advance(1)
    pool.noteConcurrencyCap('a')
    expect((pool.get('a')?.cappedUntil ?? 0) - clockRef.now()).toBe(52_000)
  })

  // 脏样本必须丢：隔了 3 分钟才成功，说明那不是「排队等槽位」，量出来会把避让窗口
  // 拉到几分钟，卡片长时间显示「避让中」，比固定 30 秒更糟。
  it('drops samples outside the plausible range and falls back to the hint', () => {
    const { pool, clockRef } = poolOne()
    pool.noteConcurrencyCap('a')
    clockRef.advance(200_000)
    pool.noteCapRelease('a')
    expect(pool.get('a')?.capSamples).toEqual([])
    expect(pool.get('a')?.lastCapAt).toBe(0)

    pool.noteConcurrencyCap('a')
    expect((pool.get('a')?.cappedUntil ?? 0) - clockRef.now()).toBe(CAPPED_HINT_MS)

    // 太短的也不算：那一刻就成功说明槽位本来就没被这次请求占住。
    pool.noteConcurrencyCap('b')
    clockRef.advance(1_000)
    pool.noteCapRelease('b')
    expect(pool.get('b')?.capSamples).toEqual([])
  })

  // 同一个号只允许一次排队样本，重复调用不能把同一段时间记两遍。
  it('consumes the pending cap sample once', () => {
    const { pool, clockRef } = poolOne()
    pool.noteConcurrencyCap('a')
    clockRef.advance(52_000)
    pool.noteCapRelease('a')
    pool.noteCapRelease('a')
    expect(pool.get('a')?.capSamples).toEqual([52_000])
  })

  // 成功就是「槽位空了」的铁证：提示继续留着会让卡片把这个刚跑通的号显示成「避让中」。
  it('clears the cap hint when the account just succeeded', () => {
    const { pool, clockRef } = poolOne()
    pool.noteConcurrencyCap('a')
    expect(pool.get('a')?.cappedUntil).toBeGreaterThan(clockRef.now())
    pool.noteSuccess('a')
    expect(pool.get('a')?.cappedUntil).toBe(0)
    expect(pool.get('a')?.lastCapAt).toBe(0)
  })
})

describe('paused and pinned', () => {
  it('never picks a paused account', () => {
    const pool = poolOf(['a', 'b'])
    pool.setPaused(['a'])
    expect(pool.pick()).toBe('b')
    pool.setPaused(['a', 'b'])
    expect(pool.pick()).toBeUndefined()
    // 暂停只是不参与轮转，不是禁用：账号本身的状态还在。
    expect(pool.get('a')?.disabled).toBe(false)
  })

  it('picks pinned accounts first, then falls back to least-recently-used', () => {
    const pool = poolOf(['a', 'b', 'c'])
    pool.setPreferred(['c'])
    expect(pool.pick()).toBe('c')
    pool.acquire('c')
    pool.release('c')
    // c 仍是置顶；只在置顶里挑不到可用号时才回落到普通账号。
    expect(pool.pick()).toBe('c')
    pool.setPreferred([])
    expect(pool.pick()).toBe('a')
  })

  it('clears both sets when called with an empty list', () => {
    const pool = poolOf(['a', 'b'])
    pool.setPaused(['a'])
    pool.setPreferred(['b'])
    pool.setPaused([])
    pool.setPreferred([])
    expect(pool.pick()).toBe('a')
  })
})
