import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 可手动兑现的 promise，用来驱动假登录会话。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const { startLoginMock } = vi.hoisted(() => ({ startLoginMock: vi.fn() }))

vi.mock('../src/oauth.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oauth.ts')>()
  return { ...actual, startLogin: startLoginMock }
})

// 登录成功后 web-status 会立刻问一次上游身份。真实实现是带签名的网络请求
// （最长等 8s），在 CI 上会拖过 vi.waitFor 默认的 1s 超时，让「迟到的轮询必须
// 拿到 done」这条回归测试误报成 idle。这里让它立刻返回 null，走「拿不到身份就
// 退回 token.userId」的既有分支，测试只验证终态记账逻辑。
vi.mock('../src/upstream.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/upstream.ts')>()
  return { ...actual, fetchCallerIdentity: vi.fn(async () => null) }
})

import { CodeArtsAccountStore, credentialFromOAuth } from '../src/auth.ts'
import { clearBenefitBlocked, isBenefitBlocked, markBenefitBlocked, setDiscoveredBenefitModels } from '../src/catalog.ts'
import {
  CODEARTS_ACCOUNTS_PATH,
  CODEARTS_CLAIM_PATH,
  CODEARTS_LOGIN_PATH,
  CODEARTS_LOGIN_STATUS_PATH,
  CODEARTS_QUEUE_PATH,
  CODEARTS_REFRESH_MODELS_PATH,
  CODEARTS_STATUS_PATH,
  CODEARTS_TOKEN_PATH,
  registerCodeArtsStatusRoute,
  summarizeClaims,
  type CodeArtsClaimResult,
} from '../src/web-status.ts'

/**
 * 路由层的测试：直接驱动注册进去的 handler，不经过 socket —— handler 只用到
 * method / url / headers 和 writeHead / end，用最小替身就够，比开真端口快得多。
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** 捕获 registerCodeArtsStatusRoute 注册的每个路由。 */
function mountRoutes(deps: Parameters<typeof registerCodeArtsStatusRoute>[1]): Map<string, Handler> {
  const routes = new Map<string, Handler>()
  const ctx = {
    effect: (fn: () => () => void) => fn(),
    webServer: {
      register: ({ path, handler }: { path: string; handler: Handler }) => {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  registerCodeArtsStatusRoute(ctx as never, deps)
  return routes
}

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const req: Record<string, unknown> = { method, url, headers: { host: '127.0.0.1:3080', ...headers } }
  if (body !== undefined) {
    req.on = (event: string, callback: (chunk?: Buffer) => void): unknown => {
      if (event === 'data') callback(Buffer.from(body))
      if (event === 'end') callback()
      return req
    }
    req.destroy = (): void => {}
  }
  return req as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> | undefined } {
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { payload = chunk ?? '' },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    body: () => (payload === '' ? undefined : JSON.parse(payload) as Record<string, unknown>),
  }
}

async function call(
  handler: Handler,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  requestBody?: string,
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const { res, status, body } = mockRes()
  await handler(mockReq(method, url, headers, requestBody), res)
  return { status: status(), body: body() }
}

const LOOPBACK = 'http://127.0.0.1:3080'

let dir: string
let store: CodeArtsAccountStore
let routes: Map<string, Handler>

function credential(userId: string) {
  return credentialFromOAuth({
    securityToken: `sts-${userId}`,
    accessKeyId: 'AKID',
    secretAccessKey: 'SK',
    refreshToken: 'r',
    clientId: 'c',
    dpopPrivateKey: { kty: 'EC', crv: 'P-256' },
    expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    userId,
    userName: userId,
  } as never)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-routes-'))
  store = new CodeArtsAccountStore(join(dir, '.codearts-accounts.json'))
  routes = mountRoutes({ store, models: () => [] })
  startLoginMock.mockReset()
})

afterEach(async () => {
  // Windows 上原子写落盘的句柄可能还没释放，直接 rmdir 会以 EBUSY 偶发失败 ——
  // 断言其实已经过了，挂掉的是收尾。让它自己重试。
  await rm(dir, { recursive: true, force: true, maxRetries: 10 })
})

/** 一次假登录：startLogin 返回一个由测试手动控制的会话。 */
function fakeLogin(url = 'https://codearts.huaweicloud.com/portal/authorize?fake=1') {
  const outcome = deferred<Parameters<typeof credentialFromOAuth>[0]>()
  startLoginMock.mockResolvedValue({
    url,
    port: 49000,
    promise: outcome.promise,
    close: () => {},
  })
  return outcome
}

const POST = 'POST'
const GET = 'GET'

describe('login flow', () => {
  const poll = (url: string): Promise<{ status: number; body: Record<string, unknown> | undefined }> =>
    call(routes.get(CODEARTS_LOGIN_STATUS_PATH)!, GET, `${CODEARTS_LOGIN_STATUS_PATH}?url=${encodeURIComponent(url)}`)

  it('reports pending while the login is in flight', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    const res = await poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')
    expect(res.body?.status).toBe('pending')
    expect(startLoginMock).toHaveBeenCalledTimes(1)
  })

  // 回归守卫：这是用户实际撞到的 bug。旧实现里，登录完成只会把「done」交给
  // 当时正好在等的那一个轮询；它兑现后所有叠着的回调还会把会话从表里删掉，
  // 于是下一次轮询只拿到 'idle'，客户端不处理 idle，按钮永远停在「登录中」。
  // 现在终态被服务端记住，**第一个**迟到的轮询必须拿到 done。
  it('delivers done to a poll that arrives after the login completed', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    outcome.resolve({
      securityToken: 'sts', accessKeyId: '', secretAccessKey: '', refreshToken: 'r',
      clientId: 'c', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      expiration: new Date(Date.now() + 3600_000).toISOString(), userId: 'uid-new', userName: 'tester',
    } as never)

    // 终态在落库（异步文件写）完成后才记录；idle 不会消费 recent，所以持续轮询
    // 直到拿到 done —— 旧实现里迟到的轮询永远只能拿到 idle，这里会超时报错。
    await vi.waitFor(async () => {
      expect((await poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')).body?.status).toBe('done')
    })
    expect(await store.ids()).toEqual(['uid-new'])
  })

  it('persists the account exactly once no matter how many polls race the settle', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    // 兑现前先叠几个轮询（真实场景：卡片每 1.5s 一次，登录瞬间往往叠着好几个）
    const p1 = poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')
    const p2 = poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')
    outcome.resolve({
      securityToken: 'sts', accessKeyId: '', secretAccessKey: '', refreshToken: 'r',
      clientId: 'c', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      expiration: new Date(Date.now() + 3600_000).toISOString(), userId: 'uid-new', userName: 'tester',
    } as never)
    await Promise.all([p1, p2])
    // 落库是异步文件写，等它真正完成再断言。
    await vi.waitFor(async () => {
      expect(await store.ids()).toEqual(['uid-new'])
    })
  })

  it('reports error when the login fails', async () => {
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    outcome.reject(new Error('exchange failed'))
    await new Promise(r => setImmediate(r))
    expect((await poll('https://codearts.huaweicloud.com/portal/authorize?fake=1')).body?.status).toBe('error')
  })

  it('reports idle for a session that never existed', async () => {
    expect((await poll('https://nope.example/')).body?.status).toBe('idle')
  })

  // issue #1：账号被禁用后，「重新登录」必须把池里的 disabled 清掉，否则登录也救不回来。
  it('revives the account in the pool once the login lands', async () => {
    const revived: string[] = []
    routes = mountRoutes({ store, models: () => [], reviveAccount: id => revived.push(id) })
    const outcome = fakeLogin()
    await call(routes.get(CODEARTS_LOGIN_PATH)!, POST, CODEARTS_LOGIN_PATH)
    outcome.resolve({
      securityToken: 'sts', accessKeyId: '', secretAccessKey: '', refreshToken: 'r',
      clientId: 'c', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      expiration: new Date(Date.now() + 3600_000).toISOString(), userId: 'uid-new', userName: 'tester',
    } as never)

    // 身份探测被 mock 成 null → 退回 token 里的键；revive 的必须是落库的那个 id。
    await vi.waitFor(async () => {
      expect(await store.ids()).toHaveLength(1)
      expect(revived).toHaveLength(1)
    })
    expect(revived).toEqual(await store.ids())
  })
})

describe('POST /api/codearts/token', () => {
  // 手工贴 token 同样是凭据换新：「手工」账号被禁用后，贴新 token 要立刻能用。
  it('revives the manual account after a token is pasted', async () => {
    const revived: string[] = []
    routes = mountRoutes({ store, models: () => [], reviveAccount: id => revived.push(id) })

    const res = await call(
      routes.get(CODEARTS_TOKEN_PATH)!,
      POST,
      CODEARTS_TOKEN_PATH,
      { 'content-type': 'application/json' },
      JSON.stringify({ token: 'pasted' }),
    )

    expect(res.status).toBe(200)
    expect(revived).toEqual(['manual'])
  })
})


describe('DELETE /api/codearts/accounts', () => {
  it('removes the named account and answers with the fresh status document', async () => {
    await store.upsert(credential('uid-a'))
    await store.upsert(credential('uid-b'))

    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'DELETE', `${CODEARTS_ACCOUNTS_PATH}?id=uid-a`)

    expect(res.status).toBe(200)
    expect(await store.ids()).toEqual(['uid-b'])
    expect((res.body?.accounts as { id: string }[]).map(a => a.id)).toEqual(['uid-b'])
  })

  it('rejects a request with no id', async () => {
    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'DELETE', CODEARTS_ACCOUNTS_PATH)
    expect(res.status).toBe(400)
  })

  it('rejects a non-DELETE method', async () => {
    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'GET', CODEARTS_ACCOUNTS_PATH)
    expect(res.status).toBe(405)
  })

  // 改状态的路由：只校验 Host 不够，DNS-rebinding 页面也能把 Host 写成 127.0.0.1。
  it('rejects a cross-origin request', async () => {
    await store.upsert(credential('uid-a'))
    const res = await call(
      routes.get(CODEARTS_ACCOUNTS_PATH)!,
      'DELETE',
      `${CODEARTS_ACCOUNTS_PATH}?id=uid-a`,
      { origin: 'http://evil.example' },
    )
    expect(res.status).toBe(403)
    expect(await store.ids()).toEqual(['uid-a'])
  })

  it('rejects a non-loopback Host', async () => {
    const res = await call(
      routes.get(CODEARTS_ACCOUNTS_PATH)!,
      'DELETE',
      `${CODEARTS_ACCOUNTS_PATH}?id=uid-a`,
      { host: 'evil.example' },
    )
    expect(res.status).toBe(403)
  })

  it('requires a loopback Origin for the status route too', async () => {
    const res = await call(routes.get(CODEARTS_ACCOUNTS_PATH)!, 'DELETE', `${CODEARTS_ACCOUNTS_PATH}?id=x`, { origin: LOOPBACK })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/codearts/status', () => {
  it('reports signed-out with no accounts', async () => {
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.status).toBe(200)
    expect(res.body?.status).toBe('signed-out')
    expect(res.body?.accounts).toEqual([])
  })

  it('lists stored accounts', async () => {
    await store.upsert(credential('uid-a'))
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.body?.status).toBe('signed-in')
    expect((res.body?.accounts as { id: string }[]).map(a => a.id)).toEqual(['uid-a'])
  })

  it('reports every account credits separately and keeps one snapshot for the dock', async () => {
    await store.upsert(credential('uid-a'))
    await store.upsert(credential('uid-b'))
    const snapshot = (remain: number) => ({
      credits: {
        planName: '体验版',
        planNameEn: 'Trial',
        specCode: 'trial',
        planStatus: 'active' as const,
        isCreditPackage: true,
        total: { total: 2000, used: 2000 - remain, remain, expiring: 0 },
        fetchedAt: Date.now(),
      },
    })
    const scoped = mountRoutes({
      store,
      models: () => [],
      credits: async () => [
        { id: 'uid-a', credits: snapshot(2500) },
        { id: 'uid-b', creditsError: 'decrypt token fail' },
      ],
    })
    const res = await call(scoped.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    const entries = res.body?.creditsByAccount as { id: string; creditsError?: string }[]
    expect(entries.map(entry => entry.id)).toEqual(['uid-a', 'uid-b'])
    expect(entries[1].creditsError).toBe('decrypt token fail')
    // 底部积分条仍读单份快照（第一份拿到的），不显示错误账号。
    expect((res.body?.credits as { credits: { total: { remain: number } } }).credits.total.remain).toBe(2500)
  })

  // 一个账号过期不该让整张卡片显示「未登录」——别的账号还能用。
  it('stays signed-in while any account is still usable', async () => {
    await store.upsert(credential('uid-a'))
    await store.upsert({
      token: 'pasted',
      storedAt: Date.now(),
      expiration: '2000-01-01T00:00:00Z',
    })
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.body?.status).toBe('signed-in')
  })

  // 用量页的四段式要按账号/按近 30 天看数据，这两项必须在契约里透传。
  it('passes per-account and last-30-day usage through to the card', async () => {
    const totals = { requests: 2, promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    const usageRoutes = mountRoutes({
      store,
      models: () => [],
      usage: () => ({
        today: totals,
        allTime: totals,
        last30: totals,
        byModelToday: [{ id: 'GLM-5.2', totals }],
        byAccountToday: { 'uid-a': totals },
        days: 1,
      }),
    })
    const res = await call(usageRoutes.get(CODEARTS_STATUS_PATH)!, GET, CODEARTS_STATUS_PATH)
    const usage = res.body?.usage as Record<string, unknown>
    expect(usage.last30).toEqual(totals)
    expect((usage.byAccountToday as Record<string, Record<string, number>>)['uid-a']?.totalTokens).toBe(15)
  })

  it('reports expired when every account is stale', async () => {
    await store.upsert({ token: 'pasted', storedAt: Date.now(), expiration: '2000-01-01T00:00:00Z' })
    const res = await call(routes.get(CODEARTS_STATUS_PATH)!, 'GET', CODEARTS_STATUS_PATH)
    expect(res.body?.status).toBe('expired')
  })
})

describe('GET /api/codearts/queue', () => {
  it('returns the tracker snapshot', async () => {
    const queued = [{ id: 'chat-1', model: 'GLM-5.2', position: 2, length: 4, status: 'queued', updatedAt: 1 }]
    const scoped = mountRoutes({ store, models: () => [], queue: () => queued })
    const res = await call(scoped.get(CODEARTS_QUEUE_PATH)!, 'GET', CODEARTS_QUEUE_PATH)
    expect(res.status).toBe(200)
    expect(res.body?.queue).toEqual(queued)
  })

  it('answers an empty queue when no tracker is wired', async () => {
    const res = await call(routes.get(CODEARTS_QUEUE_PATH)!, 'GET', CODEARTS_QUEUE_PATH)
    expect(res.status).toBe(200)
    expect(res.body?.queue).toEqual([])
  })

  it('rejects untrusted requests', async () => {
    const res = await call(routes.get(CODEARTS_QUEUE_PATH)!, 'GET', CODEARTS_QUEUE_PATH, { host: 'evil.example' })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/codearts/claim', () => {
  function claimHandler(claim: () => Promise<CodeArtsClaimResult>): Handler {
    return mountRoutes({ store, models: () => [], claim }).get(CODEARTS_CLAIM_PATH)!
  }

  it('answers with the outcome so the card can tell 领到了 from 今日已领', async () => {
    const res = await call(
      claimHandler(async () => ({ ok: true, claimed: true, state: 'claimed', amount: 1000, message: 'ok' })),
      POST,
      CODEARTS_CLAIM_PATH,
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ claimed: true, state: 'claimed', amount: 1000 })
  })

  // 「今天已经领了」不是错误：把它发成 500 会让卡片显示「领取失败」，用户以为没签到。
  it('does not turn already-claimed into an HTTP error', async () => {
    const res = await call(
      claimHandler(async () => ({ ok: true, claimed: false, state: 'already', amount: 0, message: '' })),
      POST,
      CODEARTS_CLAIM_PATH,
    )
    expect(res.status).toBe(200)
    expect(res.body?.claimed).toBe(false)
  })

  it('reports a failed claim as 500 with the upstream reason', async () => {
    const res = await call(
      claimHandler(async () => ({ ok: false, claimed: false, state: 'failed', amount: 0, message: 'decrypt token fail' })),
      POST,
      CODEARTS_CLAIM_PATH,
    )
    expect(res.status).toBe(500)
    expect(res.body?.message).toBe('decrypt token fail')
  })

  it('passes the account id from the JSON body so one account can be claimed alone', async () => {
    let received: string | undefined = 'unset'
    const handler = mountRoutes({
      store,
      models: () => [],
      claim: async (id) => {
        received = id
        return { ok: true, claimed: true, state: 'claimed', amount: 1000, message: 'ok' }
      },
    }).get(CODEARTS_CLAIM_PATH)!
    const res = await call(
      handler,
      POST,
      CODEARTS_CLAIM_PATH,
      { 'content-type': 'application/json' },
      JSON.stringify({ id: 'uid-b' }),
    )
    expect(received).toBe('uid-b')
    expect(res.status).toBe(200)
  })

  it('claims every account when the body carries no id', async () => {
    let received: string | undefined = 'unset'
    const handler = mountRoutes({
      store,
      models: () => [],
      claim: async (id) => {
        received = id
        return { ok: true, claimed: true, state: 'claimed', amount: 1000, message: 'ok' }
      },
    }).get(CODEARTS_CLAIM_PATH)!
    const res = await call(
      handler,
      POST,
      CODEARTS_CLAIM_PATH,
      { 'content-type': 'application/json' },
      JSON.stringify({}),
    )
    expect(received).toBeUndefined()
    expect(res.status).toBe(200)
  })

  it('404s when no claim handler is attached', async () => {
    const res = await call(routes.get(CODEARTS_CLAIM_PATH)!, POST, CODEARTS_CLAIM_PATH)
    expect(res.status).toBe(404)
  })
})

describe('summarizeClaims', () => {
  it('reports the batch as claimed when any account won, with per-account results', () => {
    const summary = summarizeClaims([
      { id: 'uid-a', ok: true, claimed: true, state: 'claimed', amount: 1000, message: 'ok' },
      { id: 'uid-b', ok: true, claimed: false, state: 'already', amount: 0, message: '' },
    ])
    expect(summary).toMatchObject({ ok: true, claimed: true, state: 'claimed', amount: 1000 })
    expect(summary.results?.map(result => result.id)).toEqual(['uid-a', 'uid-b'])
  })

  it('marks the batch failed when any account failed, keeping the others', () => {
    const summary = summarizeClaims([
      { id: 'uid-a', ok: false, claimed: false, state: 'failed', amount: 0, message: 'decrypt token fail' },
      { id: 'uid-b', ok: true, claimed: true, state: 'claimed', amount: 1000, message: 'ok' },
    ])
    expect(summary.ok).toBe(false)
    expect(summary.claimed).toBe(true)
    expect(summary.amount).toBe(1000)
    expect(summary.results).toHaveLength(2)
  })
})

describe('POST /api/codearts/refresh-models', () => {
  afterEach(() => {
    clearBenefitBlocked()
    setDiscoveredBenefitModels([])
  })

  const benefitCatalog = [
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · x0.00 · 福利', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
    { id: 'GLM-5.2', name: 'GLM-5.2 · x0.70', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true, ratio: '0.7x' },
  ]

  function refreshHandler(refreshModels?: () => Promise<{ models: number; benefit: number; refreshed: boolean }>): Handler {
    return mountRoutes({ store, models: () => benefitCatalog, refreshModels }).get(CODEARTS_REFRESH_MODELS_PATH)!
  }

  // 福利权益缺失是按天记的；用户点刷新就是「上游回来了，别再灰着」。
  it('clears today\'s benefit-blocked marks and answers with the fresh selection', async () => {
    setDiscoveredBenefitModels(['glm-5.3-flash'])
    markBenefitBlocked('glm-5.3-flash')
    const refreshModels = vi.fn(async () => ({ models: 2, benefit: 1, refreshed: true }))
    const res = await call(refreshHandler(refreshModels), POST, CODEARTS_REFRESH_MODELS_PATH)
    expect(refreshModels).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, models: 2, benefit: 1, refreshed: true })
    const choices = (res.body?.selection as { choices: { id: string; benefit?: boolean; blocked?: boolean; ratio?: string }[] }).choices
    // 福利模型不论上游给的 credit，倍率一律是 x0.00；普通模型照抄上游。
    expect(choices.find(c => c.id === 'glm-5.3-flash')).toMatchObject({ benefit: true, blocked: false, ratio: 'x0.00' })
    expect(choices.find(c => c.id === 'GLM-5.2')).toMatchObject({ benefit: false, ratio: 'x0.70' })
  })

  it('still reports the blocked ones when upstream did not answer', async () => {
    setDiscoveredBenefitModels(['glm-5.3-flash'])
    markBenefitBlocked('glm-5.3-flash')
    const res = await call(refreshHandler(async () => ({ models: 2, benefit: 1, refreshed: false })), POST, CODEARTS_REFRESH_MODELS_PATH)
    expect(res.status).toBe(200)
    expect(res.body?.refreshed).toBe(false)
    expect(isBenefitBlocked('glm-5.3-flash')).toBe(false)
  })

  it('reports a failing refresh as 500 with the reason', async () => {
    const res = await call(refreshHandler(async () => {
      throw new Error('model discovery failed on every source')
    }), POST, CODEARTS_REFRESH_MODELS_PATH)
    expect(res.status).toBe(500)
    expect(res.body?.message).toContain('every source')
  })

  it('404s when no refresh handler is attached', async () => {
    const res = await call(routes.get(CODEARTS_REFRESH_MODELS_PATH)!, POST, CODEARTS_REFRESH_MODELS_PATH)
    expect(res.status).toBe(404)
  })
})
