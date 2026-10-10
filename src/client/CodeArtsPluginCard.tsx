import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeArtsWebStatus, CodeArtsWebUsage, CodeArtsCreditSnapshot } from '../web-status.ts'
import styles from './CodeArtsPluginCard.module.css'

export interface CodeArtsPluginCardInjected {
  t: (key: string, params?: Record<string, string | number>) => string
}

interface LocalStatus extends Omit<CodeArtsWebStatus, 'models' | 'usage'> {
  models?: readonly { id: string; name: string }[]
  /** 老宿主/取不到账本时可能没有这一块，卡片据此隐藏用量区块。 */
  usage?: CodeArtsWebUsage
}

interface ModelChoice {
  id: string
  name: string
  enabled: boolean
  free?: boolean
}

interface ModelSelectionDoc {
  selection: {
    choices: ModelChoice[]
    restricted: boolean
    writable: boolean
  }
}

function formatStored(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

/** 上游给的 name 自带「 (免费)」尾巴，已经用 Tag 表达了就别重复一遍。 */
const TRAILING_FREE = /\s*[（(]\s*免费\s*[)）]\s*$/

function modelName(choice: ModelChoice): string {
  return choice.free === true ? choice.name.replace(TRAILING_FREE, '') : choice.name
}

/** 官方用量明细页。 */
const OFFICIAL_USAGE_URL = 'https://codearts.huaweicloud.com/portal/settings/personal-usage'

/**
 * 账号身份默认遮蔽后的占位符。
 *
 * 卡片经常被截图贴进问题反馈，账号名（label / userName / id）与获取、过期时间
 * 没有出现在截图里的必要，所以默认遮住，点一下才展开。
 */
const ACCOUNT_MASK = '*******'

/** token 数按人类习惯缩写：12345 -> 12.3k。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : '0'
}

/** 积分/token 千分位格式化（2000 → "2,000"）。 */
function formatCredits(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(Math.round(value)) : '0'
}

/**
 * 积分区块。
 *
 * 2026-10 从官方 CodeArts Agent 客户端挖出积分接口并实测通过（见 src/credits.ts），
 * 所以这里能直接显示账号总额度 —— 与下面的「本机用量」互补：一个是账号级、一个是
 * 本机级。拉不到时显示原因（creditsError），不静默吞掉。
 */
function CreditsSection({
  credits,
  error,
  t,
  onClaimed,
}: {
  credits?: CodeArtsCreditSnapshot
  error?: string
  t: CodeArtsPluginCardInjected['t']
  onClaimed?: () => void
}): React.ReactElement | null {
  // 签到是每天一次：今天领过了就显示「已领取」并置灰，刷新页面也保持。
  const [claimState, setClaimState] = useState<'idle' | 'loading' | 'success' | 'error'>(() => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      if (typeof localStorage !== 'undefined' && localStorage.getItem('codearts-claim-date') === today) {
        return 'success'
      }
    } catch { /* localStorage 不可用时退化为不记忆 */ }
    return 'idle'
  })
  const [claimMessage, setClaimMessage] = useState('')
  if (credits === undefined && error === undefined) return null
  const handleClaim = async (): Promise<void> => {
    setClaimState('loading')
    try {
      const res = await fetch('/api/codearts/claim', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
      const data = (await res.json().catch(() => undefined)) as { ok?: boolean; message?: string } | undefined
      if (res.ok && data?.ok === true) {
        setClaimState('success')
        try {
          const today = new Date().toISOString().slice(0, 10)
          if (typeof localStorage !== 'undefined') localStorage.setItem('codearts-claim-date', today)
        } catch { /* 记不住就算了，不影响领取本身 */ }
        onClaimed?.()
      } else {
        setClaimState('error')
        setClaimMessage(data?.message ?? `HTTP ${res.status}`)
      }
    } catch (err: unknown) {
      setClaimState('error')
      setClaimMessage(err instanceof Error ? err.message : String(err))
    }
  }
  const c = credits?.credits
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{t('creditsTitle')}</span>
        <span className={styles.headActions}>
          {c !== undefined && (
            <span className={styles.count}>
              {t('creditsRemaining', { remain: formatCredits(c.total.remain), total: formatCredits(c.total.total) })}
            </span>
          )}
          {onClaimed !== undefined && (
            <Button
              variant="outline"
              size="sm"
              disabled={claimState === 'loading' || claimState === 'success'}
              onClick={() => void handleClaim()}
            >
              {claimState === 'loading' ? t('claiming') : claimState === 'success' ? t('claimSuccess') : t('claimButton')}
            </Button>
          )}
        </span>
      </div>
      {error !== undefined && <p className={styles.hint}>{t('creditsUnavailable', { message: error })}</p>}
      {claimState === 'error' && <p className={styles.hint}>{t('claimFailed', { message: claimMessage })}</p>}
      {c !== undefined && (
        <>
          <div className={styles.choiceRow}>
            <span className={styles.name}>{c.planName}</span>
            <span className={styles.meta}>{t('creditsUsed', { used: formatCredits(c.total.used) })}</span>
          </div>
          {c.periodEnd !== undefined && (
            <div className={styles.choiceRow}>
              <span className={styles.name}>{t('creditsReset', { date: c.periodEnd })}</span>
              {c.total.expiring > 0 && (
                <span className={styles.meta}>
                  {t('creditsExpiring', { expiring: formatCredits(c.total.expiring), date: c.periodEnd })}
                </span>
              )}
            </div>
          )}
          {credits?.tokens !== undefined && (
            <div className={styles.choiceRow}>
              <span className={styles.name}>
                {t('creditsTokensToday', { used: formatCredits(credits.tokens.dailyUsed), limit: formatCredits(credits.tokens.dailyLimit) })}
              </span>
              <span className={styles.meta}>{t('creditsTokensBalance', { balance: formatCredits(credits.tokens.balance) })}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 用量区块。
 *
 * 只展示**本机经插件发出**的请求（不等于账号总额度 —— 账号额度见上方积分区块）；
 * 会话槽位是真事实 —— 每账号 3 个并发会话、被占时要等约 52 秒才释放，这也正是
 * 「打断后重新提问要等」的原因。
 */
function UsageSection({
  usage,
  t,
}: {
  usage: CodeArtsWebUsage
  t: CodeArtsPluginCardInjected['t']
}): React.ReactElement {
  const total = usage.today.requests
  const stateLabel: Record<CodeArtsWebUsage['slots'][number]['state'], string> = {
    ok: t('usageStateOk'),
    capped: t('usageStateCapped'),
    cooling: t('usageStateCooling'),
    disabled: t('usageStateDisabled'),
  }
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{t('usageTitle')}</span>
        <span className={styles.count}>{t('usageRequests', { n: formatCount(total) })}</span>
      </div>

      {total === 0 ? (
        <p className={styles.hint}>{t('usageEmpty')}</p>
      ) : (
        <>
          <div className={styles.choiceRow}>
            <span className={styles.name}>{t('usageToday')}</span>
            <span className={styles.meta}>
              {t('usageTokens', {
                prompt: formatTokens(usage.today.promptTokens),
                completion: formatTokens(usage.today.completionTokens),
              })}
            </span>
          </div>
          <div className={styles.choiceRow}>
            <span className={styles.name}>{t('usageAllTime', { days: formatCount(usage.days) })}</span>
            <span className={styles.meta}>
              {t('usageRequests', { n: formatCount(usage.allTime.requests) })}
              {' · '}
              {t('usageTokens', {
                prompt: formatTokens(usage.allTime.promptTokens),
                completion: formatTokens(usage.allTime.completionTokens),
              })}
            </span>
          </div>
          {usage.byModelToday.length > 0 && (
            <>
              <p className={styles.hint}>{t('usageByModel')}</p>
              {usage.byModelToday.slice(0, 5).map(entry => (
                <div key={entry.id} className={styles.choiceRow}>
                  <span className={styles.name}>{entry.id}</span>
                  <span className={styles.meta}>
                    {t('usageRequests', { n: formatCount(entry.totals.requests) })}
                    {' · '}
                    {t('usageTokens', {
                      prompt: formatTokens(entry.totals.promptTokens),
                      completion: formatTokens(entry.totals.completionTokens),
                    })}
                  </span>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {usage.slots.length > 0 && (
        <>
          <p className={styles.hint}>{t('usageSlots')}</p>
          {usage.slots.map(slot => (
            <div key={slot.id} className={styles.choiceRow}>
              <span className={styles.name}>{`${slot.active}/${slot.max}`}</span>
              {slot.state === 'ok' ? (
                <Tag tone="success">{stateLabel.ok}</Tag>
              ) : (
                <Tag>{stateLabel[slot.state]}</Tag>
              )}
            </div>
          ))}
        </>
      )}

      <p className={styles.hint}>
        {t('usageNoQuota')}
        {' '}
        <a className={styles.link} href={OFFICIAL_USAGE_URL} target="_blank" rel="noreferrer">
          {OFFICIAL_USAGE_URL}
        </a>
      </p>
    </div>
  )
}

export function CodeArtsPluginCard({ t }: CodeArtsPluginCardInjected): React.ReactElement {  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [token, setToken] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [loginPending, setLoginPending] = useState(false)
  const [selection, setSelection] = useState<ModelSelectionDoc['selection'] | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [savingModels, setSavingModels] = useState(false)
  const [savedModels, setSavedModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  /** 账号身份是否展开：默认遮蔽（false = 显示 *******）。 */
  const [accountsRevealed, setAccountsRevealed] = useState(false)

  async function refresh(): Promise<void> {
    try {
      const res = await fetch('/api/codearts/status', { headers: { Accept: 'application/json' } })
      const data = (await res.json()) as LocalStatus
      setStatus(data)
    } catch {
      setStatus({ status: 'signed-out', models: [], accounts: [] })
    }
  }

  async function refreshSelection(): Promise<void> {
    try {
      const res = await fetch('/api/codearts/enabled-models', { headers: { Accept: 'application/json' } })
      const data = (await res.json()) as ModelSelectionDoc
      setSelection(data.selection)
      setDraft(data.selection.choices.filter(c => c.enabled).map(c => c.id))
      setSavedModels(true)
    } catch {
      setSelection(null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    void refreshSelection()
  }, [])

  useEffect(() => {
    if (status?.status === 'signed-in') void refreshSelection()
  }, [status?.status])

  async function saveToken(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/codearts/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), label: label.trim() || undefined }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setMsg(data.error ?? `HTTP ${res.status}`)
      } else {
        setToken('')
        setLabel('')
        await refresh()
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function clearToken(): Promise<void> {
    setBusy(true)
    try {
      await fetch('/api/codearts/token', { method: 'DELETE' })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function removeAccount(id: string): Promise<void> {
    setBusy(true)
    try {
      await fetch(`/api/codearts/accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  // 服务端把「空数组」当作「不加限制 = 全部可用」，所以全选时回写空数组。
  const all = selection?.choices.length ?? 0
  const wire = draft.length === all ? [] : draft
  const savedIds = selection?.choices.filter(c => c.enabled).map(c => c.id) ?? []
  const dirty = savedIds.length !== draft.length || savedIds.some(id => !draft.includes(id))

  function setModel(id: string, on: boolean): void {
    setSavedModels(false)
    setModelError(null)
    setDraft(current => (on ? [...current, id] : current.filter(e => e !== id)))
  }

  async function saveModels(): Promise<void> {
    setSavingModels(true)
    setModelError(null)
    try {
      const res = await fetch('/api/codearts/enabled-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabledModels: wire }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as ModelSelectionDoc
      setSelection(data.selection)
      setDraft(data.selection.choices.filter(c => c.enabled).map(c => c.id))
      setSavedModels(true)
    } catch (err) {
      setModelError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingModels(false)
    }
  }

  async function startOAuthLogin(): Promise<void> {
    setBusy(true)
    setMsg(null)
    setLoginPending(true)
    try {
      const res = await fetch('/api/codearts/login', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data.url !== 'string') {
        setMsg(data.error ?? `HTTP ${res.status}`)
        setLoginPending(false)
        return
      }
      setLoginUrl(data.url)
      // 打开浏览器让用户登录
      if (typeof window !== 'undefined') window.open(data.url, '_blank')
      // 轮询登录结果
      const poll = async (): Promise<void> => {
        const r = await fetch(`/api/codearts/login/status?url=${encodeURIComponent(data.url)}`, {
          headers: { Accept: 'application/json' },
        })
        const st = await r.json().catch(() => ({ status: 'pending' }))
        if (st.status === 'done') {
          setLoginUrl(null)
          setLoginPending(false)
          await refresh()
          return
        }
        if (st.status === 'error') {
          setLoginUrl(null)
          setLoginPending(false)
          setMsg(t('loginFailed'))
          return
        }
        // 服务端已经不认识这个会话：登录完成/超时/插件重载都会走到这。继续空转
        // 按钮就会永远停在「登录中」——把 idle 也当终止态，刷新一次让卡片反映
        // 真实结果（加上就是多一个账号，没加上就是没变）。
        if (st.status === 'idle') {
          setLoginUrl(null)
          setLoginPending(false)
          await refresh()
          return
        }
        setTimeout(() => void poll(), 1500)
      }
      void poll()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
      setLoginPending(false)
    } finally {
      setBusy(false)
    }
  }

  const signedIn = status?.status === 'signed-in'
  const expired = status?.status === 'expired'
  const accounts = status?.accounts ?? []
  const accountName = (account: { label?: string; userName?: string; id: string }): string =>
    account.label?.trim() || account.userName?.trim() || account.id
  /** 遮蔽态下账号身份一律换成占位符：原值连 DOM 都不进。 */
  const reveal = (value: string): string => (accountsRevealed ? value : ACCOUNT_MASK)
  /**
   * 每个账号的「获取时间 + 过期状态」。同一账号重复登录可能留下多条记录（上游不给
   * 稳定身份时的妥协），把时间摆出来用户才能一眼认出哪条是旧的、放心删。
   */
  const accountMeta = (account: { storedAt?: number; expiration?: string }): string => {
    const parts: string[] = []
    const stored = formatStored(account.storedAt)
    if (stored !== '') parts.push(t('accountStored', { time: stored }))
    const exp = typeof account.expiration === 'string' ? Date.parse(account.expiration) : NaN
    if (Number.isFinite(exp)) {
      parts.push(exp <= Date.now()
        ? t('accountExpired', { time: formatStored(exp) })
        : t('accountExpires', { time: formatStored(exp) }))
    }
    return parts.join(' · ')
  }
  const dotState: StateDotState = signedIn ? 'done' : expired ? 'warning' : 'idle'
  const statusText = signedIn ? t('statusSignedIn') : expired ? t('statusExpired') : t('statusSignedOut')
  const storedTime = formatStored(status?.storedAt)
  const storedLabel = status?.label?.trim() ?? ''
  // 头部摘要里的 label 同样是账号身份，所以遮蔽态退回「存于 <时间>」那一句。
  const meta = !signedIn || storedTime === ''
    ? ''
    : storedLabel === '' || !accountsRevealed
      ? t('storedMetaNoLabel', { time: storedTime })
      : t('storedMeta', { label: storedLabel, time: storedTime })

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headText}>
          <span className={styles.name}>{t('cardTitle')}</span>
          <span className={styles.statusLine}>
            <StateDot state={dotState} />
            {statusText}
          </span>
          {meta !== '' && <span className={styles.meta}>{meta}</span>}
          <span className={styles.desc}>{signedIn ? t('descSignedIn') : t('descSignedOut')}</span>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </div>

      <div className={styles.body}>
        {signedIn ? (
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{t('accountsTitle')}</span>
              <span className={styles.headActions}>
                <span className={styles.count}>{accounts.length}</span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={accountsRevealed}
                  onClick={() => setAccountsRevealed(revealed => !revealed)}
                >
                  {accountsRevealed ? t('accountsHide') : t('accountsShow')}
                </Button>
              </span>
            </div>
            {accounts.length > 1 && <p className={styles.hint}>{t('accountsRotateHint')}</p>}
            {accounts.map(account => {
              const meta = accountMeta(account)
              return (
                <div key={account.id} className={styles.choiceRow}>
                  <span className={styles.name}>{reveal(accountName(account))}</span>
                  <span className={styles.meta}>{reveal(meta)}</span>
                  {account.stale && <Tag>{t('accountNeedsSignIn')}</Tag>}
                  {!account.signable && <Tag>{t('accountNoKey')}</Tag>}
                <Button
                  variant="outline"
                  size="sm"
                  className={styles.danger}
                  disabled={busy}
                  onClick={() => void removeAccount(account.id)}
                >
                  {t('accountRemove')}
                </Button>
                </div>
              )
            })}
            <div className={styles.actions}>
              <Button variant="primary" size="sm" disabled={busy || loginPending} onClick={() => void startOAuthLogin()}>
                {loginPending ? t('signingIn') : t('addAccount')}
              </Button>
              <Button variant="outline" size="sm" className={styles.danger} disabled={busy} onClick={() => void clearToken()}>
                {t('clearToken')}
              </Button>
            </div>
            {loginUrl !== null && (
              <p className={styles.hint}>
                {t('openManually')}
                {' '}
                <a className={styles.link} href={loginUrl} target="_blank" rel="noreferrer">{loginUrl}</a>
              </p>
            )}
          </div>
        ) : (
          <div className={styles.section}>
            {expired && <p className={styles.hint}>{t('expiredHint')}</p>}
            <div className={styles.actions}>
              <Button variant="primary" disabled={busy || loginPending} onClick={() => void startOAuthLogin()}>
                {loginPending ? t('signingIn') : t('signIn')}
              </Button>
            </div>
            {loginUrl !== null && (
              <p className={styles.hint}>
                {t('openManually')}
                {' '}
                <a className={styles.link} href={loginUrl} target="_blank" rel="noreferrer">{loginUrl}</a>
              </p>
            )}
            <details className={styles.manual}>
              <summary className={styles.manualSummary}>{t('manualToken')}</summary>
              <form onSubmit={(e) => void saveToken(e)}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="codearts-token">{t('tokenLabel')}</label>
                  <textarea
                    id="codearts-token"
                    className={styles.area}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={t('tokenPlaceholder')}
                    rows={4}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="codearts-label">{t('labelLabel')}</label>
                  <Input
                    id="codearts-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('labelPlaceholder')}
                  />
                </div>
                <div className={styles.actions}>
                  <Button variant="primary" size="sm" type="submit" disabled={busy || token.trim() === ''}>
                    {t('saveToken')}
                  </Button>
                </div>
              </form>
            </details>
          </div>
        )}

        {msg !== null && <p className={styles.error}>{msg}</p>}

        {selection ? (
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{t('modelsTitle')}</span>
              <span className={styles.count}>{t('selectedCount', { n: draft.length, total: all })}</span>
            </div>
            <p className={styles.hint}>
              {selection.restricted ? t('optionalModelsHint') : t('optionalModelsAllHint')}
            </p>
            <div className={styles.choices}>
              {selection.choices.map(choice => (
                <div key={choice.id} className={styles.choiceRow}>
                  <Checkbox
                    className={styles.check}
                    checked={draft.includes(choice.id)}
                    disabled={!selection.writable || savingModels}
                    onChange={(on) => setModel(choice.id, on)}
                    label={modelName(choice)}
                  />
                  {choice.free === true && <Tag tone="success">{t('free')}</Tag>}
                </div>
              ))}
            </div>
            {selection.writable && (
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draft.length === all}
                  onClick={() => {
                    setSavedModels(false)
                    setModelError(null)
                    setDraft(selection.choices.map(c => c.id))
                  }}
                >
                  {t('selectAll')}
                </Button>
                <Button variant="primary" size="sm" disabled={!dirty || savingModels} onClick={() => void saveModels()}>
                  {savingModels ? t('saving') : savedModels && !dirty ? t('saved') : t('saveModels')}
                </Button>
              </div>
            )}
            {modelError !== null && <p className={styles.error}>{modelError}</p>}
          </div>
        ) : (
          <p className={styles.hint}>{t('modelsLoading')}</p>
        )}

        {signedIn && (status?.credits !== undefined || status?.creditsError !== undefined) && (
          <CreditsSection credits={status?.credits} error={status?.creditsError} t={t} onClaimed={() => void refresh()} />
        )}
        {status?.usage !== undefined && <UsageSection usage={status.usage} t={t} />}
      </div>
    </div>
  )
}
