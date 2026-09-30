/**
 * 华为云 SDK-HMAC-SHA256 请求签名（AK/SK + 可选 STS security token）。
 * 翻译自 codearts2api 的 internal/upstream/signer.go，对齐华为云 AKSKSigner。
 *
 * 在 CodeArts 桌面端实测：聊天请求必须用 AK/SK 签名，光传 x-auth-token 会被
 * APIG 拒（APIG.0301 decrypt token fail）。
 *
 * @module dsh-codearts/signer
 */

import { createHash, createHmac } from 'node:crypto'

export interface SignCredential {
  accessKeyId: string
  secretAccessKey: string
  securityToken: string
}

const ALGO = 'SDK-HMAC-SHA256'

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function hmacHex(key: string, msg: string): string {
  return createHmac('sha256', key).update(msg).digest('hex')
}

/** 华为云 X-Sdk-Date 格式：20060102T150405Z（UTC，无分隔符、无毫秒）。 */
function sdkDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

function canonicalURI(path: string): string {
  const segments = path.split('/')
  const escaped = segments.map(s => encodeURIComponent(s))
  let out = escaped.join('/')
  if (!out.endsWith('/')) out += '/'
  return out
}

function canonicalQuery(raw: string): string {
  if (!raw) return ''
  const params = new URLSearchParams(raw)
  const keys = [...new Set(params.keys())].sort()
  const parts: string[] = []
  for (const k of keys) {
    const vals = params.getAll(k).sort()
    for (const v of vals) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return parts.join('&')
}

/**
 * 给一个 fetch Request 加上 X-Sdk-Date / X-Security-Token / X-Sdk-Content-Sha256
 * / Authorization 头。body 为请求体（用于 payload hash）。
 *
 * 注意：Host 头 fetch 不允许手动 set，但签名必须包含 host，所以我们在签名计算
 * 里从 URL 取 host 补一个虚拟 host 行，Authorization 写回即可（fetch 实际发出的
 * Host 与 URL.host 一致）。
 */
export function signRequest(req: Request, body: Buffer, cred: SignCredential): void {
  const xDate = sdkDate(new Date())
  req.headers.set('X-Sdk-Date', xDate)
  if (cred.securityToken) req.headers.set('X-Security-Token', cred.securityToken)
  const payloadHash = sha256Hex(body)
  req.headers.set('X-Sdk-Content-Sha256', payloadHash)

  const url = new URL(req.url)
  const host = url.host

  const all: [string, string][] = []
  req.headers.forEach((v, k) => all.push([k.toLowerCase(), v.trim()]))
  all.push(['host', host])
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  let canonicalHeaders = ''
  const signed: string[] = []
  for (const [k, v] of all) {
    canonicalHeaders += `${k}:${v}\n`
    signed.push(k)
  }
  const signedHeaders = signed.join(';')

  const canonicalRequest = [
    req.method,
    canonicalURI(url.pathname),
    canonicalQuery(url.search.slice(1)),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [ALGO, xDate, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(cred.secretAccessKey, stringToSign)
  req.headers.set(
    'Authorization',
    `${ALGO} Access=${cred.accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  )
}
