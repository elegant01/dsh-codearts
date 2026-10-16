/**
 * 福利中心（每日签到领积分）接口。
 *
 * 响应形状取自 2026-10-15 对 snap-access `/v1/ops/*` 的实测：
 * 业务失败也回 HTTP 200，成败只看 body 的 `code`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimDailyWelfare,
  fetchWelfareCampaigns,
  pickDailyWelfareCampaign,
  type CodeArtsWelfareCampaign,
} from '../src/upstream.ts'
import type { CodeArtsResolved } from '../src/upstream.ts'
import { fetchCredits } from '../src/credits.ts'

const credential: CodeArtsResolved = {
  token: 'cloud_dragon_token',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  securityToken: 'sts-token',
}

/** 一次 delivery 的真实形状：签到活动可领，学生认证/邀请不可领。 */
function deliveryBody(items: unknown[]): unknown {
  return { code: 0, message: 'ok', data: { channel: 'IDE', serverTime: 1_792_030_779_507, items } }
}

const DAILY_ELIGIBLE = {
  campaignId: 1,
  title: '每日签到领1000积分',
  type: 'USER_LOGIN',
  benefitAmount: 1000,
  benefitUnit: 'CREDIT',
  claimable: true,
  status: 'ELIGIBLE',
  extra: { triggerMode: 'MANUAL_CLAIM' },
}

const DAILY_CONFIRMED = { ...DAILY_ELIGIBLE, claimable: false, status: 'CONFIRMED' }

/** 记录调用并按 url+method 路由响应。 */
function route(responder: (url: string, method: string, body: string) => Response): {
  calls: { url: string; method: string; body: string; headers: Headers }[]
} {
  const calls: { url: string; method: string; body: string; headers: Headers }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: Request) => {
    const body = input.method === 'GET' ? '' : await input.clone().text()
    calls.push({ url: input.url, method: input.method, body, headers: input.headers })
    return responder(input.url, input.method, body)
  }))
  return { calls }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

describe('fetchWelfareCampaigns', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the daily check-in campaign and drops entries without an id', async () => {
    const { calls } = route(() => jsonResponse(deliveryBody([
      DAILY_ELIGIBLE,
      { campaignId: 2, title: '学生认证领4000积分', type: 'STUDENT_CERTIFIED', benefitAmount: 4000, benefitUnit: 'CREDIT', claimable: false, status: null },
      { title: '没有 campaignId 的一条', type: 'USER_LOGIN' },
    ])))
    const campaigns = await fetchWelfareCampaigns(credential)
    expect(campaigns).toHaveLength(2)
    expect(campaigns[0]).toMatchObject({ campaignId: 1, type: 'USER_LOGIN', amount: 1000, unit: 'CREDIT', claimable: true, status: 'ELIGIBLE' })
    expect(campaigns[1]!.status).toBe('')
    // 网关上只有裸 /v1/ops/delivery 发布过（带 PromptCenterService 前缀的那套 404）。
    expect(calls[0]!.url).toBe(
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE',
    )
  })

  it('signs with AK/SK and carries the Agent-Type the welfare gateway expects', async () => {
    const { calls } = route(() => jsonResponse(deliveryBody([])))
    await fetchWelfareCampaigns(credential)
    const headers = calls[0]!.headers
    expect(headers.get('Agent-Type')).toBe('PromptCenter')
    expect(headers.get('x-auth-token')).toBe('cloud_dragon_token')
    expect(headers.get('authorization')).toMatch(/^SDK-HMAC-SHA256 /)
  })

  it('throws instead of pretending an APIG error page is an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 200 })))
    await expect(fetchWelfareCampaigns(credential)).rejects.toThrow(/non-JSON/)
  })
})

describe('claimDailyWelfare', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('claims the eligible daily campaign and reports the granted amount', async () => {
    const { calls } = route(url =>
      url.includes('/ops/claim')
        ? jsonResponse({ code: 0, message: 'ok', data: { campaignId: 1, status: 'CLAIMED' } })
        : jsonResponse(deliveryBody([DAILY_ELIGIBLE])))
    const outcome = await claimDailyWelfare(credential)
    expect(outcome).toEqual({ state: 'claimed', amount: 1000, message: 'ok' })
    const claim = calls.find(call => call.method === 'POST')
    expect(claim!.url).toBe('https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim')
    expect(JSON.parse(claim!.body)).toMatchObject({ campaignId: 1, channel: 'IDE' })
    // idempotentKey 是客户端自己生成的（上游不给），每次一个唯一串。
    expect(JSON.parse(claim!.body).idempotentKey).toMatch(/^[0-9a-f]{32}$/)
  })

  it('does not post when the campaign already shows today as taken', async () => {
    const { calls } = route(() => jsonResponse(deliveryBody([DAILY_CONFIRMED])))
    const outcome = await claimDailyWelfare(credential)
    expect(outcome.state).toBe('already')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
  })

  it('treats code 40001 as already claimed, not as a failure', async () => {
    route(url =>
      url.includes('/ops/claim')
        ? jsonResponse({ code: 40001, message: '尚未到达权益刷新时间，暂时无法领取', data: null })
        : jsonResponse(deliveryBody([DAILY_ELIGIBLE])))
    const outcome = await claimDailyWelfare(credential)
    expect(outcome.state).toBe('already')
    expect(outcome.message).toContain('尚未到达')
  })

  it('keeps an upstream business error visible as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: Request) =>
      input.url.includes('/ops/claim')
        ? jsonResponse({ code: 50003, message: 'campaign not open', data: null })
        : jsonResponse(deliveryBody([DAILY_ELIGIBLE]))))
    const outcome = await claimDailyWelfare(credential)
    expect(outcome.state).toBe('failed')
    expect(outcome.message).toBe('campaign not open')
  })

  it('reports unavailable for a campaign the account cannot enter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(deliveryBody([{ ...DAILY_ELIGIBLE, claimable: false, status: 'ENTRY' }]))))
    const outcome = await claimDailyWelfare(credential)
    expect(outcome.state).toBe('unavailable')
  })

  it('reports unavailable when the account has no check-in campaign at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(deliveryBody([]))))
    const outcome = await claimDailyWelfare(credential)
    expect(outcome.state).toBe('unavailable')
  })

  it('needs AK/SK to sign, and says so without touching the network', async () => {
    const { calls } = route(() => jsonResponse(deliveryBody([])))
    const outcome = await claimDailyWelfare({ ...credential, accessKeyId: undefined, secretAccessKey: undefined })
    expect(outcome.state).toBe('failed')
    expect(calls).toHaveLength(0)
  })
})

describe('pickDailyWelfareCampaign', () => {
  function campaign(patch: Partial<CodeArtsWelfareCampaign>): CodeArtsWelfareCampaign {
    return {
      campaignId: 1,
      title: '每日签到领1000积分',
      type: 'USER_LOGIN',
      amount: 1000,
      unit: 'CREDIT',
      claimable: true,
      status: 'ELIGIBLE',
      ...patch,
    }
  }

  it('prefers the claimable one when the account has several check-in campaigns', () => {
    const picked = pickDailyWelfareCampaign([
      campaign({ campaignId: 1, claimable: false, status: 'CONFIRMED' }),
      campaign({ campaignId: 7, claimable: true, amount: 500 }),
    ])
    expect(picked).toMatchObject({ campaignId: 7, claimable: true })
  })

  it('ignores campaigns that are not credit check-ins', () => {
    expect(pickDailyWelfareCampaign([
      campaign({ type: 'INVITE_USER' }),
      campaign({ unit: 'TOKEN' }),
    ])).toBeUndefined()
  })
})

// 卡片按钮的「今日已领」文案读的是积分快照里的 welfare，所以状态要跟着积分一起缓存。
describe('fetchCredits 里的签到状态', () => {
  afterEach(() => vi.unstubAllGlobals())

  const STATISTICS = {
    metrics: [{
      name: 'usageTotalPackageCredit',
      package_credit_amount: 2500,
      package_credit_used: 13.43,
      package_credit_remain: 2486.57,
    }],
    package: {
      spec_code: 'codearts.agent.individual.trial',
      status: 'normal',
      package_name_cn: '体验版',
      is_credit_package: true,
    },
  }

  function routeDelivery(items: unknown[], deliveryFails = false): void {
    route(url => {
      if (url.includes('/v1/ops/delivery')) {
        return deliveryFails ? new Response('boom', { status: 500 }) : jsonResponse(deliveryBody(items))
      }
      return jsonResponse(STATISTICS)
    })
  }

  it('把 CONFIRMED 翻成 claimedToday', async () => {
    routeDelivery([DAILY_CONFIRMED])
    const snapshot = await fetchCredits(credential)
    expect(snapshot.welfare).toEqual({ claimable: false, claimedToday: true, amount: 1000 })
  })

  it('「要先登录」不是已领，按钮还得能点', async () => {
    routeDelivery([{ ...DAILY_ELIGIBLE, claimable: false, status: 'ENTRY' }])
    const snapshot = await fetchCredits(credential)
    expect(snapshot.welfare).toMatchObject({ claimable: false, claimedToday: false })
  })

  it('签到接口抽风时不拖累积分数字', async () => {
    routeDelivery([], true)
    const snapshot = await fetchCredits(credential)
    expect(snapshot.welfare).toBeUndefined()
    expect(snapshot.credits.total.total).toBe(2500)
  })
})
