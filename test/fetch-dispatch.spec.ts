import { afterEach, describe, expect, it, vi } from 'vitest'
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
