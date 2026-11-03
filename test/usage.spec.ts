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
      cachedTokens: 0,
      reasoningTokens: 0,
    })
  })

  // 缓存输入是输入的子集：上游有的用嵌套 details，有的直接平铺几个别名。
  it('reads cached prompt tokens from the nested or flat shape', () => {
    expect(normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40 },
    })).toEqual({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedTokens: 40,
      reasoningTokens: 0,
    })
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 30 }).cachedTokens).toBe(30)
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, cache_tokens: 20 }).cachedTokens).toBe(20)
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60 }).cachedTokens).toBe(60)
  })

  // 嵌套写法优先；缓存超过输入是脏数据（命中率会 >100%），钳掉。
  it('never reports more cached tokens than the prompt itself', () => {
    expect(normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 120 },
    }).cachedTokens).toBe(100)
    expect(normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 70 },
      prompt_cache_hit_tokens: 90,
    }).cachedTokens).toBe(70)
    // 没有 prompt 就没有缓存可言。
    expect(normalizeUsage({ completion_tokens: 5, cached_tokens: 9 }).cachedTokens).toBe(0)
  })

  // 思考 token 含在输出里：嵌套 details 优先，平铺别名兜底，超过输出就钳掉。
  it('reads reasoning tokens and never lets them exceed the completion itself', () => {
    expect(normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 12 },
    })).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 0,
      reasoningTokens: 12,
    })
    expect(normalizeUsage({ prompt_tokens: 1, completion_tokens: 20, reasoning_tokens: 7 }).reasoningTokens).toBe(7)
    expect(normalizeUsage({
      prompt_tokens: 1,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 40 },
    }).reasoningTokens).toBe(20)
    // 没有输出就没有思考可言。
    expect(normalizeUsage({ prompt_tokens: 5, reasoning_tokens: 3 }).reasoningTokens).toBe(0)
  })

  // 按华为实测的帧形状钉住：两个 details 是并存的（见 /api/codearts/debug 的 usages）。
  it('parses the frame shape the upstream actually sends', () => {
    expect(normalizeUsage({
      prompt_tokens: 76_988,
      completion_tokens: 697,
      total_tokens: 77_685,
      prompt_tokens_details: { cached_tokens: 73_728 },
      completion_tokens_details: { reasoning_tokens: 505 },
    })).toEqual({
      promptTokens: 76_988,
      completionTokens: 697,
      totalTokens: 77_685,
      cachedTokens: 73_728,
      reasoningTokens: 505,
    })
  })

  it('ignores junk values instead of writing NaN into the ledger', () => {
    expect(normalizeUsage({ prompt_tokens: 'x' as unknown, completion_tokens: -3, total_tokens: 7.9 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 7,
      cachedTokens: 0,
      reasoningTokens: 0,
    })
    expect(normalizeUsage(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    })
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
    expect(snapshot.today).toEqual({
      requests: 2,
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
      cachedTokens: 0,
      reasoningTokens: 0,
    })
    expect(snapshot.allTime.totalTokens).toBe(180)
    expect(snapshot.byAccountToday['acct-1']?.requests).toBe(1)
    expect(snapshot.byAccountToday['acct-2']?.totalTokens).toBe(60)
    // 便于卡片展示：按 token 降序
    expect(snapshot.byModelToday.map(m => m.id)).toEqual(['GLM-5.2', 'deepseek-v4.1-flash'])
  })

  it('counts a request even when no usage frame ever arrives', () => {
    const tracker = new CodeArtsUsageTracker()
    tracker.noteRequest('acct-1', 'GLM-5.2') // 例如用户中途点了停止生成
    expect(tracker.snapshot().today).toEqual({
      requests: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    })
  })

  // 缓存与思考都要按「模型 × 账号」两个桶各记一份，否则卡片和弹层对不上。
  it('accumulates cached and reasoning tokens per model and per account', () => {
    const tracker = new CodeArtsUsageTracker()
    tracker.noteUsage('acct-1', 'GLM-5.2', {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 12 },
    })

    const snapshot = tracker.snapshot()
    expect(snapshot.today.cachedTokens).toBe(40)
    expect(snapshot.today.reasoningTokens).toBe(12)
    expect(snapshot.byAccountToday['acct-1']?.reasoningTokens).toBe(12)
    expect(snapshot.byModelToday[0]?.totals.reasoningTokens).toBe(12)
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

  it('rolls everything up for the last 30 days but keeps the full ledger in allTime', () => {
    const tracker = new CodeArtsUsageTracker()
    const now = new Date(2026, 8, 30, 12, 0, 0).getTime()
    const longAgo = now - 40 * 86_400_000
    tracker.noteUsage('acct-1', 'GLM-5.2', { total_tokens: 500 }, longAgo)
    tracker.noteUsage('acct-1', 'GLM-5.2', { total_tokens: 100 }, now - 5 * 86_400_000)
    tracker.noteUsage('acct-1', 'GLM-5.2', { total_tokens: 20 }, now)

    const snapshot = tracker.snapshot(now)
    expect(snapshot.last30.totalTokens).toBe(120)
    expect(snapshot.allTime.totalTokens).toBe(620)
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

  // 旧账本没有 cachedTokens / reasoningTokens，读进来按 0 补齐，别让 NaN 漏进界面。
  it('backfills the newer total fields of a ledger written by an older version', async () => {
    const path = join(dir, '.codearts-usage.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      days: {
        [localDateKey()]: {
          models: { 'GLM-5.2': { requests: 2, promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
          accounts: { 'acct-1': { requests: 2, promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
        },
      },
    }), 'utf8')

    const tracker = new CodeArtsUsageTracker({ path })
    await tracker.load()
    expect(tracker.snapshot().today).toEqual({
      requests: 2,
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedTokens: 0,
      reasoningTokens: 0,
    })
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
