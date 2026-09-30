/**
 * CodeArts credential store.
 *
 * 真实 CodeArts 桌面端聊天需要：STS `security_token` + 临时 AK/SK（HMAC 签名）
 * + refresh_token（绑定 DPoP 私钥用于续期）。本模块持久化这全套 OAuth 凭证，
 * 并提供自动续期。同时也保留"手动粘贴 security_token"的兜底（但无 AK/SK 时只能
 * 作为降级态，聊天会被 APIG 拒）。
 *
 * @module dsh-codearts/auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { refreshToken, defaultLoginConfig, type OAuthToken } from './oauth.ts'

/** 持久化的完整凭证。 */
export interface CodeArtsCredential {
  /** STS security_token（聊天鉴权 + AK/SK 签名时的 X-Security-Token）。 */
  token: string
  /** 临时 AK/SK（HMAC 签名用）。手动粘贴场景可能为空。 */
  accessKeyId?: string
  secretAccessKey?: string
  /** refresh_token（续期用）。 */
  refreshToken?: string
  /** 续期绑定的 DPoP 私钥（JWK）。 */
  dpopPrivateKey?: OAuthToken['dpopPrivateKey']
  /** OAuth client_id（刷新需与登录时一致）。 */
  clientId?: string
  /** STS 过期时间（ISO）。 */
  expiration?: string
  /** 用户标识。 */
  userId?: string
  userName?: string
  /** 可选标注。 */
  label?: string
  /** 存盘时间（epoch ms）。 */
  storedAt?: number
  /** 续期已尝试且失败（多半已过期），需用户重新登录。 */
  stale?: boolean
}

/** 从 OAuthToken 落库。 */
export function credentialFromOAuth(t: OAuthToken, label?: string): CodeArtsCredential {
  return {
    token: t.securityToken,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    refreshToken: t.refreshToken,
    dpopPrivateKey: t.dpopPrivateKey,
    clientId: t.clientId,
    expiration: t.expiration,
    userId: t.userId,
    userName: t.userName,
    label: label ?? t.userName ?? t.userId,
    storedAt: Date.now(),
  }
}

export function codeartsAuthPath(home?: string): string {
  const base = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, '.codearts-auth.json')
}

export async function loadCredential(path: string): Promise<CodeArtsCredential | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CodeArtsCredential>
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return undefined
    return { ...parsed, token: parsed.token } as CodeArtsCredential
  } catch {
    return undefined
  }
}

export async function saveCredential(path: string, cred: CodeArtsCredential): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify(cred, null, 2)
  // tmp 名必须唯一：登录轮询扇出 / 续期与登录撞车时会对同一路径并发落库，
  // 共用一个 `${path}.tmp` 时先完成的 rename 会把 tmp 挪走，后一个 chmod 就 ENOENT。
  const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    // chmod 只是尽力而为（Windows 上近乎空操作），失败不能把整个流程掀翻。
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, path)
  } catch {
    await unlink(tmp).catch(() => {})
    await writeFile(path, body, { mode: 0o600 })
  }
}

export async function clearCredential(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // already gone
  }
}

export interface ResolvedCredential {
  token: string
  accessKeyId?: string
  secretAccessKey?: string
  securityToken: string
}

export class CodeArtsCredentialStore {
  private _current: CodeArtsCredential | undefined
  private _path: string

  constructor(path: string) {
    this._path = path
  }

  setPath(path: string): void {
    this._current = undefined
    this._path = path
  }

  /** 给 shim 用：返回签名所需全套。 */
  async resolve(): Promise<ResolvedCredential | undefined> {
    const cred = await this.ensureFresh()
    if (cred === undefined) return undefined
    return {
      token: cred.token,
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      securityToken: cred.token,
    }
  }

  async current(): Promise<CodeArtsCredential | undefined> {
    return (this._current ??= await loadCredential(this._path))
  }

  /** 从 OAuth 登录结果落库。 */
  async setFromOAuth(t: OAuthToken, label?: string): Promise<void> {
    const cred = credentialFromOAuth(t, label)
    await saveCredential(this._path, cred)
    this._current = cred
    await this.claimIfPossible(cred)
  }

  /** 领取限时福利（幂等）；无 AK/SK 时静默跳过。 */
  private async claimIfPossible(cred: CodeArtsCredential): Promise<void> {
    if (!cred.accessKeyId || !cred.secretAccessKey) return
    try {
      const { claimBenefit } = await import('./upstream.ts')
      await claimBenefit(
        {
          token: cred.token,
          accessKeyId: cred.accessKeyId,
          secretAccessKey: cred.secretAccessKey,
          securityToken: cred.token,
        },
      )
    } catch {
      // 领取失败不阻断登录（接口宽松，幂等）。
    }
  }

  /** 手动粘贴 security_token（降级态，无 AK/SK）。 */
  async set(token: string, label?: string): Promise<void> {
    const cred: CodeArtsCredential = {
      token: token.trim(),
      label,
      storedAt: Date.now(),
    }
    await saveCredential(this._path, cred)
    this._current = cred
  }

  async clear(): Promise<void> {
    this._current = undefined
    await clearCredential(this._path)
  }

  async hasCredential(): Promise<boolean> {
    return (await this.current()) !== undefined
  }

  /**
   * 自动续期：若距过期不足 5 分钟且具备 refresh 条件，则刷新并落库。
   * 返回当前（可能已刷新）凭证。
   */
  async ensureFresh(): Promise<CodeArtsCredential | undefined> {
    let cred = this._current ?? (await loadCredential(this._path))
    this._current = cred
    if (!cred) return undefined
    if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred
    const exp = cred.expiration ? Date.parse(cred.expiration) : NaN
    const soon = Number.isNaN(exp) ? false : exp - Date.now() < 5 * 60 * 1000
    if (!soon) return cred
    try {
      const refreshed = await refreshToken(
        defaultLoginConfig(),
        {
          userId: cred.userId ?? '',
          userName: cred.userName ?? '',
          domainId: '',
          securityToken: cred.token,
          accessKeyId: cred.accessKeyId ?? '',
          secretAccessKey: cred.secretAccessKey ?? '',
          expiration: cred.expiration ?? '',
          refreshToken: cred.refreshToken,
          clientId: cred.clientId,
          dpopPrivateKey: cred.dpopPrivateKey,
        },
      )
      const next = credentialFromOAuth(refreshed, cred.label)
      await saveCredential(this._path, next)
      this._current = next
      await this.claimIfPossible(next)
      return next
    } catch {
      // 刷新失败：标记 stale 并落库，让卡片提示用户重新登录，而不是静默用过期凭证。
      cred.stale = true
      this._current = cred
      try {
        await saveCredential(this._path, cred)
      } catch {
        // 落库失败也不阻断，内存里已标记。
      }
      return cred
    }
  }
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function makeSharedSecret(): string {
  return randomBytes(32).toString('base64url')
}
