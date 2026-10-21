import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backfillParams,
  benefitBlockedModels,
  clearBenefitBlocked,
  CodeArtsCatalog,
  creditRatioLabel,
  discoveredBenefitModels,
  isBenefitBlocked,
  isBenefitModel,
  markBenefitBlocked,
  mergeModelLists,
  modelDisplayName,
  setDiscoveredBenefitModels,
  stripModelSuffixes,
  type CodeArtsModelInfo,
} from '../src/catalog.ts'
import { refreshCatalog } from '../src/discovery.ts'
import { thinkingFields } from '../src/adapter.ts'
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

  it('keeps the ratio even when it came from the row that lost the param tie-break', () => {
    // 实测 agent-center 带 credit、内置不带；合并后倍率不能丢。
    const merged = mergeModelLists([
      [model('glm-5.2-sft-harmony', { contextWindow: 202_752, maxTokens: 65_536 })],
      [model('glm-5.2-sft-harmony', { ratio: '0.7x' })],
    ])
    expect(merged[0]?.ratio).toBe('0.7x')
    expect(merged[0]?.maxTokens).toBe(65_536)
  })
})

describe('backfillParams', () => {
  const params = [model('OpenPangu-2.0-Pro', { name: 'OpenPangu 2.0 Pro', contextWindow: 32_000, maxTokens: 4_000 })]

  it('never lets placeholder parameters beat discovered ones', () => {
    // 回归用例：表里的占位值曾靠「大小写更像注册名」压过上游真实值。
    const filled = backfillParams(
      [model('openpangu-2.0-pro', { name: 'OpenPangu-2.0-Pro', contextWindow: 524_288, maxTokens: 131_072 })],
      params,
    )
    expect(filled).toHaveLength(1)
    expect(filled[0]?.contextWindow).toBe(524_288)
    expect(filled[0]?.maxTokens).toBe(131_072)
  })

  it('fills zeroed fields but never adds a model discovery did not return', () => {
    const filled = backfillParams(
      [model('OpenPangu-2.0-Pro', { contextWindow: 524_288, maxTokens: 0, ratio: '0.7x' })],
      [...params, model('GLM-5.1', { contextWindow: 128_000, maxTokens: 8_000 })],
    )
    const pro = filled.find(m => m.id === 'OpenPangu-2.0-Pro')
    expect(pro?.maxTokens).toBe(4_000) // 发现没给 -> 参数表补
    expect(pro?.contextWindow).toBe(524_288) // 发现给了 -> 不被占位值覆盖
    expect(pro?.ratio).toBe('0.7x') // 倍率只来自发现，补参数时原样带过去
    // 表里有、上游没给：目录里就不该出现它（列表只反映上游现状，不做兜底）。
    expect(filled.map(m => m.id)).toEqual(['OpenPangu-2.0-Pro'])
  })
})

describe('isBenefitModel', () => {
  beforeEach(() => setDiscoveredBenefitModels([]))
  afterEach(() => setDiscoveredBenefitModels([]))

  // 没有任何静态兜底：没发现过就没有福利模型。猜错方向的代价不对称 ——
  // 漏带一次头是福利模型报 404（它本来就不可用），多带一次是把能用的积分模型
  // 推进一条不存在的渠道，直接 benefit not found。
  it('knows no benefit model until discovery says so', () => {
    expect(isBenefitModel('glm-5.3-flash')).toBe(false)
    expect(isBenefitModel('deepseek-v4-flash-0731')).toBe(false)
  })

  it('lets a successful discovery add and remove benefit routes', () => {
    setDiscoveredBenefitModels(['some-new-free-model', 'glm-5.3-flash'])
    expect(isBenefitModel('SOME-NEW-FREE-MODEL')).toBe(true)
    expect(isBenefitModel('glm-5.3-flash')).toBe(true)
    setDiscoveredBenefitModels(['some-new-free-model'])
    // 下一轮发现把它移出了福利名单（模型「转正」）—— 立刻不再带 maas_type 头。
    expect(isBenefitModel('glm-5.3-flash')).toBe(false)
    expect(discoveredBenefitModels()).toEqual(['some-new-free-model'])
  })
})

describe('福利权益缺失（benefit not found）', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearBenefitBlocked()
  })

  it('按小写 id 记账，并且只记被点名的那个', () => {
    markBenefitBlocked('DeepSeek-V4.1-Flash')
    expect(isBenefitBlocked('deepseek-v4.1-flash')).toBe(true)
    expect(isBenefitBlocked('glm-5.2')).toBe(false)
    expect(benefitBlockedModels()).toEqual(['deepseek-v4.1-flash'])
  })

  it('过完当天就忘掉 —— 福利每天重发，昨天的失败不能留到今天', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 21, 10, 0, 0))
    markBenefitBlocked('glm-5.3-flash')
    expect(isBenefitBlocked('glm-5.3-flash')).toBe(true)
    vi.setSystemTime(new Date(2026, 9, 22, 0, 5, 0))
    expect(isBenefitBlocked('glm-5.3-flash')).toBe(false)
    expect(benefitBlockedModels()).toEqual([])
  })

  it('手动刷新目录时清空，给用户一个不用等明天的出口', () => {
    markBenefitBlocked('glm-5.3-flash')
    clearBenefitBlocked()
    expect(isBenefitBlocked('glm-5.3-flash')).toBe(false)
  })
})

describe('stripModelSuffixes', () => {
  it('只剥尾巴：codebuddy 式「 · 倍率 · 标签」与旧格式', () => {
    expect(stripModelSuffixes('GLM-5.2 · x0.70')).toBe('GLM-5.2')
    expect(stripModelSuffixes('DeepSeek-V4-Flash · x0.00 · 福利')).toBe('DeepSeek-V4-Flash')
    expect(stripModelSuffixes('DeepSeek-V4-Flash · 限时免费')).toBe('DeepSeek-V4-Flash')
    expect(stripModelSuffixes('DeepSeek-V4-Flash (福利) · x0.00')).toBe('DeepSeek-V4-Flash')
    expect(stripModelSuffixes('DeepSeek-V4-Flash (免费)')).toBe('DeepSeek-V4-Flash')
    expect(stripModelSuffixes('GLM-5.3-Flash（福利）')).toBe('GLM-5.3-Flash')
    expect(stripModelSuffixes('GLM-5.2 (x0.7)')).toBe('GLM-5.2')
  })

  it('不动名字中间的同形文字', () => {
    expect(stripModelSuffixes('GLM-5.2')).toBe('GLM-5.2')
    expect(stripModelSuffixes('Foo (Bar)')).toBe('Foo (Bar)')
    expect(stripModelSuffixes('Foo (福利) Bar')).toBe('Foo (福利) Bar')
    expect(stripModelSuffixes('Foo · x0.5 Bar')).toBe('Foo · x0.5 Bar')
  })
})

describe('creditRatioLabel', () => {
  it('普通模型固定两位小数，福利恒为 x0.00', () => {
    expect(creditRatioLabel('0.18x', false)).toBe('x0.18')
    expect(creditRatioLabel('0.7x', false)).toBe('x0.70')
    expect(creditRatioLabel('0.79x', false)).toBe('x0.79')
    expect(creditRatioLabel('0.18x', true)).toBe('x0.00')
    expect(creditRatioLabel(undefined, true)).toBe('x0.00')
  })

  it('没有倍率就不显示，畸形值也不硬编', () => {
    expect(creditRatioLabel(undefined, false)).toBeUndefined()
    expect(creditRatioLabel('', false)).toBeUndefined()
    expect(creditRatioLabel('free', false)).toBeUndefined()
  })
})

describe('modelDisplayName', () => {
  it('照 codebuddy 的「Name · 倍率 · 标签」顺序，福利标签在后，重复调用不叠加', () => {
    expect(modelDisplayName('DeepSeek-V4-Flash (免费)', true, '0.18x')).toBe('DeepSeek-V4-Flash · x0.00 · 福利')
    expect(modelDisplayName('DeepSeek-V4-Flash · x0.00 · 福利', true)).toBe('DeepSeek-V4-Flash · x0.00 · 福利')
    expect(modelDisplayName('GLM-5.2', false, '0.7x')).toBe('GLM-5.2 · x0.70')
    expect(modelDisplayName('GLM-5.2 · x0.70', false, '0.7x')).toBe('GLM-5.2 · x0.70')
  })

  it('没有倍率的模型（上游无 credit）保持原名', () => {
    expect(modelDisplayName('Qwen3-VL-235B', false)).toBe('Qwen3-VL-235B')
    expect(modelDisplayName('Qwen3-VL-235B · x0.70', false)).toBe('Qwen3-VL-235B')
  })
})

describe('maxTokensCeilingFor', () => {
  it('keeps the measured per-model ceiling instead of the advertised one', () => {
    expect(maxTokensCeilingFor('deepseek-v4-flash-0731')).toBe(65_536)
    // 2026-09-30 实测 131072 可用，2026-10-10 复测已被网关拒（InferHub.001001005.400）。
    expect(maxTokensCeilingFor('GLM-5.2')).toBe(65_536)
  })

  it('falls back to the conservative global ceiling for unmeasured models', () => {
    expect(maxTokensCeilingFor('openpangu-2.0-pro')).toBe(MAX_TOKENS_CEILING)
  })
})

describe('thinkingFields', () => {
  // pi-ai 把「没写」当支持：只报 high/max 的模型必须把其余档位钉成 null，
  // 否则选择器里会冒出 Off/Minimal/Low/Medium。
  it('offers only the declared levels and pins the rest to null', () => {
    const fields = thinkingFields(['high', 'max'])
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    })
  })

  it('stays a plain chat model without a usable strength', () => {
    expect(thinkingFields(undefined)).toEqual({ reasoning: false })
    expect(thinkingFields([])).toEqual({ reasoning: false })
    // 不认识的档位名不能编成推理能力，否则会发出上游不认的 reasoning_effort。
    expect(thinkingFields(['ultra'])).toEqual({ reasoning: false })
    expect(thinkingFields(['off'])).toEqual({ reasoning: false })
  })
})

/** 三路响应都按 2026-09-30 实测形状裁剪。 */
const BUILTIN_BODY = JSON.stringify({
  count: 4,
  builtinModels: [
    {
      model_id: 'GLM-5.2',
      model_name: 'GLM-5.2',
      enable: true,
      display_enabled: true,
      supports_images: false,
      // 实测默认时段与低峰时段各一条；展示只取 default。
      credit: [
        { ratio: 0.7, ratio_display: '0.7x', time_slot_id: 'default' },
        { ratio: 0.35, ratio_display: '0.35x', time_slot_id: 'off_peak' },
      ],
    },
    { model_id: 'glm-5.2-sft-harmony', model_name: 'GLM-5.2-ArkTS-SPARK', enable: true, shows_images: false },
    { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B', enable: true, supports_images: true },
    { model_id: 'retired-model', model_name: 'Retired', enable: false },
  ],
})

const BENEFIT_BODY = JSON.stringify({
  error_code: '0000',
  error_msg: 'success',
  result: {
    base_url: 'https://opengw.developer.huaweicloud.com/v2',
    models: [
      {
        context_window: 1_048_576,
        max_tokens: 393_216,
        model_id: 'deepseek-v4-flash-0731',
        model_name: 'DeepSeek-V4-Flash (免费)',
        sort: 10,
        credit: [
          { ratio: 0.18, ratio_display: '0.18x', time_slot_id: 'default' },
          { ratio: 0.09, ratio_display: '0.09x', time_slot_id: 'off_peak' },
        ],
      },
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
        // 顺序故意颠倒：展示取 default，不能按数组第一条。
        credit: [
          { ratio: 0.35, ratio_display: '0.35x', time_slot_id: 'off_peak' },
          { ratio: 0.7, ratio_display: '0.7x', time_slot_id: 'default' },
        ],
      },
      {
        // 实测：model_name 是显示名，注册名在 params.model_id —— 取错会多出假模型。
        model_alias: 'glm-5.2-sft-harmony',
        model_name: 'GLM-5.2-ArkTS-SPARK',
        model_parameters: { model_id: 'glm-5.2-sft-harmony', context_window: 202_752, max_tokens: 131_072 },
        credit: [{ ratio: 0.7, ratio_display: '0.7x', time_slot_id: 'default' }],
      },
    ],
  },
})

// 26.10.0 的思考档位：只有 GLM 系报了 high/max，其余空 strengths。
const THINKING_BODY = JSON.stringify({
  variants: {
    'GLM-5.2': { strengths: ['high', 'max'], default_strength: 'high' },
    'glm-5.2-sft-harmony': { strengths: ['high'], default_strength: 'high' },
    'Qwen3-VL-235B': { strengths: [] },
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
      '/v1/model/thinking-variants': () => json(THINKING_BODY),
    })

    const result = await fetchModels(credential)
    expect([...result.sources].sort()).toEqual(['agent', 'benefit', 'builtin'])
    expect(result.errors).toEqual([])

    const byId = new Map(result.models.map(m => [m.id, m]))
    // 福利网关标称 393216，实测上限 65536：必须钳住，否则每个请求都 400。
    expect(byId.get('deepseek-v4-flash-0731')?.maxTokens).toBe(65_536)
    // GLM-5.2 的实测上限同样要钳住：上游 2026-10-10 起拒 131072。
    expect(byId.get('GLM-5.2')?.maxTokens).toBe(65_536)
    expect(byId.get('GLM-5.2')?.contextWindow).toBe(202_752)
    // 倍率取默认时段；内置 / agent 两路都给的模型合并后不能丢。
    expect(byId.get('GLM-5.2')?.ratio).toBe('0.7x')
    expect(byId.get('glm-5.2-sft-harmony')?.ratio).toBe('0.7x')
    expect(byId.get('deepseek-v4-flash-0731')?.ratio).toBe('0.18x')
    // 上游没有 credit 的模型：不编造倍率，界面上就不显示。
    expect(byId.get('Qwen3-VL-235B')?.ratio).toBeUndefined()
    // 显示名不等于注册名时，注册名当 id（否则会多出一个选不得的假模型）。
    expect(byId.has('glm-5.2-sft-harmony')).toBe(true)
    expect(byId.get('glm-5.2-sft-harmony')?.name).toBe('GLM-5.2-ArkTS-SPARK')
    expect(byId.has('GLM-5.2-ArkTS-SPARK')).toBe(false)
    // enable=false 的内置模型不进目录。
    expect(byId.has('retired-model')).toBe(false)
    // 参数表里有 GLM-5.1，但这次三路都没返回它 —— 目录里就不该出现（不做兜底）。
    expect(byId.has('GLM-5.1')).toBe(false)
    expect(result.models.every(m => m.maxTokens > 0 && m.contextWindow > 0)).toBe(true)
    // 思考档位按上游清单挂上；声明了空清单的不带。
    expect(byId.get('GLM-5.2')?.thinking).toEqual({ strengths: ['high', 'max'], default: 'high' })
    expect(byId.get('glm-5.2-sft-harmony')?.thinking?.strengths).toEqual(['high'])
    expect(byId.get('Qwen3-VL-235B')?.thinking).toBeUndefined()
  })

  it('keeps working when a source fails (benefit gateway down)', async () => {
    stubFetch({
      '/v1/model/builtin': () => json(BUILTIN_BODY),
      '/v1/agent-center/agents/useragents': () => json(AGENT_LIST_BODY),
      '/v1/agent-center/agents/detail': () => json(AGENT_DETAIL_BODY),
      '/api/v1/gateway/config': () => new Response('{"error_code":"0500"}', { status: 500 }),
      '/v1/model/thinking-variants': () => json(THINKING_BODY),
    })

    const result = await fetchModels(credential)
    expect([...result.sources].sort()).toEqual(['agent', 'builtin'])
    expect(result.errors.map(e => e.source)).toEqual(['benefit'])
    expect(result.models.map(m => m.id)).toContain('GLM-5.2')
  })

  // 思考档位只是增强：这一路挂了不能把目录一起带走。
  it('keeps the catalog when only thinking-variants fails', async () => {
    stubFetch({
      '/v1/model/builtin': () => json(BUILTIN_BODY),
      '/api/v1/gateway/config': () => json(BENEFIT_BODY),
      '/v1/agent-center/agents/useragents': () => json(AGENT_LIST_BODY),
      '/v1/agent-center/agents/detail': () => json(AGENT_DETAIL_BODY),
      '/v1/model/thinking-variants': () => new Response('nope', { status: 500 }),
    })

    const result = await fetchModels(credential)
    expect(result.errors.map(e => e.source)).toEqual(['thinking'])
    const glm = result.models.find(m => m.id === 'GLM-5.2')
    expect(glm).toBeDefined()
    expect(glm?.thinking).toBeUndefined()
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

describe('refreshCatalog 的显示名', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setDiscoveredBenefitModels([])
  })

  function oneAccountStore() {
    return {
      ids: async () => ['acct'],
      list: async () => [{ id: 'acct', label: 'acct' }],
      resolve: async () => credential,
    } as never
  }

  // 宿主的模型下拉只渲染文字，插不进 Tag —— 「 · x0.70 · 福利」这些尾巴就是
  // 那里唯一能看见福利与倍率的地方。上游把福利叫「免费」，统一成我们的措辞。
  it('名字带福利与倍率尾巴，没 credit 的不硬编', async () => {
    stubFetch({
      '/v1/model/builtin': () => json(BUILTIN_BODY),
      '/api/v1/gateway/config': () => json(BENEFIT_BODY),
      '/v1/agent-center/agents/useragents': () => json(AGENT_LIST_BODY),
      '/v1/agent-center/agents/detail': () => json(AGENT_DETAIL_BODY),
      '/v1/model/thinking-variants': () => json(THINKING_BODY),
    })
    const catalog = new CodeArtsCatalog()
    await refreshCatalog(oneAccountStore(), catalog)
    const byId = new Map(catalog.current().map(m => [m.id, m]))
    // 福利模型不带上游残留的 0.18x，倍率强制成 x0.00；标签照 codebuddy 放在最后。
    expect(byId.get('deepseek-v4-flash-0731')?.name).toBe('DeepSeek-V4-Flash · x0.00 · 福利')
    expect(byId.get('glm-5.3-flash')?.name).toBe('glm-5.3-flash · x0.00 · 福利')
    expect(byId.get('GLM-5.2')?.name).toBe('GLM-5.2 · x0.70')
    expect(byId.get('glm-5.2-sft-harmony')?.name).toBe('GLM-5.2-ArkTS-SPARK · x0.70')
    // 上游没给 credit 的保持原名，不硬编 x1.00。
    expect(byId.get('Qwen3-VL-235B')?.name).toBe('Qwen3-VL-235B')
  })
})
