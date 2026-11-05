/**
 * 「要不要在 DSH 侧边栏占一格」这个偏好，浏览器侧的单一真相。
 *
 * 为什么不靠组件返回 null 来隐藏：宿主是按**槽位里的注册条目**（entry metadata）
 * 画侧边栏导航行的 —— 只要注册还在，那一行就在；渲染函数 return null 只会留下一个
 * 「空白但可点」的按钮。所以开关必须落到「注册 / 不注册」上，这里只存那个意图，
 * 真正的注册动作由 index.tsx 的 sync 控制器按它做。
 *
 * 默认 **false**：读不到配置时必须当作关闭。侧边栏那一格是所有插件共用的全局座位，
 * 猜错的代价比「少一个入口」大得多（用户还能从「设置 → 插件」进同一张卡片）。
 */

let wanted = false

/** 当前是否要显示侧边栏入口。 */
export function sidebarPanelWanted(): boolean {
  return wanted
}

const listeners = new Set<() => void>()

/**
 * 改开关。值没变就直接返回 —— 调用方会在每次刷新状态时调用它，
 * 无变化的重注册会让侧边栏闪一下。
 */
export function setSidebarPanelWanted(next: boolean): void {
  if (wanted === next) return
  wanted = next
  // 逐个 try：一个订阅者抛错不该把别的订阅者（以及这次状态更新）一起带走。
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error: unknown) {
      console.error('[dsh-codearts] sidebar panel listener failed:', error)
    }
  }
}

/** 订阅开关变化，返回取消订阅函数。 */
export function subscribeSidebarPanelWanted(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
