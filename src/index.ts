/**
 * CodeArts models for DeepSeek Harness. The plugin registers a `codearts`
 * provider that forwards requests to CodeArts' OpenAI-compatible chat endpoint
 * through a local loopback shim.
 *
 * Sign-in is a full Huawei Cloud OAuth2 flow (PKCE + DPoP + local callback)
 * that exchanges the authorization code for an STS credential — a
 * `security_token` plus temporary AK/SK, which the chat request signs with
 * SDK-HMAC-SHA256. Pasting a bare `security_token` in the settings card remains
 * as a degraded path: without AK/SK the signature cannot be produced, so the
 * gateway rejects the chat.
 *
 * The model catalog is seeded statically and refreshed by dynamic discovery
 * (`src/discovery.ts`): the plugin asks CodeArts for the account's real model
 * list on startup and hourly, and falls back to the seed when that fails.
 *
 * Reasoning levels come from upstream's `thinking-variants` catalog (only the
 * models it names, e.g. GLM-5.2 → high/max). While a request waits for its
 * stream, the shim also polls the upstream queue position for the dock.
 *
 * @module dsh-codearts
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CodeArtsAccountStore, codeartsAccountsPath } from './auth.ts'
import { CodeArtsAccountPool } from './account-pool.ts'
import { CodeArtsCatalog, filterEnabledModels, isBenefitModel } from './catalog.ts'
import { refreshCatalog } from './discovery.ts'
import { CodeArtsUsageTracker, codeartsUsagePath } from './usage.ts'
import { CodeArtsQueueGate } from './queue.ts'
import { CodeArtsCreditCache } from './credits.ts'
import { createCodeArtsAdapter, CODEARTS_PROVIDER } from './adapter.ts'
import { probePiAiCompat } from './pi-ai-compat.ts'
import { createCodeArtsShim, recentRequestShapes, recentUsageShapes } from './shim.ts'
import { registerCodeArtsStatusRoute, summarizeClaims } from './web-status.ts'
import type {
  CodeArtsAccountCredits,
  CodeArtsClaimAccountResult,
  CodeArtsClaimResult,
  CodeArtsDockFlags,
  CodeArtsKeeperView,
} from './web-status.ts'
import { installSettingsSectionCompat, resolveSettingsNamespaceCompat } from './settings-compat.ts'
import {
  KEEPER_STALE_MS,
  keeperLogPath,
  keeperScriptPath,
  keeperStats,
  spawnKeeper,
  stopKeeper as stopKeeperProcess,
} from './keeper.ts'
import { CODEARTS_VERSION } from './version.ts'

export { CODEARTS_PROVIDER, createCodeArtsAdapter, type CodeArtsAdapter } from './adapter.ts'
export { createCodeArtsShim, type CodeArtsShim } from './shim.ts'
export {
  FALLBACK_CODEARTS_MODELS,
  CodeArtsCatalog,
  filterEnabledModels,
  type CodeArtsModelInfo,
} from './catalog.ts'
export {
  codeartsAuthPath,
  codeartsAccountsPath,
  CodeArtsAccountStore,
  CodeArtsCredentialStore,
  type CodeArtsAccountSummary,
  type CodeArtsCredential,
} from './auth.ts'
export { CodeArtsAccountPool, type AccountRuntime } from './account-pool.ts'
export {
  BENEFIT_GATEWAY_HOST,
  CodeArtsCreditCache,
  fetchCredits,
  parseCreditStatistics,
  parseTokenBalance,
  type CodeArtsCreditCategory,
  type CodeArtsCredits,
  type CodeArtsCreditSnapshot,
  type CodeArtsCreditState,
  type CodeArtsTokenQuota,
} from './credits.ts'
export {
  CodeArtsUsageTracker,
  codeartsUsagePath,
  type UsageSnapshot,
  type UsageTotals,
} from './usage.ts'
import { claimDailyWelfare } from './upstream.ts'
export { discoverModels, refreshCatalog, type DiscoveryOutcome } from './discovery.ts'
export {
  SNAP_HOST,
  chatStream,
  prepareChatBody,
  canonicalModel,
  fetchModels,
  maxTokensCeilingFor,
  type ModelDiscoveryResult,
  type UpstreamErrorKind,
} from './upstream.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-codearts'

/** The llm service is required before the provider can register. */
export const inject = ['llm']

/** Settings namespace owning the configuration card. */
export const CODEARTS_SETTINGS_NS = 'codearts' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Allowlist of CodeArts model ids offered in the model pickers. */
  enabledModels?: string[]
  /** 对话输入框下方那行「积分 N」是否显示。缺省 = 显示（老配置不改行为）。 */
  showCreditDock?: boolean
  /** 等上游开流时那行「排队第 N 位」是否显示。缺省 = 显示。 */
  showQueueDock?: boolean
  /**
   * 是否在 DSH 侧边栏的图标列里加一个 CodeArts 图标（点开在中间列显示整页版卡片）。
   *
   * 缺省 = **不显示**：图标列是全宿主共用的资源，每个插件都默认占一格很快就会挤满，
   * 而「设置 → 插件」里本来就能看到同一张卡片，所以这一格交给用户自己决定要不要。
   */
  showSidebarPanel?: boolean
  /**
   * 对话底部的「Model 模型 · x 倍率 · 排队」这几段是否显示。缺省 = 显示。
   *
   * 只管 **Model 及其右侧**：`Provider CodeArts` 是插件的身份标识，永远显示，
   * 不受这个开关控制。关掉之后那一行是 `积分 24,091 · Provider CodeArts`。
   */
  showModelDetailDock?: boolean
  /**
   * 后台自动领取每日签到积分（多账号逐个领）。缺省 = **关**。
   *
   * 缺省关的理由不是"收益小"，而是：这个开关会在用户看不见的时候动他的账号余额，
   * 默认替他打开不合适。打开后每次启动 30 秒试一轮，领不到再退避重试（最多 3 次），
   * 结果会留在卡片上给用户看。
   */
  autoClaim?: boolean
  /**
   * 常驻凭证守护进程：让 refresh_token 在 **DSH 关掉之后**也继续被续期。
   *
   * 缺省 = **关**。理由：它会在 DSH 之外留一个后台进程（用宿主 exe 以 node 形态跑，
   * 不额外依赖 node 安装），属于用户应当知情并主动选择的东西，不能默认替他开。
   * 打开后卡片上会显示它的 pid，并给一个「结束」按钮。
   */
  keepAliveDaemon?: boolean
}

interface VolatileValue<T> {
  get: () => T
}

function unwrapVolatileValue<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileValue<T>).get()
  }
  return value as T
}

function unwrapConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out as Config
}

export const Config: z<Config> = z.object({
  enabledModels: z.array(z.string()).description('Model ids offered in the model pickers (empty means every model)').volatile(),
  showCreditDock: z.boolean().default(true).description('Show the remaining-credits line under the chat input box').volatile(),
  showQueueDock: z.boolean().default(true).description('Show the upstream queue position under the chat input box').volatile(),
  showSidebarPanel: z.boolean().default(false).description('Show a CodeArts icon in the DSH sidebar icon column, opening this page in the middle column').volatile(),
  showModelDetailDock: z.boolean().default(true).description('Show "Model … · x ratio" on the line under the chat input box (Provider CodeArts always shows)').volatile(),
  autoClaim: z.boolean().default(false).description('Automatically claim the daily sign-in credits for every signed-in account').volatile(),
  keepAliveDaemon: z.boolean().default(false).description('Keep a detached background process that refreshes the OAuth credential while DSH is closed').volatile(),
}) as unknown as z<Config>

function settingsCompatNamespace(ctx: Context): SettingsNamespace {
  return resolveSettingsNamespaceCompat(ctx, ctx.get('settings'), CODEARTS_SETTINGS_NS)
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config = unwrapConfig(rawConfig)
  const accountsPath = codeartsAccountsPath()
  // 多账号：池与账号文档分离——文档管凭证，池管「谁现在能接活」。
  const store = new CodeArtsAccountStore(accountsPath)
  const pool = new CodeArtsAccountPool([])
  const catalog = new CodeArtsCatalog()
  // 用量账本：记本机经插件发出的请求（账号总额度见 credits.ts，这里只记本机）。
  const usage = new CodeArtsUsageTracker({ path: codeartsUsagePath() })
  // 上游排队位置：shim 在等开流时 start/stop，底部积分条轮询 /queue 读快照。
  const queue = new CodeArtsQueueGate()
  // 积分：CodeArts **有**积分接口（2026-10 从官方 Agent 客户端挖出，见 credits.ts）。
  const credits = new CodeArtsCreditCache()

  /** /status 是卡片与对话底部都会轮询的接口，积分慢请求不能把它拖成转圈。 */
  const CREDIT_TIMEOUT_MS = 8_000

  /**
   * 领取签到积分的单号预算。福利中心偶尔很慢（要拉活动列表再认领），给足 20 秒，
   * 但必须有个上限：自动领取是在后台跑的，卡死的请求会把这个号的后续重试全堵住。
   */
  const CLAIM_TIMEOUT_MS = 20_000

  /**
   * 拉一次积分（每个账号各自一份）。
   *
   * 积分是**账号级**属性：多账号下每个号的余额、到期、签到状态都不同，所以逐号
   * 并发拉、逐号缓存（缓存键就是账号 id）。一个号失败只影响它自己那一份。
   */
  const loadCredits = async (signal?: AbortSignal): Promise<CodeArtsAccountCredits[]> => {
    const ids = await store.ids()
    if (ids.length === 0) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CREDIT_TIMEOUT_MS)
    timer.unref?.()
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      return await Promise.all(ids.map(async (id): Promise<CodeArtsAccountCredits> => {
        const stored = await store.credential(id)
        if (stored === undefined) return { id, creditsError: 'account no longer stored' }
        if (stored.stale === true) return { id, creditsError: 'account needs sign-in' }
        try {
          const resolved = await store.resolve(id)
          if (resolved === undefined) return { id, creditsError: 'no usable credential' }
          const state = await credits.get(id, resolved, controller.signal)
          return state.phase === 'ok'
            ? { id, credits: state.value }
            : { id, creditsError: state.message }
        } catch (error: unknown) {
          return { id, creditsError: error instanceof Error ? error.message : String(error) }
        }
      }))
    } finally {
      clearTimeout(timer)
    }
  }

  let current = (): Config => config
  const enabledModels = (): readonly string[] | undefined => current().enabledModels

  const setEnabledModels = async (ids: readonly string[]): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), { enabledModels: [...ids] })
    return true
  }

  // 缺省即显示：老配置没这两个键时不该把已经用惯的那一行变没。
  // 侧边栏入口相反 —— 缺省关闭，没写过就是不要。
  // `modelDetail` 缺省开（保持老版本的样子）；`autoClaim` 缺省关。
  const dock = (): CodeArtsDockFlags => ({
    credits: current().showCreditDock !== false,
    queue: current().showQueueDock !== false,
    sidebar: current().showSidebarPanel === true,
    modelDetail: current().showModelDetailDock !== false,
    autoClaim: current().autoClaim === true,
    keepAliveDaemon: current().keepAliveDaemon === true,
  })

  const setDock = async (patch: Partial<CodeArtsDockFlags>): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    await settings.update(settingsCompatNamespace(ctx), {
      ...patch.credits === undefined ? {} : { showCreditDock: patch.credits },
      ...patch.queue === undefined ? {} : { showQueueDock: patch.queue },
      ...patch.sidebar === undefined ? {} : { showSidebarPanel: patch.sidebar },
      ...patch.modelDetail === undefined ? {} : { showModelDetailDock: patch.modelDetail },
      ...patch.autoClaim === undefined ? {} : { autoClaim: patch.autoClaim },
      ...patch.keepAliveDaemon === undefined ? {} : { keepAliveDaemon: patch.keepAliveDaemon },
    })
    return true
  }

  // Same-origin status/token routes backing the Plugin-configuration card.
  // 卡片另外读账号池的槽位占用与用量账本：这两个都是本机事实，不涉及令牌。
  /** 手动「刷新模型列表」的预算：三路来源各打一次，比每小时的后台刷新更该给足时间。 */
  const MANUAL_REFRESH_MS = 60_000

  /**
   * 最近一次**自动**领取的结果，给卡片留痕用。
   *
   * 为什么要留痕：自动领取是在用户看不见的时候动他的账号余额。只做不说，用户只
   * 会看到积分莫名其妙变多（或者没变），无从判断这个功能到底有没有在工作。
   */
  let lastAutoClaim: { at: number; claimed: boolean; state: string; amount: number; message: string } | undefined

  /**
   * 守护进程：当前活着吗。
   *
   * 「活着」= 状态文件里心跳新鲜 **且** 那个 pid 真能探到（`keeper.ts` 里两个条件都查）。
   * 只看心跳会把刚被 kill 的进程当成活的 —— 心跳是它死前 30 秒内写的，不会自己消失。
   */
  const keeperRunning = (): boolean => keeperStats().alive

  /**
   * 刚点开开关、守护进程还没写出状态文件的那段时间。
   *
   * 秒级的进程启动 + 首次 `writeKeeperState` 之间确实有一段「探不到活」的窗口。
   * 不区分的话，卡片刚被勾上就会因为「没探到进程」而自己把开关关掉 —— 用户看到的是
   * 勾了一下马上弹回去。这段时间里 `alive` 仍是 false（它确实还没活），但带 `starting`。
   */
  const KEEPER_START_GRACE_MS = KEEPER_STALE_MS

  const keeperView = async (): Promise<CodeArtsKeeperView> => {
    const logPath = keeperLogPath()
    const stats = keeperStats()
    if (stats.alive && stats.state !== undefined) {
      keeperLastError = undefined
      return {
        alive: true,
        pid: stats.state.pid,
        startedAt: stats.state.startedAt,
        heartbeatAt: stats.state.heartbeatAt,
        ...stats.state.lastPass === undefined ? {} : { lastPass: stats.state.lastPass },
        logPath,
      }
    }
    const wanted = current().keepAliveDaemon === true
    if (!wanted) return { alive: false, logPath }
    // 开关开着却没进程，两种可能：刚拉起（等一会儿就好）、进程被杀了（要把开关关掉）。
    if (Date.now() - keeperSpawnedAt < KEEPER_START_GRACE_MS) {
      return { alive: false, starting: true, ...keeperLastError === undefined ? {} : { error: keeperLastError }, logPath }
    }
    // 被 kill 了（或者是启动失败）。用户点过「结束」的情况由 keeper/stop 路由负责，
    // 这里是「进程在别处消失」—— 开关必须跟着关，否则界面会永远顶着一个空 pid。
    try {
      await setDock({ keepAliveDaemon: false })
    } catch {
      // 写不进去也不影响返回：卡片照样知道它没活着。
    }
    return {
      alive: false,
      error: keeperLastError ?? '守护进程已退出，已自动关闭保活开关',
      logPath,
    }
  }

  /**
   * 常驻守护进程：在 DSH 之外续 refresh_token。
   *
   * 与上面 `keepAliveLoop` 的分工：那个只在 DSH 活着时有用，关掉 DSH 就没了；这个起的是
   * 一个 detached 进程，DSH 退出后它还在，20 分钟续一次，把 30 天有效期的 refresh_token
   * 一直续下去 —— 这才是「十几天不用重新登录」的正解。
   *
   * refresh_token 是一次性的：两边同时刷会让后刷的一方拿着作废的 token 失败。所以开关
   * 打开时 `keepAliveLoop` 会主动让路（只从磁盘重读），刷新权独占在守护进程手里。
   */
  const KEEPER_ENSURE_MS = 60 * 1000
  let keeperSpawnedAt = 0
  let keeperLastError: string | undefined
  let keeperTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 按开关状态把守护进程拉起来。
   *
   * 只在「开关刚被打开」时调用（`armKeepAliveDaemon`）。**不做定时重起**：用户明确要求
   * 「被 kill 了开关就关掉」，而不是「被 kill 了自己又冒出来」—— 后者正是用户按了结束
   * 却看到进程又活了的那种体验。
   */
  const ensureKeeper = (): void => {
    if (stopped) return
    if (current().keepAliveDaemon !== true) return
    if (keeperRunning()) return
    const outcome = spawnKeeper({ scriptPath: keeperScriptPath(), pluginVersion: CODEARTS_VERSION })
    keeperSpawnedAt = Date.now()
    if (outcome.ok) {
      keeperLastError = undefined
      ctx.logger.debug(`dsh-codearts: credential keeper running (pid ${outcome.pid ?? '?'})`)
    } else {
      keeperLastError = outcome.reason ?? 'spawn failed'
      ctx.logger.debug(`dsh-codearts: credential keeper failed to start: ${keeperLastError}`)
    }
  }

  /**
   * 守护巡检：只在旁边看着，不重起。
   *
   * 三种结局：开关被关掉 → 收工；进程还活着 → 继续看；进程没了（超出启动宽限期）→
   * 把开关关掉并收工。判死必须在服务端做，不能只靠卡片轮询 —— 卡片没打开时也得让
   * 那个「开着却空转」的开关自己消失。
   */
  const keeperLoop = async (): Promise<void> => {
    if (stopped) return
    if (current().keepAliveDaemon !== true) {
      keeperTimer = undefined
      return
    }
    if (!keeperRunning() && Date.now() - keeperSpawnedAt >= KEEPER_START_GRACE_MS) {
      keeperTimer = undefined
      keeperSpawnedAt = 0
      await setDock({ keepAliveDaemon: false }).catch(() => false)
      return
    }
    keeperTimer = setTimeout(() => void keeperLoop(), KEEPER_ENSURE_MS)
    keeperTimer.unref?.()
  }

  /** 开关变化时立刻响应：打开就马上起，关掉就撤掉巡检（进程本身留给「结束」按钮）。 */
  const armKeepAliveDaemon = (): void => {
    if (stopped) return
    if (current().keepAliveDaemon !== true) {
      if (keeperTimer !== undefined) clearTimeout(keeperTimer)
      keeperTimer = undefined
      keeperSpawnedAt = 0
      return
    }
    if (keeperTimer !== undefined) return
    ensureKeeper()
    keeperTimer = setTimeout(() => void keeperLoop(), KEEPER_ENSURE_MS)
    keeperTimer.unref?.()
  }

  /**
   * 逐号领取每日签到积分。
   *
   * 手动「领取」按钮和后台自动领取走的是**同一条**路径，只是入口不同：领的是什么、
   * 失败怎么归类、什么时候作废缓存，两处必须完全一致，否则「手动能领到、自动领不到」
   * 这种差异排查起来极其费劲。
   */
  const claimAll = async (accountId?: string): Promise<CodeArtsClaimResult> => {
    const ids = accountId === undefined ? await store.ids() : [accountId]
    if (ids.length === 0) {
      return { ok: false, claimed: false, state: 'failed', amount: 0, message: 'no usable credential' }
    }
    // 逐号串行领：签到是轻量操作，串行能避免同一时刻对福利中心打一串并发。
    const results: CodeArtsClaimAccountResult[] = []
    for (const id of ids) {
      try {
        const stored = await store.credential(id)
        if (stored === undefined || stored.stale === true) {
          results.push({
            id,
            ok: false,
            claimed: false,
            state: 'failed',
            amount: 0,
            message: stored === undefined ? 'account not found' : 'account needs sign-in',
          })
          continue
        }
        const resolved = await store.resolve(id)
        if (resolved === undefined) {
          results.push({ id, ok: false, claimed: false, state: 'failed', amount: 0, message: 'no usable credential' })
          continue
        }
        // 应用内点「领取」拿的是福利中心的每日签到活动（/v1/ops/delivery + /v1/ops/claim），
        // 不是 claimBenefit 那条限时福利免费模型渠道 —— 后者不发积分。
        const outcome = await claimDailyWelfare(resolved, AbortSignal.timeout(CLAIM_TIMEOUT_MS))
        if (outcome.state === 'claimed') {
          // 余额真的变了，缓存必须丢掉，否则卡片下一次刷新还读旧的。
          credits.invalidate(id)
        }
        results.push({
          id,
          ok: outcome.state !== 'failed',
          claimed: outcome.state === 'claimed',
          state: outcome.state,
          amount: outcome.amount,
          message: outcome.message,
        })
      } catch (error: unknown) {
        results.push({
          id,
          ok: false,
          claimed: false,
          state: 'failed',
          amount: 0,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return summarizeClaims(results)
  }

  ctx.inject(['webServer'], webCtx => registerCodeArtsStatusRoute(webCtx, {
    store,
    models: () => catalog.current(),
    enabledModels,
    setEnabledModels,
    pool: () => pool.list(),
    // 重新登录/贴新 token 成功后，把这个号从禁用里捞出来（disabled 不清的话登录也救不回来）。
    reviveAccount: id => pool.revive(id),
    usage: () => usage.snapshot(),
    queue: () => queue.snapshot(),
    recentRequests: () => recentRequestShapes(),
    recentUsages: () => recentUsageShapes(),
    credits: signal => loadCredits(signal),
    // 弹层上那个「刷新积分」要看见真数字，所以先清缓存再拉 —— 不然点了还是 60 秒前的旧值。
    refreshCredits: signal => {
      credits.invalidate()
      return loadCredits(signal)
    },
    dock,
    setDock,
    keeper: keeperView,
    stopKeeper: async () => {
      const outcome = await stopKeeperProcess()
      // 自愈：不管 kill 结果如何，先把「刚拉起」的宽限计时清掉，免得下一次对账把它当
      // 成启动中而漏掉关开关。
      keeperSpawnedAt = 0
      return outcome
    },
    claim: claimAll,
    autoClaim: async () => {
      const outcome = await claimAll()
      lastAutoClaim = {
        at: Date.now(),
        claimed: outcome.claimed,
        state: outcome.state,
        amount: outcome.amount,
        message: outcome.message,
      }
      return outcome
    },
    refreshModels: async () => {
      const outcome = await refreshCatalog(store, catalog, AbortSignal.timeout(MANUAL_REFRESH_MS))
      const models = catalog.current()
      return {
        models: models.length,
        benefit: models.filter(model => isBenefitModel(model.id)).length,
        refreshed: outcome?.anySucceeded === true,
      }
    },
  }))

  // The settings section keeps the enabled-model allowlist live. On hosts with
  // a settings provider it contributes the section; without one the plugin
  // still serves its models, it simply has no editable section.
  installSettingsSectionCompat(ctx, CODEARTS_SETTINGS_NS, Config, config, {
    setSource(source) {
      current = () => unwrapConfig(source())
      // 开关一变就按新状态重排自动领取：打开了要立刻跟上，关掉了要立刻停手。
      armAutoClaim()
      armKeepAliveDaemon()
    },
    onChange() {
      // 设置项变化时同样重排（有些宿主的 setSource 不会因值变化重新触发）。
      armAutoClaim()
      armKeepAliveDaemon()
    },
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    queue.dispose()
    // 账本落盘再关：不然最后几秒的用量会随进程一起丢。
    void usage.flush().catch(() => {})
    void shim.close().catch(() => {})
  })

  // 动态模型发现：启动后拉一次真实目录，之后每小时刷新。失败只记日志 —— 目录保留
  // 上一次的结果，不因为上游抖动把模型选择器清空。冷启动时目录就是空的
  // （`CodeArtsCatalog` 不拿历史名单冒充），所以下面那条快速重试是唯一的出路。
  const CATALOG_REFRESH_MS = 60 * 60 * 1000
  // 目录还是空（启动/热重载后第一次发现正好撞上上游抖动）就尽快重试，而不是干等
  // 一小时 —— 空目录期间每条消息都会死在 pi-ai 的 "has no configured model"。
  // 但上游长期故障时不能按分钟硬刷：每一轮对**每个号**都要 list + resolve（可能续期）
  // + 多路目录请求，越久不好刷得越凶，所以指数退避到 5 分钟封顶。
  const CATALOG_EMPTY_RETRY_MS = 60 * 1000
  const CATALOG_EMPTY_RETRY_MAX_MS = 5 * 60 * 1000
  const abort = new AbortController()
  const discover = async (): Promise<void> => {
    if (stopped) return
    try {
      const outcome = await refreshCatalog(store, catalog, abort.signal)
      if (outcome === undefined || stopped) return
      if (outcome.anySucceeded) {
        const free = outcome.models.filter(model => model.benefit === true).length
        ctx.logger.debug(
          `dsh-codearts: model discovery refreshed the catalog (${outcome.models.length} models, ${free} benefit)`,
        )
      } else {
        ctx.logger.warn(
          'dsh-codearts: model discovery found nothing usable; keeping the current catalog',
          outcome.accounts.flatMap(account => account.errors),
        )
      }
    } catch (error) {
      ctx.logger.debug('dsh-codearts: model discovery failed; keeping the current catalog', error)
    }
  }

  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  /** 连续多少轮目录是空的（用来算退避）；一旦有货就归零。 */
  let emptyStreak = 0
  /** 自我重排的发现循环：目录为空时退避着重试（60s → 5min 封顶），有货后回到每小时。 */
  const discoverLoop = async (): Promise<void> => {
    await discover()
    if (stopped) return
    let delay: number
    if (catalog.current().length === 0) {
      delay = Math.min(CATALOG_EMPTY_RETRY_MS * 2 ** emptyStreak, CATALOG_EMPTY_RETRY_MAX_MS)
      emptyStreak += 1
    } else {
      emptyStreak = 0
      delay = CATALOG_REFRESH_MS
    }
    discoveryTimer = setTimeout(() => void discoverLoop(), delay)
    discoveryTimer.unref?.()
  }
  ctx.effect(() => () => {
    abort.abort()
    if (discoveryTimer !== undefined) clearTimeout(discoveryTimer)
  })

  /**
   * 凭证保活：每 20 分钟把所有「快过期」的账号提前续掉。
   *
   * 为什么必须有这个循环：上游签发的 token 有效期是固定的 2 小时（实测，见
   * `auth.ts` 的 `REFRESH_SKEW_MS` 注释），而 `ensureFresh` 只在「有请求进来」时才被
   * 触发。用户开着 DSH 却不聊天时没有任何请求，凭证就一路裸奔到过期 —— 表现就是
   * 「隔天就要重新登录」。有了这个循环，只要 DSH 活着，凭证就不会真的到期。
   *
   * 间隔 20 分钟 + 续期阈值 30 分钟 = 剩 30 分钟以内一定会被扫到至少一次。
   * 关掉 DSH 就无从保活（插件不在进程里），那部分只能靠下次启动时重新登录，
   * 这是纯客户端方案的硬边界，卡片文案里必须讲明白。
   */
  const KEEP_ALIVE_INTERVAL_MS = 20 * 60 * 1000
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined
  const keepAliveLoop = async (): Promise<void> => {
    if (stopped) return
    // 让路：守护进程活着时续期的独占权在它手里。refresh_token 一次性，两边同时刷
    // 会让后刷的那次拿着已作废的 token 失败，直接把号写成 stale —— 这正是「隔天就要
    // 重新登录」的成因之一。所以我们只从磁盘重读它写回的结果，自己不发刷新请求。
    if (keeperRunning()) {
      await store.reloadFromDisk().catch(() => {})
    } else {
      try {
        const outcome = await store.keepAlive()
        if (outcome.refreshed > 0) {
          ctx.logger.debug(`dsh-codearts: refreshed ${outcome.refreshed} credential(s) in the background`)
        }
        if (outcome.needsLogin.length > 0) {
          ctx.logger.debug(`dsh-codearts: ${outcome.needsLogin.length} account(s) need a fresh sign-in`)
        }
      } catch (error: unknown) {
        // 保活失败不能影响聊天：下一轮再试就是。
        ctx.logger.debug('dsh-codearts: credential keep-alive failed; will retry', error)
      }
    }
    if (stopped) return
    keepAliveTimer = setTimeout(() => void keepAliveLoop(), KEEP_ALIVE_INTERVAL_MS)
    keepAliveTimer.unref?.()
  }

  /**
   * 自动领取每日签到积分。
   *
   * 节奏的取舍：上游按天去重（重复领返回 40001 → already），所以多领不会出事；
   * 但也正因为幂等，**没必要**高频轮询 —— 单号一天只值 200 分，每 10 秒刷一次的
   * 上行成本和风控风险都远大于收益。取「启动后 30 秒试一次 + 失败才退避重试
   * （30 分钟一次、最多 3 次）」：装了就领到，领不到也不无限缠着上游。
   *
   * 终止条件：任意一轮里「有号真领到」或「所有号都是 already/unavailable」就停。
   * 只有 genuinely 失败（网络、凭据异常）才值得再试。
   */
  const AUTO_CLAIM_FIRST_DELAY_MS = 30 * 1000
  const AUTO_CLAIM_RETRY_MS = 30 * 60 * 1000
  const AUTO_CLAIM_MAX_TRIES = 3
  let autoClaimTimer: ReturnType<typeof setTimeout> | undefined
  let autoClaimTries = 0
  /** 自我重排的自动领取循环；开关关掉时直接不排下一轮，下次打开才重新开始。 */
  const autoClaimLoop = async (): Promise<void> => {
    if (stopped) return
    if (!dock().autoClaim) {
      // 开关关着：不排下一轮。用户中途打开时由设置变更路径重新拉起（见下方 onChange）。
      autoClaimTimer = undefined
      return
    }
    autoClaimTries += 1
    let retry = false
    try {
      const outcome = await claimAll()
      lastAutoClaim = {
        at: Date.now(),
        claimed: outcome.claimed,
        state: outcome.state,
        amount: outcome.amount,
        message: outcome.message,
      }
      if (outcome.claimed) {
        ctx.logger.debug(`dsh-codearts: auto-claimed daily credits (${outcome.amount})`)
      } else if (outcome.state === 'failed') {
        // 真失败（网络/凭据）才重试；already/unavailable 说明今天没什么可领的，别再缠上游。
        retry = true
      }
    } catch (error: unknown) {
      retry = true
      ctx.logger.debug('dsh-codearts: auto-claim failed; will retry', error)
    }
    if (stopped) return
    if (!retry || autoClaimTries >= AUTO_CLAIM_MAX_TRIES) {
      autoClaimTimer = undefined
      return
    }
    autoClaimTimer = setTimeout(() => void autoClaimLoop(), AUTO_CLAIM_RETRY_MS)
    autoClaimTimer.unref?.()
  }

  /** 按当前开关状态（重新）拉起自动领取；开关关掉时把在等的定时器撤掉。 */
  const armAutoClaim = (): void => {
    if (stopped) return
    if (!dock().autoClaim) {
      if (autoClaimTimer !== undefined) clearTimeout(autoClaimTimer)
      autoClaimTimer = undefined
      autoClaimTries = 0
      return
    }
    if (autoClaimTimer !== undefined) return
    autoClaimTries = 0
    autoClaimTimer = setTimeout(() => void autoClaimLoop(), AUTO_CLAIM_FIRST_DELAY_MS)
    autoClaimTimer.unref?.()
  }

  // 上面两个循环都是自我重排的，必须在这里统一收口：插件停用时残留的定时器
  // 会在 nextTick 里继续访问已卸载的 store。
  ctx.effect(() => () => {
    if (keepAliveTimer !== undefined) clearTimeout(keepAliveTimer)
    if (autoClaimTimer !== undefined) clearTimeout(autoClaimTimer)
    if (keeperTimer !== undefined) clearTimeout(keeperTimer)
  })

  // Build the loopback shim first; the adapter reads its origin at construction.
  const shim = createCodeArtsShim({ store, catalog, pool, usage, queue, logger: ctx.logger })

  // 账本懒加载：读盘失败/文件不存在都不影响插件启动。
  void usage.load().catch(() => {})

  void shim.ready
    .then(async () => {
      if (stopped) return
      // 先让 provider 挂上，再异步跑第一次发现 —— 目录是空起步的，模型要等这一轮填进来。
      void discoverLoop()
      // 凭证保活与自动领取跟模型发现一起起步：它们的首轮都带延迟（保活立即跑一次，
      // 领取等 30 秒），不会和启动瞬间的目录请求抢上游。
      void keepAliveLoop()
      armAutoClaim()
      // 守护进程跟着启动：开关开着才起，关着什么都不做。
      armKeepAliveDaemon()
      // 版本不兼容时每条消息都会死在出网之前，所以要在这里说明白（卡片上也显示）。
      const incompatible = await probePiAiCompat()
      if (incompatible !== undefined) ctx.logger.error(`dsh-codearts: ${incompatible}`)
      const codearts = createCodeArtsAdapter({
        shim,
        catalog,
        enabledModels,
        resolveAttachments: () => ctx.get('attachments'),
      })

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        releaseAdapter = ctx.llm.registerAdapter([CODEARTS_PROVIDER], codearts.adapter)
        releaseDirectory = ctx.llm.registerConfigurableProviders([{
          provider: CODEARTS_PROVIDER,
          displayName: 'CodeArts',
          settingsNs: settingsCompatNamespace(ctx),
          settingsPath: [],
          declared: false,
        }])
      } finally {
        if (releaseAdapter === undefined || releaseDirectory === undefined) {
          releaseAdapter?.()
          releaseDirectory?.()
        }
      }
      try {
        ctx.effect(() => () => {
          releaseAdapter?.()
          releaseDirectory?.()
        })
      } catch {
        releaseAdapter?.()
        releaseDirectory?.()
      }
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-codearts: loopback shim failed to start; provider not registered', error)
    })
}
