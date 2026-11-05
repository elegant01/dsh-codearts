import { CodeArtsPluginCard } from './CodeArtsPluginCard.tsx'
import type { CodeArtsPluginCardInjected } from './CodeArtsPluginCard.tsx'
import styles from './CodeArtsPanel.module.css'

/** 侧边栏按钮里的图标。宿主按 { size, active } 渲染，我们用 currentColor 跟随主题。 */
export function CodeArtsPanelIcon({ size }: { size?: number }): React.ReactElement {
  const px = typeof size === 'number' && size > 0 ? size : 16
  return (
    <svg
      className={styles.icon}
      width={px}
      height={px}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* 一支笔：CodeArts 的主题是写代码，比抽象几何块好认。 */}
      <path
        d="M9.9 2.6a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2l-6.4 6.4-3.6.9a.6.6 0 0 1-.7-.7l.9-3.6 6.3-6.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8.9 3.6 12.4 7.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export interface CodeArtsPanelPageInjected extends CodeArtsPluginCardInjected {
  /** 回对话页。宿主没提供 layout 服务时这里是 undefined，返回按钮整个不画。 */
  backToConversation?: (() => void) | undefined
}

/** 侧边栏入口页：一个返回按钮 + 标题，正文直接复用设置里那张卡片。 */
export function CodeArtsPanelPage({ t, backToConversation }: CodeArtsPanelPageInjected): React.ReactElement {
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        {backToConversation !== undefined && (
          <button type="button" className={styles.back} onClick={backToConversation}>
            <span className={styles.backCaret} aria-hidden="true" />
            {t('panelBack')}
          </button>
        )}
        <h1 className={styles.title}>{t('cardTitle')}</h1>
        <p className={styles.desc}>{t('panelDesc')}</p>
      </div>
      <div className={styles.body}>
        <CodeArtsPluginCard t={t} />
      </div>
    </div>
  )
}
