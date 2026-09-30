import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeArtsAccountStore, credentialFromOAuth, type CodeArtsCredential } from '../src/auth.ts'
import { fetchCallerIdentity } from '../src/upstream.ts'
import type { OAuthToken } from '../src/oauth.ts'

const credential = {
  token: 'sts-token',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  securityToken: 'sts-token',
}

/** 账号库里的一条凭证（只填测试用得到的字段）。 */
function cred(patch: Partial<CodeArtsCredential> = {}): CodeArtsCredential {
  return { token: 'sts-token', accessKeyId: 'AK', secretAccessKey: 'SK', storedAt: 1_000, ...patch }
}

describe('fetchCallerIdentity', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the identity the gateway reports', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      domain_id: '8b70f629fee94246bcad094fdf2defab',
      domain_name: 'hid_4u8g5m2ainh83b_',
      user_id: '798ca596feee44688280ef7adef8e265',
      user_name: 'hid_4u8g5m2ainh83b_',
    }), { status: 200 }))

    await expect(fetchCallerIdentity(credential)).resolves.toEqual({
      userId: '798ca596feee44688280ef7adef8e265',
      userName: 'hid_4u8g5m2ainh83b_',
      domainId: '8b70f629fee94246bcad094fdf2defab',
    })
  })

  it('refuses a response without a user id instead of inventing one', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ user_id: '' }), { status: 200 }))
    await expect(fetchCallerIdentity(credential)).rejects.toThrow(/user_id/)
  })

  it('surfaces a gateway rejection', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error_code":"APIG.0602"}', { status: 400 }))
    await expect(fetchCallerIdentity(credential)).rejects.toThrow(/HTTP 400/)
  })
})

describe('CodeArtsAccountStore.adoptIdentity', () => {
  let dir: string
  let store: CodeArtsAccountStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-identity-'))
    store = new CodeArtsAccountStore(join(dir, '.codearts-accounts.json'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('moves an entry onto the stable user id, keeping its credential', async () => {
    await store.upsert(cred({ label: 'dpop-keyed' }), 'dpop-hash')
    const action = await store.adoptIdentity('dpop-hash', {
      userId: '798ca596feee44688280ef7adef8e265',
      userName: 'hid_4u8g5m2ainh83b_',
      domainId: 'domain-1',
    })

    expect(action).toBe('moved')
    const ids = await store.ids()
    expect(ids).toEqual(['798ca596feee44688280ef7adef8e265'])
    const moved = await store.credential('798ca596feee44688280ef7adef8e265')
    expect(moved?.label).toBe('dpop-keyed')
    expect(moved?.userName).toBe('hid_4u8g5m2ainh83b_')
    expect(moved?.domainId).toBe('domain-1')
  })

  it('merges into the existing entry and keeps the fresher credential', async () => {
    await store.upsert(cred({ label: 'older', storedAt: 1_000 }), '798ca596feee44688280ef7adef8e265')
    await store.upsert(cred({ label: 'newer', storedAt: 2_000 }), 'dpop-hash')

    const action = await store.adoptIdentity('dpop-hash', {
      userId: '798ca596feee44688280ef7adef8e265',
      userName: '',
      domainId: '',
    })

    expect(action).toBe('merged')
    // 两条并成一条：只留稳定键，且用较新的那份凭证（它才不会被上游拒）。
    expect(await store.ids()).toEqual(['798ca596feee44688280ef7adef8e265'])
    expect((await store.credential('798ca596feee44688280ef7adef8e265'))?.label).toBe('newer')
  })

  it('backfills fields when the id is already stable', async () => {
    await store.upsert(cred({ label: 'x', storedAt: 5 }), 'dpop-hash')
    const action = await store.adoptIdentity('dpop-hash', { userId: 'dpop-hash', userName: 'u', domainId: 'd' })
    expect(action).toBe('noop')
    expect((await store.credential('dpop-hash'))?.userName).toBe('u')
  })

  it('is a no-op for an unknown id', async () => {
    expect(await store.adoptIdentity('missing', { userId: 'u', userName: '', domainId: '' })).toBe('noop')
  })
})

describe('upsertFromOAuth with an identity', () => {
  let dir: string
  let store: CodeArtsAccountStore

  const token = (patch: Partial<OAuthToken> = {}): OAuthToken => ({
    userId: '',
    userName: '',
    domainId: '',
    securityToken: 'sts-token',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    expiration: '2030-01-01T00:00:00Z',
    refreshToken: 'refresh',
    clientId: 'codearts-agent',
    dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    ...patch,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-login-'))
    store = new CodeArtsAccountStore(join(dir, '.codearts-accounts.json'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keys a re-login of the same account onto one entry (the duplicate fix)', async () => {
    const identity = { userId: '798ca596feee44688280ef7adef8e265', userName: 'hid_x', domainId: 'd' }
    const first = await store.upsertFromOAuth(token(), undefined, identity)
    const second = await store.upsertFromOAuth(token({ dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x2', y: 'y2', d: 'd2' } }), undefined, identity)

    // 两次登录用的是不同 DPoP 密钥（真实场景就是这样），但身份相同 -> 同一条记录。
    expect(first).toBe(second)
    expect(await store.ids()).toEqual(['798ca596feee44688280ef7adef8e265'])
  })

  it('still separates accounts when no identity is available', async () => {
    const a = await store.upsertFromOAuth(token({ userId: '' }))
    const b = await store.upsertFromOAuth(token({ dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x2', y: 'y2', d: 'd2' } }))
    expect(a).not.toBe(b)
    expect(await store.ids()).toHaveLength(2)
  })

  it('keeps the domain id on the stored credential', async () => {
    await store.upsertFromOAuth(token(), undefined, { userId: 'u1', userName: 'n1', domainId: 'domain-1' })
    expect((await store.credential('u1'))?.domainId).toBe('domain-1')
  })
})

describe('credentialFromOAuth', () => {
  it('carries the identity fields through, empty strings included', () => {
    const built = credentialFromOAuth({
      userId: '',
      userName: '',
      domainId: 'domain-1',
      securityToken: 'sts',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      expiration: '2030-01-01T00:00:00Z',
      refreshToken: 'r',
      clientId: 'codearts-agent',
      dpopPrivateKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    })
    expect(built.userId).toBe('')
    expect(built.domainId).toBe('domain-1')
    expect(built.token).toBe('sts')
  })
})
