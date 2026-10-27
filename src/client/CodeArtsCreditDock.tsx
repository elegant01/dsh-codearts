/**
 * 对话底部的积分条 + 点开后的积分弹层。
 *
 * 用户最初的诉求就是「对话底部要显示积分」—— 这一条挂在
 * `conversation.composer.dock` 槽位上（与宿主 session-stats strip 同位）。
 * 只在当前 provider 是 codearts 时才拉取并显示一行「积分 N」，别的 provider 下
 * 完全不渲染，不抢别人的行。
 *
 * 那一行是个按钮：点开就是逐号明细（多账号下聚合数字本身没意义，得能看出是哪个号）。
 * 显隐由设置卡片「显示」页那两个开关管着，开关值随 `/status` 一起下发 —— 底部条本来
 * 就在轮询它，不必为两个布尔开一条新链路。代价是关掉开关最多要等一个轮询周期（60 秒）
 * 才看得见效果，这个延迟在设置卡片上写明了。
 *
 * 积分数据走插件自己的 `/api/codearts/status`（带 TTL 缓存，见 src/credits.ts），
 * 不会因为这条 dock 让上游多挨一次请求；弹层上那个「刷新积分」是唯一绕缓存的出口。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type MouseEvent } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodeArtsDockFlags, CodeArtsWebStatus } from '../web-status.ts'

/** 与 src/adapter.ts 的 CODEARTS_PROVIDER 对齐 —— client 不能 import host 模块。 */
const CODEARTS_PROVIDER = 'codearts'
const STATUS_PATH = '/api/codearts/status'
const QUEUE_PATH = '/api/codearts/queue'
/** 轮询间隔：与缓存 TTL（60s）对齐，再短也只是反复命中缓存。 */
const REFRESH_INTERVAL_MS = 60_000
/** 排队位置变得快：官方客户端也是 5 秒一次；这是本机路由，打不疼上游。 */
const QUEUE_INTERVAL_MS = 5_000
/** 弹层宽度固定，好算它会不会顶出屏幕右边。 */
const PANEL_WIDTH = 280
/** 弹层与那一行之间的缝隙。 */
const PANEL_GAP = 8
/** 那一行在输入框下方，往上开才够空间；给弹层留的最小高度，不够就翻到下面。 */
const PANEL_MIN_ABOVE = 260

interface QueueEntry {
  model: string
  position: number
  length: number
}

interface ModelSelectionEntry {
  provider?: string
  model?: string
}
interface ModelSelection {
  next?: ModelSelectionEntry
  lastUsed?: ModelSelectionEntry
}

/** 弹层里的一行账号。`remain` 为 null 表示这个号这次没拿到数（原因看 error）。 */
interface CreditRow {
  id: string
  name: string
  remain: number | null
  expiring: number
  /** 这份快照的抓取时刻（上游返回时间，不是本机渲染时间）。 */
  fetchedAt?: number
  error?: string
}

/** 弹层挂在按钮上方还是下方 —— 上面放不下（会话滚到底、窗口很矮）就得往下翻。 */
interface Anchor {
  left: number
  top: number
  above: boolean
}

export interface CodeArtsCreditDockProps {
  /** 宿主注入的 projection 读取面；省略时 dock 不显示。 */
  useProjection?: (key: string) => unknown
  /** locale 翻译函数。 */
  t: (key: string, params?: Record<string, unknown>) => string
}

function readSelection(useProjection: ((key: string) => unknown) | undefined): ModelSelection | undefined {
  if (useProjection === undefined) return undefined
  try {
    return useProjection('modelSelection') as ModelSelection | undefined
  } catch {
    return undefined
  }
}

function isCodeArts(selection: ModelSelection | undefined): boolean {
  const current = selection?.next ?? selection?.lastUsed
  return current?.provider === CODEARTS_PROVIDER
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value))
}

function formatClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** 账号名与设置卡片同一套取法：备注 > 用户名 > id。 */
function accountName(account: { id: string; label?: string; userName?: string }): string {
  return account.label?.trim() || account.userName?.trim() || account.id
}

/**
 * 逐号明细。
 *
 * 老后端只有聚合的一份 `credits`，那时单账号就退回它 —— 别因为后端没升级就把
 * 弹层弹成一句「没有数据」。
 */
function rowsOf(data: CodeArtsWebStatus): CreditRow[] {
  const byId = new Map((data.creditsByAccount ?? []).map(entry => [entry.id, entry]))
  return (data.accounts ?? []).map(account => {
    const entry = byId.get(account.id)
      ?? (byId.size === 0 && (data.accounts?.length ?? 0) === 1
        ? { id: account.id, credits: data.credits, creditsError: data.creditsError }
        : undefined)
    const snapshot = entry?.credits
    return {
      id: account.id,
      name: accountName(account),
      remain: snapshot?.credits.total.remain ?? null,
      expiring: snapshot?.credits.total.expiring ?? 0,
      ...snapshot?.credits.fetchedAt === undefined ? {} : { fetchedAt: snapshot.credits.fetchedAt },
      ...entry?.creditsError === undefined ? {} : { error: entry.creditsError },
    }
  })
}

/** 把弹层钉在按钮边上：优先往上开（那一行本来就在输入框下面），放不下就翻到下面。 */
function anchorOf(rect: DOMRect): Anchor {
  const above = rect.top > PANEL_MIN_ABOVE
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    top: above ? rect.top - PANEL_GAP : rect.bottom + PANEL_GAP,
    above,
  }
}

export function CodeArtsCreditDock({ useProjection, t }: CodeArtsCreditDockProps): ReactElement | null {
  const selection = readSelection(useProjection)
  const active = isCodeArts(selection)
  const [remain, setRemain] = useState<number | null>(null)
  const [total, setTotal] = useState<number>(0)
  const [rows, setRows] = useState<CreditRow[]>([])
  const [flags, setFlags] = useState<CodeArtsDockFlags>({ credits: true, queue: true })
  const [queued, setQueued] = useState<QueueEntry | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadStatus = useCallback(async (force: boolean): Promise<void> => {
    try {
      const res = await fetch(force ? `${STATUS_PATH}?force=1` : STATUS_PATH, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!res.ok) return
      const data = (await res.json().catch(() => undefined)) as CodeArtsWebStatus | undefined
      if (data === undefined || !mounted.current) return
      setFlags(data.dock ?? { credits: true, queue: true })
      setRows(rowsOf(data))
      // 多账号时把各号余额加在一起：底部条只表达「这台机器上还能用多少」。
      const snapshots = (data.creditsByAccount ?? [])
        .map(entry => entry.credits)
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
      const pool = snapshots.length > 0
        ? snapshots
        : data.credits === undefined ? [] : [data.credits]
      if (pool.length === 0) {
        setRemain(null)
        return
      }
      setRemain(Math.round(pool.reduce((sum, item) => sum + item.credits.total.remain, 0)))
      setTotal(Math.round(pool.reduce((sum, item) => sum + item.credits.total.total, 0)))
    } catch {
      // 积分是锦上添花，拉不到就别显示 —— 别在对话底部弹错误打扰用户。
    }
  }, [])

  useEffect(() => {
    if (!active) {
      setRemain(null)
      setRows([])
      setAnchor(null)
      return
    }
    let timer: number | undefined
    void loadStatus(false)
    timer = window.setInterval(() => void loadStatus(false), REFRESH_INTERVAL_MS)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [active, loadStatus])

  // 排队只在等上游开流时有值；没有排队就保持安静，别在底部常驻一个「排队 0」。
  useEffect(() => {
    if (!active) {
      setQueued(null)
      return
    }
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const res = await fetch(QUEUE_PATH, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const data = (await res.json().catch(() => undefined)) as { queue?: QueueEntry[] } | undefined
        if (mounted.current) setQueued(data?.queue?.[0] ?? null)
      } catch {
        // 排队信息是提示性的，拉不到就当没排队。
      }
    }
    void refresh()
    timer = window.setInterval(refresh, QUEUE_INTERVAL_MS)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [active])

  const close = useCallback(() => setAnchor(null), [])

  // 弹层是 fixed 定位的，页面一滚、窗口一缩就会和那一行脱节 —— 直接关掉比跟着算便宜。
  useEffect(() => {
    if (anchor === null) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (panelRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [anchor, close])

  if (!active) return null

  const showCredits = flags.credits && remain !== null
  const showQueue = flags.queue && queued !== null
  if (!showCredits && !showQueue) return null

  const queueTitle = queued === null
    ? undefined
    : t('queueDockTitle', { model: queued.model, position: queued.position, length: queued.length })
  const creditsTitle = showCredits
    ? t('creditsDockTitle', { remain: remain ?? 0, total })
    : undefined
  const fetchedAt = rows.reduce((latest, row) => Math.max(latest, row.fetchedAt ?? 0), 0)
  const lastUpdated = fetchedAt > 0 ? formatClock(fetchedAt) : ''

  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    if (anchor !== null) {
      close()
      return
    }
    setAnchor(anchorOf(event.currentTarget.getBoundingClientRect()))
  }

  const forceRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await loadStatus(true)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: '18px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        // 这一行是所有插件共用的 flex 行（[data-composer-dock]），别人写 width:100%
        // 就会来抢我们的份。max-content 是硬下限，flex-shrink:0 是双保险。
        flex: '0 0 auto',
        minWidth: 'max-content',
      }}
      title={queueTitle ?? creditsTitle}
    >
      {showQueue && queued !== null && <span>{t('queueDock', { position: queued.position })}</span>}
      {showCredits && (
        <button
          ref={triggerRef}
          // 输入框那一坨是个表单，button 不写 type 默认 submit —— 点一下就把输入框里的
          // 草稿当消息发出去了。
          type="button"
          aria-expanded={anchor !== null}
          aria-label={t('creditsDockExpand')}
          title={creditsTitle}
          onClick={toggle}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            margin: 0,
            padding: 0,
            border: 0,
            background: 'none',
            color: 'inherit',
            font: 'inherit',
            lineHeight: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span>{t('creditsDock', { remain: formatNumber(remain ?? 0) })}</span>
          <span aria-hidden="true" style={{ opacity: 0.6, fontSize: '0.8em' }}>▾</span>
        </button>
      )}
      {anchor !== null && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('creditsDockPanelTitle')}
          style={{
            // fixed 而不是 absolute：宿主那一行外面任何一层 overflow:hidden 都会把
            // absolute 的浮层裁掉，fixed 只认视口，不受祖先裁剪。
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            transform: anchor.above ? 'translateY(-100%)' : undefined,
            width: PANEL_WIDTH,
            maxWidth: 'calc(100vw - 16px)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            boxSizing: 'border-box',
            borderRadius: 'var(--dsw-radius-lg, 10px)',
            border: '0.5px solid var(--dsw-alias-settings-card-stroke, rgba(127, 127, 127, 0.28))',
            background: 'var(--dsw-alias-settings-card-fill, rgba(32, 32, 32, 0.96))',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            lineHeight: '18px',
            whiteSpace: 'normal',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{t('creditsDockPanelTitle')}</span>
            <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void forceRefresh()}>
              {refreshing ? t('creditsDockRefreshing') : t('creditsDockRefresh')}
            </Button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: '4px 12px',
              alignItems: 'center',
              borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22))',
              paddingTop: 8,
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            <span>{t('creditsDockColAccount')}</span>
            <span style={{ justifySelf: 'end' }}>{t('creditsDockColBalance')}</span>
            {rows.length === 0 && (
              <span style={{ gridColumn: '1 / -1' }}>{t('creditsDockEmpty')}</span>
            )}
            {rows.map(row => (
              <div
                key={row.id}
                style={{
                  display: 'contents',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <StateDot state={row.remain === null ? 'warning' : 'done'} />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--dsw-alias-label-primary)',
                    }}
                    title={row.error === undefined ? row.name : row.error}
                  >
                    {row.name}
                  </span>
                </span>
                <span style={{ justifySelf: 'end', fontVariantNumeric: 'tabular-nums' }}>
                  {row.remain === null ? '—' : formatNumber(row.remain)}
                </span>
              </div>
            ))}
          </div>

          {rows
            .filter(row => row.expiring > 0)
            .map(row => (
              <p
                key={`${row.id}-expiring`}
                style={{
                  margin: 0,
                  color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))',
                }}
              >
                {t('creditsDockExpiring', {
                  account: row.name,
                  expiring: formatNumber(row.expiring),
                })}
              </p>
            ))}

          {lastUpdated !== '' && (
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('creditsDockUpdated', { time: lastUpdated })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
