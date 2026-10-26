import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodeArtsShim, type CodeArtsShim } from '../src/shim.ts'
import { clearBenefitBlocked, isBenefitBlocked } from '../src/catalog.ts'
import { resetTokenCeilings } from '../src/upstream.ts'

/**
 * End-to-end over the real HTTP surface: a stubbed upstream emits CodeArts SSE,
 * and we assert what a DSH client would actually receive from the shim.
 *
 * This is the layer INSTALL.md flagged as "尚未端到端验证" — the standalone
 * probes proved the upstream answers, not that the in-process stream
 * translation produces a well-formed OpenAI SSE stream.
 */

/** Build a Response whose body streams the given raw SSE text pieces. */
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

/** POST to the shim and collect the full SSE response text. */
function postSse(port: number, bearer: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
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

/** The frames a real upstream sends, as separate TCP writes. */
const OPENAI_CHUNKS = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"，世界"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  // The usage frame: empty choices, present because prepareChatBody forces
  // stream_options.include_usage. DSH's usage pill reads exactly this.
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n',
  'data: [DONE]\n\n',
]

/** Parse the concatenated SSE text into the JSON payloads (excluding [DONE]). */
function payloads(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const raw = trimmed.slice(5).trim()
    if (raw === '' || raw === '[DONE]') continue
    try {
      out.push(JSON.parse(raw))
    } catch {
      out.push({ __unparsable: raw })
    }
  }
  return out
}

function deltaText(text: string): string {
  const parts: string[] = []
  for (const frame of payloads(text) as { choices?: { delta?: { content?: string } }[] }[]) {
    for (const choice of frame.choices ?? []) {
      if (typeof choice.delta?.content === 'string') parts.push(choice.delta.content)
    }
  }
  return parts.join('')
}

function doneCount(text: string): number {
  return text.split('data: [DONE]').length - 1
}

let shim: CodeArtsShim
let port: number
let bearer: string

/** 上游回应可以是固定一串帧，也可以按请求体决定回什么（降档重发要用后者）。 */
type Responder = readonly string[] | ((body: string) => readonly string[])

async function startShim(
  chunks: Responder,
  catalogModels: readonly { id: string; contextWindow: number; maxTokens: number }[] = [],
): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
    // 出网只传「字符串 URL + 普通 init」（见 upstream.ts 的 dispatch），请求体在 init.body。
    const raw = init?.body
    const body = raw === undefined ? '' : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    return sseResponse(typeof chunks === 'function' ? chunks(body) : chunks)
  }))
  shim = createCodeArtsShim({
    store: {
      ids: async () => ['acct'],
      resolve: async () => ({ token: 'sts', accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'sts' }),
    } as never,
    catalog: { current: () => catalogModels } as never,
  })
  await shim.ready
  port = Number(new URL(shim.baseUrl()).port)
  bearer = shim.token()
}

const ASK = { model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }

beforeEach(() => {
  vi.restoreAllMocks()
  // 降档记忆是进程内的，不重置的话上一个用例学到的低上限会串到下一个用例里。
  resetTokenCeilings()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await shim?.close()
})

describe('end-to-end: OpenAI-shaped upstream stream', () => {
  it('delivers the assistant text as incremental deltas', async () => {
    await startShim(OPENAI_CHUNKS)
    const res = await postSse(port, bearer, ASK)
    expect(res.status).toBe(200)
    expect(deltaText(res.text)).toBe('你好，世界')
  })

  // Regression guard: the usage frame carries `choices: []`. A `choices.length > 0`
  // pass-through test drops it, and no later branch emits it either — so DSH's
  // usage pill silently never receives data.
  it('forwards the usage-only frame', async () => {
    await startShim(OPENAI_CHUNKS)
    const res = await postSse(port, bearer, ASK)
    const usage = (payloads(res.text) as { usage?: { total_tokens?: number } }[]).find(f => f.usage !== undefined)
    expect(usage, 'usage frame missing from the client stream').toBeDefined()
    expect(usage?.usage?.total_tokens).toBe(15)
  })

  it('terminates the stream with exactly one [DONE]', async () => {
    await startShim(OPENAI_CHUNKS)
    const res = await postSse(port, bearer, ASK)
    expect(doneCount(res.text)).toBe(1)
  })

  it('preserves an upstream [DONE] without adding a second', async () => {
    await startShim([
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(doneCount(res.text)).toBe(1)
  })

  it('adds a [DONE] when the upstream never sent one', async () => {
    await startShim([
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(doneCount(res.text)).toBe(1)
  })

  it('carries reasoning_content through untouched', async () => {
    await startShim([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    const frames = payloads(res.text) as { choices?: { delta?: { reasoning_content?: string } }[] }[]
    const reasoning = frames.flatMap(f => f.choices ?? []).map(c => c.delta?.reasoning_content).filter(Boolean)
    expect(reasoning).toEqual(['think'])
  })

  it('reassembles a frame split across TCP chunk boundaries', async () => {
    // The JSON frame is cut mid-object, exactly as a real socket would.
    await startShim([
      'data: {"choices":[{"index":0,"delta":{"con',
      'tent":"split"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(deltaText(res.text)).toBe('split')
  })

  // Regression guard for a stream deadlock: a pull() that read a chunk
  // producing no output frame used to return without enqueuing, and the
  // runtime would never call pull() again — the client hung forever with no
  // error and no end. An SSE comment/heartbeat is the cleanest trigger.
  it('does not stall on an SSE comment/heartbeat frame', async () => {
    await startShim([
      'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n',
      ': keep-alive\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(deltaText(res.text)).toBe('ab')
    expect(doneCount(res.text)).toBe(1)
  })

  it('does not stall when a whole read is a bare newline', async () => {
    await startShim([
      '\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n',
      '\n\n',
      'data: [DONE]\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(deltaText(res.text)).toBe('a')
    expect(doneCount(res.text)).toBe(1)
  })

  it('rejects an unparsable frame without dropping the rest of the stream', async () => {
    await startShim([
      'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n',
      'data: {not json\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(deltaText(res.text)).toBe('ab')
  })
})

describe('end-to-end: legacy cumulative-snapshot protocol', () => {
  it('converts whole-text snapshots into incremental deltas', async () => {
    await startShim([
      'data: {"type":"answer","text":""}\n\n',
      'data: {"text":"你"}\n\n',
      'data: {"text":"你好"}\n\n',
      'data: {"text":"你好，世界"}\n\n',
      'data: {"text":"[DONE]","error_code":"0"}\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(deltaText(res.text)).toBe('你好，世界')
    expect(doneCount(res.text)).toBe(1)
  })

  it('emits nothing when a snapshot repeats the previous text', async () => {
    await startShim([
      'data: {"text":"abc"}\n\n',
      'data: {"text":"abc"}\n\n',
      'data: {"text":"[DONE]","error_code":"0"}\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(deltaText(res.text)).toBe('abc')
  })

  // 同一条「参数非法」会被降档重试 3 次；上游一直这么回，最后才原样交给 DSH。
  it('surfaces an upstream error_code frame and terminates', async () => {
    await startShim([
      'data: {"error_code":"InferHub.001001005.400","error_msg":"max_tokens too large"}\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(res.text).toContain('InferHub.001001005.400')
    expect(doneCount(res.text)).toBe(1)
  })

  // 2026-10-21 实测：账号没有福利权益时上游回 HTTP 200 + 这句流内帧。它既不能重发
  // 也不能换号（去掉 maas_type 就变成 model is not registered），唯一能做的就是让卡片
  // 今天别再推这个模型。
  it('marks the model as benefit-blocked for today when the entitlement is missing', async () => {
    clearBenefitBlocked()
    await startShim([
      'data: {"error_code":"InferHub.4004.200","error_msg":"benefit not found"}\n\n',
    ])
    const res = await postSse(port, bearer, { ...ASK, model: 'deepseek-v4.1-flash' })
    expect(res.text).toContain('benefit not found')
    expect(isBenefitBlocked('deepseek-v4.1-flash')).toBe(true)
    expect(isBenefitBlocked('glm-5.2')).toBe(false)
    clearBenefitBlocked()
  })
})

describe('max_tokens 上限降档自愈', () => {
  const PARAM_INVALID = 'data: {"error_code":"InferHub.001001005.400","error_msg":"The request param is invalid, Please check it"}\n\n'
  const ASK_WITH_MAX = { model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 65_536 }

  // 上游会悄悄调低已经实测过的上限，而它回的是一句不带参数的话。
  // 模拟「第一档被拒、第二档放行」：客户端最终必须看到正常内容，而不是那次失败。
  it('降一档重发，客户端只看到正常流', async () => {
    const sent: number[] = []
    await startShim(body => {
      sent.push((JSON.parse(body) as { max_tokens?: number }).max_tokens ?? 0)
      return sent.length === 1 ? [PARAM_INVALID] : OPENAI_CHUNKS
    })
    const res = await postSse(port, bearer, ASK_WITH_MAX)
    expect(sent).toEqual([65_536, 32_768])
    expect(deltaText(res.text)).toBe('你好，世界')
    expect(res.text).not.toContain('InferHub.001001005.400')
  })

  it('装得下但余量不足时，把 max_tokens 压进窗口再发', async () => {
    let sentMax = 0
    await startShim(
      body => {
        sentMax = (JSON.parse(body) as { max_tokens?: number }).max_tokens ?? 0
        return OPENAI_CHUNKS
      },
      [{ id: 'GLM-5.2', contextWindow: 20_000, maxTokens: 65_536 }],
    )
    await postSse(port, bearer, { ...ASK_WITH_MAX, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] })
    // prompt ≈ 10000 tokens，窗口 20000，再扣 2048 估算余量 → 只剩不到 8000
    expect(sentMax).toBeGreaterThan(1_024)
    expect(sentMax).toBeLessThan(8_000)
  })

  // 这一条是需求本身：放不下时要说清楚是哪个模型、窗口多大、估算多少，
  // 而不是让用户去猜上游那句 "The request param is invalid"。
  it('根本放不下时直接回具体错误，一次上游都不发', async () => {
    let askedUpstream = false
    await startShim(
      body => {
        askedUpstream = true
        return OPENAI_CHUNKS
      },
      [{ id: 'GLM-5.2', contextWindow: 4_000, maxTokens: 65_536 }],
    )
    const res = await postSse(port, bearer, { ...ASK_WITH_MAX, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] })
    expect(askedUpstream).toBe(false)
    expect(res.status).toBe(400)
    expect(res.text).toContain('上下文放不下')
    expect(res.text).toContain('4000')
  })
})
