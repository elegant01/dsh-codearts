import { describe, expect, it } from 'vitest'
import { dockSnapshot, publishDock, subscribeDock } from '../src/client/dock-store.ts'

// 模块级单例，没有重置入口：把断言串成一条时间线，顺序就是真实使用顺序。
describe('dock store', () => {
  it('shares dock flags between card instances and fills missing keys', () => {
    // 初始：还没读到服务端值，用缺省值。
    expect(dockSnapshot().loaded).toBe(false)
    expect(dockSnapshot().dock.credits).toBe(true)

    const seen: boolean[] = []
    const off = subscribeDock(() => seen.push(dockSnapshot().dock.settingsEntry))

    // 老后端少字段：缺的键必须补缺省，而不是变 undefined。
    publishDock({ dock: { credits: false } })
    expect(dockSnapshot().loaded).toBe(true)
    expect(dockSnapshot().dock.credits).toBe(false)
    expect(dockSnapshot().dock.settingsEntry).toBe(true)

    // 一个实例关掉「设置左侧入口」：另一个实例的订阅立刻收到 false。
    publishDock({ dock: { ...dockSnapshot().dock, settingsEntry: false } })
    expect(seen).toEqual([true, false])

    // writable 可以单独更新，不影响 dock（订阅者会再读一次快照，值不变）。
    publishDock({ writable: true })
    expect(dockSnapshot().writable).toBe(true)
    expect(dockSnapshot().dock.settingsEntry).toBe(false)
    expect(seen).toEqual([true, false, false])

    off()
    publishDock({ dock: { ...dockSnapshot().dock, settingsEntry: true } })
    // 取消订阅后不再收到通知。
    expect(seen).toEqual([true, false, false])
    expect(dockSnapshot().dock.settingsEntry).toBe(true)
  })
})
