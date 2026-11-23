/**
 * 「按账号并发上限」在浏览器侧的共享状态（issue #16）。
 *
 * 与 `dock-store` 同一个理由：同一张卡片会同时挂在设置页、侧边栏和插件详情页，
 * 各自 fetch 的话，在 A 处改完并发，B 处会一直显示旧数字。
 *
 * @module dsh-codearts/client/concurrency-store
 */

export interface ConcurrencySnapshot {
  /** 没单独设置过的账号用的上限。 */
  default: number
  /** 按账号覆盖（账号 id → 并发数）。 */
  caps: Record<string, number>
  writable: boolean
  /** 是否至少成功读到过一次服务端值。 */
  loaded: boolean
}

let snapshot: ConcurrencySnapshot = { default: 2, caps: {}, writable: false, loaded: false }
const listeners = new Set<() => void>()

export function concurrencySnapshot(): ConcurrencySnapshot {
  return snapshot
}

export function publishConcurrency(patch: {
  default?: number
  caps?: Record<string, number>
  writable?: boolean
}): void {
  const next: ConcurrencySnapshot = {
    default: patch.default ?? snapshot.default,
    caps: patch.caps ?? snapshot.caps,
    writable: patch.writable ?? snapshot.writable,
    loaded: true,
  }
  if (
    next.default === snapshot.default
    && next.writable === snapshot.writable
    && snapshot.loaded
    && sameCaps(next.caps, snapshot.caps)
  ) return
  snapshot = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error: unknown) {
      console.error('[dsh-codearts] concurrency-store listener failed:', error)
    }
  }
}

function sameCaps(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

export function subscribeConcurrency(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
