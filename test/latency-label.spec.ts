import { describe, expect, it } from 'vitest'
import { latencyP95Label } from '../src/client/latency-label.ts'

/**
 * 首字 P95 卡的显示口径。回归位是第一条：溢出档没有 value，
 * 渲染顺序写反时它会显示成「—」，看起来像一直没采到样本。
 */
describe('latencyP95Label', () => {
  it('says ">30 s" when P95 lands in the overflow bucket (no value there)', () => {
    // 实测形态：今天 175 个样本、>30 秒档 15 个 ⇒ percentileOf 回 { overflow: true } 且没有 p95。
    expect(latencyP95Label({ overflow: true })).toBe('>30 s')
  })

  it('prints the bucket upper bound in ms when P95 is inside the ladder', () => {
    expect(latencyP95Label({ p95: 5000, overflow: false })).toBe('5000 ms')
    expect(latencyP95Label({ p95: 200, overflow: false })).toBe('200 ms')
  })

  it('shows the dash only when there really is no percentile at all', () => {
    expect(latencyP95Label({ overflow: false })).toBe('—')
  })
})
