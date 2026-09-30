/**
 * 用量账本：把聊天流里的 usage 帧累计成「今天用了多少」。
 *
 * 为什么只能自己记：**CodeArts 没有额度/积分 API**（codearts2api 的 pool 里
 * `credits` 字段恒为 0，注释写着「CodeArts 无积分字段」；本插件也没有任何余额接口
 * 可用）。能拿到的真实数据只有两样：
 *   1. 每个请求的 token `usage`（上游在流末尾回一帧 `{choices:[],usage:{...}}`）；
 *   2. 插件自己知道的账号会话槽位占用（见 account-pool：每账号 3 个并发会话）。
 *
 * 所以这里累计的是**本机经插件发出的请求**，不是账号总额度 —— 卡片上的文案必须
 * 照实说，官方额度明细在 `codearts.huaweicloud.com/portal/settings/personal-usage`。
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
}

/** 一天之内按模型 / 按账号的累计。 */
export interface UsageDay {
  /** 模型 id -> 累计。 */
  models: Record<string, UsageTotals>
  /** 账号 id -> 累计。 */
  accounts: Record<string, UsageTotals>
}

interface UsageFile {
  version: 1
  days: Record<string, UsageDay>
}

/** 保留多少天（更早的丢掉，文件不会无限长）。 */
export const RETENTION_DAYS = 60

/** 上游 usage 帧里我们关心的字段。 */
export interface RawUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
}

export interface UsageSnapshot {
  /** 今天的合计。 */
  today: UsageTotals
  /** 账本里所有保留天数的合计。 */
  allTime: UsageTotals
  /** 今天按模型的合计，按 totalTokens 降序。 */
  byModelToday: { id: string; totals: UsageTotals }[]
  /** 今天按账号的合计。 */
  byAccountToday: Record<string, UsageTotals>
  /** 账本覆盖的天数（便于「数据从哪天开始」的说明）。 */
  days: number
  /** 最近一次记账时间（epoch ms）。 */
  lastAt?: number
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

function addTotals(into: UsageTotals, add: Partial<UsageTotals>): void {
  into.requests += add.requests ?? 0
  into.promptTokens += add.promptTokens ?? 0
  into.completionTokens += add.completionTokens ?? 0
  into.totalTokens += add.totalTokens ?? 0
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

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 从上游 usage 帧里取三个计数字段（缺哪个算 0，total 缺失时用 prompt+completion 兜底）。 */
export function normalizeUsage(raw: RawUsage | undefined): Omit<UsageTotals, 'requests'> {
  if (raw === undefined) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const promptTokens = positiveInt(raw.prompt_tokens)
  const completionTokens = positiveInt(raw.completion_tokens)
  const total = positiveInt(raw.total_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: total > 0 ? total : promptTokens + completionTokens,
  }
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
        const models = (day as UsageDay).models ?? {}
        const accounts = (day as UsageDay).accounts ?? {}
        this.days.set(date, { models, accounts })
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
    this.lastAt = at
    this.prune(at)
    this.scheduleSave()
  }

  /** 丢弃保留期之外的天（按日期键比较即可，YYYY-MM-DD 是字典序）。 */
  private prune(at: number): void {
    if (this.days.size === 0) return
    const cutoff = localDateKey(at - RETENTION_DAYS * 86_400_000)
    for (const date of [...this.days.keys()]) {
      if (date < cutoff) this.days.delete(date)
    }
  }

  /** 当前快照（卡片与 CLI 都读它）。 */
  snapshot(at: number = this.now()): UsageSnapshot {
    const todayKey = localDateKey(at)
    const today = this.days.get(todayKey)
    const allTime = emptyTotals()
    for (const day of this.days.values()) {
      for (const totals of Object.values(day.models)) mergeTotals(allTime, totals)
    }
    const models = today?.models ?? {}
    return {
      today: { ...emptyTotals(), ...(today === undefined ? {} : sumOf(models)) },
      allTime,
      byModelToday: Object.entries(models)
        .map(([id, totals]) => ({ id, totals: { ...totals } }))
        .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || (a.id < b.id ? -1 : 1)),
      byAccountToday: Object.fromEntries(
        Object.entries(today?.accounts ?? {}).map(([id, totals]) => [id, { ...totals }]),
      ),
      days: this.days.size,
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
    }
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
