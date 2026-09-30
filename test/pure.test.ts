import { describe, expect, it } from 'vitest'
import { BENEFIT_MODELS, filterEnabledModels, isBenefitModel, FALLBACK_CODEARTS_MODELS } from '../src/catalog.ts'
import { canonicalModel, prepareChatBody, SNAP_HOST, MAX_TOKENS_CEILING } from '../src/upstream.ts'

describe('canonicalModel', () => {
  it('maps the friendly alias to the upstream-registered spelling', () => {
    expect(canonicalModel('deepseek-v4-flash')).toBe('deepseek-v4-flash-0731')
    expect(canonicalModel('deepseek-v4-pro')).toBe('deepseek-v4-pro-0813')
  })

  it('is case-insensitive on the key but preserves the mapped casing', () => {
    expect(canonicalModel('GLM-5.2')).toBe('GLM-5.2')
    expect(canonicalModel('glm-5.1')).toBe('GLM-5.1')
  })

  it('passes unknown ids through untouched (route errors surface upstream)', () => {
    expect(canonicalModel('some-new-model')).toBe('some-new-model')
  })
})

describe('isBenefitModel', () => {
  it('recognises every seeded benefit model regardless of case', () => {
    for (const id of BENEFIT_MODELS) {
      expect(isBenefitModel(id)).toBe(true)
      expect(isBenefitModel(id.toUpperCase())).toBe(true)
    }
  })

  it('does not classify commercial models as benefit', () => {
    expect(isBenefitModel('GLM-5.2')).toBe(false)
    expect(isBenefitModel('Qwen3-VL-235B')).toBe(false)
  })
})

describe('filterEnabledModels', () => {
  const models = FALLBACK_CODEARTS_MODELS

  it('serves everything when the allowlist is absent or empty', () => {
    expect(filterEnabledModels(models, undefined)).toEqual(models)
    expect(filterEnabledModels(models, [])).toEqual(models)
  })

  it('narrows to the allowlist when it matches something', () => {
    const kept = filterEnabledModels(models, ['GLM-5.2'])
    expect(kept.map(m => m.id)).toEqual(['GLM-5.2'])
  })

  it('falls back to everything when the allowlist matches nothing', () => {
    expect(filterEnabledModels(models, ['nope'])).toEqual(models)
  })
})

describe('prepareChatBody', () => {
  it('canonicalises the model and injects the CodeArts-specific fields', () => {
    const { url, body, model } = prepareChatBody(JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }))
    expect(url).toBe(`${SNAP_HOST}/api/v2/chat/completions`)
    expect(model).toBe('deepseek-v4-flash-0731')
    const parsed = JSON.parse(body)
    expect(parsed.model).toBe('deepseek-v4-flash-0731')
    expect(parsed.stream).toBe(true)
    expect(parsed.tool_stream).toBe(true)
    expect(parsed.chat_id).toMatch(/^[0-9a-f]{32}$/)
    expect(parsed.prompt_cache_key).toBe(parsed.chat_id)
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('passes malformed input through so the upstream can report the error', () => {
    const raw = '{not json'
    const { body, model } = prepareChatBody(raw)
    expect(body).toBe(raw)
    expect(model).toBe('')
  })

  it('normalizes OpenAI-only fields and keeps include_usage for real usage frames', () => {
    const { body } = prepareChatBody(JSON.stringify({
      model: 'GLM-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: false },
      store: false,
      max_completion_tokens: 8000,
      logprobs: true,
      top_logprobs: 2,
      tools: [{
        type: 'function',
        function: { name: 'read', description: 'd', parameters: { type: 'object' }, strict: false },
      }],
      prompt_cache_key: 'from-client',
    }))
    const parsed = JSON.parse(body)
    // include_usage 被强制为 true(上游只在此时回真实 usage,DSH 底部用量药丸依赖它)
    expect(parsed.stream_options).toEqual({ include_usage: true })
    expect(parsed.store).toBeUndefined()
    expect(parsed.logprobs).toBeUndefined()
    expect(parsed.top_logprobs).toBeUndefined()
    expect(parsed.tools[0].function.strict).toBeUndefined()
    // max_completion_tokens 被翻译成华为认识的 max_tokens
    expect(parsed.max_tokens).toBe(8000)
    expect(parsed.max_completion_tokens).toBeUndefined()
    // 客户端伪造的 prompt_cache_key 被替换成注入的 chat_id
    expect(parsed.prompt_cache_key).toBe(parsed.chat_id)
  })

  it('injects stream_options.include_usage when the client did not send it', () => {
    const { body } = prepareChatBody(JSON.stringify({
      model: 'GLM-4.7',
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(JSON.parse(body).stream_options).toEqual({ include_usage: true })
  })

  it('keeps standard OpenAI fields the gateway accepts', () => {
    const { body } = prepareChatBody(JSON.stringify({
      model: 'GLM-4.7',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 512,
      stop: ['\n'],
      tool_choice: 'auto',
    }))
    const parsed = JSON.parse(body)
    expect(parsed.temperature).toBe(0.7)
    expect(parsed.top_p).toBe(0.9)
    expect(parsed.max_tokens).toBe(512)
    expect(parsed.stop).toEqual(['\n'])
    expect(parsed.tool_choice).toBe('auto')
  })

  it('clamps max_tokens to the upstream ceiling (InferHub.001001005.400 beyond it)', () => {
    const { body } = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 384_000,
    }))
    const parsed = JSON.parse(body)
    expect(parsed.max_tokens).toBe(MAX_TOKENS_CEILING)
    // 恰好等于上限的值不应被改动
    const { body: atLimit } = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: MAX_TOKENS_CEILING,
    }))
    expect(JSON.parse(atLimit).max_tokens).toBe(MAX_TOKENS_CEILING)
  })
})

describe('conversation-scoped chat_id', () => {
  const bodyWith = (messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
    JSON.parse(prepareChatBody(JSON.stringify({ model: 'GLM-5.2', messages, ...extra })).body)
  const chatIdOf = (messages: unknown[], extra?: Record<string, unknown>): string =>
    bodyWith(messages, extra).chat_id as string

  it('is 32 lowercase hex, as the upstream requires', () => {
    expect(chatIdOf([{ role: 'user', content: 'hi' }])).toMatch(/^[0-9a-f]{32}$/)
  })

  // The point of the whole scheme. A conversation's later turns carry more
  // history, but the first user message is unchanged — so they must land on the
  // same chat_id. Minting a fresh id per request opens a new upstream session
  // every turn, and the concurrency cap is reached after a few turns.
  it('stays the same as the conversation history grows', () => {
    const first = [{ role: 'user', content: '写一个快排' }]
    const later = [
      ...first,
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '改成降序' },
      { role: 'assistant', content: '改好了' },
      { role: 'user', content: '再加个测试' },
    ]
    expect(chatIdOf(later)).toBe(chatIdOf(first))
  })

  it('differs between conversations that open differently', () => {
    expect(chatIdOf([{ role: 'user', content: '问题 A' }]))
      .not.toBe(chatIdOf([{ role: 'user', content: '问题 B' }]))
  })

  it('anchors on the first user message, ignoring a leading system message', () => {
    const withSystem = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '同一个开场' },
    ]
    expect(chatIdOf(withSystem)).toBe(chatIdOf([{ role: 'user', content: '同一个开场' }]))
  })

  // Session-title generation and the real agent request can carry the same
  // opening user message; without this they collide on one upstream session.
  it('separates a tool-carrying request from the same one without tools', () => {
    const messages = [{ role: 'user', content: '同一个开场' }]
    const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]
    expect(chatIdOf(messages, { tools })).not.toBe(chatIdOf(messages))
  })

  it('honours an explicit conversation_id from the client', () => {
    const explicit = 'a'.repeat(32)
    expect(chatIdOf([{ role: 'user', content: 'hi' }], { conversation_id: explicit })).toBe(explicit)
  })

  it('falls back to a fresh id when there is no user message', () => {
    const only = [{ role: 'system', content: 'x' }]
    expect(chatIdOf(only)).toMatch(/^[0-9a-f]{32}$/)
    expect(chatIdOf(only)).not.toBe(chatIdOf(only))
  })

  it('keeps prompt_cache_key equal to chat_id', () => {
    const parsed = bodyWith([{ role: 'user', content: 'hi' }])
    expect(parsed.prompt_cache_key).toBe(parsed.chat_id)
  })
})
