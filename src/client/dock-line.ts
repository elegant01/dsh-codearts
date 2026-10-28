/**
 * 对话底部那一行的分段拼装。
 *
 * 与 `dsh-codebuddy-cli` 的底栏同构：积分在最前，然后是 provider、模型、倍率，
 * 最后是本插件的排队段，段与段之间用 ` · ` 连接成**一个文本节点**
 * （`积分 24,091 · Provider CodeArts · Model DeepSeek-V4.1-Flash-1017 · x0.18`）。
 * 用连接符而不是 flex gap 是有意的：邻居那一行也是这么拼的，观感才对得上。
 *
 * 为什么积分段要**单独**返回（而不是跟其余各段拼成一串）：底部那一行里只有积分那段
 * 是可点击的（点开逐号明细），模型/倍率那几段是纯文本。所以这里把可点击的那一段与
 * 其余各段分开给出去，组件照着渲染就行 —— 「哪段能点」由触摸得到的结构决定，不是
 * 靠组件里的 if 记住。
 *
 * 抽成纯函数是为了把「段序 / 分隔符 / 哪段可以缺席」钉在一个地方。测试拿真实的 zh 文案
 * 表跑（见 `test/dock-line.spec.ts`），所以改文案或改段序都会红。
 */

/** 一行里各段的取值。省略的字段 = 这一段不出现。 */
export interface DockLineParts {
  /** 已格式化的积分段（`积分 24,091`）；「显示剩余积分」关掉时省略。 */
  credits?: string
  /** 段里出现的 provider 名（`CodeArts`）。 */
  provider: string
  /** 剥掉倍率尾巴的模型名；未选择模型时省略（改印「未选择模型」）。 */
  model?: string
  /** 已格式化的倍率（`x0.18`）；上游没给倍率的模型省略，不臆造。 */
  ratio?: string
  /** 已格式化的排队段；没在排队时省略。 */
  queue?: string
}

/** 拆好的两半：可点击的积分段，以及其余各段拼成的一串（不带前导分隔符）。 */
export interface DockLine {
  credits?: string
  rest: string
}

/** 段分隔符 —— 与邻居插件一致，改这里等于改整行的样子。 */
export const DOCK_SEGMENT_SEPARATOR = ' · '

export function buildDockLine(
  parts: DockLineParts,
  t: (key: string, params?: Record<string, unknown>) => string,
): DockLine {
  const rest: string[] = []
  rest.push(t('dockProvider', { provider: parts.provider }))
  rest.push(parts.model === undefined ? t('dockNoModel') : t('dockModel', { model: parts.model }))
  if (parts.ratio !== undefined) rest.push(parts.ratio)
  if (parts.queue !== undefined) rest.push(parts.queue)
  return {
    ...parts.credits === undefined ? {} : { credits: parts.credits },
    rest: rest.join(DOCK_SEGMENT_SEPARATOR),
  }
}