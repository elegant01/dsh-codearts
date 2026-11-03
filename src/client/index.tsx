/** Browser half: CodeArts token status inside Plugin configuration (MVP). */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CodeArtsPluginCard } from './CodeArtsPluginCard.tsx'
import type { CodeArtsPluginCardInjected } from './CodeArtsPluginCard.tsx'
import { CodeArtsCreditDock } from './CodeArtsCreditDock.tsx'
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

    // 积分条挂在输入框工具行、权限控制右边（conversation.input.left，宿主契约原文
    // 「Compact controls at the left of the composer tool row」）。
    //
    // 原先整条都挂在输入框下方的 conversation.composer.dock：那里还挤着宿主自己的
    // tok/s、缓存命中、上下文圆环，模型名一长（DeepSeek-V4.1-Flash-20261017）整条就
    // 压不住。现在拆成两个实例：积分进工具行，Provider / 模型 / 倍率 / 排队留在原处。
    // 模型名和倍率在工具行右侧本来就有 pill，搬过去只会重复占宽。
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: 'codearts-credits-bar',
      order: 20,
      locale: namespace,
      inject: () => ({ t, zone: 'bar' as const }),
    }, CodeArtsCreditDock))

    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'codearts-credits',
      order: 20,
      locale: namespace,
      inject: () => ({ t, zone: 'dock' as const }),
    }, CodeArtsCreditDock))
  } catch (error: unknown) {
    console.error('[dsh-codearts] client card failed to load (host provider unaffected):', error)
  }
}
