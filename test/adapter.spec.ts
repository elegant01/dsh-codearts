import { describe, expect, it } from 'vitest'
import { createCodeArtsAdapter } from '../src/adapter.ts'
import { CodeArtsCatalog, type CodeArtsModelInfo } from '../src/catalog.ts'

const model = (id: string, patch: Partial<CodeArtsModelInfo> = {}): CodeArtsModelInfo => ({
  id,
  name: id,
  contextWindow: 202_752,
  maxTokens: 65_536,
  supportsImages: false,
  ...patch,
})

function adapterFor(models: CodeArtsModelInfo[]) {
  const catalog = new CodeArtsCatalog()
  catalog.set(models)
  const shim = {
    ready: Promise.resolve(),
    baseUrl: () => 'http://127.0.0.1:1',
    token: () => 'shim-secret',
    close: async () => {},
  }
  return createCodeArtsAdapter({ shim, catalog, resolveAttachments: undefined }).adapter
}

describe('codearts adapter reasoning', () => {
  // 宿主选择器只认 efforts：上游声明什么就只露什么，别把 off/low 这些没声明的档位
  // 摆出来让用户选，也别给没有档位的模型硬加一个选择器。
  it('surfaces only the thinking strengths upstream declared', async () => {
    const adapter = adapterFor([
      model('GLM-5.2', { thinking: { strengths: ['high', 'max'], default: 'high' } }),
      model('Qwen3-VL-235B'),
    ])
    // listModels 只给基础信息；推理档位在 resolveModel 里（宿主选模型时读这份）。
    const glm = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(glm.reasoning?.efforts.map(effort => effort.id)).toEqual(['high', 'max'])
    const qwen = await adapter.resolveModel('codearts', 'Qwen3-VL-235B')
    expect(qwen.reasoning).toBeUndefined()
  })
})
