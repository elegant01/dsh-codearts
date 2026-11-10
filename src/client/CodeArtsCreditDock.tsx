/**
 * 对话底部的「模型 + 积分」条，以及点开后的积分弹层。
 *
 * 这一条挂在 `conversation.composer.dock` 槽位上（与宿主 session-stats strip 同位）。
 * 只在当前 provider 是 codearts 时才渲染，别的 provider 下完全不出现，不抢别人的行。
 *
 * 第一段是 `Provider CodeArts · <模型名>`，模型名直接用目录里的 `name`
 * （`catalog.ts` 的 `modelDisplayName` 已经把倍率写进去了，如
 * `DeepSeek-V4.1-Flash-1017 · x0.18`），所以这一行自带倍率、不必另算。
 * 这段是**我们自己的**身份行：邻居插件（如 dsh-codebuddy-cli）对任何 provider
 * 都会画一行 `Provider <id> · Model <id>`，在 codearts 下那行只有模型 id、没有
 * 倍率；两边都开就会重复，所以优先我们这条，邻居那条应在它自己的设置里关掉。
 *
 * 那一行是个按钮：点开就是逐号明细（多账号下聚合数字本身没意义，得能看出是哪个号）。
 * 显隐由设置卡片「显示」页那两个开关管着，开关值随 `/status` 一起下发 —— 底部条本来
 * 就在轮询它，不必为两个布尔开一条新链路。代价是关掉开关最多要等一个轮询周期（60 秒）
 * 才看得见效果，这个延迟在设置卡片上写明了。
 *
 * 积分数据走插件自己的 `/api/codearts/status`（带 TTL 缓存，见 src/credits.ts），
 * 不会因为这条 dock 让上游多挨一次请求；弹层上那个「刷新积分」是唯一绕缓存的出口。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type MouseEvent } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_DOCK_FLAGS, type CodeArtsDockFlags, type CodeArtsWebStatus } from '../web-status.ts'
import type { UsageTotals } from '../usage.ts'
import { stripModelSuffixes } from '../catalog.ts'
import { buildDockLine, DOCK_SEGMENT_SEPARATOR } from './dock-line.ts'
import {
  ensureSuppressStyle,
  markForeignDockEntries,
  releaseDockEntries,
  type DockNode,
} from './dock-suppress.ts'

/** 与 src/adapter.ts 的 CODEARTS_PROVIDER 对齐 —— client 不能 import host 模块。 */
const CODEARTS_PROVIDER = 'codearts'
const STATUS_PATH = '/api/codearts/status'
const QUEUE_PATH = '/api/codearts/queue'
/** 轮询间隔：与缓存 TTL（60s）对齐，再短也只是反复命中缓存。 */
const REFRESH_INTERVAL_MS = 60_000
/** 排队位置变得快：官方客户端也是 5 秒一次；这是本机路由，打不疼上游。 */
const QUEUE_INTERVAL_MS = 5_000
/**
 * 弹层宽度：只放「账号 + 积分」两列，所以按同类插件（dsh-connect-trae 的
 * `min(248px, …)`）取一档窄宽度 —— 这一层回答的是「哪个号还有多少积分」，
 * 用量数字不该把它撑成一张报表。
 */
const PANEL_WIDTH = 260
/** 弹层与那一行之间的缝隙。 */
const PANEL_GAP = 8
/**
 * 弹层里每行的列模板：账号 | 积分。
 *
 * 数字列用 `auto`：它跟着最宽的那个余额自适应，面板不必为「12,600」预留固定宽度。
 * 输入 / 输出 / 缓存这些用量数字不进表格，收进整行的悬浮提示（{@link usageLine}），
 * 完整明细在设置卡片里看。
 */
const PANEL_ROW_COLUMNS = 'minmax(0, 1fr) auto'
/** 数字格统一右对齐 + 等宽数字，列才对得齐。 */
const PANEL_NUM_CELL: CSSProperties = { justifySelf: 'end', fontVariantNumeric: 'tabular-nums' }
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
  /** 今天经本插件发出的用量（与设置卡片「用量」区块同一份账本）。 */
  usage?: UsageTotals
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

/**
 * 压掉同一行里**别的插件**条目时用的标记属性。
 *
 * 我们只能控制自己，压不了别人的注册 —— 但 `conversation.composer.dock` 是 list
 * 槽位，宿主把每条注册平铺成 `[data-composer-dock]` 的**直接子节点**，所以我们这条
 * 的 effect 能拿到兄弟节点。选中 codearts 模型期间给它们打上这个属性、由我们注入的
 * 一条 CSS 隐藏；切走或卸载时逐个摘掉，不留痕迹。
 *
 * 具体规则与「哪些不能碰」都在 `dock-suppress.ts` 里（那边能脱离 DOM 单测）。
 */


export interface CodeArtsCreditDockProps {
  /** 宿主注入的 projection 读取面；省略时 dock 不显示。 */
  useProjection?: (key: string) => unknown
  /** locale 翻译函数。 */
  t: (key: string, params?: Record<string, unknown>) => string
  /**
   * 这个实例挂在哪：
   * - `bar`  = 输入框工具行（权限控制右边），只画积分段和它点开的逐号明细；
   * - `dock` = 输入框下方那行，只画 Provider / 模型 / 倍率 / 排队。
   *
   * 同一份数据、同一套开关，两处各自渲染自己那几段 —— 模型名和倍率在工具行右侧
   * 已经有 pill 了，再在工具行里写一遍就是重复占宽。
   */
  zone?: 'bar' | 'dock'
}

function readSelection(useProjection: ((key: string) => unknown) | undefined): ModelSelection | undefined {
  if (useProjection === undefined) return undefined
  try {
    return useProjection('modelSelection') as ModelSelection | undefined
  } catch {
    return undefined
  }
}

function currentOf(selection: ModelSelection | undefined): ModelSelectionEntry | undefined {
  return selection?.next ?? selection?.lastUsed
}

function isCodeArts(selection: ModelSelection | undefined): boolean {
  return currentOf(selection)?.provider === CODEARTS_PROVIDER
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value))
}

/** 与设置卡片「用量」区块同一口径：12345 -> 12.3k。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function formatClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * 弹层里那行用量：`入 12.3k · 出 697（思 505）· 命中 94% · 37 条`。
 *
 * 刻意比设置卡片里的完整版短：面板只有 260px，把「缓存 11.5k」也列上就会折成
 * 两三行，比原来那个悬浮提示还难看。缓存值本身由命中率表达（它是输入的占比），
 * 思考 token 也不在这里——它是输出的子集，放在设置卡片的统计块里。上游不给缓存
 * 字段就不显示命中率：显示成 0% 会被当成「没命中」而不是「没数据」。
 */
function usageLine(usage: UsageTotals, t: (key: string, params?: Record<string, unknown>) => string): string {
  const cached = usage.cachedTokens ?? 0
  const parts = [
    t('usageCompact', {
      prompt: formatTokens(usage.promptTokens),
      completion: formatTokens(usage.completionTokens),
    }),
  ]
  if (cached > 0 && usage.promptTokens > 0) {
    parts.push(t('usageCacheHit', { pct: Math.min(100, Math.round((cached / usage.promptTokens) * 100)) }))
  }
  parts.push(t('usageRequestCount', { n: formatNumber(usage.requests) }))
  return parts.join(' · ')
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
    const usage = data.usage?.byAccountToday?.[account.id]
    return {
      id: account.id,
      name: accountName(account),
      remain: snapshot?.credits.total.remain ?? null,
      expiring: snapshot?.credits.total.expiring ?? 0,
      ...(usage === undefined ? {} : { usage }),
      ...snapshot?.credits.fetchedAt === undefined ? {} : { fetchedAt: snapshot.credits.fetchedAt },
      ...entry?.creditsError === undefined ? {} : { error: entry.creditsError },
    }
  })
}

/**
 * 弹层往上开还是往下开。
 *
 * 位置不在这里算：fixed 元素遇到带 transform / backdrop-filter 的祖先时，坐标会
 * 相对那个祖先而不是视口（工具行就长在输入框卡片里），所以真实偏移要渲染后实测
 * （见组件里的 layout effect），这里只决定朝哪边翻。
 */
function placeAbove(rect: DOMRect): boolean {
  return rect.top > PANEL_MIN_ABOVE
}

export function CodeArtsCreditDock({ useProjection, t, zone = 'dock' }: CodeArtsCreditDockProps): ReactElement | null {
  const selection = readSelection(useProjection)
  const active = isCodeArts(selection)
  const [remain, setRemain] = useState<number | null>(null)
  const [rows, setRows] = useState<CreditRow[]>([])
  /**
   * 模型 id -> 目录条目（显示名 + 已格式化的倍率）。
   *
   * 显示名自带 ` · x0.18` 尾巴，倍率单独放一段，所以两个都要拿：
   * 名字用 `stripModelSuffixes` 剥掉尾巴，倍率直接用服务端算好的 `ratio`。
   */
  const [modelInfo, setModelInfo] = useState<Record<string, { name: string; ratio?: string }>>({})
  const [flags, setFlags] = useState<CodeArtsDockFlags>(DEFAULT_DOCK_FLAGS)
  const [queued, setQueued] = useState<QueueEntry | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  /**
   * 弹层的包含块原点（视口坐标）。
   *
   * fixed 只有在祖先没有 transform / backdrop-filter 时才是视口坐标；工具行长在输入框
   * 卡片里，一旦撞上这类祖先，left/top 就会相对那个祖先算，弹层会飞到窗口外。做法是
   * 先按 0,0 渲染但不可见，量出面板实际落在哪（就是包含块原点），再把目标坐标减掉它；
   * 视口情形下量到 (0,0)，等于没动。
   */
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** 这一行的根节点 —— 它的 parentElement 就是宿主那条共享 flex 行。 */
  const rootRef = useRef<HTMLDivElement | null>(null)
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
      setFlags(data.dock ?? DEFAULT_DOCK_FLAGS)
      setRows(rowsOf(data))
      setModelInfo(Object.fromEntries((data.models ?? []).map(model => [model.id, {
        name: model.name,
        ...model.ratio === undefined ? {} : { ratio: model.ratio },
      }])))
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

  // 量一次包含块原点（见 origin 的注释）。渲染时 origin 为空 = 按 0,0 且不可见，
  // 所以量到的 rect 不会被 translateY(-100%) 这类变换污染。
  useLayoutEffect(() => {
    if (anchor === null) {
      setOrigin(null)
      return
    }
    const el = panelRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    setOrigin(prev => (prev !== null && Math.abs(prev.x - rect.left) < 0.5 && Math.abs(prev.y - rect.top) < 0.5
      ? prev
      : { x: rect.left, y: rect.top }))
  }, [anchor])

  // 选中我们的模型时，把这一行里别人的条目压掉。
  //
  // 别人注册什么我们管不了，但宿主把每条注册平铺成 `[data-composer-dock]` 的直接子节点，
  // 所以「隐藏兄弟节点」是我们在自己这一条里能做到的事：给它们打标记 + 一条我们注入的
  // CSS。切走（active=false）或卸载时逐个摘掉标记，绝不留下别人的行永久消失。
  useEffect(() => {
    if (!active) return
    const self = rootRef.current
    // 宿主那行是 `<div data-composer-dock>`，里面先放一个 display:contents 的
    // `[data-slot="conversation.composer.dock"]` 锚点，所有插件的条目平铺在锚点下。
    const slot = self?.closest('[data-slot="conversation.composer.dock"]') ?? null
    if (self === null || slot === null) return
    const node = slot as unknown as DockNode
    const me = self as unknown as DockNode
    const marked = new Set<DockNode>()
    const sweep = (): void => {
      for (const found of markForeignDockEntries(node, me)) marked.add(found)
    }
    ensureSuppressStyle()
    sweep()
    // 邻居可能比我们晚挂载（或整条替换），盯着子节点增删再扫一遍。
    const observer = new MutationObserver(sweep)
    observer.observe(slot, { childList: true })
    return () => {
      observer.disconnect()
      releaseDockEntries(marked)
      marked.clear()
    }
  }, [active])

  if (!active) return null

  const showCredits = flags.credits && remain !== null
  const showQueue = flags.queue && queued !== null
  // 工具行那个实例没有积分就什么都不画，别留一个零宽的 flex 子节点占位。
  // 「Model 及其右侧」关掉时，输入框下方那行只剩 Provider CodeArts 一段 —— 和
  // 「这一步没有可显示的东西」是两回事，所以这里不能连 provider 一起收掉，交给
  // buildDockLine 决定画几段。
  if (zone === 'bar' && !showCredits) return null

  // 一行分段，与 dsh-codebuddy-cli 的底栏同构（`积分 1,642 · Provider CodeBuddy ·
  // Model GLM-5.3 · x0.79`）：积分在最前，然后 provider、模型、倍率，最后是我们的排队段。
  // 段序与分隔符由 dock-line.ts 的纯函数说了算，这里只负责取数。
  //
  // 只有积分那一段是可点击的（点开逐号明细）；模型/倍率/排队是纯文本。别把整行做成
  // 按钮 —— 那样点模型名也会弹积分面板。
  const modelId = currentOf(selection)?.model
  const entry = modelId === undefined ? undefined : modelInfo[modelId]
  // 名字剥掉 ` · x0.18` 尾巴：倍率要单独成段，否则同一行里会出现两次。
  const modelLabel = entry === undefined
    ? modelId ?? ''
    : stripModelSuffixes(entry.name)
  const ratio = entry?.ratio

  const line = buildDockLine({
    // 积分只在工具行那一段；其余段留在输入框下方那行。
    ...zone === 'bar' && showCredits
      ? { credits: t('creditsDock', { remain: formatNumber(remain ?? 0) }) }
      : {},
    provider: 'CodeArts',
    ...modelLabel === '' ? {} : { model: modelLabel },
    ...ratio === undefined ? {} : { ratio },
    ...zone === 'dock' && showQueue && queued !== null
      ? { queue: t('queueDock', { position: queued.position }) }
      : {},
  // 「Model 及其右侧」开关：只管 model/ratio/queue 三段，provider 永远在。
  }, t, flags.modelDetail !== false)

  const fetchedAt = rows.reduce((latest, row) => Math.max(latest, row.fetchedAt ?? 0), 0)
  const lastUpdated = fetchedAt > 0 ? formatClock(fetchedAt) : ''

  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    if (anchor !== null) {
      close()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const above = placeAbove(rect)
    setAnchor({ left: rect.left, top: above ? rect.top - PANEL_GAP : rect.bottom + PANEL_GAP, above })
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
      ref={rootRef}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // 段间距交给 ` · ` 分隔符，不给 flex gap —— 有积分时这一行是
        // 「按钮 + 分隔符 + 纯文本」三个节点，gap 会在分隔符两侧各加一份空隙。
        gap: 0,
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
    >
      {/*
        **只有积分那一段**是开弹层的按钮：这是本插件原来的设定，别为了对齐邻居把它
        扩成整行 —— 那样点模型名/倍率也会弹出积分面板。
        输入框那一坨是个表单，button 不写 type 默认 submit —— 点一下会把草稿当消息发出去。
      */}
      {line.credits !== undefined && (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={anchor !== null}
            aria-label={t('creditsDockPanelTitle')}
            onClick={toggle}
            style={{
              all: 'unset',
              cursor: 'pointer',
              font: 'inherit',
              color: 'inherit',
              fontVariantNumeric: 'inherit',
              lineHeight: 'inherit',
              whiteSpace: 'inherit',
            }}
          >
            {line.credits}
          </button>
          {/* 分隔符只在后面真的还有段时才画：工具行那个实例后面已经没有内容，
              留着就是一个悬空的 `·`。 */}
          {zone === 'dock' && <span aria-hidden="true">{DOCK_SEGMENT_SEPARATOR}</span>}
        </>
      )}
      {zone === 'dock' && <span>{line.rest}</span>}
      {anchor !== null && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('creditsDockPanelTitle')}
          style={{
            // fixed 而不是 absolute：宿主那一行外面任何一层 overflow:hidden 都会把
            // absolute 的浮层裁掉，fixed 只认视口，不受祖先裁剪。
            position: 'fixed',
            // origin 为空时按 0,0 不可见地量一次，见上面的 layout effect。
            left: origin === null ? 0 : anchor.left - origin.x,
            top: origin === null ? 0 : anchor.top - origin.y,
            transform: anchor.above && origin !== null ? 'translateY(-100%)' : undefined,
            visibility: origin === null ? 'hidden' : 'visible',
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
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22))',
              paddingTop: 8,
              fontSize: 12,
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            {rows.length === 0 && <span>{t('creditsDockEmpty')}</span>}

            {rows.map(row => (
              // 一行「名 + 余额」、一行灰字用量，但**不带表头**：一旦有「账号 / 积分」
              // 两列表头，每个号占两行就立刻显得对不齐；名字和余额本身自带语义。
              <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: PANEL_ROW_COLUMNS,
                    gap: '0 8px',
                    alignItems: 'center',
                    minWidth: 0,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
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
                  <span style={PANEL_NUM_CELL}>{row.remain === null ? '—' : formatNumber(row.remain)}</span>
                </div>
                {/* 左缩进对齐到账号名（圆点 6 + 间隙 5）。 */}
                <span
                  style={{
                    paddingLeft: 11,
                    fontSize: 11,
                    lineHeight: '15px',
                    color: 'var(--dsw-alias-label-tertiary)',
                  }}
                >
                  {row.usage === undefined
                    ? t('creditsDockNoTokens')
                    : `${t('usageToday')} ${usageLine(row.usage, t)}`}
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
