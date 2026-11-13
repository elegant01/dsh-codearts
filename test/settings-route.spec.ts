import { describe, expect, it, vi } from 'vitest'
import { openPluginSettings } from '../src/client/settings-route.ts'

/** 设置壳那类槽位条目：只有 store.create() 有用。 */
function slotsWithSeat(handle: unknown): { entries: (key: string) => readonly unknown[] } {
  return {
    entries: (key: string) => (key === 'sidebar.settings' ? [{ store: handle }] : []),
  }
}

describe('openPluginSettings', () => {
  // 设置壳把 openSection 挂在 sidebar.settings 的 store seat 上：一次调用就能
  // 「打开设置并选中 CodeArts 那一节」，这是主路径（dsh-connect-trae 同款）。
  it('opens the settings dialog on our section through the shell store seat', () => {
    const openSection = vi.fn()
    const result = openPluginSettings({
      slots: slotsWithSeat({ create: () => ({ actions: { openSection, open: vi.fn() } }) }),
      sectionId: 'dsh-codearts',
    })
    expect(result).toBe(true)
    expect(openSection).toHaveBeenCalledWith('dsh-codearts')
  })

  // 老壳只有 open()：退回到 settings.open 命令打开面板，再靠导航行兜底。
  it('falls back to the settings.open command when the seat has no openSection', () => {
    const invoke = vi.fn()
    const result = openPluginSettings({
      slots: slotsWithSeat({ create: () => ({ actions: { open: vi.fn() } }) }),
      shortcuts: { invoke },
      sectionId: 'dsh-codearts',
      // 不给 label：只验证命令被调用，不触发 DOM 点击。
      label: () => '',
    })
    expect(result).toBe(true)
    expect(invoke).toHaveBeenCalledWith('settings.open', { modal: null })
  })

  it('returns false when neither the seat nor the command exists', () => {
    expect(openPluginSettings({ slots: undefined, sectionId: 'dsh-codearts' })).toBe(false)
    expect(openPluginSettings({ slots: { entries: () => [] }, sectionId: 'dsh-codearts' })).toBe(false)
  })

  // 别的 bundle 的行为不能把按钮变成异常：seat 自己炸了也要退回命令路径。
  it('survives a throwing store seat', () => {
    const invoke = vi.fn()
    const result = openPluginSettings({
      slots: slotsWithSeat({ create: () => { throw new Error('boom') } }),
      shortcuts: { invoke },
      sectionId: 'dsh-codearts',
      label: () => '',
    })
    expect(result).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
