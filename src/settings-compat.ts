/**
 * Compatibility helpers for the `dsh-settings` API transition.
 *
 * The settings API moved through three generations:
 *   1. `installSettingsSection(ctx, ns, schema, entry, hooks)` (module-level)
 *   2. `settings.installSection(...)` (provider service, DSH 0.1.2+)
 *   3. Managed forms (DSH 0.1.7+): no installer; forms derived from the
 *      plugin's Loader-entry Config schema + `configure({ auto: false })`.
 *
 * This module detects which generation is installed at runtime, so one build
 * keeps working on every supported DSH host. Adapted from dsh-codebuddy-cli.
 *
 * @module dsh-codearts/settings-compat
 */

import type { Context } from '@deepseek-ai/cordis'
import * as settingsModule from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

type SettingsModuleCompat = {
  settingsNamespace?: (value: string) => SettingsNamespace
  installSettingsSection?: <T>(
    ctx: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
}

interface SettingsProviderCompat {
  configure?: (presentation: { auto?: boolean }, owner?: unknown) => (() => void) | void
  installSection?: <T>(
    owner: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
  describe?: () => readonly { ns: SettingsNamespace | string; value?: unknown }[]
}

const compatModule = settingsModule as unknown as SettingsModuleCompat

function plainSettingsSchema<T>(schema: z<T>): z<T> {
  const clone = structuredClone(schema.toJSON()) as unknown as {
    refs?: Record<string, { meta?: Record<string, unknown> }>
  }
  for (const node of Object.values(clone.refs ?? {})) {
    if (node !== null && typeof node === 'object' && node.meta !== undefined) delete node.meta.volatile
  }
  return z(clone as never) as unknown as z<T>
}

function entryNamespaceOf(ctx: Context): SettingsNamespace | undefined {
  const compat = ctx as unknown as {
    fiber?: { entry?: { id?: unknown; options?: { id?: unknown } } }
    loader?: { locate?: (fiber?: unknown) => unknown }
  }
  const entry = compat.fiber?.entry
  const candidates = [entry?.options?.id, entry?.id, compat.loader?.locate?.(compat.fiber)]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate as SettingsNamespace
  }
  return undefined
}

export function settingsNamespaceCompat(value: string): SettingsNamespace {
  return compatModule.settingsNamespace?.(value) ?? (value as SettingsNamespace)
}

export function resolveSettingsNamespaceCompat(
  ctx: Context,
  provider: unknown,
  fallback: SettingsNamespace,
): SettingsNamespace {
  if (compatModule.installSettingsSection !== undefined) return fallback
  const candidate = provider as SettingsProviderCompat
  if (candidate.installSection !== undefined) return fallback
  if (candidate.configure !== undefined) return entryNamespaceOf(ctx) ?? fallback
  return fallback
}

export function installSettingsSectionCompat<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacyInstaller = compatModule.installSettingsSection
  if (legacyInstaller !== undefined) {
    legacyInstaller(ctx, ns, plainSettingsSchema(schema), entry, hooks)
    return
  }

  ctx.inject(['settings'], (sctx) => {
    const provider = sctx.get('settings') as unknown as SettingsProviderCompat | undefined
    if (provider === undefined) return

    if (provider.installSection !== undefined) {
      provider.installSection(ctx, ns, plainSettingsSchema(schema), entry, hooks)
      return
    }

    if (provider.configure === undefined) {
      throw new TypeError('dsh-settings exposes neither installSection nor configure')
    }

    sctx.effect(() => {
      const dispose = provider.configure?.({ auto: false }, ctx.fiber)
      return typeof dispose === 'function' ? dispose : () => {}
    })

    const namespace = entryNamespaceOf(ctx)
    if (namespace !== undefined) {
      const refresh = (): void => {
        const descriptor = provider.describe?.().find(entry => String(entry.ns) === namespace)
        if (descriptor?.value !== undefined) {
          hooks.setSource?.(() => descriptor.value as T)
        }
        hooks.onChange()
      }
      const settingsEvents = sctx as unknown as {
        on(event: 'settings/document-updated', listener: (updated: unknown) => void): () => void
      }
      sctx.effect(() => settingsEvents.on('settings/document-updated', (updated) => {
        if (String(updated) === namespace) refresh()
      }))
    }
  })
}
