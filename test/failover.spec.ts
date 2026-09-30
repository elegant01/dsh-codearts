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
function stubUpstream(options: { capTimes?: number } = {}): void {
  let aCalls = 0
  const capTimes = options.capTimes ?? Number.POSITIVE_INFINITY
  vi.stubGlobal('fetch', vi.fn(async (input: Request) => {
    const token = input.headers.get('x-auth-token') ?? ''
    seenTokens.push(token)
    if (token === TOKEN_A) {
      aCalls += 1
      if (aCalls <= capTimes) {
        return new Response(CAP_BODY, { status: 400, headers: { 'content-type': 'application/json' } })
      }
    }
    return sseResponse(OK_CHUNKS)
  }))
}

async function start(accountIds: string[], options: { capTimes?: number } = {}): Promise<void> {
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
    vi.stubGlobal('fetch', vi.fn(async (input: Request) => {
      const token = input.headers.get('x-auth-token') ?? ''
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
})
