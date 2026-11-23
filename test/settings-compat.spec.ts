import { describe, expect, it, vi } from 'vitest'
import { writeSettingsDictKey } from '../src/settings-compat.ts'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

const ns = 'llm-codearts' as unknown as SettingsNamespace

/**
 * issue #17 缺陷②：清除覆盖走 `settings.update`（深合并）删不掉配置键 ——
 * 表里没有的键原样保留，重启后覆盖照常生效。必须走 `mutate` + `unset`。
 */
describe('writeSettingsDictKey', () => {
  it('uses mutate + unset so the key actually disappears', async () => {
    const mutate = vi.fn(async () => {})
    const update = vi.fn(async () => {})
    await writeSettingsDictKey({ mutate, update }, ns, 'contextWindowOverrides', ['glm-5.2'])

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(ns, [
      { op: 'unset', path: ['contextWindowOverrides', 'glm-5.2'] },
    ])
    // 走 mutate 时不能再顺手 update 一份整表：那是另一个写，且删不掉键。
    expect(update).not.toHaveBeenCalled()
  })

  it('unsets a duplicate spelling and sets the new key in one call', async () => {
    const mutate = vi.fn(async () => {})
    const update = vi.fn(async () => {})
    await writeSettingsDictKey({ mutate, update }, ns, 'maxTokensOverrides', ['glm-5.2'], {
      key: 'GLM-5.2',
      value: 131_072,
    })

    expect(mutate).toHaveBeenCalledWith(ns, [
      { op: 'unset', path: ['maxTokensOverrides', 'glm-5.2'] },
      { op: 'set', path: ['maxTokensOverrides', 'GLM-5.2'], value: 131_072 },
    ])
  })

  it('does nothing when there is nothing to remove and nothing to set', async () => {
    const mutate = vi.fn(async () => {})
    const update = vi.fn(async () => {})
    await writeSettingsDictKey({ mutate, update }, ns, 'contextWindowOverrides', [])
    expect(mutate).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  // 老宿主没有 mutate：至少把新值写进去，行为与 1.4.8 相同（删不掉键）。
  it('falls back to update on hosts that predate mutate', async () => {
    const update = vi.fn(async () => {})
    await writeSettingsDictKey({ update }, ns, 'contextWindowOverrides', ['glm-5.2'], {
      key: 'GLM-5.2',
      value: 500_000,
    })
    expect(update).toHaveBeenCalledWith(ns, { contextWindowOverrides: { 'GLM-5.2': 500_000 } })
  })
})
