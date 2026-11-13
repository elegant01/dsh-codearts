/**
 * 「显示」页那些开关在浏览器侧的共享状态。
 *
 * 为什么需要它：同一张卡片会被挂到三个地方 —— 设置里的 CodeArts 页、侧边栏的整页
 * 面板、插件详情页。每个实例各自 fetch `/api/codearts/dock` 的话，在 A 处改了开关，
 * B 处只要已经挂载过就永远显示旧值（实测：设置页取消「设置左侧导航显示 CodeArts」，
 * 侧边栏那张卡片仍显示勾选）。
 *
 * 所以开关值只存一份：谁 fetch/POST 成功就写进来，所有挂着的实例订阅它。
 * 乐观更新只改调用方自己的局部状态，成功后才 publish —— 别的实例不该看到还没被
 * 服务端确认的值。
 *
 * @module dsh-codearts/client/dock-store
 */

import { DEFAULT_DOCK_FLAGS, type CodeArtsDockFlags } from '../web-status.ts'

export interface DockSnapshot {
  dock: CodeArtsDockFlags
  writable: boolean
  /** 是否至少成功读到过一次服务端值。 */
  loaded: boolean
}

let snapshot: DockSnapshot = { dock: DEFAULT_DOCK_FLAGS, writable: false, loaded: false }
const listeners = new Set<() => void>()

export function dockSnapshot(): DockSnapshot {
  return snapshot
}

/**
 * 写入新值。`patch.dock` 只给变化的键也行：缺省键用 DEFAULT_DOCK_FLAGS 补齐，
 * 老后端少字段时不会把已经打开的开关注销成 undefined。
 */
export function publishDock(patch: { dock?: Partial<CodeArtsDockFlags>; writable?: boolean }): void {
  const dock = patch.dock === undefined ? snapshot.dock : { ...DEFAULT_DOCK_FLAGS, ...patch.dock }
  const writable = patch.writable ?? snapshot.writable
  if (dock === snapshot.dock && writable === snapshot.writable && snapshot.loaded) return
  snapshot = { dock, writable, loaded: true }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error: unknown) {
      console.error('[dsh-codearts] dock-store listener failed:', error)
    }
  }
}

export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
