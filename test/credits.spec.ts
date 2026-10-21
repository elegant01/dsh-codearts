import { describe, expect, it, vi } from 'vitest'
import {
  parseCreditStatistics,
  parseTokenBalance,
  CodeArtsCreditCache,
  type CodeArtsCreditSnapshot,
} from '../src/credits.ts'

const STATISTICS_BODY = {
  metrics: [
    { name: 'usageDataChatMessages', value: -1, show: false },
    { name: 'usageTokenChatMessages', value: 0, package_token_amount: 1, show: true },
    {
      name: 'usageTotalPackageCredit',
      value: 0,
      package_credit_amount: 2000.0,
      package_credit_used: 0.0,
      package_credit_remain: 2000.0,
      package_credit_expiring_amount: 1000.0,
      show: true,
    },
    {
      name: 'usageBasicPackageCredit',
      value: 0,
      package_credit_amount: 0,
      package_credit_used: 0,
      package_credit_remain: 0,
      show: true,
    },
    {
      name: 'usageBonusPackageCredit',
      value: 0,
      package_credit_amount: 2000.0,
      package_credit_used: 0.0,
      package_credit_remain: 2000.0,
      package_credit_expiring_amount: 1000.0,
      show: true,
    },
  ],
  start_date: '2026-10-09',
  end_date: '2026-11-10',
  package: {
    spec_code: 'codearts.agent.individual.trial',
    status: 'normal',
    package_name_en: 'Trial',
    package_name_cn: '体验版',
    package_url: 'https://console.huaweicloud.com/example',
    is_token_package: false,
    is_credit_package: true,
  },
}

describe('parseCreditStatistics', () => {
  it('reads the trial package with bonus credits', () => {
    const result = parseCreditStatistics(STATISTICS_BODY)
    expect(result).toBeDefined()
    expect(result!.planName).toBe('体验版')
    expect(result!.planNameEn).toBe('Trial')
    expect(result!.specCode).toBe('codearts.agent.individual.trial')
    expect(result!.planStatus).toBe('active')
    expect(result!.isCreditPackage).toBe(true)
    expect(result!.packageUrl).toBe('https://console.huaweicloud.com/example')
    expect(result!.periodStart).toBe('2026-10-09')
    expect(result!.periodEnd).toBe('2026-11-10')
    expect(result!.total).toEqual({ total: 2000, used: 0, remain: 2000, expiring: 1000 })
    expect(result!.bonus).toEqual({ total: 2000, used: 0, remain: 2000, expiring: 1000 })
    expect(result!.basic).toEqual({ total: 0, used: 0, remain: 0, expiring: 0 })
  })

  it('falls back to the English name when Chinese is missing', () => {
    const body = { ...STATISTICS_BODY, package: { ...STATISTICS_BODY.package, package_name_cn: '' } }
    expect(parseCreditStatistics(body)!.planName).toBe('Trial')
  })

  it('maps upstream status to our vocabulary', () => {
    const closed = parseCreditStatistics({ ...STATISTICS_BODY, package: { ...STATISTICS_BODY.package, status: 'closed' } })
    expect(closed!.planStatus).toBe('expired')
    const frozen = parseCreditStatistics({ ...STATISTICS_BODY, package: { ...STATISTICS_BODY.package, status: 'freeze' } })
    expect(frozen!.planStatus).toBe('frozen')
    const unknown = parseCreditStatistics({ ...STATISTICS_BODY, package: { ...STATISTICS_BODY.package, status: 'weird' } })
    expect(unknown!.planStatus).toBe('unknown')
  })

  it('returns undefined when metrics is absent', () => {
    expect(parseCreditStatistics({})).toBeUndefined()
    expect(parseCreditStatistics({ metrics: 'nope' })).toBeUndefined()
  })

  it('returns undefined when usageTotalPackageCredit is absent', () => {
    expect(parseCreditStatistics({ metrics: [{ name: 'usageDataChatMessages', value: -1 }] })).toBeUndefined()
  })

  it('treats -1 as absent, not as 0', () => {
    const body = {
      ...STATISTICS_BODY,
      metrics: [
        {
          name: 'usageTotalPackageCredit',
          package_credit_amount: -1,
          package_credit_used: -1,
          package_credit_remain: -1,
          package_credit_expiring_amount: -1,
        },
      ],
    }
    // 三个关键字段全是 -1（非负解析为 undefined）→ categoryOf 返回 undefined → 整体 undefined。
    expect(parseCreditStatistics(body)).toBeUndefined()
  })
})

const BALANCE_BODY = {
  error_code: '0000',
  error_msg: 'success',
  result: {
    channel: 'codearts',
    daily_token_limit: 10000000,
    daily_tokens_used: 5639922,
    monthly_token_limit: 0,
    monthly_tokens_used: 15760882,
    total_balance: 4360078,
    total_quota: 10000000,
    used_amount: 5639922,
  },
}

describe('parseTokenBalance', () => {
  it('reads the daily/monthly quota', () => {
    const result = parseTokenBalance(BALANCE_BODY)
    expect(result).toEqual({
      dailyLimit: 10000000,
      dailyUsed: 5639922,
      monthlyLimit: 0,
      monthlyUsed: 15760882,
      balance: 4360078,
      quota: 10000000,
    })
  })

  it('returns undefined when result is absent', () => {
    expect(parseTokenBalance({})).toBeUndefined()
    expect(parseTokenBalance({ result: null })).toBeUndefined()
  })
})

describe('CodeArtsCreditCache', () => {
  const fakeCredential = { accessToken: 'x' } as never
  const snapshot: CodeArtsCreditSnapshot = {
    credits: {
      planName: '体验版',
      planNameEn: 'Trial',
      specCode: 'trial',
      planStatus: 'active',
      isCreditPackage: true,
      total: { total: 2000, used: 0, remain: 2000, expiring: 1000 },
      fetchedAt: 0,
    },
  }

  it('caches a success within TTL and does not re-call load', async () => {
    let calls = 0
    const load = vi.fn(async () => {
      calls++
      return snapshot
    })
    let now = 1000
    const cache = new CodeArtsCreditCache({ ttlMs: 60_000, load, now: () => now })
    const a = await cache.get('uid-a', fakeCredential)
    const b = await cache.get('uid-a', fakeCredential)
    expect(a.phase).toBe('ok')
    expect(b.phase).toBe('ok')
    expect(calls).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
    // TTL 过期后重新拉。
    now += 61_000
    await cache.get('uid-a', fakeCredential)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('caches a failure for the shorter failureTtlMs', async () => {
    const load = vi.fn(async () => {
      throw new Error('upstream down')
    })
    let now = 1000
    const cache = new CodeArtsCreditCache({ ttlMs: 60_000, failureTtlMs: 5_000, load, now: () => now })
    const a = await cache.get('uid-a', fakeCredential)
    expect(a.phase).toBe('error')
    expect((a as { message: string }).message).toBe('upstream down')
    // 4s 后：仍在失败缓存窗口内，不重新拉。
    now += 4_000
    await cache.get('uid-a', fakeCredential)
    expect(load).toHaveBeenCalledTimes(1)
    // 6s 后：超过 failureTtlMs，重新拉。
    now += 6_000
    await cache.get('uid-a', fakeCredential)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('single-flies concurrent gets', async () => {
    let resolve: (value: CodeArtsCreditSnapshot) => void
    const pending = new Promise<CodeArtsCreditSnapshot>(r => {
      resolve = r
    })
    const load = vi.fn(() => pending)
    const cache = new CodeArtsCreditCache({ load })
    const a = cache.get('uid-a', fakeCredential)
    const b = cache.get('uid-a', fakeCredential)
    const c = cache.get('uid-a', fakeCredential)
    resolve!(snapshot)
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(load).toHaveBeenCalledTimes(1)
    expect(ra).toBe(rb)
    expect(rb).toBe(rc)
  })

  it('keeps one cache slot per account', async () => {
    const load = vi.fn(async () => snapshot)
    const cache = new CodeArtsCreditCache({ load })
    await cache.get('uid-a', fakeCredential)
    await cache.get('uid-b', fakeCredential)
    await cache.get('uid-a', fakeCredential)
    expect(load).toHaveBeenCalledTimes(2)
    // 只清一个号，不影响另一个号。
    cache.invalidate('uid-a')
    await cache.get('uid-b', fakeCredential)
    expect(load).toHaveBeenCalledTimes(2)
    await cache.get('uid-a', fakeCredential)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('invalidate drops the cache', async () => {
    let calls = 0
    const load = vi.fn(async () => {
      calls++
      return snapshot
    })
    const cache = new CodeArtsCreditCache({ load })
    await cache.get('uid-a', fakeCredential)
    cache.invalidate('uid-a')
    await cache.get('uid-a', fakeCredential)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
