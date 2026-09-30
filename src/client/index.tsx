/** Browser half: CodeArts token status inside Plugin configuration (MVP). */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CodeArtsPluginCard } from './CodeArtsPluginCard.tsx'
import type { CodeArtsPluginCardInjected } from './CodeArtsPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { CodeArtsSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.codearts': CodeArtsSettingsKey
  }
  /**
   * rc.2 宿主把插件配置页挂在 plugins.bundle.config（按 bundle 包名取 key）。
   * 这个槽位只在宿主运行时声明 —— 连 0.2.0-rc.2 的 settings-plugins 类型里都没有
   * （它导出的槽位是 settings.plugins.tab / settings.general.item 那一组），
   * 所以只能我们自己补，让类型跟运行时的真槽位对上。
   */
  interface SlotMap {
    'plugins.bundle.config': {
      kind: 'keyed';
      scope: 'root';
      owner: { children?: never };
    };
  }
}

export const name = 'dsh-codearts-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.codearts'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-codearts: settings copy')
    const t = ctx.locale.bind(namespace) as CodeArtsPluginCardInjected['t']

    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: 'dsh-codearts',
      locale: namespace,
    }, () => <CodeArtsPluginCard t={t} />))
  } catch (error: unknown) {
    console.error('[dsh-codearts] client card failed to load (host provider unaffected):', error)
  }
}
