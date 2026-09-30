/**
 * 独立复现脚本:pi-ai(openai-completions) → 本地 shim → (mock)华为上游。
 * 打出发往华为的完整请求体。
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createCodeArtsShim } from '../src/shim.ts'
import { CodeArtsCredentialStore } from '../src/auth.ts'
import { CodeArtsCatalog } from '../src/catalog.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const enc = new TextEncoder()
const sse = obj => enc.encode(`data: ${JSON.stringify(obj)}\n\n`)

const WATCHDOG_MS = 20_000
const timer = setTimeout(() => {
  console.error('WATCHDOG: timed out; capturedUrl =', capturedUrl ?? '(none)')
  process.exit(2)
}, WATCHDOG_MS)

let capturedUrl
let capturedHeaders
let capturedBody

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'codearts-wire-'))
  const store = new CodeArtsCredentialStore(join(dir, '.codearts-auth.json'))
  await store.set('fake-cloud-dragon-token')
  const catalog = new CodeArtsCatalog()
  const shim = createCodeArtsShim({ store, catalog })
  await shim.ready
  console.log('[1] shim ready at', shim.baseUrl())

  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('myhuaweicloud.com')) {
      const req = input instanceof Request ? input : new Request(input, init)
      capturedUrl = url
      capturedHeaders = Object.fromEntries(req.headers.entries())
      capturedBody = await req.text()
      console.log('[3] captured upstream request:', url)
      console.log('=== CAPTURED BODY ===')
      console.log(capturedBody)
      console.log('=== END CAPTURED BODY ===')
      const body = new ReadableStream({
        start(c) {
          c.enqueue(sse({ type: 'answer' }))
          c.enqueue(sse({ text: 'Hello' }))
          c.enqueue(sse({ text: '[DONE]', error_code: '0' }))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    console.log('[2] pass-through request:', url)
    return realFetch(input, init)
  }

  const model = {
    id: 'GLM-4.7',
    name: 'GLM-4.7',
    api: 'openai-completions',
    provider: 'codearts',
    baseUrl: `${shim.baseUrl()}/v1`,
    input: ['text', 'image'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
  }

  const provider = createProvider({
    id: 'codearts',
    name: 'CodeArts',
    auth: {
      apiKey: {
        name: 'CodeArts token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: 'CodeArts' }
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  })

  console.log('[4] calling streamSimple...')
  const stream = provider.streamSimple(model, {
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      },
    ],
  }, {
    apiKey: shim.token(),
    maxTokens: 8_000,
    sessionId: 'test-session',
  })

  for await (const ev of stream) {
    if (ev.type === 'error') {
      console.log('[5] pi-ai ERROR event:', JSON.stringify(ev.error).slice(0, 1200))
      break
    }
    if (ev.type === 'done') {
      console.log('[5] pi-ai done; text =', JSON.stringify(ev.message.content))
      break
    }
  }

  clearTimeout(timer)
  console.log('\n=== upstream body ===')
  try {
    console.log(JSON.stringify(JSON.parse(capturedBody), null, 2))
  } catch {
    console.log('(raw)', capturedBody)
  }
  console.log('\n=== suspect fields ===')
  const p = JSON.parse(capturedBody)
  for (const k of ['store', 'stream_options', 'max_completion_tokens', 'max_tokens', 'prompt_cache_key', 'tool_stream', 'chat_id', 'stream', 'temperature', 'tools']) {
    console.log(k, '=', JSON.stringify(p[k]))
  }

  await shim.close()
  rmSync(dir, { recursive: true, force: true })
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
