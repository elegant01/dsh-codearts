import { useEffect, useId, useState } from 'react'
import { Button, Checkbox, Input, SegmentedTabs, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CodeArtsDoctorReport,
  CodeArtsWebStatus,
  CodeArtsWebUsage,
  CodeArtsCreditSnapshot,
  CodeArtsWelfareState,
} from '../web-status.ts'
import { stripModelSuffixes } from '../catalog.ts'
import { setSidebarPanelWanted } from './panel-switch.ts'
import { latencyP95Label } from './latency-label.ts'
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
  /** 支持图片输入（挂「识图」Tag；纯文本模型缺省）。 */
  supportsImages?: boolean
  /** 上游今天判定该模型不可用的原因（挂「异常」Tag，悬浮显示）。 */
  error?: string
  /** 上游返回的上下文窗口；undefined 表示没返回（后端那个 32768 是兜底值，不能当真）。 */
  contextWindow?: number
  /** 上游返回的最大输出 token。 */
  maxTokens?: number
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

/** 浮层里的明细数字要精确到个位并带千分位，不用 k/M 缩写。 */
function exactCount(value: number): string {
  return formatCredits(value)
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

type CardTab = 'accounts' | 'models' | 'usage' | 'display'

/** GET/POST /api/codearts/dock 的文档（后端契约见 web-status.ts 的 CodeArtsDockFlags）。 */
interface DockDoc {
  dock?: {
    credits: boolean
    queue: boolean
    sidebar?: boolean
    modelDetail?: boolean
    autoClaim?: boolean
    keepAliveDaemon?: boolean
  }
  writable?: boolean
}

/**
 * 开关的兜底值：后端没这条路由（老版本）时按「都显示」渲染，与原有行为一致。
 * 侧边栏那一格相反 —— 缺省关闭；自动领取与常驻保活也缺省关（不替用户动余额、
 * 不替用户在系统里留后台进程）。
 */
const DOCK_DEFAULT = {
  credits: true,
  queue: true,
  sidebar: false,
  modelDetail: true,
  autoClaim: false,
  keepAliveDaemon: false,
}

/**
 * 上一次读到的状态。`/api/codearts/status` 会顺带去上游拉积分（有 TTL 缓存），
 * 冷的时候要等近一秒；模块级留一份快照，再进这一页就能立刻按旧值画出来，
 * 后台再刷新 —— 比每次都先闪骨架舒服，也不会把「还没读到」误判成未登录。
 */
let lastStatusSnapshot: LocalStatus | null = null

/**
 * 实测结果也要跨挂载保留：一次实测要真发一次请求、等上游回话，用户切到别的
 * 页再回来就清空，等于逼他重测。模块级存一份，进程内不丢。
 */
type ModelTestResult = { ok: boolean; message: string; ms?: number }
const lastTestResults: Record<string, ModelTestResult> = {}

/**
 * 上下文窗口这类数字不适合印全值（1048576 比 1M 难读），按 K/M 取整。
 *
 * undefined 表示上游没给 —— 此时后端下发的 32768 是兜底值，不能当成真的印出来。
 */
function formatWindow(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '—'
  if (tokens >= 1_048_576) return `${Math.round(tokens / 1_048_576)}M`
  if (tokens >= 1_024) return `${Math.round(tokens / 1_024)}K`
  return String(tokens)
}

/** 体检里一条检查的标题。账号级检查按 id 找回备注名，别让用户对着哈希猜。 */
function doctorCheckLabel(
  id: string,
  accounts: readonly { id: string; label?: string; userName?: string }[],
  t: CodeArtsPluginCardInjected['t'],
): string {
  if (id.startsWith('account:')) {
    const accountId = id.slice('account:'.length)
    const account = accounts.find(entry => entry.id === accountId)
    const name = account?.label?.trim() || account?.userName?.trim() || accountId
    return `${t('doctorCheckAccount')} ${name}`
  }
  switch (id) {
    case 'runtime': return t('doctorCheckRuntime')
    case 'accounts': return t('doctorCheckAccounts')
    case 'models': return t('doctorCheckModels')
    case 'usage': return t('doctorCheckUsage')
    case 'pi-ai': return t('doctorCheckPiAi')
    default: return id
  }
}

/** 体检的 hints 是稳定 id（见 web-status.ts 的 doctorReport），这里翻成人话。 */
function doctorHintText(id: string, t: CodeArtsPluginCardInjected['t']): string {
  switch (id) {
    case 'no-account': return t('doctorHintNoAccount')
    case 'account-stale': return t('doctorHintAccountStale')
    case 'account-no-key': return t('doctorHintAccountNoKey')
    case 'account-expired': return t('doctorHintAccountExpired')
    case 'empty-catalog': return t('doctorHintEmptyCatalog')
    case 'usage-missing': return t('doctorHintUsageMissing')
    case 'dsh-home-missing': return t('doctorHintDshHome')
    case 'pi-ai': return t('doctorHintPiAi')
    default: return t('doctorHintOther', { id })
  }
}

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
 * 缓存命中率：缓存输入 / 全部输入，钳在 0~100。
 *
 * 上游没给缓存字段、或今天压根没有输入时返回 undefined —— 统计块里显示「—」，
 * 不要把「没有数据」写成「0%」。
 */
function hitPercentOf(totals: CodeArtsWebUsage['today']): number | undefined {
  const cached = totals.cachedTokens ?? 0
  if (cached <= 0 || totals.promptTokens <= 0) return undefined
  return Math.min(100, Math.round((cached / totals.promptTokens) * 100))
}

/**
 * 悬停明细卡的正文：标题（账号 / 模型 / 日期 / 钟点）+ 输入 / 输出 / 思考 / 缓存 /
 * 请求 / 命中率。用量条和热力图格子共用这一份，改文案或加字段只需动这里。
 */
function UsageTipBody({
  label,
  totals,
  t,
}: {
  label: string
  totals: CodeArtsWebUsage['today']
  t: CodeArtsPluginCardInjected['t']
}): React.ReactElement {
  const cached = totals.cachedTokens
  const pct = hitPercentOf(totals)
  return (
    <>
      <div className={styles.usageTipName}>{label}</div>
      <div className={styles.usageTipSep} />
      <div className={styles.usageTipRow}>
        <span>{t('usageTipInput')}</span><span>{exactCount(totals.promptTokens)}</span>
      </div>
      <div className={styles.usageTipRow}>
        <span>{t('usageTipOutput')}</span><span>{exactCount(totals.completionTokens)}</span>
      </div>
      {(totals.reasoningTokens ?? 0) > 0 && (
        <div className={styles.usageTipRow}>
          <span>{t('usageTipReasoning')}</span><span>{exactCount(totals.reasoningTokens ?? 0)}</span>
        </div>
      )}
      <div className={styles.usageTipRow}>
        <span>{t('usageTipCached')}</span>
        <span>{cached === undefined ? t('usageTipNoCache') : exactCount(cached)}</span>
      </div>
      <div className={styles.usageTipSep} />
      <div className={styles.usageTipRow}>
        <span>{t('usageTipRequests')}</span>
        <span>{t('usageRequestCount', { n: formatCount(totals.requests) })}</span>
      </div>
      {pct !== undefined && (
        <div className={styles.usageTipRow}>
          <span>{t('usageTipHit')}</span><span>{pct}%</span>
        </div>
      )}
    </>
  )
}

/**
 * 悬停卡贴着指针画：热力图格子只有 36px 宽，卡片锚在格子上会横穿整张卡片，
 * 所以和 agent-acta 一样用 fixed + 指针坐标，靠近右下边界时翻到另一侧。
 */
function tipPointStyle(point: { x: number; y: number }): React.CSSProperties {
  const width = 230
  const height = 190
  const viewWidth = typeof window === 'undefined' ? 0 : window.innerWidth
  const viewHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const left = viewWidth > 0 && point.x + 16 + width > viewWidth ? point.x - 16 - width : point.x + 16
  const top = viewHeight > 0 && point.y + 16 + height > viewHeight ? point.y - 16 - height : point.y + 16
  return { left: Math.max(8, left), top: Math.max(8, top) }
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
  /** 当前悬停的那一行；卡片浮层只在它上面出现。 */
  const [hovered, setHovered] = useState<string | null>(null)
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
        const totals = row.totals
        const detail = [
          t('usageRequests', { n: formatCount(totals.requests) }),
          t('usageTokens', {
            prompt: formatTokens(totals.promptTokens),
            completion: formatTokens(totals.completionTokens),
          }),
        ].join(' · ')
        return (
          <div
            key={row.id}
            className={styles.modelRow}
            title={`${row.label} · ${detail}`}
            onMouseEnter={() => setHovered(row.id)}
            onMouseLeave={() => setHovered(prev => (prev === row.id ? null : prev))}
          >
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
              {t('usageRequestCount', { n: formatCount(totals.requests) })}
            </span>

            {hovered === row.id && (
              <div className={styles.usageTip} role="tooltip">
                <UsageTipBody label={row.label} totals={totals} t={t} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 一格 token 量在整组里的深浅档：0 是空格，其余按相对最大值分 5 档。 */
function toneOf(volume: number, max: number): string {
  if (volume <= 0 || max <= 0) return 'empty'
  const ratio = volume / max
  if (ratio < 0.15) return 'lv1'
  if (ratio < 0.35) return 'lv2'
  if (ratio < 0.6) return 'lv3'
  if (ratio < 0.85) return 'lv4'
  return 'lv5'
}

/** 「YYYY-MM-DD」是本地日历日，不能丢给 `new Date(string)`（会被当成 UTC）。返回周一=0…周日=6。 */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return (new Date(year, month - 1, day).getDay() + 6) % 7
}

/**
 * 当月的每日热力图：7 列是周一到周日，格子里的数字是「几号」，底色深浅是那天的 token 量。
 *
 * 画整月而不是「最近 N 天」：日历是熟人界面，缺的格子一眼就知道是「还没到」还是「没用量」；
 * 颜色用 agent-acta 那套绿阶。精确数字（输入 / 缓存 / 命中率 / 条数）全放进悬停提示。
 */
function UsageHeat({
  days,
  t,
}: {
  days: readonly { date: string; totals: CodeArtsWebUsage['today'] }[]
  t: CodeArtsPluginCardInjected['t']
}): React.ReactElement {
  const [hovered, setHovered] = useState<string | null>(null)
  /** 指针离开格子就清掉，卡片跟着指针停在那一次进入的位置。 */
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const last = days.at(-1)
  const month = last?.date.slice(0, 7) ?? ''
  const inMonth = days.filter(day => day.date.startsWith(month))
  const max = inMonth.reduce((peak, day) => Math.max(peak, day.totals.totalTokens), 0)
  const [year, monthNo] = month.split('-').map(Number) as [number, number]
  const span = month === '' ? [] : Array.from({ length: new Date(year, monthNo, 0).getDate() }, (_, index) => {
    const day = index + 1
    const date = `${month}-${String(day).padStart(2, '0')}`
    const found = inMonth.find(entry => entry.date === date)
    return { date, day, totals: found?.totals, future: last !== undefined && date > last.date }
  })
  // 1 号要落在它自己的星期列上，前面补透明格。
  const offset = month === '' ? 0 : weekdayOf(`${month}-01`)
  const shown = span.find(entry => entry.date === hovered)
  return (
    <>
      <div className={styles.heatLegend}>
        <span>{t('usageHeatLess')}</span>
        {['lv1', 'lv2', 'lv3', 'lv4', 'lv5'].map(tone => (
          <span key={tone} className={styles.heatLegendChip} data-tone={tone} />
        ))}
        <span>{t('usageHeatMore')}</span>
      </div>
      <div className={styles.heatGrid}>
        {t('usageHeatWeekdays').split(' ').map(label => (
          <span key={label} className={styles.heatWeekday}>
            {label}
          </span>
        ))}
        {Array.from({ length: offset }, (_, index) => (
          <span key={`pad-${String(index)}`} className={styles.heatCell} data-tone="pad" />
        ))}
        {span.map(entry => {
          // 未来的日子只留日期；本月里已经过去却没有记录的日子是浅底空格，不参与深浅编码。
          const tone = entry.future
            ? 'out'
            : entry.totals === undefined
              ? 'empty'
              : toneOf(entry.totals.totalTokens, max)
          return (
            <span
              key={entry.date}
              className={styles.heatCell}
              data-tone={tone}
              data-today={entry.date === last?.date ? 'true' : undefined}
              onMouseEnter={entry.totals === undefined ? undefined : event => {
                setHovered(entry.date)
                setPoint({ x: event.clientX, y: event.clientY })
              }}
              onMouseLeave={entry.totals === undefined ? undefined : () => {
                setHovered(null)
              }}
            >
              {entry.day}
            </span>
          )
        })}
      </div>
      {shown?.totals !== undefined && point !== null && (
        <div
          className={styles.usageTip}
          data-float="true"
          role="tooltip"
          style={tipPointStyle(point)}
        >
          <UsageTipBody label={shown.date} totals={shown.totals} t={t} />
        </div>
      )}
      <p className={styles.trendTip}>{t('usageTrendHint')}</p>
    </>
  )
}

/**
 * 今天逐小时：一行 24 格，深浅同样是相对最大值的档位，轴标签每 6 格画一个。
 *
 * 只在有真实小时桶时画 —— 功能上线前的小时没有回填，全画成空格会被误读成「跑了但没用量」。
 */
function UsageHours({
  hours,
  t,
}: {
  hours: readonly { hour: number; totals: CodeArtsWebUsage['today'] }[]
  t: CodeArtsPluginCardInjected['t']
}): React.ReactElement {
  const [hovered, setHovered] = useState<number | null>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const max = hours.reduce((peak, hour) => Math.max(peak, hour.totals.totalTokens), 0)
  const shown = hovered === null ? undefined : hours.find(entry => entry.hour === hovered)
  return (
    <>
      <div className={styles.heatHours}>
        {hours.map(entry => (
          <span
            key={entry.hour}
            className={styles.heatHourCell}
            data-tone={toneOf(entry.totals.totalTokens, max)}
            onMouseEnter={event => {
              setHovered(entry.hour)
              setPoint({ x: event.clientX, y: event.clientY })
            }}
            onMouseLeave={() => {
              setHovered(null)
            }}
          />
        ))}
      </div>
      <div className={styles.heatAxis}>
        {hours.map(entry => (
          <span key={entry.hour} className={styles.heatAxisSlot}>
            {entry.hour % 6 === 0 ? entry.hour : ''}
          </span>
        ))}
      </div>
      {shown !== undefined && point !== null && (
        <div
          className={styles.usageTip}
          data-float="true"
          role="tooltip"
          style={tipPointStyle(point)}
        >
          <UsageTipBody
            label={`${String(shown.hour).padStart(2, '0')}:00`}
            totals={shown.totals}
            t={t}
          />
        </div>
      )}
      <p className={styles.trendTip}>{t('usageTrendHint')}</p>
    </>
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
  const today = usage.today
  // 失败率的分母是「进了 shim 的请求」，不是上游收到的请求 —— 排队/换号失败也该算。
  const failures = usage.failuresToday ?? { total: 0, byKind: {} }
  // 「一次都没成功、但一直在失败」也要能看到失败率，不能因为 requests=0 就整段空着。
  const hasUsage = usage.allTime.requests > 0 || today.requests > 0 || failures.total > 0
  const hit = hitPercentOf(today)
  const attempts = today.requests + failures.total
  const failRate = attempts > 0 ? Math.round((failures.total / attempts) * 100) : undefined
  const latency = usage.latencyToday ?? { samples: 0, overflow: false }
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{t('usageTitle')}</span>
        <span className={styles.count}>
          {t('usageRange', {
            today: formatCount(today.requests),
            last30: formatCount(usage.last30.requests),
          })}
        </span>
      </div>

      {!hasUsage ? (
        <p className={styles.hint}>{t('usageEmpty')}</p>
      ) : (
        <>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('usageStatTokens')}</span>
              <span className={styles.statValue}>{formatTokens(today.totalTokens)}</span>
              <span className={styles.statSub}>
                {t('usageStatIn', { n: formatTokens(today.promptTokens) })}
                {/* 思考 token 是输出的子集：不进列里占宽度，挂在这里。 */}
                {(today.reasoningTokens ?? 0) > 0
                  ? ` · ${t('usageStatThinking', { n: formatTokens(today.reasoningTokens ?? 0) })}`
                  : ''}
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('usageStatHit')}</span>
              <span className={styles.statValue}>{hit === undefined ? '—' : `${hit}%`}</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('usageStatRequests')}</span>
              <span className={styles.statValue}>{formatCount(today.requests)}</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('usageStatFailures')}</span>
              <span className={styles.statValue}>{failRate === undefined ? '—' : `${failRate}%`}</span>
              <span className={styles.statSub}>
                {t('usageStatFailureCount', { n: formatCount(failures.total) })}
              </span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('usageStatLatency')}</span>
              <span className={styles.statValue}>{latencyP95Label(latency)}</span>
              <span className={styles.statSub}>
                {latency.p50 === undefined
                  ? t('usageStatLatencyEmpty')
                  : t('usageStatLatencyDetail', { p50: formatCount(latency.p50), n: formatCount(latency.samples) })}
              </span>
            </div>
          </div>

          {(usage.recentDays ?? []).length > 0 && (
            <>
              <p className={styles.hint}>{t('usageTrendWeek')}</p>
              <UsageHeat days={usage.recentDays ?? []} t={t} />
            </>
          )}
          {(usage.todayByHour ?? []).length > 0 && (
            <>
              <p className={styles.hint}>{t('usageTrendHour')}</p>
              {/* 逐小时是这次才有的口径：启用前的小时没有回填，别画成「跑了但没用量」。 */}
              {(usage.todayByHour ?? []).some(entry => entry.totals.requests > 0) ? (
                <UsageHours hours={usage.todayByHour ?? []} t={t} />
              ) : (
                <p className={styles.trendTip}>{t('usageTrendHourEmpty')}</p>
              )}
            </>
          )}

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

export function CodeArtsPluginCard({ t }: CodeArtsPluginCardInjected): React.ReactElement {
  const [status, setStatus] = useState<LocalStatus | null>(lastStatusSnapshot)
  const [token, setToken] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [loginPending, setLoginPending] = useState(false)
  /** 正在进行的是哪个账号的「重新登录」（无则 null）。用来只让那一行的按钮变「登录中」。 */
  const [reloginId, setReloginId] = useState<string | null>(null)
  const [selection, setSelection] = useState<ModelSelectionDoc['selection'] | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [savingModels, setSavingModels] = useState(false)
  const [savedModels, setSavedModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  /** 正在实测的模型 id；同一时间只测一个，避免把上游并发槽位占满。 */
  const [testingId, setTestingId] = useState<string | null>(null)
  /** 逐模型的测试结果（通过/失败 + 原因）。 */
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>(() => ({ ...lastTestResults }))
  /** 正在提交 paused/pinned 的账号 id。 */
  const [flagBusy, setFlagBusy] = useState<string | null>(null)
  const [doctor, setDoctor] = useState<CodeArtsDoctorReport | null>(null)
  const [doctorBusy, setDoctorBusy] = useState(false)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  /** 正在领取的账号 id；批量领取时是 CLAIM_ALL。null 表示没有在飞。 */
  const [claimingId, setClaimingId] = useState<string | null>(null)
  /** 逐账号的领取结果文案。 */
  const [claimResults, setClaimResults] = useState<Record<string, string>>({})
  /** 这次会话里刚领成的账号（快照刷新前先把按钮改成「今日已领」）。 */
  const [claimedIds, setClaimedIds] = useState<Record<string, true>>({})
  const [manualOpen, setManualOpen] = useState(false)
  const [tab, setTab] = useState<CardTab>('accounts')
  const tabIdBase = useId()
  /** 对话底部那一行的两个显隐开关（后端 = 插件 settings 里的两个布尔）。 */
  const [dock, setDock] = useState(DOCK_DEFAULT)
  const [dockWritable, setDockWritable] = useState(false)
  const [dockSaving, setDockSaving] = useState(false)
  const [dockError, setDockError] = useState<string | null>(null)
  /** 「结束守护进程」按钮在飞，防止连点。 */
  const [keeperStopping, setKeeperStopping] = useState(false)
  /** 结束按钮的结果/失败原因（成功也留一句，让用户知道进程真没了）。 */
  const [keeperNotice, setKeeperNotice] = useState<string | null>(null)
  /**
   * 首次读取状态的三态。为什么要单独记：`status === null` 只说明「还没读到」，
   * 直接按它画就会先闪一下「未登录」，等数据回来再翻成「已登录」—— 看起来像
   * 掉线又自己好了。只有服务端明确回 signed-out 才允许画登录框。
   */
  const [statusPhase, setStatusPhase] = useState<'loading' | 'ready' | 'failed'>(
    lastStatusSnapshot === null ? 'loading' : 'ready',
  )
  const [loadError, setLoadError] = useState<string | null>(null)

  async function refreshDock(): Promise<void> {
    try {
      const res = await fetch('/api/codearts/dock', { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      const data = (await res.json()) as DockDoc
      if (data.dock !== undefined) {
        // 老后端只回 credits/queue：缺的键用兜底值补齐，别把 undefined 塞进 state。
        const next = { ...DOCK_DEFAULT, ...data.dock }
        setDock(next)
        setSidebarPanelWanted(next.sidebar)
      }
      setDockWritable(data.writable === true)
    } catch {
      // 老后端没这条路由：保持默认（都显示 / 侧边栏关闭），勾选框置灰，别把整张卡片报成出错。
    }
  }

  /**
   * 改一个开关：先按新值渲染，写失败再退回去。
   *
   * 这里不像模型勾选那样攒草稿再点保存 —— 只有几个布尔，攒草稿反而让用户猜
   * 「我刚才那一下到底生效没有」。
   */
  async function toggleDock(
    key: 'credits' | 'queue' | 'sidebar' | 'modelDetail' | 'autoClaim' | 'keepAliveDaemon',
    on: boolean,
  ): Promise<void> {
    const previous = dock
    setDock({ ...dock, [key]: on })
    setDockSaving(true)
    setDockError(null)
    // 侧边栏开关要立刻反映到导航行上，不等 POST 回来（乐观更新，失败再退回去）。
    if (key === 'sidebar') setSidebarPanelWanted(on)
    try {
      const res = await fetch('/api/codearts/dock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [key]: on }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
      }
      const data = (await res.json()) as DockDoc
      if (data.dock !== undefined) {
        const next = { ...DOCK_DEFAULT, ...data.dock }
        setDock(next)
        setSidebarPanelWanted(next.sidebar)
      }
    } catch (error: unknown) {
      setDock(previous)
      if (key === 'sidebar') setSidebarPanelWanted(previous.sidebar)
      setDockError(error instanceof Error ? error.message : String(error))
    } finally {
      setDockSaving(false)
    }
  }

  /**
   * 结束守护进程。
   *
   * 服务端在kill之后**顺手把开关写成 false**（见 web-status.ts 的 keeperStopHandler）：
   * 只杀进程不改开关会留下「开关开着却没进程」的矛盾状态，插件下次启动还会把它拉起来。
   * 这里拿响应里的 `dock` 直接覆盖本地状态，不等下一轮 refreshDock —— 否则按钮点完
   * 界面上开关还亮着，用户会以为没生效。
   */
  async function stopKeeper(): Promise<void> {
    setKeeperStopping(true)
    setKeeperNotice(null)
    try {
      const res = await fetch('/api/codearts/keeper/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        reason?: string
        dock?: DockDoc['dock']
        error?: string
      }
      if (data.dock !== undefined) setDock({ ...DOCK_DEFAULT, ...data.dock })
      if (!res.ok || data.ok === false) {
        setKeeperNotice(t('displayKeeperStopFailed', { message: data.reason ?? data.error ?? `HTTP ${res.status}` }))
      } else {
        setKeeperNotice(t('displayKeeperStopped'))
      }
    } catch (error: unknown) {
      setKeeperNotice(t('displayKeeperStopFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setKeeperStopping(false)
      // 无论成败都再读一次真相：状态页可能已经因为「进程没了」把开关关了。
      await Promise.all([refreshDock(), refresh()])
    }
  }

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as LocalStatus
      lastStatusSnapshot = data
      setStatus(data)
      setLoadError(null)
      setStatusPhase('ready')
    } catch (error: unknown) {
      // 拉不到 ≠ 没登录。首次失败停在「重试」页，已经读到过数据就静默保留旧值。
      setLoadError(error instanceof Error ? error.message : String(error))
      setStatusPhase(phase => (phase === 'ready' ? 'ready' : 'failed'))
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
    void refreshDock()
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

  /**
   * 改一个账号的 paused/pinned 标记。
   *
   * 暂停 ≠ 删除：凭证还在，只是不参与轮转（比如这个号今天额度用完了，但明天还要用）。
   * 置顶改变的是 pick() 的优先级，不是顺序本身 —— 取消置顶就回到「最久未用优先」。
   */
  async function setAccountFlag(id: string, patch: { paused?: boolean; pinned?: boolean }): Promise<void> {
    setFlagBusy(id)
    setMsg(null)
    try {
      const res = await fetch('/api/codearts/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setFlagBusy(null)
    }
  }

  /** 点「体检」拉一次本机报告；只读，不改任何状态。 */
  async function runDoctor(): Promise<void> {
    setDoctorBusy(true)
    setDoctorError(null)
    try {
      const res = await fetch('/api/codearts/doctor', { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setDoctor((await res.json()) as CodeArtsDoctorReport)
    } catch (err) {
      setDoctorError(err instanceof Error ? err.message : String(err))
    } finally {
      setDoctorBusy(false)
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
   * 实测某个模型现在能不能调用。
   *
   * 上游的清单会列出调不动的模型（81003.401），刷新救不了；只有真发一次最小请求
   * 才知道。测试成功会清掉后端记的「异常」标记，所以结束后重拉一次 selection。
   */
  function recordTest(id: string, result: ModelTestResult): void {
    // 模块级缓存与组件 state 同步写：切换页签/重开卡片时不至于把结果丢掉。
    lastTestResults[id] = result
    setTestResults(current => ({ ...current, [id]: result }))
  }

  async function testModel(id: string): Promise<void> {
    setTestingId(id)
    delete lastTestResults[id]
    setTestResults(current => {
      const next = { ...current }
      delete next[id]
      return next
    })
    try {
      const res = await fetch('/api/codearts/test-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; ms?: number } | null
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`)
      recordTest(id, { ok: data?.ok === true, message: data?.message ?? '', ms: data?.ms })
      await refreshSelection()
    } catch (err) {
      recordTest(id, { ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTestingId(null)
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

  /**
   * 开始一次浏览器登录。
   *
   * 不带 `targetId` 是「添加账号」；带 `targetId` 是「重新登录这个账号」——
   * 服务端会把新凭证写回原条目（保留顺序与备注），而不是又长出一条。
   */
  async function startOAuthLogin(targetId?: string): Promise<void> {
    setBusy(true)
    setMsg(null)
    setLoginPending(true)
    if (targetId !== undefined) setReloginId(targetId)
    const finish = (): void => {
      setLoginUrl(null)
      setLoginPending(false)
      setReloginId(null)
    }
    try {
      const query = targetId === undefined ? '' : `?account=${encodeURIComponent(targetId)}`
      const res = await fetch(`/api/codearts/login${query}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data.url !== 'string') {
        setMsg(data.error ?? `HTTP ${res.status}`)
        finish()
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
        const st = await r.json().catch(() => ({ status: 'pending' })) as {
          status?: string
          replaced?: boolean
          conflict?: boolean
        }
        if (st.status === 'done') {
          finish()
          // 点了「重新登录」却登了另一个号：已作为新账号添加，原账号没动。
          if (st.conflict === true) setMsg(t('reloginOtherAccount'))
          await refresh()
          return
        }
        if (st.status === 'error') {
          finish()
          setMsg(t('loginFailed'))
          return
        }
        // 服务端已经不认识这个会话：登录完成/超时/插件重载都会走到这。继续空转
        // 按钮就会永远停在「登录中」——把 idle 也当终止态，刷新一次让卡片反映
        // 真实结果（加上就是多一个账号，没加上就是没变）。
        if (st.status === 'idle') {
          finish()
          await refresh()
          return
        }
        setTimeout(() => void poll(), 1500)
      }
      void poll()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
      finish()
    } finally {
      setBusy(false)
    }
  }

  const signedIn = status?.status === 'signed-in'
  const expired = status?.status === 'expired'
  /** 首次数据还没回来：标题栏说「加载中」，正文放骨架，别画登录框。 */
  const loading = statusPhase === 'loading'
  /** 连状态都读不到（服务没起 / 路由 404）：给错误和重试，不要假装没登录。 */
  const failed = statusPhase === 'failed' && status === null
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
  const dotState: StateDotState = !loading && signedIn ? 'done' : !loading && expired ? 'warning' : 'idle'
  const statusText = loading
    ? t('statusLoading')
    : failed
      ? t('statusUnavailable')
      : signedIn ? t('statusSignedIn') : expired ? t('statusExpired') : t('statusSignedOut')
  /** 读不到状态时别在下面写「去登录」—— 用户可能已经登录了，只是接口没起来。 */
  const descText = loading ? t('descLoading') : failed ? null : signedIn ? t('descSignedIn') : t('descSignedOut')
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
    display: {
      value: 'display',
      label: t('tabDisplay'),
      id: tabId('display'),
      panelId: panelId('display'),
    },
  }
  // 登录中至少有账号、模型和显示三页；用量没数据时整页不出现，别给空 Tab。
  const tabs: [SegmentedTab<CardTab>, ...SegmentedTab<CardTab>[]] = [
    tabItems.accounts,
    tabItems.models,
    ...(usageAvailable ? [tabItems.usage] : []),
    tabItems.display,
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
          {descText !== null && <span className={styles.desc}>{descText}</span>}
        </div>
        <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </div>

      <div className={styles.body}>
        {status?.piAiError !== undefined && <p className={styles.error}>{status.piAiError}</p>}
        {failed ? (
          <div className={styles.section}>
            <p className={styles.error}>{t('loadFailed', { message: loadError ?? '' })}</p>
            <div className={styles.actions}>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
                {t('retry')}
              </Button>
            </div>
          </div>
        ) : loading ? (
          <div className={styles.skeleton} aria-busy="true" aria-label={t('statusLoading')}>
            <span className={styles.skeletonRow} />
            <span className={styles.skeletonRow} />
            <span className={styles.skeletonRow} />
          </div>
        ) : signedIn ? (
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
                              {account.paused && <Tag>{t('accountPaused')}</Tag>}
                              {account.pinned && <Tag tone="success">{t('accountPinned')}</Tag>}
                              {account.stale && <Tag>{t('accountNeedsSignIn')}</Tag>}
                              {!account.signable && <Tag>{t('accountNoKey')}</Tag>}
                            </span>
                            {accountLine !== '' && <span className={styles.meta}>{accountLine}</span>}
                            <span className={styles.meta}>
                              {t('accountToday', {
                                n: formatCount(status?.usage?.byAccountToday[account.id]?.requests ?? 0),
                                failed: formatCount(status?.usage?.failuresByAccountToday?.[account.id] ?? 0),
                              })}
                            </span>
                          </div>
                          <div className={styles.accountRowActions}>
                            {/*
                              启用 = 参与轮转。关掉就是暂停：凭证留着，不删号也不用
                              重新登录 —— 以前这里是一个「暂停/恢复」按钮，状态要靠
                              按钮文案反推；换成开关后，开着的就是能接活的号。
                            */}
                            <span className={styles.accountToggle}>
                              <span className={styles.accountToggleLabel}>{t('accountEnabled')}</span>
                              <Switch
                                checked={!account.paused}
                                disabled={busy || loginPending || flagBusy === account.id}
                                label={`${accountName(account)} ${t('accountEnabled')}`}
                                onChange={next => void setAccountFlag(account.id, { paused: !next })}
                              />
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || loginPending || flagBusy === account.id}
                              onClick={() => void setAccountFlag(account.id, { pinned: !account.pinned })}
                            >
                              {account.pinned ? t('accountUnpin') : t('accountPin')}
                            </Button>
                            {/*
                              「重新登录」把新凭证写回这一条：以前只有删除，凭证一过期
                              就只能删掉再加回来，顺序和备注全丢。
                            */}
                            <Button
                              variant={account.stale ? 'primary' : 'outline'}
                              size="sm"
                              disabled={busy || loginPending}
                              onClick={() => void startOAuthLogin(account.id)}
                            >
                              {reloginId === account.id && loginPending
                                ? t('reloginPending')
                                : t('accountRelogin')}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className={styles.danger}
                              disabled={busy || loginPending}
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
                    {(selection.choices ?? []).map(choice => {
                      const result = testResults[choice.id]
                      return (
                        <div key={choice.id} className={styles.choiceRow}>
                          <Checkbox
                            className={styles.check}
                            checked={draft.includes(choice.id)}
                            disabled={!selection.writable || savingModels}
                            onChange={(on) => setModel(choice.id, on)}
                            label={modelName(choice)}
                          />
                          {/*
                            上下文窗口体现「这个模型能不能装下整份代码」。上游 agent 来源
                            确实返回值；builtin 来源没有，后端会兜底成 32768 并置
                            contextWindow=undefined，这里就显示「—」而不是假的 32K。
                          */}
                          <span
                            className={styles.modelSpec}
                            title={t('modelSpecTitle', {
                              context: choice.contextWindow === undefined ? '?' : formatCount(choice.contextWindow),
                              output: choice.maxTokens === undefined ? '?' : formatCount(choice.maxTokens),
                            })}
                          >
                            {t('modelSpec', {
                              context: formatWindow(choice.contextWindow),
                              output: formatWindow(choice.maxTokens),
                            })}
                          </span>
                          {choice.benefit === true && (
                            <Tag tone={choice.blocked === true ? 'warning' : 'success'}>
                              {choice.blocked === true ? t('benefitBlocked') : t('benefit')}
                            </Tag>
                          )}
                          {choice.error !== undefined && (
                            <span title={choice.error} style={{ cursor: 'help' }}>
                              <Tag tone="warning">{t('modelError')}</Tag>
                            </span>
                          )}
                          {choice.ratio !== undefined && <Tag tone="quiet">{choice.ratio}</Tag>}
                          {choice.supportsImages === true && <Tag tone="quiet">{t('modelImages')}</Tag>}
                          {draft.includes(choice.id) && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={testingId !== null}
                              onClick={() => void testModel(choice.id)}
                            >
                              {testingId === choice.id ? t('testingModel') : t('testModel')}
                            </Button>
                          )}
                          {result !== undefined && (
                            <span title={result.ms === undefined ? result.message : `${result.message}（${result.ms} ms）`}>
                              <Tag tone={result.ok ? 'success' : 'warning'}>{result.ok ? t('testOk') : t('testFailed')}</Tag>
                            </span>
                          )}
                        </div>
                      )
                    })}
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

            <TabPanel
              id={panelId('display')}
              labelledBy={tabId('display')}
              active={activeTab === 'display'}
            >
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{t('displayTitle')}</span>
                </div>
                <p className={styles.hint}>{t('displayHint')}</p>
                <div className={styles.choices}>
                  <div className={styles.choiceRow}>
                    <Checkbox
                      className={styles.check}
                      checked={dock.credits}
                      disabled={!dockWritable || dockSaving}
                      onChange={on => void toggleDock('credits', on)}
                      label={t('displayCreditsToggle')}
                    />
                  </div>
                  <div className={styles.choiceRow}>
                    <Checkbox
                      className={styles.check}
                      checked={dock.queue}
                      disabled={!dockWritable || dockSaving}
                      onChange={on => void toggleDock('queue', on)}
                      label={t('displayQueueToggle')}
                    />
                  </div>
                  {/*
                    「Model 及其右侧」：只收模型名、倍率、排队这三段。`Provider CodeArts`
                    是插件的身份标识，永远显示 —— 关掉之后那一行是
                    `积分 24,091 · Provider CodeArts`。
                  */}
                  <div className={styles.choiceRow}>
                    <Checkbox
                      className={styles.check}
                      checked={dock.modelDetail}
                      disabled={!dockWritable || dockSaving}
                      onChange={on => void toggleDock('modelDetail', on)}
                      label={t('displayModelDetailToggle')}
                    />
                  </div>
                </div>
                {!dockWritable && <p className={styles.hint}>{t('displayNotWritable')}</p>}
                {dockError !== null && <p className={styles.error}>{t('displayFailed', { message: dockError })}</p>}
              </div>

              {/*
                自动领取单独一段：它不是「显不显示」，而是在后台动账号余额，所以要有
                自己的说明（什么时候跑、失败怎么退避），并且默认关闭。
              */}
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{t('displayAutoClaimTitle')}</span>
                </div>
                <p className={styles.hint}>{t('displayAutoClaimHint')}</p>
                <div className={styles.choices}>
                  <div className={styles.choiceRow}>
                    <Checkbox
                      className={styles.check}
                      checked={dock.autoClaim}
                      disabled={!dockWritable || dockSaving}
                      onChange={on => void toggleDock('autoClaim', on)}
                      label={t('displayAutoClaimToggle')}
                    />
                  </div>
                </div>
              </div>

              {/*
                常驻保活：在 DSH 之外起一个后台进程续 refresh_token。
                和上面几段不同，这一段要显示**进程号**和**结束**按钮 —— 用户必须能确认
                「它真的在跑」，也必须能亲手停掉一个不经他同意就在系统里活着的进程。
              */}
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{t('displayKeeperTitle')}</span>
                  {/*
                    结束按钮只在「开关开着」时出现：开关关着就说明本来不该有进程，
                    再给一个结束按钮反而让人以为有东西在跑。开关开着却没探到活进程
                    （被 kill 了/启动失败）时也显示 —— 那时正需要点一下把状态清干净。
                  */}
                  {dock.keepAliveDaemon && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={keeperStopping}
                      onClick={() => void stopKeeper()}
                    >
                      {keeperStopping ? t('displayKeeperStopping') : t('displayKeeperStop')}
                    </Button>
                  )}
                </div>
                <p className={styles.hint}>{t('displayKeeperHint')}</p>
                <div className={styles.choices}>
                  <div className={styles.choiceRow}>
                    <Checkbox
                      className={styles.check}
                      checked={dock.keepAliveDaemon}
                      disabled={!dockWritable || dockSaving}
                      onChange={on => void toggleDock('keepAliveDaemon', on)}
                      label={t('displayKeeperToggle')}
                    />
                  </div>
                </div>
                {/* 进程状态：活着的给 pid 与心跳，没活的把原因讲清楚，别只是留一个空标签。 */}
                {dock.keepAliveDaemon && (
                  <p className={styles.hint}>
                    {status?.keeper?.alive === true
                      ? t('displayKeeperRunning', {
                        pid: status.keeper.pid ?? '?',
                        time: formatStored(status.keeper.heartbeatAt),
                      })
                      : status?.keeper?.starting === true
                        ? t('displayKeeperStarting')
                        : t('displayKeeperDown', { message: status?.keeper?.error ?? '' })}
                  </p>
                )}
                {keeperNotice !== null && <p className={styles.hint}>{keeperNotice}</p>}
                {status?.keeper?.logPath !== undefined && dock.keepAliveDaemon && (
                  <p className={styles.hint}>{t('displayKeeperLog', { path: status.keeper.logPath })}</p>
                )}
              </div>

              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{t('displaySidebarTitle')}</span>
                </div>
                <p className={styles.hint}>{t('displaySidebarHint')}</p>
                <div className={styles.choices}>
                  <div className={styles.choiceRow}>
                    <Checkbox
                      className={styles.check}
                      checked={dock.sidebar}
                      disabled={!dockWritable || dockSaving}
                      onChange={on => void toggleDock('sidebar', on)}
                      label={t('displaySidebarToggle')}
                    />
                  </div>
                </div>
              </div>

              {/* 体检：CLI doctor 的可视化版本，只查本机可判定的东西，不联网。 */}
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{t('doctorTitle')}</span>
                  <Button variant="outline" size="sm" disabled={doctorBusy} onClick={() => void runDoctor()}>
                    {doctorBusy ? t('doctorRunning') : t('doctorRun')}
                  </Button>
                </div>
                <p className={styles.hint}>{t('doctorHint')}</p>
                {doctorError !== null && <p className={styles.error}>{t('doctorFailed', { message: doctorError })}</p>}
                {doctor !== null && (
                  <>
                    <div className={styles.doctorList}>
                      {doctor.checks.map(check => (
                        <div key={check.id} className={styles.doctorRow}>
                          <StateDot state={check.ok ? 'done' : 'warning'} />
                          <span className={styles.doctorName}>{doctorCheckLabel(check.id, accounts, t)}</span>
                          {check.detail !== undefined && <span className={styles.meta}>{check.detail}</span>}
                        </div>
                      ))}
                    </div>
                    {doctor.hints.length > 0 && (
                      <p className={styles.hint}>{doctor.hints.map(id => doctorHintText(id, t)).join('；')}</p>
                    )}
                  </>
                )}
              </div>
            </TabPanel>
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
