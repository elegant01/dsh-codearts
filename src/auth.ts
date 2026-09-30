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

/** 福利领取的上限；失败无所谓，卡住登录才是问题。 */
const CLAIM_TIMEOUT_MS = 15_000

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

/** 续期必需的三样；ensureFresh 已确认齐全才会走到 refresh。 */
interface RefreshMaterials {
  refreshToken: string
  dpopPrivateKey: NonNullable<CodeArtsCredential['dpopPrivateKey']>
  clientId: string
}

export class CodeArtsCredentialStore {
  private _current: CodeArtsCredential | undefined
  private _path: string
  /** 正在进行的刷新。并发请求必须共用它，不能各刷一次。 */
  private _inflight: Promise<CodeArtsCredential> | undefined
  /**
   * 凭证代际。重登/清除会推进它，让还在飞的刷新发现自己过期，
   * 从而不把刷新结果写回去覆盖掉刚拿到的新凭证。
   */
  private _gen = 0

  /** 作废在飞的刷新；任何直接写凭证的路径都要先调它。 */
  private invalidateInflight(): void {
    this._gen += 1
    this._inflight = undefined
  }

  constructor(path: string) {
    this._path = path
  }

  setPath(path: string): void {
    this.invalidateInflight()
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
    // 重登拿到的新凭证优先级最高：先作废在飞的刷新，别让旧刷新回头覆盖它。
    this.invalidateInflight()
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
        // 领取失败不该拖住登录/续期。之前没传 signal，claimBenefit 的 fetch 就没有
        // 任何超时——福利接口一旦不响应，ensureFresh() 永远不返回，跟着卡死的是
        // 整个聊天请求。
        AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      )
    } catch {
      // 领取失败不阻断登录（接口宽松，幂等）。
    }
  }

  /** 手动粘贴 security_token（降级态，无 AK/SK）。 */
  async set(token: string, label?: string): Promise<void> {
    this.invalidateInflight()
    const cred: CodeArtsCredential = {
      token: token.trim(),
      label,
      storedAt: Date.now(),
    }
    await saveCredential(this._path, cred)
    this._current = cred
  }

  async clear(): Promise<void> {
    this.invalidateInflight()
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
    const gen = this._gen
    const cred = this._current ?? (await loadCredential(this._path))
    // 读盘是异步的，用户可能正好在这个窗口里重登或登出。此时**以内存为准**：
    // 既不重新读盘（clear 的删除也是异步的，可能还没落盘，读回来的是已作废的
    // 那份，会把已登出的凭证复活），也不去刷新（结果会盖掉刚拿到的新凭证）。
    if (this._gen !== gen) return this._current
    this._current = cred
    if (!cred) return undefined
    if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred
    const exp = cred.expiration ? Date.parse(cred.expiration) : NaN
    const soon = Number.isNaN(exp) ? false : exp - Date.now() < 5 * 60 * 1000
    if (!soon) return cred
    // 并发请求不能各刷一次：refresh_token 会轮换，后一次刷新会作废前一次刚拿到
    // 的 AK/SK。实测症状就是一串 "Incorrect IAM authentication" + 凭证被写脏。
    const inflight = this._inflight ??= this.refresh(cred, {
      refreshToken: cred.refreshToken,
      dpopPrivateKey: cred.dpopPrivateKey,
      clientId: cred.clientId,
    }).finally(() => {
      this._inflight = undefined
    })
    return inflight
  }

  /** 真正去刷一次；失败则把凭证标成 stale 落库，让卡片提示重新登录。 */
  private async refresh(cred: CodeArtsCredential, mat: RefreshMaterials): Promise<CodeArtsCredential> {
    const gen = this._gen
    /**
     * 这次刷新的结果还能不能往回写。光看代际号不够：重登是异步落库的，可能在
     * 本次刷新启动**之后**才把 _current 换掉，那时代际号已经来不及拦。所以还要
     * 确认「当前凭证仍然是这次刷新的那一份」。
     */
    const stillCurrent = (): boolean => this._gen === gen && this._current === cred
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
          refreshToken: mat.refreshToken,
          clientId: mat.clientId,
          dpopPrivateKey: mat.dpopPrivateKey,
        },
      )
      const next = credentialFromOAuth(refreshed, cred.label)
      if (!stillCurrent()) return next
      await saveCredential(this._path, next)
      this._current = next
      await this.claimIfPossible(next)
      return next
    } catch {
      // 刷新失败：标记 stale 并落库，让卡片提示用户重新登录，而不是静默用过期凭证。
      cred.stale = true
      if (!stillCurrent()) return cred
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
