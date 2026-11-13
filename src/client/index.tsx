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
import { CodeArtsPanelIcon, CodeArtsPanelPage } from './CodeArtsPanel.tsx'
import { setSettingsEntryWanted, setSidebarPanelWanted, sidebarPanelWanted, settingsEntryWanted, subscribeSettingsEntryWanted, subscribeSidebarPanelWanted } from './panel-switch.ts'
import { dockSnapshot, subscribeDock } from './dock-store.ts'
import { openPluginSettings } from './settings-route.ts'
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
    /**
     * 侧边栏那排图标（宿主 ui-sidebar 声明）。每个 list id 对应 main 面板里
     * 同名的 key —— 宿主自己画按钮，只找我们要两样东西：一个显示用的
     * label，和一个 glyph 组件（组件本身就是图标，宿主给 size / active）。
     */
    'sidebar.panellist': {
      kind: 'list';
      scope: 'root';
      owner: { size: number; active: boolean };
    };
    /** 中间列的面板（宿主 ui-layout 声明）。key 'conversation' 是保留给对话的。 */
    'main': {
      kind: 'keyed';
      scope: 'root';
      owner: { children?: never };
    };
    /**
     * 设置左侧那一列导航（宿主 ui-settings 声明）。用户找插件的第一反应就是这里
     * （issue #7），而「内置插件 → 详情页」那条路径对第一次用的人基本等于找不到。
     */
    'settings.section': {
      kind: 'list';
      scope: 'root';
    };
  }
}

export const name = 'dsh-codearts-client'
export const inject = ['slots', 'locale']

/**
 * 侧边栏按钮的 id，同时也是中间列面板的 key —— 宿主靠这两个同名值把
 * 「点了哪一行」和「中间列画哪一页」配对。
 */
const PANEL_ID = 'dsh-codearts'

export function apply(ctx: ClientContext): void {
  /**
   * 回对话页。软取 layout 服务：`ctx.get` 在服务没提供时返回 undefined 而不会抛，
   * 所以老宿主/非桌面端只是没有返回按钮，不影响整块 client 加载。
   * 故意不写进 `inject` —— 依赖缺失会让 apply 整个不跑。
   */
  const backToConversation = (): void => {
    try {
      const layout = ctx.get('layout') as { selectPanel?: (id: string | null) => void } | undefined
      layout?.selectPanel?.(null) // null = 回到对话，且不切换当前 Session
    } catch (error: unknown) {
      console.error('[dsh-codearts] failed to switch back to conversation:', error)
    }
  }

  try {
    const namespace = 'settings.codearts'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-codearts: settings copy')
    const t = ctx.locale.bind(namespace) as CodeArtsPluginCardInjected['t']

    /**
     * 打开「设置 → CodeArts」。
     *
     * 宿主没有直白的「打开某节设置」服务，走设置壳公开挂在 `sidebar.settings`
     * 槽位上的 store seat（见 settings-route.ts 的说明）。点按钮时现取，不缓存：
     * 那个槽位属于另一个 bundle，apply 顺序不是我们能假定的。
     */
    const openSettings = (): boolean => openPluginSettings({
      slots: ctx.slots as unknown as { entries?: (key: string) => readonly unknown[] },
      shortcuts: ctx.get('shortcuts') as { invoke?: (id: string, context?: unknown) => void } | undefined,
      sectionId: PANEL_ID,
      label: () => t('tabLabel'),
    })

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
      inject: () => ({ t, zone: 'bar' as const, onOpenSettings: openSettings }),
    }, CodeArtsCreditDock))

    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'codearts-credits',
      order: 20,
      locale: namespace,
      inject: () => ({ t, zone: 'dock' as const, onOpenSettings: openSettings }),
    }, CodeArtsCreditDock))

    // 侧边栏入口：一排图标里的一个按钮（sidebar.panellist），配一页中间列面板
    // （main，key 与上面的 id 同名）。
    //
    // 默认**不注册**，用户在我们卡片的「显示」页勾上才出现。这一点不能偷懒成
    // 「注册了但渲染 null」：宿主是按注册条目本身画导航行的，渲染 null 只会留下
    // 一个空白可点的按钮。所以这里是一个 sync 控制器：先拆后建、按开关决定建不建。
    //
    // 两个槽位都由宿主声明 —— 老宿主 / 非桌面端可能压根没有，所以每个 inject
    // 回调自己 try/catch：回调是延后执行的（槽位声明后才跑），从 renderer 的
    // changed() 里冒出来的错会变成首屏渲染错误横幅，外层 catch 抓不到。
    /** 每次 claim 拿到的 inject disposer；拆的时候逐个调用（连带注销里面的注册）。 */
    const panelClaims: Array<() => void> = []

    const dropPanelSlots = (): void => {
      for (const dispose of panelClaims.splice(0)) {
        try {
          dispose()
        } catch (error: unknown) {
          console.error('[dsh-codearts] failed to release sidebar panel:', error)
        }
      }
    }

    const syncPanelRegistration = (): void => {
      // 先拆：同一个 id / key 不能同时注册两份，第二次注册会被宿主直接拒。
      dropPanelSlots()
      if (!sidebarPanelWanted()) return
      try {
        panelClaims.push(ctx.slots.inject('sidebar.panellist', () => {
          try {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              // 排在宿主自带那几行附近、dsh-connect-trae（order 2）后面。
              order: 50,
              label: () => t('tabLabel'),
              locale: namespace,
            }, CodeArtsPanelIcon)
          } catch (error: unknown) {
            console.error('[dsh-codearts] sidebar panel entry unavailable:', error)
            return () => {}
          }
        }))
      } catch (error: unknown) {
        console.error('[dsh-codearts] sidebar panel slot unavailable:', error)
      }
      try {
        panelClaims.push(ctx.slots.inject('main', () => {
          try {
            return ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: namespace,
              inject: () => ({ t, backToConversation }),
            }, CodeArtsPanelPage)
          } catch (error: unknown) {
            console.error('[dsh-codearts] main panel page unavailable:', error)
            return () => {}
          }
        }))
      } catch (error: unknown) {
        console.error('[dsh-codearts] main panel slot unavailable:', error)
      }
    }

    /**
     * 开关关掉时如果用户正站在那一页上，先回对话 —— 否则中间列会留在
     * 一个已经没了的 key 上。软取 layout：没有这个服务就跳过。
     */
    const leavePanelIfActive = (): void => {
      try {
        const layout = ctx.get('layout') as {
          selectPanel?: (id: string | null) => void
          panelInfo?: { getSnapshot?: () => { activePanelId?: string | null } }
        } | undefined
        if (layout?.panelInfo?.getSnapshot?.()?.activePanelId === PANEL_ID) layout.selectPanel?.(null)
      } catch {
        // layout 不在（非桌面端）就没有「当前面板」这回事。
      }
    }

    // 订阅 + 首次同步都放进一个 effect：卸载时取消订阅并拆掉注册。
    ctx.effect(() => {
      const off = subscribeSidebarPanelWanted(() => {
        if (!sidebarPanelWanted()) leavePanelIfActive()
        syncPanelRegistration()
      })
      syncPanelRegistration()
      return () => {
        off()
        dropPanelSlots()
      }
    }, 'dsh-codearts: sidebar panel opt-in')

    /**
     * 设置左侧导航里的入口（settings.section）。
     *
     * 和侧边栏那格一样按「注册 / 拆注册」实现：宿主是按槽位条目画导航行的，
     * 渲染 null 只会留下一个空白可点的行。缺省开 —— 这是用户找插件的主路径
     * （issue #7），只有明确关掉才拆。
     */
    const settingsEntryClaims: Array<() => void> = []

    const dropSettingsEntry = (): void => {
      for (const dispose of settingsEntryClaims.splice(0)) {
        try {
          dispose()
        } catch (error: unknown) {
          console.error('[dsh-codearts] failed to release settings entry:', error)
        }
      }
    }

    const syncSettingsEntry = (): void => {
      dropSettingsEntry()
      if (!settingsEntryWanted()) return
      try {
        settingsEntryClaims.push(ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              id: PANEL_ID,
              // 排在宿主自带那几节（通用设置 / 模型 / 内置插件 …）之后、
              // 其他插件入口附近，不抢前几格。
              order: 50,
              label: () => t('tabLabel'),
              locale: namespace,
              inject: () => ({ t }),
            }, CodeArtsPluginCard)
          } catch (error: unknown) {
            console.error('[dsh-codearts] settings entry unavailable:', error)
            return () => {}
          }
        }))
      } catch (error: unknown) {
        console.error('[dsh-codearts] settings section slot unavailable:', error)
      }
    }

    ctx.effect(() => {
      const off = subscribeSettingsEntryWanted(syncSettingsEntry)
      syncSettingsEntry()
      return () => {
        off()
        dropSettingsEntry()
      }
    }, 'dsh-codearts: settings entry opt-out')

    /**
     * 共享的 dock 状态一变，两个入口的注册/拆注册跟着走。
     *
     * 以前只有「卡片挂载时」才把开关值写进 panel-switch；如果另一张卡片或 60 秒
     * 轮询先拿到新值，就会出现「卡片上勾着、导航里却没有入口」（实测）。
     */
    ctx.effect(() => {
      const apply = (): void => {
        const { dock, loaded } = dockSnapshot()
        if (!loaded) return
        setSettingsEntryWanted(dock.settingsEntry !== false)
        setSidebarPanelWanted(dock.sidebar === true)
      }
      const off = subscribeDock(apply)
      apply()
      return off
    }, 'dsh-codearts: entry switches follow dock state')

    // 开关存在插件设置里，刷新页面后浏览器侧没有记忆，所以开局问一次状态接口。
    // 失败静默：侧边栏保持关闭（缺省），设置入口保持显示（缺省）。
    void (async () => {
      try {
        const res = await fetch('/api/codearts/dock', { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as { dock?: { sidebar?: boolean; settingsEntry?: boolean } }
        setSidebarPanelWanted(data.dock?.sidebar === true)
        // 老后端没有这个字段：缺省仍是「显示」，别因为读不到就把它拆了。
        setSettingsEntryWanted(data.dock?.settingsEntry !== false)
      } catch {
        // 老后端没这条路由：保持两个缺省。
      }
    })()
  } catch (error: unknown) {
    console.error('[dsh-codearts] client card failed to load (host provider unaffected):', error)
  }
}
