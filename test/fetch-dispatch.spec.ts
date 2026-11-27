import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  chatStream,
  clearQueueStatus,
  fetchQueueStatus,
  fetchWelfareCampaigns,
  signedGet,
  SNAP_HOST,
} from '../src/upstream.ts'

/**
 * Regression guard for issue #2 (GitHub): 邻居插件把 `globalThis.fetch` 换成它自己那份
 * undici 之后，`fetch(new Request(...))` 会因为认不出外来 Request 而被当成 URL 字符串，
 * 报 `Failed to parse URL from [object Request]`，HTTP 0、根本没出网 —— 表现就是
 * 「积分不可用」+「models 为空」。所以插件出网只能传字符串 URL 和普通 init。
 */

const credential = {
  token: 'sts-token',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  securityToken: 'sts-token',
}

interface Call {
  input: unknown
  init: RequestInit | undefined
}

/** 伪装成「另一份 undici 的 fetch」：非字符串 input 一律按它的写法抛错。 */
function foreignFetch(reply: () => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    if (typeof input !== 'string') {
      throw new TypeError(`Failed to parse URL from ${String(input)}`)
    }
    return reply()
  }))
  return calls
}

const json = (body: string): Response => new Response(body, { status: 200 })

const sse = (frames: readonly string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const frame of frames) controller.enqueue(enc.encode(frame))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

/** init.headers 既可能是普通对象也可能是 Headers，测试里统一读成 Record。 */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers
  if (raw === undefined) return {}
  if (raw instanceof Headers) {
    const out: Record<string, string> = {}
    raw.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(raw)) return Object.fromEntries(raw as [string, string][])
  return { ...(raw as Record<string, string>) }
}

afterEach(() => vi.unstubAllGlobals())

describe('outbound requests never carry a Request object', () => {
  it('signedGet sends the url as a string and keeps the signed headers byte-for-byte', async () => {
    const calls = foreignFetch(() => json('{"ok":true}'))
    const outcome = await signedGet(`${SNAP_HOST}/v1/model/builtin`, credential, 'AgentCenter')

    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe(`${SNAP_HOST}/v1/model/builtin`)
    const headers = headerRecord(calls[0]!.init)
    expect(headers['agent-type']).toBe('AgentCenter')
    expect(headers['x-security-token']).toBe('sts-token')
    // 签名头里有 =+/ 这些字符，展开成普通对象不能改动它们。
    expect(headers.authorization).toMatch(/^SDK-HMAC-SHA256 /)
    expect(headers['x-sdk-date']).toMatch(/^\d{8}T\d{6}Z$/)
    // GET 带 body 会被 fetch 直接拒，所以这个键必须整个不存在。
    expect(calls[0]!.init?.body).toBeUndefined()
    expect(calls[0]!.init?.method).toBe('GET')
  })

  it('chatStream forwards the prepared body and the post-signature Chat-Id', async () => {
    const calls = foreignFetch(() => sse([
      'data: {"choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const payload = JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: '你好' }], stream: true })
    const result = await chatStream(credential, {
      url: `${SNAP_HOST}/api/v2/chat/completions`,
      body: payload,
      model: 'GLM-5.2',
      chatId: 'chat-1',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(calls[0]!.input).toBe(`${SNAP_HOST}/api/v2/chat/completions`)
    expect(calls[0]!.init?.method).toBe('POST')
    // 中文正文要逐字节无损：Buffer 原样交给 fetch，不做二次编码。
    expect(Buffer.from(calls[0]!.init!.body as Uint8Array).toString('utf8')).toBe(payload)
    const headers = headerRecord(calls[0]!.init)
    expect(headers['chat-id']).toBe('chat-1')
    expect(headers['session-id']).toBeTruthy()
    expect(headers.authorization).toMatch(/^SDK-HMAC-SHA256 /)

    // 读干流，别留一个悬着的 reader。
    const reader = result.stream.getReader()
    let text = ''
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
    expect(text).toContain('pong')
  })

  it('queue status GET and the clearing DELETE go out as urls', async () => {
    const calls = foreignFetch(() => json('{"status":"working","queue_length":0,"queue_position":0,"message":""}'))

    await expect(fetchQueueStatus(credential, 'chat-1', 'GLM-5.2')).resolves.toMatchObject({ status: 'working' })
    await clearQueueStatus(credential, 'chat-1', 'GLM-5.2')

    expect(calls).toHaveLength(2)
    expect(String(calls[0]!.input)).toContain('/api/v1/queue/status?task_id=chat-1')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
    expect(calls[1]!.init?.method).toBe('DELETE')
    expect(calls[1]!.init?.body).toBeUndefined()
  })

  it('the welfare gateway sees the signed query as a plain url', async () => {
    const calls = foreignFetch(() => json('{"code":0,"message":"ok","data":{"items":[]}}'))

    await expect(fetchWelfareCampaigns(credential)).resolves.toEqual([])

    expect(calls[0]!.input).toBe(`${SNAP_HOST}/v1/ops/delivery?channel=IDE`)
    const headers = headerRecord(calls[0]!.init)
    expect(headers['agent-type']).toBe('PromptCenter')
    expect(headers.authorization).toMatch(/^SDK-HMAC-SHA256 /)
  })
})

/**
 * issue #23：billion-context 把 `globalThis.fetch` 接进它自己的链路，对「未归属
 * 会话、又超过静默直连上限」的请求在**本地**回 422 + `x-bili-gate:
 * oversize-refusal*`，根本没出网。插件要能认出这个标记，换自己的 node:http(s)
 * 连接直发，而不是把它的本地拒绝当成上游错误。
 */
describe('neighbor gate refusal falls back to a direct connection', () => {
  const biliRefusal = (): Response => new Response(JSON.stringify({
    error: {
      type: 'server_error',
      code: 'bili_gate_oversize_refusal_unattributed_bytes',
      message: 'billion-context refused this request locally',
      retryable: true,
    },
  }), { status: 422, headers: { 'content-type': 'application/json', 'x-bili-gate': 'oversize-refusal-unattributed-bytes' } })

  const payload = JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: '你好' }], stream: true })

  /** 假上游：记录直连收到的请求，回一段最小 SSE。 */
  async function listen(): Promise<{ server: Server; url: string; seen: { body: string; authorization: string; count: number } }> {
    const seen = { body: '', authorization: '', count: 0 }
    const server = createServer((req, res) => {
      seen.count += 1
      seen.authorization = String(req.headers.authorization ?? '')
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.body = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          'data: {"choices":[{"index":0,"delta":{"content":"直连成功"},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
        )
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return { server, url: `http://127.0.0.1:${port}/api/v2/chat/completions`, seen }
  }

  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text
      text += decoder.decode(value, { stream: true })
    }
  }

  it('resends the signed request over its own connection', async () => {
    const upstream = await listen()
    try {
      const calls = foreignFetch(biliRefusal)
      const result = await chatStream(credential, {
        url: upstream.url,
        body: payload,
        model: 'GLM-5.2',
        chatId: 'chat-1',
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)
      // 先走了全局 fetch（发现被本地拒收），再改走自己的连接。
      expect(calls).toHaveLength(1)
      expect(upstream.seen.count).toBe(1)
      // 请求体与签名头原样保留：直连只是换传输，不改协议内容。
      expect(upstream.seen.body).toBe(payload)
      expect(upstream.seen.authorization).toMatch(/^SDK-HMAC-SHA256 /)
      expect(await drain(result.stream)).toContain('直连成功')
    } finally {
      upstream.server.closeAllConnections()
      await new Promise<void>(resolve => upstream.server.close(() => resolve()))
    }
  })

  it('leaves a genuine upstream 422 alone', async () => {
    const upstream = await listen()
    try {
      foreignFetch(() => new Response('{"error":{"code":"something_real"}}', {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }))
      const result = await chatStream(credential, { url: upstream.url, body: payload, model: 'GLM-5.2' })

      expect(result.ok).toBe(false)
      // 没有 bili 标记头就按上游错误处理，不偷偷重发。
      expect(upstream.seen.count).toBe(0)
    } finally {
      upstream.server.closeAllConnections()
      await new Promise<void>(resolve => upstream.server.close(() => resolve()))
    }
  })
})
