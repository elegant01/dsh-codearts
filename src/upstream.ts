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
import { isBenefitModel } from './catalog.ts'

export const SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const EP_CHAT = '/api/v2/chat/completions'
// 限时福利（免费套餐）网关：领取接口（幂等）。对齐 codearts2api 的 BenefitHost/EpBenefitClaim。
const BENEFIT_HOST = 'https://opengw.developer.huaweicloud.com'
const EP_BENEFIT_CLAIM = '/api/v1/benefit/claim'

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
 * 把 OpenAI 风格 chat body 适配给 CodeArts /api/v2/chat/completions。
 * 该端点虽是 OpenAI 兼容，但网关按自己的 schema 严格校验参数。所以这里
 * 不做原样透传，而是：
 *  1. model 走 canonicalModel（大小写敏感）
 *  2. max_completion_tokens → max_tokens（华为只认后者），并钳制到
 *     MAX_TOKENS_CEILING（超限会流内报 InferHub.001001005.400
 *     "The request param is invalid, Please check it"）
 *  3. 丢弃非白名单字段（stream_options / store / logprobs 等虽实测可容忍，
 *     但按 codearts2api 观察到的真实流量收窄，避免网关后续收紧）
 *  4. tools[].function 去掉 strict（OpenAI 专有）
 *  5. 注入 CodeArts 特有字段：chat_id（按对话派生，见 conversationChatId）、
 *     prompt_cache_key、tool_stream
 */
export function prepareChatBody(rawJson: string): { url: string; body: string; model: string } {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>
  } catch {
    // 解析失败仍拼一个最小请求，让上游自己报错
    return { url: `${SNAP_HOST}${EP_CHAT}`, body: rawJson, model: '' }
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
  // max_tokens 超过服务端上限会被流内拒绝（InferHub.001001005.400），
  // 钳到实测上限，保证生成不被截断的前提下请求能过。
  if (typeof body.max_tokens === 'number' && body.max_tokens > MAX_TOKENS_CEILING) {
    body.max_tokens = MAX_TOKENS_CEILING
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
  return { url: `${SNAP_HOST}${EP_CHAT}`, body: JSON.stringify(body), model }
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
  prepared: { url: string; body: string; model: string },
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

  let resp: Response
  try {
    resp = await fetch(req, { signal })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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

export async function fetchModels(_credential: CodeArtsResolved): Promise<never> {
  throw new Error('dsh-codearts: dynamic model discovery not implemented; use the static catalog')
}

/**
 * 领取限时福利（幂等：已领取返回成功）。官方客户端打开模型菜单即调用。
 * 不领取时福利模型调用必报 InferHub.4004.200 benefit not found。
 * 需要 AK/SK 签名（凭证要带 accessKeyId/secretAccessKey）。
 */
export async function claimBenefit(credential: CodeArtsResolved, abort?: AbortSignal): Promise<void> {
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
  // 接口返回 { error_code: "0000", ... }；非 0000 视为失败，但不阻断（幂等）。
  try {
    const json = JSON.parse(raw)
    if (json.error_code && json.error_code !== '0000') {
      throw new Error(`claim benefit rejected: ${json.error_code} ${json.error_msg ?? ''}`)
    }
  } catch (e) {
    if (e instanceof SyntaxError) return // 非 JSON 也当成功（接口行为宽松）
    throw e
  }
}
