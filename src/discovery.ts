/**
 * 动态模型发现：把「已登录账号」变成「当前可用模型清单」。
 *
 * 为什么要单独一层：模型目录是**按账号**授予的（限时福利尤其如此：A 账号有、
 * B 账号没有），而插件对外只暴露一份目录。所以这里逐账号发现、取并集，再把
 * 结果提交给全局目录与福利集合。
 *
 * 失败一律不抛出：拉不到就继续用现有目录（冷启动时是种子清单），把失败原因
 * 带回去给 CLI / 日志展示。真正「不可用」的信号是 0 个账号。
 *
 * @module dsh-codearts/discovery
 */

import {
  isBenefitModel,
  modelDisplayName,
  setDiscoveredBenefitModels,
  type CodeArtsCatalog,
  type CodeArtsModelInfo,
} from './catalog.ts'
import { mergeModelLists } from './catalog.ts'
import { fetchModels, type ModelSource } from './upstream.ts'
import type { CodeArtsAccountStore } from './auth.ts'

export interface AccountDiscovery {
  accountId: string
  label?: string
  ok: boolean
  models: readonly CodeArtsModelInfo[]
  sources: readonly ModelSource[]
  errors: readonly { source: ModelSource; message: string }[]
}

export interface DiscoveryOutcome {
  /** 合并所有账号后的目录（已去重、已排序、已钳制上限）。 */
  models: readonly CodeArtsModelInfo[]
  /** 逐账号的结果，含失败原因。 */
  accounts: readonly AccountDiscovery[]
  /** 至少一个账号成功。 */
  anySucceeded: boolean
}

/**
 * 逐账号发现并合并（不改全局状态）。
 *
 * @param store 账号文档；逐个 `resolve()` 以拿到已续期的签名材料
 * @param signal 取消信号（宿主关停时用）
 */
export async function discoverModels(
  store: CodeArtsAccountStore,
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const ids = await store.ids()
  const accounts: AccountDiscovery[] = []
  for (const id of ids) {
    if (signal?.aborted === true) break
    const summary = (await store.list()).find(account => account.id === id)
    const label = summary?.label ?? summary?.userName
    const resolved = await store.resolve(id)
    if (resolved === undefined) {
      accounts.push({
        accountId: id,
        ...(label === undefined ? {} : { label }),
        ok: false,
        models: [],
        sources: [],
        errors: [{ source: 'agent', message: 'credential unavailable (sign in again)' }],
      })
      continue
    }
    try {
      const result = await fetchModels(resolved, signal)
      accounts.push({
        accountId: id,
        ...(label === undefined ? {} : { label }),
        ok: true,
        models: result.models,
        sources: result.sources,
        errors: result.errors,
      })
    } catch (error) {
      accounts.push({
        accountId: id,
        ...(label === undefined ? {} : { label }),
        ok: false,
        models: [],
        sources: [],
        errors: [{ source: 'agent', message: error instanceof Error ? error.message : String(error) }],
      })
    }
  }

  const ok = accounts.filter(account => account.ok)
  // 并集：一个账号能看到某模型，就把它展示出来（能否真正调用由上游决定）。
  const models = mergeModelLists(ok.map(account => account.models))
  return { models, accounts, anySucceeded: ok.length > 0 }
}

/**
 * 发现并**提交**到全局目录：目录内容 + 福利集合。
 *
 * @returns 提交后的目录；没有任何账号成功时返回 `undefined`（调用方保留原目录）
 */
export async function refreshCatalog(
  store: CodeArtsAccountStore,
  catalog: CodeArtsCatalog,
  signal?: AbortSignal,
): Promise<DiscoveryOutcome | undefined> {
  const outcome = await discoverModels(store, signal)
  if (!outcome.anySucceeded || outcome.models.length === 0) return outcome
  // 福利名单取所有成功账号的并集：漏标一次就是一次 InferHub.002002009.404。
  setDiscoveredBenefitModels(outcome.models.filter(model => model.benefit === true).map(model => model.id))
  // 名字必须按**提交后**的福利集合来定：福利模型的 id 也可能同时出现在内置 / agent 两路里，
  // 只看单条 model.benefit 会漏标。宿主模型下拉只渲染文字，「 · x0.18 · 福利」
  // 这类尾巴就是它唯一能看见的倍率与福利标记。
  catalog.set(
    outcome.models.map(model => {
      const benefit = isBenefitModel(model.id)
      return { ...model, name: modelDisplayName(model.name, benefit, model.ratio) }
    }),
  )
  return outcome
}
