/**
 * Same-origin status + token routes for the CodeArts card.
 *
 * Minimal surface vs dsh-codebuddy-cli. The browser half calls these to read
 * sign-in state / model list / the account list / local usage / credits, to add
 * or remove accounts, and to claim the daily check-in credits. The route
 * answers loopback browser requests only and never returns token material.
 *
 * @module dsh-codearts/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CodeArtsAccountStore, CodeArtsAccountSummary } from './auth.ts'
import { MANUAL_ACCOUNT_ID, credentialFromOAuth } from './auth.ts'
import type { AccountRuntime } from './account-pool.ts'
import type { CodeArtsCatalog, CodeArtsModelInfo } from './catalog.ts'
import type { CodeArtsCreditSnapshot, CodeArtsCreditState } from './credits.ts'
import type { CodeArtsQueueEntry } from './queue.ts'
import type { UsageSnapshot, UsageTotals } from './usage.ts'
import { CODEARTS_VERSION } from './version.ts'
// 卡片只认 web-status 这一份状态契约，所以契约里用到的积分类型要跟着转出去 ——
// 否则 client 侧只能越过本模块去直引 credits.ts。
export type { CodeArtsCreditSnapshot, CodeArtsCreditState } from './credits.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { probePiAiCompat } from './pi-ai-compat.ts'
import {
  chatStream,
  contextWindowOverrideFor,
  firstFrameError,
  isModelNotAccessible,
  modelUnavailableReasonText,
  prepareChatBody,
  upstreamErrorMessage,
} from './upstream.ts'
import {
  clearBenefitBlocked,
  creditRatioLabel,
  filterEnabledModels,
  forgetModelUnavailable,
  isBenefitBlocked,
  isBenefitModel,
  markModelUnavailable,
  modelUnavailableReason,
} from './catalog.ts'
import { fetchCallerIdentity, type CallerIdentity, type CodeArtsWelfareState } from './upstream.ts'
import { startLogin, type LoginSession, type OAuthToken } from './oauth.ts'
// 领取结果里的 state 也是卡片要认的契约，同上不外露 upstream 模块。
export type { CodeArtsWelfareState } from './upstream.ts'

/** 登录后问身份的超时：它是「顺手做对」，不能拖住登录落库。 */
const IDENTITY_TIMEOUT_MS = 8_000

/** Route paths (same-origin under the DSH web origin). */
export const CODEARTS_STATUS_PATH = '/api/codearts/status'
export const CODEARTS_MODELS_PATH = '/api/codearts/models'
export const CODEARTS_MODELS_SELECTION_PATH = '/api/codearts/enabled-models'
/**
 * POST /api/codearts/context-window — 按模型设置/清除上下文窗口覆盖（issue #9）。
 * `{ id, window }`，`window: null` 表示删除覆盖、回到跟随上游。
 */
export const CODEARTS_CONTEXT_WINDOW_PATH = '/api/codearts/context-window'
export const CODEARTS_TOKEN_PATH = '/api/codearts/token'
export const CODEARTS_LOGIN_PATH = '/api/codearts/login'
export const CODEARTS_LOGIN_STATUS_PATH = '/api/codearts/login/status'
/** 删除某个账号：DELETE /api/codearts/accounts?id=<accountId> */
export const CODEARTS_ACCOUNTS_PATH = '/api/codearts/accounts'
/** POST /api/codearts/claim — 领一次福利中心的每日签到积分（幂等由上游按天去重）。 */
export const CODEARTS_CLAIM_PATH = '/api/codearts/claim'
/** POST /api/codearts/refresh-models — 立刻重拉一次模型目录，并清掉「福利今日不可用」标记。 */
export const CODEARTS_REFRESH_MODELS_PATH = '/api/codearts/refresh-models'
/**
 * POST /api/codearts/test-model — 用最小请求实测某个模型能不能调通。
 *
 * 存在理由：上游的模型清单会列出调不动的模型（`InferHub.ModelArts.81003.401`），
 * 刷新救不了；只有真发一次请求才知道。成功会清掉该模型的「异常」标记。
 */
export const CODEARTS_TEST_MODEL_PATH = '/api/codearts/test-model'
/** GET /api/codearts/queue — 上游排队位置（只在等开流期间有值，底部积分条旁边展示）。 */
export const CODEARTS_QUEUE_PATH = '/api/codearts/queue'
/**
 * GET/POST /api/codearts/dock — 对话底部那一行的显隐开关。
 * GET 给当前值与 writable，POST 收 `{credits?, queue?}` 写进 settings。
 */
export const CODEARTS_DOCK_PATH = '/api/codearts/dock'
/**
 * POST /api/codearts/keeper/stop — 结束常驻守护进程，并把开关**同时**关掉。
 *
 * 为什么必须在服务端把开关一起关：进程被 kill 之后，「开关开着但没进程」是个自相
 * 矛盾的状态。若只杀进程不改开关，用户下次打开 DSH 会看到开关还是开的、PID 却是空
 * 的，以为功能坏了；而且插件会按「开关是开的」去重起它 —— 用户刚 kill 掉的东西自己
 * 又回来了。所以这两件事必须原子地一起做。
 */
export const CODEARTS_KEEPER_STOP_PATH = '/api/codearts/keeper/stop'
/** 最近出站请求的**形状**摘要（只有 role 名与计数，不含内容），排障用。 */
export const CODEARTS_DEBUG_PATH = '/api/codearts/debug'
/**
 * GET /api/codearts/doctor — 把 CLI `doctor` 的静态体检搬进卡片。
 *
 * 只做本机可判定的检查（版本、账号、凭证有效期、目录、账本、pi-ai 兼容），
 * 不额外打上游 —— 卡片本来就每 60 秒刷一次状态，不该因为点了体检再等超时。
 */
export const CODEARTS_DOCTOR_PATH = '/api/codearts/doctor'

/** 勾选 UI 的一个选项。 */
export interface CodeArtsModelChoice {
  id: string
  name: string
  /** 走限时福利路由的模型（不是「免费随便用」，是单独的福利权益）。 */
  benefit?: boolean
  /** 福利今天被上游判定缺失（InferHub.4004.200），卡片据此置灰。 */
  blocked?: boolean
  /** 已格式化的积分倍率（`x0.18`；福利恒为 `x0.00`，上游没给倍率时缺省）。 */
  ratio?: string
  /** 支持图片输入（卡片据此挂「识图」Tag；纯文本模型缺省）。 */
  supportsImages?: boolean
  /**
   * 上下文窗口（生效值：用户覆盖或实测上界压低之后的结果）。
   *
   * 卡片用它显示「1M 上下文」这类规格，也是窗口输入框的当前值。
   */
  contextWindow?: number
  /**
   * 上游标称的窗口（未被覆盖/学习改动过的原值）。
   *
   * 有它卡片才能判断「这个数字是不是用户自己设的」，以及把输入框清空后应该回到哪。
   */
  contextWindowDiscovered?: number
  /** 用户给这个模型设的窗口覆盖值（issue #9）；undefined 表示跟随上游。 */
  contextWindowOverride?: number
  /** 单次输出上限（endpoint 元数据或实测天花板）。 */
  maxTokens?: number
  /**
   * 上游今天判定该模型不可用（如 `InferHub.ModelArts.81003.401`）的原因。
   *
   * 卡片挂一个「异常」Tag，悬浮显示这段原因；**不**替用户取消勾选。
   */
  error?: string
}

/** enabled-models 路由返回的 selection 文档（与 codebuddy 的 shape 对齐）。 */
export interface CodeArtsModelSelection {
  choices: { id: string; name: string; enabled: boolean; benefit?: boolean; blocked?: boolean; ratio?: string; supportsImages?: boolean; contextWindow?: number; contextWindowDiscovered?: number; contextWindowOverride?: number; maxTokens?: number; error?: string }[]
  /** 已选子集是否小于全集（卡片据此显示不同提示）。 */
  restricted: boolean
  /** 是否可写（无 settings provider 时为 false，卡片只读）。 */
  writable: boolean
}

/**
 * 由完整目录 + 已存 enabled 计算 selection。
 * - enabled 为空/未存 => 全部勾选（restricted=false）
 * - enabled 为非空列表 => 仅勾选其中的（restricted=true），缺的按未勾选
 * 福利模型用 catalog 的 benefit 标记（这里靠 model.benefit 字段，由调用方注入）。
 */
export function selectionOf(
  models: readonly CodeArtsModelChoice[],
  enabled: readonly string[] | undefined,
  writable: boolean,
): CodeArtsModelSelection {
  const allowed = new Set(enabled ?? [])
  const restricted = enabled !== undefined && enabled.length > 0
  const choices = models.map(m => ({
    id: m.id,
    name: m.name,
    benefit: m.benefit,
    blocked: m.blocked,
    ratio: m.ratio,
    supportsImages: m.supportsImages,
    contextWindow: m.contextWindow,
    contextWindowDiscovered: m.contextWindowDiscovered,
    contextWindowOverride: m.contextWindowOverride,
    maxTokens: m.maxTokens,
    ...(m.error === undefined ? {} : { error: m.error }),
    enabled: restricted ? allowed.has(m.id) : true,
  }))
  return { choices, restricted, writable }
}

/** 目录 -> 勾选 UI 的选项（福利标记、今日不可用标记与倍率都在这里算）。 */
function choicesOf(deps: CodeArtsStatusRouteOptions): CodeArtsModelChoice[] {
  const overrides = deps.contextWindowOverrides?.()
  return deps.models().map(m => {
    const benefit = isBenefitModel(m.id)
    const ratio = creditRatioLabel(m.ratio, benefit)
    const error = modelUnavailableReason(m.id)
    const override = contextWindowOverrideFor(overrides, m.id)
    return {
      id: m.id,
      name: m.name,
      benefit,
      blocked: isBenefitBlocked(m.id),
      ...(ratio === undefined ? {} : { ratio }),
      ...(m.supportsImages === true ? { supportsImages: true } : {}),
      ...(m.contextWindowKnown === true ? { contextWindow: m.contextWindow } : {}),
      // 生效值和上游标称值不同才带原值：卡片据此把输入框还原成「跟随上游」。
      ...(m.contextWindowDiscovered === undefined ? {} : { contextWindowDiscovered: m.contextWindowDiscovered }),
      ...(override === undefined ? {} : { contextWindowOverride: override }),
      ...(m.maxTokens > 0 ? { maxTokens: m.maxTokens } : {}),
      ...(error === undefined ? {} : { error }),
    }
  })
}

/**
 * 目录 -> 底栏/卡片用的模型徽章。
 *
 * 倍率在这里就算好（`creditRatioLabel`：福利恒为 `x0.00`），客户端拿到的是可以直接
 * 印出来的字符串 —— 底栏那一行要把它作为独立的一段，所以不能只给带尾巴的名字。
 */
function modelBadgesOf(models: readonly CodeArtsModelInfo[]): CodeArtsWebModelBadge[] {
  return models.map(m => {
    const ratio = creditRatioLabel(m.ratio, isBenefitModel(m.id))
    return { id: m.id, name: m.name, ...(ratio === undefined ? {} : { ratio }) }
  })
}

/**
 * 领取福利的结果。
 *
 * `ok` 是「这次请求跑通了没有」，`claimed` 才是「积分真的加上了」——
 * 今天已领 / 账号没有这个活动都算 ok 但没 claimed，UI 不该把它们当报错。
 */
export interface CodeArtsClaimOutcome {
  ok: boolean
  claimed: boolean
  state: CodeArtsWelfareState
  amount: number
  message: string
}

/** 批量领取时每个账号各自的结果。 */
export interface CodeArtsClaimAccountResult extends CodeArtsClaimOutcome {
  id: string
}

export interface CodeArtsClaimResult extends CodeArtsClaimOutcome {
  /** 一次领多个账号时逐号给出结果；单账号旧调用方不看这个字段。 */
  results?: readonly CodeArtsClaimAccountResult[]
}

/** 某个账号的积分：成功给快照，失败给原因 —— 一个号拉不到不影响别的号。 */
export interface CodeArtsAccountCredits {
  id: string
  credits?: CodeArtsCreditSnapshot
  creditsError?: string
}

/**
 * 对话底部那一行的显隐开关，外加侧边栏入口。
 *
 * 两个字段各管一件事：积分数字是常驻的，排队提示只在等开流时出现。分成两个开关
 * 是因为「不想常驻一个数字」和「别告诉我为什么在等」是两种完全不同的诉求。
 * `sidebar` 是第三件事：要不要在 DSH 侧边栏占一格（点开是整页版卡片）。
 */
export interface CodeArtsDockFlags {
  /** 剩余积分那一行。 */
  credits: boolean
  /** 上游排队位置提示（属于「Model 及其右侧」那一段，与 modelDetail 同进同退）。 */
  queue: boolean
  /** DSH 侧边栏里的 CodeArts 入口。 */
  sidebar: boolean
  /**
   * 设置左侧导航里的 CodeArts 入口（点开即整页版卡片）。
   *
   * 缺省 **显示**：用户找插件的第一反应是「设置里从左列找」，只挂在「内置插件 →
   * 详情页」里等于默认找不到（issue #7）。这一格与侧边栏那格不同 —— 设置导航本来就是
   * 给各个插件分组的，多一项不会挤到主界面。
   */
  settingsEntry: boolean
  /**
   * 「Model 及其右侧」（模型名、倍率、排队）。
   *
   * 只控制这一段：`Provider CodeArts` 是插件的身份标识，**常驻显示**，不受任何开关
   * 控制（用户点名要求）。关掉之后整行长这样：`积分 24,091 · Provider CodeArts`。
   */
  modelDetail: boolean
  /** 后台自动领取每日签到积分。缺省关：别默认替用户改动账号余额状态。 */
  autoClaim: boolean
  /**
   * 常驻凭证守护进程（在 DSH 之外续 refresh_token）。
   *
   * 缺省关：它会在系统里留一个后台进程，必须由用户主动打开。打开后 `/status` 的
   * `keeper` 字段会带上 pid 与最近一轮结果；进程被 kill 掉时这里会自动翻回 false。
   */
  keepAliveDaemon: boolean
}

/**
 * 守护进程在卡片上的样子。
 *
 * 只放能给人看的东西：pid、启动时刻、心跳、上一轮续期结果。**绝不含任何 token**。
 */
export interface CodeArtsKeeperView {
  /** 进程真的活着（心跳新鲜 **且** pid 还存活，两个条件都满足）。 */
  alive: boolean
  /**
   * 刚请求拉起、状态文件还没写出来。
   *
   * 与 `alive: false` 的区别很重要：这时候「没探到活」是正常的启动延迟，不能据此
   * 判定「被 kill 了」而把开关关掉。
   */
  starting?: boolean
  pid?: number
  startedAt?: number
  heartbeatAt?: number
  /** 最近一轮续期：检查了几个、续了几个、哪些号需要重新登录。 */
  lastPass?: { at: number; checked: number; refreshed: number; needsLogin: readonly string[] }
  /**
   * 打开了开关但进程没起来时，这里说明原因（脚本缺失、spawn 失败……）。
   * 有值 = 开关看着是开的，实际没在保活，卡片必须把这个冲突讲明白。
   */
  error?: string
  /** 守护进程自己的日志路径，出问题让用户能找过去。 */
  logPath?: string
}

/**
 * 开关的默认值：没有 settings provider（或老配置没这两个键）时保持原有行为 ——
 * 底部两行都显示；侧边栏相反，缺省不开（那一格是所有插件共用的全局座位）。
 * `modelDetail` 缺省开（保持老版本的样子），`autoClaim` 缺省关。
 */
export const DEFAULT_DOCK_FLAGS: CodeArtsDockFlags = {
  credits: true,
  queue: true,
  sidebar: false,
  settingsEntry: true,
  modelDetail: true,
  autoClaim: false,
  keepAliveDaemon: false,
}

/**
 * 把逐账号的领取结果汇总成一条：HTTP 层只看 ok，卡片看 results 逐号展示。
 * 有一个号失败就算整批 ok=false，但别的号领到的结果照样在 results 里。
 */
export function summarizeClaims(results: readonly CodeArtsClaimAccountResult[]): CodeArtsClaimResult {
  const failed = results.find(result => result.state === 'failed')
  const claimed = results.filter(result => result.claimed)
  const messages = [...new Set(results.map(result => result.message).filter(message => message !== ''))]
  return {
    ok: results.length > 0 && failed === undefined,
    claimed: claimed.length > 0,
    state: claimed.length > 0 ? 'claimed' : failed?.state ?? results[0]?.state ?? 'failed',
    amount: claimed.reduce((sum, result) => sum + result.amount, 0),
    message: results.length === 1 ? results[0].message : messages.join('; ').slice(0, 300),
    results,
  }
}

export interface CodeArtsWebStatus {
  status: 'signed-in' | 'signed-out' | 'expired'
  label?: string
  storedAt?: number
  models: readonly CodeArtsWebModelBadge[]
  /** 已存账号。多个账号时会自动轮转，某个号忙就换下一个。 */
  accounts: readonly CodeArtsAccountSummary[]
  /** 本机经插件发出的请求统计（账号总额度见 credits 字段，这里只记本机）。 */
  usage: CodeArtsWebUsage
  /**
   * 账号积分/额度（CodeArts 自己的积分接口，2026-10 实测可用）。
   * 省略表示插件没接这条链路或还没拉到。
   */
  credits?: CodeArtsCreditSnapshot
  /** 积分拿不到时的原因 —— 有值就说明 credits 缺席，且要让用户看见为什么。 */
  creditsError?: string
  /**
   * 每个账号各自的积分（按 account id 对齐）。多账号下 credits 只是其中一份快照，
   * 卡片要按账号展示就必须读这里。
   */
  creditsByAccount?: readonly CodeArtsAccountCredits[]
  /**
   * 对话底部那一行的显隐开关。省略 = 都显示（老宿主/老配置保持原有行为）。
   * 底部条本来就在轮询这个接口，所以开关搭车下发，不用多开一条链路。
   */
  dock?: CodeArtsDockFlags
  /** 常驻凭证守护进程的状态（只在打开了 `dock.keepAliveDaemon` 时有意义）。 */
  keeper?: CodeArtsKeeperView
  /**
   * 运行时解析到的 `@earendil-works/pi-ai` 不满足要求时的说明。
   * 有值 = 模型全跑不动（每条消息在出网前就失败），且这是版本装配问题，不是账号或网络。
   */
  piAiError?: string
}

/**
 * 卡片上的用量区块。
 *
 * 只报**本机经插件发出**的请求：上游没有任何额度/积分接口（codearts2api 的 pool 里
 * credits 恒为 0），所以卡片必须把这一点说清楚，官方额度明细在
 * `codearts.huaweicloud.com/portal/settings/personal-usage`。
 */
export interface CodeArtsWebUsage {
  /** 今天的合计。 */
  today: UsageTotals
  /** 账本里保留天数的合计。 */
  allTime: UsageTotals
  /** 最近 30 天（含今天）的合计。 */
  last30: UsageTotals
  /** 今天按模型，按 token 降序（卡片只展示前几条）。 */
  byModelToday: readonly { id: string; totals: UsageTotals }[]
  /** 今天按账号 —— 多账号时用来看是哪个号在用。 */
  byAccountToday: Record<string, UsageTotals>
  /** 账本覆盖天数。 */
  days: number
  /**
   * 最近 `TREND_DAYS` 天（含今天，按日期升序）的每日合计，没账目的日子补 0。
   * 现在是 35 天 = 5 周，正好铺满卡片热力图一屏月历的 7 列格子。
   *
   * 卡片用它画「本月 · 每日 token」那张贴格 —— 每格的悬停提示里有请求数与缓存命中率，
   * 命中率掉下来通常意味着系统提示词前缀变了或上下文变长，比只看总量更有诊断价值。
   */
  recentDays: readonly { date: string; totals: UsageTotals }[]
  /** 今天 0..23 点的逐小时合计（没到的小时补 0）。 */
  todayByHour: readonly { hour: number; totals: UsageTotals }[]
  lastAt?: number
  /** 今天的失败次数与类别（失败率的分母是成功请求数 + 这里的 total）。 */
  failuresToday: { total: number; byKind: Record<string, number> }
  /** 今天按账号的失败次数。 */
  failuresByAccountToday: Record<string, number>
  /** 今天的首字延迟分位；样本为 0 时 p50/p95 缺省。 */
  latencyToday: { samples: number; p50?: number; p95?: number; overflow: boolean }
  /** 每个账号的会话槽位占用与池状态 —— 这是「为什么刚才要等」的直接答案。 */
  slots: readonly CodeArtsWebAccountSlot[]
}

export interface CodeArtsWebAccountSlot {
  id: string
  /** 本机正在飞的请求数 / 允许的并发数。 */
  active: number
  max: number
  /** 账号池里的状态。 */
  state: 'ok' | 'capped' | 'cooling' | 'disabled'
  /** 卡片用的说明文字（英文，由卡片侧本地化）。 */
  detail?: string
}

export interface CodeArtsWebModelBadge {
  id: string
  name: string
  /**
   * 已格式化的积分倍率（`x0.18`；福利恒为 `x0.00`，上游没给倍率的模型缺省）。
   *
   * `name` 里其实已经带了同样的尾巴（见 catalog 的 modelDisplayName），底栏为了让
   * 倍率成为独立的一段（`Model X · x0.18`，与 dsh-codebuddy-cli 的底栏同构），
   * 需要把这两件事分开拿，所以这里单列一个字段而不是让客户端去拆名字。
   */
  ratio?: string
}

/** 体检里的一条检查。`id` 是稳定标识，卡片按它选本地化文案。 */
export interface CodeArtsDoctorCheck {
  id: string
  ok: boolean
  /** 已格式化的说明（账号 id、有效期、模型数等）；卡片直接印，不再拼。 */
  detail?: string
}

export interface CodeArtsDoctorReport {
  ok: boolean
  version: string
  node: string
  checks: CodeArtsDoctorCheck[]
  /** 需要用户动手的建议（与 checks 里的失败项对应，但合并成一句话更好读）。 */
  hints: string[]
}

export interface CodeArtsStatusRouteOptions {
  store: CodeArtsAccountStore
  models: () => readonly CodeArtsModelInfo[]
  enabledModels?: () => readonly string[] | undefined
  /** 账号池运行时（槽位占用/冷却/禁用）。省略则卡片不显示槽位区块。 */
  pool?: () => readonly AccountRuntime[]
  /**
   * 凭据换新（登录成功/手动贴 token）后复活池里的账号：清掉 disabled 与冷却。
   * 省略则「重新登录」不影响池状态（disabled 只能靠重启清掉，见 issue #1）。
   */
  reviveAccount?: (id: string) => void
  /** 用量账本快照。省略则卡片不显示用量区块。 */
  usage?: () => UsageSnapshot
  /**
   * 拉一次账号积分（内部应带缓存，别每次刷新都打上游）。
   * 省略则卡片不显示积分区块。
   */
  credits?: (signal?: AbortSignal) => Promise<readonly CodeArtsAccountCredits[]>
  /**
   * 领每日签到积分（福利中心 /v1/ops/delivery + /v1/ops/claim）。
   * 省略 id 时逐个可用账号都领一遍；上游按天去重，重复领返回 already。
   */
  claim?: (accountId?: string) => Promise<CodeArtsClaimResult>
  /**
   * 后台自动领取那一轮的结果：先跑一次全量领取，再把它记成「上次自动领取」。
   *
   * 与 `claim` 分开是为了留痕：自动领取在用户看不见的时候动他的余额，卡片必须能
   * 说清「上次是什么时候领的、领到没有、领了多少」，否则这个开关等于黑箱。
   */
  autoClaim?: () => Promise<CodeArtsClaimResult>
  /**
   * 立刻重拉一次模型目录（不等每小时那一次）。
   *
   * 存在的理由：限时福利名单会变（模型被移出/转正），而唯一权威来源 `gateway/config`
   * 只在发现流程里拉。上游轮换后，用户需要一个立刻见效的出口。
   */
  refreshModels?: () => Promise<{ models: number; benefit: number; refreshed: boolean }>
  /** 当前在上游排队、值得展示的请求。省略则卡片不显示排队信息。 */
  queue?: () => readonly CodeArtsQueueEntry[]
  /** 最近几次出站请求的形状摘要（`/api/codearts/debug`）。 */
  recentRequests?: () => readonly unknown[]
  /** 最近几帧 usage 的原样内容（`/api/codearts/debug`），用来确认上游是否下发缓存字段。 */
  recentUsages?: () => readonly unknown[]
  /**
   * Persist a new allowlist. Resolves false when no settings provider is
   * attached, which the card renders as a read-only selection.
   */
  setEnabledModels?: (ids: readonly string[]) => Promise<boolean>
  /**
   * 用户按模型 id 配置的上下文窗口覆盖值（issue #9）。
   *
   * 免费档的真实窗口远小于目录标称的 1M，而且会漂 —— 没有覆盖项时用户只能等上游修。
   * 省略则卡片不显示窗口输入框与滑块。
   */
  contextWindowOverrides?: () => Readonly<Record<string, number>> | undefined
  /**
   * 写入或清除某个模型的窗口覆盖（`window: null` = 回到跟随上游）。
   *
   * 返回 false 表示没接 settings provider，卡片据此把输入框置灰。
   */
  setContextWindowOverride?: (id: string, window: number | null) => Promise<boolean>
  /**
   * 对话底部那一行的显隐开关当前值。省略则 /status 不带 dock 字段（= 都显示）。
   */
  dock?: () => CodeArtsDockFlags
  /** 写入显隐开关。返回 false 表示没接 settings provider，卡片据此把勾选框置灰。 */
  setDock?: (patch: Partial<CodeArtsDockFlags>) => Promise<boolean>
  /**
   * 守护进程的当前状态（pid、心跳、上一轮续期结果）。
   *
   * 每次 `/status` 都现算：pid 可能刚被用户 kill 掉，缓存一个「上次还是活的」快照
   * 会让卡片一直显示一个已经不存在的进程号。
   *
   * 允许返回 Promise，是因为实现方要在这条路径上做一次状态对账 —— 「开关开着但进程
   * 没了」必须当场把开关关掉，而写开关是异步的。
   */
  keeper?: () => CodeArtsKeeperView | Promise<CodeArtsKeeperView>
  /**
   * 结束守护进程（卡片上那个「结束」按钮）。
   *
   * 只杀进程、不改开关的话会留下「开关开着却没进程」的自相矛盾状态，而且插件下次
   * 启动会按开关把它重新拉起来 —— 用户刚 kill 掉的东西自己回来了。所以处理函数杀完
   * 会**紧接着**把 `keepAliveDaemon` 写成 false，见 `keeperStopHandler`。
   */
  stopKeeper?: () => Promise<{ ok: boolean; pid?: number; reason?: string }>
  /**
   * 丢掉积分缓存后重拉一次（弹层上那个「刷新积分」按钮）。
   * 省略时 `?force=1` 退回普通缓存读取 —— 顶多是不新鲜，不该报错。
   */
  refreshCredits?: (signal?: AbortSignal) => Promise<readonly CodeArtsAccountCredits[]>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Build the status document (no token material crosses to the browser). */
/**
 * 登录后立刻问一次身份（有超时，失败返回 null）。
 *
 * 这一步是「尽量做对」而不是必须：拿不到身份也要能把账号存下来，只是会退回
 * 「每次登录各自成一条」的旧行为。
 */
async function probeIdentity(token: OAuthToken): Promise<CallerIdentity | null> {
  const credential = {
    token: token.securityToken,
    accessKeyId: token.accessKeyId,
    secretAccessKey: token.secretAccessKey,
    securityToken: token.securityToken,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS)
  timer.unref?.()
  try {
    return await fetchCallerIdentity(credential, controller.signal)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 一次登录落库的结果：`replaced` 表示凭证写回指定账号，`conflict` 表示登错了号。 */
interface LoginSettlement {
  /** 落库后的账号 id（可能因并入稳定身份键而与目标 id 不同）。 */
  id: string
  replaced: boolean
  conflict: boolean
}

/**
 * 落一次 OAuth 登录的凭证。
 *
 * 不带 `targetId` 是「添加账号」：同一账号更新，别的账号新增。
 *
 * 带 `targetId` 是「重新登录这个账号」：凭证写回原条目（保留 id、展示顺序和
 * 备注），而不是又长出一条 —— 以前卡片上只有「删除」，用户遇到凭证过期只能
 * 先把账号删掉再加回来，顺序和备注都丢。
 *
 * 上游只在 `fetchCallerIdentity` 成功时才给稳定 `userId`，拿不到身份就判断不了
 * 「是不是同一个人」。此时按用户意图替换（他点的就是这个账号的重登），并沿用
 * 旧条目的身份字段；只有两边 `userId` 都非空且不同，才判为登了另一个账号，
 * 退回「新增」，原账号原样不动。
 */
async function settleLogin(
  deps: CodeArtsStatusRouteOptions,
  token: OAuthToken,
  targetId: string | undefined,
): Promise<LoginSettlement> {
  const identity = await probeIdentity(token)
  const target = targetId === undefined ? undefined : await deps.store.credential(targetId)
  // 登录期间该账号被删了：别凭空复活一个用户刚删掉的号，按新增处理。
  if (targetId !== undefined && target !== undefined) {
    const known = typeof target.userId === 'string' && target.userId !== ''
    const otherAccount = identity !== null && known && target.userId !== identity.userId
    if (!otherAccount) {
      const cred = credentialFromOAuth(token, target.label)
      // 身份探测失败时沿用旧字段：把它们抹掉，下次「重新登录」又会多出一条。
      cred.userId = cred.userId || target.userId
      cred.userName = cred.userName || target.userName
      cred.domainId = cred.domainId || target.domainId
      const id = await deps.store.upsert(cred, targetId)
      deps.reviveAccount?.(id)
      if (identity !== null && identity.userId !== '') {
        // 老条目若还是 DPoP 键，借这次登录并入稳定身份键 —— 否则同一个号会一直
        // 在「DPoP 键 + userId 键」之间来回多出一条。
        if (identity.userId !== id) await deps.store.adoptIdentity(id, identity)
        deps.reviveAccount?.(identity.userId)
        return { id: identity.userId, replaced: true, conflict: false }
      }
      return { id, replaced: true, conflict: false }
    }
  }
  const id = await deps.store.upsertFromOAuth(token, undefined, identity ?? undefined)
  // 身份已有、但这次是用老键（DPoP）新建的条目：并入稳定键，避免重复账号。
  if (identity !== null && id !== identity.userId) {
    await deps.store.adoptIdentity(id, identity)
  }
  // 凭据已换新：把这个号从禁用/冷却里捞出来（含 adopt 前后的两个键）。
  // 没有这个，「重新登录」对已被禁用的账号完全无效（issue #1）。
  deps.reviveAccount?.(id)
  if (identity !== null && identity.userId !== id) deps.reviveAccount?.(identity.userId)
  return { id: identity?.userId ?? id, replaced: false, conflict: target !== undefined }
}

/** 账号还能用吗（没被标 stale、也没过期）。 */
function accountUsable(summary: CodeArtsAccountSummary): boolean {  if (summary.stale) return false
  if (typeof summary.expiration !== 'string') return true
  const at = Date.parse(summary.expiration)
  return !Number.isFinite(at) || at > Date.now()
}

/** 池状态 -> 卡片能直接渲染的槽位信息。 */
function slotsOf(deps: CodeArtsStatusRouteOptions): CodeArtsWebAccountSlot[] {
  const runtime = deps.pool?.() ?? []
  const now = Date.now()
  return runtime.map(account => {
    const state: CodeArtsWebAccountSlot['state'] = account.disabled
      ? 'disabled'
      : now < account.coolUntil
        ? 'cooling'
        : now < account.cappedUntil
          ? 'capped'
          : 'ok'
    const detail = state === 'capped'
      ? `upstream session cap hit; avoiding it for ~${Math.ceil((account.cappedUntil - now) / 1000)}s`
      : state === 'cooling'
        ? `cooling down for ~${Math.ceil((account.coolUntil - now) / 1000)}s`
        : state === 'disabled'
          ? account.lastError ?? 'disabled'
          : undefined
    return {
      id: account.id,
      active: account.activeConcurrent,
      max: account.maxConcurrent,
      state,
      ...(detail === undefined ? {} : { detail }),
    }
  })
}

/** 用量账本 -> 卡片文档；没有账本（未注入）时给一份空壳，卡片就不会瞎显示。 */
function usageOf(deps: CodeArtsStatusRouteOptions): CodeArtsWebUsage {
  const snapshot: UsageSnapshot | undefined = deps.usage?.()
  const noTotals: UsageTotals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  }
  return {
    today: snapshot?.today ?? noTotals,
    allTime: snapshot?.allTime ?? noTotals,
    last30: snapshot?.last30 ?? noTotals,
    byModelToday: snapshot?.byModelToday ?? [],
    byAccountToday: snapshot?.byAccountToday ?? {},
    days: snapshot?.days ?? 0,
    recentDays: snapshot?.recentDays ?? [],
    todayByHour: snapshot?.todayByHour ?? [],
    failuresToday: snapshot?.failuresToday ?? { total: 0, byKind: {} },
    failuresByAccountToday: snapshot?.failuresByAccountToday ?? {},
    latencyToday: snapshot?.latencyToday ?? { samples: 0, overflow: false },
    ...snapshot?.lastAt === undefined ? {} : { lastAt: snapshot.lastAt },
    slots: slotsOf(deps),
  }
}

/**
 * 积分区块。
 *
 * 积分是「锦上添花」：拉不到也绝不能把状态接口本身拖垮，所以失败一律降级成
 * `creditsError` 交给卡片显示原因（超时由注入方在自己的闭包里保证）。
 *
 * `force` 是给对话底部弹层那个「刷新积分」按钮用的：不强制的话它会命中 60 秒缓存，
 * 按钮点了数字不动 —— 那还不如不给这个按钮。
 */
async function creditsOf(
  deps: CodeArtsStatusRouteOptions,
  force: boolean,
): Promise<Partial<CodeArtsWebStatus>> {
  const load = force ? (deps.refreshCredits ?? deps.credits) : deps.credits
  if (load === undefined) return {}
  try {
    const entries = await load()
    // credits / creditsError 保留给对话底部的单行积分条：取第一份拿到的快照。
    const primary = entries.find(entry => entry.credits !== undefined) ?? entries[0]
    return {
      ...primary?.credits === undefined ? {} : { credits: primary.credits },
      ...primary?.credits === undefined && primary?.creditsError !== undefined
        ? { creditsError: primary.creditsError }
        : {},
      ...entries.length === 0 ? {} : { creditsByAccount: entries },
    }
  } catch (error: unknown) {
    return { creditsError: safeMessage(error) }
  }
}

async function buildStatus(deps: CodeArtsStatusRouteOptions, force = false): Promise<CodeArtsWebStatus> {
  const models = modelBadgesOf(deps.models())
  const accounts = await deps.store.list()
  const cred = await deps.store.current()
  const usage = usageOf(deps)
  const dock = deps.dock === undefined ? {} : { dock: deps.dock() }
  // 守护进程状态每次现算：用户随时可能从卡片上把它 kill 掉，缓存一份「上次还活着」
  // 的快照会让界面一直显示一个已经不存在的 pid。这里 await，是因为实现方在这条路径上
  // 会顺手把「开关开着但进程已死」的开关关掉（对账是异步的）。
  const keeperView = deps.keeper === undefined ? {} : { keeper: await deps.keeper() }
  // pi-ai 版本不兼容时模型全不可用，但状态接口本身还能用 —— 原因必须在这里给出去，
  // 否则用户只看到每条消息一句「本轮运行失败」。
  const piAi = await probePiAiCompat()
  const compat = piAi === undefined ? {} : { piAiError: piAi }

  if (accounts.length === 0 || cred === undefined) {
    return { status: 'signed-out', models, accounts, usage, ...dock, ...keeperView, ...compat }
  }
  // 只要还有**任意一个**账号能用就算登录中 —— 别的号过期了不影响轮转。
  const usable = accounts.some(accountUsable)
  const identity = {
    ...cred.label === undefined ? {} : { label: cred.label },
    ...cred.storedAt === undefined ? {} : { storedAt: cred.storedAt },
    models,
    accounts,
    usage,
    ...dock,
    ...keeperView,
  }
  // 没有可用账号时不问积分：凭证都过期了，问了也是白跑一趟（还得等超时）。
  if (!usable) return { status: 'expired', ...identity, ...compat }
  return { status: 'signed-in', ...identity, ...compat, ...await creditsOf(deps, force) }
}

/** GET /api/codearts/status */
function statusHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      const url = new URL(req.url ?? '', 'http://localhost')
      const force = url.searchParams.get('force') === '1'
      json(res, 200, await buildStatus(deps, force))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/**
 * 本机体检：与 CLI 的 `doctor` 同一份判据，但只做不联网的检查。
 *
 * 这里的每一项都能在 1ms 内判定；需要网络的（凭证能不能续期、上游目录是否正常）
 * 已经在 /status 与 /refresh-models 里体现，重复做只会让「体检」按钮转圈。
 */
async function doctorReport(deps: CodeArtsStatusRouteOptions): Promise<CodeArtsDoctorReport> {
  const accounts = await deps.store.list()
  const models = deps.models()
  const checks: CodeArtsDoctorCheck[] = []
  const hints = new Set<string>()

  checks.push({
    id: 'runtime',
    ok: true,
    detail: `dsh-codearts ${CODEARTS_VERSION} · node ${process.version} · ${process.platform}`,
  })

  checks.push({
    id: 'accounts',
    ok: accounts.length > 0,
    detail: `${accounts.length}`,
  })
  if (accounts.length === 0) hints.add('no-account')

  for (const account of accounts) {
    const problems: string[] = []
    if (account.stale) problems.push('stale')
    if (!account.signable) problems.push('no-key')
    if (account.expiration !== undefined) {
      const expiresAt = Date.parse(account.expiration)
      if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) problems.push('expired')
    }
    checks.push({
      id: `account:${account.id}`,
      ok: problems.length === 0,
      detail: problems.length > 0
        ? problems.join(',')
        : (account.label ?? account.userName ?? account.expiration ?? 'ok'),
    })
    for (const problem of problems) hints.add(`account-${problem}`)
  }

  checks.push({ id: 'models', ok: models.length > 0, detail: `${models.length}` })
  if (models.length === 0) hints.add('empty-catalog')

  checks.push({
    id: 'usage',
    ok: deps.usage !== undefined,
    detail: deps.usage === undefined ? 'tracker not wired' : 'local ledger',
  })
  if (deps.usage === undefined) hints.add('usage-missing')

  if (process.env.DSH_HOME === undefined) hints.add('dsh-home-missing')

  // pi-ai 探测带缓存（同一个宿主版本只探一次），放在这里不会变成一次慢请求。
  const piAi = await probePiAiCompat()
  checks.push({ id: 'pi-ai', ok: piAi === undefined, ...(piAi === undefined ? {} : { detail: piAi }) })
  if (piAi !== undefined) hints.add('pi-ai')

  return {
    ok: checks.every(check => check.ok),
    version: CODEARTS_VERSION,
    node: process.version,
    checks,
    hints: [...hints],
  }
}

/** GET /api/codearts/doctor */
function doctorHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await doctorReport(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}
/**
 * GET/POST /api/codearts/dock — 对话底部那一行的显隐开关读写。
 *
 * 和 enabled-models 同一套规矩：GET 给当前值 + writable，POST 只收布尔、
 * 没接 settings provider 时回 403 让卡片把勾选框置灰。
 */
function dockHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const current = deps.dock?.() ?? DEFAULT_DOCK_FLAGS
    if (req.method === 'GET') {
      json(res, 200, { dock: current, writable: deps.setDock !== undefined })
      return
    }
    if (req.method === 'POST') {
      if (deps.setDock === undefined) {
        json(res, 403, { error: 'dock-not-writable' })
        return
      }
      const type = req.headers['content-type']
      if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
        json(res, 415, { error: 'content-type must be application/json' })
        return
      }
      try {
        const body = JSON.parse(await readBody(req)) as {
          credits?: unknown
          queue?: unknown
          sidebar?: unknown
          settingsEntry?: unknown
          modelDetail?: unknown
          autoClaim?: unknown
          keepAliveDaemon?: unknown
        }
        const keys = ['credits', 'queue', 'sidebar', 'settingsEntry', 'modelDetail', 'autoClaim', 'keepAliveDaemon'] as const
        const touched = keys.filter(key => body[key] !== undefined)
        if (touched.length === 0 || touched.some(key => typeof body[key] !== 'boolean')) {
          json(res, 400, {
            error: 'expected {"credits"?: boolean, "queue"?: boolean, "sidebar"?: boolean, "settingsEntry"?: boolean, "modelDetail"?: boolean, "autoClaim"?: boolean, "keepAliveDaemon"?: boolean}',
          })
          return
        }
        const ok = await deps.setDock(Object.fromEntries(
          touched.map(key => [key, body[key] as boolean]),
        ))
        if (!ok) {
          json(res, 403, { error: 'dock-not-writable' })
          return
        }
        json(res, 200, { dock: deps.dock?.() ?? DEFAULT_DOCK_FLAGS, writable: true })
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }
}

/**
 * POST /api/codearts/keeper/stop — 结束守护进程，并把开关一起关掉。
 *
 * 顺序不能反：先杀进程、再写开关。反过来的话，写开关的那一瞬间如果正好触发了插件的
 * 重排（`armKeepAliveDaemon`），它会按「开关是开的」再起一个 —— 用户点一次结束，
 * 结果又冒出来一个新 pid。杀完再写，重排看到的是 false，自然什么都不做。
 */
function keeperStopHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (deps.stopKeeper === undefined) {
      json(res, 503, { error: 'keeper-control-unavailable' })
      return
    }
    try {
      const outcome = await deps.stopKeeper()
      // 即使 kill 失败（比如没权限）也把开关关掉：留着「开着却没进程」比关掉更糟 ——
      // 用户点结束的意图是明确的，失败原因在 outcome.reason 里给出去。
      const writable = deps.setDock === undefined
        ? false
        : await deps.setDock({ keepAliveDaemon: false }).catch(() => false)
      json(res, outcome.ok ? 200 : 500, {
        ok: outcome.ok,
        ...outcome.pid === undefined ? {} : { pid: outcome.pid },
        ...outcome.reason === undefined ? {} : { reason: outcome.reason },
        writable,
        dock: deps.dock?.() ?? DEFAULT_DOCK_FLAGS,
      })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** GET /api/codearts/models — currently offered model ids (honours allowlist). */
function modelsHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const offered = filterEnabledModels(deps.models(), deps.enabledModels?.())
    json(res, 200, { models: modelBadgesOf(offered) })
  }
}

/**
 * GET/POST /api/codearts/enabled-models — 模型勾选的读写。
 * GET 返回 selection（choices + restricted + writable）；POST 接收 {enabledModels}
 * 写入 settings（全选时传空数组表示"全部"）。与 codebuddy 的 /plugins/<id>/enabled-models 对齐。
 */
function modelsSelectionHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (req.method === 'GET') {
      const all = choicesOf(deps)
      const writable = deps.setEnabledModels !== undefined
      const selection = selectionOf(all, deps.enabledModels?.(), writable)
      json(res, 200, { selection })
      return
    }
    if (req.method === 'POST') {
      if (!deps.setEnabledModels) {
        json(res, 403, { error: 'selection-not-writable' })
        return
      }
      const type = req.headers['content-type']
      if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
        json(res, 415, { error: 'content-type must be application/json' })
        return
      }
      try {
        const body = JSON.parse(await readBody(req)) as { enabledModels?: unknown }
        if (!Array.isArray(body.enabledModels) || !body.enabledModels.every(x => typeof x === 'string')) {
          json(res, 400, { error: 'expected {"enabledModels": string[]}' })
          return
        }
        const ok = await deps.setEnabledModels(body.enabledModels as string[])
        if (!ok) {
          json(res, 403, { error: 'selection-not-writable' })
          return
        }
        const all = choicesOf(deps)
        const selection = selectionOf(all, deps.enabledModels?.(), true)
        json(res, 200, { selection })
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }
}

/**
 * POST /api/codearts/context-window { id, window } — 按模型覆盖上下文窗口。
 *
 * 存在的理由（issue #9）：目录给的是上游标称窗口，免费档实际能装下的往往差一半，
 * 而超限时上游只回一句「参数非法」、不指名参数。`window: null` 删除覆盖、回到跟随上游。
 */
function contextWindowHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (deps.setContextWindowOverride === undefined) {
      json(res, 403, { error: 'context-window-not-writable' })
      return
    }
    const type = req.headers['content-type']
    if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req)) as { id?: unknown; window?: unknown }
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        json(res, 400, { error: 'expected {"id": string, "window": number|null}' })
        return
      }
      let window: number | null = null
      if (body.window !== null && body.window !== undefined) {
        if (typeof body.window !== 'number' || !Number.isFinite(body.window) || body.window <= 0) {
          json(res, 400, { error: 'window must be a positive number or null' })
          return
        }
        window = Math.floor(body.window)
      }
      const ok = await deps.setContextWindowOverride(id, window)
      if (!ok) {
        json(res, 403, { error: 'context-window-not-writable' })
        return
      }
      // 回整份 selection（和 enabled-models 一样）：卡片一次替换，不用自己拼状态。
      const all = choicesOf(deps)
      json(res, 200, { selection: selectionOf(all, deps.enabledModels?.(), true) })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** POST /api/codearts/token { token, label? } — store a pasted token. */
function tokenPostHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    // A state-changing route that writes a credential: gate on Host *and*
    // Origin like every other mutating route. Host alone would let a
    // DNS-rebinding page (attacker origin, loopback Host) store a token.
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const type = req.headers['content-type']
    if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
      json(res, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = JSON.parse(await readBody(req))
      const token = typeof body?.token === 'string' ? body.token.trim() : ''
      if (token === '') {
        json(res, 400, { error: 'expected {"token": string}' })
        return
      }
      const label = typeof body?.label === 'string' && body.label.trim() !== '' ? body.label.trim() : undefined
      await deps.store.set(token, label)
      // 手工 token 也是凭据换新：复活「手工」账号，否则它被禁用后贴新 token 也没用。
      deps.reviveAccount?.(MANUAL_ACCOUNT_ID)
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** DELETE /api/codearts/token — forget the stored token. */
function tokenDeleteHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'DELETE') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      await deps.store.clear()
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/**
 * DELETE /api/codearts/accounts?id=<accountId> — 删掉一个账号。
 * POST /api/codearts/accounts — 改账号标记：`{ id, paused?, pinned? }`。
 *
 * id 必须显式给：多账号下「删掉当前那个」是歧义的。改状态的路由，所以和
 * /token 一样走 Host + Origin 双校验。
 */
function accountsHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'DELETE' && req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const url = new URL(req.url ?? '', 'http://localhost')
    try {
      if (req.method === 'POST') {
        const type = req.headers['content-type']
        if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
          json(res, 415, { error: 'content-type must be application/json' })
          return
        }
        const body = JSON.parse(await readBody(req)) as { id?: unknown; paused?: unknown; pinned?: unknown }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id === '') {
          json(res, 400, { error: 'expected {"id": string}' })
          return
        }
        let changed = false
        if (typeof body.paused === 'boolean') {
          if (!await deps.store.setPaused(id, body.paused)) {
            json(res, 404, { error: 'unknown account' })
            return
          }
          changed = true
        }
        if (typeof body.pinned === 'boolean') {
          if (!await deps.store.setPinned(id, body.pinned)) {
            json(res, 404, { error: 'unknown account' })
            return
          }
          changed = true
        }
        if (!changed) {
          json(res, 400, { error: 'expected paused and/or pinned boolean' })
          return
        }
        json(res, 200, await buildStatus(deps))
        return
      }
      const id = (url.searchParams.get('id') ?? '').trim()
      if (id === '') {
        json(res, 400, { error: 'expected ?id=<accountId>' })
        return
      }
      await deps.store.remove(id)
      json(res, 200, await buildStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** POST /api/codearts/claim — 领一次每日签到积分；未领到也回 200（看 claimed/state）。 */
function claimHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (deps.claim === undefined) {
      json(res, 404, { error: 'claim not available' })
      return
    }
    // 与其他 mutating route 一致：挡 DNS-rebinding。
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    let accountId: string | undefined
    const type = req.headers['content-type']
    if (typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')) {
      try {
        const body = JSON.parse(await readBody(req)) as { id?: unknown }
        if (typeof body?.id === 'string' && body.id.trim() !== '') accountId = body.id.trim()
      } catch {
        json(res, 400, { error: 'expected {"id"?: string}' })
        return
      }
    }
    try {
      const result = await deps.claim(accountId)
      json(res, result.ok ? 200 : 500, result)
    } catch (error: unknown) {
      json(res, 500, {
        ok: false,
        claimed: false,
        state: 'failed',
        amount: 0,
        message: safeMessage(error),
      })
    }
  }
}

/**
 * POST /api/codearts/refresh-models — 立刻重拉目录，并清掉「福利今日不可用」标记。
 *
 * 清标记放在拉目录**之前**：福利回来时这是唯一的自救出口，不能让用户等到明天。
 * 代价是「今天确实领完了」的那种缺失也会被一并清掉，再点一次就重新记上。
 */
function refreshModelsHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (deps.refreshModels === undefined) {
      json(res, 404, { error: 'refresh not available' })
      return
    }
    try {
      clearBenefitBlocked()
      const counted = await deps.refreshModels()
      const selection = selectionOf(
        choicesOf(deps),
        deps.enabledModels?.(),
        deps.setEnabledModels !== undefined,
      )
      json(res, 200, { ok: true, ...counted, selection })
    } catch (error: unknown) {
      json(res, 500, { ok: false, message: safeMessage(error) })
    }
  }
}

/**
 * 逐账号发一次最小聊天，验证模型**真的能调用**（清单里有 ≠ 能调）。
 *
 * 只发一句 ping、max_tokens 16：目的是让上游过一遍权限与路由检查，不是拿内容。
 * 必须逐账号试 —— 池里的正常请求也是这么轮的；只测第一个号会把「这个号没权限」
 * 误报成「模型不可用」。
 */
async function probeModel(
  deps: CodeArtsStatusRouteOptions,
  id: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; message: string; accountId?: string }> {
  const ids = await deps.store.ids()
  if (ids.length === 0) return { ok: false, message: '没有已登录的账号，请先在设置卡片登录。' }
  const raw = JSON.stringify({
    model: id,
    stream: true,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'ping' }],
  })
  let last = '没有可用的账号'
  for (const accountId of ids.slice(0, 3)) {
    if (signal.aborted) break
    const credential = await deps.store.resolve(accountId)
    if (credential === undefined) {
      last = '凭据不可用，请重新登录'
      continue
    }
    const result = await chatStream(credential, prepareChatBody(raw), signal)
    if (!result.ok) {
      last = upstreamErrorMessage(result.message, result.status)
      if (result.kind === 'iam_stale') {
        await deps.store.forceRefresh(accountId, credential.token).catch(() => undefined)
      }
      continue
    }
    const reader = result.stream.getReader()
    try {
      for (let frame = 0; frame < 6; frame += 1) {
        const next = await reader.read()
        if (next.done) return { ok: true, message: '上游已响应', accountId }
        const text = new TextDecoder().decode(next.value)
        const error = firstFrameError(text)
        if (error !== undefined) {
          const detail = `${error.code}: ${error.message}`.replace(/^: /, '')
          if (isModelNotAccessible(detail)) {
            markModelUnavailable(id, modelUnavailableReasonText(detail))
          }
          return { ok: false, message: upstreamErrorMessage(detail), accountId }
        }
        // 拿到第一帧正常数据就够证明「这个号能调通」；剩下的是生成内容，没必要读。
        if (text.includes('"choices"')) return { ok: true, message: '上游正常响应', accountId }
      }
      return { ok: true, message: '上游已开流', accountId }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
  return { ok: false, message: last }
}

/**
 * POST /api/codearts/test-model — 实测一个模型现在能不能调用。
 *
 * 成功会清掉它的「异常」标记（测试就是重新验证一次）；`81003.401` 会重新记上。
 * 失败也可能只是撞了并发上限/限流，所以除模型级错误外不动标记。
 */
function testModelHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    let id = ''
    try {
      const body = JSON.parse(await readBody(req)) as { id?: unknown }
      if (typeof body.id === 'string') id = body.id.trim()
    } catch {
      json(res, 400, { error: 'expected {"id": string}' })
      return
    }
    if (id === '') {
      json(res, 400, { error: 'expected {"id": string}' })
      return
    }
    if (!deps.models().some(model => model.id === id)) {
      json(res, 404, { error: `unknown model: ${id}` })
      return
    }
    const started = Date.now()
    try {
      const result = await probeModel(deps, id, AbortSignal.timeout(45_000))
      if (result.ok) forgetModelUnavailable(id)
      json(res, 200, { ...result, ms: Date.now() - started })
    } catch (error: unknown) {
      json(res, 200, { ok: false, message: safeMessage(error), ms: Date.now() - started })
    }
  }
}

/** GET /api/codearts/queue — 排队位置快照（无跟踪器/无排队时给空数组）。 */
function queueHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    json(res, 200, { queue: deps.queue?.() ?? [] })
  }
}

/** GET /api/codearts/debug — 最近出站请求的形状摘要（只有 role 名与计数）。 */
function debugHandler(deps: CodeArtsStatusRouteOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    json(res, 200, {
      requests: deps.recentRequests?.() ?? [],
      usages: deps.recentUsages?.() ?? [],
    })
  }
}

/** Mount the status / models / token routes. */
export function registerCodeArtsStatusRoute(ctx: Context, deps: CodeArtsStatusRouteOptions): void {
  ctx.effect(() => {
    const activeLogins = new Map<string, LoginSession>()
    /** 已结束登录的终态，供迟到的轮询读取。被读一次即删。 */
    const recentLogins = new Map<string, LoginOutcome>()
    /** 本次登录是「重新登录」时，授权 URL → 目标账号 id。终态落库后即删。 */
    const reloginTargets = new Map<string, string>()
    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_STATUS_PATH,
      handler: statusHandler(deps),
    })
    const disposeModels = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_MODELS_PATH,
      handler: modelsHandler(deps),
    })
    const disposeModelsSelection = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_MODELS_SELECTION_PATH,
      handler: modelsSelectionHandler(deps),
    })
    const disposeContextWindow = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_CONTEXT_WINDOW_PATH,
      handler: contextWindowHandler(deps),
    })
    // 宿主 WebServer 对同一个 (kind, path) 只留一个席位，重复注册会抛
    // duplicate exact route —— 抛在同一次 effect 里会把它后面的注册全跳过，
    // 所以 /token 的 POST 与 DELETE 必须共用一个 handler。
    const disposeToken = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_TOKEN_PATH,
      handler: tokenHandler(deps),
    })
    const disposeLoginStart = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_LOGIN_PATH,
      handler: loginStartHandler(deps, activeLogins, recentLogins, reloginTargets),
    })
    const disposeLoginStatus = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_LOGIN_STATUS_PATH,
      handler: loginPollHandler(deps, activeLogins, recentLogins),
    })
    const disposeAccounts = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_ACCOUNTS_PATH,
      handler: accountsHandler(deps),
    })
    const disposeClaim = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_CLAIM_PATH,
      handler: claimHandler(deps),
    })
    const disposeRefresh = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_REFRESH_MODELS_PATH,
      handler: refreshModelsHandler(deps),
    })
    const disposeTestModel = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_TEST_MODEL_PATH,
      handler: testModelHandler(deps),
    })
    const disposeQueue = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_QUEUE_PATH,
      handler: queueHandler(deps),
    })
    const disposeDock = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_DOCK_PATH,
      handler: dockHandler(deps),
    })
    const disposeKeeperStop = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_KEEPER_STOP_PATH,
      handler: keeperStopHandler(deps),
    })
    const disposeDebug = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_DEBUG_PATH,
      handler: debugHandler(deps),
    })
    const disposeDoctor = ctx.webServer.register({
      kind: 'exact',
      path: CODEARTS_DOCTOR_PATH,
      handler: doctorHandler(deps),
    })
    return () => {
      disposeStatus()
      disposeModels()
      disposeModelsSelection()
      disposeContextWindow()
      disposeToken()
      disposeLoginStart()
      disposeLoginStatus()
      disposeAccounts()
      disposeClaim()
      disposeRefresh()
      disposeTestModel()
      disposeQueue()
      disposeDock()
      disposeKeeperStop()
      disposeDebug()
      disposeDoctor()
      for (const s of activeLogins.values()) s.close()
      activeLogins.clear()
      reloginTargets.clear()
    }
  }, 'dsh-codearts: Web status route')
}

/** /api/codearts/token — 一个席位按方法分派（POST 写入，DELETE 清除）。 */
function tokenHandler(deps: CodeArtsStatusRouteOptions) {
  const post = tokenPostHandler(deps)
  const remove = tokenDeleteHandler(deps)
  return (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    req.method === 'DELETE' ? remove(req, res) : post(req, res)
}

/** 一次登录的终态。落库成功才算 done；落库失败按 error 报给卡片。 */
type LoginOutcome =
  | { status: 'done'; id: string; replaced: boolean; conflict: boolean }
  | { status: 'error' }

/** 记一次登录终态；超出容量就丢最旧的，别让这个表无限长。 */
function recordLoginOutcome(recent: Map<string, LoginOutcome>, url: string, outcome: LoginOutcome): void {
  if (recent.size >= 20 && !recent.has(url)) {
    const oldest = recent.keys().next().value
    if (oldest !== undefined) recent.delete(oldest)
  }
  recent.set(url, outcome)
}

/**
 * POST /api/codearts/login — 启动本地 OAuth 回调，返回授权 URL。
 *
 * `?account=<id>` 表示「重新登录这个账号」（见 settleLogin）；省略就是添加账号。
 */
function loginStartHandler(
  deps: CodeArtsStatusRouteOptions,
  active: Map<string, LoginSession>,
  recent: Map<string, LoginOutcome>,
  targets: Map<string, string>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const targetId = (new URL(req.url ?? '', 'http://localhost').searchParams.get('account') ?? '').trim()
    try {
      const session = await startLogin()
      active.set(session.url, session)
      if (targetId !== '') targets.set(session.url, targetId)
      // 终态只在 promise 兑现/失败时处理**一次**：落库 + 记下结果。之后不管卡片
      // 轮询多少次、迟到的轮询什么时候到，都从 recent 里读这个终态——不能在每个
      // 轮询里各自 .then 一遍（那样登录完成时所有叠着的回调会一起跑、把会话从
      // active 里删掉，下一次轮询就只能看到 idle，卡片按钮永远停在「登录中」）。
      session.promise.then(
        async token => {
          active.delete(session.url)
          // 先同步取走目标 id：轮询可能马上到达，别让它读到已经清空的状态。
          const reloginId = targets.get(session.url)
          targets.delete(session.url)
          try {
            const result = await settleLogin(deps, token, reloginId)
            recordLoginOutcome(recent, session.url, { status: 'done', ...result })
          } catch {
            recordLoginOutcome(recent, session.url, { status: 'error' })
          }
        },
        () => {
          active.delete(session.url)
          targets.delete(session.url)
          recordLoginOutcome(recent, session.url, { status: 'error' })
        },
      )
      // 5 分钟超时：关回调端口。注意此时 promise 永远不会兑现（take() 没有等
      // 到 code 就一直挂着），所以终态要在这里自己记，不能指望上面的 .then。
      const timer = setTimeout(() => {
        session.close()
        targets.delete(session.url)
        if (active.delete(session.url)) recordLoginOutcome(recent, session.url, { status: 'error' })
      }, 5 * 60 * 1000)
      // finally 派生出的 promise 会继承 rejection —— 登录失败时同样会变成未处理 rejection。
      session.promise.finally(() => clearTimeout(timer)).catch(() => {})
      json(res, 200, { url: session.url, port: session.port })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** GET /api/codearts/login/status — 轮询登录结果。 */
function loginPollHandler(
  _deps: CodeArtsStatusRouteOptions,
  active: Map<string, LoginSession>,
  recent: Map<string, LoginOutcome>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    const url = new URL(req.url ?? '', 'http://localhost')
    const key = url.searchParams.get('url') ?? ''
    if (active.has(key)) {
      json(res, 200, { status: 'pending' })
      return
    }
    const outcome = recent.get(key)
    if (outcome !== undefined) {
      // 读完即消费：这个终态只告诉第一个来问的轮询。卡片侧把 idle 也当终止态
      // 兜底，所以第二个轮询拿不到 done 也不会卡死。
      recent.delete(key)
      json(res, 200, { ...outcome })
      return
    }
    json(res, 200, { status: 'idle' })
  }
}
