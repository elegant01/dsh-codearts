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
import type { CodeArtsCredentialStore } from './auth.ts'
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
  store: CodeArtsCredentialStore
  catalog: CodeArtsCatalog
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

/**
 * 上游免费档只允许 3 个并发会话（实测 TM.00001041）。闸门设 2：给 CodeArts 网页端
 * 留一个坑，别让我们把账号占满。
 */
const UPSTREAM_SLOTS = 2
/**
 * 撞上限后在本地排队重发的上限。
 *
 * 2026-09-30 实测：一个上游会话要 ~52s 才被释放，而且**中途打断并不减免** —— 只跑了
 * 98ms 就中止的请求，同样占满一个名额 52s。所以用户「打断 → 马上重问」时，等的
 * 就是这个 52s。预算必须盖过它，否则用户看到的不是「稍等一下」，而是直接失败。
 *
 * 上限受 pi-ai 的 90s idle 超时约束：等待期间我们发不出任何内容，超过 90s 用户
 * 看到的就是超时。75s 给 52s 留了余量，也还在 90s 之内。
 */
const CAP_WAIT_LIMIT = 75_000
const CAP_RETRY_GAP = 3_000
/** 排队等坑的上限。超过就明确失败，不能让请求无界堆在队列里。 */
const SLOT_WAIT_LIMIT = 60_000

let slotsInUse = 0
const slotQueue: Array<() => void> = []

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 占一个上游会话坑；满了就排队。排队超时或客户端已走则返回 null ——
 * 闸门自己不能变成新的死锁源。成功时返回幂等的释放函数。
 */
function acquireSlot(signal: AbortSignal): Promise<(() => void) | null> {
  return new Promise(resolve => {
    let settled = false
    const cleanup = (): void => {
      const at = slotQueue.indexOf(grant)
      if (at >= 0) slotQueue.splice(at, 1)
      clearTimeout(timer)
      signal.removeEventListener('abort', giveUp)
    }
    const grant = (): void => {
      if (settled) return
      settled = true
      cleanup()
      slotsInUse += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        slotsInUse -= 1
        slotQueue.shift()?.()
      })
    }
    const giveUp = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(null)
    }
    const timer = setTimeout(giveUp, SLOT_WAIT_LIMIT)
    signal.addEventListener('abort', giveUp, { once: true })
    if (slotsInUse < UPSTREAM_SLOTS) grant()
    else slotQueue.push(grant)
  })
}

/**
 * 打开上游流。命中并发上限时不把它甩给 pi-ai —— 429 会被重试 5 次，每次再去要
 * 一个会话，越试越满 —— 而是在本地排队重发；等不到才原样返回错误。
 * 客户端中途离开就不再空等。
 */
async function openStream(
  credential: CodeArtsResolved,
  prepared: { url: string; body: string; model: string },
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
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }
    if (credential === undefined) {
      writeOpenAIError(res, 401, 'not_signed_in', 'no CodeArts token stored; paste a cloud_dragon_token in the plugin settings')
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

    // 一个坑 = 一个上游会话。拿不到就排队等，别放出去撞 400 或静默。
    const releaseSlot = await acquireSlot(controller.signal)
    if (releaseSlot === null) {
      if (!controller.signal.aborted) {
        writeOpenAIError(
          res,
          429,
          'soft_rate',
          `codearts 并发会话排队超时（上游免费档只允许 ${UPSTREAM_SLOTS + 1} 个并发会话），请稍后重试`,
        )
      }
      return
    }
    try {
      const result = await openStream(credential, prepared, controller.signal)
      if (!result.ok) {
        writeOpenAIError(
          res,
          KIND_STATUS[result.kind],
          result.kind,
          `codearts upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`,
        )
        return
      }
      if (controller.signal.aborted) {
        // 断开发生在等上游响应头期间：把上游连接释放掉再走人。
        await result.stream.cancel().catch(() => {})
        return
      }
      await pipeToResponse(res, result.stream, controller.signal)
    } finally {
      releaseSlot()
    }
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
