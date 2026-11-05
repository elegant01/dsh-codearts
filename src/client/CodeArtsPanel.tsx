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
      {/*
       * 尖括号夹一道斜杠 = 「写代码」，这是代码编辑器里最通用的那个符号。
       * 之前画的是铅笔，和宿主自带的 IconEditOutline（编辑）撞脸，侧边栏里
       * 看着像「编辑这一页」而不是「CodeArts 入口」。
       */}
      <path
        d="M5.1 3.9 1.9 8l3.2 4.1"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.9 3.9 14.1 8l-3.2 4.1"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 3.2 7 12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
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
