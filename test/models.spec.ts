import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoveredBenefitModels,
  fillFromSeed,
  isBenefitModel,
  mergeModelLists,
  setDiscoveredBenefitModels,
  type CodeArtsModelInfo,
} from '../src/catalog.ts'
import { fetchModels, maxTokensCeilingFor, MAX_TOKENS_CEILING } from '../src/upstream.ts'

const model = (id: string, patch: Partial<CodeArtsModelInfo> = {}): CodeArtsModelInfo => ({
  id,
  name: id,
  contextWindow: 0,
  maxTokens: 0,
  supportsImages: false,
  ...patch,
})

describe('mergeModelLists', () => {
  it('dedupes case-insensitively and keeps the richer row', () => {
    const merged = mergeModelLists([
      [model('GLM-5.2', { contextWindow: 0, maxTokens: 0 })],
      [model('glm-5.2', { contextWindow: 202_752, maxTokens: 131_072 })],
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.contextWindow).toBe(202_752)
    expect(merged[0]?.maxTokens).toBe(131_072)
  })

  it('unions the benefit flag: a missing header is a 404, never a false negative', () => {
    const merged = mergeModelLists([
      [model('glm-5.3-flash', { benefit: true })],
      [model('glm-5.3-flash', { contextWindow: 1024 })],
    ])
    expect(merged[0]?.benefit).toBe(true)
  })

  it('sorts by lowercase id so the picker order is stable across refreshes', () => {
    const merged = mergeModelLists([[model('Qwen3-VL-235B')], [model('GLM-5.2')], [model('deepseek-v4.1-flash')]])
    expect(merged.map(m => m.id)).toEqual(['deepseek-v4.1-flash', 'GLM-5.2', 'Qwen3-VL-235B'])
  })
})

describe('fillFromSeed', () => {
  const seed = [model('OpenPangu-2.0-Pro', { name: 'OpenPangu 2.0 Pro', contextWindow: 32_000, maxTokens: 4_000 })]

  it('never lets placeholder seed parameters beat discovered ones', () => {
    // 回归用例：种子里的占位值曾靠「大小写更像注册名」压过上游真实值。
    const filled = fillFromSeed(
      [model('openpangu-2.0-pro', { name: 'OpenPangu-2.0-Pro', contextWindow: 524_288, maxTokens: 131_072 })],
      seed,
    )
    expect(filled).toHaveLength(1)
    expect(filled[0]?.contextWindow).toBe(524_288)
    expect(filled[0]?.maxTokens).toBe(131_072)
  })

  it('fills zeroed fields and adds models discovery did not return', () => {
    const filled = fillFromSeed(
      [model('OpenPangu-2.0-Pro', { contextWindow: 524_288, maxTokens: 0 })],
      [...seed, model('GLM-5.1', { contextWindow: 128_000, maxTokens: 8_000 })],
    )
    const pro = filled.find(m => m.id === 'OpenPangu-2.0-Pro')
    expect(pro?.maxTokens).toBe(4_000) // 发现没给 -> 种子补
    expect(pro?.contextWindow).toBe(524_288) // 发现给了 -> 不被种子覆盖
    expect(filled.map(m => m.id)).toContain('GLM-5.1')
  })
})

describe('isBenefitModel', () => {
  afterEach(() => setDiscoveredBenefitModels([]))

  it('falls back to the cold-start seed before any discovery ran', () => {
    expect(isBenefitModel('glm-5.3-flash')).toBe(true)
  })

  it('lets a successful discovery add and remove benefit routes', () => {
    setDiscoveredBenefitModels(['some-new-free-model'])
    expect(isBenefitModel('SOME-NEW-FREE-MODEL')).toBe(true)
    // 发现成功后种子不再兜底：目录里明确没有它，就不再带 maas_type 头。
    expect(isBenefitModel('glm-5.3-flash')).toBe(false)
    expect(discoveredBenefitModels()).toEqual(['some-new-free-model'])
  })
})

describe('maxTokensCeilingFor', () => {
  it('keeps the measured per-model ceiling instead of the advertised one', () => {
    expect(maxTokensCeilingFor('deepseek-v4-flash-0731')).toBe(65_536)
    expect(maxTokensCeilingFor('GLM-5.2')).toBe(131_072)
  })

  it('falls back to the conservative global ceiling for unmeasured models', () => {
    expect(maxTokensCeilingFor('openpangu-2.0-pro')).toBe(MAX_TOKENS_CEILING)
  })
})

/** 三路响应都按 2026-09-30 实测形状裁剪。 */
const BUILTIN_BODY = JSON.stringify({
  count: 2,
  builtinModels: [
    { model_id: 'GLM-5.2', model_name: 'GLM-5.2', enable: true, display_enabled: true, supports_images: false },
    { model_id: 'glm-5.2-sft-harmony', model_name: 'GLM-5.2-ArkTS-SPARK', enable: true, shows_images: false },
    { model_id: 'retired-model', model_name: 'Retired', enable: false },
  ],
})

const BENEFIT_BODY = JSON.stringify({
  error_code: '0000',
  error_msg: 'success',
  result: {
    base_url: 'https://opengw.developer.huaweicloud.com/v2',
    models: [
      { context_window: 1_048_576, max_tokens: 393_216, model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash-0731', sort: 10 },
      { context_window: 1_048_576, max_tokens: 131_072, model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash', sort: 20 },
    ],
  },
})

const AGENT_LIST_BODY = JSON.stringify({
  total: 2,
  agents: [
    { agent_id: 'aaa', agent_name: 'CodeAgent', show_in_ide: true, is_primary_agent: true, alias: { alias_zh_cn: '智能体' } },
    { agent_id: 'bbb', agent_name: 'OtherAgent', is_primary_agent: true, alias: { alias_zh_cn: '别的' } },
  ],
})

const AGENT_DETAIL_BODY = JSON.stringify({
  agent_id: 'aaa',
  gpts: {
    models: [
      {
        model_alias: 'GLM-5.2',
        model_name: 'GLM-5.2',
        model_parameters: { model_id: 'GLM-5.2', context_window: 202_752, max_tokens: 131_072 },
      },
      {
        // 实测：model_name 是显示名，注册名在 params.model_id —— 取错会多出假模型。
        model_alias: 'glm-5.2-sft-harmony',
        model_name: 'GLM-5.2-ArkTS-SPARK',
        model_parameters: { model_id: 'glm-5.2-sft-harmony', context_window: 202_752, max_tokens: 131_072 },
      },
    ],
  },
})

const credential = {
  token: 'sts-token',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  securityToken: 'sts-token',
}

function stubFetch(handlers: Record<string, () => Response>): void {
  vi.stubGlobal('fetch', async (input: Request | string | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (url.includes(fragment)) return handler()
    }
    return new Response('{"error_msg":"not found","error_code":"APIG.0101"}', { status: 404 })
  })
}

const json = (body: string): Response => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })

describe('fetchModels', () => {
  beforeEach(() => setDiscoveredBenefitModels([]))
  afterEach(() => {
    vi.unstubAllGlobals()
    setDiscoveredBenefitModels([])
  })

  it('merges the three sources and clamps max_tokens to the measured ceiling', async () => {
    stubFetch({
      '/v1/model/builtin': () => json(BUILTIN_BODY),
      '/api/v1/gateway/config': () => json(BENEFIT_BODY),
      '/v1/agent-center/agents/useragents': () => json(AGENT_LIST_BODY),
      '/v1/agent-center/agents/detail': () => json(AGENT_DETAIL_BODY),
    })

    const result = await fetchModels(credential)
    expect([...result.sources].sort()).toEqual(['agent', 'benefit', 'builtin'])
    expect(result.errors).toEqual([])

    const byId = new Map(result.models.map(m => [m.id, m]))
    // 福利网关标称 393216，实测上限 65536：必须钳住，否则每个请求都 400。
    expect(byId.get('deepseek-v4-flash-0731')?.maxTokens).toBe(65_536)
    // GLM-5.2 实测可用 131072，不该被全局 65536 砍掉。
    expect(byId.get('GLM-5.2')?.maxTokens).toBe(131_072)
    expect(byId.get('GLM-5.2')?.contextWindow).toBe(202_752)
    // 显示名不等于注册名时，注册名当 id（否则会多出一个选不得的假模型）。
    expect(byId.has('glm-5.2-sft-harmony')).toBe(true)
    expect(byId.get('glm-5.2-sft-harmony')?.name).toBe('GLM-5.2-ArkTS-SPARK')
    expect(byId.has('GLM-5.2-ArkTS-SPARK')).toBe(false)
    // enable=false 的内置模型不进目录。
    expect(byId.has('retired-model')).toBe(false)
    // 种子补进来的模型仍在（发现只回了 4 个）。
    expect(byId.has('GLM-5.1')).toBe(true)
    expect(result.models.every(m => m.maxTokens > 0 && m.contextWindow > 0)).toBe(true)
  })

  it('keeps working when a source fails (benefit gateway down)', async () => {
    stubFetch({
      '/v1/model/builtin': () => json(BUILTIN_BODY),
      '/v1/agent-center/agents/useragents': () => json(AGENT_LIST_BODY),
      '/v1/agent-center/agents/detail': () => json(AGENT_DETAIL_BODY),
      '/api/v1/gateway/config': () => new Response('{"error_code":"0500"}', { status: 500 }),
    })

    const result = await fetchModels(credential)
    expect([...result.sources].sort()).toEqual(['agent', 'builtin'])
    expect(result.errors.map(e => e.source)).toEqual(['benefit'])
    expect(result.models.map(m => m.id)).toContain('GLM-5.2')
  })

  it('reports an error when every source rejects the request', async () => {
    stubFetch({
      '/v1/model/builtin': () => new Response('nope', { status: 403 }),
      '/api/v1/gateway/config': () => new Response('nope', { status: 403 }),
      '/v1/agent-center/agents/useragents': () => new Response('nope', { status: 403 }),
    })

    await expect(fetchModels(credential)).rejects.toThrow(/every source/)
  })
})
