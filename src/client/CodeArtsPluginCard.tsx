import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeArtsWebStatus } from '../web-status.ts'
import styles from './CodeArtsPluginCard.module.css'

export interface CodeArtsPluginCardInjected {
  t: (key: string, params?: Record<string, string | number>) => string
}

interface LocalStatus extends Omit<CodeArtsWebStatus, 'models'> {
  models?: readonly { id: string; name: string }[]
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

export function CodeArtsPluginCard({ t }: CodeArtsPluginCardInjected): React.ReactElement {
  const [status, setStatus] = useState<LocalStatus | null>(null)
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
  const dotState: StateDotState = signedIn ? 'done' : expired ? 'warning' : 'idle'
  const statusText = signedIn ? t('statusSignedIn') : expired ? t('statusExpired') : t('statusSignedOut')
  const storedTime = formatStored(status?.storedAt)
  const storedLabel = status?.label?.trim() ?? ''
  const meta = !signedIn || storedTime === ''
    ? ''
    : storedLabel === ''
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
              <span className={styles.count}>{accounts.length}</span>
            </div>
            {accounts.length > 1 && <p className={styles.hint}>{t('accountsRotateHint')}</p>}
            {accounts.map(account => (
              <div key={account.id} className={styles.choiceRow}>
                <span className={styles.name}>{accountName(account)}</span>
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
            ))}
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
      </div>
    </div>
  )
}
