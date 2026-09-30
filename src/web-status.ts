/**
 * Same-origin status + token routes for the CodeArts card.
 *
 * Minimal surface vs dsh-codebuddy-cli: no credits, no check-in, no multi-account.
 * The browser half calls these to read sign-in state / model list and to write
 * or clear the pasted `cloud_dragon_token`. The route answers loopback browser
 * requests only and never returns token material.
 *
 * @module dsh-codearts/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CodeArtsCredentialStore } from './auth.ts'
import type { CodeArtsCatalog, CodeArtsModelInfo } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { filterEnabledModels, isBenefitModel } from './catalog.ts'
import { startLogin, type LoginSession } from './oauth.ts'

/** Route paths (same-origin under the DSH web origin). */
export const CODEARTS_STATUS_PATH = '/api/codearts/status'
export const CODEARTS_MODELS_PATH = '/api/codearts/models'
export const CODEARTS_MODELS_SELECTION_PATH = '/api/codearts/enabled-models'
export const CODEARTS_TOKEN_PATH = '/api/codearts/token'
export const CODEARTS_LOGIN_PATH = '/api/codearts/login'
export const CODEARTS_LOGIN_STATUS_PATH = '/api/codearts/login/status'

/** 勾选 UI 的一个选项。 */
export interface CodeArtsModelChoice {
  id: string
  name: string
  /** 限时福利（免费）模型。 */
  free?: boolean
}

/** enabled-models 路由返回的 selection 文档（与 codebuddy 的 shape 对齐）。 */
export interface CodeArtsModelSelection {
  choices: { id: string; name: string; enabled: boolean; free?: boolean }[]
  /** 已选子集是否小于全集（卡片据此显示不同提示）。 */
  restricted: boolean
  /** 是否可写（无 settings provider 时为 false，卡片只读）。 */
  writable: boolean
}

/**
 * 由完整目录 + 已存 enabled 计算 selection。
 * - enabled 为空/未存 => 全部勾选（restricted=false）
 * - enabled 为非空列表 => 仅勾选其中的（restricted=true），缺的按未勾选
 * 福利模型用 catalog 的 benefit 标记（这里靠 model.free 字段，由调用方注入）。
 */
export function selectionOf(
  models: readonly CodeArtsModelChoice[],
  enabled: readonly string[] | undefined,
  writable: boolean,
): CodeArtsModelSelection {
  const allowed = new Set(enabled ?? [])
  const restricted = enabled !== undefined && enabled.length > 0
  const choices = models.map(m => ({
    id: m.id,
    name: m.name,
    free: m.free,
    enabled: restricted ? allowed.has(m.id) : true,
  }))
  return { choices, restricted, writable }
}

export interface CodeArtsWebStatus {
  status: 'signed-in' | 'signed-out' | 'expired'
  label?: string
  storedAt?: number
  models: readonly CodeArtsWebModelBadge[]
}

export interface CodeArtsWebModelBadge {
  id: string
  name: string
}

export interface CodeArtsStatusRouteOptions {
  store: CodeArtsCredentialStore
  models: () => readonly CodeArtsModelInfo[]
  enabledModels?: () => readonly string[] | undefined
  /**
   * Persist a new allowlist. Resolves false when no settings provider is
   * attached, which the card renders as a read-only selection.
   */
  setEnabledModels?: (ids: readonly string[]) => Promise<boolean>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Build the status document (no token material crosses to the browser). */
async function buildStatus(deps: CodeArtsStatusRouteOptions): Promise<CodeArtsWebStatus> {
  const cred = await deps.store.current()
  const models = deps.models().map(m => ({ id: m.id, name: m.name }))
  if (cred === undefined) {
    return { status: 'signed-out', models }
  }
  const expired =
    cred.stale === true ||
    (typeof cred.expiration === 'string' &&
      Number.isFinite(Date.parse(cred.expiration)) &&
      Date.parse(cred.expiration) <= Date.now())
  if (expired) {
    return {
      status: 'expired',
      ...cred.label === undefined ? {} : { label: cred.label },
      ...cred.storedAt === undefined ? {} : { storedAt: cred.storedAt },
      models,
    }
  }
  return {
    status: 'signed-in',
    ...cred.label === undefined ? {} : { label: cred.label },
    ...cred.storedAt === undefined ? {} : { storedAt: cred.storedAt },
    models,
  }
}

/** GET /api/codearts/status */
function statusHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** GET /api/codearts/models — currently offered model ids (honours allowlist). */
function modelsHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const offered = filterEnabledModels(deps.models(), deps.enabledModels?.())
    json(res, 200, { models: offered.map(m => ({ id: m.id, name: m.name })) })
  }
}

/**
 * GET/POST /api/codearts/enabled-models — 模型勾选的读写。
 * GET 返回 selection（choices + restricted + writable）；POST 接收 {enabledModels}
 * 写入 settings（全选时传空数组表示"全部"）。与 codebuddy 的 /plugins/<id>/enabled-models 对齐。
 */
function modelsSelectionHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      const all = deps.models().map(m => ({ id: m.id, name: m.name, free: isBenefitModel(m.id) }))
      const writable = deps.setEnabledModels !== undefined
      const selection = selectionOf(all, deps.enabledModels?.(), writable)
      json(res, 200, { selection })
      return
    }
    if (req.method === 'POST') {
      if (!deps.setEnabledModels) {
        json(res, 403, { error: 'selection-not-writable' })
        return
      }
      const type = req.headers['content-type']
      if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
        json(res, 415, { error: 'content-type must be application/json' })
        return
      }
      try {
        const body = JSON.parse(await readBody(req)) as { enabledModels?: unknown }
        if (!Array.isArray(body.enabledModels) || !body.enabledModels.every(x => typeof x === 'string')) {
          json(res, 400, { error: 'expected {"enabledModels": string[]}' })
          return
        }
        const ok = await deps.setEnabledModels(body.enabledModels as string[])
        if (!ok) {
          json(res, 403, { error: 'selection-not-writable' })
          return
        }
        const all = deps.models().map(m => ({ id: m.id, name: m.name, free: isBenefitModel(m.id) }))
        const selection = selectionOf(all, deps.enabledModels?.(), true)
        json(res, 200, { selection })
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }
}

/** POST /api/codearts/token { token, label? } — store a pasted token. */
function tokenPostHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    // A state-changing route that writes a credential: gate on Host *and*
    // Origin like every other mutating route. Host alone would let a
    // DNS-rebinding page (attacker origin, loopback Host) store a token.
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const type = req.headers['content-type']
    if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const token = typeof body?.token === 'string' ? body.token.trim() : ''
      if (token === '') {
        json(res, 400, { error: 'expected {"token": string}' })
        return
      }
      const label = typeof body?.label === 'string' && body.label.trim() !== '' ? body.label.trim() : undefined
      await deps.store.set(token, label)
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** DELETE /api/codearts/token — forget the stored token. */
function tokenDeleteHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'DELETE') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      await deps.store.clear()
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the status / models / token routes. */
export function registerCodeArtsStatusRoute(ctx: Context, deps: CodeArtsStatusRouteOptions): void {
  ctx.effect(() => {
    const activeLogins = new Map<string, LoginSession>()
    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_STATUS_PATH,
      handler: statusHandler(deps),
    })
    const disposeModels = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_MODELS_PATH,
      handler: modelsHandler(deps),
    })
    const disposeModelsSelection = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_MODELS_SELECTION_PATH,
      handler: modelsSelectionHandler(deps),
    })
    // 宿主 WebServer 对同一个 (kind, path) 只留一个席位，重复注册会抛
    // duplicate exact route —— 抛在同一次 effect 里会把它后面的注册全跳过，
    // 所以 /token 的 POST 与 DELETE 必须共用一个 handler。
    const disposeToken = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_TOKEN_PATH,
      handler: tokenHandler(deps),
    })
    const disposeLoginStart = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_LOGIN_PATH,
      handler: loginStartHandler(deps, activeLogins),
    })
    const disposeLoginStatus = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_LOGIN_STATUS_PATH,
      handler: loginPollHandler(deps, activeLogins),
    })
    return () => {
      disposeStatus()
      disposeModels()
      disposeToken()
      disposeLoginStart()
      disposeLoginStatus()
      for (const s of activeLogins.values()) s.close()
      activeLogins.clear()
    }
  }, 'dsh-codearts: Web status route')
}

/** /api/codearts/token — 一个席位按方法分派（POST 写入，DELETE 清除）。 */
function tokenHandler(deps: CodeArtsStatusRouteOptions) {
  const post = tokenPostHandler(deps)
  const remove = tokenDeleteHandler(deps)
  return (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    req.method === 'DELETE' ? remove(req, res) : post(req, res)
}

/** POST /api/codearts/login — 启动本地 OAuth 回调，返回授权 URL。 */
function loginStartHandler(deps: CodeArtsStatusRouteOptions, active: Map<string, LoginSession>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const session = await startLogin()
      // 5 分钟超时后自动清理
      const timer = setTimeout(() => {
        session.close()
        active.delete(session.url)
      }, 5 * 60 * 1000)
      // finally 派生出的 promise 会继承 rejection —— 登录失败时同样会变成未处理 rejection。
      session.promise.finally(() => clearTimeout(timer)).catch(() => {})
      active.set(session.url, session)
      json(res, 200, { url: session.url, port: session.port })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** GET /api/codearts/login/status — 轮询登录结果，完成则落库并清理。 */
function loginPollHandler(deps: CodeArtsStatusRouteOptions, active: Map<string, LoginSession>) {
  // 每次轮询都会给同一个 session.promise 挂一个 .then，登录完成时这些回调会
  // 一起跑 —— 不拦一道就会出现多次并发 setFromOAuth（并发写同一份凭证文件）。
  const claimed = new WeakSet<LoginSession>()
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const url = new URL(req.url ?? '', 'http://localhost')
    const key = url.searchParams.get('url') ?? ''
    const session = active.get(key)
    if (!session) {
      json(res, 200, { status: 'idle' })
      return
    }
    const result = await Promise.race([
      session.promise.then(
        (token): { status: string } => {
          if (!claimed.has(session)) {
            claimed.add(session)
            // 必须吞掉 rejection：宿主把未处理的 rejection 当 fatal，整个应用会退出。
            void deps.store.setFromOAuth(token).catch(() => {})
          }
          active.delete(key)
          return { status: 'done' }
        },
        (): { status: string } => {
          active.delete(key)
          return { status: 'error' }
        },
      ),
      // 避免长轮询阻塞：若还没完成，返回 pending
      new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'pending' }), 0)),
    ])
    json(res, 200, result)
  }
}
