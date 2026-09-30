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
 * Deliberately out of scope for now:
 *   - no credits / balance (CodeArts exposes none; free quota resets monthly)
 *   - no multi-account (a single credential file)
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
  SNAP_HOST,
  chatStream,
  prepareChatBody,
  canonicalModel,
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

  let current = (): Config => config
  const enabledModels = (): readonly string[] | undefined => current().enabledModels

  const setEnabledModels = async (ids: readonly string[]): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), { enabledModels: [...ids] })
    return true
  }

  // Same-origin status/token routes backing the Plugin-configuration card.
  ctx.inject(['webServer'], webCtx => registerCodeArtsStatusRoute(webCtx, {
    store,
    models: () => catalog.current(),
    enabledModels,
    setEnabledModels,
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
    void shim.close().catch(() => {})
  })

  // Build the loopback shim first; the adapter reads its origin at construction.
  const shim = createCodeArtsShim({ store, catalog, pool, logger: ctx.logger })

  void shim.ready
    .then(() => {
      if (stopped) return
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
