/**
 * The `codearts` pi-ai provider.
 *
 * One loopback-backed adapter registered into the Harness LLM seam, assembled
 * from the same public `dsh-llm-pi-ai` extension points dsh-codebuddy-cli uses.
 * The shim does the CodeArts wire translation; this file only describes the
 * models and points pi-ai at the shim's OpenAI-compatible endpoint.
 *
 * MVP simplifications vs dsh-codebuddy-cli:
 *   - no billing rate in the model name (CodeArts has no balance API)
 *   - no per-model reasoning ladder (models are surfaced as plain chat models)
 *
 * @module dsh-codearts/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
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
 * 90s 足够容忍首 token 冷启动与推理间隙，又能让 DSH 的重试策略
 * （maxRetries=5, TIMEOUT 可重试）更快接管。
 */
export const CODEARTS_STREAM_IDLE_TIMEOUT_MS = 90_000

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
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
  resolveAttachments?: () => AttachmentStore | undefined
}

export interface CodeArtsAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: CodeArtsModelInfo, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: CODEARTS_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? (['text', 'image'] as const) : (['text'] as const),
    // MVP: no reasoning ladder surfaced; CodeArts reasoning is not modeled here.
    reasoning: false,
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
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-codearts retryPolicy'),
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
