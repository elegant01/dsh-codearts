import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodeArtsUsageTracker, codeartsUsagePath, localDateKey, normalizeUsage, RETENTION_DAYS } from '../src/usage.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-usage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('localDateKey', () => {
  it('uses the local calendar day, not UTC', () => {
    // 2026-09-30 23:30 本地时间：用 toISOString 会算成 10-01（UTC 已是次日）。
    const at = new Date(2026, 8, 30, 23, 30, 0).getTime()
    expect(localDateKey(at)).toBe('2026-09-30')
  })
})

describe('normalizeUsage', () => {
  it('falls back to prompt+completion when total is missing', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
  })

  it('ignores junk values instead of writing NaN into the ledger', () => {
    expect(normalizeUsage({ prompt_tokens: 'x' as unknown, completion_tokens: -3, total_tokens: 7.9 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 7,
    })
    expect(normalizeUsage(undefined)).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  })
})

describe('CodeArtsUsageTracker', () => {
  it('accumulates requests and tokens today, by model and by account', () => {
    const tracker = new CodeArtsUsageTracker()
    tracker.noteRequest('acct-1', 'GLM-5.2')
    tracker.noteUsage('acct-1', 'GLM-5.2', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
    tracker.noteRequest('acct-2', 'deepseek-v4.1-flash')
    tracker.noteUsage('acct-2', 'deepseek-v4.1-flash', { prompt_tokens: 50, completion_tokens: 10 })

    const snapshot = tracker.snapshot()
    expect(snapshot.today).toEqual({ requests: 2, promptTokens: 150, completionTokens: 30, totalTokens: 180 })
    expect(snapshot.allTime.totalTokens).toBe(180)
    expect(snapshot.byAccountToday['acct-1']?.requests).toBe(1)
    expect(snapshot.byAccountToday['acct-2']?.totalTokens).toBe(60)
    // 便于卡片展示：按 token 降序
    expect(snapshot.byModelToday.map(m => m.id)).toEqual(['GLM-5.2', 'deepseek-v4.1-flash'])
  })

  it('counts a request even when no usage frame ever arrives', () => {
    const tracker = new CodeArtsUsageTracker()
    tracker.noteRequest('acct-1', 'GLM-5.2') // 例如用户中途点了停止生成
    expect(tracker.snapshot().today).toEqual({ requests: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  })

  it('ignores an all-zero usage frame (no phantom record)', () => {
    const tracker = new CodeArtsUsageTracker()
    tracker.noteUsage('acct-1', 'GLM-5.2', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
    expect(tracker.snapshot().today.requests).toBe(0)
    expect(tracker.snapshot().byModelToday).toEqual([])
  })

  it('keeps days apart so "today" does not include yesterday', () => {
    const tracker = new CodeArtsUsageTracker()
    const yesterday = new Date(2026, 8, 29, 12, 0, 0).getTime()
    const today = new Date(2026, 8, 30, 12, 0, 0).getTime()
    tracker.noteRequest('acct-1', 'GLM-5.2', yesterday)
    tracker.noteUsage('acct-1', 'GLM-5.2', { total_tokens: 500 }, yesterday)
    tracker.noteRequest('acct-1', 'GLM-5.2', today)
    tracker.noteUsage('acct-1', 'GLM-5.2', { total_tokens: 100 }, today)

    const snapshot = tracker.snapshot(today)
    expect(snapshot.today.requests).toBe(1)
    expect(snapshot.today.totalTokens).toBe(100)
    expect(snapshot.allTime.requests).toBe(2)
    expect(snapshot.allTime.totalTokens).toBe(600)
    expect(snapshot.days).toBe(2)
  })

  it('survives a restart: writes atomically and reads the ledger back', async () => {
    const path = join(dir, '.codearts-usage.json')
    const first = new CodeArtsUsageTracker({ path, saveDebounceMs: 0 })
    first.noteRequest('acct-1', 'GLM-5.2')
    first.noteUsage('acct-1', 'GLM-5.2', { prompt_tokens: 40, completion_tokens: 2 })
    await first.flush()
    expect(existsSync(path)).toBe(true)

    const second = new CodeArtsUsageTracker({ path })
    await second.load()
    const snapshot = second.snapshot()
    expect(snapshot.today.requests).toBe(1)
    expect(snapshot.today.promptTokens).toBe(40)
  })

  it('starts clean when the ledger file is corrupt instead of failing the plugin', async () => {
    const path = join(dir, '.codearts-usage.json')
    await writeFile(path, '{ this is not json', 'utf8')
    const tracker = new CodeArtsUsageTracker({ path })
    await tracker.load()
    tracker.noteRequest('acct-1', 'GLM-5.2')
    expect(tracker.snapshot().today.requests).toBe(1)
  })

  it('drops days past the retention window', async () => {
    const path = join(dir, '.codearts-usage.json')
    const now = Date.now()
    const old = localDateKey(now - (RETENTION_DAYS + 5) * 86_400_000)
    const recent = localDateKey(now - 86_400_000)
    await writeFile(path, JSON.stringify({
      version: 1,
      days: {
        [old]: { models: { 'GLM-5.2': { requests: 9, promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, accounts: {} },
        [recent]: { models: { 'GLM-5.2': { requests: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, accounts: {} },
      },
    }), 'utf8')

    const tracker = new CodeArtsUsageTracker({ path })
    await tracker.load()
    const snapshot = tracker.snapshot()
    expect(snapshot.allTime.requests).toBe(1) // 旧的那天被丢掉
    expect(snapshot.days).toBe(1)
  })

  it('keeps the file readable: version tag plus one entry per day', async () => {
    const path = join(dir, '.codearts-usage.json')
    const tracker = new CodeArtsUsageTracker({ path, saveDebounceMs: 0 })
    tracker.noteRequest('acct-1', 'GLM-5.2')
    await tracker.flush()
    const doc = JSON.parse(await readFile(path, 'utf8')) as { version: number; days: Record<string, unknown> }
    expect(doc.version).toBe(1)
    expect(Object.keys(doc.days)).toEqual([localDateKey()])
  })
})

describe('codeartsUsagePath', () => {
  it('lives next to the account document under DSH_HOME', () => {
    expect(codeartsUsagePath('/tmp/home')).toBe(join('/tmp/home', '.codearts-usage.json'))
  })
})
