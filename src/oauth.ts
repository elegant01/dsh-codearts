/**
 * CodeArts OAuth2（PKCE）登录 + 刷新，翻译自 codearts2api 的
 * internal/server/oauth.go / cmd/login/main.go / internal/upstream/client.go。
 *
 * 登录：本地起 127.0.0.1 回调服务 → 浏览器跳 codearts.huaweicloud.com/authorize
 * → 用户登录 → 华为回调带 code → 用 code + PKCE verifier + DPoP 私钥换
 * security_token + 临时 AK/SK + refresh_token。
 *
 * 刷新：refresh_token 与 client_id、DPoP 私钥三者绑定，刷新时原样复用。
 *
 * @module dsh-codearts/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { newDPoPPrivateJWK, signDpopProof, type DPoPPrivateJWK } from './dpop.ts'

const CLIENT_ID = 'codearts-agent'
const PLUGIN_NAME = 'snap_AIIDE'
const PLUGIN_VERSION = '5.2.0'

// 端点（翻译自 codearts2api internal/upstream/const.go）
const SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const STS_HOST = 'https://sts.cn-north-4.myhuaweicloud.com'
const PORTAL = 'https://codearts.huaweicloud.com/portal'
const REDIRECT_PATH = '/oauth/callback'

export interface OAuthToken {
  userId: string
  userName: string
  domainId: string
  securityToken: string
  accessKeyId: string
  secretAccessKey: string
  expiration: string // ISO 时间字符串
  refreshToken: string
  clientId: string
  dpopPrivateKey: DPoPPrivateJWK
}

export interface LoginConfig {
  clientId: string
  snapHost: string
  stsHost: string
  portal: string
}

export function defaultLoginConfig(): LoginConfig {
  return { clientId: CLIENT_ID, snapHost: SNAP_HOST, stsHost: STS_HOST, portal: PORTAL }
}

export function randomHex(n: number): string {
  return randomBytes(n).toString('hex')
}

export function pkce(): { verifier: string; challenge: string; method: string } {
  const verifier = base64url(randomBytes(64))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/** 构造华为授权页 URL（浏览器打开，用户登录后回调本机）。 */
export function buildAuthorizeURL(cfg: LoginConfig, ticketId: string, challenge: string, method: string, port: number): string {
  const q = new URLSearchParams()
  q.set('theme', '2')
  q.set('locale', 'zh-cn')
  q.set('uri_scheme', cfg.clientId)
  q.set('client_id', cfg.clientId)
  q.set('port', String(port))
  q.set('code_challenge', challenge)
  q.set('code_challenge_method', 'SHA-256')
  q.set('ticket_id', ticketId)
  q.set('plugin-name', PLUGIN_NAME)
  q.set('plugin-version', PLUGIN_VERSION)
  return `${cfg.portal}/authorize?${q.toString()}`
}

/** 换 token 请求体：application/x-www-form-urlencoded（与华为 STS 一致）。 */
function buildTokenBody(cfg: LoginConfig, params: Record<string, string>): string {
  const form = new URLSearchParams({ client_id: cfg.clientId, ...params })
  return form.toString()
}

/** 用授权 code 换 token。 */
export async function exchangeCode(
  cfg: LoginConfig,
  code: string,
  verifier: string,
  port: number,
  dpopJWK: DPoPPrivateJWK,
  abort?: AbortSignal,
): Promise<OAuthToken> {
  const htu = `${cfg.stsHost}/v1/oauth2/tokens`
  const dpop = signDpopProof(dpopJWK, htu)
  const body = buildTokenBody(cfg, {
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
  })
  const res = await fetch(`${htu}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'DPoP': dpop,
      'plugin-name': PLUGIN_NAME,
      'plugin-version': PLUGIN_VERSION,
    },
    body,
    signal: abort,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`exchange code failed: ${res.status} ${text}`)
  }
  return parseToken(await res.json(), dpopJWK, cfg.clientId)
}

/** 用 refresh_token 续期。 */
export async function refreshToken(
  cfg: LoginConfig,
  prev: OAuthToken,
  abort?: AbortSignal,
): Promise<OAuthToken> {
  const htu = `${cfg.stsHost}/v1/oauth2/tokens`
  const dpop = signDpopProof(prev.dpopPrivateKey, htu)
  const body = buildTokenBody(cfg, {
    grant_type: 'refresh_token',
    refresh_token: prev.refreshToken,
  })
  const res = await fetch(`${htu}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'DPoP': dpop,
      'plugin-name': PLUGIN_NAME,
      'plugin-version': PLUGIN_VERSION,
    },
    body,
    signal: abort,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`refresh token failed: ${res.status} ${text}`)
  }
  return parseToken(await res.json(), prev.dpopPrivateKey, prev.clientId, prev)
}

function parseToken(json: any, dpopJWK: DPoPPrivateJWK, clientId: string, prev?: OAuthToken): OAuthToken {
  const cred = json.credentials ?? {}
  return {
    userId: json.user_id ?? prev?.userId ?? '',
    userName: json.user_name ?? prev?.userName ?? '',
    domainId: json.domain_id ?? prev?.domainId ?? '',
    securityToken: cred.security_token ?? cred.SecurityToken ?? '',
    accessKeyId: cred.access_key_id ?? cred.AccessKeyID ?? '',
    secretAccessKey: cred.secret_access_key ?? cred.SecretAccessKey ?? '',
    expiration: cred.expiration ?? cred.Expiration ?? '',
    refreshToken: json.refresh_token ?? json.RefreshToken ?? prev?.refreshToken ?? '',
    clientId,
    dpopPrivateKey: dpopJWK,
  }
}

/**
 * 起一个本地回调 server 并完成整段登录。resolve 时 token 已落盘就绪。
 * 桌面版 DSH 下 127.0.0.1 回调一定能落回本机。
 */
export interface LoginSession {
  url: string
  port: number
  promise: Promise<OAuthToken>
  close: () => void
}

export async function startLogin(cfg: LoginConfig = defaultLoginConfig()): Promise<LoginSession> {
  const ticketId = randomHex(16)
  const { verifier, challenge, method } = pkce()
  const dpopJWK = newDPoPPrivateJWK()

  const codeCh = await new Promise<{ port: number; server: http.Server; take: () => Promise<string> }>((resolve) => {
    const server = http.createServer()
    const waiters: ((code: string) => void)[] = []
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== REDIRECT_PATH) {
        res.writeHead(404).end()
        return
      }
      const code = u.searchParams.get('code')
      const redirect = u.searchParams.get('redirect')
      if (!code && redirect) {
        res.writeHead(307, { Location: redirect }).end()
        return
      }
      if (!code) {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const cv = new URLSearchParams(body).get('code')
          finish(cv)
        })
        return
      }
      finish(code)
      function finish(c?: string | null) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h3>CodeArts 登录成功，可关闭此页面。</h3>')
        if (c) for (const w of waiters.splice(0)) w(c)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        server,
        take: () => new Promise<string>((r) => waiters.push(r)),
      })
    })
  })

  const url = buildAuthorizeURL(cfg, ticketId, challenge, method, codeCh.port)

  const promise = (async (): Promise<OAuthToken> => {
    const timer = setTimeout(() => codeCh.server.close(), 5 * 60 * 1000)
    try {
      const code = await codeCh.take()
      return await exchangeCode(cfg, code, verifier, codeCh.port, dpopJWK)
    } finally {
      clearTimeout(timer)
      codeCh.server.close()
    }
  })()

  return { url, port: codeCh.port, promise, close: () => codeCh.server.close() }
}
