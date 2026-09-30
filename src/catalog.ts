/**
 * CodeArts model catalog (MVP = static seed list).
 *
 * We do not call CodeArts' dynamic model API in the MVP (it needs a signed
 * request + account identity).
 *
 * Provenance (be honest — this is a hand-maintained seed, not a discovery):
 *  - The four `BENEFIT_MODELS` ids below were confirmed against a live
 *    `GET /v2/models` response from a real account (see notes in history).
 *  - The commercial ids (GLM-*, OpenPangu-*, Qwen3-*) come from codearts2api's
 *    `seedKnownModels`. Their ids are trustworthy, but `contextWindow`,
 *    `maxTokens` and `supportsImages` are *not* verified against the live
 *    account — treat them as placeholders. Wrong contextWindow only affects the
 *    DSH context meter / truncation margin, not routing.
 *
 * Add or correct rows here as you verify them. (No `billing` — CodeArts exposes
 * no balance API, and the goal is "用完拉倒".)
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
 * 大小写不敏感匹配（上游注册名区分大小写，但客户端习惯小写）。
 */
export const BENEFIT_MODELS: readonly string[] = [
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro-0813',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
]

const benefitLower = new Set(BENEFIT_MODELS.map(m => m.toLowerCase()))

/** 该模型是否走限时福利路由（按小写 ID 判定）。 */
export function isBenefitModel(id: string): boolean {
  return benefitLower.has(id.trim().toLowerCase())
}
