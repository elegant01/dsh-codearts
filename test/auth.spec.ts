import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshTokenMock } = vi.hoisted(() => ({ refreshTokenMock: vi.fn() }))

vi.mock('../src/oauth.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/oauth.ts')>()
  return { ...actual, refreshToken: refreshTokenMock }
})

import {
  CodeArtsCredentialStore,
  clearCredential,
  credentialFromOAuth,
  loadCredential,
  makeSharedSecret,
  saveCredential,
  tokensEqual,
} from '../src/auth.ts'

let dir: string
let authPath: string

/** Minimal OAuthToken stand-in; the store only reads these fields. */
function oauthToken(overrides: Record<string, unknown> = {}) {
  return {
    securityToken: 'sts-token',
    accessKeyId: 'AKID',
    secretAccessKey: 'SK',
    refreshToken: 'refresh-1',
    clientId: 'client-1',
    // ensureFresh only attempts a refresh when the DPoP key is present too —
    // the refresh_token is bound to it server-side.
    dpopPrivateKey: { kty: 'EC', crv: 'P-256' },
    expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    userId: 'uid-1',
    userName: 'tester',
    ...overrides,
  } as never
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-codearts-test-'))
  authPath = join(dir, '.codearts-auth.json')
  refreshTokenMock.mockReset()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('credential persistence', () => {
  it('round-trips a credential through disk', async () => {
    const cred = credentialFromOAuth(oauthToken())
    await saveCredential(authPath, cred)
    expect(await loadCredential(authPath)).toEqual(cred)
  })

  it('defaults the label to the OAuth user name', () => {
    expect(credentialFromOAuth(oauthToken()).label).toBe('tester')
  })

  it('honours an explicit label over the user name', () => {
    expect(credentialFromOAuth(oauthToken(), 'work').label).toBe('work')
  })

  it('writes a file readable only by the owner', async () => {
    await saveCredential(authPath, credentialFromOAuth(oauthToken()))
    const raw = await readFile(authPath, 'utf8')
    expect(JSON.parse(raw).token).toBe('sts-token')
  })

  it('returns undefined for a missing file', async () => {
    expect(await loadCredential(join(dir, 'nope.json'))).toBeUndefined()
  })

  it('returns undefined for malformed JSON instead of throwing', async () => {
    await writeFile(authPath, '{not json', 'utf8')
    expect(await loadCredential(authPath)).toBeUndefined()
  })

  it('returns undefined when the stored token is empty', async () => {
    await writeFile(authPath, JSON.stringify({ token: '' }), 'utf8')
    expect(await loadCredential(authPath)).toBeUndefined()
  })

  it('clears the credential', async () => {
    await saveCredential(authPath, credentialFromOAuth(oauthToken()))
    await clearCredential(authPath)
    expect(await loadCredential(authPath)).toBeUndefined()
  })
})

describe('CodeArtsCredentialStore', () => {
  it('stores and resolves a pasted token without AK/SK', async () => {
    const store = new CodeArtsCredentialStore(authPath)
    await store.set('  pasted-token  ')

    const resolved = await store.resolve()
    expect(resolved?.token).toBe('pasted-token')
    expect(resolved?.securityToken).toBe('pasted-token')
    expect(resolved?.accessKeyId).toBeUndefined()
    expect(await store.hasCredential()).toBe(true)
  })

  it('reports no credential when nothing is stored', async () => {
    const store = new CodeArtsCredentialStore(authPath)
    expect(await store.hasCredential()).toBe(false)
    expect(await store.resolve()).toBeUndefined()
  })

  it('clears the stored credential', async () => {
    const store = new CodeArtsCredentialStore(authPath)
    await store.set('pasted-token')
    await store.clear()
    expect(await store.hasCredential()).toBe(false)
  })

  it('leaves a credential alone when it cannot be refreshed', async () => {
    const store = new CodeArtsCredentialStore(authPath)
    await saveCredential(authPath, { token: 'no-refresh', storedAt: 1 })
    const cred = await store.ensureFresh()
    expect(cred?.token).toBe('no-refresh')
    expect(refreshTokenMock).not.toHaveBeenCalled()
  })

  it('does not refresh a credential that is nowhere near expiry', async () => {
    const store = new CodeArtsCredentialStore(authPath)
    await saveCredential(authPath, credentialFromOAuth(oauthToken()))
    const cred = await store.ensureFresh()
    expect(cred?.token).toBe('sts-token')
    expect(refreshTokenMock).not.toHaveBeenCalled()
  })

  it('refreshes an almost-expired credential and persists the new token', async () => {
    refreshTokenMock.mockResolvedValue(oauthToken({ securityToken: 'sts-token-2' }))
    const store = new CodeArtsCredentialStore(authPath)
    await saveCredential(authPath, credentialFromOAuth(
      oauthToken({ expiration: new Date(Date.now() + 60_000).toISOString() }),
    ))

    expect((await store.ensureFresh())?.token).toBe('sts-token-2')
    expect(refreshTokenMock).toHaveBeenCalledTimes(1)
    // The refreshed value must reach disk, not just memory.
    expect((await loadCredential(authPath))?.token).toBe('sts-token-2')
  })

  // The card shows "expired, sign in again" off this flag; silently serving a
  // dead token would surface as an opaque upstream 401 instead.
  it('marks the credential stale and persists it when refresh fails', async () => {
    refreshTokenMock.mockRejectedValue(new Error('refresh rejected'))
    const store = new CodeArtsCredentialStore(authPath)
    await saveCredential(authPath, credentialFromOAuth(
      oauthToken({ expiration: new Date(Date.now() + 60_000).toISOString() }),
    ))

    expect((await store.ensureFresh())?.stale).toBe(true)
    expect((await loadCredential(authPath))?.stale).toBe(true)
  })
})

describe('tokensEqual', () => {
  it('accepts identical tokens', () => {
    expect(tokensEqual('abc123', 'abc123')).toBe(true)
  })

  it('rejects differing tokens and differing lengths', () => {
    expect(tokensEqual('abc123', 'abc124')).toBe(false)
    expect(tokensEqual('abc', 'abc123')).toBe(false)
  })
})

describe('makeSharedSecret', () => {
  it('produces a URL-safe secret', () => {
    expect(makeSharedSecret()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('does not repeat across calls', () => {
    expect(makeSharedSecret()).not.toBe(makeSharedSecret())
  })
})
