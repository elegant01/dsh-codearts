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
import { CodeArtsAccountPool, ERROR_THRESHOLD, type AccountRuntime } from './account-pool.ts'
import type { CodeArtsCatalog } from './catalog.ts'
import { markModelUnavailable } from './catalog.ts'
import {
  canonicalModel,
  chatStream,
  contextWindowOverrideFor,
  degradeTokenCeiling,
  firstFrameError,
  isConcurrencyCap,
  isIamTokenError,
  isModelNotAccessible,
  isNotMultimodal,
  isParamInvalidFrame,
  isQueueableRate,
  isQueueReject,
  isQueueRejectText,
  isTpmLimit,
  learnContextWindow,
  learnedContextWindowFor,
  MAX_TOKENS_FLOOR,
  maxTokensCeilingFor,
  modelUnavailableReasonText,
  prepareChatBody,
  queueFrame,
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
   * 上游排队闸门。给了就在发请求前短探一次排队位置（底部展示「排队第 N 位」），
   * **没轮到也照发** —— 实测 chat 请求不校验这张票（issue #10）。
   */
  queue?: CodeArtsQueueGate
  logger?: ShimLogger
  /**
   * 调试日志（默认关闭）。
   *
   * 宿主对插件的 info/debug 没有出口，acquire/release 这类取证信息只能让宿主
   * 注入一个落盘函数（见 index.ts 的 DSH_CODEARTS_DEBUG）。issue #8 的「槽位
   * 疑似泄漏」没有这些日志就无法证实或排除。
   */
  debug?: (message: string) => void
  /** 本地槽位满时最多等多久（缺省 30 秒）。测试用它把等待压到毫秒级。 */
  localSlotWaitMs?: number
  /** 上游回排队拒绝后的首次退避（缺省 5 秒，之后翻倍）。测试用它把等待压到毫秒级。 */
  queueRetryGapMs?: number
  /**
   * 「排队时一直等到轮到」（每次请求实时读，缺省关）。
   *
   * 打开后，上游明确回排队拒绝时不再换号/短退避，而是提前开流 + 每 20 秒一个空帧
   * 保住宿主连接，轮询这张票直到 working（最长 15 分钟），再用同一个号发请求。
   */
  waitInQueue?: () => boolean
  /**
   * 按模型 id 覆盖 contextWindow（用户配置，每次请求实时读取）。
   *
   * 目录值来自上游标称，免费档真实窗口可能小得多（issue #9）。回调而不是快照：
   * 用户在设置里改完，下一句话就该用新值，不必等下一轮模型发现。
   */
  contextWindowOverrides?: () => Readonly<Record<string, number>> | undefined
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  iam_stale: 401,
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
 * 「一个账号都选不出来」时的报错：把真实原因说清 —— 是禁用（附最后错误）、冷却
 * （附剩余秒数），还是本地槽位全满。以前三种都回同一句「没有可用账号」，禁用那
 * 种还把真因（比如 billion-context 本地拒签的 403）整个吞掉（issue #1）。
 *
 * 全部被禁用时回 401（宿主只自动重试 429，401 一次就把「去重新登录」说清）；
 * 只要还有会自己恢复的（冷却/槽位满）就回 429，宿主重试有概率直接救回来。
 */
function noAccountError(
  accounts: readonly AccountRuntime[],
  pausedIds: readonly string[] = [],
): { status: number; kind: string; message: string } {
  const now = Date.now()
  const paused = new Set(pausedIds)
  const disabled = accounts.filter(a => a.disabled)
  const cooling = accounts.filter(a => !a.disabled && now < a.coolUntil)
  const idleButPaused = accounts.filter(a => !a.disabled && now >= a.coolUntil && paused.has(a.id))
  // 健康、没暂停却没被选中：唯一剩下的原因就是本地槽位满了（pick/acquire 只拦这个）。
  const busy = accounts.filter(a => !a.disabled && now >= a.coolUntil && !paused.has(a.id))
  const parts: string[] = []
  if (disabled.length > 0) {
    const reasons = disabled
      .map(a => (a.lastError === undefined ? a.id : `${a.id}（${a.lastError.slice(0, 120)}）`))
      .join('、')
    parts.push(`${disabled.length} 个被禁用：${reasons}——请到设置卡片重新登录（若在用 billion-context，先检查它的 resign 配置）`)
  }
  if (cooling.length > 0) {
    const secs = Math.max(1, Math.ceil((Math.min(...cooling.map(a => a.coolUntil)) - now) / 1000))
    parts.push(`${cooling.length} 个在短时冷却中（约 ${secs} 秒后恢复）`)
  }
  if (idleButPaused.length > 0) {
    parts.push(`${idleButPaused.length} 个已被暂停（在卡片上取消暂停即可恢复）`)
  }
  if (busy.length > 0) {
    parts.push(`${busy.length} 个的本地并发槽位已满（每账号最多 ${busy[0]?.maxConcurrent ?? 2} 个在飞请求）`)
  }
  // 只是「都在忙」时别说成「没有账号」：账号是好的，只是被长响应占着。这句话
  // 会被用户和 DSH 都当成故障信号（issue #8）。
  const onlyBusy = disabled.length === 0 && cooling.length === 0 && idleButPaused.length === 0 && busy.length > 0
  const message = onlyBusy
    ? `codearts 账号忙：${parts.join('；')}，已等待仍没有空位，请稍后重试`
    : `codearts 当前没有可用账号：${parts.join('；')}`
  return disabled.length === accounts.length
    ? { status: 401, kind: 'session_dead', message }
    : { status: 429, kind: 'soft_rate', message }
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

/**
 * 一次请求最多把 max_tokens 降几档（65536 → 32768 → 16384 → 8192）。
 *
 * 到地板后还会再进循环一次 —— 那一次不再重发，而是把「其实是上下文装不下」
 * 报出来并学习窗口上界（见 `openWithCeilingHeal`）。
 */
const MAX_CEILING_HEALS = 3
/**
 * 一次请求最多试几个账号：clamp(可用账号数, ROTATE_MIN_ATTEMPTS, ROTATE_MAX_ATTEMPTS)。
 *
 * 原来固定试 3 个（与 Go 参考的 MaxRotate 一致）。多号才是这个插件的核心场景：
 * 5 个号时前 3 个在这一轮里都新报了并发上限，第 4 个明明空着也轮不到，只能落到
 * 下面那根「原地排队等 52 秒」的稻草上 —— 那 52 秒本来是可以绕开的。
 *
 * 上界 6 只是次数天花板，真正的刹车是 CAP_WAIT_LIMIT 那个共用截止点：每次尝试都要
 * 挂号 + 开一次流，号再多也不能无限试下去。
 */
const ROTATE_MIN_ATTEMPTS = 3
const ROTATE_MAX_ATTEMPTS = 6
/** 开始下一次尝试前必须留下的预算：一次挂号短探（默认 5 秒）再加一次开流。 */
const ATTEMPT_RESERVE_MS = 20_000
/**
 * 一次请求在「换号轮换 + 回落到同一账号原地重发」上总共能花的墙上时间，从进入
 * 轮换起算，两段共用一个截止点。
 *
 * 2026-09-30 实测：一个上游会话要 ~52s 才被释放，而且**中途打断并不减免** ——
 * 只跑了 98ms 就中止的请求，同样占满一个名额 52s。所以用户「打断 → 马上重问」
 * 时等的就是这个 52s。池里有别的账号时下面会直接换号（不用等）；这条是最后一根
 * 稻草，必须盖过 52s，否则用户看到的不是「稍等一下」而是直接失败。
 *
 * 上限受 pi-ai 的 90s idle 超时约束：等待期间我们发不出任何内容，超过 90s 用户
 * 看到的就是超时。75s 给 52s 留了余量，也还在 90s 之内。以前这个预算只归兜底那一段
 * 自己，轮换花掉的时间是额外加的，多号最坏能顶穿 90s —— 所以现在是共用截止点。
 */
const CAP_WAIT_LIMIT = 75_000
const CAP_RETRY_GAP = 3_000
/** 上游回「排队」拒绝后的首次退避，之后翻倍（5s → 10s → 20s → 30s）。 */
const QUEUE_RETRY_GAP = 5_000
/**
 * 「排队时一直等到轮到」开关打开后替用户挂多久。
 *
 * 默认关（卡片「显示」页）：这一段会提前打开 SSE 并每 20 秒发一个空帧保活，
 * 等待期间界面上已经开始「回复」了 —— 属于用户应当主动选择的行为。
 */
const QUEUE_WAIT_LIMIT_MS = 15 * 60_000
/** 空帧间隔：宿主按「可解析的流事件」算 90 秒空闲，20 秒留足余量。 */
const QUEUE_HEARTBEAT_MS = 20_000
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

/**
 * 最近几帧 usage 的**原始内容**，最新在前。
 *
 * 存这个不是为了统计，而是为了回答一个只能靠证据回答的问题：上游到底给没给缓存
 * 字段、叫什么名字。账本里的 `cachedTokens` 恒为 0 有两种可能 —— 没命中，或者上游
 * 压根没这个字段 —— 界面分不出来，只有把原帧摊开看才知道。走 `/api/codearts/debug`
 * 读，重启即清；只保留最近几帧，不落盘。
 */
export interface UsageShapeSummary {
  at: number
  accountId: string
  model: string
  usage: Record<string, unknown>
}

const recentUsages: UsageShapeSummary[] = []
/** 探针只留最近 5 帧：够看形状，又不至于把内存堆成日志。 */
const USAGE_PROBE_LIMIT = 5

/** 最近的 usage 原帧，最新在前。 */
export function recentUsageShapes(): readonly UsageShapeSummary[] {
  return [...recentUsages].reverse()
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
  const debug = options.debug
  /**
   * 本地槽位满时的等待预算。
   *
   * 以前「本地 2 个槽位都占着」立刻回 429「没有可用账号」，而 DSH 的 llm-retry 对
   * soft_rate 只有 5 次 / 最长 10s 间隔，熬不过一段流式响应 ⇒ 并发派发（一次 5 个
   * subagent）必然有请求整轮失败（issue #8）。改成先等槽位释放，等不到再报错。
   * 30 秒上限：pi-ai 的 90 秒 idle 超时还没有开始计时（我们连响应头都没发）。
   */
  const LOCAL_SLOT_WAIT_MS = 30_000
  const localSlotWaitBudgetMs = options.localSlotWaitMs ?? LOCAL_SLOT_WAIT_MS
  const queueRetryGapMs = options.queueRetryGapMs ?? QUEUE_RETRY_GAP
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

  /**
   * 该模型当前应使用的上下文窗口：用户覆盖优先于目录值，再被进程内学到的上界往下钳。
   *
   * 学到的上界来自「max_tokens 已到地板仍被判参数非法」的实测（issue #9）。必须在这里
   * 生效 —— 只改目录不够，目录要等下一轮发现，而用户下一句话马上就来。
   * 返回 0 表示查不到该模型，不做超长预判。
   */
  function contextWindowFor(id: string): number {
    const lower = id.trim().toLowerCase()
    let discovered = 0
    for (const model of catalog.current()) {
      if (model.id.toLowerCase() === lower) {
        discovered = model.contextWindow
        break
      }
    }
    const override = contextWindowOverrideFor(options.contextWindowOverrides?.(), lower)
    const base = override ?? discovered
    const learned = learnedContextWindowFor(lower)
    const window = learned === undefined ? base : Math.min(base, learned)
    return window > 0 ? window : 0
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
      const headText = head === undefined ? undefined : new TextDecoder().decode(head)
      // 首帧就是限流错误（TPM 实测是 HTTP 200 + 流内 error_code）：此时一个字都没
      // 吐出来，重发是安全的。必须在这里降级成真正的请求失败，交给下面的排队逻辑；
      // 否则错误会被当成正常流转发，DSH 侧只看到一句英文 PI_AI_ERROR。
      const rate = headText === undefined ? undefined : rateLimitFrame(headText)
      if (rate !== undefined) {
        reader.releaseLock()
        await result.stream.cancel().catch(() => {})
        logger?.warn(`dsh-codearts: ${prepared.model} 首帧被判限流（${rate.code}），进入本地排队`)
        return { prepared, result: { ok: false, kind: 'soft_rate', status: 429, message: `${rate.code}: ${rate.message}` } }
      }
      // 排队拒绝同样要赶在转发之前认出来：一个字都没吐出去，退避重发是安全的。
      // 归 'client' 而不是 'soft_rate' —— 账号本身完全健康，别让它被冷却（issue #10）。
      const queued = headText === undefined ? undefined : queueFrame(headText)
      if (queued !== undefined) {
        reader.releaseLock()
        await result.stream.cancel().catch(() => {})
        logger?.warn(`dsh-codearts: ${prepared.model} 首帧被判排队，本地退避重发`)
        return { prepared, result: { ok: false, kind: 'client', status: 400, message: `queued: ${queued.message}` } }
      }
      // 凭据失效 / 模型无权限 / 不吃图也都是流内首帧，与限流同样绕过了 classify()。
      // 必须在转发之前认出来：凭据失效要能强制续期后重发，另外两种要翻成人话。
      const upstreamError = headText === undefined ? undefined : firstFrameError(headText)
      if (upstreamError !== undefined) {
        const detail = `${upstreamError.code}: ${upstreamError.message}`.replace(/^: /, '')
        if (isIamTokenError(detail) || isModelNotAccessible(detail) || isNotMultimodal(detail)) {
          reader.releaseLock()
          await result.stream.cancel().catch(() => {})
          logger?.warn(`dsh-codearts: ${prepared.model} 首帧报上游错误（${detail.slice(0, 160)}）`)
          if (isModelNotAccessible(detail)) {
            markModelUnavailable(prepared.model, modelUnavailableReasonText(detail))
          }
          const kind: UpstreamErrorKind = isIamTokenError(detail)
            ? 'iam_stale'
            : isModelNotAccessible(detail)
              ? 'not_found'
              : 'client'
          return { prepared, result: { ok: false, kind, status: KIND_STATUS[kind], message: detail } }
        }
      }
      // 只有「带 max_tokens、还有降档空间」的请求才值得重发：没有 max_tokens（或连
      // prompt 都估不出来）的请求，降 max_tokens 解决不了任何问题，只会白撞上游。
      // 已经在地板时多放一次机会进来 —— 那一次不是重发，而是把「其实装不下」说出来。
      const atFloor = maxTokensCeilingFor(prepared.model) <= MAX_TOKENS_FLOOR
      const shouldHeal = prepared.promptTokens > 0
        && headText !== undefined
        && isParamInvalidFrame(headText)
        && (heal < MAX_CEILING_HEALS || atFloor)
      reader.releaseLock()
      if (!shouldHeal) return { prepared, result, head }
      await result.stream.cancel().catch(() => {})
      if (degradeTokenCeiling(prepared.model) === 0) {
        // max_tokens 已经到地板还被判参数非法 ⇒ 不是 max_tokens 的问题，是 prompt 装不下。
        // 把本次估算记成该模型的真实窗口上界（下一轮守卫会直接拦下来），并把报错指向
        // 上下文 —— 继续让用户看到「max_tokens」只会把他引到重发/换号上（issue #9）。
        if (prepared.promptTokens > 0) {
          const learned = learnContextWindow(prepared.model, prepared.promptTokens)
          logger?.warn(
            `dsh-codearts: ${prepared.model} 在 max_tokens 地板仍被判参数非法，按本次 prompt 估算 ${prepared.promptTokens} tokens 学习窗口上界 ${learned}`,
          )
        }
        const estimate = prepared.promptTokens > 0 ? `本次 prompt 估算约 ${prepared.promptTokens} tokens，` : ''
        return {
          prepared,
          result: {
            ok: false,
            kind: 'client',
            status: 400,
            message: `${prepared.model}: 上下文放不下 —— ${estimate}max_tokens 已降到 ${MAX_TOKENS_FLOOR} 仍被上游判参数非法。请压缩上下文（/compact）或新建会话；如果目录里的窗口值不准，可在设置里覆盖该模型的 contextWindow。`,
          },
        }
      }
      logger?.warn(`dsh-codearts: ${prepared.model} 被判参数非法，max_tokens 降档到 ${maxTokensCeilingFor(prepared.model)} 后重发`)
    }
  }

  /**
   * 在**同一个账号**上重发，直到不再被限流或预算耗尽。
   *
   * `untilAt` 由调用方给：它和前面的换号轮换是同一个截止点，不是这段自己重新起算，
   * 否则两段各自 75s 会顶穿宿主的 90s 流空闲超时。
   *
   * 并发槽位是账号级的：有别的号就该换号，等 52s 是最后手段。
   * TPM 是模型级配额：换号只是换个账号撞同一堵墙，只能原地等窗口滑过去 ——
   * 间隔逐次翻倍（3s → 6s → 12s → 24s，封顶 30s），避免在配额已经满的时候
   * 把重试本身也打成一波流量。
   *
   * 「排队」拒绝（issue #10）同理：上游让等一会儿再来，从 5 秒起翻倍重发；
   * 这段等待发生在 POST 被拒之后 —— 还没写给宿主任何字节，重发安全。
   *
   * 命中限流不甩给 pi-ai：429 会被重试 5 次，每次再撞一次限流，越试越满。
   */
  async function openStream(
    credential: CodeArtsResolved,
    raw: string,
    contextWindow: number,
    signal: AbortSignal,
    untilAt: number,
  ): Promise<{ prepared: PreparedChatBody; result: ChatResult; head?: Uint8Array; waitedMs: number }> {
    const started = Date.now()
    let gap = CAP_RETRY_GAP
    let queueGap = queueRetryGapMs
    for (;;) {
      const opened = await openWithCeilingHeal(credential, raw, contextWindow, signal)
      const waitedMs = Date.now() - started
      if (opened.result.ok || signal.aborted) return { ...opened, waitedMs }
      if (!isQueueableRate(opened.result)) return { ...opened, waitedMs }
      if (isTpmLimit(opened.result)) gap = Math.min(gap * 2, 30_000)
      if (isQueueReject(opened.result)) {
        gap = queueGap
        queueGap = Math.min(queueGap * 2, 30_000)
      }
      if (Date.now() + gap > untilAt) return { ...opened, waitedMs }
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
    /** 首字延迟的起点：从读完请求头就开始算，排队与换号的时间都算「用户等了多久」。 */
    const requestStartedAt = Date.now()
    if (!isJsonContentType(req)) {
      usage?.noteFailure('media_type')
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
      usage?.noteFailure('context_overflow')
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
      const all = await store.ids()
      const paused = new Set(await store.pausedIds())
      pool.sync(all)
      pool.setPaused([...paused])
      pool.setPreferred(await store.pinnedIds())
      ids = all.filter(id => !paused.has(id))
    } catch (error: unknown) {
      usage?.noteFailure('not_signed_in')
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }
    if (ids.length === 0) {
      usage?.noteFailure('not_signed_in')
      writeOpenAIError(res, 401, 'not_signed_in', 'no CodeArts account stored; sign in from the CodeArts settings card')
      return
    }
    pool.sync(ids)

    // 先按账号轮换：某个账号的会话槽位被占（要 ~52s 才释放）就换下一个用，
    // 而不是让用户干等 —— 这正是「打断后重新提问」卡住的根因。
    const tried = new Set<string>()
    /** 已经为它强制续期过一次的账号：同一个号只重试一次，避免把 refresh_token 连烧。 */
    const refreshed = new Set<string>()
    let cappedAccount: string | undefined
    let tpmAccount: string | undefined
    let queuedAccount: string | undefined
    let queueWaitedMs = 0
    let localSlotWaitedMs = 0
    let lastKind: UpstreamErrorKind | undefined
    let lastAccountId: string | undefined
    let lastStatus = 0
    let lastMessage = ''

    // 轮换与下面的兜底排队共用这一个截止点。
    const rotateDeadline = Date.now() + CAP_WAIT_LIMIT
    const attempts = Math.min(Math.max(ids.length, ROTATE_MIN_ATTEMPTS), ROTATE_MAX_ATTEMPTS)
    /** 日志里区分并发请求；没开调试时不生成。 */
    const requestTag = debug === undefined ? '' : randomBytes(3).toString('hex')

    /**
     * 两轮：第一轮按账号轮换；如果全被「本地槽位满」挡住，就等一个槽位空出来
     * 再跑第二轮。以前这里直接落到「没有可用账号」的 429，并发派发（一次 5 个
     * subagent）必然误伤（issue #8）。
     */
    for (let round = 0; round < 2; round += 1) {
      tried.clear()
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        // 剩下的预算还得够过一次挂号短探（queue.ts 的 maxWaitMs 默认 5 秒）和一次开流，
        // 否则这一试自己就会把截止点拖过去，比直接报错更糟。
        if (Date.now() + ATTEMPT_RESERVE_MS > rotateDeadline) break
        const id = pool.pick(tried)
        if (id === undefined) break
        tried.add(id)
        if (!pool.acquire(id)) {
          debug?.(`acquire miss req=${requestTag} ${id} active=${pool.get(id)?.activeConcurrent ?? '?'}/${pool.get(id)?.maxConcurrent ?? '?'}`)
          continue
        }
        debug?.(`acquire ok req=${requestTag} ${id} active=${pool.get(id)?.activeConcurrent ?? '?'}/${pool.get(id)?.maxConcurrent ?? '?'}`)
        try {
          const credential = await store.resolve(id)
          if (credential === undefined) {
            pool.disable(id, 'no credential')
            continue
          }
          // 挂号只用来提示（底部积分条显示「排队第 N 位」）：实测 chat 请求并不校验
          // 这张票 —— 拿第 535 位的票去 POST，942ms 就开流了。没轮到也照发；
          // 以前在这里白等 20 秒再回 400，就是 issue #10 里那个失败。
          if (queue !== undefined) {
            const gate = await queue.wait(credential, checked.chatId, checked.model, controller.signal)
            if (controller.signal.aborted) return
            if (gate.kind !== 'working') debug?.(`queue ${gate.kind} req=${requestTag} ${id}`)
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
            await pipeToResponse(res, result.stream, controller.signal, { accountId: id, model: prepared.model, startedAt: requestStartedAt }, opened.head)
            return
          }
          lastKind = result.kind
          lastAccountId = id
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
          if (isQueueReject(result)) {
            // 上游让「等一会儿再来」：账号和模型都没坏，交给下面的兜底原地退避重发。
            queuedAccount = id
            break
          }
          if (result.kind === 'iam_stale') {
            // token 可能被提前作废，而 expiration 还写着几小时后：强制续期一次，
            // 然后让同一个号再试一次。续期失败时 `forceRefresh` 返回 undefined，
            // 不会像 1.3.0 那样拿同一份死 token 再白打一次上游（issue #8）。
            if (!refreshed.has(id)) {
              refreshed.add(id)
              logger?.warn(`dsh-codearts: ${id} 的 IAM token 被判失效，强制续期后重试`)
              const next = await store.forceRefresh(id, credential.token)
              if (next !== undefined) {
                tried.delete(id)
                continue
              }
            }
            pool.cooldown(id, SERVER_COOLDOWN_MS, result.message)
            continue
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
          debug?.(`release req=${requestTag} ${id} active=${pool.get(id)?.activeConcurrent ?? '?'}/${pool.get(id)?.maxConcurrent ?? '?'}`)
        }
      }

      if (lastKind !== undefined || controller.signal.aborted) break
      // 一个号都没选出来：先分辨是不是「全都只是本地槽位满」。是的话等一个槽位
      // 空出来再跑一轮；预算从共用截止点里扣，等待期间不占任何槽位。
      if (!pool.hasBusyWaitable()) break
      const waitBudget = Math.min(localSlotWaitBudgetMs, rotateDeadline - ATTEMPT_RESERVE_MS - Date.now())
      if (waitBudget <= 0) break
      const waitingSince = Date.now()
      debug?.(`slot wait start req=${requestTag} budget=${waitBudget}ms pool=${pool.list().map(a => `${a.id}:${a.activeConcurrent}/${a.maxConcurrent}`).join(',')}`)
      const got = await pool.waitForFreeSlot(waitBudget, controller.signal)
      localSlotWaitedMs += Date.now() - waitingSince
      debug?.(`slot wait ${got ? 'done' : 'timeout'} req=${requestTag} waited=${Date.now() - waitingSince}ms`)
      if (!got) break
    }

    if (controller.signal.aborted) return

    // 「排队时一直等到轮到」（卡片开关，默认关）：上游明确回排队拒绝时，短退避
    // 换个号也救不了，唯一能做的就是等这张票。见 waitForQueueTurn。
    if (queuedAccount !== undefined && options.waitInQueue?.() === true) {
      await waitForQueueTurn(queuedAccount)
      return
    }

    // 所有账号都撞在上限上：挑一个号原地排队等限流解除。单号时这是唯一的兜底；
    // 号超过尝试次数（>6）时剩下的号这一轮没被碰过，也是走这里排队 —— 那部分靠
    // LRU 在请求之间轮转覆盖（acquire 会推 lastUsed）。
    // 截止点跟轮换共用，所以前面耗掉的时间会从这里的等待里扣掉。
    const queueAccount = cappedAccount ?? tpmAccount ?? queuedAccount
    if (queueAccount !== undefined) {
      if (pool.acquire(queueAccount)) {
        // 上限降档在主循环里已经跑过（learned 表是进程内共享的），这里不再重跑，
        // 只沿用排队等槽位的兜底。
        try {
          const credential = await store.resolve(queueAccount)
          if (credential !== undefined) {
            const opened = await openStream(credential, raw, contextWindow, controller.signal, rotateDeadline)
            const { result } = opened
            queueWaitedMs = opened.waitedMs
            // 同上：客户端主动中止不算账号故障，不要拿它去回写池状态。
            if (controller.signal.aborted) {
              if (result.ok) await result.stream.cancel().catch(() => {})
              return
            }
            if (result.ok) {
              // 先量样本再复位：noteSuccess 会把 lastCapAt 清零。
              // 这一条是「撞上限后在同一请求里排队等到槽位」，正好是这个号释放槽位的
              // 实测时长；主循环里的普通成功不能当这个样本（见 pool.noteCapRelease）。
              pool.noteCapRelease(queueAccount)
              pool.noteSuccess(queueAccount)
              await pipeToResponse(res, result.stream, controller.signal, { accountId: queueAccount, model: opened.prepared.model, startedAt: requestStartedAt }, opened.head)
              return
            }
            lastKind = result.kind
            lastAccountId = queueAccount
            lastStatus = result.status
            lastMessage = result.message
          }
        } finally {
          pool.release(queueAccount)
        }
      }
    }

    if (lastKind === undefined) {
      const none = noAccountError(pool.list(), pool.pausedIds())
      usage?.noteFailure(none.kind)
      writeOpenAIError(res, none.status, none.kind, none.message)
      return
    }
    // 排队等过就明说等过多久：否则用户不知道插件已经努力过，只会觉得「又失败了」。
    const explanation = upstreamErrorMessage(lastMessage, lastStatus)
    const waits: string[] = []
    if (queueWaitedMs >= 1_000) waits.push(`排队重试 ${Math.round(queueWaitedMs / 1000)} 秒`)
    if (localSlotWaitedMs >= 1_000) waits.push(`等本地槽位 ${Math.round(localSlotWaitedMs / 1000)} 秒`)
    const waited = waits.length > 0 ? `（本地已${waits.join('、')}）` : ''
    const failedKind = isQueueRejectText(lastMessage) ? 'queued' : lastKind
    usage?.noteFailure(failedKind, lastAccountId)
    writeOpenAIError(res, KIND_STATUS[lastKind], failedKind, `${explanation}${waited}`)

    /**
     * 「一直等到轮到」：提前开流保住宿主连接，轮询这张票直到 working，再发请求。
     *
     * 和上面的兜底通道有一个本质区别：响应头已经发出去了，后面任何失败都**不能再
     * 换号、也不能回 HTTP 状态码**，只能以流内错误帧交代。所以只有上游明确回排队
     * 拒绝时才会走到这里 —— 那时换别的号去撞同一张票也没有意义。
     */
    async function waitForQueueTurn(id: string): Promise<void> {
      const gate = queue
      if (gate === undefined) return
      const credential = await store.resolve(id)
      if (credential === undefined) return
      const waitStartedAt = Date.now()
      const heartbeat = startHeartbeat(checked.model)
      try {
        const verdict = await gate.wait(credential, checked.chatId, checked.model, controller.signal, QUEUE_WAIT_LIMIT_MS)
        if (controller.signal.aborted || verdict.kind === 'aborted') return
        if (verdict.kind !== 'working') {
          usage?.noteFailure(verdict.kind === 'error' ? 'queued' : verdict.kind, id)
          failStream(
            res,
            verdict.kind === 'queued'
              ? `等了 ${Math.round(QUEUE_WAIT_LIMIT_MS / 60_000)} 分钟仍未轮到（第 ${verdict.position} 位，共 ${verdict.length} 条）。请稍后重试，或临时切换模型。`
              : verdict.message,
          )
          return
        }
        let acquired = pool.acquire(id)
        if (!acquired) {
          const freed = await pool.waitForFreeSlot(10_000, controller.signal)
          acquired = freed && pool.acquire(id)
        }
        if (!acquired) {
          failStream(res, '轮到排队后本地账号槽位仍被占用，请稍后重试。')
          return
        }
        try {
          const opened = await openStream(credential, raw, contextWindow, controller.signal, Date.now() + 60_000)
          queueWaitedMs = opened.waitedMs
          if (controller.signal.aborted) {
            if (opened.result.ok) await opened.result.stream.cancel().catch(() => {})
            return
          }
          if (opened.result.ok) {
            pool.noteSuccess(id)
            await pipeToResponse(res, opened.result.stream, controller.signal, { accountId: id, model: opened.prepared.model, startedAt: requestStartedAt }, opened.head)
            return
          }
          usage?.noteFailure(isQueueReject(opened.result) ? 'queued' : opened.result.kind, id)
          const waitedSec = Math.round((Date.now() - waitStartedAt) / 1000)
          const suffix = waitedSec >= 1 ? `（本地已排队 ${waitedSec} 秒）` : ''
          failStream(res, `${upstreamErrorMessage(opened.result.message, opened.result.status)}${suffix}`)
        } finally {
          pool.release(id)
        }
      } finally {
        heartbeat.stop()
      }
    }

    /**
     * 等待期间的空帧：宿主只看「可解析的流事件」续空闲计时（SSE 注释不算），
     * 空 delta 不产生任何可见文字，但足以让连接活着。
     */
    function startHeartbeat(model: string): { stop: () => void } {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
      }
      const beat = (): void => {
        if (!res.writable || res.writableEnded) return
        res.write(`data: ${JSON.stringify({
          id: 'codearts-queue',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
        })}\n\n`)
      }
      beat()
      const timer = setInterval(beat, QUEUE_HEARTBEAT_MS)
      timer.unref?.()
      return { stop: () => clearInterval(timer) }
    }

    /** 响应头已经发出之后的失败：只能作为流内错误帧交代，不能再改状态码。 */
    function failStream(response: ServerResponse, message: string): void {
      if (!response.writable || response.writableEnded) return
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
        error: { code: 'queued', message },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
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
    attribution?: { accountId: string; model: string; startedAt?: number },
    head?: Uint8Array,
  ): Promise<void> {
    // 「一直等到轮到」会在等票期间先发头 + 空帧保活；那时这里不能再写一次头。
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
    }
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
    /** 首个真正写出的帧记一次 TTFT；之后不再记。 */
    let firstFrame = true
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
          if (res.writable) {
            if (firstFrame) {
              firstFrame = false
              if (usage !== undefined && attribution?.startedAt !== undefined) {
                usage.noteLatency(Date.now() - attribution.startedAt)
              }
            }
            res.write(frame + '\n\n')
          }
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
          // 留一份原样副本给 /debug：字段名就是答案，只留最近几帧。
          recentUsages.push({
            at: Date.now(),
            accountId: attribution.accountId,
            model: attribution.model,
            usage: parsed.usage,
          })
          while (recentUsages.length > USAGE_PROBE_LIMIT) recentUsages.shift()
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
