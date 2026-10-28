import { describe, expect, it } from 'vitest'
import { buildDockLine, DOCK_SEGMENT_SEPARATOR, type DockLine } from '../src/client/dock-line.ts'
import { en, zh } from '../src/client/locales.ts'

/**
 * 用**真实的**文案表拼，而不是在测试里再抄一份格式：抄一份的话，文案改了测试还是绿的，
 * 那就白测了。缺键直接抛错，顺带守住「新增段必须补文案」。
 */
function translator(table: Record<string, string | undefined>) {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = table[key]
    if (template === undefined) throw new Error(`missing copy for '${key}'`)
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
  }
}

const t = translator(zh as unknown as Record<string, string>)

/**
 * 组件里的渲染顺序：积分段（按钮）+ 分隔符 + 其余段（纯文本）。
 * 这里复现它，好断言「看得见的那一整行」长什么样。
 */
function visibleLine(line: DockLine): string {
  return line.credits === undefined
    ? line.rest
    : `${line.credits}${DOCK_SEGMENT_SEPARATOR}${line.rest}`
}

describe('对话底部那一行的分段', () => {
  it('积分在最前，然后是 provider、模型、倍率 —— 与 codebuddy 的底栏同构', () => {
    const line = buildDockLine({
      credits: t('creditsDock', { remain: '24,091' }),
      provider: 'CodeArts',
      model: 'DeepSeek-V4.1-Flash-1017',
      ratio: 'x0.18',
    }, t)
    expect(line.credits).toBe('积分 24,091')
    expect(line.rest).toBe('Provider CodeArts · Model DeepSeek-V4.1-Flash-1017 · x0.18')
    expect(visibleLine(line)).toBe('积分 24,091 · Provider CodeArts · Model DeepSeek-V4.1-Flash-1017 · x0.18')
  })

  // 这一条是行为约束：底部那一行只有积分段可点（点开逐号明细），其余是纯文本。
  // 积分段被单独返回，就是为了让组件没法把整行包成按钮。
  it('积分段单独返回，其余各段拼成一串 —— 组件只把积分那段做成按钮', () => {
    const line = buildDockLine({
      credits: t('creditsDock', { remain: '1' }),
      provider: 'CodeArts',
      model: 'GLM-5.3',
      ratio: 'x0.79',
    }, t)
    expect(line.credits).toBe('积分 1')
    // 其余段里绝不能混进积分文案 —— 否则「哪段能点」就分不开了。
    expect(line.rest.startsWith('Provider')).toBe(true)
    expect(line.rest.includes('积分')).toBe(false)
  })

  it('倍率缺席的模型不臆造倍率（Qwen3-VL 这类上游没给 credit）', () => {
    expect(buildDockLine({ provider: 'CodeArts', model: 'Qwen3-VL-235B' }, t))
      .toEqual({ rest: 'Provider CodeArts · Model Qwen3-VL-235B' })
  })

  it('积分关掉时，身份段仍然在，且整行不留前导分隔符', () => {
    const line = buildDockLine({ provider: 'CodeArts', model: 'GLM-5.3', ratio: 'x0.79' }, t)
    expect(line.credits).toBeUndefined()
    expect(visibleLine(line)).toBe('Provider CodeArts · Model GLM-5.3 · x0.79')
    expect(visibleLine(line).startsWith(DOCK_SEGMENT_SEPARATOR)).toBe(false)
  })

  it('没选模型时印「未选择模型」，而不是空一段', () => {
    expect(visibleLine(buildDockLine({ provider: 'CodeArts' }, t))).toBe('Provider CodeArts · 未选择模型')
  })

  it('排队段排在最后', () => {
    expect(visibleLine(buildDockLine({
      credits: t('creditsDock', { remain: '1,000' }),
      provider: 'CodeArts',
      model: 'GLM-5.3',
      ratio: 'x0.79',
      queue: t('queueDock', { position: 3 }),
    }, t))).toBe('积分 1,000 · Provider CodeArts · Model GLM-5.3 · x0.79 · 排队第 3 位')
  })

  it('英文表也能拼出同一套段序（只有积分与排队的措辞不同）', () => {
    const ten = translator(en as unknown as Record<string, string>)
    expect(visibleLine(buildDockLine({
      credits: ten('creditsDock', { remain: '24,091' }),
      provider: 'CodeArts',
      model: 'GLM-5.3',
      ratio: 'x0.79',
    }, ten))).toBe('Credits 24,091 · Provider CodeArts · Model GLM-5.3 · x0.79')
  })

  it('段分隔符就是邻居插件用的那一个', () => {
    expect(DOCK_SEGMENT_SEPARATOR).toBe(' · ')
  })
})