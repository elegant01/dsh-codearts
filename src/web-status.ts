/**
 * Same-origin status + token routes for the CodeArts card.
 *
 * Minimal surface vs dsh-codebuddy-cli. The browser half calls these to read
 * sign-in state / model list / the account list / local usage / credits, to add
 * or remove accounts, and to claim the daily check-in credits. The route
 * answers loopback browser requests only and never returns token material.
 *
 * @module dsh-codearts/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CodeArtsAccountStore, CodeArtsAccountSummary } from './auth.ts'
import { MANUAL_ACCOUNT_ID } from './auth.ts'
import type { AccountRuntime } from './account-pool.ts'
import type { CodeArtsCatalog, CodeArtsModelInfo } from './catalog.ts'
import type { CodeArtsCreditSnapshot, CodeArtsCreditState } from './credits.ts'
import type { CodeArtsQueueEntry } from './queue.ts'
import type { UsageSnapshot, UsageTotals } from './usage.ts'
// 卡片只认 web-status 这一份状态契约，所以契约里用到的积分类型要跟着转出去 ——
// 否则 client 侧只能越过本模块去直引 credits.ts。
export type { CodeArtsCreditSnapshot, CodeArtsCreditState } from './credits.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { probePiAiCompat } from './pi-ai-compat.ts'
import {
  clearBenefitBlocked,
  creditRatioLabel,
  filterEnabledModels,
  isBenefitBlocked,
  isBenefitModel,
} from './catalog.ts'
import { fetchCallerIdentity, type CallerIdentity, type CodeArtsWelfareState } from './upstream.ts'
import { startLogin, type LoginSession, type OAuthToken } from './oauth.ts'
// 领取结果里的 state 也是卡片要认的契约，同上不外露 upstream 模块。
export type { CodeArtsWelfareState } from './upstream.ts'

/** 登录后问身份的超时：它是「顺手做对」，不能拖住登录落库。 */
const IDENTITY_TIMEOUT_MS = 8_000

/** Route paths (same-origin under the DSH web origin). */
export const CODEARTS_STATUS_PATH = '/api/codearts/status'
export const CODEARTS_MODELS_PATH = '/api/codearts/models'
export const CODEARTS_MODELS_SELECTION_PATH = '/api/codearts/enabled-models'
export const CODEARTS_TOKEN_PATH = '/api/codearts/token'
export const CODEARTS_LOGIN_PATH = '/api/codearts/login'
export const CODEARTS_LOGIN_STATUS_PATH = '/api/codearts/login/status'
/** 删除某个账号：DELETE /api/codearts/accounts?id=<accountId> */
export const CODEARTS_ACCOUNTS_PATH = '/api/codearts/accounts'
/** POST /api/codearts/claim — 领一次福利中心的每日签到积分（幂等由上游按天去重）。 */
export const CODEARTS_CLAIM_PATH = '/api/codearts/claim'
/** POST /api/codearts/refresh-models — 立刻重拉一次模型目录，并清掉「福利今日不可用」标记。 */
export const CODEARTS_REFRESH_MODELS_PATH = '/api/codearts/refresh-models'
/** GET /api/codearts/queue — 上游排队位置（只在等开流期间有值，底部积分条旁边展示）。 */
export const CODEARTS_QUEUE_PATH = '/api/codearts/queue'
/**
 * GET/POST /api/codearts/dock — 对话底部那一行的显隐开关。
 * GET 给当前值与 writable，POST 收 `{credits?, queue?}` 写进 settings。
 */
export const CODEARTS_DOCK_PATH = '/api/codearts/dock'
/** 最近出站请求的**形状**摘要（只有 role 名与计数，不含内容），排障用。 */
export const CODEARTS_DEBUG_PATH = '/api/codearts/debug'

/** 勾选 UI 的一个选项。 */
export interface CodeArtsModelChoice {
  id: string
  name: string
  /** 走限时福利路由的模型（不是「免费随便用」，是单独的福利权益）。 */
  benefit?: boolean
  /** 福利今天被上游判定缺失（InferHub.4004.200），卡片据此置灰。 */
  blocked?: boolean
  /** 已格式化的积分倍率（`x0.18`；福利恒为 `x0.00`，上游没给倍率时缺省）。 */
  ratio?: string
  /** 支持图片输入（卡片据此挂「识图」Tag；纯文本模型缺省）。 */
  supportsImages?: boolean
}

/** enabled-models 路由返回的 selection 文档（与 codebuddy 的 shape 对齐）。 */
export interface CodeArtsModelSelection {
  choices: { id: string; name: string; enabled: boolean; benefit?: boolean; blocked?: boolean; ratio?: string; supportsImages?: boolean }[]
  /** 已选子集是否小于全集（卡片据此显示不同提示）。 */
  restricted: boolean
  /** 是否可写（无 settings provider 时为 false，卡片只读）。 */
  writable: boolean
}

/**
 * 由完整目录 + 已存 enabled 计算 selection。
 * - enabled 为空/未存 => 全部勾选（restricted=false）
 * - enabled 为非空列表 => 仅勾选其中的（restricted=true），缺的按未勾选
 * 福利模型用 catalog 的 benefit 标记（这里靠 model.benefit 字段，由调用方注入）。
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
    benefit: m.benefit,
    blocked: m.blocked,
    ratio: m.ratio,
    supportsImages: m.supportsImages,
    enabled: restricted ? allowed.has(m.id) : true,
  }))
  return { choices, restricted, writable }
}

/** 目录 -> 勾选 UI 的选项（福利标记、今日不可用标记与倍率都在这里算）。 */
function choicesOf(deps: CodeArtsStatusRouteOptions): CodeArtsModelChoice[] {
  return deps.models().map(m => {
    const benefit = isBenefitModel(m.id)
    const ratio = creditRatioLabel(m.ratio, benefit)
    return {
      id: m.id,
      name: m.name,
      benefit,
      blocked: isBenefitBlocked(m.id),
      ...(ratio === undefined ? {} : { ratio }),
      ...(m.supportsImages === true ? { supportsImages: true } : {}),
    }
  })
}

/**
 * 目录 -> 底栏/卡片用的模型徽章。
 *
 * 倍率在这里就算好（`creditRatioLabel`：福利恒为 `x0.00`），客户端拿到的是可以直接
 * 印出来的字符串 —— 底栏那一行要把它作为独立的一段，所以不能只给带尾巴的名字。
 */
function modelBadgesOf(models: readonly CodeArtsModelInfo[]): CodeArtsWebModelBadge[] {
  return models.map(m => {
    const ratio = creditRatioLabel(m.ratio, isBenefitModel(m.id))
    return { id: m.id, name: m.name, ...(ratio === undefined ? {} : { ratio }) }
  })
}

/**
 * 领取福利的结果。
 *
 * `ok` 是「这次请求跑通了没有」，`claimed` 才是「积分真的加上了」——
 * 今天已领 / 账号没有这个活动都算 ok 但没 claimed，UI 不该把它们当报错。
 */
export interface CodeArtsClaimOutcome {
  ok: boolean
  claimed: boolean
  state: CodeArtsWelfareState
  amount: number
  message: string
}

/** 批量领取时每个账号各自的结果。 */
export interface CodeArtsClaimAccountResult extends CodeArtsClaimOutcome {
  id: string
}

export interface CodeArtsClaimResult extends CodeArtsClaimOutcome {
  /** 一次领多个账号时逐号给出结果；单账号旧调用方不看这个字段。 */
  results?: readonly CodeArtsClaimAccountResult[]
}

/** 某个账号的积分：成功给快照，失败给原因 —— 一个号拉不到不影响别的号。 */
export interface CodeArtsAccountCredits {
  id: string
  credits?: CodeArtsCreditSnapshot
  creditsError?: string
}

/**
 * 对话底部那一行的显隐开关。
 *
 * 两个字段各管一件事：积分数字是常驻的，排队提示只在等开流时出现。分成两个开关
 * 是因为「不想常驻一个数字」和「别告诉我为什么在等」是两种完全不同的诉求。
 */
export interface CodeArtsDockFlags {
  /** 剩余积分那一行。 */
  credits: boolean
  /** 上游排队位置提示。 */
  queue: boolean
}

/** 开关的默认值：没有 settings provider（或老配置没这两个键）时保持原有行为 —— 都显示。 */
export const DEFAULT_DOCK_FLAGS: CodeArtsDockFlags = { credits: true, queue: true }

/**
 * 把逐账号的领取结果汇总成一条：HTTP 层只看 ok，卡片看 results 逐号展示。
 * 有一个号失败就算整批 ok=false，但别的号领到的结果照样在 results 里。
 */
export function summarizeClaims(results: readonly CodeArtsClaimAccountResult[]): CodeArtsClaimResult {
  const failed = results.find(result => result.state === 'failed')
  const claimed = results.filter(result => result.claimed)
  const messages = [...new Set(results.map(result => result.message).filter(message => message !== ''))]
  return {
    ok: results.length > 0 && failed === undefined,
    claimed: claimed.length > 0,
    state: claimed.length > 0 ? 'claimed' : failed?.state ?? results[0]?.state ?? 'failed',
    amount: claimed.reduce((sum, result) => sum + result.amount, 0),
    message: results.length === 1 ? results[0].message : messages.join('; ').slice(0, 300),
    results,
  }
}

export interface CodeArtsWebStatus {
  status: 'signed-in' | 'signed-out' | 'expired'
  label?: string
  storedAt?: number
  models: readonly CodeArtsWebModelBadge[]
  /** 已存账号。多个账号时会自动轮转，某个号忙就换下一个。 */
  accounts: readonly CodeArtsAccountSummary[]
  /** 本机经插件发出的请求统计（账号总额度见 credits 字段，这里只记本机）。 */
  usage: CodeArtsWebUsage
  /**
   * 账号积分/额度（CodeArts 自己的积分接口，2026-10 实测可用）。
   * 省略表示插件没接这条链路或还没拉到。
   */
  credits?: CodeArtsCreditSnapshot
  /** 积分拿不到时的原因 —— 有值就说明 credits 缺席，且要让用户看见为什么。 */
  creditsError?: string
  /**
   * 每个账号各自的积分（按 account id 对齐）。多账号下 credits 只是其中一份快照，
   * 卡片要按账号展示就必须读这里。
   */
  creditsByAccount?: readonly CodeArtsAccountCredits[]
  /**
   * 对话底部那一行的显隐开关。省略 = 都显示（老宿主/老配置保持原有行为）。
   * 底部条本来就在轮询这个接口，所以开关搭车下发，不用多开一条链路。
   */
  dock?: CodeArtsDockFlags
  /**
   * 运行时解析到的 `@earendil-works/pi-ai` 不满足要求时的说明。
   * 有值 = 模型全跑不动（每条消息在出网前就失败），且这是版本装配问题，不是账号或网络。
   */
  piAiError?: string
}

/**
 * 卡片上的用量区块。
 *
 * 只报**本机经插件发出**的请求：上游没有任何额度/积分接口（codearts2api 的 pool 里
 * credits 恒为 0），所以卡片必须把这一点说清楚，官方额度明细在
 * `codearts.huaweicloud.com/portal/settings/personal-usage`。
 */
export interface CodeArtsWebUsage {
  /** 今天的合计。 */
  today: UsageTotals
  /** 账本里保留天数的合计。 */
  allTime: UsageTotals
  /** 最近 30 天（含今天）的合计。 */
  last30: UsageTotals
  /** 今天按模型，按 token 降序（卡片只展示前几条）。 */
  byModelToday: readonly { id: string; totals: UsageTotals }[]
  /** 今天按账号 —— 多账号时用来看是哪个号在用。 */
  byAccountToday: Record<string, UsageTotals>
  /** 账本覆盖天数。 */
  days: number
  lastAt?: number
  /** 每个账号的会话槽位占用与池状态 —— 这是「为什么刚才要等」的直接答案。 */
  slots: readonly CodeArtsWebAccountSlot[]
}

export interface CodeArtsWebAccountSlot {
  id: string
  /** 本机正在飞的请求数 / 允许的并发数。 */
  active: number
  max: number
  /** 账号池里的状态。 */
  state: 'ok' | 'capped' | 'cooling' | 'disabled'
  /** 卡片用的说明文字（英文，由卡片侧本地化）。 */
  detail?: string
}

export interface CodeArtsWebModelBadge {
  id: string
  name: string
  /**
   * 已格式化的积分倍率（`x0.18`；福利恒为 `x0.00`，上游没给倍率的模型缺省）。
   *
   * `name` 里其实已经带了同样的尾巴（见 catalog 的 modelDisplayName），底栏为了让
   * 倍率成为独立的一段（`Model X · x0.18`，与 dsh-codebuddy-cli 的底栏同构），
   * 需要把这两件事分开拿，所以这里单列一个字段而不是让客户端去拆名字。
   */
  ratio?: string
}

export interface CodeArtsStatusRouteOptions {
  store: CodeArtsAccountStore
  models: () => readonly CodeArtsModelInfo[]
  enabledModels?: () => readonly string[] | undefined
  /** 账号池运行时（槽位占用/冷却/禁用）。省略则卡片不显示槽位区块。 */
  pool?: () => readonly AccountRuntime[]
  /**
   * 凭据换新（登录成功/手动贴 token）后复活池里的账号：清掉 disabled 与冷却。
   * 省略则「重新登录」不影响池状态（disabled 只能靠重启清掉，见 issue #1）。
   */
  reviveAccount?: (id: string) => void
  /** 用量账本快照。省略则卡片不显示用量区块。 */
  usage?: () => UsageSnapshot
  /**
   * 拉一次账号积分（内部应带缓存，别每次刷新都打上游）。
   * 省略则卡片不显示积分区块。
   */
  credits?: (signal?: AbortSignal) => Promise<readonly CodeArtsAccountCredits[]>
  /**
   * 领每日签到积分（福利中心 /v1/ops/delivery + /v1/ops/claim）。
   * 省略 id 时逐个可用账号都领一遍；上游按天去重，重复领返回 already。
   */
  claim?: (accountId?: string) => Promise<CodeArtsClaimResult>
  /**
   * 立刻重拉一次模型目录（不等每小时那一次）。
   *
   * 存在的理由：限时福利名单会变（模型被移出/转正），而唯一权威来源 `gateway/config`
   * 只在发现流程里拉。上游轮换后，用户需要一个立刻见效的出口。
   */
  refreshModels?: () => Promise<{ models: number; benefit: number; refreshed: boolean }>
  /** 当前在上游排队、值得展示的请求。省略则卡片不显示排队信息。 */
  queue?: () => readonly CodeArtsQueueEntry[]
  /** 最近几次出站请求的形状摘要（`/api/codearts/debug`）。 */
  recentRequests?: () => readonly unknown[]
  /**
   * Persist a new allowlist. Resolves false when no settings provider is
   * attached, which the card renders as a read-only selection.
   */
  setEnabledModels?: (ids: readonly string[]) => Promise<boolean>
  /**
   * 对话底部那一行的显隐开关当前值。省略则 /status 不带 dock 字段（= 都显示）。
   */
  dock?: () => CodeArtsDockFlags
  /** 写入显隐开关。返回 false 表示没接 settings provider，卡片据此把勾选框置灰。 */
  setDock?: (patch: Partial<CodeArtsDockFlags>) => Promise<boolean>
  /**
   * 丢掉积分缓存后重拉一次（弹层上那个「刷新积分」按钮）。
   * 省略时 `?force=1` 退回普通缓存读取 —— 顶多是不新鲜，不该报错。
   */
  refreshCredits?: (signal?: AbortSignal) => Promise<readonly CodeArtsAccountCredits[]>
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
/**
 * 登录后立刻问一次身份（有超时，失败返回 null）。
 *
 * 这一步是「尽量做对」而不是必须：拿不到身份也要能把账号存下来，只是会退回
 * 「每次登录各自成一条」的旧行为。
 */
async function probeIdentity(token: OAuthToken): Promise<CallerIdentity | null> {
  const credential = {
    token: token.securityToken,
    accessKeyId: token.accessKeyId,
    secretAccessKey: token.secretAccessKey,
    securityToken: token.securityToken,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS)
  timer.unref?.()
  try {
    return await fetchCallerIdentity(credential, controller.signal)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 账号还能用吗（没被标 stale、也没过期）。 */
function accountUsable(summary: CodeArtsAccountSummary): boolean {  if (summary.stale) return false
  if (typeof summary.expiration !== 'string') return true
  const at = Date.parse(summary.expiration)
  return !Number.isFinite(at) || at > Date.now()
}

/** 池状态 -> 卡片能直接渲染的槽位信息。 */
function slotsOf(deps: CodeArtsStatusRouteOptions): CodeArtsWebAccountSlot[] {
  const runtime = deps.pool?.() ?? []
  const now = Date.now()
  return runtime.map(account => {
    const state: CodeArtsWebAccountSlot['state'] = account.disabled
      ? 'disabled'
      : now < account.coolUntil
        ? 'cooling'
        : now < account.cappedUntil
          ? 'capped'
          : 'ok'
    const detail = state === 'capped'
      ? `upstream session cap hit; avoiding it for ~${Math.ceil((account.cappedUntil - now) / 1000)}s`
      : state === 'cooling'
        ? `cooling down for ~${Math.ceil((account.coolUntil - now) / 1000)}s`
        : state === 'disabled'
          ? account.lastError ?? 'disabled'
          : undefined
    return {
      id: account.id,
      active: account.activeConcurrent,
      max: account.maxConcurrent,
      state,
      ...(detail === undefined ? {} : { detail }),
    }
  })
}

/** 用量账本 -> 卡片文档；没有账本（未注入）时给一份空壳，卡片就不会瞎显示。 */
function usageOf(deps: CodeArtsStatusRouteOptions): CodeArtsWebUsage {
  const snapshot: UsageSnapshot | undefined = deps.usage?.()
  const noTotals: UsageTotals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  return {
    today: snapshot?.today ?? noTotals,
    allTime: snapshot?.allTime ?? noTotals,
    last30: snapshot?.last30 ?? noTotals,
    byModelToday: snapshot?.byModelToday ?? [],
    byAccountToday: snapshot?.byAccountToday ?? {},
    days: snapshot?.days ?? 0,
    ...snapshot?.lastAt === undefined ? {} : { lastAt: snapshot.lastAt },
    slots: slotsOf(deps),
  }
}

/**
 * 积分区块。
 *
 * 积分是「锦上添花」：拉不到也绝不能把状态接口本身拖垮，所以失败一律降级成
 * `creditsError` 交给卡片显示原因（超时由注入方在自己的闭包里保证）。
 *
 * `force` 是给对话底部弹层那个「刷新积分」按钮用的：不强制的话它会命中 60 秒缓存，
 * 按钮点了数字不动 —— 那还不如不给这个按钮。
 */
async function creditsOf(
  deps: CodeArtsStatusRouteOptions,
  force: boolean,
): Promise<Partial<CodeArtsWebStatus>> {
  const load = force ? (deps.refreshCredits ?? deps.credits) : deps.credits
  if (load === undefined) return {}
  try {
    const entries = await load()
    // credits / creditsError 保留给对话底部的单行积分条：取第一份拿到的快照。
    const primary = entries.find(entry => entry.credits !== undefined) ?? entries[0]
    return {
      ...primary?.credits === undefined ? {} : { credits: primary.credits },
      ...primary?.credits === undefined && primary?.creditsError !== undefined
        ? { creditsError: primary.creditsError }
        : {},
      ...entries.length === 0 ? {} : { creditsByAccount: entries },
    }
  } catch (error: unknown) {
    return { creditsError: safeMessage(error) }
  }
}

async function buildStatus(deps: CodeArtsStatusRouteOptions, force = false): Promise<CodeArtsWebStatus> {
  const models = modelBadgesOf(deps.models())
  const accounts = await deps.store.list()
  const cred = await deps.store.current()
  const usage = usageOf(deps)
  const dock = deps.dock === undefined ? {} : { dock: deps.dock() }
  // pi-ai 版本不兼容时模型全不可用，但状态接口本身还能用 —— 原因必须在这里给出去，
  // 否则用户只看到每条消息一句「本轮运行失败」。
  const piAi = await probePiAiCompat()
  const compat = piAi === undefined ? {} : { piAiError: piAi }

  if (accounts.length === 0 || cred === undefined) {
    return { status: 'signed-out', models, accounts, usage, ...dock, ...compat }
  }
  // 只要还有**任意一个**账号能用就算登录中 —— 别的号过期了不影响轮转。
  const usable = accounts.some(accountUsable)
  const identity = {
    ...cred.label === undefined ? {} : { label: cred.label },
    ...cred.storedAt === undefined ? {} : { storedAt: cred.storedAt },
    models,
    accounts,
    usage,
    ...dock,
  }
  // 没有可用账号时不问积分：凭证都过期了，问了也是白跑一趟（还得等超时）。
  if (!usable) return { status: 'expired', ...identity, ...compat }
  return { status: 'signed-in', ...identity, ...compat, ...await creditsOf(deps, force) }
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
      const url = new URL(req.url ?? '', 'http://localhost')
      const force = url.searchParams.get('force') === '1'
      json(res, 200, await buildStatus(deps, force))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/**
 * GET/POST /api/codearts/dock — 对话底部那一行的显隐开关读写。
 *
 * 和 enabled-models 同一套规矩：GET 给当前值 + writable，POST 只收布尔、
 * 没接 settings provider 时回 403 让卡片把勾选框置灰。
 */
function dockHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const current = deps.dock?.() ?? DEFAULT_DOCK_FLAGS
    if (req.method === 'GET') {
      json(res, 200, { dock: current, writable: deps.setDock !== undefined })
      return
    }
    if (req.method === 'POST') {
      if (deps.setDock === undefined) {
        json(res, 403, { error: 'dock-not-writable' })
        return
      }
      const type = req.headers['content-type']
      if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
        json(res, 415, { error: 'content-type must be application/json' })
        return
      }
      try {
        const body = JSON.parse(await readBody(req)) as { credits?: unknown; queue?: unknown }
        const keys = ['credits', 'queue'] as const
        const touched = keys.filter(key => body[key] !== undefined)
        if (touched.length === 0 || touched.some(key => typeof body[key] !== 'boolean')) {
          json(res, 400, { error: 'expected {"credits"?: boolean, "queue"?: boolean}' })
          return
        }
        const ok = await deps.setDock(Object.fromEntries(
          touched.map(key => [key, body[key] as boolean]),
        ))
        if (!ok) {
          json(res, 403, { error: 'dock-not-writable' })
          return
        }
        json(res, 200, { dock: deps.dock?.() ?? DEFAULT_DOCK_FLAGS, writable: true })
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
      return
    }
    json(res, 405, { error: 'method not allowed' })
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
    json(res, 200, { models: modelBadgesOf(offered) })
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
      const all = choicesOf(deps)
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
        const all = choicesOf(deps)
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
      // 手工 token 也是凭据换新：复活「手工」账号，否则它被禁用后贴新 token 也没用。
      deps.reviveAccount?.(MANUAL_ACCOUNT_ID)
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

/**
 * DELETE /api/codearts/accounts?id=<accountId> — 删掉一个账号。
 *
 * id 必须显式给：多账号下「删掉当前那个」是歧义的。改状态的路由，所以和
 * /token 一样走 Host + Origin 双校验。
 */
function accountsHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'DELETE') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const url = new URL(req.url ?? '', 'http://localhost')
    const id = (url.searchParams.get('id') ?? '').trim()
    if (id === '') {
      json(res, 400, { error: 'expected ?id=<accountId>' })
      return
    }
    try {
      await deps.store.remove(id)
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** POST /api/codearts/claim — 领一次每日签到积分；未领到也回 200（看 claimed/state）。 */
function claimHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (deps.claim === undefined) {
      json(res, 404, { error: 'claim not available' })
      return
    }
    // 与其他 mutating route 一致：挡 DNS-rebinding。
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    let accountId: string | undefined
    const type = req.headers['content-type']
    if (typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')) {
      try {
        const body = JSON.parse(await readBody(req)) as { id?: unknown }
        if (typeof body?.id === 'string' && body.id.trim() !== '') accountId = body.id.trim()
      } catch {
        json(res, 400, { error: 'expected {"id"?: string}' })
        return
      }
    }
    try {
      const result = await deps.claim(accountId)
      json(res, result.ok ? 200 : 500, result)
    } catch (error: unknown) {
      json(res, 500, {
        ok: false,
        claimed: false,
        state: 'failed',
        amount: 0,
        message: safeMessage(error),
      })
    }
  }
}

/**
 * POST /api/codearts/refresh-models — 立刻重拉目录，并清掉「福利今日不可用」标记。
 *
 * 清标记放在拉目录**之前**：福利回来时这是唯一的自救出口，不能让用户等到明天。
 * 代价是「今天确实领完了」的那种缺失也会被一并清掉，再点一次就重新记上。
 */
function refreshModelsHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (deps.refreshModels === undefined) {
      json(res, 404, { error: 'refresh not available' })
      return
    }
    try {
      clearBenefitBlocked()
      const counted = await deps.refreshModels()
      const selection = selectionOf(
        choicesOf(deps),
        deps.enabledModels?.(),
        deps.setEnabledModels !== undefined,
      )
      json(res, 200, { ok: true, ...counted, selection })
    } catch (error: unknown) {
      json(res, 500, { ok: false, message: safeMessage(error) })
    }
  }
}

/** GET /api/codearts/queue — 排队位置快照（无跟踪器/无排队时给空数组）。 */
function queueHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    json(res, 200, { queue: deps.queue?.() ?? [] })
  }
}

/** GET /api/codearts/debug — 最近出站请求的形状摘要（只有 role 名与计数）。 */
function debugHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    json(res, 200, { requests: deps.recentRequests?.() ?? [] })
  }
}

/** Mount the status / models / token routes. */
export function registerCodeArtsStatusRoute(ctx: Context, deps: CodeArtsStatusRouteOptions): void {
  ctx.effect(() => {
    const activeLogins = new Map<string, LoginSession>()
    /** 已结束登录的终态，供迟到的轮询读取。被读一次即删。 */
    const recentLogins = new Map<string, LoginOutcome>()
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
      handler: loginStartHandler(deps, activeLogins, recentLogins),
    })
    const disposeLoginStatus = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_LOGIN_STATUS_PATH,
      handler: loginPollHandler(deps, activeLogins, recentLogins),
    })
    const disposeAccounts = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_ACCOUNTS_PATH,
      handler: accountsHandler(deps),
    })
    const disposeClaim = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_CLAIM_PATH,
      handler: claimHandler(deps),
    })
    const disposeRefresh = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_REFRESH_MODELS_PATH,
      handler: refreshModelsHandler(deps),
    })
    const disposeQueue = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_QUEUE_PATH,
      handler: queueHandler(deps),
    })
    const disposeDock = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_DOCK_PATH,
      handler: dockHandler(deps),
    })
    const disposeDebug = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_DEBUG_PATH,
      handler: debugHandler(deps),
    })
    return () => {
      disposeStatus()
      disposeModels()
      disposeModelsSelection()
      disposeToken()
      disposeLoginStart()
      disposeLoginStatus()
      disposeAccounts()
      disposeClaim()
      disposeRefresh()
      disposeQueue()
      disposeDock()
      disposeDebug()
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

/** 一次登录的终态。落库成功才算 done；落库失败按 error 报给卡片。 */
type LoginOutcome = 'done' | 'error'

/** 记一次登录终态；超出容量就丢最旧的，别让这个表无限长。 */
function recordLoginOutcome(recent: Map<string, LoginOutcome>, url: string, outcome: LoginOutcome): void {
  if (recent.size >= 20 && !recent.has(url)) {
    const oldest = recent.keys().next().value
    if (oldest !== undefined) recent.delete(oldest)
  }
  recent.set(url, outcome)
}

/** POST /api/codearts/login — 启动本地 OAuth 回调，返回授权 URL。 */
function loginStartHandler(
  deps: CodeArtsStatusRouteOptions,
  active: Map<string, LoginSession>,
  recent: Map<string, LoginOutcome>,
) {
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
      active.set(session.url, session)
      // 终态只在 promise 兑现/失败时处理**一次**：落库 + 记下结果。之后不管卡片
      // 轮询多少次、迟到的轮询什么时候到，都从 recent 里读这个终态——不能在每个
      // 轮询里各自 .then 一遍（那样登录完成时所有叠着的回调会一起跑、把会话从
      // active 里删掉，下一次轮询就只能看到 idle，卡片按钮永远停在「登录中」）。
      session.promise.then(
        async token => {
          active.delete(session.url)
          try {
            // 登录响应不带 user_id，所以立刻问一次上游身份：拿到就能让「同一账号
            // 重新登录」命中同一条记录，拿不到就退回旧行为（DPoP 公钥当键）。
            const identity = await probeIdentity(token)
            const id = await deps.store.upsertFromOAuth(token, undefined, identity ?? undefined)
            // 身份已有、但这次是用老键（DPoP）新建的条目：并入稳定键，避免重复账号。
            if (identity !== null && id !== identity.userId) {
              await deps.store.adoptIdentity(id, identity)
            }
            // 凭据已换新：把这个号从禁用/冷却里捞出来（含 adopt 前后的两个键）。
            // 没有这个，「重新登录」对已被禁用的账号完全无效（issue #1）。
            deps.reviveAccount?.(id)
            if (identity !== null && identity.userId !== id) deps.reviveAccount?.(identity.userId)
            recordLoginOutcome(recent, session.url, 'done')
          } catch {
            recordLoginOutcome(recent, session.url, 'error')
          }
        },
        () => {
          active.delete(session.url)
          recordLoginOutcome(recent, session.url, 'error')
        },
      )
      // 5 分钟超时：关回调端口。注意此时 promise 永远不会兑现（take() 没有等
      // 到 code 就一直挂着），所以终态要在这里自己记，不能指望上面的 .then。
      const timer = setTimeout(() => {
        session.close()
        if (active.delete(session.url)) recordLoginOutcome(recent, session.url, 'error')
      }, 5 * 60 * 1000)
      // finally 派生出的 promise 会继承 rejection —— 登录失败时同样会变成未处理 rejection。
      session.promise.finally(() => clearTimeout(timer)).catch(() => {})
      json(res, 200, { url: session.url, port: session.port })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** GET /api/codearts/login/status — 轮询登录结果。 */
function loginPollHandler(
  _deps: CodeArtsStatusRouteOptions,
  active: Map<string, LoginSession>,
  recent: Map<string, LoginOutcome>,
) {
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
    if (active.has(key)) {
      json(res, 200, { status: 'pending' })
      return
    }
    const outcome = recent.get(key)
    if (outcome !== undefined) {
      // 读完即消费：这个终态只告诉第一个来问的轮询。卡片侧把 idle 也当终止态
      // 兜底，所以第二个轮询拿不到 done 也不会卡死。
      recent.delete(key)
      json(res, 200, { status: outcome })
      return
    }
    json(res, 200, { status: 'idle' })
  }
}
