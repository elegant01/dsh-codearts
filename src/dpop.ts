/**
 * DPoP（RFC 9449）证明 JWT：ES256 + P-256，供 oauth2/tokens 请求头使用。
 * 翻译自 codearts2api 的 internal/upstream/dpop.go。
 *
 * 关键约束：refresh_token 与首次换取时的 DPoP 公钥绑定，刷新时必须复用同一
 * 私钥，否则 STS 报 InvalidDPoPHeader。因此该私钥必须随 refresh_token 一起落盘。
 *
 * @module dsh-codearts/dpop
 */

import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

/** 可持久化的 P-256 DPoP 私钥（JWK 形式，含 d）。 */
export type DPoPPrivateJWK = {
  kty: string
  crv: string
  x: string
  y: string
  d: string
}

const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const P256_HALF = P256_ORDER >> 1n

/** 生成新的 DPoP 私钥（JWK）。 */
export function newDPoPPrivateJWK(): DPoPPrivateJWK {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x!, y: jwk.y!, d: jwk.d! }
}

function privateKeyFromJWK(jwk: DPoPPrivateJWK) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createPrivateKey({ key: jwk as any, format: 'jwk' } as any)
}

function b64u(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

/**
 * 生成 DPoP proof JWT（htm=POST，htu=token 端点）。
 * 低 S 归一化以兼容服务端校验。
 */
export function signDpopProof(jwk: DPoPPrivateJWK, htu: string): string {
  const key = privateKeyFromJWK(jwk)
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }
  const headerJSON = Buffer.from(JSON.stringify(header))
  const payload = {
    htm: 'POST',
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString('hex'),
  }
  const payloadJSON = Buffer.from(JSON.stringify(payload))
  const input = `${b64u(headerJSON)}.${b64u(payloadJSON)}`
  // ES256：对 input 的 SHA256 做 ECDSA。createSign 内部会哈希，故直接喂 input。
  const sig = createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' })
  // 低 S 归一化
  let s = sig.subarray(32, 64)
  let sBig = BigInt(`0x${s.toString('hex')}`)
  if (sBig > P256_HALF) {
    sBig = P256_ORDER - sBig
    s = Buffer.from(sBig.toString(16).padStart(64, '0'), 'hex')
  }
  return `${input}.${b64u(Buffer.concat([sig.subarray(0, 32), s]))}`
}
