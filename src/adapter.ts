/**
 * The `codearts` pi-ai provider.
 *
 * One loopback-backed adapter registered into the Harness LLM seam, assembled
 * from the same public `dsh-llm-pi-ai` extension points dsh-codebuddy-cli uses.
 * The shim does the CodeArts wire translation; this file only describes the
 * models and points pi-ai at the shim's OpenAI-compatible endpoint.
 *
 * MVP simplifications vs dsh-codebuddy-cli:
 *   - only the default-slot credit multiplier goes into the model name (`(x0.18)`);
 *     per-request cost is not modelled (subscription quota, cost reported as zero)
 *   - reasoning levels are surfaced only where upstream's thinking-variants names
 *     them (`GLM-5.2` → high/max); everything else stays a plain chat model
 *
 * @module dsh-codearts/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, ResolvedNormalRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { filterEnabledModels, type CodeArtsCatalog, type CodeArtsModelInfo } from './catalog.ts'
import type { CodeArtsShim } from './shim.ts'

/** Provider route this bundle owns. Keep in sync with cordis.patch.yml. */
export const CODEARTS_PROVIDER = 'codearts'

/**
 * Provider idle ceiling while one stream read is outstanding.
 *
 * 90s 而不是常见的 300s：华为免费推理后端实测会流中途停摆（吐几个 token 后
 * 长时间静默），300s 意味着用户要在"等待"里干等 5 分钟才进入自动重试。
 * 90s 足够容忍首 token 冷启动与推理间隙，又能让 DSH 的重试策略（TIMEOUT
 * 可重试）更快接管。
 */
export const CODEARTS_STREAM_IDLE_TIMEOUT_MS = 90_000

/**
 * 重试预算：必须跨得过插件自己的账号冷却窗（issue #14）。
 *
 * 软限流 / 5xx 会把账号冷却 30s（`shim.ts` 的 `SERVER_COOLDOWN_MS`），期间所有
 * 请求回 429 `soft_rate` 交给宿主重试。宿主默认预算是 5 次、0.5s 起指数退避
 * （累计 ≈15.5s）—— 在冷却窗**前段**撞上时，预算必定先烧尽，变成一次可见的轮次
 * 失败。默认次数因此对齐到 8 次（0.5+1+2+4+8+10+10+10 ≈45.5s，含 0.9 抖动下限
 * 也稳过 30s），并且可以通过插件配置 `retryPolicy` 自己调。
 *
 * 代价：持续性故障（等完再被拒、贯穿整个预算）的暴露时间从 ≈15.5s 变 ≈45.5s。
 * 实测这种型态很少见，而「等完即放行」是常态，所以默认选跨得过窗口这边。
 */
export const DEFAULT_CODEARTS_MAX_RETRIES = 8
const DEFAULT_CODEARTS_INITIAL_DELAY_MS = 500
const DEFAULT_CODEARTS_MAX_DELAY_MS = 10_000

/**
 * 重试码 = 宿主默认五项 + MALFORMED_RESPONSE。
 *
 * 模型偶尔把 tool_call 参数写成非法 JSON（未转义引号、流内 JSON 损坏），
 * pi-ai 在**派发工具之前**就判整轮失败 —— 用户看到的是一轮报错、选项全无。
 * 重发一次让模型重新生成，多数自愈。宿主的默认集合不含这个码，而
 * `retryableCodes` 是替换语义（不是并入），所以五项默认值必须显式列全。
 */
const RETRYABLE_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'MALFORMED_RESPONSE',
] as const

/** 用户在 `llm-codearts.config.retryPolicy` 里可调的三个旋钮。 */
export interface CodeArtsRetryPolicyConfig {
  /** 首次请求之后最多重试几次（默认 8，覆盖 30s 冷却窗）。 */
  maxRetries?: number
  /** 首档退避毫秒数（默认 500）。 */
  initialDelayMs?: number
  /** 单档退避上限毫秒数（默认 10000）。 */
  maxDelayMs?: number
}

/** 只认有限正整数；非法值忽略而不是抛错（值来自用户写的配置文件）。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/** 把插件配置解析成宿主快照用的重试策略；缺省值按上面注释对齐冷却窗。 */
export function resolveCodeArtsRetryPolicy(config?: CodeArtsRetryPolicyConfig): ResolvedNormalRetryPolicy {
  const resolved: RetryPolicyConfig = {
    mode: 'normal',
    maxRetries: positiveInt(config?.maxRetries) ?? DEFAULT_CODEARTS_MAX_RETRIES,
    retryableCodes: [...RETRYABLE_CODES],
    backoff: {
      initialDelayMs: positiveInt(config?.initialDelayMs) ?? DEFAULT_CODEARTS_INITIAL_DELAY_MS,
      maxDelayMs: positiveInt(config?.maxDelayMs) ?? DEFAULT_CODEARTS_MAX_DELAY_MS,
    },
  }
  const policy = resolveRetryPolicy(resolved, 'dsh-codearts retryPolicy')
  // 这里构造的永远是 normal；收窄类型，调用方不必各自判别。
  if (policy.mode !== 'normal') throw new Error('dsh-codearts retry policy must be normal')
  return policy
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * 6 MiB 而不是 20 MiB：上游网关对**整个请求体**约 10 MB 就拒（issue #18 实测
 * 9.71 MB 过、10.41 MB 拒，且纯文本 1 MB 能过 ⇒ 是字节而非 token）。20 MiB 的
 * 预算会让图片总量 10 MB 左右的请求直接发给上游，撞 InferHub.001001005.400，
 * 再被误判成上下文超限。压到 6 MiB 后，宿主会把最老的图片换成占位文本
 * （`read_image` 按需重读），给文本与工具定义留出约 4 MB 余量。
 */
export const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 6_291_456,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/** Inert pi-ai auth plane: the codearts route authenticates only via the shim secret. */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-codearts: the codearts route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

export interface CodeArtsAdapterOptions {
  shim: CodeArtsShim
  catalog: CodeArtsCatalog
  enabledModels?: () => readonly string[] | undefined
  /** issue #14 的 `retryPolicy` 配置；缺省按默认预算（8 次）注册。 */
  retryPolicy?: CodeArtsRetryPolicyConfig
  resolveAttachments?: () => AttachmentStore | undefined
}

export interface CodeArtsAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

/** pi-ai's selectable levels, in escalation order. */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Turn upstream's thinking strengths into pi-ai reasoning metadata.
 *
 * Every level upstream does not declare is pinned to `null`: pi-ai treats a
 * missing entry as supported, so leaving them out would offer Off/Minimal/Low/
 * Medium for a model that only knows high/max. `off` is pinned as well — the
 * gateway's default is already high, and claiming Off would send no effort
 * field and still think.
 */
export function thinkingFields(strengths: readonly string[] | undefined): {
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
} {
  const offered = new Set(strengths ?? [])
  if (!REASONING_LEVELS.some(level => level !== 'off' && offered.has(level))) return { reasoning: false }
  const map = {} as Record<(typeof REASONING_LEVELS)[number], string | null>
  for (const level of REASONING_LEVELS) map[level] = offered.has(level) ? level : null
  return { reasoning: true, thinkingLevelMap: map }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: CodeArtsModelInfo, baseUrl: string): Model<Api> {
  const thinking = thinkingFields(info.thinking?.strengths)
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: CODEARTS_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? (['text', 'image'] as const) : (['text'] as const),
    reasoning: thinking.reasoning,
    ...(thinking.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: thinking.thinkingLevelMap }),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

export function createCodeArtsAdapter(options: CodeArtsAdapterOptions): CodeArtsAdapter {
  const { shim, catalog, enabledModels, resolveAttachments } = options

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl))
  }

  const base = createProvider({
    id: CODEARTS_PROVIDER,
    name: 'CodeArts',
    auth: {
      apiKey: {
        name: 'CodeArts token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'CodeArts' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profileFields = {
    provider: CODEARTS_PROVIDER,
    displayName: 'CodeArts',
    streamIdleTimeoutMs: CODEARTS_STREAM_IDLE_TIMEOUT_MS,
    // 宿主在注册时快照策略，改配置需要重载插件（不能热切）。
    retryPolicy: resolveCodeArtsRetryPolicy(options.retryPolicy),
    configuredMaxTokens: new Map(),
    modelErrors: new Map<string, string>(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  const profile = profileFields as unknown as ResolvedPiAiProviderProfile

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[CODEARTS_PROVIDER, profile]])

  const adapter = new CodeArtsPiAiAdapter(catalog, enabledModels, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[CODEARTS_PROVIDER, profile]])
    },
  }
}

/**
 * Adapter that narrows the *offered* model surface to the enabled allowlist
 * (dispatch stays whole). Mirrors dsh-codebuddy-cli's CodeBuddyPiAiAdapter.
 */
class CodeArtsPiAiAdapter extends PiAiAdapter {
  private readonly catalog: CodeArtsCatalog
  private readonly enabledModels: (() => readonly string[] | undefined) | undefined

  constructor(
    catalog: CodeArtsCatalog,
    enabledModels: (() => readonly string[] | undefined) | undefined,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
    this.catalog = catalog
    this.enabledModels = enabledModels
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    const allowed = filterEnabledModels(this.catalog.current(), this.enabledModels?.())
    const catalogIds = new Set(this.catalog.current().map(entry => entry.id))
    const allowedIds = new Set(allowed.map(entry => entry.id))
    return models.filter(model => !catalogIds.has(model.id) || allowedIds.has(model.id))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return super.resolveModel(provider, model, signal)
  }
}
