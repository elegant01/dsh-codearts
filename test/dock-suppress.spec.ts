import { describe, expect, it } from 'vitest'
import {
  SUPPRESS_ATTR,
  isForeignDockEntry,
  markForeignDockEntries,
  releaseDockEntries,
  type DockNode,
} from '../src/client/dock-suppress.ts'

/**
 * 最小假节点：只实现 dock-suppress 用到的那几个方法。
 *
 * 不引 jsdom 是有意的 —— 这段逻辑只关心「谁的、是不是宿主的统计 pill」，
 * 用假节点就能把边界钉死；真 DOM 的形状由宿主保证（list 槽位平铺）。
 */
class FakeNode implements DockNode {
  readonly attributes = new Map<string, string>()
  readonly children: FakeNode[] = []
  parent: FakeNode | null = null
  /** 供 querySelector('[data-composer-stat]') 用：命中的兄弟统计 pill 名字。 */
  statInside: string | null = null

  constructor(readonly name: string) {}

  append(...nodes: FakeNode[]): this {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
    return this
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  querySelector(selector: string): DockNode | null {
    if (selector !== '[data-composer-stat]') throw new Error(`unexpected selector ${selector}`)
    return this.statInside === null ? null : new FakeNode(this.statInside)
  }

  contains(other: unknown): boolean {
    for (const child of this.children) {
      if (child === other || child.contains(other)) return true
    }
    return false
  }
}

/** 宿主那一行：锚点 + 我们 + 邻居 + 宿主的统计 pill。 */
function buildRow() {
  const row = new FakeNode('dock-row')
  const slot = new FakeNode('slot-anchor')
  const ours = new FakeNode('codearts')
  const neighbour = new FakeNode('neighbour-provider-line')
  const activityPill = new FakeNode('host-activity-pill')
  activityPill.setAttribute('data-composer-stat', 'activity')
  const usagePill = new FakeNode('host-usage-pill')
  usagePill.setAttribute('data-composer-stat', 'usage')
  // 宿主有时把统计 pill 再包一层，外层没有属性 —— 里面那颗 pill 是判据。
  const wrapped = new FakeNode('host-wrapper')
  const inner = new FakeNode('wrapped-usage-pill')
  inner.setAttribute('data-composer-stat', 'usage')
  wrapped.append(inner)
  wrapped.statInside = 'data-composer-stat'
  slot.append(ours, neighbour, activityPill, usagePill, wrapped)
  row.append(slot)
  return { row, slot, ours, neighbour, activityPill, usagePill, wrapped }
}

describe('composer dock 的同级压制', () => {
  it('只压别人的 provider 行', () => {
    const { slot, ours, neighbour } = buildRow()
    const marked = markForeignDockEntries(slot, ours)
    expect(marked).toEqual([neighbour])
    expect(neighbour.getAttribute(SUPPRESS_ATTR)).toBe('')
    expect(ours.getAttribute(SUPPRESS_ATTR)).toBeNull()
  })

  it('宿主的统计 pill 一律不碰（直接挂属性和包了一层都算）', () => {
    const { slot, ours, activityPill, usagePill, wrapped } = buildRow()
    markForeignDockEntries(slot, ours)
    for (const pill of [activityPill, usagePill, wrapped]) {
      expect(pill.getAttribute(SUPPRESS_ATTR)).toBeNull()
    }
  })

  it('重复扫描不会把已标记的再算一遍', () => {
    const { slot, ours, neighbour } = buildRow()
    expect(markForeignDockEntries(slot, ours)).toEqual([neighbour])
    expect(markForeignDockEntries(slot, ours)).toEqual([])
  })

  it('邻居晚挂载时，下一次扫描能补上', () => {
    const { slot, ours } = buildRow()
    markForeignDockEntries(slot, ours)
    const late = new FakeNode('late-neighbour')
    slot.append(late)
    expect(markForeignDockEntries(slot, ours)).toEqual([late])
    expect(late.getAttribute(SUPPRESS_ATTR)).toBe('')
  })

  it('切走时摘干净，别人那一行回来', () => {
    const { slot, ours, neighbour } = buildRow()
    const marked = markForeignDockEntries(slot, ours)
    releaseDockEntries(marked)
    expect(neighbour.getAttribute(SUPPRESS_ATTR)).toBeNull()
    // 再扫一遍能重新认出来（说明属性没留成既成事实）。
    expect(markForeignDockEntries(slot, ours)).toEqual([neighbour])
  })

  it('把自己和包含自己的祖先排除掉（宿主可能包一层 display:contents）', () => {
    const { slot, ours, neighbour } = buildRow()
    expect(isForeignDockEntry(ours, ours)).toBe(false)
    expect(isForeignDockEntry(neighbour, ours)).toBe(true)
    // 包着我们自己的那层不能压，否则等于自杀。
    const wrapper = new FakeNode('wrapper')
    wrapper.append(ours)
    slot.append(wrapper)
    expect(isForeignDockEntry(wrapper, ours)).toBe(false)
  })
})
