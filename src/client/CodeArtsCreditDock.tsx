/**
 * 对话底部的积分条。
 *
 * 用户最初的诉求就是「对话底部要显示积分」—— 这一条挂在
 * `conversation.composer.dock` 槽位上（与宿主 session-stats strip 同位）。
 * 只在当前 provider 是 codearts 时才拉取并显示一行「积分 N」，别的 provider 下
 * 完全不渲染，不抢别人的行。
 *
 * 积分数据走插件自己的 `/api/codearts/status`（带 TTL 缓存，见 src/credits.ts），
 * 不会因为这条 dock 让上游多挨一次请求。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CodeArtsWebStatus } from '../web-status.ts'

/** 与 src/adapter.ts 的 CODEARTS_PROVIDER 对齐 —— client 不能 import host 模块。 */
const CODEARTS_PROVIDER = 'codearts'
const STATUS_PATH = '/api/codearts/status'
/** 轮询间隔：与缓存 TTL（60s）对齐，再短也只是反复命中缓存。 */
const REFRESH_INTERVAL_MS = 60_000

interface ModelSelectionEntry {
  provider?: string
  model?: string
}
interface ModelSelection {
  next?: ModelSelectionEntry
  lastUsed?: ModelSelectionEntry
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

export function CodeArtsCreditDock({ useProjection, t }: CodeArtsCreditDockProps): ReactElement | null {
  const selection = readSelection(useProjection)
  const active = isCodeArts(selection)
  const [remain, setRemain] = useState<number | null>(null)
  const [total, setTotal] = useState<number>(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!active) {
      setRemain(null)
      return
    }
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const res = await fetch(STATUS_PATH, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const data = (await res.json().catch(() => undefined)) as CodeArtsWebStatus | undefined
        if (data === undefined || data.credits === undefined) return
        if (mounted.current) {
          setRemain(Math.round(data.credits.credits.total.remain))
          setTotal(Math.round(data.credits.credits.total.total))
        }
      } catch {
        // 积分是锦上添花，拉不到就别显示 —— 别在对话底部弹错误打扰用户。
      }
    }
    void refresh()
    timer = window.setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [active])

  if (!active || remain === null) return null
  const text = t('creditsDock', { remain: new Intl.NumberFormat().format(remain) })
  const title = t('creditsDockTitle', { remain, total })
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
      title={title}
    >
      <span>{text}</span>
    </div>
  )
}
