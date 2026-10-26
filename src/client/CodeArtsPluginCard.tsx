import { useEffect, useId, useState } from 'react'
import { Button, Checkbox, Input, SegmentedTabs, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeArtsWebStatus, CodeArtsWebUsage, CodeArtsCreditSnapshot, CodeArtsWelfareState } from '../web-status.ts'
import { stripModelSuffixes } from '../catalog.ts'
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
  benefit?: boolean
  blocked?: boolean
  /** 后端已经格式化好的倍率（`x0.18`，福利为 `x0.00`）。 */
  ratio?: string
}

interface ModelSelectionDoc {
  selection: {
    choices: ModelChoice[]
    restricted: boolean
    writable: boolean
  }
}

/** POST /api/codearts/refresh-models 的响应（后端契约见 web-status.ts）。 */
interface RefreshModelsResponse {
  ok?: boolean
  models?: number
  benefit?: number
  refreshed?: boolean
  selection?: ModelSelectionDoc['selection']
  message?: string
}

function formatStored(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

/** 目录里的 name 自带「 · x0.18 · 福利」尾巴，这里已经用 Tag 表达了就别重复。 */
function modelName(choice: ModelChoice): string {
  return stripModelSuffixes(choice.name)
}

/** 官方用量明细页。 */
const OFFICIAL_USAGE_URL = 'https://codearts.huaweicloud.com/portal/settings/personal-usage'

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

/** POST /api/codearts/claim 的响应（后端契约见 web-status.ts 的 CodeArtsClaimResult）。 */
interface ClaimResponse {
  ok?: boolean
  claimed?: boolean
  state?: CodeArtsWelfareState
  amount?: number
  message?: string
  /** 逐账号结果：批量领取时卡片按 id 把文案挂回各自的积分块。 */
  results?: ({ id?: string } & Omit<ClaimResponse, 'results'>)[]
}

/** 批量领取的 claimingId 哨兵（真实账号 id 不会等于它）。 */
const CLAIM_ALL = '*'

/** 一次领取操作的文案：优先用后端逐号结果，老后端只回一条时按 id 归位。 */
function claimMessagesOf(
  data: ClaimResponse | null,
  accountIds: readonly string[],
  t: Translate,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (data === null) return out
  const results = data.results ?? []
  if (results.length > 0) {
    for (const result of results) {
      if (result.id !== undefined) out[result.id] = claimText(result, t)
    }
    return out
  }
  for (const id of accountIds) out[id] = claimText(data, t)
  return out
}

type Translate = CodeArtsPluginCardInjected['t']

type CardTab = 'accounts' | 'models' | 'usage'

/** 一个 Tab 面板；未选中的用 hidden 留在 DOM 里，草稿和滚动位置都别丢。 */
function TabPanel({
  id,
  labelledBy,
  active,
  children,
}: {
  id: string
  labelledBy: string
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      hidden={!active}
      tabIndex={0}
      className={styles.tabPanel}
    >
      {children}
    </div>
  )
}

/**
 * 领取结果 → 文案。
 *
 * 本地状态（claimed/already/没有这个活动）用界面自己的话；只有 failed 才透出
 * 上游给的 reason —— 那句往往才是排障要的东西（签名失败、404、非 JSON…）。
 */
function claimText(data: ClaimResponse | null, t: Translate): string {
  if (data?.claimed === true) {
    return t('claimDone', { amount: formatCredits(data.amount ?? 0) })
  }
  if (data?.state === 'already') return t('claimAlready')
  if (data?.state === 'unavailable') return t('claimUnavailable')
  const message = typeof data?.message === 'string' && data.message !== '' ? data.message : 'request failed'
  return t('claimFailed', { message })
}

function formatClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** 后端拿不到积分时的几种「账号本身不可用」原因，换成用户能懂的一句话。 */
function creditErrorText(message: string, t: Translate): string {
  switch (message) {
    case 'account needs sign-in':
    case 'no usable credential':
    case 'account not found':
    case 'account no longer stored':
      return t('creditsNeedSignIn')
    default:
      return message
  }
}

/**
 * 账号卡片里的积分块。
 *
 * 积分并进账号页：视线从上到下就是「谁登录着 → 这个号还有多少积分 → 去签到」。
 * 拉不到时只把原因留在块里，别把上面的账号一起拖没。
 */
function CreditBlock({
  credits,
  error,
  t,
  onClaim,
  claiming,
  claimResult,
  justClaimed,
}: {
  credits?: CodeArtsCreditSnapshot
  error?: string
  t: CodeArtsPluginCardInjected['t']
  onClaim: () => void
  claiming: boolean
  /** 上一次领取的结果文案；null 表示本次还没点过。 */
  claimResult: string | null
  /** 这一次刚领成：领完后 delivery 有几秒还回「可领」，这段时间靠它兜住按钮。 */
  justClaimed: boolean
}): React.ReactElement | null {
  if (credits === undefined && error === undefined) return null
  const c = credits?.credits
  const claimedToday = justClaimed || credits?.welfare?.claimedToday === true
  const expiring = c?.total.expiring ?? 0
  const expiringRatio = c !== undefined && c.total.total > 0
    ? Math.min(100, Math.max(0, (expiring / c.total.total) * 100))
    : 0
  const usedRatio = c !== undefined && c.total.total > 0
    ? Math.min(100, Math.max(0, (c.total.used / c.total.total) * 100))
    : 0
  const usedLabel = c === undefined
    ? ''
    : t('creditsUsedOfTotal', { used: formatCredits(c.total.used), total: formatCredits(c.total.total) })
  const updated = formatClock(c?.fetchedAt)
  return (
    <div className={styles.creditBlock}>
      {c !== undefined ? (
        <>
          <div className={styles.balanceRow}>
            <span className={styles.balance}>{formatCredits(c.total.remain)}</span>
            <span className={styles.balanceUnit}>{t('creditsUnit')}</span>
            <span className={styles.balanceMeta}>{t('creditsUsed', { used: formatCredits(c.total.used) })}</span>
            {updated !== '' && <span className={styles.updated}>{t('creditsUpdated', { time: updated })}</span>}
          </div>
          <div className={styles.creditRows}>
            <div className={styles.creditRow}>
              <span>{t('creditsTotal', { total: formatCredits(c.total.total) })}</span>
              {c.periodEnd !== undefined && <span>{t('creditsReset', { date: c.periodEnd })}</span>}
            </div>
            {c.total.total > 0 && (
              <span
                className={styles.usageBar}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={c.total.total}
                aria-valuenow={Math.min(c.total.used, c.total.total)}
                aria-label={usedLabel}
                title={usedLabel}
              >
                <span className={styles.usageFill} style={{ width: `${usedRatio}%` }} />
              </span>
            )}
            {expiring > 0 && (
              <div className={styles.expiryRow}>
                <div className={styles.creditRow}>
                  <span className={styles.expiryLabel}>{t('creditsExpiringShort', { expiring: formatCredits(expiring) })}</span>
                  {c.periodEnd !== undefined && <span>{t('creditsReset', { date: c.periodEnd })}</span>}
                </div>
                <span className={styles.bar}>
                  <span className={styles.barFill} style={{ width: `${expiringRatio}%` }} />
                </span>
              </div>
            )}
            {credits?.tokens !== undefined && (
              <div className={styles.creditRow}>
                <span>
                  {t('creditsTokensToday', {
                    used: formatCredits(credits.tokens.dailyUsed),
                    limit: formatCredits(credits.tokens.dailyLimit),
                  })}
                </span>
                <span>{t('creditsTokensBalance', { balance: formatCredits(credits.tokens.balance) })}</span>
              </div>
            )}
          </div>
          <a
            className={`${styles.link} ${styles.creditLink}`}
            href={c.packageUrl ?? OFFICIAL_USAGE_URL}
            target="_blank"
            rel="noreferrer"
          >
            {t('creditsDetailLink')}
          </a>
        </>
      ) : (
        <p className={styles.creditHint}>
          {t('creditsUnavailable', { message: creditErrorText(error ?? '', t) })}
        </p>
      )}
      <div className={styles.creditFooter}>
        <Button variant="outline" size="sm" disabled={claiming || claimedToday} onClick={onClaim}>
          {claiming ? t('claimPending') : claimedToday ? t('claimButtonDone') : t('claimButton')}
        </Button>
        {c !== undefined && <Tag tone="quiet">{c.planName}</Tag>}
      </div>
      <p className={styles.creditHint}>{claimResult ?? t('claimHint')}</p>
    </div>
  )
}

/** 登录前的手动填 token 表单；登录后从「粘贴 Token 添加」展开的也是这一份。 */
function ManualTokenForm({
  t,
  token,
  label,
  busy,
  onToken,
  onLabel,
  onSubmit,
}: {
  t: Translate
  token: string
  label: string
  busy: boolean
  onToken: (value: string) => void
  onLabel: (value: string) => void
  onSubmit: (event: React.FormEvent) => void
}): React.ReactElement {
  return (
    <form onSubmit={onSubmit}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="codearts-token">{t('tokenLabel')}</label>
        <textarea
          id="codearts-token"
          className={styles.area}
          value={token}
          onChange={(e) => onToken(e.target.value)}
          placeholder={t('tokenPlaceholder')}
          rows={4}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="codearts-label">{t('labelLabel')}</label>
        <Input
          id="codearts-label"
          value={label}
          onChange={(e) => onLabel(e.target.value)}
          placeholder={t('labelPlaceholder')}
        />
      </div>
      <div className={styles.actions}>
        <Button variant="primary" size="sm" type="submit" disabled={busy || token.trim() === ''}>
          {t('saveToken')}
        </Button>
      </div>
    </form>
  )
}

/** 一条用量条的数据：模型和账号共用同一套渲染。 */
interface UsageBarRow {
  id: string
  label: string
  totals: CodeArtsWebUsage['today']
}

/**
 * 横向条形列表：名称 / 条 / token / 占比 / 请求数。
 *
 * 条长按「占组内总量的比例」画（不是按最大值归一化），所以几条加起来就是全部。
 * token 全 0 的日子（只有请求数、没收到 usage 帧）退回按请求数画。
 */
function UsageBars({
  rows,
  t,
}: {
  rows: readonly UsageBarRow[]
  t: CodeArtsPluginCardInjected['t']
}): React.ReactElement | null {
  const tokenMode = rows.some(row => row.totals.totalTokens > 0)
  const valueOf = (row: UsageBarRow): number =>
    tokenMode ? row.totals.totalTokens : row.totals.requests
  const sum = rows.reduce((total, row) => total + valueOf(row), 0)
  const top = [...rows].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 5)
  if (top.length === 0) return null
  return (
    <div className={styles.modelChart}>
      {top.map(row => {
        const value = valueOf(row)
        const share = sum > 0 ? (value / sum) * 100 : 0
        const detail = [
          t('usageRequests', { n: formatCount(row.totals.requests) }),
          t('usageTokens', {
            prompt: formatTokens(row.totals.promptTokens),
            completion: formatTokens(row.totals.completionTokens),
          }),
        ].join(' · ')
        return (
          <div key={row.id} className={styles.modelRow} title={`${row.label} · ${detail}`}>
            <span className={styles.modelName}>{row.label}</span>
            <span className={styles.modelTrack}>
              <span
                className={styles.modelFill}
                // 有值但占比极小的项也留 1.5% 的条，否则看起来像没用量。
                style={{ width: `${value > 0 ? Math.max(share, 1.5) : 0}%` }}
              />
            </span>
            <span className={styles.modelTokens}>
              {tokenMode ? formatTokens(value) : formatCount(value)}
            </span>
            <span className={styles.modelShare}>{share.toFixed(1)}%</span>
            <span className={styles.modelRequests}>
              {t('usageRequestCount', { n: formatCount(row.totals.requests) })}
            </span>
          </div>
        )
      })}
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
  accounts,
  t,
}: {
  usage: CodeArtsWebUsage
  accounts: readonly { id: string; label?: string; userName?: string }[]
  t: CodeArtsPluginCardInjected['t']
}): React.ReactElement {
  const total = usage.today.requests
  const stateLabel: Record<CodeArtsWebUsage['slots'][number]['state'], string> = {
    ok: t('usageStateOk'),
    capped: t('usageStateCapped'),
    cooling: t('usageStateCooling'),
    disabled: t('usageStateDisabled'),
  }
  // 已删账号的当日用量仍会留在账本里，这时只能退回显示 id。
  const nameOf = new Map(
    accounts.map(account => [account.id, account.label?.trim() || account.userName?.trim() || account.id]),
  )
  const accountRows: UsageBarRow[] = Object.entries(usage.byAccountToday).map(([id, totals]) => ({
    id,
    label: nameOf.get(id) ?? id,
    totals,
  }))
  const modelRows: UsageBarRow[] = usage.byModelToday.map(entry => ({
    id: entry.id,
    label: entry.id.split(' · ')[0],
    totals: entry.totals,
  }))
  const hasUsage = usage.allTime.requests > 0 || total > 0
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{t('usageTitle')}</span>
        <span className={styles.count}>{t('usageRequests', { n: formatCount(total) })}</span>
      </div>

      {!hasUsage ? (
        <p className={styles.hint}>{t('usageEmpty')}</p>
      ) : (
        <>
          <div className={styles.choiceRow}>
            <span className={styles.name}>{t('usageTodayTotal')}</span>
            <span className={styles.meta}>
              {t('usageRequests', { n: formatCount(total) })}
              {' · '}
              {t('usageTokens', {
                prompt: formatTokens(usage.today.promptTokens),
                completion: formatTokens(usage.today.completionTokens),
              })}
            </span>
          </div>
          <div className={styles.choiceRow}>
            <span className={styles.name}>{t('usageLast30')}</span>
            <span className={styles.meta}>
              {t('usageRequests', { n: formatCount(usage.last30.requests) })}
              {' · '}
              {t('usageTokens', {
                prompt: formatTokens(usage.last30.promptTokens),
                completion: formatTokens(usage.last30.completionTokens),
              })}
            </span>
          </div>
          {accounts.length > 1 && accountRows.length > 0 && (
            <>
              <p className={styles.hint}>{t('usageByAccount')}</p>
              <UsageBars rows={accountRows} t={t} />
            </>
          )}
          {modelRows.length > 0 && (
            <>
              <p className={styles.hint}>{t('usageByModel')}</p>
              <UsageBars rows={modelRows} t={t} />
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
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  /** 正在领取的账号 id；批量领取时是 CLAIM_ALL。null 表示没有在飞。 */
  const [claimingId, setClaimingId] = useState<string | null>(null)
  /** 逐账号的领取结果文案。 */
  const [claimResults, setClaimResults] = useState<Record<string, string>>({})
  /** 这次会话里刚领成的账号（快照刷新前先把按钮改成「今日已领」）。 */
  const [claimedIds, setClaimedIds] = useState<Record<string, true>>({})
  const [manualOpen, setManualOpen] = useState(false)
  const [tab, setTab] = useState<CardTab>('accounts')
  const tabIdBase = useId()

  /**
   * 领每日签到积分。给 id 就只领那个号，不给就逐个号都领一遍。
   *
   * 除了这一次刚领成，「今天已领」都来自上游的福利活动状态（积分快照里的 welfare），
   * 所以刷新、重开窗口都不会把按钮说错。领完不记日期：去重在上游按天做。
   */
  async function claim(accountId?: string): Promise<void> {
    const ids = accountId === undefined
      ? (status?.accounts ?? []).map(account => account.id)
      : [accountId]
    setClaimingId(accountId ?? CLAIM_ALL)
    try {
      const res = await fetch('/api/codearts/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountId === undefined ? {} : { id: accountId }),
      })
      const data = (await res.json().catch(() => null)) as ClaimResponse | null
      const messages = claimMessagesOf(data, ids, t)
      if (Object.keys(messages).length > 0) {
        setClaimResults(prev => ({ ...prev, ...messages }))
      }
      const won = data?.results !== undefined && data.results.length > 0
        ? data.results.filter(result => result.claimed === true && result.id !== undefined)
        : data?.claimed === true
          ? ids.map(id => ({ id }))
          : []
      if (won.length > 0) {
        setClaimedIds(prev => {
          const next = { ...prev }
          for (const result of won) next[result.id!] = true
          return next
        })
        await refresh()
      }
    } catch (error: unknown) {
      const message = t('claimFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
      setClaimResults(prev => {
        const next = { ...prev }
        for (const id of ids) next[id] = message
        return next
      })
    } finally {
      setClaimingId(null)
    }
  }

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
  const blockedCount = selection?.choices.filter(c => c.blocked === true).length ?? 0
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

  /**
   * 手动重拉一次模型目录。
   *
   * 存在的理由：限时福利名单会轮换（模型被移出、被转正），后台每小时才拉一次，
   * 干等或重启都不是办法。顺带清掉「福利今日不可用」标记 —— 活动回来时这是唯一
   * 不用等第二天的出口。
   */
  async function refreshCatalog(): Promise<void> {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const res = await fetch('/api/codearts/refresh-models', { method: 'POST' })
      const data = (await res.json().catch(() => null)) as RefreshModelsResponse | null
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`)
      if (data?.selection !== undefined) {
        setSelection(data.selection)
        setDraft(data.selection.choices.filter(c => c.enabled).map(c => c.id))
        setSavedModels(true)
      }
      setRefreshMsg(
        data?.refreshed === false
          ? t('refreshStale', { n: data.models ?? 0 })
          : t('refreshed', { n: data?.models ?? 0, benefit: data?.benefit ?? 0 }),
      )
    } catch (err) {
      setRefreshMsg(t('refreshFailed', {
        message: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setRefreshing(false)
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
  const meta = !signedIn || storedTime === ''
    ? ''
    : storedLabel === ''
      ? t('storedMetaNoLabel', { time: storedTime })
      : t('storedMeta', { label: storedLabel, time: storedTime })

  const tabId = (value: CardTab): string => `${tabIdBase}-tab-${value}`
  const panelId = (value: CardTab): string => `${tabIdBase}-panel-${value}`
  const creditEntries = new Map((status?.creditsByAccount ?? []).map(entry => [entry.id, entry]))
  /** 某账号的积分：新后端按 id 给；老后端只有全局快照，单账号时退回它。 */
  const creditFor = (id: string): { credits?: CodeArtsCreditSnapshot; creditsError?: string } | undefined => {
    const entry = creditEntries.get(id)
    if (entry !== undefined) return entry
    if (creditEntries.size === 0 && accounts.length === 1) {
      if (status?.credits === undefined && status?.creditsError === undefined) return undefined
      return { credits: status?.credits, creditsError: status?.creditsError }
    }
    return undefined
  }
  const usageAvailable = status?.usage !== undefined
  const tabItems: Record<CardTab, SegmentedTab<CardTab>> = {
    accounts: {
      value: 'accounts',
      label: t('tabAccounts', { n: accounts.length }),
      id: tabId('accounts'),
      panelId: panelId('accounts'),
    },
    models: {
      value: 'models',
      label: t('tabModels', { n: draft.length, total: all }),
      id: tabId('models'),
      panelId: panelId('models'),
    },
    usage: {
      value: 'usage',
      label: t('tabUsage'),
      id: tabId('usage'),
      panelId: panelId('usage'),
    },
  }
  // 登录中至少有账号和模型两页；用量没数据时整页不出现，别给空 Tab。
  const tabs: [SegmentedTab<CardTab>, ...SegmentedTab<CardTab>[]] = [
    tabItems.accounts,
    tabItems.models,
    ...(usageAvailable ? [tabItems.usage] : []),
  ]
  // 数据变化（比如积分改为不可用）可能让当前页消失，退回答账号页。
  const activeTab: CardTab = tabs.some(item => item.value === tab) ? tab : 'accounts'

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
        {status?.piAiError !== undefined && <p className={styles.error}>{status.piAiError}</p>}
        {signedIn ? (
          <>
            <SegmentedTabs
              className={styles.tabs}
              items={tabs}
              value={activeTab}
              onChange={setTab}
              label={t('tabsLabel')}
            />

            <TabPanel
              id={panelId('accounts')}
              labelledBy={tabId('accounts')}
              active={activeTab === 'accounts'}
            >
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{t('accountsTitle')}</span>
                  <span className={styles.count}>{accounts.length}</span>
                </div>

                <div className={styles.accountToolbar}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-expanded={manualOpen}
                    disabled={busy}
                    onClick={() => setManualOpen(open => !open)}
                  >
                    {t('pasteTokenAdd')}
                  </Button>
                  <Button variant="primary" size="sm" disabled={busy || loginPending} onClick={() => void startOAuthLogin()}>
                    {loginPending ? t('signingIn') : t('addAccount')}
                  </Button>
                </div>

                {loginUrl !== null && (
                  <p className={styles.hint}>
                    {t('openManually')}
                    {' '}
                    <a className={styles.link} href={loginUrl} target="_blank" rel="noreferrer">{loginUrl}</a>
                  </p>
                )}
                {manualOpen && (
                  <div className={styles.manualForm}>
                    <ManualTokenForm
                      t={t}
                      token={token}
                      label={label}
                      busy={busy}
                      onToken={setToken}
                      onLabel={setLabel}
                      onSubmit={(e) => void saveToken(e)}
                    />
                  </div>
                )}

                <div className={styles.accountCard}>
                  {accounts.map(account => {
                    const accountLine = accountMeta(account)
                    const credit = creditFor(account.id)
                    return (
                      <div key={account.id} className={styles.accountEntry}>
                        <div className={styles.accountRow}>
                          <span className={styles.avatar} aria-hidden="true">
                            {Array.from(accountName(account))[0] ?? '*'}
                          </span>
                          <div className={styles.accountInfo}>
                            <span className={styles.accountNameRow}>
                              <span className={styles.accountName}>{accountName(account)}</span>
                              {account.stale && <Tag>{t('accountNeedsSignIn')}</Tag>}
                              {!account.signable && <Tag>{t('accountNoKey')}</Tag>}
                            </span>
                            {accountLine !== '' && <span className={styles.meta}>{accountLine}</span>}
                          </div>
                          <div className={styles.accountRowActions}>
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
                        </div>
                        {credit !== undefined && (
                          <CreditBlock
                            credits={credit.credits}
                            error={credit.creditsError}
                            t={t}
                            onClaim={() => void claim(account.id)}
                            claiming={claimingId === account.id || claimingId === CLAIM_ALL}
                            claimResult={claimResults[account.id] ?? null}
                            justClaimed={claimedIds[account.id] === true}
                          />
                        )}
                      </div>
                    )
                  })}
                  {accounts.length > 1 && (
                    <div className={styles.claimAllRow}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={claimingId !== null}
                        onClick={() => void claim()}
                      >
                        {claimingId === CLAIM_ALL ? t('claimPending') : t('claimAll')}
                      </Button>
                    </div>
                  )}
                  {accounts.length > 1 && <p className={styles.accountHint}>{t('accountsRotateHint')}</p>}
                </div>

                <div className={styles.actions}>
                  <Button variant="outline" size="sm" className={styles.danger} disabled={busy} onClick={() => void clearToken()}>
                    {t('clearToken')}
                  </Button>
                </div>
              </div>
            </TabPanel>

            <TabPanel
              id={panelId('models')}
              labelledBy={tabId('models')}
              active={activeTab === 'models'}
            >
              {selection ? (
                <div className={styles.section}>
                  <div className={styles.sectionHead}>
                    <span className={styles.sectionLabel}>{t('modelsTitle')}</span>
                    <span className={styles.count}>{t('selectedCount', { n: draft.length, total: all })}</span>
                    <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refreshCatalog()}>
                      {refreshing ? t('refreshing') : t('refreshModels')}
                    </Button>
                  </div>
                  <p className={styles.hint}>
                    {selection.restricted ? t('optionalModelsHint') : t('optionalModelsAllHint')}
                  </p>
                  {blockedCount > 0 && <p className={styles.hint}>{t('benefitBlockedHint', { n: blockedCount })}</p>}
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
                        {choice.benefit === true && (
                          <Tag tone={choice.blocked === true ? 'warning' : 'success'}>
                            {choice.blocked === true ? t('benefitBlocked') : t('benefit')}
                          </Tag>
                        )}
                        {choice.ratio !== undefined && <Tag tone="quiet">{choice.ratio}</Tag>}
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
            </TabPanel>

            {status?.usage !== undefined && (
              <TabPanel
                id={panelId('usage')}
                labelledBy={tabId('usage')}
                active={activeTab === 'usage'}
              >
                <UsageSection usage={status.usage} accounts={accounts} t={t} />
              </TabPanel>
            )}
          </>
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
              <ManualTokenForm
                t={t}
                token={token}
                label={label}
                busy={busy}
                onToken={setToken}
                onLabel={setLabel}
                onSubmit={(e) => void saveToken(e)}
              />
            </details>
          </div>
        )}

        {msg !== null && <p className={styles.error}>{msg}</p>}
      </div>
    </div>
  )
}
