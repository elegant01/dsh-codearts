import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodeArtsShim, type CodeArtsShim } from '../src/shim.ts'

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

async function startShim(chunks: readonly string[]): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))
  shim = createCodeArtsShim({
    store: {
      ids: async () => ['acct'],
      resolve: async () => ({ token: 'sts', accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'sts' }),
    } as never,
    catalog: { current: () => [] } as never,
  })
  await shim.ready
  port = Number(new URL(shim.baseUrl()).port)
  bearer = shim.token()
}

const ASK = { model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }

beforeEach(() => {
  vi.restoreAllMocks()
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

  it('surfaces an upstream error_code frame and terminates', async () => {
    await startShim([
      'data: {"error_code":"InferHub.001001005.400","error_msg":"max_tokens too large"}\n\n',
    ])
    const res = await postSse(port, bearer, ASK)
    expect(res.text).toContain('InferHub.001001005.400')
    expect(doneCount(res.text)).toBe(1)
  })
})
