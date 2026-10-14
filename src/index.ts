/**
 * CodeArts models for DeepSeek Harness. The plugin registers a `codearts`
 * provider that forwards requests to CodeArts' OpenAI-compatible chat endpoint
 * through a local loopback shim.
 *
 * Sign-in is a full Huawei Cloud OAuth2 flow (PKCE + DPoP + local callback)
 * that exchanges the authorization code for an STS credential — a
 * `security_token` plus temporary AK/SK, which the chat request signs with
 * SDK-HMAC-SHA256. Pasting a bare `security_token` in the settings card remains
 * as a degraded path: without AK/SK the signature cannot be produced, so the
 * gateway rejects the chat.
 *
 * The model catalog is seeded statically and refreshed by dynamic discovery
 * (`src/discovery.ts`): the plugin asks CodeArts for the account's real model
 * list on startup and hourly, and falls back to the seed when that fails.
 *
 * Deliberately out of scope for now:
 *   - no account balance/credits: CodeArts exposes no such API. The plugin keeps
 *     its own ledger of requests it sent (`src/usage.ts`) and links to the
 *     official usage page instead of inventing a number.
 *   - no per-model reasoning ladder (models surface as plain chat models)
 *
 * @module dsh-codearts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CodeArtsAccountStore, codeartsAccountsPath } from './auth.ts'
import { CodeArtsAccountPool } from './account-pool.ts'
import { CodeArtsCatalog, filterEnabledModels } from './catalog.ts'
import { refreshCatalog } from './discovery.ts'
import { CodeArtsUsageTracker, codeartsUsagePath } from './usage.ts'
import { CodeArtsCreditCache, type CodeArtsCreditState } from './credits.ts'
import { createCodeArtsAdapter, CODEARTS_PROVIDER } from './adapter.ts'
import { createCodeArtsShim } from './shim.ts'
import { registerCodeArtsStatusRoute } from './web-status.ts'
import { installSettingsSectionCompat, resolveSettingsNamespaceCompat } from './settings-compat.ts'

export { CODEARTS_PROVIDER, createCodeArtsAdapter, type CodeArtsAdapter } from './adapter.ts'
export { createCodeArtsShim, type CodeArtsShim } from './shim.ts'
export {
  FALLBACK_CODEARTS_MODELS,
  CodeArtsCatalog,
  filterEnabledModels,
  type CodeArtsModelInfo,
} from './catalog.ts'
export {
  codeartsAuthPath,
  codeartsAccountsPath,
  CodeArtsAccountStore,
  CodeArtsCredentialStore,
  type CodeArtsAccountSummary,
  type CodeArtsCredential,
} from './auth.ts'
export { CodeArtsAccountPool, type AccountRuntime } from './account-pool.ts'
export {
  BENEFIT_GATEWAY_HOST,
  CodeArtsCreditCache,
  fetchCredits,
  parseCreditStatistics,
  parseTokenBalance,
  type CodeArtsCreditCategory,
  type CodeArtsCredits,
  type CodeArtsCreditSnapshot,
  type CodeArtsCreditState,
  type CodeArtsTokenQuota,
} from './credits.ts'
export {
  CodeArtsUsageTracker,
  codeartsUsagePath,
  type UsageSnapshot,
  type UsageTotals,
} from './usage.ts'
import { claimBenefit } from './upstream.ts'
export { discoverModels, refreshCatalog, type DiscoveryOutcome } from './discovery.ts'
export {
  SNAP_HOST,
  chatStream,
  prepareChatBody,
  canonicalModel,
  fetchModels,
  maxTokensCeilingFor,
  type ModelDiscoveryResult,
  type UpstreamErrorKind,
} from './upstream.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-codearts'

/** The llm service is required before the provider can register. */
export const inject = ['llm']

/** Settings namespace owning the configuration card. */
export const CODEARTS_SETTINGS_NS = 'codearts' as SettingsNamespace

/** Plugin configuration (MVP: just the model allowlist). */
export interface Config {
  /** Allowlist of CodeArts model ids offered in the model pickers. */
  enabledModels?: string[]
}

interface VolatileValue<T> {
  get: () => T
}

function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

export const Config: z<Config> = z.object({
  enabledModels: z.array(z.string()).description('Model ids offered in the model pickers (empty means every model)').volatile(),
}) as unknown as z<Config>

function settingsCompatNamespace(ctx: Context): SettingsNamespace {
  return resolveSettingsNamespaceCompat(ctx, ctx.get('settings'), CODEARTS_SETTINGS_NS)
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config = unwrapConfig(rawConfig)
  const accountsPath = codeartsAccountsPath()
  // 多账号：池与账号文档分离——文档管凭证，池管「谁现在能接活」。
  const store = new CodeArtsAccountStore(accountsPath)
  const pool = new CodeArtsAccountPool([])
  const catalog = new CodeArtsCatalog()
  // 用量账本：记本机经插件发出的请求（账号总额度见 credits.ts，这里只记本机）。
  const usage = new CodeArtsUsageTracker({ path: codeartsUsagePath() })
  // 积分：CodeArts **有**积分接口（2026-10 从官方 Agent 客户端挖出，见 credits.ts）。
  const credits = new CodeArtsCreditCache()

  /** /status 是卡片与对话底部都会轮询的接口，积分慢请求不能把它拖成转圈。 */
  const CREDIT_TIMEOUT_MS = 8_000

  /**
   * 拉一次积分。
   *
   * 积分是**账号级**属性，不随请求轮转：这里挑第一个没用坏的账号，够覆盖正常用法
   * （多账号下的积分差异不在本插件关心范围内）。
   */
  const loadCredits = async (signal?: AbortSignal): Promise<CodeArtsCreditState> => {
    const ids = await store.ids()
    if (ids.length === 0) return { phase: 'error', message: 'not signed in', at: Date.now() }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CREDIT_TIMEOUT_MS)
    timer.unref?.()
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      let last: CodeArtsCreditState | undefined
      for (const id of ids) {
        const stored = await store.credential(id)
        if (stored === undefined || stored.stale === true) continue
        const resolved = await store.resolve(id)
        if (resolved === undefined) continue
        const state = await credits.get(resolved, controller.signal)
        if (state.phase === 'ok') return state
        last = state
      }
      return last ?? { phase: 'error', message: 'no usable credential', at: Date.now() }
    } finally {
      clearTimeout(timer)
    }
  }

  let current = (): Config => config
  const enabledModels = (): readonly string[] | undefined => current().enabledModels

  const setEnabledModels = async (ids: readonly string[]): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), { enabledModels: [...ids] })
    return true
  }

  // Same-origin status/token routes backing the Plugin-configuration card.
  // 卡片另外读账号池的槽位占用与用量账本：这两个都是本机事实，不涉及令牌。
  ctx.inject(['webServer'], webCtx => registerCodeArtsStatusRoute(webCtx, {
    store,
    models: () => catalog.current(),
    enabledModels,
    setEnabledModels,
    pool: () => pool.list(),
    usage: () => usage.snapshot(),
    credits: signal => loadCredits(signal),
    claim: async () => {
      try {
        const ids = await store.ids()
        for (const id of ids) {
          const stored = await store.credential(id)
          if (stored === undefined || stored.stale === true) continue
          const resolved = await store.resolve(id)
          if (resolved === undefined) continue
          // 只开通限时福利渠道：它不改变积分，所以这里不碰积分缓存（积分看签到页）。
          await claimBenefit(resolved, AbortSignal.timeout(10_000))
          return { ok: true as const }
        }
        return { ok: false as const, message: 'no usable credential' }
      } catch (error: unknown) {
        return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }))

  // The settings section keeps the enabled-model allowlist live. On hosts with
  // a settings provider it contributes the section; without one the plugin
  // still serves its models, it simply has no editable section.
  installSettingsSectionCompat(ctx, CODEARTS_SETTINGS_NS, Config, config, {
    setSource(source) {
      current = () => unwrapConfig(source())
    },
    onChange() {
      // authFile had no analogue here; nothing else to react to for MVP.
    },
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    // 账本落盘再关：不然最后几秒的用量会随进程一起丢。
    void usage.flush().catch(() => {})
    void shim.close().catch(() => {})
  })

  // 动态模型发现：启动后拉一次真实目录，之后每小时刷新。失败只记日志 —— 目录保留
  // 上一次的结果（冷启动时就是种子清单），不因为上游抖动把模型选择器清空。
  const CATALOG_REFRESH_MS = 60 * 60 * 1000
  const abort = new AbortController()
  const discover = async (): Promise<void> => {
    if (stopped) return
    try {
      const outcome = await refreshCatalog(store, catalog, abort.signal)
      if (outcome === undefined || stopped) return
      if (outcome.anySucceeded) {
        const free = outcome.models.filter(model => model.benefit === true).length
        ctx.logger.debug(
          `dsh-codearts: model discovery refreshed the catalog (${outcome.models.length} models, ${free} benefit)`,
        )
      } else {
        ctx.logger.warn(
          'dsh-codearts: model discovery found nothing usable; keeping the current catalog',
          outcome.accounts.flatMap(account => account.errors),
        )
      }
    } catch (error) {
      ctx.logger.debug('dsh-codearts: model discovery failed; keeping the current catalog', error)
    }
  }
  ctx.effect(() => {
    const timer = setInterval(() => void discover(), CATALOG_REFRESH_MS)
    timer.unref?.()
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  })

  // Build the loopback shim first; the adapter reads its origin at construction.
  const shim = createCodeArtsShim({ store, catalog, pool, usage, logger: ctx.logger })

  // 账本懒加载：读盘失败/文件不存在都不影响插件启动。
  void usage.load().catch(() => {})

  void shim.ready
    .then(() => {
      if (stopped) return
      // 先让 provider 挂上（用种子目录即可服务），再异步换成真实清单。
      void discover()
      const codearts = createCodeArtsAdapter({
        shim,
        catalog,
        enabledModels,
        resolveAttachments: () => ctx.get('attachments'),
      })

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        releaseAdapter = ctx.llm.registerAdapter([CODEARTS_PROVIDER], codearts.adapter)
        releaseDirectory = ctx.llm.registerConfigurableProviders([{
          provider: CODEARTS_PROVIDER,
          displayName: 'CodeArts',
          settingsNs: settingsCompatNamespace(ctx),
          settingsPath: [],
          declared: false,
        }])
      } finally {
        if (releaseAdapter === undefined || releaseDirectory === undefined) {
          releaseAdapter?.()
          releaseDirectory?.()
        }
      }
      try {
        ctx.effect(() => () => {
          releaseAdapter?.()
          releaseDirectory?.()
        })
      } catch {
        releaseAdapter?.()
        releaseDirectory?.()
      }
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-codearts: loopback shim failed to start; provider not registered', error)
    })
}
