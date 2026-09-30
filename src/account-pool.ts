/**
 * 账号池：把多个 CodeArts 账号编成一个可轮转的池。
 *
 * 为什么要多账号：上游对**每个账号**只允许 3 个并发会话，每个会话占满约 52 秒
 * 才释放，而且**中途打断并不减免**这个占用（实测：只跑 98ms 就中止的请求同样
 * 占满一个名额 52 秒）。单账号下「打断 → 立刻重问」必然要等；多一个账号就多
 * 一份配额，请求可以直接换号，不用等。
 *
 * 结构参照 codearts2api（Go）的 `internal/pool`，但只取本项目用得到的那部分：
 * 每账号的槽位计数、健康/冷却状态、以及选号。保活心跳、签到、积分一律不搬。
 *
 * @module dsh-codearts/account-pool
 */

/** 单账号默认并发上限。上游给 3 个会话，留 1 个给 CodeArts 网页端。 */
export const DEFAULT_MAX_CONCURRENT = 2

/**
 * 撞到上游并发上限后，多久内优先不选这个账号。
 *
 * 这不是冷却：账号本身没坏，只是它的会话槽位暂时满了（约 52 秒才释放）。
 * 所以只是一个「倾向」——池里还有别的账号就先换一个；全都这样时照样会选它，
 * 因为排队等它总比直接失败强。
 */
export const CAPPED_HINT_MS = 30_000

/** 连续出错多少次后短时冷却。 */
export const ERROR_THRESHOLD = 3

export interface AccountRuntime {
  id: string
  /** 我们这边正在飞的请求数。 */
  activeConcurrent: number
  maxConcurrent: number
  /** 冷却截止时间（epoch ms）；0 表示没在冷却。 */
  coolUntil: number
  /** 撞上游并发上限后的「优先避开」截止时间。 */
  cappedUntil: number
  disabled: boolean
  lastError?: string
  /** 上次被选中的时间，用于「最久未用优先」。 */
  lastUsed: number
  errorCount: number
}

export interface PoolOptions {
  maxConcurrent?: number
  /** 可注入的时钟，便于测试。 */
  now?: () => number
}

export class CodeArtsAccountPool {
  private readonly accounts = new Map<string, AccountRuntime>()
  private readonly maxConcurrent: number
  private readonly now: () => number

  constructor(ids: readonly string[], options: PoolOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.now = options.now ?? (() => Date.now())
    this.sync(ids)
  }

  /** 让池与账号文档对齐：新增的进来，删掉的出去。已有账号的运行时状态保留。 */
  sync(ids: readonly string[]): void {
    const wanted = new Set(ids)
    for (const id of [...this.accounts.keys()]) {
      if (!wanted.has(id)) this.accounts.delete(id)
    }
    for (const id of ids) {
      if (this.accounts.has(id)) continue
      this.accounts.set(id, {
        id,
        activeConcurrent: 0,
        maxConcurrent: this.maxConcurrent,
        coolUntil: 0,
        cappedUntil: 0,
        disabled: false,
        lastUsed: 0,
        errorCount: 0,
      })
    }
  }

  list(): AccountRuntime[] {
    return [...this.accounts.values()]
  }

  get(id: string): AccountRuntime | undefined {
    return this.accounts.get(id)
  }

  /** 账号本身可用（没被禁用、不在冷却中）。 */
  healthy(id: string): boolean {
    const account = this.accounts.get(id)
    if (account === undefined) return false
    return !account.disabled && this.now() >= account.coolUntil
  }

  /** 现在就能接活的账号（健康 + 本地还有空槽位），按「最久未用」排序。 */
  private available(exclude: ReadonlySet<string>): AccountRuntime[] {
    const now = this.now()
    return this.list()
      .filter(a => !a.disabled && now >= a.coolUntil && !exclude.has(a.id) && a.activeConcurrent < a.maxConcurrent)
      .sort((a, b) => a.lastUsed - b.lastUsed)
  }

  /**
   * 选一个账号。
   *
   * 优先挑没人撞上限的（`cappedUntil` 已过的）；如果全都撞了，就退回其中任意
   * 一个 —— 排它的队总比直接失败强。都没得选（全禁用/全在冷却）时返回 undefined。
   */
  pick(exclude: ReadonlySet<string> = new Set()): string | undefined {
    const candidates = this.available(exclude)
    if (candidates.length === 0) return undefined
    const now = this.now()
    const notCapped = candidates.filter(a => now >= a.cappedUntil)
    return (notCapped.length > 0 ? notCapped[0] : candidates[0]).id
  }

  /** 占一个本地槽位。占用失败（已满/不存在）返回 false。 */
  acquire(id: string): boolean {
    const account = this.accounts.get(id)
    if (account === undefined) return false
    if (account.activeConcurrent >= account.maxConcurrent) return false
    account.activeConcurrent += 1
    account.lastUsed = this.now()
    return true
  }

  /** 释放槽位；重复释放不会把计数压到负数。 */
  release(id: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    if (account.activeConcurrent > 0) account.activeConcurrent -= 1
  }

  /**
   * 撞到上游并发上限。
   *
   * **不冷却账号** —— 账号没坏，只是会话槽位暂时满了（约 52 秒释放）。冷却会
   * 让它在一分钟内彻底不可用，反而把后续请求也一起误伤（Go 参考里也是这么
   * 处理的）。这里只记一个「优先避开」的提示，好让并发的请求先去用别的账号。
   */
  noteConcurrencyCap(id: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.cappedUntil = this.now() + CAPPED_HINT_MS
  }

  /** 凭据失效等硬错误：直接停用，等用户重新登录。 */
  disable(id: string, reason: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.disabled = true
    account.lastError = reason
  }

  /** 上游 5xx / 软限流：短时冷却。 */
  cooldown(id: string, ms: number, reason: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.coolUntil = this.now() + ms
    account.lastError = reason
  }

  /** 累计错误；达到阈值就冷却。 */
  noteError(id: string, threshold: number, cooldownMs: number, reason: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.errorCount += 1
    account.lastError = reason
    if (threshold > 0 && account.errorCount >= threshold) {
      account.coolUntil = this.now() + cooldownMs
    }
  }

  /** 一次成功：清掉错误计数与冷却。 */
  noteSuccess(id: string): void {
    const account = this.accounts.get(id)
    if (account === undefined) return
    account.errorCount = 0
    account.coolUntil = 0
    account.lastError = undefined
  }

  /** 有没有任何账号可用（含被撞上限提示的）。 */
  hasUsable(): boolean {
    const now = this.now()
    return this.list().some(a => !a.disabled && now >= a.coolUntil)
  }
}
