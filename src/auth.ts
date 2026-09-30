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

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
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

/** 原子写一个 JSON 文件（0600）。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify(value, null, 2)
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

export async function saveCredential(path: string, cred: CodeArtsCredential): Promise<void> {
  await writeJsonAtomic(path, cred)
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

/**
 * 领取限时福利（幂等）；无 AK/SK 时静默跳过。
 *
 * 必须带超时：领取失败不该拖住登录/续期。早先没传 signal，claimBenefit 的
 * fetch 就没有任何超时 —— 福利接口一旦不响应，ensureFresh() 永远不返回，
 * 跟着卡死的是整个聊天请求。
 */
async function claimIfPossible(cred: CodeArtsCredential): Promise<void> {
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
      AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    )
  } catch {
    // 领取失败不阻断登录（接口宽松，幂等）。
  }
}

/** 续期判定：距过期不足 5 分钟就去刷。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

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
    await claimIfPossible(cred)
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

// ---------------------------------------------------------------------------
// 多账号
// ---------------------------------------------------------------------------

/**
 * 手工粘贴 token 的降级账号固定用这个 id：再粘一次是**覆盖**，而不是又加一个。
 */
export const MANUAL_ACCOUNT_ID = 'manual'

/** 账号集合文档（`.codearts-accounts.json`）。 */
export interface CodeArtsAccountDocument {
  version: 1
  /** 展示顺序。 */
  order: string[]
  accounts: Record<string, CodeArtsCredential>
}

export interface CodeArtsAccountSummary {
  id: string
  label?: string
  userName?: string
  expiration?: string
  storedAt?: number
  /** 上次续期失败，需要重新登录。 */
  stale: boolean
  /** 带 AK/SK，能产生签名（只有 security_token 的降级凭证不能）。 */
  signable: boolean
}

export function codeartsAccountsPath(home?: string): string {
  const base = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, '.codearts-accounts.json')
}

/**
 * 账号的自然键，按稳定性依次退让：
 *
 * 1. `userId` —— 最理想，同一个人永远同一个键。
 * 2. `userName`。
 * 3. **DPoP 公钥**。实测上游的 token 响应里 `user_id` / `user_name` **都是空串**
 *    （2026-09-30 用真实账号核对），所以前两级拿不到。DPoP 密钥由每次登录生成、
 *    续期时原样复用，因此「同一次登录」内稳定、不同账号必然不同 —— 比拿 token
 *    做键好，因为 token 每次续期都会轮换。
 * 4. 最后才退回 token 哈希（手工粘贴的降级凭证没有 DPoP 密钥）。
 *
 * 已知代价：上游不给稳定身份，所以**对同一个账号重新登录**会被当成新账号，
 * 旧条目会自己失效（凭据被拒 → 停用）并可在卡片上删掉。
 */
export function accountIdOf(cred: CodeArtsCredential): string {
  if (typeof cred.userId === 'string' && cred.userId !== '') return cred.userId
  if (typeof cred.userName === 'string' && cred.userName !== '') return cred.userName
  const jwk = cred.dpopPrivateKey
  if (jwk !== undefined && typeof jwk.x === 'string' && typeof jwk.y === 'string') {
    return `k${createHash('sha256').update(`${jwk.x}.${jwk.y}`).digest('hex').slice(0, 15)}`
  }
  return `t${createHash('sha256').update(cred.token).digest('hex').slice(0, 15)}`
}

export function summarizeAccount(id: string, cred: CodeArtsCredential): CodeArtsAccountSummary {
  return {
    id,
    ...cred.label === undefined ? {} : { label: cred.label },
    ...cred.userName === undefined ? {} : { userName: cred.userName },
    ...cred.expiration === undefined ? {} : { expiration: cred.expiration },
    ...cred.storedAt === undefined ? {} : { storedAt: cred.storedAt },
    stale: cred.stale === true,
    signable: typeof cred.accessKeyId === 'string' && cred.accessKeyId !== '' &&
      typeof cred.secretAccessKey === 'string' && cred.secretAccessKey !== '',
  }
}

/**
 * 单个账号的内存状态与续期。
 *
 * 每个账号一份、互不干扰。`refresh_token` 是一次性的，上游在刷新时会轮换它：
 * 同一账号内并发刷新会烧掉它、并让失败的那次把 `stale` 盖在成功那次刚拿到的
 * 凭证上，登录态就此写死（本机真实踩过一次）。所以这里保留单凭证时代验证过的
 * 「单飞 + 代际」两条保护，只是作用域缩到单个账号。
 */
class AccountSlot {
  private _cred: CodeArtsCredential
  private _inflight: Promise<CodeArtsCredential> | undefined
  private _gen = 0
  // 不用 TS 参数属性（constructor(private x)）：本项目的探针脚本用
  // `node --experimental-strip-types` 直接跑源码，那个模式不支持参数属性。
  private readonly persist: (cred: CodeArtsCredential) => Promise<void>

  constructor(cred: CodeArtsCredential, persist: (cred: CodeArtsCredential) => Promise<void>) {
    this._cred = cred
    this.persist = persist
  }

  get credential(): CodeArtsCredential {
    return this._cred
  }

  /** 账号被替换或删除：作废在飞的刷新，别让它回头写回旧值。 */
  invalidate(): void {
    this._gen += 1
    this._inflight = undefined
  }

  async ensureFresh(): Promise<CodeArtsCredential> {
    const cred = this._cred
    // 已知要重新登录了，再刷也是白刷（而且会白烧一次请求）。
    if (cred.stale === true) return cred
    if (!cred.refreshToken || !cred.dpopPrivateKey || !cred.clientId) return cred
    const exp = cred.expiration ? Date.parse(cred.expiration) : NaN
    const soon = Number.isNaN(exp) ? false : exp - Date.now() < REFRESH_SKEW_MS
    if (!soon) return cred
    const inflight = this._inflight ??= this.refresh(cred, {
      refreshToken: cred.refreshToken,
      dpopPrivateKey: cred.dpopPrivateKey,
      clientId: cred.clientId,
    }).finally(() => {
      this._inflight = undefined
    })
    return inflight
  }

  private async refresh(cred: CodeArtsCredential, mat: RefreshMaterials): Promise<CodeArtsCredential> {
    const gen = this._gen
    // 光看代际号不够：账号被替换是异步落库的，可能在本轮刷新启动**之后**才换掉
    // _cred，那时代际号已经来不及拦。所以还要确认「当前凭证仍是这一份」。
    const stillCurrent = (): boolean => this._gen === gen && this._cred === cred
    try {
      const refreshed = await refreshToken(defaultLoginConfig(), {
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
      })
      const next = credentialFromOAuth(refreshed, cred.label)
      if (!stillCurrent()) return next
      await this.persist(next)
      this._cred = next
      await claimIfPossible(next)
      return next
    } catch {
      // 续期失败：标记 stale 落库，让卡片提示重新登录，而不是静默用过期凭证。
      cred.stale = true
      if (!stillCurrent()) return cred
      this._cred = cred
      try {
        await this.persist(cred)
      } catch {
        // 落库失败也不阻断，内存里已标记。
      }
      return cred
    }
  }
}

async function readAccountDocument(path: string): Promise<CodeArtsAccountDocument | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CodeArtsAccountDocument>
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const accounts = (parsed.accounts ?? {}) as Record<string, CodeArtsCredential>
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is string => typeof id === 'string')
      : []
    // 防御：文档里存在但不在 order 中的账号也要列出来。
    for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id)
    return { version: 1, order, accounts }
  } catch {
    return undefined
  }
}

/** 多账号凭证存储：一个账号一份槽位，共用一个文档文件。 */
export class CodeArtsAccountStore {
  private _doc: CodeArtsAccountDocument | undefined
  private _slots = new Map<string, AccountSlot>()
  private _loading: Promise<void> | undefined
  /** 落库串行化：多个账号的续期可能同时想写同一个文档。 */
  private _writeChain: Promise<void> = Promise.resolve()

  private readonly path: string
  /** 旧版单凭证文件；新文档不存在时把它收编成第一个账号。 */
  private readonly legacyPath: string

  constructor(path: string, legacyPath?: string) {
    this.path = path
    this.legacyPath = legacyPath ?? join(dirname(path), '.codearts-auth.json')
  }

  private async loaded(): Promise<void> {
    this._loading ??= this.load()
    return this._loading
  }

  private async load(): Promise<void> {
    const doc = await readAccountDocument(this.path)
    if (doc !== undefined) {
      this.adopt(doc)
      return
    }
    // 迁移：把旧的单凭证文件收编成第一个账号。旧文件**保留不删**，随时可回滚。
    const legacy = await loadCredential(this.legacyPath)
    const fresh: CodeArtsAccountDocument = { version: 1, order: [], accounts: {} }
    if (legacy !== undefined) {
      const id = accountIdOf(legacy)
      fresh.order.push(id)
      fresh.accounts[id] = legacy
    }
    this.adopt(fresh)
    if (legacy !== undefined) await this.persistDoc()
  }

  private adopt(doc: CodeArtsAccountDocument): void {
    this._doc = doc
    this._slots.clear()
    for (const [id, cred] of Object.entries(doc.accounts)) {
      this._slots.set(id, new AccountSlot(cred, this.persisterFor(id)))
    }
  }

  private persisterFor(id: string): (cred: CodeArtsCredential) => Promise<void> {
    return async (cred: CodeArtsCredential): Promise<void> => {
      if (this._doc === undefined) return
      this._doc.accounts[id] = cred
      await this.persistDoc()
    }
  }

  private persistDoc(): Promise<void> {
    const snapshot = this._doc
    const write = async (): Promise<void> => {
      if (snapshot !== undefined) await writeJsonAtomic(this.path, snapshot)
    }
    this._writeChain = this._writeChain.then(write, write)
    return this._writeChain
  }

  /** 按展示顺序返回账号摘要。 */
  async list(): Promise<CodeArtsAccountSummary[]> {
    await this.loaded()
    const doc = this._doc as CodeArtsAccountDocument
    return doc.order
      .filter(id => doc.accounts[id] !== undefined)
      .map(id => summarizeAccount(id, doc.accounts[id]))
  }

  async ids(): Promise<string[]> {
    await this.loaded()
    const doc = this._doc as CodeArtsAccountDocument
    return doc.order.filter(id => doc.accounts[id] !== undefined)
  }

  async credential(id: string): Promise<CodeArtsCredential | undefined> {
    await this.loaded()
    return (this._doc as CodeArtsAccountDocument).accounts[id]
  }

  /** 首个账号——卡片顶部与 CLI 的「当前」。 */
  async current(): Promise<CodeArtsCredential | undefined> {
    const ids = await this.ids()
    return ids.length === 0 ? undefined : (this._doc as CodeArtsAccountDocument).accounts[ids[0]]
  }

  async hasCredential(): Promise<boolean> {
    return (await this.ids()).length > 0
  }

  /** 新增或更新一个账号，返回它的 id。 */
  async upsert(cred: CodeArtsCredential, id: string = accountIdOf(cred)): Promise<string> {
    await this.loaded()
    const doc = this._doc as CodeArtsAccountDocument
    this._slots.get(id)?.invalidate()
    doc.accounts[id] = cred
    if (!doc.order.includes(id)) doc.order.push(id)
    this._slots.set(id, new AccountSlot(cred, this.persisterFor(id)))
    await this.persistDoc()
    await claimIfPossible(cred)
    return id
  }

  /**
   * 从一次 OAuth 登录结果新增/更新账号。
   *
   * 「再登录一次」天然就是「添加账号」：同一账号（userId 相同）是更新，
   * 别的账号就是新增 —— 所以登录路由本身不需要改。
   */
  async upsertFromOAuth(t: OAuthToken, label?: string): Promise<string> {
    return this.upsert(credentialFromOAuth(t, label))
  }

  /** 手工粘贴 security_token（降级态，无 AK/SK）——固定覆盖同一个「手工」账号。 */
  async set(token: string, label?: string): Promise<void> {
    await this.upsert({ token: token.trim(), label, storedAt: Date.now() }, MANUAL_ACCOUNT_ID)
  }

  async remove(id: string): Promise<void> {
    await this.loaded()
    const doc = this._doc as CodeArtsAccountDocument
    this._slots.get(id)?.invalidate()
    this._slots.delete(id)
    delete doc.accounts[id]
    doc.order = doc.order.filter(existing => existing !== id)
    await this.persistDoc()
  }

  /** 清空全部账号（整体登出）。 */
  async clear(): Promise<void> {
    await this.loaded()
    for (const slot of this._slots.values()) slot.invalidate()
    this._slots.clear()
    this._doc = { version: 1, order: [], accounts: {} }
    await this.persistDoc()
    // 旧的单凭证文件也要删：留着它，一旦账号文档被删掉就会「复活」出一个
    // 早已登出的凭证。
    await clearCredential(this.legacyPath)
  }

  /** 给 shim 用：解析某账号的签名材料（内部含续期）。 */
  async resolve(id: string): Promise<ResolvedCredential | undefined> {
    await this.loaded()
    const slot = this._slots.get(id)
    if (slot === undefined) return undefined
    const cred = await slot.ensureFresh()
    return {
      token: cred.token,
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      securityToken: cred.token,
    }
  }
}
