/**
 * 用量账本：把聊天流里的 usage 帧累计成「今天用了多少」。
 *
 * 为什么还要自己记：账号总额度有积分接口了（见 credits.ts，2026-10 从官方 Agent
 * 客户端挖出并实测通过），但**本机经插件发出的请求**仍需自己累计 —— 上游不按
 * 「这台机器」维度给统计。能拿到的真实数据有三样：
 *   1. 每个请求的 token `usage`（上游在流末尾回一帧 `{choices:[],usage:{...}}`）；
 *   2. 插件自己知道的账号会话槽位占用（见 account-pool：每账号 3 个并发会话）；
 *   3. 账号积分/额度（见 credits.ts）。
 *
 * 所以这里累计的是**本机经插件发出的请求**，与卡片上的积分区块互补 —— 一个是本机
 * 级、一个是账号级。官方额度明细在 `codearts.huaweicloud.com/portal/settings/personal-usage`。
 *
 * 落盘在 `$DSH_HOME/.codearts-usage.json`，按天存，保留最近 `RETENTION_DAYS` 天。
 *
 * @module dsh-codearts/usage
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from './auth.ts'

/** 用量账本路径：与账号文档同一层（`$DSH_HOME` 或 `~/.dsh`）。 */
export function codeartsUsagePath(home?: string): string {
  const base = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, '.codearts-usage.json')
}

/** 累计计数。 */
export interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /**
   * 命中上游 prompt 缓存的输入 token（OpenAI 兼容口径）。
   *
   * 上游若在 usage 帧里带 `prompt_tokens_details.cached_tokens`（也有平铺成
   * `cached_tokens` / `cache_tokens` / `prompt_cache_hit_tokens` 的），这里才可能
   * 是正数；不给就恒为 0。UI 据此决定显不显示「缓存」那一段 —— 不臆造。
   * 它是 `promptTokens` 的**子集**，不是额外的输入量。
   */
  cachedTokens: number
  /**
   * 其中属于「思考」的输出 token（OpenAI 兼容口径：`completion_tokens_details.reasoning_tokens`，
   * 平铺成顶层 `reasoning_tokens` 的也认）。
   *
   * 推理模型（deepseek-v4.1-flash 这类）会把它单列出来，通常照样计费；不单独记就
   * 只能看见一个偏大的「输出」。它是 `completionTokens` 的**子集**，不是额外的输出量。
   * 上游不给就恒为 0。
   */
  reasoningTokens: number
}

/** 一天之内按模型 / 按账号 / 按小时的累计。 */
export interface UsageDay {
  /** 模型 id -> 累计。 */
  models: Record<string, UsageTotals>
  /** 账号 id -> 累计。 */
  accounts: Record<string, UsageTotals>
  /**
   * 钟点（两位本地小时，`00`..`23`）-> 累计。
   *
   * 只用来画「今天按小时」的曲线，所以只保留最近 `HOUR_RETENTION_DAYS` 天
   * （见 {@link CodeArtsUsageTracker.prune}）—— 60 天 × 24 格会把账本撑大一个量级，
   * 而超过两天的逐小时数据没人看。老账本没有这个键，读的时候当空表。
   */
  hours?: Record<string, UsageTotals>
}

interface UsageFile {
  version: 1
  days: Record<string, UsageDay>
}

/** 保留多少天（更早的丢掉，文件不会无限长）。 */
export const RETENTION_DAYS = 60

/** 「最近 N 天」热力图里的天数（含今天）。5 周 = 35 天，正好铺满一屏月历的 7 列格子。 */
export const TREND_DAYS = 35

/** 逐小时桶保留几天：今天 + 昨天，够画「今天按小时」和「跟昨天同一时刻比」。 */
export const HOUR_RETENTION_DAYS = 2

/** 上游 usage 帧里我们关心的字段。 */
export interface RawUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
  /** OpenAI 兼容的嵌套写法：`prompt_tokens_details: { cached_tokens }`。 */
  prompt_tokens_details?: unknown
  /** 平铺写法，几家兼容层各用各的名字，都认。 */
  cached_tokens?: unknown
  cache_tokens?: unknown
  prompt_cache_hit_tokens?: unknown
  /** 推理模型的嵌套写法：`completion_tokens_details: { reasoning_tokens }`。 */
  completion_tokens_details?: unknown
  /** 平铺的思考 token 别名。 */
  reasoning_tokens?: unknown
}

export interface UsageSnapshot {
  /** 今天的合计。 */
  today: UsageTotals
  /** 账本里所有保留天数的合计。 */
  allTime: UsageTotals
  /** 最近 30 天（含今天）的合计。 */
  last30: UsageTotals
  /** 今天按模型的合计，按 totalTokens 降序。 */
  byModelToday: { id: string; totals: UsageTotals }[]
  /** 今天按账号的合计。 */
  byAccountToday: Record<string, UsageTotals>
  /** 账本覆盖的天数（便于「数据从哪天开始」的说明）。 */
  days: number
  /**
   * 最近 {@link TREND_DAYS} 天（含今天，按日期升序）的每日合计；没账目的日子补 0。
   *
   * 补 0 而不是跳过：横轴要固定 7 格，否则「昨天没跑」和「昨天丢了」看不出区别。
   */
  recentDays: { date: string; totals: UsageTotals }[]
  /**
   * 今天 0 点到 23 点的逐小时合计（固定 24 项，还没到的钟点补 0）。
   *
   * 命中率曲线用它 —— 一次长会话把命中率拉低、隔一小时又回来，按天的粒度看不见。
   */
  todayByHour: { hour: number; totals: UsageTotals }[]
  /** 最近一次记账时间（epoch ms）。 */
  lastAt?: number
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  }
}

function addTotals(into: UsageTotals, add: Partial<UsageTotals>): void {
  into.requests += add.requests ?? 0
  into.promptTokens += add.promptTokens ?? 0
  into.completionTokens += add.completionTokens ?? 0
  into.totalTokens += add.totalTokens ?? 0
  into.cachedTokens += add.cachedTokens ?? 0
  into.reasoningTokens += add.reasoningTokens ?? 0
}

function mergeTotals(into: UsageTotals, from: UsageTotals): void {
  addTotals(into, from)
}

/** 本地日期键 YYYY-MM-DD（不用 toISOString：那是 UTC，会把跨零点的用量算到前一天）。 */
export function localDateKey(at: number = Date.now()): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地小时键 `00`..`23`（同样按本地时间切，跨零点的那一小时不会错位）。 */
export function localHourKey(at: number = Date.now()): string {
  return localHourKeyOfHour(new Date(at).getHours())
}

/** 0..23 -> `00`..`23`（小时桶的键）。 */
function localHourKeyOfHour(hour: number): string {
  return String(hour).padStart(2, '0')
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 从上游 usage 帧里取缓存命中数。
 *
 * 位置见过两种：OpenAI 的 `prompt_tokens_details.cached_tokens`，以及兼容层直接
 * 平铺在顶层的几种别名。取第一个能读到的。缓存输入必然是输入的子集，所以比
 * `promptTokens` 还大的脏数据直接钳掉 —— 否则界面上会出现 >100% 的命中率。
 */
function cachedTokensOf(raw: RawUsage, promptTokens: number): number {
  if (promptTokens <= 0) return 0
  const nested = nestedField(raw.prompt_tokens_details, 'cached_tokens')
  const cached = positiveInt(nested ?? raw.cached_tokens ?? raw.cache_tokens ?? raw.prompt_cache_hit_tokens)
  return Math.min(cached, promptTokens)
}

/**
 * 从上游 usage 帧里取思考 token。
 *
 * 口径与 {@link cachedTokensOf} 对称：嵌套 `completion_tokens_details.reasoning_tokens`
 * 优先，顶层 `reasoning_tokens` 兜底，超过输出总量就钳掉（它含在输出里）。
 */
function reasoningTokensOf(raw: RawUsage, completionTokens: number): number {
  if (completionTokens <= 0) return 0
  const nested = nestedField(raw.completion_tokens_details, 'reasoning_tokens')
  const reasoning = positiveInt(nested ?? raw.reasoning_tokens)
  return Math.min(reasoning, completionTokens)
}

/** 读 `*_tokens_details` 这类嵌套对象里的一个字段；不是对象（或缺字段）给 undefined。 */
function nestedField(details: unknown, key: string): unknown {
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)[key]
    : undefined
}

/** 从上游 usage 帧里取计数（缺哪个算 0，total 缺失时用 prompt+completion 兜底）。 */
export function normalizeUsage(raw: RawUsage | undefined): Omit<UsageTotals, 'requests'> {
  if (raw === undefined) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  }
  const promptTokens = positiveInt(raw.prompt_tokens)
  const completionTokens = positiveInt(raw.completion_tokens)
  const total = positiveInt(raw.total_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: total > 0 ? total : promptTokens + completionTokens,
    cachedTokens: cachedTokensOf(raw, promptTokens),
    reasoningTokens: reasoningTokensOf(raw, completionTokens),
  }
}

/** 读一项累计值，缺字段（旧账本没有 cachedTokens / reasoningTokens）就按 0 补齐。 */
function normalizeTotals(raw: Partial<UsageTotals> | undefined): UsageTotals {
  return {
    requests: positiveInt(raw?.requests),
    promptTokens: positiveInt(raw?.promptTokens),
    completionTokens: positiveInt(raw?.completionTokens),
    totalTokens: positiveInt(raw?.totalTokens),
    cachedTokens: positiveInt(raw?.cachedTokens),
    reasoningTokens: positiveInt(raw?.reasoningTokens),
  }
}

/** 整张「模型/账号 -> 累计」表补齐字段。 */
function normalizeStore(store: Record<string, Partial<UsageTotals>> | undefined): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {}
  for (const [key, totals] of Object.entries(store ?? {})) {
    if (typeof totals !== 'object' || totals === null) continue
    out[key] = normalizeTotals(totals)
  }
  return out
}

export interface UsageTrackerOptions {
  /** 账本文件路径；省略则只记在内存里（测试用）。 */
  path?: string
  /** 可注入的时钟。 */
  now?: () => number
  /** 落盘防抖毫秒数（流式请求里每帧都写盘太浪费）。 */
  saveDebounceMs?: number
}

/**
 * 用量账本。
 *
 * 记账分两步，因为一次请求可能只有其一：
 *  - `noteRequest()` 在请求发出时调用（拿不到 usage 的流也要计入请求数）；
 *  - `noteUsage()` 在收到 usage 帧时调用（补 token 数）。
 */
export class CodeArtsUsageTracker {
  private days = new Map<string, UsageDay>()
  private lastAt: number | undefined
  private loaded = false
  private loading: Promise<void> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  private readonly path: string | undefined
  private readonly now: () => number
  private readonly saveDebounceMs: number

  constructor(options: UsageTrackerOptions = {}) {
    this.path = options.path
    this.now = options.now ?? (() => Date.now())
    this.saveDebounceMs = options.saveDebounceMs ?? 2_000
  }

  /** 读账本（懒加载，只读一次）。 */
  async load(): Promise<void> {
    this.loading ??= this.readFile()
    return this.loading
  }

  private async readFile(): Promise<void> {
    if (this.loaded || this.path === undefined || !existsSync(this.path)) {
      this.loaded = true
      return
    }
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UsageFile>
      if (parsed.version !== 1 || typeof parsed.days !== 'object' || parsed.days === null) return
      for (const [date, day] of Object.entries(parsed.days)) {
        if (typeof day !== 'object' || day === null) continue
        const models = normalizeStore((day as UsageDay).models)
        const accounts = normalizeStore((day as UsageDay).accounts)
        const hours = (day as UsageDay).hours
        this.days.set(date, hours === undefined
          ? { models, accounts }
          : { models, accounts, hours: normalizeStore(hours) })
      }
      this.prune(this.now())
    } catch {
      // 账本坏了不值得让插件起不来：丢掉重建。
      this.days.clear()
    } finally {
      this.loaded = true
    }
  }

  private day(dateKey: string): UsageDay {
    let day = this.days.get(dateKey)
    if (day === undefined) {
      day = { models: {}, accounts: {} }
      this.days.set(dateKey, day)
    }
    return day
  }

  private bucket(store: Record<string, UsageTotals>, key: string): UsageTotals {
    let totals = store[key]
    if (totals === undefined) {
      totals = emptyTotals()
      store[key] = totals
    }
    return totals
  }

  /** 记一次请求（不等到 usage 帧）。 */
  noteRequest(accountId: string, model: string, at: number = this.now()): void {
    const day = this.day(localDateKey(at))
    addTotals(this.bucket(day.models, model), { requests: 1 })
    addTotals(this.bucket(day.accounts, accountId), { requests: 1 })
    addTotals(this.bucket(this.hoursOf(day), localHourKey(at)), { requests: 1 })
    this.lastAt = at
    this.prune(at) // 常驻进程也能自然淘汰旧数据，不必等下次重启
    this.scheduleSave()
  }

  /** 记一次 usage 帧。 */
  noteUsage(accountId: string, model: string, raw: RawUsage | undefined, at: number = this.now()): void {
    const usage = normalizeUsage(raw)
    if (usage.totalTokens === 0 && usage.promptTokens === 0 && usage.completionTokens === 0) return
    const day = this.day(localDateKey(at))
    addTotals(this.bucket(day.models, model), usage)
    addTotals(this.bucket(day.accounts, accountId), usage)
    addTotals(this.bucket(this.hoursOf(day), localHourKey(at)), usage)
    this.lastAt = at
    this.prune(at)
    this.scheduleSave()
  }

  /** 一天里的逐小时桶，第一次写的时候才建（老账本没有这个键）。 */
  private hoursOf(day: UsageDay): Record<string, UsageTotals> {
    day.hours ??= {}
    return day.hours
  }

  /**
   * 丢弃保留期之外的天（按日期键比较即可，YYYY-MM-DD 是字典序）。
   *
   * 顺带把两天之前的**小时桶**清掉：逐小时数据只有「今天按小时」在画，留着只是
   * 让 60 天的账本多出一个数量级的体积。
   */
  private prune(at: number): void {
    if (this.days.size === 0) return
    const cutoff = localDateKey(at - RETENTION_DAYS * 86_400_000)
    const hourCutoff = localDateKey(at - HOUR_RETENTION_DAYS * 86_400_000)
    for (const [date, day] of [...this.days.entries()]) {
      if (date < cutoff) {
        this.days.delete(date)
      } else if (date < hourCutoff && day.hours !== undefined) {
        delete day.hours
      }
    }
  }

  /** 当前快照（卡片与 CLI 都读它）。 */
  snapshot(at: number = this.now()): UsageSnapshot {
    const todayKey = localDateKey(at)
    const today = this.days.get(todayKey)
    const cutoff = localDateKey(at - 30 * 86_400_000)
    const allTime = emptyTotals()
    const last30 = emptyTotals()
    for (const [date, day] of this.days) {
      for (const totals of Object.values(day.models)) {
        mergeTotals(allTime, totals)
        if (date >= cutoff) mergeTotals(last30, totals)
      }
    }
    const models = today?.models ?? {}
    return {
      today: { ...emptyTotals(), ...(today === undefined ? {} : sumOf(models)) },
      allTime,
      last30,
      byModelToday: Object.entries(models)
        .map(([id, totals]) => ({ id, totals: { ...totals } }))
        .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || (a.id < b.id ? -1 : 1)),
      byAccountToday: Object.fromEntries(
        Object.entries(today?.accounts ?? {}).map(([id, totals]) => [id, { ...totals }]),
      ),
      days: this.days.size,
      recentDays: this.recentDaysOf(at),
      todayByHour: this.todayByHourOf(today, at),
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
    }
  }

  /** 最近 TREND_DAYS 天的每日合计（按日期升序，缺账目的日子补 0）。 */
  private recentDaysOf(at: number): UsageSnapshot['recentDays'] {
    const out: UsageSnapshot['recentDays'] = []
    for (let back = TREND_DAYS - 1; back >= 0; back -= 1) {
      const date = localDateKey(at - back * 86_400_000)
      const day = this.days.get(date)
      out.push({ date, totals: day === undefined ? emptyTotals() : sumOf(day.models) })
    }
    return out
  }

  /** 今天 0 点起的 24 个钟点（还没到的小时补 0，横轴才有固定的 24 格）。 */
  private todayByHourOf(today: UsageDay | undefined, at: number): UsageSnapshot['todayByHour'] {
    const hours = today?.hours ?? {}
    const currentHour = new Date(at).getHours()
    return Array.from({ length: 24 }, (_, hour) => {
      const totals = hours[localHourKeyOfHour(hour)]
      return {
        hour,
        // 未来的钟点连空桶都不给：那是「还没发生」，不是「发生了但为 0」。
        totals: hour > currentHour || totals === undefined ? emptyTotals() : { ...totals },
      }
    })
  }

  private scheduleSave(): void {
    if (this.path === undefined) return
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, this.saveDebounceMs)
    this.saveTimer.unref?.()
  }

  /** 立即落盘（关停时调用，别丢最后几秒的账）。 */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.save()
  }

  private save(): Promise<void> {
    if (this.path === undefined) return Promise.resolve()
    const doc: UsageFile = { version: 1, days: Object.fromEntries(this.days) }
    this.saving = this.saving.then(
      () => writeJsonAtomic(this.path as string, doc),
      () => writeJsonAtomic(this.path as string, doc),
    )
    return this.saving
  }
}

/** 一批桶的合计。 */
function sumOf(store: Record<string, UsageTotals>): UsageTotals {
  const out = emptyTotals()
  for (const totals of Object.values(store)) mergeTotals(out, totals)
  return out
}
