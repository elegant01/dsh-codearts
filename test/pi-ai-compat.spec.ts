import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_PI_AI_VERSION, probePiAiCompat, resetPiAiCompatProbe } from '../src/pi-ai-compat.ts'

/**
 * Regression guard for issue #2 (GitHub) 的第二条：profile 顶层被别的插件 hoist 了一个
 * 低版本 `@earendil-works/pi-ai` 时，本插件的 import 会落到那份上，而它不认识宿主折叠
 * 出来的 `role:"system"` 消息 —— 每条消息都在出网前抛
 * `Cannot read properties of undefined (reading 'length')`。
 */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

afterEach(() => {
  resetPiAiCompatProbe()
  vi.doUnmock('@earendil-works/pi-ai/utils/estimate')
  vi.unstubAllGlobals()
})

describe('pi-ai packaging', () => {
  // 只写 peerDependencies 的话，npm 装插件时区间不会被强制满足：没有自己的
  // node_modules，ESM 解析直接落到 profile 顶层那份（实测可以是 0.82.1）。
  it('ships pi-ai as a real dependency, not a peer', () => {
    expect(pkg.dependencies?.['@earendil-works/pi-ai']).toMatch(/^\^?\d+\.\d+\.\d+$/)
    expect(pkg.peerDependencies?.['@earendil-works/pi-ai']).toBeUndefined()
  })
})

describe('pi-ai runtime self-check', () => {
  it('accepts the copy this plugin is built against', async () => {
    await expect(probePiAiCompat()).resolves.toBeUndefined()
  })

  it('says which version is required when the resolved copy cannot estimate a system message', async () => {
    resetPiAiCompatProbe()
    vi.doMock('@earendil-works/pi-ai/utils/estimate', () => ({
      // 0.82.1 的行为：没有 system 分支，字符串内容被按字符遍历，读 block.name.length。
      estimateMessageTokens: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')")
      },
    }))

    const message = await probePiAiCompat()

    expect(message).toContain(MIN_PI_AI_VERSION)
    expect(message).toContain("Cannot read properties of undefined (reading 'length')")
    // 探测只跑一次：结果给 logger 和状态接口共用，别每条消息都重新 import。
    await expect(probePiAiCompat()).resolves.toBe(message)
  })

  it('still reports when the estimate module itself is missing', async () => {
    resetPiAiCompatProbe()
    vi.doMock('@earendil-works/pi-ai/utils/estimate', () => ({ other: 1 }))

    const message = await probePiAiCompat()

    expect(message).toContain('pi-ai 不兼容')
    expect(message).toContain(MIN_PI_AI_VERSION)
  })
})
