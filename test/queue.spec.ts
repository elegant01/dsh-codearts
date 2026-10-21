import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeArtsQueueGate } from '../src/queue.ts'
import type { CodeArtsQueueStatus, CodeArtsResolved } from '../src/upstream.ts'

const credential = { token: 'token', securityToken: 'token' } as CodeArtsResolved

const working = (): CodeArtsQueueStatus => ({ status: 'working', queueLength: 0, queuePosition: 0, message: '' })
const waiting = (position: number, length: number): CodeArtsQueueStatus => ({
  status: 'waiting',
  queueLength: length,
  queuePosition: position,
  message: `当前请求量较大，您排在第${position}位。`,
})

describe('CodeArtsQueueGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('占号后立刻查询，每 5 秒一次，轮到后清号放行', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(waiting(2, 4))
      .mockResolvedValueOnce(waiting(1, 4))
      .mockResolvedValueOnce(working())
    const clear = vi.fn(async () => {})
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: clear })

    const outcome = gate.wait(credential, 'chat-1', 'deepseek-v4.1-flash')
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)
    expect(gate.snapshot()).toEqual([
      {
        id: 'chat-1',
        model: 'deepseek-v4.1-flash',
        position: 2,
        length: 4,
        status: 'waiting',
        message: '当前请求量较大，您排在第2位。',
        updatedAt: expect.any(Number),
      },
    ])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(query).toHaveBeenCalledTimes(2)
    expect(gate.snapshot()[0]?.position).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toEqual({ kind: 'working' })
    expect(query).toHaveBeenCalledTimes(3)
    expect(gate.snapshot()).toEqual([])
    expect(clear).toHaveBeenCalledWith(credential, 'chat-1', 'deepseek-v4.1-flash')
  })

  it('不排队的模型（working / 空状态）一次就放行', async () => {
    const query = vi.fn(async () => working())
    const clear = vi.fn(async () => {})
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: clear })
    await expect(gate.wait(credential, 'chat-1', 'GLM-5.2')).resolves.toEqual({ kind: 'working' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)

    const empty = new CodeArtsQueueGate({
      fetchStatus: vi.fn(async () => ({ status: '', queueLength: 0, queuePosition: 0, message: '' })),
      clearStatus: clear,
    })
    await expect(empty.wait(credential, 'chat-2', 'GLM-5.2')).resolves.toEqual({ kind: 'working' })
  })

  it('等满 maxWaitMs 还在队里就返回 queued 并清号（不把请求挂着）', async () => {
    const query = vi.fn(async () => waiting(571, 599))
    const clear = vi.fn(async () => {})
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: clear, maxWaitMs: 20_000 })
    const outcome = gate.wait(credential, 'chat-1', 'deepseek-v4.1-flash')
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(outcome).resolves.toEqual({
      kind: 'queued',
      position: 571,
      length: 599,
      message: '当前请求量较大，您排在第571位。',
    })
    // 0/5/10/15/20 秒各查一次，到点就收 —— 不会一直轮下去。
    expect(query).toHaveBeenCalledTimes(5)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(gate.snapshot()).toEqual([])
  })

  it('queue_full 直接返回上游文案并清号', async () => {
    const query = vi.fn(async () => ({
      status: 'queue_full',
      queueLength: 0,
      queuePosition: 0,
      message: '队列已满，请稍后再试',
    }))
    const clear = vi.fn(async () => {})
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: clear })
    await expect(gate.wait(credential, 'chat-1', 'deepseek-v4.1-flash')).resolves.toEqual({
      kind: 'queue_full',
      message: '队列已满，请稍后再试',
    })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('取消时停止轮询并清号', async () => {
    const query = vi.fn(async () => waiting(9, 10))
    const clear = vi.fn(async () => {})
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: clear })
    const controller = new AbortController()
    const outcome = gate.wait(credential, 'chat-1', 'deepseek-v4.1-flash', controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)

    controller.abort()
    await expect(outcome).resolves.toEqual({ kind: 'aborted' })
    expect(gate.snapshot()).toEqual([])
    expect(clear).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('连续三次查询失败就放弃并清号', async () => {
    const query = vi.fn(async () => {
      throw new Error('queue endpoint down')
    })
    const clear = vi.fn(async () => {})
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: clear })
    const outcome = gate.wait(credential, 'chat-1', 'deepseek-v4.1-flash')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toEqual({
      kind: 'error',
      message: '查询上游排队状态连续失败 3 次：queue endpoint down',
    })
    expect(query).toHaveBeenCalledTimes(3)
    expect(clear).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('dispose 会中止正在等待的请求', async () => {
    const query = vi.fn(async () => waiting(5, 5))
    const gate = new CodeArtsQueueGate({ fetchStatus: query, clearStatus: vi.fn(async () => {}) })
    const outcome = gate.wait(credential, 'chat-1', 'deepseek-v4.1-flash')
    await vi.advanceTimersByTimeAsync(0)
    gate.dispose()
    await expect(outcome).resolves.toEqual({ kind: 'aborted' })
    expect(gate.snapshot()).toEqual([])
  })
})
