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
  prepareChatBody,
  chatStream,
  isConcurrencyCap,
  type ChatResult,
  type CodeArtsResolved,
  type UpstreamErrorKind,
} from './upstream.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'

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
const MAX_ROTATE = 3
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
 * 在**同一个账号**上重发，直到不再撞上限或预算耗尽。
 *
 * 只在没有别的账号可选时使用 —— 等 52s 是最后手段，能换号就换号。
 * 命中上限不甩给 pi-ai：429 会被重试 5 次，每次再去要一个会话，越试越满。
 */
async function openStream(
  credential: CodeArtsResolved,
  prepared: { url: string; body: string; model: string; chatId?: string },
  signal: AbortSignal,
): Promise<ChatResult> {
  const until = Date.now() + CAP_WAIT_LIMIT
  for (;;) {
    const result = await chatStream(credential, prepared, signal)
    if (result.ok) return result
    const worthWaiting = isConcurrencyCap(result) && !signal.aborted && Date.now() + CAP_RETRY_GAP <= until
    if (!worthWaiting) return result
    await sleep(CAP_RETRY_GAP)
  }
}

export function createCodeArtsShim(options: CodeArtsShimOptions): CodeArtsShim {
  const { store, catalog } = options
  const logger = options.logger
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

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)
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
        const result = await chatStream(credential, prepared, controller.signal)
        if (result.ok) {
          pool.noteSuccess(id)
          if (controller.signal.aborted) {
            // 断开发生在等上游响应头期间：把上游连接释放掉再走人。
            await result.stream.cancel().catch(() => {})
            return
          }
          await pipeToResponse(res, result.stream, controller.signal)
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

    // 所有账号都撞在上限上：回到单账号时代的做法 —— 挑一个号原地排队等槽位释放。
    // 多账号时走不到这里；单账号时这是唯一的兜底。
    if (cappedAccount !== undefined) {
      if (pool.acquire(cappedAccount)) {
        try {
          const credential = await store.resolve(cappedAccount)
          if (credential !== undefined) {
            const result = await openStream(credential, prepared, controller.signal)
            if (result.ok) {
              pool.noteSuccess(cappedAccount)
              if (controller.signal.aborted) {
                await result.stream.cancel().catch(() => {})
                return
              }
              await pipeToResponse(res, result.stream, controller.signal)
              return
            }
            lastKind = result.kind
            lastStatus = result.status
            lastMessage = result.message
          }
        } finally {
          pool.release(cappedAccount)
        }
      }
    }

    if (lastKind === undefined) {
      writeOpenAIError(res, 429, 'soft_rate', 'codearts 当前没有可用账号（全部被禁用或冷却中），请稍后重试')
      return
    }
    writeOpenAIError(
      res,
      KIND_STATUS[lastKind],
      lastKind,
      `codearts upstream ${lastKind} (http ${lastStatus}): ${lastMessage.slice(0, 400)}`,
    )
  }

  /** 把上游 SSE 按事件边界转发给 DSH，直到流结束或被中止。 */
  async function pipeToResponse(
    res: ServerResponse,
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
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
    // 上游流里可能已经带了终止帧（openAIDone）。收尾时只在没写过的情况下补，
    // 否则下游会连续收到两个 data: [DONE]。
    let sawDone = false
    const finish = (): void => {
      if (!res.writable || res.writableEnded) return
      res.end(sawDone ? undefined : 'data: [DONE]\n\n')
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          finish()
          return
        }
        buf += decoder.decode(value, { stream: true })
        // 按 SSE 事件边界（空行）切分
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (!frame) continue
          if (frame.trim() === 'data: [DONE]') sawDone = true
          if (res.writable) res.write(frame + '\n\n')
        }
      }
    } catch (error: unknown) {
      // 用户点「停止生成」也会走到这里，那不是故障，别刷日志。
      if (!signal.aborted) {
        logger?.warn('dsh-codearts: upstream stream failed mid-flight', error)
      }
      finish()
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
