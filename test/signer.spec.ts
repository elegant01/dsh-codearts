import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signRequest, type SignCredential } from '../src/signer.ts'

const CRED: SignCredential = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  securityToken: 'sts-token-example',
}

/** The instant the fake clock is pinned to, so signatures are reproducible. */
const FIXED_NOW = new Date('2024-01-02T03:04:05Z')
const FIXED_SDK_DATE = '20240102T030405Z'

function signedRequest(url: string, body = '{}', method = 'POST'): Request {
  const req = new Request(url, { method, body })
  signRequest(req, Buffer.from(body), CRED)
  return req
}

afterEach(() => {
  vi.useRealTimers()
})

describe('signRequest', () => {
  it('stamps a Huawei-format X-Sdk-Date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    const req = signedRequest('https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions')
    expect(req.headers.get('X-Sdk-Date')).toBe(FIXED_SDK_DATE)
  })

  it('carries the STS security token when the credential has one', () => {
    const req = signedRequest('https://example.com/api/v2/chat/completions')
    expect(req.headers.get('X-Security-Token')).toBe(CRED.securityToken)
  })

  it('omits X-Security-Token for a plain AK/SK credential', () => {
    const req = new Request('https://example.com/api/v2/chat/completions', { method: 'POST', body: '{}' })
    signRequest(req, Buffer.from('{}'), { ...CRED, securityToken: '' })
    expect(req.headers.get('X-Security-Token')).toBeNull()
  })

  it('hashes the exact request body into X-Sdk-Content-Sha256', () => {
    const body = JSON.stringify({ model: 'GLM-5.2', messages: [] })
    const req = signedRequest('https://example.com/api/v2/chat/completions', body)
    const expected = createHash('sha256').update(Buffer.from(body)).digest('hex')
    expect(req.headers.get('X-Sdk-Content-Sha256')).toBe(expected)
  })

  it('builds an Authorization header naming the algorithm, AK and signed headers', () => {
    const req = signedRequest('https://example.com/api/v2/chat/completions')
    const auth = req.headers.get('Authorization') ?? ''
    expect(auth).toMatch(/^SDK-HMAC-SHA256 Access=AKIDEXAMPLE, SignedHeaders=.+, Signature=[0-9a-f]{64}$/)

    const signedHeaders = /SignedHeaders=([^,]+),/.exec(auth)?.[1]?.split(';') ?? []
    // The Host header cannot be set on a fetch Request, so the signer folds a
    // synthesised `host` line into the canonical request — and must list it.
    expect(signedHeaders).toContain('host')
    expect(signedHeaders).toContain('x-sdk-date')
    expect(signedHeaders).toContain('x-sdk-content-sha256')
    // Signed headers must be lowercase and sorted, or Huawei rejects the request.
    expect([...signedHeaders].sort()).toEqual(signedHeaders)
    for (const header of signedHeaders) expect(header).toBe(header.toLowerCase())
  })

  it('is deterministic for identical input at a fixed instant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    const url = 'https://example.com/api/v2/chat/completions?a=1&b=2'
    const first = signedRequest(url).headers.get('Authorization')
    const second = signedRequest(url).headers.get('Authorization')
    expect(first).toBe(second)
    expect(first).not.toBeNull()
  })

  it('changes the signature when the body changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    const url = 'https://example.com/api/v2/chat/completions'
    const withA = signedRequest(url, '{"a":1}').headers.get('Authorization')
    const withB = signedRequest(url, '{"b":2}').headers.get('Authorization')
    expect(withA).not.toBe(withB)
  })

  it('changes the signature when the secret key changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    const url = 'https://example.com/api/v2/chat/completions'
    const other = new Request(url, { method: 'POST', body: '{}' })
    signRequest(other, Buffer.from('{}'), { ...CRED, secretAccessKey: 'different-secret' })
    expect(other.headers.get('Authorization')).not.toBe(signedRequest(url).headers.get('Authorization'))
  })
})
