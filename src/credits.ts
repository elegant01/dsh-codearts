/**
 * CodeArts 积分与额度。
 *
 * 老结论「CodeArts 没有额度接口」是**错的**。2026-10-10 从官方 CodeArts Agent
 * 客户端（`<安装目录>/resources/app/extensions/vscode-codebot/out/extension.js`）
 * 里挖出它自己的接口清单，并逐条实测通过：
 *
 *   GET {SNAP_HOST}/snap-manager/v1/statistics/plugin
 *       积分体系：套餐名/状态、总量、已用、剩余、即将过期、额度周期（重置日）
 *   GET https://opengw.developer.huaweicloud.com/api/v1/user/tokens/balance
 *       日/月 token 额度与余额
 *
 * 鉴权必须带 AK/SK 签名（SDK-HMAC-SHA256）。官方客户端那里只写了 `x-auth-token`，
 * 是因为它走 IDE 内部的请求通道；我们直连时只带 `x-auth-token` 会被 APIG 拒掉：
 * `401 APIG.0301 decrypt token fail`（实测三种组合，只有签名那一路 200）。
 *
 * 卡片每次刷新都会问一次状态，所以这里带 TTL 缓存 + 单飞：命中缓存不打上游，
 * 失败也缓存一小段，免得上游抽风时每次刷新都要等一次超时。
 *
 * @module dsh-codearts/credits
 */

import {
  SNAP_HOST,
  fetchWelfareCampaigns,
  isWelfareClaimedStatus,
  pickDailyWelfareCampaign,
  signedGet,
  type CodeArtsResolved,
} from './upstream.ts'

/** 福利网关：token 余额接口在这里（与 benefit/claim、gateway/config 同一个 host）。 */
export const BENEFIT_GATEWAY_HOST = 'https://opengw.developer.huaweicloud.com'

const EP_STATISTICS_PLUGIN = '/snap-manager/v1/statistics/plugin'
const EP_TOKEN_BALANCE = '/api/v1/user/tokens/balance'

/** 一类积分（总量/已用/剩余/即将过期）。上游给不出的字段留 undefined。 */
export interface CodeArtsCreditCategory {
  total: number
  used: number
  remain: number
  /** 会在本周期结束时作废的部分。 */
  expiring: number
}

/** 积分快照（来自 statistics/plugin）。 */
export interface CodeArtsCredits {
  /** 套餐显示名，例如「体验版」。 */
  planName: string
  /** 套餐英文名（中文缺失时的兜底）。 */
  planNameEn: string
  /** 上游给的 spec_code，例如 codearts.agent.individual.trial。 */
  specCode: string
  /** normal → active、closed → expired、freeze → frozen。 */
  planStatus: 'active' | 'expired' | 'frozen' | 'unknown'
  /** 是否按积分计费（false 表示 token 套餐）。 */
  isCreditPackage: boolean
  /** 变更/购买套餐的官方页面。 */
  packageUrl?: string
  /** 额度周期起止（end 就是「限额重置日期」）。 */
  periodStart?: string
  periodEnd?: string
  /** 总积分（usageTotalPackageCredit）。 */
  total: CodeArtsCreditCategory
  /** 赠送积分（usageBonusPackageCredit）。 */
  bonus?: CodeArtsCreditCategory
  /** 基础套餐积分（usageBasicPackageCredit）。 */
  basic?: CodeArtsCreditCategory
  /** 按需积分（usageOnDemandPackageCredit）。 */
  onDemand?: CodeArtsCreditCategory
  /** 抓取时刻（毫秒）。 */
  fetchedAt: number
}

/** token 额度快照（来自 tokens/balance）。 */
export interface CodeArtsTokenQuota {
  dailyLimit: number
  dailyUsed: number
  monthlyLimit: number
  monthlyUsed: number
  /** 剩余额度。 */
  balance: number
  /** 总额度。 */
  quota: number
}

/** 每日签到活动当前状态（来自福利中心 `/v1/ops/delivery`）。 */
export interface CodeArtsDailyWelfare {
  /** 上游说这条活动现在点得动吗。 */
  claimable: boolean
  /**
   * 「今天已经领过了」。单独判出来给卡片改按钮文案用 —— 不可领的原因有好几种
   * （已领 / 要先去官网登录 / 账号没资格），只有这一种该把按钮变成「今日已领」。
   */
  claimedToday: boolean
  /** 领一次给多少积分。 */
  amount: number
}

export interface CodeArtsCreditSnapshot {
  credits: CodeArtsCredits
  /** 拿不到（接口失败/不支持）时为 undefined，不影响积分本身。 */
  tokens?: CodeArtsTokenQuota
  /** 没有这个活动（或账号是 token 套餐）时为 undefined。 */
  welfare?: CodeArtsDailyWelfare
}

/** 缓存里的一个结果：成功给值，失败给消息 —— 失败也要能被卡片看见。 */
export type CodeArtsCreditState =
  | { phase: 'ok'; value: CodeArtsCreditSnapshot; at: number }
  | { phase: 'error'; message: string; at: number }

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 取一个非负数字。
 *
 * 上游用 `-1` 表示「这个指标不适用」（例如模型维度的 usage_token / model_quota_num），
 * 所以负数一律当「没有」而不是当 0 —— 否则界面会把「不适用」显示成「已用 0」。
 */
function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function numberOrZero(value: unknown): number {
  return nonNegative(value) ?? 0
}

/** 按 name 找一条 metrics（上游的 metrics 是一个带 name 的数组）。 */
function metricNamed(raw: unknown, name: string): Record<string, unknown> | undefined {
  for (const item of asArray(raw)) {
    const metric = asRecord(item)
    if (firstString(metric.name) === name) return metric
  }
  return undefined
}

function categoryOf(metric: Record<string, unknown> | undefined): CodeArtsCreditCategory | undefined {
  if (metric === undefined) return undefined
  const total = nonNegative(metric.package_credit_amount)
  const used = nonNegative(metric.package_credit_used)
  const remain = nonNegative(metric.package_credit_remain)
  // 三个关键字段一个都没有，说明这条 metric 不是积分口径（可能是 token 口径）。
  if (total === undefined && used === undefined && remain === undefined) return undefined
  return {
    total: numberOrZero(total),
    used: numberOrZero(used),
    remain: numberOrZero(remain),
    expiring: numberOrZero(metric.package_credit_expiring_amount),
  }
}

/** 套餐状态映射：与官方客户端 CreditPackageService.mapPackageStatus 一致。 */
function mapPlanStatus(raw: string): CodeArtsCredits['planStatus'] {
  if (raw === 'normal') return 'active'
  if (raw === 'closed') return 'expired'
  if (raw === 'freeze') return 'frozen'
  return 'unknown'
}

/**
 * 解析 `GET /snap-manager/v1/statistics/plugin` 的响应。
 *
 * 返回 undefined 表示这不是一份能用的积分文档（上游改了形状/账号没有积分体系）——
 * 调用方据此报「积分不可用」，而不是显示一排 0 假装是真的。
 */
export function parseCreditStatistics(raw: unknown): CodeArtsCredits | undefined {
  const body = asRecord(raw)
  const metrics = body.metrics
  if (!Array.isArray(metrics)) return undefined
  const total = categoryOf(metricNamed(metrics, 'usageTotalPackageCredit'))
  if (total === undefined) return undefined
  const pkg = asRecord(body.package)
  const planNameCn = firstString(pkg.package_name_cn)
  const planNameEn = firstString(pkg.package_name_en)
  const packageUrl = firstString(pkg.package_url)
  const periodStart = firstString(body.start_date)
  const periodEnd = firstString(body.end_date)
  return {
    planName: planNameCn !== '' ? planNameCn : planNameEn,
    planNameEn,
    specCode: firstString(pkg.spec_code),
    planStatus: mapPlanStatus(firstString(pkg.status)),
    isCreditPackage: pkg.is_credit_package === true,
    ...packageUrl === '' ? {} : { packageUrl },
    ...periodStart === '' ? {} : { periodStart },
    ...periodEnd === '' ? {} : { periodEnd },
    total,
    ...pick('bonus', categoryOf(metricNamed(metrics, 'usageBonusPackageCredit'))),
    ...pick('basic', categoryOf(metricNamed(metrics, 'usageBasicPackageCredit'))),
    ...pick('onDemand', categoryOf(metricNamed(metrics, 'usageOnDemandPackageCredit'))),
    fetchedAt: Date.now(),
  }
}

function pick(key: 'bonus' | 'basic' | 'onDemand', value: CodeArtsCreditCategory | undefined): Record<string, CodeArtsCreditCategory> {
  return value === undefined ? {} : { [key]: value }
}

/** 解析 `GET /api/v1/user/tokens/balance` 的响应（`result` 里是额度口径）。 */
export function parseTokenBalance(raw: unknown): CodeArtsTokenQuota | undefined {
  const result = asRecord(asRecord(raw).result)
  const balance = nonNegative(result.total_balance)
  const quota = nonNegative(result.total_quota)
  if (balance === undefined && quota === undefined) return undefined
  return {
    dailyLimit: numberOrZero(result.daily_token_limit),
    dailyUsed: numberOrZero(result.daily_tokens_used),
    monthlyLimit: numberOrZero(result.monthly_token_limit),
    monthlyUsed: numberOrZero(result.monthly_tokens_used),
    balance: numberOrZero(balance),
    quota: numberOrZero(quota),
  }
}

function errorOf(action: string, result: { status: number; message: string }): Error {
  return new Error(`${action} HTTP ${result.status} ${result.message}`.trim().slice(0, 300))
}

/**
 * 拉一次积分与 token 额度。
 *
 * 积分是主口径：它失败就整体失败（卡片要能看见原因）。token 额度是附带的，
 * 它失败只让 `tokens` 缺席 —— 别让一个次要接口把主数字一起拖没。
 */
export async function fetchCredits(
  credential: CodeArtsResolved,
  signal?: AbortSignal,
): Promise<CodeArtsCreditSnapshot> {
  const [statistics, balance, welfare] = await Promise.all([
    signedGet(`${SNAP_HOST}${EP_STATISTICS_PLUGIN}`, credential, undefined, signal),
    signedGet(`${BENEFIT_GATEWAY_HOST}${EP_TOKEN_BALANCE}`, credential, undefined, signal).catch(
      () => ({ ok: false as const, status: 0, message: 'request failed' }),
    ),
    // 签到状态也是附带的：拉不到只是按钮少一个依据，不该把积分数字一起拖没。
    fetchWelfareCampaigns(credential, signal)
      .then(campaigns => {
        const daily = pickDailyWelfareCampaign(campaigns)
        if (daily === undefined) return undefined
        return {
          claimable: daily.claimable,
          claimedToday: !daily.claimable && isWelfareClaimedStatus(daily.status),
          amount: daily.amount,
        } satisfies CodeArtsDailyWelfare
      })
      .catch(() => undefined),
  ])
  if (!statistics.ok) throw errorOf('statistics', statistics)
  const credits = parseCreditStatistics(safeJson(statistics.text))
  if (credits === undefined) throw new Error('statistics response carries no credit metrics')
  const tokens = balance.ok ? parseTokenBalance(safeJson(balance.text)) : undefined
  return {
    credits,
    ...tokens === undefined ? {} : { tokens },
    ...welfare === undefined ? {} : { welfare },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 缓存默认存活时间：卡片刷新不至于每次都打上游。 */
export const CREDIT_TTL_MS = 60_000
/** 失败缓存：短一些，让用户改完配置/重登后不用等满一分钟。 */
export const CREDIT_FAILURE_TTL_MS = 15_000

export interface CreditCacheOptions {
  ttlMs?: number
  failureTtlMs?: number
  /** 便于测试注入。 */
  load?: (credential: CodeArtsResolved, signal?: AbortSignal) => Promise<CodeArtsCreditSnapshot>
  now?: () => number
}

/**
 * 积分缓存（TTL + 单飞）。
 *
 * 单飞很重要：卡片刷新、对话底部的轮询可能同时打进来，没有它就会并发问上游好几次；
 * 而上游对同一账号的并发是有成本/风险的。
 */
export class CodeArtsCreditCache {
  private state: CodeArtsCreditState | undefined
  private inflight: Promise<CodeArtsCreditState> | undefined
  private readonly ttlMs: number
  private readonly failureTtlMs: number
  private readonly load: (credential: CodeArtsResolved, signal?: AbortSignal) => Promise<CodeArtsCreditSnapshot>
  private readonly now: () => number

  constructor(options: CreditCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? CREDIT_TTL_MS
    this.failureTtlMs = options.failureTtlMs ?? CREDIT_FAILURE_TTL_MS
    this.load = options.load ?? fetchCredits
    this.now = options.now ?? (() => Date.now())
  }

  /** 当前缓存内容（不触发请求），供只想读快照的场景使用。 */
  peek(): CodeArtsCreditState | undefined {
    return this.state
  }

  /** 丢掉缓存，下次 get 会重新拉（重新登录/添加账号后调用）。 */
  invalidate(): void {
    this.state = undefined
    this.inflight = undefined
  }

  /**
   * 取一次积分。命中缓存直接返回；否则合并成一次上游请求。
   * **不抛异常**：失败以 `phase: 'error'` 返回，调用方（状态路由）照样能渲染。
   */
  async get(credential: CodeArtsResolved, signal?: AbortSignal): Promise<CodeArtsCreditState> {
    const cached = this.state
    if (cached !== undefined) {
      const ttl = cached.phase === 'ok' ? this.ttlMs : this.failureTtlMs
      if (this.now() - cached.at < ttl) return cached
    }
    const inflight = this.inflight ??= this.run(credential, signal).finally(() => {
      this.inflight = undefined
    })
    return inflight
  }

  private async run(credential: CodeArtsResolved, signal?: AbortSignal): Promise<CodeArtsCreditState> {
    try {
      const value = await this.load(credential, signal)
      const state: CodeArtsCreditState = { phase: 'ok', value, at: this.now() }
      this.state = state
      return state
    } catch (error) {
      const state: CodeArtsCreditState = {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        at: this.now(),
      }
      this.state = state
      return state
    }
  }
}
