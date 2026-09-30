import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshTokenMock } = vi.hoisted(() => ({ refreshTokenMock: vi.fn() }))

vi.mock('../src/oauth.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oauth.ts')>()
  return { ...actual, refreshToken: refreshTokenMock }
})

// 登录/续期后会去领福利；真打网络会让测试挂住（那条路径没有超时可言）。
vi.mock('../src/upstream.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/upstream.ts')>()
  return { ...actual, claimBenefit: vi.fn(async () => {}) }
})

import {
  accountIdOf,
  CodeArtsAccountStore,
  credentialFromOAuth,
  MANUAL_ACCOUNT_ID,
} from '../src/auth.ts'

let dir: string
let accountsPath: string
let legacyPath: string

function token(overrides: Record<string, unknown> = {}): never {
  return {
    securityToken: 'sts-token',
    accessKeyId: 'AKID',
    secretAccessKey: 'SK',
    refreshToken: 'refresh-1',
    clientId: 'client-1',
    // 账号身份在拿不到 userId 时会落到 DPoP 公钥（x/y）上，所以这套 fixture 必须
    // 带上它们，否则测的就不是真实形状。
    dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'fixture-x', y: 'fixture-y', d: 'fixture-d' },
    expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    userId: 'uid-1',
    userName: 'tester',
    ...overrides,
  } as never
}

function credential(userId: string, overrides: Record<string, unknown> = {}) {
  return credentialFromOAuth(token({ userId, userName: userId, ...overrides }))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-accounts-'))
  accountsPath = join(dir, '.codearts-accounts.json')
  legacyPath = join(dir, '.codearts-auth.json')
  refreshTokenMock.mockReset()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('migration from the single-credential file', () => {
  it('adopts the legacy credential as the first account', async () => {
    await writeFile(legacyPath, JSON.stringify(credential('uid-legacy')), 'utf8')

    const store = new CodeArtsAccountStore(accountsPath)
    const ids = await store.ids()

    expect(ids).toEqual(['uid-legacy'])
    expect((await store.current())?.userId).toBe('uid-legacy')
    // 收编后写下账号文档，下次直接读它。
    expect(existsSync(accountsPath)).toBe(true)
  })

  it('leaves the legacy file in place so the change is reversible', async () => {
    await writeFile(legacyPath, JSON.stringify(credential('uid-legacy')), 'utf8')
    await new CodeArtsAccountStore(accountsPath).ids()
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('starts empty when there is nothing to migrate', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    expect(await store.ids()).toEqual([])
    expect(await store.hasCredential()).toBe(false)
  })

  it('does not re-adopt a legacy file once the account document exists', async () => {
    // 先有账号文档……
    await new CodeArtsAccountStore(accountsPath).upsert(credential('uid-new'))
    // ……之后旧版单凭证文件才出现。迁移只发生在新文档不存在时，所以它应当被忽略。
    await writeFile(legacyPath, JSON.stringify(credential('uid-legacy')), 'utf8')

    const reopened = new CodeArtsAccountStore(accountsPath)
    expect(await reopened.ids()).toEqual(['uid-new'])
  })
})

describe('account management', () => {
  it('keys accounts by userId', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a'))
    await store.upsert(credential('uid-b'))
    expect(await store.ids()).toEqual(['uid-a', 'uid-b'])
  })

  it('updates in place when the same account signs in again', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a', { securityToken: 'first' }))
    await store.upsert(credential('uid-a', { securityToken: 'second' }))

    expect(await store.ids()).toEqual(['uid-a'])
    expect((await store.credential('uid-a'))?.token).toBe('second')
  })

  it('removes one account without touching the others', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a'))
    await store.upsert(credential('uid-b'))
    await store.remove('uid-a')

    expect(await store.ids()).toEqual(['uid-b'])
    expect((await store.resolve('uid-a'))).toBeUndefined()
  })

  it('persists across instances', async () => {
    await new CodeArtsAccountStore(accountsPath).upsert(credential('uid-a'))
    expect(await new CodeArtsAccountStore(accountsPath).ids()).toEqual(['uid-a'])
  })

  it('resolves the signing material for a specific account', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a', { securityToken: 'tok-a' }))
    await store.upsert(credential('uid-b', { securityToken: 'tok-b' }))

    expect((await store.resolve('uid-b'))?.token).toBe('tok-b')
    expect((await store.resolve('uid-a'))?.token).toBe('tok-a')
  })

  it('clear() drops every account and the legacy file', async () => {
    await writeFile(legacyPath, JSON.stringify(credential('uid-legacy')), 'utf8')
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-b'))

    await store.clear()

    expect(await store.ids()).toEqual([])
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(accountsPath)).toBe(true)
  })

  it('falls back to a token hash when there is no userId (pasted token)', () => {
    const pasted = { token: 'pasted-token' }
    expect(accountIdOf(pasted)).toBe(accountIdOf(pasted))
    expect(accountIdOf(pasted)).not.toBe(accountIdOf({ token: 'other' }))
  })

  it('keys by userId when the provider gives one', () => {
    expect(accountIdOf(credentialFromOAuth(token({ userId: 'uid-1' })))).toBe('uid-1')
  })

  // 实测（2026-09-30，真实账号）：上游的 token 响应里 user_id / user_name 都是空串，
  // 所以真实登录只能落到 DPoP 公钥这一级。
  it('keys by the DPoP public key when the provider gives no identity', () => {
    const cred = credentialFromOAuth(token({ userId: '', userName: '' }))
    expect(accountIdOf(cred)).toMatch(/^k[0-9a-f]{15}$/)
  })

  it('gives two accounts different keys even without a user id', () => {
    const a = credentialFromOAuth(token({ userId: '', userName: '', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb', d: 'ccc' } }))
    const b = credentialFromOAuth(token({ userId: '', userName: '', dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'xxx', y: 'yyy', d: 'zzz' } }))
    expect(accountIdOf(a)).not.toBe(accountIdOf(b))
  })

  // 关键性质：续期会轮换 token，账号身份**不能**跟着变，否则每次续期都多出一个账号。
  it('keeps the key stable across a token rotation', () => {
    const before = credentialFromOAuth(token({ userId: '', userName: '' }))
    const after = credentialFromOAuth(token({
      userId: '', userName: '', securityToken: 'rotated', refreshToken: 'rotated',
    }))
    expect(accountIdOf(after)).toBe(accountIdOf(before))
  })

  it('pasting a token overwrites the same manual account instead of adding one', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    await store.set('first-paste')
    await store.set('second-paste')

    expect(await store.ids()).toEqual([MANUAL_ACCOUNT_ID])
    expect((await store.credential(MANUAL_ACCOUNT_ID))?.token).toBe('second-paste')
  })

  it('reports signable only when the account carries AK/SK', async () => {
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a'))
    await store.set('pasted-token')

    const byId = new Map((await store.list()).map(a => [a.id, a]))
    expect(byId.get('uid-a')?.signable).toBe(true)
    expect(byId.get(MANUAL_ACCOUNT_ID)?.signable).toBe(false)
  })
})

describe('per-account refresh', () => {
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

  function slowRefresh(result: unknown): void {
    refreshTokenMock.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(result), 30)
    }))
  }

  const soon = (): Record<string, unknown> => ({ expiration: new Date(Date.now() + 60_000).toISOString() })

  it('refreshes each account independently', async () => {
    const refreshed: string[] = []
    refreshTokenMock.mockImplementation(async (_config: unknown, payload: { userId?: string }) => {
      refreshed.push(payload.userId ?? '')
      return token({ userId: payload.userId, securityToken: 'fresh' })
    })
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a', soon()))
    await store.upsert(credential('uid-b', soon()))

    await store.resolve('uid-a')
    await store.resolve('uid-b')

    expect(refreshed.sort()).toEqual(['uid-a', 'uid-b'])
  })

  // refresh_token 是一次性的：同一个账号并发刷新会烧掉它，并把失败那次的 stale
  // 盖在成功那次刚拿到的凭证上。本机真实踩过一次。
  it('refreshes a single account only once under concurrency', async () => {
    slowRefresh(token({ userId: 'uid-a', securityToken: 'fresh' }))
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a', soon()))

    const results = await Promise.all([
      store.resolve('uid-a'),
      store.resolve('uid-a'),
      store.resolve('uid-a'),
    ])

    expect(refreshTokenMock).toHaveBeenCalledTimes(1)
    expect(results.map(r => r?.token)).toEqual(['fresh', 'fresh', 'fresh'])
  })

  it('a sign-in during an in-flight refresh is not overwritten by it', async () => {
    let release: (value: unknown) => void = () => {}
    refreshTokenMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const store = new CodeArtsAccountStore(accountsPath)
    await store.upsert(credential('uid-a', soon()))

    const pending = store.resolve('uid-a')
    await tick()
    // 用户重新登录了：应当拿到新凭证，旧刷新不得回头盖掉它。
    await store.upsert(credential('uid-a', { securityToken: 'brand-new', expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }))
    release(token({ userId: 'uid-a', securityToken: 'stale-refresh' }))
    await pending

    expect((await store.credential('uid-a'))?.token).toBe('brand-new')
    expect(JSON.parse(await readFile(accountsPath, 'utf8')).accounts['uid-a'].token).toBe('brand-new')
  })
})
