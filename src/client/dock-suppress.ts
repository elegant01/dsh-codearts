/**
 * 选中我们的模型时，把对话底部那一行里**别人**的条目暂时压掉。
 *
 * 别人注册什么我们管不了 —— `conversation.composer.dock` 是 list 槽位，每条注册由
 * 宿主平铺成同一个 `[data-composer-dock]` 行里的一个直接子节点。所以我们能做的是：
 * 在自己这条的 effect 里认出兄弟节点、给它们打个属性，再用一条我们注入的 CSS 隐藏。
 * 切走或卸载时逐个摘掉属性，绝不留下别人的行永久消失。
 *
 * 不碰的：宿主自己的轮次/token 统计 pill（带 `data-composer-stat`），以及上下文占用
 * 那一格 —— 那些不是「别人的 provider 行」，压掉就是抢宿主的 UI。
 *
 * 这里刻意不写 `instanceof HTMLElement`：结构够了就能用，逻辑也就能在没装 jsdom 的
 * 测试环境里用假节点跑（见 test/dock-suppress.spec.ts）。
 */

/** 标记属性：带上它的节点被我们隐藏。 */
export const SUPPRESS_ATTR = 'data-codearts-dock-suppressed'
/** 注入的那条样式表 id。 */
export const SUPPRESS_STYLE_ID = 'dsh-codearts-dock-suppress'

/** 扫描时需要的最小结构 —— `Element` 天然满足。 */
export interface DockNode {
  readonly children: ArrayLike<DockNode>
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
  querySelector(selector: string): DockNode | null
  /** 真 DOM 有；假节点按需实现。缺了就当「不包含」，扫描照常进行。 */
  contains?(other: DockNode): boolean
}

/**
 * 这个兄弟节点该不该被压掉。
 *
 * 该压：别人的一条注册（既不是我们自己，也不包含我们，也不是宿主统计 pill）。
 * 不该压：我们自己、我们自己的子孙（有些宿主会包一层）、宿主的统计 pill。
 */
export function isForeignDockEntry(node: DockNode, self: DockNode): boolean {
  if (node === self) return false
  // 宿主可能把条目包在 display:contents 的锚点里，我们自己的祖先链不能压。
  if (node.contains?.(self) === true) return false
  if (node.hasAttribute('data-composer-stat')) return false
  if (node.querySelector('[data-composer-stat]') !== null) return false
  return true
}

/**
 * 扫一遍并给新发现的「别人」打标记。返回**这次**新标记的节点，调用方负责在清理时
 * 逐个摘掉（只摘自己打的那批，别动别人的状态）。
 */
export function markForeignDockEntries(parent: DockNode, self: DockNode): DockNode[] {
  const marked: DockNode[] = []
  for (const child of Array.from(parent.children)) {
    if (!isForeignDockEntry(child, self)) continue
    if (child.getAttribute(SUPPRESS_ATTR) === '') continue
    child.setAttribute(SUPPRESS_ATTR, '')
    marked.push(child)
  }
  return marked
}

/** 摘掉标记 —— 切走 provider 或组件卸载时调用。 */
export function releaseDockEntries(nodes: Iterable<DockNode>): void {
  for (const node of nodes) node.removeAttribute(SUPPRESS_ATTR)
}

/** 注入一次隐藏规则；重复调用无副作用。没有 document 的环境（SSR/测试）直接跳过。 */
export function ensureSuppressStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(SUPPRESS_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = SUPPRESS_STYLE_ID
  style.textContent = `[${SUPPRESS_ATTR}]{display:none!important}`
  document.head.appendChild(style)
}
