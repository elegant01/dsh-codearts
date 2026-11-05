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
       * 一张「纸」—— 左上缺角、右下收口 —— 中间一道斜杠。纸代表产出物，斜杠代表
       * 「写代码」这个动作，合起来是「用代码生成的产物」。
       * 之前画的是铅笔，和宿主自带的 IconEditOutline（编辑）撞脸，侧边栏里看着像
       * 「编辑这一页」而不是「CodeArts 入口」。
       * 16px 下只能容纳这么多笔画：试过在原稿里再塞一对尖括号和一条曲线，会糊成一团。
       */}
      <path
        d="M6 2.6h6.5A1.5 1.5 0 0 1 14 4.1V10.8"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 6.2v6.1a1.5 1.5 0 0 0 1.5 1.5h6.1"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.3 5.9 6.7 10.9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
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
