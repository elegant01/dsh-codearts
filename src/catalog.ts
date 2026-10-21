/**
 * CodeArts model catalog.
 *
 * **目录只放上游给的东西。** 唯一来源是动态发现（`src/discovery.ts` +
 * `upstream.fetchModels`）：启动、每小时、以及卡片上「刷新模型列表」各拉一次，
 * 取内置 / 限时福利 / agent-center 三路的并集。上游没返回的模型就是没有，
 * 未登录或三路全失败时目录是空的 —— 不拿一份历史名单冒充「可用模型」。
 *
 * `FALLBACK_CODEARTS_MODELS` 因此**不再往目录里塞模型**，只剩一个按 id 的参数表：
 * 上游有时不给 `contextWindow` / `maxTokens`，而写错的 `maxTokens` 会让每个请求
 * 直接失败（见 `MEASURED_MAX_TOKENS`）。它只给发现到的模型补参数，别的什么都不管。
 *
 * 福利路由同理：只有 `gateway/config` 亲口给出的模型才算福利（见 `isBenefitModel`）。
 * 这条渠道 2026-10-21 起整体不可用，于是福利模型当天就从目录里消失 —— 那是事实，
 * 不是故障，硬撑只会把能正常用的积分模型推到一条不存在的渠道上。
 *
 * @module dsh-codearts/catalog
 */

/** One model the adapter exposes to DSH. */
export interface CodeArtsModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  /**
   * 积分消耗倍率（上游 `credit[].ratio_display` 的原值，如 `0.18x`）。
   *
   * 来自模型发现；福利模型由展示层强制成 `x0.00`，不依赖上游是否给 credit。
   */
  ratio?: string
  /**
   * 该模型走限时福利（免费套餐）路由。
   *
   * 由动态发现填入：福利是按账号授予的，只有拉过 `gateway/config` 才知道某个账号
   * 到底有没有它。种子里那份静态名单只是冷启动兜底（见 `isBenefitModel`）。
   */
  benefit?: boolean
}

/**
 * 参数表（不是模型名单）：只给**发现到的**模型补 `contextWindow` / `maxTokens` /
 * `supportsImages`，绝不会因为这里有条目就把模型塞进目录。
 *
 * maxTokens 注记（2026-09-30 实测，scripts/param-probe.mjs 直连上游二分验证）：
 * 福利 DeepSeek 模型的 max_tokens 服务端硬上限是 **65536**，更大的值
 * （73728 / 98304 / 131072 / 384000 / 393216）一律流内报
 * InferHub.001001005.400 "The request param is invalid, Please check it"。
 * 此前的 384000/393216 是占位值：DSH 会把 catalog 的 maxTokens 作为
 * max_tokens 原样发给上游，导致所有请求直接失败。
 */
export const FALLBACK_CODEARTS_MODELS: readonly CodeArtsModelInfo[] = [
  { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
  { id: 'GLM-5.1', name: 'GLM-5.1', contextWindow: 128_000, maxTokens: 8_000, supportsImages: false },
  { id: 'GLM-4.7', name: 'GLM-4.7', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
  { id: 'OpenPangu-2.0-Pro', name: 'OpenPangu 2.0 Pro', contextWindow: 32_000, maxTokens: 4_000, supportsImages: true },
  { id: 'OpenPangu-2.0-Flash', name: 'OpenPangu 2.0 Flash', contextWindow: 32_000, maxTokens: 4_000, supportsImages: true },
  { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
  { id: 'Qwen3.5-397B-A17B-VL', name: 'Qwen3.5-397B-A17B-VL', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
  { id: 'Qwen3.6-27B-VL', name: 'Qwen3.6-27B-VL', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek-V4-Flash (福利)', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek-V4-Pro (福利)', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash (福利)', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
]

/**
 * 倍率的展示写法：福利恒为 `x0.00`，其余用上游的数值，拿不到就不显示。
 *
 * 福利模型不走积分，倍率显示成 0 比显示上游某个残留 credit 更接近事实。
 */
export function creditRatioLabel(ratio: string | undefined, benefit: boolean): string | undefined {
  if (benefit) return 'x0.00'
  const value = (ratio ?? '').trim().replace(/x$/i, '').trim()
  // 与宿主里 dsh-connect-trae 的展示对齐：固定两位小数（x0.70 / x0.18），
  // 避免同一列里 x0.7 和 x0.79 参差不齐。
  return /^\d+(?:\.\d+)?$/.test(value) ? `x${Number(value).toFixed(2)}` : undefined
}

/**
 * 模型在宿主下拉里的**名字**带一个标记尾巴：` · x0.18`、` · x0.00 · 福利`。
 *
 * 写法照搬 dsh-codebuddy-cli 的 provider：倍率在前、上游徽章措辞在后，统一用
 * ` · ` 连接（`Name · x0.71 · 限时免费`）。宿主自己的模型下拉只渲染文字，
 * 插不进 Tag，所以那是用户唯一能看见标记的地方；插件卡片会反过来把尾巴剥掉、
 * 改挂 Tag（见 client 的 modelName），两边都不会重复。
 */
export function modelDisplayName(name: string, benefit: boolean, ratio?: string): string {
  const base = stripModelSuffixes(name)
  const parts = [creditRatioLabel(ratio, benefit), benefit ? '福利' : undefined].filter(
    (part): part is string => part !== undefined,
  )
  return parts.length === 0 ? base : `${base} · ${parts.join(' · ')}`
}

/**
 * 剥掉模型名尾巴上的标记：` · x0.18`、` · x0.00 · 福利`、`(福利)`、`(免费)`、
 * `(x0.18)` 等（兼容旧格式）。
 */
export function stripModelSuffixes(name: string): string {
  let base = name
  for (;;) {
    const next = base.replace(/\s*·\s*(?:x\d+(?:\.\d+)?|(?:限时)?(?:免费|福利)(?:\s+x\d+(?:\.\d+)?)?)\s*$/, '')
    if (next === base) break
    base = next
  }
  return base
    .replace(/\s*[（(]\s*(?:(?:免费|福利)(?:\s+x\d+(?:\.\d+)?)?|x\d+(?:\.\d+)?)\s*[)）]\s*$/, '')
    .trim()
}

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class CodeArtsCatalog {
  /** 空目录起步：没发现过就是没有模型，不拿历史名单冒充。 */
  private models: readonly CodeArtsModelInfo[] = []

  current(): readonly CodeArtsModelInfo[] {
    return this.models
  }

  set(models: readonly CodeArtsModelInfo[]): void {
    this.models = [...models]
  }
}

/**
 * Narrow a catalog to the user's enabled selection (allowlist of model ids).
 * Same semantics as the codebuddy plugin: absent or empty => serve all.
 */
export function filterEnabledModels(
  models: readonly CodeArtsModelInfo[],
  enabled: readonly string[] | undefined,
): readonly CodeArtsModelInfo[] {
  if (enabled === undefined || enabled.length === 0) return models
  const allow = new Set(enabled)
  const kept = models.filter(model => allow.has(model.id))
  return kept.length === 0 ? models : kept
}

/**
 * 动态发现确认的福利模型（小写 id）—— 这是「是不是福利」的**唯一**依据。
 *
 * 只认 `gateway/config` 给过的名单，没有静态兜底：猜错一次的代价不对称 ——
 * 漏带 `maas_type: benefit` 是福利模型报 404（它本来就不可用），多带一次却是把
 * 一个正常能用的积分模型推进一条不存在的渠道，直接 benefit not found。
 *
 * 与 codearts2api 的差别：那边按账号隔离目录，本插件的聊天链路（shim → upstream）
 * 拿不到账号上下文，所以这里取所有成功账号的并集。
 */
const discoveredBenefit = new Set<string>()

/** 用一次发现的结果替换动态福利集合（传空数组表示「本轮确认没有福利模型」）。 */
export function setDiscoveredBenefitModels(ids: readonly string[]): void {
  discoveredBenefit.clear()
  for (const id of ids) {
    const key = id.trim().toLowerCase()
    if (key !== '') discoveredBenefit.add(key)
  }
}

/** 当前动态发现的福利模型（小写 id，排序后的副本，便于测试与诊断输出）。 */
export function discoveredBenefitModels(): readonly string[] {
  return [...discoveredBenefit].sort()
}

/**
 * 该模型是否走限时福利路由（按小写 ID 判定）。
 *
 * 只认发现结果：`gateway/config` 没给过的模型一律不算福利，没有静态兜底。
 */
export function isBenefitModel(id: string): boolean {
  return discoveredBenefit.has(id.trim().toLowerCase())
}

/**
 * 今天被上游判定「没有福利权益」的模型（小写 id -> 本地日期键）。
 *
 * 判据只有一个：聊天回 `InferHub.4004.200 benefit not found`。上游没有任何接口能
 * 提前告诉我们福利余量（`statistics/plugin` 的 `model_quota_num` 实测恒为 -1，
 * 唯一能给数的 opengw balance 也不覆盖福利池），所以只能「失败一次才知道」。
 *
 * 按本地日期存：福利是每天发的，昨天的失败不代表今天。卡片据此把模型标成
 * 「福利今日不可用」，但**不**替用户取消勾选 —— 那是改他的设置。
 */
const benefitBlocked = new Map<string, string>()

function localDayKey(at: number = Date.now()): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** 记一次「这个模型今天没有福利权益」。 */
export function markBenefitBlocked(id: string): void {
  const key = id.trim().toLowerCase()
  if (key !== '') benefitBlocked.set(key, localDayKey())
}

/** 该模型今天是否已经因为福利权益缺失失败过。 */
export function isBenefitBlocked(id: string): boolean {
  const key = id.trim().toLowerCase()
  const day = benefitBlocked.get(key)
  if (day === undefined) return false
  if (day === localDayKey()) return true
  benefitBlocked.delete(key)
  return false
}

/** 今天被福利缺失挡住的模型（排序副本，供状态接口与诊断输出）。 */
export function benefitBlockedModels(): readonly string[] {
  return [...benefitBlocked.keys()].filter(isBenefitBlocked).sort()
}

/** 清空福利缺失记录 —— 手动刷新模型列表时调，给用户一个自救出口。 */
export function clearBenefitBlocked(): void {
  benefitBlocked.clear()
}

/**
 * 合并多路来源的模型清单（内置 / 限时福利 / agent-center）。
 *
 * 规则对齐 codearts2api 的 `MergeModels`：
 *  - 按小写 id 去重（上游注册名大小写敏感，但同一模型的书写可能不一致）；
 *  - `benefit` 取或：漏标一次就是一次 404；
 *  - 参数更全的一条优先（有 contextWindow > 没有，supportsImages 为真优先）；
 *  - 输出按小写 id 排序，保证 `/v1/models` 在刷新前后顺序稳定。
 */
export function mergeModelLists(
  sets: readonly (readonly CodeArtsModelInfo[])[],
): readonly CodeArtsModelInfo[] {
  const merged = new Map<string, CodeArtsModelInfo>()
  for (const set of sets) {
    for (const model of set) {
      const id = model.id.trim()
      if (id === '') continue
      const key = id.toLowerCase()
      const normalized: CodeArtsModelInfo = { ...model, id }
      const current = merged.get(key)
      merged.set(key, current === undefined ? normalized : richerModel(current, normalized))
    }
  }
  return [...merged.values()].sort((a, b) => {
    const la = a.id.toLowerCase()
    const lb = b.id.toLowerCase()
    return la === lb ? (a.id < b.id ? -1 : 1) : la < lb ? -1 : 1
  })
}

/** 同一模型两条记录取更全的一条；`benefit` 永远取或。 */
function richerModel(current: CodeArtsModelInfo, next: CodeArtsModelInfo): CodeArtsModelInfo {
  const benefit = current.benefit === true || next.benefit === true
  const keep = richerThan(next, current) ? next : current
  const drop = keep === next ? current : next
  const ratio = keep.ratio ?? drop.ratio
  return {
    id: keep.id,
    name: keep.name || drop.name || keep.id,
    contextWindow: keep.contextWindow > 0 ? keep.contextWindow : drop.contextWindow,
    maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
    supportsImages: keep.supportsImages || drop.supportsImages,
    ...(ratio === undefined ? {} : { ratio }),
    ...(benefit ? { benefit: true } : {}),
  }
}

/** a 是否比 b 更值得保留：优先带参数，其次保留大小写更「像注册名」的一条。 */
function richerThan(a: CodeArtsModelInfo, b: CodeArtsModelInfo): boolean {
  if ((a.contextWindow > 0) !== (b.contextWindow > 0)) return a.contextWindow > 0
  if ((a.maxTokens > 0) !== (b.maxTokens > 0)) return a.maxTokens > 0
  return a.id !== a.id.toLowerCase() && b.id === b.id.toLowerCase()
}

/**
 * 用参数表给**发现结果**补 0 值字段。参数表里有、上游这次没返回的模型 —— 不塞进目录。
 *
 * 为什么不能把参数表一起丢进 `mergeModelLists`：那个函数按「参数更全/大小写更像注册名」
 * 选记录，表里的占位值（例如 OpenPangu 的 ctx 32000 / max 4000）会凭大小写规则
 * 压过上游返回的真实值（ctx 524288 / max 131072）。所以顺序必须是
 * 「先合并发现结果 → 再用参数表补 0 值字段」。
 */
export function backfillParams(
  discovered: readonly CodeArtsModelInfo[],
  params: readonly CodeArtsModelInfo[] = FALLBACK_CODEARTS_MODELS,
): readonly CodeArtsModelInfo[] {
  const byId = new Map<string, CodeArtsModelInfo>()
  for (const model of discovered) byId.set(model.id.toLowerCase(), { ...model })
  for (const fallback of params) {
    const current = byId.get(fallback.id.toLowerCase())
    if (current === undefined) continue
    byId.set(fallback.id.toLowerCase(), {
      id: current.id,
      name: current.name || fallback.name,
      contextWindow: current.contextWindow > 0 ? current.contextWindow : fallback.contextWindow,
      maxTokens: current.maxTokens > 0 ? current.maxTokens : fallback.maxTokens,
      supportsImages: current.supportsImages || fallback.supportsImages,
      // 倍率只来自发现：参数表里的占位条目没有 ratio，绝不能拿它当兜底。
      ...(current.ratio === undefined ? {} : { ratio: current.ratio }),
      ...(current.benefit === true ? { benefit: true } : {}),
    })
  }
  return [...byId.values()].sort((a, b) => {
    const la = a.id.toLowerCase()
    const lb = b.id.toLowerCase()
    return la === lb ? (a.id < b.id ? -1 : 1) : la < lb ? -1 : 1
  })
}
