/**
 * CodeArts 真实聊天协议（翻译自 codearts2api 逆向，consumer 版 cn-north-4）。
 *
 * 聊天走 OpenAI 兼容端点：
 *   POST /api/v2/chat/completions  （snap-access.cn-north-4.myhuaweicloud.com）
 * 鉴权为 x-auth-token = STS security_token，并叠加华为云 AK/SK SDK-HMAC-SHA256
 * 签名（与官方 AgentKernel 一致）。请求体是标准 OpenAI 形状（role/content），
 * 响应 SSE 也是 OpenAI 增量（choices[].delta.content），但含有华为特有事件
 * （累计全文快照 + 结束态 error_code），本模块做兼容转换。
 *
 * @module dsh-codearts/upstream
 */

import { createHash, randomBytes } from 'node:crypto'
import { signRequest, type SignCredential } from './signer.ts'
import {
  fillFromSeed,
  isBenefitModel,
  mergeModelLists,
  type CodeArtsModelInfo,
} from './catalog.ts'

export const SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const EP_CHAT = '/api/v2/chat/completions'
// 限时福利（免费套餐）网关：领取接口（幂等）。对齐 codearts2api 的 BenefitHost/EpBenefitClaim。
const BENEFIT_HOST = 'https://opengw.developer.huaweicloud.com'
const EP_BENEFIT_CLAIM = '/api/v1/benefit/claim'
// 模型清单三路来源（对齐 codearts2api 的 const.go，2026-09 逆向自官方 CodeArts Agent 客户端）。
const EP_MODEL_BUILTIN = '/v1/model/builtin'
const EP_BENEFIT_CONFIG = '/api/v1/gateway/config'
const EP_AGENT_LIST = '/v1/agent-center/agents/useragents'
const EP_AGENT_DETAIL = '/v1/agent-center/agents/detail'
/**
 * 当前登录身份。**必须带 `/snap-manager` 前缀**：2026-09-30 实测
 * `/v1/current/user` 是 APIG.0101（未发布），`/snap-manager/v1/current/user`
 * 才返回 `{user_id, user_name, domain_id}`。codearts2api 的 const.go 里少了这段前缀
 * （它另有 STS 的 `/v5/caller-identity`，但那条对 STS 临时凭证返回 401）。
 */
const EP_CURRENT_USER = '/snap-manager/v1/current/user'

export type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client'

export interface ChatResultOk {
  ok: true
  /** 已转成 OpenAI 增量 SSE 的 ReadableStream（文本，data: ...\n\n）。 */
  stream: ReadableStream<Uint8Array>
}
export interface ChatResultErr {
  ok: false
  kind: UpstreamErrorKind
  status: number
  message: string
}
export type ChatResult = ChatResultOk | ChatResultErr

/** 给 shim 用的凭证（来自 credentialStore.resolve）。 */
export interface CodeArtsResolved {
  token: string
  accessKeyId?: string
  secretAccessKey?: string
  securityToken: string
}

const STATIC_MODEL_MAP: Record<string, string> = {
  'snap-chat': 'GLM-5.2',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-4.7': 'GLM-4.7',
  'openpangu-2.0-pro': 'OpenPangu-2.0-Pro',
  'openpangu-2.0-flash': 'OpenPangu-2.0-Flash',
  'qwen3-vl-235b': 'Qwen3-VL-235B',
  'qwen3.5-397b-a17b-vl': 'Qwen3.5-397B-A17B-VL',
  'qwen3.6-27b-vl': 'Qwen3.6-27B-VL',
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek-v4-pro-0813',
  'glm-5.3-flash': 'glm-5.3-flash',
}

export function canonicalModel(id: string): string {
  const mapped = STATIC_MODEL_MAP[id.toLowerCase()]
  return mapped ?? id
}

function hex32(): string {
  // 32 位 hex = 16 字节
  return randomBytes(16).toString('hex')
}

function randomTraceId(): string {
  return hex32()
}

interface OpenAIMessage {
  role?: string
  content?: unknown
}

/** 上游对 max_tokens 的服务端硬上限（2026-09-30 直连二分实测）。 */
export const MAX_TOKENS_CEILING = 65_536

/** token 估算的余量：混排误差 + 上游自己注入的会话头，宁可少给也别整轮失败。 */
const PROMPT_ESTIMATE_MARGIN = 2_048
/** 短于此的生成长度就没有实际意义了，此时直接报具体错误而不是硬挤。 */
const MIN_USEFUL_OUTPUT_TOKENS = 1_024

/**
 * 实测过的、**按模型**的 max_tokens 上限（小写 id → 上限）。
 *
 * 这个上限是模型相关的，不能用一个全局值：
 *  - 免费（限时福利）DeepSeek 系列：> 65536 会被流内 InferHub.001001005.400
 *    "The request param is invalid" 拒掉，而福利网关标称的是 393216 / 384000；
 *  - GLM-5.2：2026-09-30 逐值直连验证过 8000/65536/131072 均正常，但
 *    **2026-10-10 复测 131072 已经被拒**（同一个 InferHub.001001005.400），
 *    65536 仍然正常。也就是说这条上限由服务端控制、会漂，目录里留着的旧实测值
 *    不会报错，只会让该模型的每一轮在流的第一帧就失败 —— 所以复测要按日期记。
 *
 * 没测过的模型一律退回 `MAX_TOKENS_CEILING`（保守但可用），而不是照抄标称值 ——
 * DSH 会把 catalog 的 maxTokens 原样当 max_tokens 发出去，照抄标称值等于让请求失败。
 * 新增实测结果时往这里加一行即可（scripts/param-probe.mjs 与
 * scripts/probe-models.ts 是得到这些数字的工具）。
 */
const MEASURED_MAX_TOKENS: Readonly<Record<string, number>> = {
  'deepseek-v4-flash-0731': 65_536,
  'deepseek-v4-pro-0813': 65_536,
  'deepseek-v4.1-flash': 65_536,
  'glm-5.3-flash': 65_536,
  'glm-5.2': 65_536,
}

/** 该模型可用的 max_tokens 上限（实测值与会话内学到的更低值取小）。 */
export function maxTokensCeilingFor(id: string): number {
  const measured = measuredCeilingFor(id)
  const learned = learnedMaxTokens.get(ceilingKey(id))
  return learned === undefined ? measured : Math.min(measured, learned)
}

/**
 * 上游的「参数非法」错误码。它是**流内**帧（HTTP 仍是 200），所以既不走
 * classify()，也不会告诉我们是哪个参数错、更不区分「max_tokens 太大」和
 * 「prompt 装不下」—— 一切得我们自己判。
 */
export const PARAM_INVALID_CODE = 'InferHub.001001005.400'

/** 一帧（chatStream 已把上游 error_code 转成 OpenAI error 帧）是不是那条「参数非法」。 */
export function isParamInvalidFrame(text: string): boolean {
  return text.includes(PARAM_INVALID_CODE) || text.includes('The request param is invalid')
}

/**
 * 本次进程内学到的上限（小写 id → 上限）。
 *
 * 上游会把「实测过」的值悄悄调低（GLM-5.2 的 131072 于 2026-10-10 被收），
 * 手工表必然滞后。所以撞到「参数非法」时就地折半降档重试，并把结果记在这里，
 * 免得该模型后面每一轮都先白撞一次。
 */
const learnedMaxTokens = new Map<string, number>()
/** 降档下限：再低就没有可用的生成长度了，此时宁可把具体错误报给用户。 */
const MAX_TOKENS_FLOOR = 8_192

function ceilingKey(id: string): string {
  return id.trim().toLowerCase()
}

function measuredCeilingFor(id: string): number {
  return MEASURED_MAX_TOKENS[ceilingKey(id)] ?? MAX_TOKENS_CEILING
}

/**
 * 把该模型的上限折半降一档（收到「参数非法」后重发之前调用）。
 * @returns 新的上限；已经降到底则返回 0，表示别再试了。
 */
export function degradeTokenCeiling(id: string): number {
  const next = Math.floor(maxTokensCeilingFor(id) / 2)
  if (next < MAX_TOKENS_FLOOR) return 0
  learnedMaxTokens.set(ceilingKey(id), next)
  return next
}

/** 清空降档记忆。进程内状态，测试之间必须能重置。 */
export function resetTokenCeilings(): void {
  learnedMaxTokens.clear()
}

/**
 * 粗估一段文本占多少 token：CJK 每字约 1，其余每 4 字符约 1。
 *
 * 只要保守就够用 —— 它的用途是「在我们这边就把装不下的情况判掉」，
 * 而不是精确计费（上游不会告诉我们超没超，只会回一句参数非法）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // 假名到汉字（含扩展 A）/ 谚文与 CJK 兼容符号 / 全宽标点
    if ((code >= 0x3040 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xfbff) || (code >= 0xff00 && code <= 0xff60)) {
      cjk += 1
    }
  }
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/** 上游要求 chat_id 为 32 位小写十六进制。 */
const CHAT_ID_RE = /^[0-9a-f]{32}$/

/** 稳定地把消息内容序列化成锚点文本（字符串原样，多模态数组走 JSON）。 */
function canonicalContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * 为一次对话派生稳定的 chat_id。
 *
 * 上游按 chat_id 计会话，而并发会话数有上限且回收很慢。若每个请求都新开一个
 * chat_id，多轮对话几轮之后就会撞上「并发会话数已达上限」——历史在增长，但
 * **首条 user 消息始终不变**，所以拿它当会话锚点：同一次对话的每一轮共用同一个
 * chat_id，只占一个会话。
 *
 * 客户端若显式给了 conversation_id（32 位 hex）则优先用它。
 */
function conversationChatId(parsed: Record<string, unknown>): string {
  const explicit = typeof parsed.conversation_id === 'string' ? parsed.conversation_id.trim().toLowerCase() : ''
  if (CHAT_ID_RE.test(explicit)) return explicit

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  for (const raw of messages) {
    const message = raw as OpenAIMessage
    if (message?.role !== 'user') continue
    let anchor = `${message.role}\u0000${canonicalContent(message.content)}`
    // 同一句话可能先被用来生成会话标题（不带 tools），再发起真正的 Agent 请求。
    // 两者必须算作不同会话，否则标题请求会和 Agent 抢同一个会话。
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) anchor += '\u0000tools'
    return createHash('sha256').update(anchor).digest('hex').slice(0, 32)
  }
  // 没有 user 消息（少见）：退回随机 id，行为与从前一致。
  return hex32()
}

/**
 * 由 chat_id 派生稳定的会话标识，作为 `Session-Id` 头发给上游。
 * 与参考实现 codearts2api 的 sessionIDFor 一致（sha256 前 16 字节）。
 */
function sessionIdFor(chatId: string): string {
  return createHash('sha256').update(`codearts-session:${chatId}`).digest('hex').slice(0, 32)
}

export interface PreparedChatBody {
  url: string
  body: string
  model: string
  chatId: string
  /**
   * 不用发出去就能判定的失败（目前是「上下文放不下」）。非空时调用方必须直接把它
   * 回给 DSH —— 上游遇到同类问题只会给一句 "The request param is invalid"，
   * 那句话里没有模型、没有 token 数，用户无从下手。
   */
  error?: string
}

/**
 * 把 OpenAI 风格 chat body 适配给 CodeArts /api/v2/chat/completions。
 * 该端点虽是 OpenAI 兼容，但网关按自己的 schema 严格校验参数。所以这里
 * 不做原样透传，而是：
 *  1. model 走 canonicalModel（大小写敏感）
 *  2. max_completion_tokens → max_tokens（华为只认后者），并钳到该模型的上限；
 *     再按 contextWindow 扣掉 prompt 估算，保证 prompt + max_tokens 装得下
 *     （两者任一超限，上游都只会流内回 InferHub.001001005.400
 *     "The request param is invalid, Please check it"，不告诉我们是哪一个）
 *  3. 丢弃非白名单字段（stream_options / store / logprobs 等虽实测可容忍，
 *     但按 codearts2api 观察到的真实流量收窄，避免网关后续收紧）
 *  4. tools[].function 去掉 strict（OpenAI 专有）
 *  5. 注入 CodeArts 特有字段：chat_id（按对话派生，见 conversationChatId）、
 *     prompt_cache_key、tool_stream
 *
 * @param contextWindow 该模型的上下文窗口（来自 catalog）。传 0 表示不知道，
 *   此时只做上限钳制、不做「装不下」判断。
 */
export function prepareChatBody(rawJson: string, contextWindow = 0): PreparedChatBody {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>
  } catch {
    // 解析失败仍拼一个最小请求，让上游自己报错
    return { url: `${SNAP_HOST}${EP_CHAT}`, body: rawJson, model: '', chatId: '' }
  }
  const model = typeof parsed.model === 'string' ? canonicalModel(parsed.model) : ''
  const chatId = conversationChatId(parsed)

  // 上游网关接受的顶层字段白名单（对齐 codearts2api 观察到的真实流量）。
  // stream_options 实测可被网关接受，且 include_usage: true 会让上游在流末尾
  // 回真实 usage 帧（否则整条流 usage 全 0，DSH 底部的 token/tok/s 药丸没数据）。
  const body: Record<string, unknown> = {}
  for (const key of ['messages', 'temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'frequency_penalty', 'tools', 'tool_choice', 'user', 'stream_options']) {
    if (parsed[key] !== undefined) body[key] = parsed[key]
  }
  // 上游默认不发 usage;强制要求回传(幂等,pi-ai 每次都会带)。
  if (body.stream_options === undefined || typeof body.stream_options !== 'object') {
    body.stream_options = { include_usage: true }
  } else {
    ;(body.stream_options as Record<string, unknown>).include_usage = true
  }
  // pi-ai 对非 OpenAI provider 发 max_completion_tokens；华为只认 max_tokens。
  if (body.max_tokens === undefined && typeof parsed.max_completion_tokens === 'number') {
    body.max_tokens = parsed.max_completion_tokens
  }
  // 上游遇到任何一种参数超限都只回同一句话，所以「max_tokens 太大」和
  // 「prompt 装不下」必须在我们这边分开判：
  //  1. 超过该模型上限 → 钳住（上限由服务端控制、会漂，真撞了还有 degradeTokenCeiling 兜底）
  //  2. prompt + max_tokens 超过 contextWindow → 把 max_tokens 压到装得下；
  //     连最短回答都放不下时，回一条**具体**错误，而不是让上游给一句黑话。
  const ceiling = maxTokensCeilingFor(model)
  if (typeof body.max_tokens === 'number') {
    let maxTokens = Math.min(body.max_tokens, ceiling)
    if (contextWindow > 0) {
      const promptTokens = estimateTokens(`${JSON.stringify(body.messages ?? '')}${JSON.stringify(body.tools ?? '')}`)
      const room = contextWindow - promptTokens - PROMPT_ESTIMATE_MARGIN
      if (room < MIN_USEFUL_OUTPUT_TOKENS) {
        body.max_tokens = maxTokens
        return {
          url: `${SNAP_HOST}${EP_CHAT}`,
          body: JSON.stringify(body),
          model,
          chatId,
          error: `上下文放不下：${model} 的窗口是 ${contextWindow} tokens，本次请求（含 ${Array.isArray(body.messages) ? body.messages.length : 0} 条消息与工具定义）估算约 ${promptTokens} tokens，剩余不足 ${MIN_USEFUL_OUTPUT_TOKENS} tokens 的生成余量。请新建会话或改用上下文更大的模型。`,
        }
      }
      maxTokens = Math.min(maxTokens, room)
    }
    body.max_tokens = maxTokens
  }
  // strict 是 OpenAI 专有，华为 schema 不认识。
  if (Array.isArray(body.tools)) {
    body.tools = (body.tools as Record<string, unknown>[]).map(tool => {
      if (tool && typeof tool === 'object' && tool.function && typeof tool.function === 'object') {
        const fn = { ...(tool.function as Record<string, unknown>) }
        delete fn.strict
        return { ...tool, function: fn }
      }
      return tool
    })
  }
  body.model = model
  body.stream = true
  body.chat_id = chatId
  body.prompt_cache_key = chatId
  body.tool_stream = true
  return { url: `${SNAP_HOST}${EP_CHAT}`, body: JSON.stringify(body), model, chatId }
}

/**
 * 免费档的「并发会话数已达上限」。实测 HTTP 400 + 这个错误码，上限是 3 个会话，
 * 而且被掐断/挂起的流要约 2 分钟才被网关回收。它不是请求错误，重发就有机会，
 * 所以 shim 要在本地排队重等，而不是把它变成 pi-ai 的重试风暴。
 */
export const CONCURRENCY_CAP_CODE = 'TM.00001041'

export function isConcurrencyCap(result: ChatResult): boolean {
  return !result.ok && result.message.includes(CONCURRENCY_CAP_CODE)
}

function classify(status: number, message: string): UpstreamErrorKind {
  const m = message.toLowerCase()
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (m.includes('not registered') || m.includes('benefit not found')) return 'not_found'
  if (m.includes('tpm') || m.includes('并发')) return 'soft_rate'
  return 'client'
}

const enc = new TextEncoder()

function openAIData(obj: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`)
}

/** OpenAI 流的终止帧是裸 `data: [DONE]`，不能走 JSON.stringify（否则会带引号）。 */
function openAIDone(): Uint8Array {
  return enc.encode('data: [DONE]\n\n')
}

/**
 * 把上游累计快照 SSE 转换成 OpenAI 增量流。
 *
 * 上游行为（reverse-engineering.md §5）：
 *  - {"type":"answer", ...} 起始
 *  - {"text": "<累计全文>"} 全文快照（用替换语义）
 *  - {"delta":{"content":"..."}} 真增量
 *  - {"text":"[DONE]","error_code":"0"} 结束；error_code != 0 为错误
 */
export async function chatStream(
  credential: CodeArtsResolved,
  prepared: { url: string; body: string; model: string; chatId?: string },
  signal?: AbortSignal,
): Promise<ChatResult> {
  const traceId = randomTraceId()
  const bodyBuf = Buffer.from(prepared.body)
  // 限时福利（免费套餐）模型必须带 maas_type: benefit 头，且要在签名前设置
  // （signer 会把请求里的所有 header 计入 SignedHeaders）。
  const benefit = isBenefitModel(prepared.model)
  const req = new Request(prepared.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-auth-token': credential.token,
      'X-Security-Token': credential.securityToken,
      'x-snap-traceid': traceId,
      'X-Language': 'zh-cn',
      'app-id': 'CodeAgent3.0',
      'is_confidential': 'false',
      ...(benefit ? { 'maas_type': 'benefit' } : {}),
    },
    body: bodyBuf,
  })
  // 若具备 AK/SK 则叠加华为云 HMAC 签名（与官方一致）；仅有 security_token 也能用。
  if (credential.accessKeyId && credential.secretAccessKey) {
    const signCred: SignCredential = {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    }
    signRequest(req, bodyBuf, signCred)
  }
  // Chat-Id / Session-Id 必须在签名**之后**追加，否则会被计入 SignedHeaders，
  // 网关可能拒签。上游按这组标识给会话计数与做 prompt cache 亲和：只把 chat_id
  // 放在 body 里不够，头也得带上，否则每个请求照样各算一个会话。
  if (prepared.chatId) {
    req.headers.set('Chat-Id', prepared.chatId)
    req.headers.set('Session-Id', sessionIdFor(prepared.chatId))
  }

  let resp: Response
  try {
    resp = await fetch(req, { signal })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 用户点「停止生成」会让 fetch 抛 AbortError，它也会走到这里。那不是上游故障，
    // 绝不能归类成 'server' —— 调用方会据此把账号判为故障（冷却/停用），于是「打断
    // 一次」就变成「这个账号三十秒内不可用」。调用方仍必须先看 signal.aborted。
    if (signal?.aborted === true) {
      return { ok: false, kind: 'client', status: 0, message: 'aborted by client' }
    }
    return { ok: false, kind: 'server', status: 0, message }
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return { ok: false, kind: classify(resp.status, text), status: resp.status, message: text.slice(0, 400) }
  }

  const model = prepared.model
  const upstream = resp.body
  if (!upstream) {
    return { ok: false, kind: 'server', status: 0, message: 'dsh-codearts: 上游无响应体' }
  }

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let lastText = ''
  let sentAny = false
  // 终止帧只允许出现一次：上游可能已经发过裸 data:[DONE]，流正常结束时
  // 不能再补一个，否则下游会看到重复的收尾帧。
  let doneSent = false
  // SSE 帧可能跨 TCP chunk 被切断；攒 buffer 按 \n 切行。
  let sseBuf = ''

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // 这一层必须一直读到「至少产出一帧」或上游结束为止,不能只 read 一次。
        //
        // 单次 read 拿到的数据可能什么都不产出:半行 JSON（帧被 TCP 切断）、
        // SSE 注释/心跳、空行,或旧协议的 {"type":"answer","text":""} 开头帧
        // 和 {"text":"[DONE]"} 收尾帧。此时若直接 return,运行时不会再回调
        // pull,整个流就永久卡死——客户端一直转圈,既不结束也不报错。
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            if (sentAny && !doneSent) controller.enqueue(openAIDone())
            controller.close()
            return
          }
          sseBuf += decoder.decode(value, { stream: true })
          const lines = sseBuf.split('\n')
          sseBuf = lines.pop() ?? ''
          let emitted = false
          for (const raw of lines) {
            const trimmed = raw.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            // 裸 data:[DONE] 是流终止帧,原样透传给下游(pi-ai 依赖它收尾)。
            if (payload === '[DONE]') {
              sentAny = true
              if (!doneSent) {
                doneSent = true
                controller.enqueue(openAIDone())
                emitted = true
              }
              continue
            }
            if (!payload) continue
            let ev: any
            try {
              ev = JSON.parse(payload)
            } catch {
              continue
            }
            if (ev.error_code && ev.error_code !== '0' && ev.error_code !== 0) {
              controller.enqueue(
                openAIData({
                  choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
                  error: { code: ev.error_code, message: ev.error_msg ?? 'upstream error' },
                }),
              )
              controller.enqueue(openAIDone())
              controller.close()
              return
            }
            // 2026-09-30 实测:当前上游直接回标准 OpenAI chat.completion.chunk
            // (choices[].delta.content / reasoning_content),且流以裸 data:[DONE]
            // 结束。这种帧原样透传,不做任何转换。
            //
            // 注意判据是「有 choices 字段」而不是「choices 非空」：开了
            // stream_options.include_usage 后,承载 usage 的收尾帧形如
            // {"choices":[],"usage":{...}}。用 length > 0 会把这一帧漏掉——
            // 它既没有 legacy 的 delta/text,就会一路掉到函数末尾被丢弃,
            // 于是 DSH 底部的用量药丸永远拿不到数据。
            if (Array.isArray(ev.choices)) {
              sentAny = true
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
              emitted = true
              continue
            }
            // ——以下为旧版协议帧(累计全文快照),保留兼容——
            // 增量 delta
            if (ev.delta?.content) {
              sentAny = true
              controller.enqueue(openAIData({ model, choices: [{ delta: { content: ev.delta.content }, finish_reason: null }] }))
              emitted = true
            }
            // 累计全文快照：用替换语义算增量
            if (typeof ev.text === 'string' && ev.text !== '[DONE]') {
              const cur = ev.text
              if (cur.length > lastText.length && cur.startsWith(lastText)) {
                const delta = cur.slice(lastText.length)
                sentAny = true
                controller.enqueue(openAIData({ model, choices: [{ delta: { content: delta }, finish_reason: null }] }))
                emitted = true
              }
              lastText = cur
            }
          }
          // 有产出就交还给消费者；没有则继续读，直到读到有产出的帧或上游结束。
          if (emitted) return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        controller.enqueue(openAIData({ error: { message } }))
        controller.close()
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })

  return { ok: true, stream }
}

/** 登录身份（上游对同一账号恒定，可用来当账号的自然键）。 */
export interface CallerIdentity {
  userId: string
  userName: string
  domainId: string
}

/**
 * 查当前凭证对应的账号身份。
 *
 * 为什么需要它：登录响应里 `user_id` / `user_name` 都是空串（实测），所以插件原先
 * 只能拿 DPoP 公钥当账号标识 —— 代价是**对同一个账号重新登录会被当成新账号**。
 * 这个端点给出上游的稳定 `user_id`，重新登录就能命中同一条账号记录。
 *
 * 失败不应阻断登录：调用方按「拿不到身份就退回旧行为」处理。
 */
export async function fetchCallerIdentity(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<CallerIdentity> {
  const resp = await signedGet(`${SNAP_HOST}${EP_CURRENT_USER}`, credential, undefined, signal)
  if (!resp.ok) throw new Error(`identity HTTP ${resp.status} ${resp.message}`)
  const body = asRecord(parseJson(resp.text))
  const userId = firstString(body.user_id)
  if (userId === '') throw new Error('identity response carries no user_id')
  return {
    userId,
    userName: firstString(body.user_name),
    domainId: firstString(body.domain_id),
  }
}

/** 模型清单的三路来源。任一路失败都不阻断，只有三路全失败才算失败。 */
export type ModelSource = 'builtin' | 'benefit' | 'agent'

export interface ModelDiscoveryResult {
  /** 合并后的清单（已去重、已排序）。 */
  models: readonly CodeArtsModelInfo[]
  /** 本轮成功应答的来源。 */
  sources: readonly ModelSource[]
  /** 失败来源及原因（不阻断，供 doctor/日志展示）。 */
  errors: readonly { source: ModelSource; message: string }[]
}

/** 发现不到 contextWindow 时的保守默认值：只影响 DSH 的上下文计量条与截断余量。 */
const UNKNOWN_CONTEXT_WINDOW = 32_768

/** 发现不到 maxTokens 时的默认值（低于服务端上限，保证请求能过）。 */
const UNKNOWN_MAX_TOKENS = 8_000

/** 带 AK/SK 签名的 GET；body 为空（签名按空载荷算）。 */
export async function signedGet(
  url: string,
  credential: CodeArtsResolved,
  agentType: 'AgentCenter' | 'PromptCenter' | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const req = new Request(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Language': 'zh-cn',
      ...(agentType === undefined ? {} : { 'Agent-Type': agentType }),
      'X-Security-Token': credential.securityToken,
    },
  })
  if (credential.accessKeyId && credential.secretAccessKey) {
    signRequest(req, Buffer.from(''), {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    })
  }
  let resp: Response
  try {
    resp = await fetch(req, { signal })
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
  const text = await resp.text().catch(() => '')
  if (!resp.ok) return { ok: false, status: resp.status, message: text.slice(0, 300) }
  return { ok: true, text }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 内置模型：`GET /v1/model/builtin`（`Agent-Type: PromptCenter`）。
 * 实测响应 `{ count, builtinModels: [{ model_id, model_name, model_desc,
 * enable, display_enabled, supports_images, ... }] }` —— 注意它**不带**
 * context_window / max_tokens，那两项要靠合并种子或福利来源补。
 */
async function fetchBuiltinModels(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<readonly CodeArtsModelInfo[]> {
  const resp = await signedGet(`${SNAP_HOST}${EP_MODEL_BUILTIN}`, credential, 'PromptCenter', signal)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.message}`)
  const body = asRecord(parseJson(resp.text))
  const out: CodeArtsModelInfo[] = []
  for (const raw of asArray(body.builtinModels)) {
    const model = asRecord(raw)
    if (model.enable === false) continue
    const id = firstString(model.model_id, model.model_name)
    if (id === '') continue
    out.push({
      id,
      name: firstString(model.model_name, id),
      contextWindow: positive(model.context_window),
      maxTokens: positive(model.max_tokens),
      supportsImages: model.supports_images === true,
    })
  }
  return out
}

/**
 * 限时福利模型：`GET {opengw}/api/v1/gateway/config`。
 * 实测响应 `{ error_code: '0000', result: { base_url, models: [{ model_id,
 * model_name, context_window, max_tokens, sort }] } }`，整份标记福利。
 */
async function fetchBenefitModels(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<readonly CodeArtsModelInfo[]> {
  const resp = await signedGet(`${BENEFIT_HOST}${EP_BENEFIT_CONFIG}`, credential, undefined, signal)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.message}`)
  const body = asRecord(parseJson(resp.text))
  const code = firstString(body.error_code)
  if (code !== '' && code !== '0000') {
    throw new Error(`gateway/config error_code=${code} ${firstString(body.error_msg)}`)
  }
  const out: CodeArtsModelInfo[] = []
  for (const raw of asArray(asRecord(body.result).models)) {
    const model = asRecord(raw)
    const id = firstString(model.model_id, model.model_name)
    if (id === '') continue
    out.push({
      id,
      name: firstString(model.model_name, id),
      contextWindow: positive(model.context_window),
      maxTokens: positive(model.max_tokens),
      supportsImages: model.supports_images === true,
      benefit: true,
    })
  }
  return out
}

/**
 * agent-center 的模型清单：先 `useragents` 找一个 CodeAgent，再取 detail 的
 * `gpts.models`。过滤条件与官方客户端一致（`agent_name === 'CodeAgent'` 且
 * IDE 可见），退化为 primary，再退化为第一个。
 */
async function fetchAgentModels(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<readonly CodeArtsModelInfo[]> {
  const listResp = await signedGet(
    `${SNAP_HOST}${EP_AGENT_LIST}?offset=0&limit=100&is_primary_agent=true`,
    credential,
    'AgentCenter',
    signal,
  )
  if (!listResp.ok) throw new Error(`agent list HTTP ${listResp.status} ${listResp.message}`)
  const agents = asArray(asRecord(parseJson(listResp.text)).agents).map(asRecord)
  let agentId = ''
  for (const agent of agents) {
    const alias = asRecord(agent.alias)
    if (
      firstString(agent.agent_name) === 'CodeAgent' &&
      firstString(alias.alias_zh_cn) === '智能体' &&
      agent.show_in_ide === true
    ) {
      agentId = firstString(agent.agent_id)
      if (agentId !== '') break
    }
  }
  if (agentId === '') {
    for (const agent of agents) {
      if (agent.is_primary_agent === true) {
        agentId = firstString(agent.agent_id)
        if (agentId !== '') break
      }
    }
  }
  if (agentId === '' && agents.length > 0) agentId = firstString(agents[0]?.agent_id)
  if (agentId === '') throw new Error('no agent found to read gpts.models from')

  const detailResp = await signedGet(
    `${SNAP_HOST}${EP_AGENT_DETAIL}?agent_id=${encodeURIComponent(agentId)}`,
    credential,
    'AgentCenter',
    signal,
  )
  if (!detailResp.ok) throw new Error(`agent detail HTTP ${detailResp.status} ${detailResp.message}`)
  const gpts = asRecord(asRecord(parseJson(detailResp.text)).gpts)
  const out: CodeArtsModelInfo[] = []
  for (const raw of asArray(gpts.models)) {
    const model = asRecord(raw)
    const params = asRecord(model.model_parameters)
    // id 取**注册名**而不是 `model_name`：两者并不总是同一个字符串。实测
    // `glm-5.2-sft-harmony` 这条的 model_name 是显示名 `GLM-5.2-ArkTS-SPARK`，
    // 而内置来源的 model_id 与这里的 params.model_id 都写着 glm-5.2-sft-harmony。
    // 聊天按注册名路由，取错就会多出一个根本不存在的模型条目（且选它必然 404）。
    const id = firstString(params.model_id, model.model_id, model.model_alias, model.model_name)
    if (id === '') continue
    out.push({
      id,
      name: firstString(model.model_name, model.model_alias, id),
      contextWindow: positive(params.context_window),
      maxTokens: positive(params.max_tokens),
      supportsImages: model.supports_images === true,
    })
  }
  return out
}

/**
 * 动态发现当前账号可用的模型清单（三路合并）。
 *
 * 与 codearts2api 的 `Client.FetchModels` 等价：内置、限时福利、agent-center 三路
 * 各自独立，任一路失败只记进 `errors` 不阻断 —— 福利网关抖动时仍能拿到内置模型。
 *
 * 上标的两个「实测 vs 标称」处理（很重要，别照搬标称值）：
 *  - **maxTokens 钳到该模型的实测上限**（`MEASURED_MAX_TOKENS`）。上游
 *    `gateway/config` 给福利模型标的是 393216 / 384000，而聊天端点实测超过 65536
 *    就流内报 InferHub.001001005.400；DSH 会把 catalog 的 maxTokens 原样当
 *    max_tokens 发出去，照抄标称值等于让每个请求都失败。
 *  - contextWindow 用发现值（只影响 DSH 的上下文计量与截断余量，不影响路由）。
 *
 * @throws 三路全失败，或合并结果为空。
 */
export async function fetchModels(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<ModelDiscoveryResult> {
  const settled = await Promise.all([
    fetchBuiltinModels(credential, signal).then(
      models => ({ source: 'builtin' as const, models }),
      error => ({ source: 'builtin' as const, error: error as Error }),
    ),
    fetchBenefitModels(credential, signal).then(
      models => ({ source: 'benefit' as const, models }),
      error => ({ source: 'benefit' as const, error: error as Error }),
    ),
    fetchAgentModels(credential, signal).then(
      models => ({ source: 'agent' as const, models }),
      error => ({ source: 'agent' as const, error: error as Error }),
    ),
  ])

  const sources: ModelSource[] = []
  const errors: { source: ModelSource; message: string }[] = []
  const discovered: (readonly CodeArtsModelInfo[])[] = []
  for (const item of settled) {
    if ('error' in item) errors.push({ source: item.source, message: item.error.message })
    else {
      sources.push(item.source)
      discovered.push(item.models)
    }
  }
  if (sources.length === 0) {
    throw new Error(`model discovery failed on every source: ${errors.map(e => `${e.source}: ${e.message}`).join('; ')}`)
  }

  // 种子只用来补缺（补发现结果里缺席的模型、补齐为 0 的参数），不参与竞争 ——
  // 否则种子里的占位参数会压过上游返回的真实值（见 fillFromSeed 的注释）。
  const merged = fillFromSeed(mergeModelLists(discovered))
  if (merged.length === 0) throw new Error('model discovery returned an empty catalog')

  const models = merged.map(model => ({
    ...model,
    contextWindow: model.contextWindow > 0 ? model.contextWindow : UNKNOWN_CONTEXT_WINDOW,
    maxTokens: Math.min(
      model.maxTokens > 0 ? model.maxTokens : UNKNOWN_MAX_TOKENS,
      maxTokensCeilingFor(model.id),
    ),
  }))

  // 这里**不**改全局福利集：多账号时要取并集，由调用方（discovery.ts）统一提交，
  // 否则最后拉的那个账号会覆盖掉别的账号确认过的福利模型。
  return { models, sources, errors }
}

/**
 * 开通「限时福利」（免费模型）渠道，幂等：已开通就原样返回。官方客户端打开模型菜单
 * 即调用（GET），用户点「领取」时也调（POST）——两种方法实测都返回 200/0000。
 * 不开通时福利模型调用必报 InferHub.4004.200 benefit not found。
 * 需要 AK/SK 签名（凭证要带 accessKeyId/secretAccessKey）。
 *
 * **它不发积分。** 返回体只是一条渠道开通记录（channel / create_time / update_time，
 * 幂等所以时间戳是旧的），账号积分由套餐决定（见 credits.ts），领取动作在官网签到页。
 * 别把它当「领取积分」用 —— 早先卡片这么用，结果就是「点了显示已领取、积分没变」。
 */
export async function claimBenefit(credential: CodeArtsResolved, abort?: AbortSignal): Promise<void> {
  // 没有 AK/SK 就签不了名。这不是失败，而是「这个账号没有这条通道」，静默跳过。
  if (!credential.accessKeyId || !credential.secretAccessKey) return
  const url = `${BENEFIT_HOST}${EP_BENEFIT_CLAIM}`
  const bodyBuf = Buffer.from('{}')
  const req = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Language': 'zh-cn',
      'X-Security-Token': credential.securityToken,
    },
    body: bodyBuf,
  })
  const signCred: SignCredential = {
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    securityToken: credential.securityToken,
  }
  signRequest(req, bodyBuf, signCred)
  const resp = await fetch(req, { signal: abort })
  const raw = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(`claim benefit failed: ${resp.status} ${raw.slice(0, 200)}`)
  }
  // 成功判定对齐官方客户端：`error_code === "0000"` 才算成功。
  // 非 JSON **不能**当成功 —— APIG 的错误页也会是 200 + 非 JSON，那样会假成功。
  let json: { error_code?: string; error_msg?: string }
  try {
    json = JSON.parse(raw) as typeof json
  } catch {
    throw new Error(`claim benefit: unexpected non-JSON response: ${raw.slice(0, 200)}`)
  }
  if (json.error_code !== '0000') {
    throw new Error(
      `claim benefit rejected: ${json.error_code ?? '(no error_code)'} ${json.error_msg ?? ''}`.trim(),
    )
  }
}

/**
 * 福利中心（活动积分）接口：26.9.901 起应用内「每日签到领 1000 积分」走这套。
 *
 * host 与积分统计是同一个 snap-access 网关，路径前缀 `/v1/ops`，鉴权头对齐官方客户端
 * 的 `Pz()`（`x-auth-token` + `Agent-Type: PromptCenter`），再补上我们直连必须的
 * AK/SK 签名。三个实测出来的坑：
 *
 *  1. bundle 里 URL 有两套变体，带前缀的 `/PromptCenterService/v1/ops/*` 在这个网关上
 *     回 **404 APIG.0101（未发布）** —— 只有裸 `/v1/ops/*` 能用；
 *  2. 只带 `x-auth-token` 会被拒（`APIG.0301 decrypt token fail`）；
 *  3. **业务失败也回 HTTP 200**，成败只看 body 的 `code`（0 才是成功）。
 *     今天已领时是 `code:40001 尚未到达权益刷新时间，暂时无法领取`。
 *
 * 领的是「活动」而不是额度：`/ops/delivery` 给活动清单（含 campaignId / status /
 * claimable），`/ops/claim` 按 campaignId 领。`idempotentKey` 上游不返回，官方客户端
 * 自己生成随机串（与 `x-snap-traceid` 同一个生成器），按天去重落在服务端。
 */
const EP_OPS_DELIVERY = '/v1/ops/delivery'
const EP_OPS_CLAIM = '/v1/ops/claim'

/** 每日签到活动的 type（实测为 campaignId 1，benefitAmount 1000 CREDIT）。 */
const WELFARE_DAILY_TYPE = 'USER_LOGIN'

/** 上游按钮文案的状态机：这几个都表示「今天已经领过了」。 */
const WELFARE_ALREADY_STATES = new Set(['CLAIMED', 'CONFIRMED', 'CONSUMED'])

/** 活动状态是不是「今天已经领过了」（区别于「要先登录」「没资格」这些同样不可领的情况）。 */
export function isWelfareClaimedStatus(status: string): boolean {
  return WELFARE_ALREADY_STATES.has(status)
}

/**
 * 「今日已领」的业务码。
 *
 * 这个分支不是冗余的：领取成功后的几十秒里 delivery 有可能还回一份**陈旧**的
 * `claimable:true / ELIGIBLE`（实测 2026-10-16，领完立刻读会看到），于是会真的
 * POST 第二次 —— 服务端按天去重回这个码，所以按「已领」处理，不能当失败。
 */
const WELFARE_CODE_NOT_YET = 40001

export interface CodeArtsWelfareCampaign {
  campaignId: number
  title: string
  type: string
  /** 这一条活动给多少福利。 */
  amount: number
  /** CREDIT / 其它；只有 CREDIT 才是积分。 */
  unit: string
  claimable: boolean
  /** 上游状态；活动未开始时为 ''。 */
  status: string
}

/** 领取结果。UI 按 state 出文案，message 只在上游给了更有用的话时兜底。 */
export type CodeArtsWelfareState = 'claimed' | 'already' | 'unavailable' | 'failed'

export interface CodeArtsWelfareOutcome {
  state: CodeArtsWelfareState
  /** 本次拿到的积分数（只有 claimed 才非 0）。 */
  amount: number
  message: string
}

/** 福利接口的请求：签名 + 官方那套头，返回解析后的 body。 */
async function welfareRequest(
  url: string,
  method: 'GET' | 'POST',
  credential: CodeArtsResolved,
  body?: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; code: number; message: string; data: unknown }
  | { ok: false; message: string }
> {
  const req = new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Language': 'zh-cn',
      'x-snap-traceid': hex32(),
      'x-auth-token': credential.token,
      'Agent-Type': 'PromptCenter',
      'X-Security-Token': credential.securityToken,
    },
    ...(body === undefined ? {} : { body }),
  })
  const bodyBuf = Buffer.from(body ?? '')
  if (credential.accessKeyId !== undefined && credential.secretAccessKey !== undefined) {
    signRequest(req, bodyBuf, {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    })
  }
  let resp: Response
  try {
    resp = await fetch(req, { signal })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const text = await resp.text().catch(() => '')
  if (!resp.ok) return { ok: false, message: `HTTP ${resp.status} ${text.slice(0, 200)}` }
  // 200 + 非 JSON 是 APIG 的错误页，不能当成功。
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: `unexpected non-JSON response: ${text.slice(0, 200)}` }
  }
  const envelope = asRecord(parsed)
  return {
    ok: true,
    code: typeof envelope.code === 'number' ? envelope.code : -1,
    message: firstString(envelope.message),
    data: envelope.data,
  }
}

/** 活动清单（`GET /v1/ops/delivery?channel=IDE`）。 */
export async function fetchWelfareCampaigns(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<CodeArtsWelfareCampaign[]> {
  const resp = await welfareRequest(
    `${SNAP_HOST}${EP_OPS_DELIVERY}?channel=IDE`,
    'GET',
    credential,
    undefined,
    signal,
  )
  if (!resp.ok) throw new Error(`welfare delivery: ${resp.message}`)
  return asArray(asRecord(resp.data).items).flatMap(item => {
    const raw = asRecord(item)
    const campaignId = typeof raw.campaignId === 'number' ? raw.campaignId : Number.NaN
    if (Number.isFinite(campaignId) === false) return []
    return [{
      campaignId,
      title: firstString(raw.title),
      type: firstString(raw.type),
      amount: typeof raw.benefitAmount === 'number' ? raw.benefitAmount : 0,
      unit: firstString(raw.benefitUnit),
      claimable: raw.claimable === true,
      status: firstString(raw.status),
    } satisfies CodeArtsWelfareCampaign]
  })
}

/**
 * 从活动清单里挑「每日签到」那条。
 *
 * 同一个 type 理论上可能有多条（上游换活动的时候），优先挑当前可领的那条。
 */
export function pickDailyWelfareCampaign(
  campaigns: readonly CodeArtsWelfareCampaign[],
): CodeArtsWelfareCampaign | undefined {
  const daily = campaigns.filter(c => c.type === WELFARE_DAILY_TYPE && c.unit === 'CREDIT')
  return daily.find(c => c.claimable) ?? daily[0]
}

/**
 * 领一次每日签到积分。
 *
 * 不抛异常：这是卡片上一个按钮的后续，失败要变成能显示的文案而不是断掉的请求。
 */
export async function claimDailyWelfare(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<CodeArtsWelfareOutcome> {
  if (credential.accessKeyId === undefined || credential.secretAccessKey === undefined) {
    return { state: 'failed', amount: 0, message: 'no AK/SK to sign' }
  }
  let campaigns: CodeArtsWelfareCampaign[]
  try {
    campaigns = await fetchWelfareCampaigns(credential, signal)
  } catch (error) {
    return {
      state: 'failed',
      amount: 0,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const target = pickDailyWelfareCampaign(campaigns)
  if (target === undefined) {
    return { state: 'unavailable', amount: 0, message: 'no daily check-in campaign' }
  }
  if (!target.claimable) {
    return isWelfareClaimedStatus(target.status)
      ? { state: 'already', amount: 0, message: '' }
      : { state: 'unavailable', amount: 0, message: target.status }
  }
  const resp = await welfareRequest(
    `${SNAP_HOST}${EP_OPS_CLAIM}`,
    'POST',
    credential,
    JSON.stringify({
      campaignId: target.campaignId,
      idempotentKey: hex32(),
      channel: 'IDE',
    }),
    signal,
  )
  if (!resp.ok) return { state: 'failed', amount: 0, message: resp.message }
  if (resp.code === 0) return { state: 'claimed', amount: target.amount, message: resp.message }
  return {
    state: resp.code === WELFARE_CODE_NOT_YET ? 'already' : 'failed',
    amount: 0,
    message: resp.message,
  }
}
