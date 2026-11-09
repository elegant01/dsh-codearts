/**
 * 首字延迟 P95 的显示值。
 *
 * 单独成模块是因为这里踩过一个静默失效的顺序：`percentileOf` 落进「>30 秒」溢出档时
 * 只回 `{ overflow: true }`、不带 value（见 usage.ts 的注释：宁可不给精确值），
 * 而渲染先判 `p95 === undefined` 就会把溢出吞成「—」—— 用户看到的是「这个数一直没值」，
 * 实际是 P95 真的超过了 30 秒。溢出必须先判。
 */
export function latencyP95Label(latency: { p95?: number; overflow: boolean }): string {
  if (latency.overflow === true) return '>30 s'
  if (latency.p95 === undefined) return '—'
  return `${Math.round(latency.p95)} ms`
}
