import { describe, expect, it } from 'vitest'
import {
  createCodeArtsAdapter,
  DEFAULT_CODEARTS_MAX_RETRIES,
  resolveCodeArtsRetryPolicy,
  type CodeArtsRetryPolicyConfig,
} from '../src/adapter.ts'
import { CodeArtsCatalog, type CodeArtsModelInfo } from '../src/catalog.ts'

const model = (id: string, patch: Partial<CodeArtsModelInfo> = {}): CodeArtsModelInfo => ({
  id,
  name: id,
  contextWindow: 202_752,
  maxTokens: 65_536,
  supportsImages: false,
  ...patch,
})

function adapterFor(models: CodeArtsModelInfo[], retryPolicy?: CodeArtsRetryPolicyConfig) {
  const catalog = new CodeArtsCatalog()
  catalog.set(models)
  const shim = {
    ready: Promise.resolve(),
    baseUrl: () => 'http://127.0.0.1:1',
    token: () => 'shim-secret',
    close: async () => {},
  }
  return createCodeArtsAdapter({ shim, catalog, retryPolicy, resolveAttachments: undefined }).adapter
}

describe('codearts adapter reasoning', () => {
  // 宿主选择器只认 efforts：上游声明什么就只露什么，别把 off/low 这些没声明的档位
  // 摆出来让用户选，也别给没有档位的模型硬加一个选择器。
  it('surfaces only the thinking strengths upstream declared', async () => {
    const adapter = adapterFor([
      model('GLM-5.2', { thinking: { strengths: ['high', 'max'], default: 'high' } }),
      model('Qwen3-VL-235B'),
    ])
    // listModels 只给基础信息；推理档位在 resolveModel 里（宿主选模型时读这份）。
    const glm = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(glm.reasoning?.efforts.map(effort => effort.id)).toEqual(['high', 'max'])
    const qwen = await adapter.resolveModel('codearts', 'Qwen3-VL-235B')
    expect(qwen.reasoning).toBeUndefined()
  })
})

// issue #14：账号冷却窗（shim 的 SERVER_COOLDOWN_MS = 30s）必须能被宿主重试预算
// 跨过去，否则冷却前段的 soft_rate 会确定性地烧尽预算、变成死轮。
describe('codearts retry policy', () => {
  it('defaults to a budget that outlasts the 30s cooldown', () => {
    // 宿主退避是 0.5s 起翻倍、10s 封顶：8 次累计 ≈45.5s，含 0.9 抖动下限仍 > 30s。
    const steps = [0.5, 1, 2, 4, 8, 10, 10, 10]
    expect(steps.reduce((a, b) => a + b, 0)).toBeGreaterThan(30)
    expect(steps.reduce((a, b) => a + b, 0) * 0.9).toBeGreaterThan(30)
    expect(DEFAULT_CODEARTS_MAX_RETRIES).toBe(steps.length)
    const policy = resolveCodeArtsRetryPolicy()
    expect(policy.mode).toBe('normal')
    expect(policy.maxRetries).toBe(DEFAULT_CODEARTS_MAX_RETRIES)
    expect(policy.initialDelayMs).toBe(500)
    expect(policy.maxDelayMs).toBe(10_000)
  })

  it('registers the default policy on the provider route', () => {
    const adapter = adapterFor([model('GLM-5.2')])
    const policy = adapter.providerRetryPolicy('codearts')
    expect(policy?.mode === 'normal' ? policy.maxRetries : undefined).toBe(DEFAULT_CODEARTS_MAX_RETRIES)
  })

  it('lets the user override the knobs', () => {
    const policy = resolveCodeArtsRetryPolicy({ maxRetries: 3, initialDelayMs: 1_000, maxDelayMs: 2_000 })
    expect(policy.maxRetries).toBe(3)
    expect(policy.initialDelayMs).toBe(1_000)
    expect(policy.maxDelayMs).toBe(2_000)
    const adapter = adapterFor([model('GLM-5.2')], { maxRetries: 3 })
    const registered = adapter.providerRetryPolicy('codearts')
    expect(registered?.mode === 'normal' ? registered.maxRetries : undefined).toBe(3)
  })

  // 配置读自用户写的文件：坏值不能让整个重试退化成默认之外的怪状态。
  it('ignores non-positive or non-finite values', () => {
    const policy = resolveCodeArtsRetryPolicy({ maxRetries: 0, initialDelayMs: -5, maxDelayMs: Number.NaN })
    expect(policy.maxRetries).toBe(DEFAULT_CODEARTS_MAX_RETRIES)
    expect(policy.initialDelayMs).toBe(500)
    expect(policy.maxDelayMs).toBe(10_000)
  })
})
