import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodeArtsShim, type CodeArtsShim } from '../src/shim.ts'
import { CodeArtsUsageTracker } from '../src/usage.ts'

/**
 * Drives the shim over raw node:http rather than fetch, because fetch refuses
 * to let a caller set a Host header — and a forged Host is exactly what the
 * DNS-rebinding case has to exercise.
 */
interface RawResponse {
  status: number
  body: unknown
}

function raw(port: number, options: {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: options.headers,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          // Leave non-JSON bodies as text.
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const CATALOG = [
  { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek-V4-Flash (免费)', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
]

let shim: CodeArtsShim
let port: number
let bearer: string
let resolveCredential: () => Promise<unknown>
/** 账号存储里现有的账号 id；空数组即「没登录」。 */
let storeIds: string[]

beforeEach(async () => {
  storeIds = ['acct']
  resolveCredential = async () => ({
    token: 'sts-token',
    accessKeyId: 'AKID',
    secretAccessKey: 'SK',
    securityToken: 'sts-token',
  })
  shim = createCodeArtsShim({
    store: { ids: async () => storeIds, resolve: () => resolveCredential() } as never,
    catalog: { current: () => CATALOG } as never,
  })
  await shim.ready
  port = Number(new URL(shim.baseUrl()).port)
  bearer = shim.token()
})

afterEach(async () => {
  await shim.close()
})

const okHeaders = (): Record<string, string> => ({
  host: `127.0.0.1:${port}`,
  authorization: `Bearer ${bearer}`,
})

describe('shim loopback gate', () => {
  it('serves a well-formed loopback request', async () => {
    const res = await raw(port, { path: '/healthz', headers: okHeaders() })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  // A DNS-rebinding page resolves attacker.com to 127.0.0.1, so the request
  // arrives with the attacker's name in Host. The gate must drop it.
  it('rejects a non-loopback Host with 403', async () => {
    const res = await raw(port, {
      path: '/healthz',
      headers: { host: 'evil.example', authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('host_not_allowed')
  })

  // Regression guard: the wildcard bind address is not a loopback identity.
  it('rejects a wildcard Host with 403', async () => {
    for (const host of ['0.0.0.0', '0.0.0.0:1234', '[::]']) {
      const res = await raw(port, {
        path: '/healthz',
        headers: { host, authorization: `Bearer ${bearer}` },
      })
      expect(res.status, `Host: ${host}`).toBe(403)
    }
  })

  it('rejects a cross-origin request with 403', async () => {
    const res = await raw(port, {
      path: '/healthz',
      headers: { ...okHeaders(), origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('origin_not_allowed')
  })

  it('accepts a loopback Origin', async () => {
    const res = await raw(port, {
      path: '/healthz',
      headers: { ...okHeaders(), origin: `http://127.0.0.1:${port}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('shim bearer gate', () => {
  it('rejects a missing bearer with 401', async () => {
    const res = await raw(port, { path: '/healthz', headers: { host: `127.0.0.1:${port}` } })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong bearer with 401', async () => {
    const res = await raw(port, {
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: 'Bearer not-the-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a bearer of the right length but wrong value', async () => {
    const forged = 'x'.repeat(bearer.length)
    const res = await raw(port, {
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${forged}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('shim routing', () => {
  it('lists the catalog on /v1/models', async () => {
    const res = await raw(port, { path: '/v1/models', headers: okHeaders() })
    expect(res.status).toBe(200)
    const ids = (res.body as { data: { id: string }[] }).data.map(m => m.id)
    expect(ids).toEqual(['GLM-5.2', 'deepseek-v4-flash-0731'])
  })

  it('404s an unknown route', async () => {
    const res = await raw(port, { path: '/nope', headers: okHeaders() })
    expect(res.status).toBe(404)
  })

  it('rejects a non-JSON chat body with 415', async () => {
    const res = await raw(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { ...okHeaders(), 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).toBe(415)
  })

  it('reports not-signed-in as 401 when the store has no credential', async () => {
    storeIds = []
    const res = await raw(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { ...okHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [] }),
    })
    expect(res.status).toBe(401)
  })
})

/**
 * 用量记账走的是真实 HTTP 路径：请求体 -> 上游（打桩 SSE）-> 转发 -> 账本。
 * 这是「卡片上今日用量」唯一的真源，所以按端到端来测，而不是直接调账本 API。
 */
describe('usage accounting', () => {
  const SSE = [
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')

  async function chatAndDrain(tracker: CodeArtsUsageTracker, port: number, bearer: string): Promise<void> {
    const res = await raw(port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    // raw() 读到流结束才 resolve，此时记账已经发生。
    expect(tracker.snapshot().today.requests).toBeGreaterThan(0)
  }

  it('records the usage frame that the upstream sends at the end of the stream', async () => {
    vi.stubGlobal('fetch', async () => new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const usage = new CodeArtsUsageTracker()
    const withUsage = createCodeArtsShim({
      store: { ids: async () => ['acct'], resolve: async () => ({ token: 'sts-token', accessKeyId: 'AKID', secretAccessKey: 'SK', securityToken: 'sts-token' }) } as never,
      catalog: { current: () => CATALOG } as never,
      usage,
    })
    try {
      await withUsage.ready
      const p = Number(new URL(withUsage.baseUrl()).port)
      await chatAndDrain(usage, p, withUsage.token())
      const snapshot = usage.snapshot()
      expect(snapshot.today).toEqual({ requests: 1, promptTokens: 12, completionTokens: 3, totalTokens: 15 })
      expect(snapshot.byAccountToday['acct']?.totalTokens).toBe(15)
      expect(snapshot.byModelToday[0]?.id).toBe('GLM-5.2')
    } finally {
      await withUsage.close()
      vi.unstubAllGlobals()
    }
  })

  it('counts the request even when the stream dies before any usage frame', async () => {
    vi.stubGlobal('fetch', async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const usage = new CodeArtsUsageTracker()
    const withUsage = createCodeArtsShim({
      store: { ids: async () => ['acct'], resolve: async () => ({ token: 'sts-token', accessKeyId: 'AKID', secretAccessKey: 'SK', securityToken: 'sts-token' }) } as never,
      catalog: { current: () => CATALOG } as never,
      usage,
    })
    try {
      await withUsage.ready
      const p = Number(new URL(withUsage.baseUrl()).port)
      await chatAndDrain(usage, p, withUsage.token())
      const snapshot = usage.snapshot()
      expect(snapshot.today.requests).toBe(1)
      expect(snapshot.today.totalTokens).toBe(0)
    } finally {
      await withUsage.close()
      vi.unstubAllGlobals()
    }
  })
})

/**
 * 排队闸门的出口：没轮到就不发聊天请求，并把上游那句排队文案回给宿主。
 *
 * 状态码必须是 400 而不是 429 —— 宿主的 classifyPiAiError 按文本里的状态码归类，
 * 429 会被判成 RATE_LIMIT 并自动重试 5 次（实测），用户看到的是「一直转圈」。
 */
describe('queue gate replies', () => {
  async function withGate(outcome: unknown): Promise<{ port: number; bearer: string; close: () => Promise<void> }> {
    const upstream = vi.fn(async () => {
      throw new Error('排队没等到时不该发聊天请求')
    })
    vi.stubGlobal('fetch', upstream)
    const gated = createCodeArtsShim({
      store: { ids: async () => ['acct'], resolve: async () => ({ token: 't', securityToken: 't' }) } as never,
      catalog: { current: () => CATALOG } as never,
      queue: { wait: async () => outcome } as never,
    })
    await gated.ready
    return {
      port: Number(new URL(gated.baseUrl()).port),
      bearer: gated.token(),
      close: async () => {
        await gated.close()
        vi.unstubAllGlobals()
      },
    }
  }

  const chat = async (shimPort: number, token: string) =>
    raw(shimPort, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { host: `127.0.0.1:${shimPort}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

  it('answers a queued verdict with 400 and the upstream wording', async () => {
    const gated = await withGate({ kind: 'queued', position: 595, length: 600, message: '当前请求量较大，您排在第595位。' })
    try {
      const res = await chat(gated.port, gated.bearer)
      expect(res.status).toBe(400)
      const error = (res.body as { error: { code: string; message: string } }).error
      expect(error.code).toBe('queued')
      expect(error.message).toContain('您排在第595位')
      expect(error.message).toContain('请稍后重试')
      // 429/timeout 这类词会踩到宿主的重试分类，正文里不能出现。
      expect(error.message).not.toMatch(/\b429\b|rate.?limit|timeout/i)
    } finally {
      await gated.close()
    }
  })

  it('answers queue_full with 429 and never opens the chat request', async () => {
    const gated = await withGate({ kind: 'queue_full', message: '队列已满，请稍后再试' })
    try {
      const res = await chat(gated.port, gated.bearer)
      expect(res.status).toBe(429)
      expect((res.body as { error: { message: string } }).error.message).toBe('队列已满，请稍后再试')
    } finally {
      await gated.close()
    }
  })
})
