/**
 * 「要不要在 DSH 里占一个入口」这类偏好的浏览器侧单一真相。
 *
 * 为什么不靠组件返回 null 来隐藏：宿主是按**槽位里的注册条目**（entry metadata）
 * 画导航行的 —— 只要注册还在，那一行就在；渲染函数 return null 只会留下一个
 * 「空白但可点」的按钮。所以开关必须落到「注册 / 不注册」上，这里只存那个意图，
 * 真正的注册动作由 index.tsx 的 sync 控制器按它做。
 *
 * 两个开关的默认值不同，理由也不同：
 * - 侧边栏图标列（`sidebar`）缺省 **关**：那一格是全宿主共用的全局座位，每个插件都
 *   默认占一格很快就会挤满，猜错的代价比「少一个入口」大得多。
 * - 设置左侧导航（`settingsEntry`）缺省 **开**：用户找插件的第一反应就是「设置里
 *   从左列找」，而设置导航本来就是按插件分组的，多一项不会挤占主界面（issue #7）。
 */

export interface WantedSwitch {
  /** 当前是否要显示这个入口。 */
  get(): boolean
  /** 改开关。值没变就直接返回 —— 调用方会频繁同步，无变化的重注册会让导航闪一下。 */
  set(next: boolean): void
  /** 订阅开关变化，返回取消订阅函数。 */
  subscribe(listener: () => void): () => void
}

/** 一个纯内存的布尔开关 + 订阅表；不持久化，真实值来自 `/api/codearts/dock`。 */
export function createWantedSwitch(initial: boolean): WantedSwitch {
  let wanted = initial
  const listeners = new Set<() => void>()
  return {
    get: () => wanted,
    set(next: boolean): void {
      if (wanted === next) return
      wanted = next
      // 逐个 try：一个订阅者抛错不该把别的订阅者（以及这次状态更新）一起带走。
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error: unknown) {
          console.error('[dsh-codearts] entry switch listener failed:', error)
        }
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** 侧边栏图标列里的入口（缺省关）。 */
export const sidebarEntrySwitch = createWantedSwitch(false)

/** 设置左侧导航里的入口（缺省开）。 */
export const settingsEntrySwitch = createWantedSwitch(true)

export const sidebarPanelWanted = sidebarEntrySwitch.get
export const setSidebarPanelWanted = sidebarEntrySwitch.set
export const subscribeSidebarPanelWanted = sidebarEntrySwitch.subscribe

export const settingsEntryWanted = settingsEntrySwitch.get
export const setSettingsEntryWanted = settingsEntrySwitch.set
export const subscribeSettingsEntryWanted = settingsEntrySwitch.subscribe
