import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeArtsAccountPool } from '../src/account-pool.ts'
import { createCodeArtsShim, type CodeArtsShim } from '../src/shim.ts'

/**
 * 多账号轮转的核心行为：一个账号撞上「并发会话数已达上限」时，请求应当**换下一个
 * 账号**继续，而不是让用户干等 —— 用户的实际痛点就是「打断生成后重新提问，卡住
 * 不继续」，而打断会让那个账号的会话槽位占满约 52 秒。
 */

const TOKEN_A = 'token-account-a'
const TOKEN_B = 'token-account-b'

/** 上游的并发上限错误（HTTP 400 + TM.00001041）。 */
const CAP_BODY = JSON.stringify({
  error_code: 'TM.00001041',
  error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。',
})

/** 模型级 TPM 限流：2026-10-21 实测是 HTTP 200 + 流内 error_code（当天真实码是 81114）。 */
const TPM_FRAME = 'data: {"error_code":"InferHub.ModelArts.81114.429","error_msg":"Too many requests, the rate limit is 50000000 tokens per minute."}\n\n'

/**
 * 出网走 upstream.ts 的 dispatch：只给「字符串 URL + 普通 init」，头部是键已小写的
 * 普通对象（不能传 Request —— 邻居插件换了 globalThis.fetch 后会认不出）。
 */
function authTokenOf(init: { headers?: unknown } | undefined): string {
  return ((init?.headers ?? {}) as Record<string, string>)['x-auth-token'] ?? ''
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const OK_CHUNKS = [
  'data: {"choices":[{"index":0,"delta":{"content":"来自 B"},"finish_reason":null}]}\n\n',
  'data: [DONE]\n\n',
]

function post(port: number, bearer: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true })
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      const parts: Buffer[] = []
      res.on('data', (chunk: Buffer) => parts.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/** 发起一次聊天，`abortAfterMs` 之后模拟用户点「停止生成」（断开连接）。 */
function postAbortable(port: number, bearer: string, abortAfterMs: number): Promise<void> {
  return new Promise(resolve => {
    const payload = JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true })
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      res.on('data', () => {})
      res.on('end', () => resolve())
    })
    req.on('error', () => resolve())
    setTimeout(() => { req.destroy(); resolve() }, abortAfterMs)
    req.write(payload)
    req.end()
  })
}

let shim: CodeArtsShim
let port: number
let bearer: string
let pool: CodeArtsAccountPool
let ids: string[]
/** 记录每次上游请求用的是哪个账号的 token。 */
let seenTokens: string[]

function credentialFor(id: string): { token: string; accessKeyId: string; secretAccessKey: string; securityToken: string } {
  return { token: id === 'A' ? TOKEN_A : TOKEN_B, accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'sts' }
}

/**
 * 假上游。账号 A 默认**永远**回并发上限（用户打断后那个账号的处境）；
 * `capOnce` 让 A 只被拒第一次、之后放行，用来测单账号的原地重试兜底。
 * 账号 B 永远正常。
 */
function stubUpstream(options: { capTimes?: number; tpmTimes?: number } = {}): void {
  let aCalls = 0
  const capTimes = options.capTimes ?? (options.tpmTimes === undefined ? Number.POSITIVE_INFINITY : 0)
  const tpmTimes = options.tpmTimes ?? 0
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { headers?: unknown }) => {
    const token = authTokenOf(init)
    seenTokens.push(token)
    if (token === TOKEN_A) {
      aCalls += 1
      if (aCalls <= tpmTimes) return sseResponse([TPM_FRAME])
      if (aCalls <= capTimes) {
        return new Response(CAP_BODY, { status: 400, headers: { 'content-type': 'application/json' } })
      }
    }
    return sseResponse(OK_CHUNKS)
  }))
}

async function start(accountIds: string[], options: { capTimes?: number; tpmTimes?: number } = {}): Promise<void> {
  ids = accountIds
  seenTokens = []
  stubUpstream(options)
  pool = new CodeArtsAccountPool([])
  shim = createCodeArtsShim({
    store: {
      ids: async () => ids,
      resolve: async (id: string) => credentialFor(id),
    } as never,
    catalog: { current: () => [] } as never,
    pool,
  })
  await shim.ready
  port = Number(new URL(shim.baseUrl()).port)
  bearer = shim.token()
}

beforeEach(() => {
  ids = ['A', 'B']
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await shim?.close()
})

describe('cross-account failover', () => {
  it('hands a capped request to the next account instead of waiting', async () => {
    await start(['A', 'B'])
    const res = await post(port, bearer)

    expect(res.status).toBe(200)
    expect(res.text).toContain('来自 B')
    // A 试过、被拒，然后换 B —— 两个账号都用到了。
    expect(seenTokens).toEqual([TOKEN_A, TOKEN_B])
  })

  it('remembers which account was capped so the next request prefers the other one', async () => {
    await start(['A', 'B'])
    await post(port, bearer)
    seenTokens = []

    await post(port, bearer)

    // 第二次请求应当**先**用 B：A 刚撞过上限，池会优先避开它。
    expect(seenTokens[0]).toBe(TOKEN_B)
    expect(pool.get('A')?.cappedUntil).toBeGreaterThan(0)
  })

  // 撞上限不冷却账号：账号没坏，只是槽位暂时满了。冷却会让它在一分钟内彻底
  // 不可用，把后续请求一起误伤。
  it('does not disable or cool down an account that hit the concurrency cap', async () => {
    await start(['A', 'B'])
    await post(port, bearer)

    const a = pool.get('A')
    expect(a?.disabled).toBe(false)
    expect(a?.coolUntil).toBe(0)
    expect(pool.healthy('A')).toBe(true)
  })

  it('disables an account whose credential is rejected, and uses the other one', async () => {
    ids = ['A', 'B']
    seenTokens = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { headers?: unknown }) => {
      const token = authTokenOf(init)
      seenTokens.push(token)
      if (token === TOKEN_A) {
        return new Response('{"error_code":"401","error_msg":"token invalid"}', {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      }
      return sseResponse(OK_CHUNKS)
    }))
    pool = new CodeArtsAccountPool([])
    shim = createCodeArtsShim({
      store: { ids: async () => ids, resolve: async (id: string) => credentialFor(id) } as never,
      catalog: { current: () => [] } as never,
      pool,
    })
    await shim.ready
    port = Number(new URL(shim.baseUrl()).port)
    bearer = shim.token()

    const res = await post(port, bearer)
    expect(res.status).toBe(200)
    expect(res.text).toContain('来自 B')
    expect(pool.get('A')?.disabled).toBe(true)
  })

  // 用户「随时打断」不该有任何代价。曾经不是这样：在收到第一个字节之前中止，
  // fetch 抛的 AbortError 被当成上游 5xx，于是这个账号被冷却 30 秒 —— 打断几次
  // 之后 pick() 选不出账号，表现就是「打断之后再也问不动了」。
  describe('client abort', () => {
    /**
     * 第一个请求永远不响应，直到客户端断开 —— 模拟「还没出字就点了停止」，
     * 也就是最容易踩到那个误判的时机。之后放行，便于测紧接着的请求。
     */
    async function startWithHangingFirstCall(): Promise<void> {
      ids = ['A']
      seenTokens = []
      let hang = true
      vi.stubGlobal('fetch', vi.fn(async (_input: Request, init?: { signal?: AbortSignal }) => {
        seenTokens.push('A')
        if (hang) {
          hang = false
          // 忠实模拟 fetch：signal 中止时以 AbortError 拒绝。
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('This operation was aborted')
              err.name = 'AbortError'
              reject(err)
            }, { once: true })
          })
        }
        return sseResponse(OK_CHUNKS)
      }))
      pool = new CodeArtsAccountPool([])
      shim = createCodeArtsShim({
        store: { ids: async () => ids, resolve: async (id: string) => credentialFor(id) } as never,
        catalog: { current: () => [] } as never,
        pool,
      })
      await shim.ready
      port = Number(new URL(shim.baseUrl()).port)
      bearer = shim.token()
    }

    const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))

    it('does not cool down or disable the account', async () => {
      await startWithHangingFirstCall()
      await postAbortable(port, bearer, 150)
      await settle()

      const account = pool.get('A')
      expect(account?.disabled).toBe(false)
      expect(account?.coolUntil).toBe(0)
      expect(account?.activeConcurrent).toBe(0)
      expect(pool.healthy('A')).toBe(true)
    })

    it('lets the very next request through immediately', async () => {
      await startWithHangingFirstCall()
      await postAbortable(port, bearer, 150)
      await settle()

      const started = Date.now()
      const res = await post(port, bearer)
      expect(res.status).toBe(200)
      // 没有被冷却的话，第二次请求应当是毫秒级；30 秒冷却会在这里露馅。
      expect(Date.now() - started).toBeLessThan(3_000)
    })
  })

  // 单账号没有别的号可换，只能原地等槽位释放 —— 这是兜底路径。
  it('falls back to waiting when it is the only account and the cap clears', async () => {
    // A 连拒两次：一次在主循环里，一次在兜底重试的第一次。第三次才放行，
    // 所以中间必然要等一个重试间隔。
    await start(['A'], { capTimes: 2 })
    const started = Date.now()
    const res = await post(port, bearer)

    expect(res.status).toBe(200)
    expect(res.text).toContain('来自 B')
    expect(Date.now() - started).toBeGreaterThan(1_000)
    expect(seenTokens.length).toBeGreaterThanOrEqual(2)
  }, 20_000)

  // 2026-10-21：TPM 限流以流内首帧返回（HTTP 200），以前会被当成正常流原样透传，
  // 用户只看到一句英文 PI_AI_ERROR。它应当像并发上限一样进入本地排队。
  it('queues on a first-frame TPM error and then delivers the retry', async () => {
    // 第一次在主循环里撞 TPM，排队后的第一次重试再撞一次，第三次才放行。
    await start(['A'], { tpmTimes: 2 })
    const started = Date.now()
    const res = await post(port, bearer)

    expect(res.status).toBe(200)
    expect(res.text).toContain('来自 B')
    expect(Date.now() - started).toBeGreaterThan(3_000)
    expect(seenTokens.length).toBe(3)
  }, 20_000)

  // TPM 是配额问题，不是账号坏了；排队期间绝不能把它冷却/停用。
  it('does not cool down an account that hit the TPM limit', async () => {
    await start(['A'], { tpmTimes: 2 })
    await post(port, bearer)

    const a = pool.get('A')
    expect(a?.disabled).toBe(false)
    expect(a?.coolUntil).toBe(0)
    expect(pool.healthy('A')).toBe(true)
  }, 20_000)
})

/**
 * issue #1：billion-context 在宿主层拦截出站请求做压缩，碰到 SDK-HMAC-SHA256
 * 签名请求要用 CodeArts 凭据重签，找不到凭据就在**本地**回 403（根本没出网）。
 * 这绝不能被当成凭据失效 —— 否则账号被永久禁用，重启、重新登录都救不回来。
 */
describe('local proxy resign refusal (issue #1)', () => {
  /** billion-context 拒签时的真实响应形状（403 + 这两个标记）。 */
  const RESIGN_BODY = JSON.stringify({
    error: {
      type: 'signed_request_requires_resign',
      code: 'bili_resign_unavailable',
      message: 'bili refused to forward this sdk-hmac-sha256-signed request: the signature covers the request body.',
    },
  })

  async function startWithUpstream(body: string, status: number): Promise<void> {
    ids = ['A']
    seenTokens = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { headers?: unknown }) => {
      seenTokens.push(authTokenOf(init))
      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }))
    pool = new CodeArtsAccountPool([])
    shim = createCodeArtsShim({
      store: { ids: async () => ids, resolve: async (id: string) => credentialFor(id) } as never,
      catalog: { current: () => [] } as never,
      pool,
    })
    await shim.ready
    port = Number(new URL(shim.baseUrl()).port)
    bearer = shim.token()
  }

  it('does not disable the account, and answers 400 with an actionable hint', async () => {
    await startWithUpstream(RESIGN_BODY, 403)
    const res = await post(port, bearer)

    // 400 而不是 429：宿主只自动重试 429，400 一次就把真因说清。
    expect(res.status).toBe(400)
    expect(res.text).toContain('billion-context')
    // 账号没坏 —— 是本地代理拒签。禁用它就是 issue #1 里「再也问不动」的根因。
    const a = pool.get('A')
    expect(a?.disabled).toBe(false)
    expect(a?.coolUntil).toBe(0)
    expect(pool.healthy('A')).toBe(true)
  })

  // 回归保护：不带拒签标记的真 403 依旧是凭据失效，照样禁用账号。
  it('a plain 403 still means session_dead and disables the account', async () => {
    await startWithUpstream('{"error_code":"403","error_msg":"forbidden"}', 403)
    const res = await post(port, bearer)

    expect(pool.get('A')?.disabled).toBe(true)
    expect(res.status).toBe(401)
    expect(res.text).not.toContain('billion-context')
  })
})

/**
 * 一个账号都选不出来时，报错必须说清是哪种「没有」—— 全禁用（附最后错误）、
 * 冷却中（附剩余秒数），还是本地槽位全满。以前三种都是同一句「没有可用账号」，
 * 把真因整个吞掉（issue #1）。
 */
describe('no-account error message', () => {
  it('names the disable reason and points at re-login when every account is disabled', async () => {
    await start(['A'], { capTimes: 0 })
    pool.sync(['A'])
    pool.disable('A', 'HTTP 403 signed_request_requires_resign')

    const res = await post(port, bearer)

    expect(res.status).toBe(401)
    expect(res.text).toContain('被禁用')
    expect(res.text).toContain('signed_request_requires_resign')
    expect(res.text).toContain('重新登录')
    // 一个可用账号都没有时绝不能出网。
    expect(seenTokens.length).toBe(0)
  })

  it('says the local slots are full when every healthy account is busy', async () => {
    // 两个在飞请求占满 A 的本地槽位（每账号 2 个），第三个应当立刻拿到
    // 「槽位已满」而不是笼统的「没有可用账号」。
    ids = ['A']
    seenTokens = []
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      seenTokens.push(authTokenOf(init as { headers?: unknown }))
      // 一直挂着，直到客户端断开（模拟在飞的长请求）。
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return sseResponse(OK_CHUNKS)
    }))
    pool = new CodeArtsAccountPool([])
    shim = createCodeArtsShim({
      store: { ids: async () => ids, resolve: async (id: string) => credentialFor(id) } as never,
      catalog: { current: () => [] } as never,
      pool,
    })
    await shim.ready
    port = Number(new URL(shim.baseUrl()).port)
    bearer = shim.token()

    const inflight = [postAbortable(port, bearer, 2_000), postAbortable(port, bearer, 2_000)]
    // 等两个请求都把槽位占上。
    await vi.waitFor(() => { expect(seenTokens.length).toBe(2) })

    const res = await post(port, bearer)
    expect(res.status).toBe(429)
    expect(res.text).toContain('槽位已满')
    expect(res.text).not.toContain('被禁用')

    await Promise.all(inflight)
  })

  it('says how long the cooldown lasts when every account is cooling', async () => {
    await start(['A'], { capTimes: 0 })
    pool.sync(['A'])
    pool.cooldown('A', 30_000, 'upstream 500')

    const res = await post(port, bearer)
    expect(res.status).toBe(429)
    expect(res.text).toContain('冷却')
    expect(seenTokens.length).toBe(0)
  })
})
