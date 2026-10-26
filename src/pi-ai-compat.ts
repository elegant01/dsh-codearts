/**
 * `@earendil-works/pi-ai` 运行时自检。
 *
 * 本插件编译时对齐的是 1.3.0，而宿主（`dsh-llm-pi-ai` 0.2.1-rc.2 起）会先把系统提示
 * 折叠成一条 `role:"system"`、`content` 为**字符串**的消息，再交给 provider。1.3.0 之前
 * 的 `estimateMessageTokens` 没有 system 分支：字符串内容被按字符遍历，每个"块"是单个
 * 字符，`block.name` 为 undefined，于是每条消息都死在
 * `Cannot read properties of undefined (reading 'length')` 上 —— 而且是在出网之前，
 * 用户只看得到一句「本轮运行失败」。
 *
 * 什么时候会拿到旧的那份：profile 顶层被别的插件 hoist 了一个低版本，而本插件的依赖
 * 没落地到自己的 `node_modules`。1.1.3 起 `@earendil-works/pi-ai` 已从 peerDependencies
 * 移进 dependencies，区间真正生效；这里再探测一次，把「版本不兼容」明说，而不是让
 * 每条消息各自崩在一个看不懂的 TypeError 上。
 *
 * 探测用能力而不是版本号：不依赖 package.json 能不能读到，也对未来的版本漂移免疫。
 *
 * @module dsh-codearts/pi-ai-compat
 */

/** 折叠后的系统消息要能被估token；从这一版起才支持。 */
export const MIN_PI_AI_VERSION = '1.3.0'

let probe: Promise<string | undefined> | undefined

/** 不兼容时的说明；兼容时 undefined。结果只算一次（模块加载后版本不会再变）。 */
export function probePiAiCompat(): Promise<string | undefined> {
  probe ??= runProbe()
  return probe
}

/** 只给测试用：清掉缓存，让下一次探测重新跑。 */
export function resetPiAiCompatProbe(): void {
  probe = undefined
}

async function runProbe(): Promise<string | undefined> {
  const hint = `需要 @earendil-works/pi-ai >= ${MIN_PI_AI_VERSION}，请重装 dsh-codearts（1.1.3 起它自带这份依赖），`
    + '或把 profile 顶层那份升级到同一区间'
  let estimate: ((message: never) => number) | undefined
  try {
    ;({ estimateMessageTokens: estimate } = await import('@earendil-works/pi-ai/utils/estimate'))
  } catch (error: unknown) {
    return `pi-ai 不兼容：读不到 @earendil-works/pi-ai/utils/estimate（${messageOf(error)}）。${hint}`
  }
  if (typeof estimate !== 'function') {
    return `pi-ai 不兼容：这份 @earendil-works/pi-ai 没有 estimateMessageTokens。${hint}`
  }
  try {
    // 宿主真实交给 provider 的形状：content 是字符串，没有 toolsAdded/toolsRemoved。
    estimate({ role: 'system', content: 'probe' } as never)
  } catch (error: unknown) {
    return `pi-ai 不兼容：这份 @earendil-works/pi-ai 处理不了宿主折叠出的 system 消息（${messageOf(error)}），`
      + `每条请求都会在出网前失败。${hint}`
  }
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
