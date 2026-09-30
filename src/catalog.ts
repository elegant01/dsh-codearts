/**
 * CodeArts model catalog.
 *
 * 目录有两条来源：
 *  1. **动态发现**（`src/discovery.ts` + `upstream.fetchModels`）：启动与每小时
 *     各拉一次，取内置 / 限时福利 / agent-center 三路的并集。这是正常路径。
 *  2. **静态种子**（`FALLBACK_CODEARTS_MODELS`）：仅在发现失败或尚未登录时兜底。
 *
 * 种子的来龙去脉（诚实标注，别把它当权威）：
 *  - 福利模型的 id 已与真实账号的 `gateway/config` 对齐；
 *  - 商业模型的 id 可信（来自 codearts2api 的 `seedKnownModels`），但
 *    `contextWindow` / `maxTokens` / `supportsImages` 是**占位值**，发现成功时
 *    会被上游真实值覆盖 —— 这正是 `fillFromSeed` 只补缺、不覆盖的原因。
 *    写错的 contextWindow 只影响 DSH 的上下文计量与截断余量，不影响路由；
 *    写错的 maxTokens 会直接让请求失败（见 `MEASURED_MAX_TOKENS`）。
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
   * 该模型走限时福利（免费套餐）路由。
   *
   * 由动态发现填入：福利是按账号授予的，只有拉过 `gateway/config` 才知道某个账号
   * 到底有没有它。种子里那份静态名单只是冷启动兜底（见 `isBenefitModel`）。
   */
  benefit?: boolean
}

/**
 * Static seed roster. Ids are the *upstream registered* spellings (case
 * matters — `canonicalModel` in upstream.ts passes these through verbatim).
 * Updated 2026-09 from codearts2api's known model set.
 *
 * maxTokens 注记（2026-09-30 实测，scripts/param-probe.mjs 直连上游二分验证）：
 * 免费福利 DeepSeek 模型的 max_tokens 服务端硬上限是 **65536**，更大的值
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
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek-V4-Flash (免费)', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek-V4-Pro (免费)', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (免费)', contextWindow: 131_072, maxTokens: 65_536, supportsImages: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash (免费)', contextWindow: 128_000, maxTokens: 8_000, supportsImages: true },
]

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class CodeArtsCatalog {
  private models: readonly CodeArtsModelInfo[] = FALLBACK_CODEARTS_MODELS

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
 * 限时福利（免费套餐）模型种子：聊天必须带 `maas_type: benefit` 头，否则上游返回
 * InferHub.002002009.404 model is not registered。对齐 codearts2api 的
 * `seedBenefitModels`：宁可多带头，不可漏带（漏一次就是一次 404）。
 *
 * 这只是**冷启动兜底**：真实名单由 `fetchModels` 拉 `gateway/config` 得到并写进
 * `setDiscoveredBenefitModels`，发现结果优先。
 *
 * 大小写不敏感匹配（上游注册名区分大小写，但客户端习惯小写）。
 */
export const BENEFIT_MODELS: readonly string[] = [
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro-0813',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
]

const benefitLower = new Set(BENEFIT_MODELS.map(m => m.toLowerCase()))

/**
 * 动态发现确认的福利模型（小写 id）。
 *
 * 与 codearts2api 的差别：那边按账号隔离目录，本插件的聊天链路（shim → upstream）
 * 拿不到账号上下文，所以这里取**并集**并保留种子兜底 —— 宁可多带一次
 * `maas_type: benefit` 头，也不要漏带导致 404。套餐轮换后模型「转正」时，
 * 下次发现会把它从这份集合里去掉。
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
 * 发现结果优先于种子：目录里明确「不是福利」的模型（已转正）不会被种子重新标成福利，
 * 因为发现成功时会把它从 `discoveredBenefit` 里剔除，而种子只在该集合为空时兜底。
 */
export function isBenefitModel(id: string): boolean {
  const key = id.trim().toLowerCase()
  if (key === '') return false
  if (discoveredBenefit.has(key)) return true
  // 发现过且明确不在福利名单里 -> 不是福利；没发现过才回退种子。
  if (discoveredBenefit.size > 0) return false
  return benefitLower.has(key)
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
  return {
    id: keep.id,
    name: keep.name || drop.name || keep.id,
    contextWindow: keep.contextWindow > 0 ? keep.contextWindow : drop.contextWindow,
    maxTokens: keep.maxTokens > 0 ? keep.maxTokens : drop.maxTokens,
    supportsImages: keep.supportsImages || drop.supportsImages,
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
 * 用种子清单给**发现结果**补缺：种子只补，不覆盖。
 *
 * 为什么不能把种子一起丢进 `mergeModelLists`：那个函数按「参数更全/大小写更像注册名」
 * 选记录，种子里的占位值（例如 OpenPangu 的 ctx 32000 / max 4000）会凭大小写规则
 * 压过上游返回的真实值（ctx 524288 / max 131072）。所以顺序必须是
 * 「先合并发现结果 → 再用种子补 0 值字段与缺失条目」。
 */
export function fillFromSeed(
  discovered: readonly CodeArtsModelInfo[],
  seed: readonly CodeArtsModelInfo[] = FALLBACK_CODEARTS_MODELS,
): readonly CodeArtsModelInfo[] {
  const byId = new Map<string, CodeArtsModelInfo>()
  for (const model of discovered) byId.set(model.id.toLowerCase(), { ...model })
  for (const fallback of seed) {
    const key = fallback.id.toLowerCase()
    const current = byId.get(key)
    if (current === undefined) {
      byId.set(key, { ...fallback })
      continue
    }
    byId.set(key, {
      id: current.id,
      name: current.name || fallback.name,
      contextWindow: current.contextWindow > 0 ? current.contextWindow : fallback.contextWindow,
      maxTokens: current.maxTokens > 0 ? current.maxTokens : fallback.maxTokens,
      supportsImages: current.supportsImages || fallback.supportsImages,
      ...(current.benefit === true ? { benefit: true } : {}),
    })
  }
  return [...byId.values()].sort((a, b) => {
    const la = a.id.toLowerCase()
    const lb = b.id.toLowerCase()
    return la === lb ? (a.id < b.id ? -1 : 1) : la < lb ? -1 : 1
  })
}
