/**
 * 上游排队的「闸门」。
 *
 * 26.10.0 起上游有 `GET /api/v1/queue/status`，但它**不是只读查询**：GET 本身会把
 * 这个 task 挂进队列、返回队尾位置，`DELETE` 才把它清掉（2026-10-21 实测）。真正
 * 的 chat 请求并不看这个号 —— 拿着一张第 535 位的票去 POST，942ms 就开流了。
 * 官方客户端的做法是：只对 `enable_queue` 的模型，先轮询排队接口，等状态变成
 * `working` 才发聊天请求（见 vscode-codebot 的 `startQueuePolling`）。
 *
 * 这张票的定位是**提示，不是门禁**（issue #10）：真正的 chat 请求并不校验它，
 * 所以 `wait()` 只做一次短探（`maxWaitMs`，默认 5 秒），结果交给 shim ——
 * 没轮到也照发请求，底部积分条在这几秒里显示「排队第 N 位」。以前等满 20 秒
 * 就直接回 400，用户看到的失败其实是插件自己造出来的。
 *
 * 宿主也等不起：流空闲超时只有 90 秒（等待期间一个字节都发不出去，SSE 注释帧
 * 也不算事件），而 flash 高峰期队尾有 500+ 号、要等二十几分钟。真正值得等的位置
 * 在 POST 被上游明确拒绝之后（还没写任何字节，重发安全），由 shim 退避重试。
 *
 * 收尾（轮到/超时/取消/失败）都会 DELETE 清号，别把幽灵排队留在上游撑大队列。
 *
 * @module dsh-codearts/queue
 */

import {
  clearQueueStatus,
  fetchQueueStatus,
  type CodeArtsQueueStatus,
  type CodeArtsResolved,
} from './upstream.ts'

export interface CodeArtsQueueEntry {
  /** chat_id，与上游 task_id 的尾段一致。 */
  id: string
  model: string
  position: number
  length: number
  status: string
  message?: string
  updatedAt: number
}

export type CodeArtsQueueOutcome =
  /** 轮到了（或模型本来就不排队），可以发请求。 */
  | { kind: 'working' }
  /** 短探没轮到：只是提示，shim 照常发请求。 */
  | { kind: 'queued'; position: number; length: number; message: string }
  /** 队列本身已满；同样只是提示，不拦请求。 */
  | { kind: 'queue_full'; message: string }
  /** 排队接口连续失败：拿不到位置就安静地照发，不影响请求。 */
  | { kind: 'error'; message: string }
  /** 用户取消或插件退出。 */
  | { kind: 'aborted' }

export interface CodeArtsQueueGateOptions {
  /** 两次查询之间的间隔（官方客户端是 5 秒）。 */
  intervalMs?: number
  /** 短探多久（只影响底部提示的可见时长，不拦请求）。 */
  maxWaitMs?: number
  /** 连续失败几次就放弃。 */
  maxErrors?: number
  /** 注入查询函数（测试用）。 */
  fetchStatus?: (
    credential: CodeArtsResolved,
    chatId: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<CodeArtsQueueStatus>
  /** 注入清号函数（测试用）。 */
  clearStatus?: (credential: CodeArtsResolved, chatId: string, model: string) => Promise<void>
  now?: () => number
}

const CLEAR_TIMEOUT_MS = 5_000

export class CodeArtsQueueGate {
  private readonly entries = new Map<string, CodeArtsQueueEntry>()
  private readonly controllers = new Set<AbortController>()
  private readonly intervalMs: number
  private readonly maxWaitMs: number
  private readonly maxErrors: number
  private readonly query: NonNullable<CodeArtsQueueGateOptions['fetchStatus']>
  private readonly clear: NonNullable<CodeArtsQueueGateOptions['clearStatus']>
  private readonly now: () => number

  constructor(options: CodeArtsQueueGateOptions = {}) {
    this.intervalMs = options.intervalMs ?? 5_000
    this.maxWaitMs = options.maxWaitMs ?? 5_000
    this.maxErrors = options.maxErrors ?? 3
    this.query = options.fetchStatus ?? fetchQueueStatus
    this.clear =
      options.clearStatus ??
      ((credential, chatId, model) => clearQueueStatus(credential, chatId, model, AbortSignal.timeout(CLEAR_TIMEOUT_MS)))
    this.now = options.now ?? Date.now
  }

  /**
   * 占号并**最多探 `maxWaitMs`**。调用方只拿结果做提示：`working` 表示正好轮到，
   * 其余结果照发 chat 请求（这张票不拦请求，见模块注释）。
   */
  async wait(
    credential: CodeArtsResolved,
    chatId: string,
    model: string,
    signal?: AbortSignal,
    /** 覆盖这次探测的时长（「一直等到轮到」开关会传几分钟）。 */
    budgetMs: number = this.maxWaitMs,
  ): Promise<CodeArtsQueueOutcome> {
    if (chatId === '') return { kind: 'working' }
    if (signal?.aborted === true) return { kind: 'aborted' }

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    this.controllers.add(controller)

    const entry: CodeArtsQueueEntry = {
      id: chatId,
      model,
      position: 0,
      length: 0,
      status: '',
      updatedAt: this.now(),
    }
    this.entries.set(chatId, entry)

    let errors = 0
    const deadlineAt = this.now() + budgetMs
    try {
      for (;;) {
        if (controller.signal.aborted) return { kind: 'aborted' }
        let status: CodeArtsQueueStatus
        try {
          status = await this.query(credential, chatId, model, controller.signal)
          errors = 0
        } catch (error: unknown) {
          if (controller.signal.aborted) return { kind: 'aborted' }
          errors += 1
          if (errors >= this.maxErrors) {
            return { kind: 'error', message: `查询上游排队状态连续失败 ${errors} 次：${errorText(error)}` }
          }
          await this.pause(controller.signal)
          continue
        }
        entry.status = status.status
        entry.position = status.queuePosition
        entry.length = status.queueLength
        entry.message = status.message
        entry.updatedAt = this.now()
        const verdict = verdictOf(status)
        if (verdict !== undefined) return verdict
        // 探够了就把结果交出去：请求照发，位置只用来提示。
        if (this.now() >= deadlineAt) {
          return { kind: 'queued', position: status.queuePosition, length: status.queueLength, message: status.message }
        }
        await this.pause(controller.signal, Math.min(this.intervalMs, deadlineAt - this.now()))
      }
    } finally {
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', onAbort)
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId)
      await this.clear(credential, chatId, model).catch(() => {})
    }
  }

  /** 正在排队的条目（给底部条）。 */
  snapshot(): readonly CodeArtsQueueEntry[] {
    return [...this.entries.values()]
      .filter(entry => entry.position > 0 || (entry.status !== '' && entry.status !== 'working'))
      .map(entry => ({
        id: entry.id,
        model: entry.model,
        position: entry.position,
        length: entry.length,
        status: entry.status,
        ...(entry.message === '' ? {} : { message: entry.message }),
        updatedAt: entry.updatedAt,
      }))
  }

  dispose(): void {
    for (const controller of [...this.controllers]) controller.abort()
  }

  private pause(signal: AbortSignal, delay: number = this.intervalMs): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(finish, Math.max(0, delay))
      timer.unref?.()
      function finish(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

/**
 * 这个状态还要不要继续等。
 *
 * `working` = 轮到；`queue_full` = 队列已满，上游建议换模型；其余（waiting 等）继续。
 * 空状态且位置为 0 说明这个模型根本没排队（如 GLM），直接放行。
 */
function verdictOf(status: CodeArtsQueueStatus): CodeArtsQueueOutcome | undefined {
  const text = status.status.trim().toLowerCase()
  if (text === 'working') return { kind: 'working' }
  if (text === 'queue_full') return { kind: 'queue_full', message: status.message }
  if (text === '' && status.queuePosition === 0 && status.queueLength === 0) return { kind: 'working' }
  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
