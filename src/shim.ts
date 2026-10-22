/**
 * Loopback OpenAI-compatible endpoint for CodeArts.
 *
 * DSH's pi-ai provider points here. The shim validates the loopback + shared
 * secret, resolves the pasted `cloud_dragon_token`, and forwards the request
 * to CodeArts' `/api/v2/chat/completions` — whose SSE chunk shape is already
 * OpenAI-compatible, so we pipe the upstream stream straight through.
 *
 * Inbound hardening (copied from dsh-codebuddy-cli): bind 127.0.0.1 only,
 * require a loopback Host header, a loopback Origin, and the per-process
 * shared secret as `Authorization: Bearer`. Any local attacker hitting the
 * port still cannot forge the secret.
 *
 * @module dsh-codearts/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { CodeArtsAccountStore } from './auth.ts'
import { CodeArtsAccountPool, ERROR_THRESHOLD } from './account-pool.ts'
import type { CodeArtsCatalog } from './catalog.ts'
import {
  canonicalModel,
  chatStream,
  degradeTokenCeiling,
  isConcurrencyCap,
  isParamInvalidFrame,
  isQueueableRate,
  isTpmLimit,
  maxTokensCeilingFor,
  prepareChatBody,
  rateLimitFrame,
  upstreamErrorMessage,
  type ChatResult,
  type CodeArtsResolved,
  type PreparedChatBody,
  type UpstreamErrorKind,
} from './upstream.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import type { CodeArtsQueueGate } from './queue.ts'
import type { CodeArtsUsageTracker } from './usage.ts'

export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface CodeArtsShim {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

export interface CodeArtsShimOptions {
  store: CodeArtsAccountStore
  catalog: CodeArtsCatalog
  /** 账号池。不传则内部自建一个，并在每次请求前与账号文档对齐。 */
  pool?: CodeArtsAccountPool
  /** 用量账本。给了就在转发流的同时把 usage 帧记下来（卡片上的「今日用量」）。 */
  usage?: CodeArtsUsageTracker
  /**
   * 上游排队闸门。给了就在发请求前占号、轮询到轮到再开流
   * （底部积分条旁边展示「排队第 N 位」）。
   */
  queue?: CodeArtsQueueGate
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/**
 * 排队没等到时回给用户的那句：优先用上游自己的文案（它就是写给人看的，带位置和
 * 「建议切换模型/升级套餐」），上游没给才自己拼。
 */
function queuedMessage(
  model: string,
  gate: { position: number; length: number; message: string },
): string {
  const upstream = gate.message.trim()
  const detail = upstream === '' ? `上游排队中：${model} 第 ${gate.position} 位（共 ${gate.length} 条）` : upstream
  return `${detail} 插件没有一直等下去，请稍后重试。`
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 一次请求最多试几个账号（与 Go 参考的 MaxRotate 一致）。 */
const MAX_ROTATE = 3/** 一次请求最多把 max_tokens 降几档（65536 → 32768 → 16384 → 8192）。 */
const MAX_CEILING_HEALS = 3
/**
 * 所有账号都撞上并发上限时，回落到「在同一账号上原地重发」的预算。
 *
 * 2026-09-30 实测：一个上游会话要 ~52s 才被释放，而且**中途打断并不减免** ——
 * 只跑了 98ms 就中止的请求，同样占满一个名额 52s。所以用户「打断 → 马上重问」
 * 时等的就是这个 52s。池里有别的账号时下面会直接换号（不用等）；这条是最后一根
 * 稻草，必须盖过 52s，否则用户看到的不是「稍等一下」而是直接失败。
 *
 * 上限受 pi-ai 的 90s idle 超时约束：等待期间我们发不出任何内容，超过 90s 用户
 * 看到的就是超时。75s 给 52s 留了余量，也还在 90s 之内。
 */
const CAP_WAIT_LIMIT = 75_000
const CAP_RETRY_GAP = 3_000
/** 上游 5xx 后短时冷却该账号。 */
const SERVER_COOLDOWN_MS = 30_000
/** 零散错误累计到阈值后冷却该账号。 */
const ERROR_COOLDOWN_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))


/**
 * 最近几次出站请求的**形状**摘要：只有消息条数、role 名、工具数量，绝不记内容。
 *
 * 存在的理由只有一个：上游对参数问题只会回一句黑话（实测「Message role cannot
 * empty」这类），不看请求形状就分不清是宿主发了空 role 还是我们拼坏了。
 * 走 `/api/codearts/debug` 读，重启即清。
 */
export interface RequestShapeSummary {
  at: number
  model: string
  messages: number
  roles: string[]
  /** role 为空（或缺失/非字符串）的消息下标。 */
  emptyRoleAt: number[]
  tools: number
}

const recentShapes: RequestShapeSummary[] = []

/** 最近的请求形状，最新在前。 */
export function recentRequestShapes(): readonly RequestShapeSummary[] {
  return [...recentShapes].reverse()
}

function noteRequestShape(raw: string, model: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object') return
  const list = Array.isArray((parsed as { messages?: unknown }).messages)
    ? (parsed as { messages: unknown[] }).messages
    : []
  const roles = list.map(message => {
    if (message === null || typeof message !== 'object') return ''
    const role = (message as { role?: unknown }).role
    return typeof role === 'string' ? role : ''
  })
  recentShapes.push({
    at: Date.now(),
    model,
    messages: list.length,
    roles,
    emptyRoleAt: roles.map((role, index) => (role === '' ? index : -1)).filter(index => index >= 0),
    tools: Array.isArray((parsed as { tools?: unknown }).tools) ? (parsed as { tools: unknown[] }).tools.length : 0,
  })
  if (recentShapes.length > 8) recentShapes.shift()
}

export function createCodeArtsShim(options: CodeArtsShimOptions): CodeArtsShim {
  const { store, catalog } = options
  const logger = options.logger
  const usage = options.usage
  const queue = options.queue
  // 账号池。空池起步，每次请求前用 store.ids() 对齐（新增/删除账号自动跟上）。
  const pool = options.pool ?? new CodeArtsAccountPool([])

  const SHARED_SECRET = randomBytes(32).toString('base64url')

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('codearts shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'codearts',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  /** 该模型的上下文窗口（catalog 里查，大小写不敏感）；查不到返回 0 = 不做超长预判。 */
  function contextWindowFor(id: string): number {
    const lower = id.trim().toLowerCase()
    for (const model of catalog.current()) {
      if (model.id.toLowerCase() === lower) return model.contextWindow
    }
    return 0
  }

  /**
   * 打开上游流；撞到「参数非法」就把该模型的 max_tokens 上限折半降一档再开一次。
   *
   * 上游的 max_tokens 上限由服务端控制、会漂（GLM-5.2 标称 131072，2026-10-10 起
   * 直接被拒），手工实测表必然滞后。而这类错误是**流内**帧（HTTP 仍 200），只能在
   * 第一帧判 —— 此时还没有任何内容产出，重发是安全的。降档结果记在 upstream 的
   * 进程内表里，该模型后续请求直接从新上限起步，不必每轮再白撞一次。
   */
  async function openWithCeilingHeal(
    credential: CodeArtsResolved,
    raw: string,
    contextWindow: number,
    signal: AbortSignal,
  ): Promise<{ prepared: PreparedChatBody; result: ChatResult; head?: Uint8Array }> {
    for (let heal = 0; ; heal += 1) {
      const prepared = prepareChatBody(raw, contextWindow)
      if (prepared.error !== undefined) {
        return { prepared, result: { ok: false, kind: 'client', status: 400, message: prepared.error } }
      }
      const result = await chatStream(credential, prepared, signal)
      if (!result.ok) return { prepared, result }
      const reader = result.stream.getReader()
      const first = await reader.read()
      const head = first.done ? undefined : first.value
      // 首帧就是限流错误（TPM 实测是 HTTP 200 + 流内 error_code）：此时一个字都没
      // 吐出来，重发是安全的。必须在这里降级成真正的请求失败，交给下面的排队逻辑；
      // 否则错误会被当成正常流转发，DSH 侧只看到一句英文 PI_AI_ERROR。
      const rate = head === undefined ? undefined : rateLimitFrame(new TextDecoder().decode(head))
      if (rate !== undefined) {
        reader.releaseLock()
        await result.stream.cancel().catch(() => {})
        logger?.warn(`dsh-codearts: ${prepared.model} 首帧被判限流（${rate.code}），进入本地排队`)
        return { prepared, result: { ok: false, kind: 'soft_rate', status: 429, message: `${rate.code}: ${rate.message}` } }
      }
      const shouldHeal = heal < MAX_CEILING_HEALS && head !== undefined && isParamInvalidFrame(new TextDecoder().decode(head))
      reader.releaseLock()
      if (!shouldHeal) return { prepared, result, head }
      await result.stream.cancel().catch(() => {})
      if (degradeTokenCeiling(prepared.model) === 0) {
        return { prepared, result: { ok: false, kind: 'client', status: 400, message: `${prepared.model}: max_tokens 已降到下限仍被判参数非法` } }
      }
      logger?.warn(`dsh-codearts: ${prepared.model} 被判参数非法，max_tokens 降档到 ${maxTokensCeilingFor(prepared.model)} 后重发`)
    }
  }

  /**
   * 在**同一个账号**上重发，直到不再被限流或预算耗尽。
   *
   * 并发槽位是账号级的：有别的号就该换号，等 52s 是最后手段。
   * TPM 是模型级配额：换号只是换个账号撞同一堵墙，只能原地等窗口滑过去 ——
   * 间隔逐次翻倍（3s → 6s → 12s → 24s，封顶 30s），避免在配额已经满的时候
   * 把重试本身也打成一波流量。
   *
   * 命中限流不甩给 pi-ai：429 会被重试 5 次，每次再撞一次限流，越试越满。
   */
  async function openStream(
    credential: CodeArtsResolved,
    raw: string,
    contextWindow: number,
    signal: AbortSignal,
  ): Promise<{ prepared: PreparedChatBody; result: ChatResult; head?: Uint8Array; waitedMs: number }> {
    const started = Date.now()
    const until = started + CAP_WAIT_LIMIT
    let gap = CAP_RETRY_GAP
    for (;;) {
      const opened = await openWithCeilingHeal(credential, raw, contextWindow, signal)
      const waitedMs = Date.now() - started
      if (opened.result.ok || signal.aborted) return { ...opened, waitedMs }
      if (!isQueueableRate(opened.result)) return { ...opened, waitedMs }
      if (isTpmLimit(opened.result)) gap = Math.min(gap * 2, 30_000)
      if (Date.now() + gap > until) return { ...opened, waitedMs }
      await sleep(gap)
    }
  }

  /** 先交回降档判定读过的那一帧（它是流的开头，丢了就少一段），再接着读剩下的。 */
  async function* drainFrames(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    head?: Uint8Array,
  ): AsyncGenerator<Uint8Array> {
    if (head !== undefined) yield head
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield value
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    // 上游对「max_tokens 太大」和「prompt 装不下」只会回同一句 "The request param is
    // invalid"。所以出口处先按该模型的 contextWindow 自己判：能压小 max_tokens 就压小，
    // 压不动了就把带数字的具体错误直接回给 DSH，别让一轮请求去换一句黑话。
    let contextWindow = 0
    try {
      const inbound = JSON.parse(raw) as { model?: unknown }
      if (typeof inbound.model === 'string') contextWindow = contextWindowFor(canonicalModel(inbound.model))
    } catch {
      // 解析不了就交给 prepareChatBody 自己的兜底路径
    }
    const checked = prepareChatBody(raw, contextWindow)
    noteRequestShape(raw, checked.model)
    if (checked.error !== undefined) {
      writeOpenAIError(res, 400, 'context_overflow', checked.error)
      return
    }
    const controller = new AbortController()
    // ⚠ 必须挂 res，不能挂 req：请求体读完的那一刻 req 就已经 close 过了（实测），
    // 在它之后才挂的 handler 永远不触发 —— 所以「停止生成」以前从来没中止过上游，
    // 华为那边还在继续生成，下一次请求就被压在后面转圈。
    // 客户端提前断开时 res.writableEnded 还是 false，正常收尾才是 true。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    let ids: string[]
    try {
      ids = await store.ids()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }
    if (ids.length === 0) {
      writeOpenAIError(res, 401, 'not_signed_in', 'no CodeArts account stored; sign in from the CodeArts settings card')
      return
    }
    pool.sync(ids)

    // 先按账号轮换：某个账号的会话槽位被占（要 ~52s 才释放）就换下一个用，
    // 而不是让用户干等 —— 这正是「打断后重新提问」卡住的根因。
    const tried = new Set<string>()
    let cappedAccount: string | undefined
    let tpmAccount: string | undefined
    let queueWaitedMs = 0
    let lastKind: UpstreamErrorKind | undefined
    let lastStatus = 0
    let lastMessage = ''

    for (let attempt = 0; attempt < MAX_ROTATE; attempt += 1) {
      const id = pool.pick(tried)
      if (id === undefined) break
      tried.add(id)
      if (!pool.acquire(id)) continue
      try {
        const credential = await store.resolve(id)
        if (credential === undefined) {
          pool.disable(id, 'no credential')
          continue
        }
        // 上游排队要客户端自己挂号：先占号、轮询到 working 再发聊天请求。
        // 只等一小会儿（闸门里的 maxWaitMs），还在队里就把位置回给用户 ——
        // 挂着他二十几分钟不是产品，而且宿主的 90 秒流空闲超时也会先掐掉。
        if (queue !== undefined) {
          const gate = await queue.wait(credential, checked.chatId, checked.model, controller.signal)
          if (controller.signal.aborted) return
          if (gate.kind === 'queued') {
            // 400 而不是 429：宿主的 classifyPiAiError 按状态码归类，429 会被判成
            // RATE_LIMIT 并自动重试 5 次（实测），用户看到的是「一直转圈」而不是一句
            // 「在排队，稍后再试」。INVALID_REQUEST 不在重试名单里，一次就把话说到。
            writeOpenAIError(res, 400, 'queued', queuedMessage(checked.model, gate))
            return
          }
          if (gate.kind === 'queue_full' || gate.kind === 'error') {
            writeOpenAIError(res, gate.kind === 'queue_full' ? 429 : 502, gate.kind, gate.message)
            return
          }
        }
        const opened = await openWithCeilingHeal(credential, raw, contextWindow, controller.signal)
        const { prepared, result } = opened
        // 用户点「停止生成」时这次上游调用会以 AbortError 失败。那**不是账号故障**，
        // 必须在这里就返回：放它落到下面的分类里，每打断一次就会把这个账号冷却 30 秒，
        // 几次之后 pick() 选不出账号，表现就是「打断之后再也问不动了」。
        if (controller.signal.aborted) {
          if (result.ok) await result.stream.cancel().catch(() => {})
          return
        }
        if (result.ok) {
          pool.noteSuccess(id)
          await pipeToResponse(res, result.stream, controller.signal, { accountId: id, model: prepared.model }, opened.head)
          return
        }
        lastKind = result.kind
        lastStatus = result.status
        lastMessage = result.message

        if (isConcurrencyCap(result)) {
          // 账号没坏，只是槽位暂时满了：记一个「优先避开」的提示，换下一个号。
          // 明确**不**冷却 —— 冷却会让它在接下来一分钟彻底不可用，误伤后续请求。
          pool.noteConcurrencyCap(id)
          cappedAccount = id
          continue
        }
        if (isTpmLimit(result)) {
          // TPM 是模型级配额，换号也只是换个账号去撞同一堵墙；原地排队等窗口。
          // 账号本身完全健康，不要标记 capped/冷却。
          tpmAccount = id
          break
        }
        if (result.kind === 'session_dead') {
          // 凭据失效，这个号得重新登录了，换下一个。
          pool.disable(id, result.message)
          continue
        }
        if (result.kind === 'server' || result.kind === 'soft_rate') {
          pool.cooldown(id, SERVER_COOLDOWN_MS, result.message)
          break
        }
        // 其余（400/404 等）：换号只会拿到同样的错，直接报。
        pool.noteError(id, ERROR_THRESHOLD, ERROR_COOLDOWN_MS, result.message)
        break
      } finally {
        pool.release(id)
      }
    }

    if (controller.signal.aborted) return

    // 所有账号都撞在上限上：回到单账号时代的做法 —— 挑一个号原地排队等限流解除。
    // 多账号时走不到这里；单账号时这是唯一的兜底。
    const queueAccount = cappedAccount ?? tpmAccount
    if (queueAccount !== undefined) {
      if (pool.acquire(queueAccount)) {
        // 上限降档在主循环里已经跑过（learned 表是进程内共享的），这里不再重跑，
        // 只沿用排队等槽位的兜底。
        try {
          const credential = await store.resolve(queueAccount)
          if (credential !== undefined) {
            const opened = await openStream(credential, raw, contextWindow, controller.signal)
            const { result } = opened
            queueWaitedMs = opened.waitedMs
            // 同上：客户端主动中止不算账号故障，不要拿它去回写池状态。
            if (controller.signal.aborted) {
              if (result.ok) await result.stream.cancel().catch(() => {})
              return
            }
            if (result.ok) {
              pool.noteSuccess(queueAccount)
              await pipeToResponse(res, result.stream, controller.signal, { accountId: queueAccount, model: opened.prepared.model }, opened.head)
              return
            }
            lastKind = result.kind
            lastStatus = result.status
            lastMessage = result.message
          }
        } finally {
          pool.release(queueAccount)
        }
      }
    }

    if (lastKind === undefined) {
      writeOpenAIError(res, 429, 'soft_rate', 'codearts 当前没有可用账号（全部被禁用或冷却中），请稍后重试')
      return
    }
    // 排队等过就明说等过多久：否则用户不知道插件已经努力过，只会觉得「又失败了」。
    const explanation = upstreamErrorMessage(lastMessage, lastStatus)
    const waited = queueWaitedMs >= 1_000 ? `（本地已排队重试 ${Math.round(queueWaitedMs / 1000)} 秒）` : ''
    writeOpenAIError(res, KIND_STATUS[lastKind], lastKind, `${explanation}${waited}`)
  }

  /**
   * 记下一帧里的上游流内错误。判据宽松（帧文本含 "error" 才解析），解析不出来就忽略 ——
   * 诊断不能影响转发。
   */
  function logInStreamError(frame: string, model: string): void {
    try {
      const payload = frame.startsWith('data:') ? frame.slice(5).trim() : frame
      const ev = JSON.parse(payload) as { error?: { code?: unknown; message?: unknown } }
      if (ev.error === undefined) return
      const code = String(ev.error.code ?? '')
      const message = String(ev.error.message ?? '').slice(0, 200)
      logger?.error(`dsh-codearts: 上游流内报错 model=${model} code=${code} msg=${message}`)
    } catch {
      // 帧被切断或不是 JSON：忽略
    }
  }

  /** 把上游 SSE 按事件边界转发给 DSH，直到流结束或被中止。 */
  async function pipeToResponse(
    res: ServerResponse,
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    attribution?: { accountId: string; model: string },
    head?: Uint8Array,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    // 这次请求记一次账：拿不到 usage 帧（被中止、上游没回）时，请求数也要算上。
    if (usage !== undefined && attribution !== undefined) {
      usage.noteRequest(attribution.accountId, attribution.model)
    }
    // 上游流里可能已经带了终止帧（openAIDone）。收尾时只在没写过的情况下补，
    // 否则下游会连续收到两个 data: [DONE]。
    let sawDone = false
    const finish = (): void => {
      if (!res.writable || res.writableEnded) return
      res.end(sawDone ? undefined : 'data: [DONE]\n\n')
    }
    try {
      for await (const value of drainFrames(reader, head)) {
        buf += decoder.decode(value, { stream: true })
        // 按 SSE 事件边界（空行）切分
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (!frame) continue
          if (frame.trim() === 'data: [DONE]') sawDone = true
          // 参数类错误上游是放在**流内** error_code 帧里回的（HTTP 仍 200），它绕过了
          // chatStream 的错误分类，在插件侧本来完全不可见 —— 用户只看到 PI_AI_ERROR。
          if (frame.includes('"error"')) logInStreamError(frame, attribution?.model ?? '')
          // usage 帧形如 {"choices":[],"usage":{...}}，只在记账时解析，别影响转发。
          if (usage !== undefined && attribution !== undefined && frame.includes('"usage"')) {
            recordFrameUsage(frame, attribution)
          }
          if (res.writable) res.write(frame + '\n\n')
        }
      }
      finish()
    } catch (error: unknown) {
      // 用户点「停止生成」也会走到这里，那不是故障，别刷日志。
      if (!signal.aborted) {
        logger?.warn('dsh-codearts: upstream stream failed mid-flight', error)
      }
      finish()
    }
  }

  /** 从一帧 SSE 文本里取 usage 计入账本（解析失败就算了，不能影响转发）。 */
  function recordFrameUsage(frame: string, attribution: { accountId: string; model: string }): void {
    if (usage === undefined) return
    for (const line of frame.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as { usage?: Record<string, unknown> }
        if (parsed.usage !== undefined && parsed.usage !== null) {
          usage.noteUsage(attribution.accountId, attribution.model, parsed.usage)
        }
      } catch {
        // 半帧/非 JSON：忽略
      }
    }
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
