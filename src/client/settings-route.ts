/**
 * 「打开设置 → CodeArts」这条路的实现。
 *
 * 宿主没有给插件一个直白的「打开某节设置」服务，但设置壳把自己挂在
 * `sidebar.settings` 槽位上，并且带了一个 **store seat**：
 *
 *     const shellHandle = createSettingsShellStore()
 *     const shellInstance = shellHandle.create()
 *     ctx.slots.register({ name: 'sidebar.settings', store: { ...shellHandle, create: () => shellInstance }, … })
 *
 * 这个 seat 是壳公开的状态把手（`StoredEntry.store` 是文档字段，`slots.entries()`
 * 是公开方法；宿主自己的客户端测试也这么读）。`actions.openSection(id)` 一次把
 * `activeId = id` 和 `open = true` 都设上，正好是「在 CodeArts 那一节打开设置」。
 *
 * 旧壳没有 `openSection` 时退回到「打开设置面板 + 点同名导航行」。判断按**逐字**
 * 相等：`模型` 是 `模型与预设` 的子串，模糊匹配会点错节。两条路都不抛异常 ——
 * 调用方是一个按钮的 click handler，抛出去会把整条积分行带没。
 *
 * @module dsh-codearts/client/settings-route
 */

/** 设置壳所在的槽位：它的 store seat 就是对外唯一的状态把手。 */
const SETTINGS_SLOT = 'sidebar.settings'

interface SettingsShellHandle {
  create?: () => {
    actions?: {
      /** 打开设置并选中某一节（本次要用的那条）。 */
      openSection?: (id: string) => void
      /** 只打开设置，不选节（老壳）。 */
      open?: () => void
    }
  } | undefined
}

export interface SettingsRouteDeps {
  /** `ctx.slots`（软取）。 */
  slots?: { entries?: (key: string) => readonly unknown[] }
  /** `ctx.get('shortcuts')`：旧壳兜底用的 `settings.open` 命令。 */
  shortcuts?: { invoke?: (id: string, context?: unknown) => void }
  /** 本插件注册 `settings.section` 时的 id —— 与导航行必须同一个拼写。 */
  sectionId: string
  /** 导航行的本地化文本，仅旧壳兜底路径使用。 */
  label?: () => string
  /** 测试注入。 */
  doc?: Document
  schedule?: (run: () => void, ms: number) => void
}

/** 面板挂载后导航行的标签要等一次 locale 快照，所以重试几次、总共约 300ms。 */
const RETRY_DELAYS_MS = [0, 60, 70, 80, 90]

function defaultSchedule(run: () => void, ms: number): void {
  globalThis.setTimeout(run, ms)
}

function findSectionRow(scope: ParentNode, label: string): HTMLElement | undefined {
  const want = label.trim()
  if (want === '') return undefined
  return Array.from(scope.querySelectorAll<HTMLElement>('button'))
    .find(button => (button.textContent ?? '').trim() === want)
}

/**
 * 打开本插件的设置节。
 *
 * @returns true = 已经走通一条路（设置面板会在我们这一节打开，或至少已打开）。
 */
export function openPluginSettings(deps: SettingsRouteDeps): boolean {
  // 路线 1：壳的 store seat，一次调用、精确选中，没有时序问题。
  try {
    const entries = deps.slots?.entries?.(SETTINGS_SLOT) as readonly { store?: SettingsShellHandle }[] | undefined
    const instance = entries?.[0]?.store?.create?.()
    const openSection = instance?.actions?.openSection
    if (typeof openSection === 'function') {
      openSection(deps.sectionId)
      return true
    }
  } catch {
    // 换下一条路。
  }

  // 路线 2（老壳）：用 settings.open 命令打开面板，再点同名导航行。
  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document)
  const label = deps.label?.() ?? ''
  try {
    const invoke = deps.shortcuts?.invoke
    if (typeof invoke === 'function') invoke('settings.open', { modal: null })
    else return false
  } catch {
    return false
  }
  if (doc === undefined || label.trim() === '') return true
  const schedule = deps.schedule ?? defaultSchedule
  const scopeOf = (): ParentNode => doc.querySelector('[data-shortcut-modal="settings"]') ?? doc
  let clicked = false
  for (const delay of RETRY_DELAYS_MS) {
    schedule(() => {
      if (clicked) return
      try {
        const row = findSectionRow(scopeOf(), label)
        if (row !== undefined) {
          clicked = true
          row.click()
        }
      } catch {
        // 找不到就等下一次重试。
      }
    }, delay)
  }
  return true
}
