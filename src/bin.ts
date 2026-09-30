#!/usr/bin/env node
/**
 * dsh-codearts CLI: sign-in state, diagnostics and sign-out.
 *
 *   dsh plugin --profile web exec dsh-codearts status        # sign-in state + seed models
 *   dsh plugin --profile web exec dsh-codearts status --json # machine-readable
 *   dsh plugin --profile web exec dsh-codearts models        # discover the account's real models
 *   dsh plugin --profile web exec dsh-codearts models --json # machine-readable
 *   dsh plugin --profile web exec dsh-codearts usage         # local token accounting
 *   dsh plugin --profile web exec dsh-codearts usage --json  # machine-readable
 *   dsh plugin --profile web exec dsh-codearts doctor        # secret-free diagnostics
 *   dsh plugin --profile web exec dsh-codearts logout        # drop the plugin's credential
 *
 * `models` asks the upstream for the account's real catalog (built-in, limited-time
 * benefit and agent-center sources) instead of printing the hand-maintained seed —
 * that is the first thing to run when a model is missing from the picker.
 *
 * `usage` reads the plugin's own ledger of requests this machine sent. CodeArts has
 * no quota API, so it is not an account balance.
 *
 * `doctor` never prints token material — only paths, booleans and versions —
 * so its output is safe to paste into a bug report. `logout` removes only this
 * plugin's own credential copy; nothing outside the plugin is touched.
 *
 * @module dsh-codearts/bin
 */

import { existsSync, statSync } from 'node:fs'
import { codeartsAccountsPath, CodeArtsAccountStore, type CodeArtsAccountSummary } from './auth.ts'
import { FALLBACK_CODEARTS_MODELS, isBenefitModel } from './catalog.ts'
import { discoverModels } from './discovery.ts'
import { CodeArtsUsageTracker, codeartsUsagePath } from './usage.ts'
import { CODEARTS_VERSION } from './version.ts'

/** Bumped when a `--json` document changes shape (4: local usage accounting). */
const JSON_SCHEMA_VERSION = 4

type Action = 'doctor' | 'logout' | 'models' | 'status' | 'usage'

interface StatusOut {
  schemaVersion: number
  version: string
  signedIn: boolean
  label?: string
  storedAt?: number
  /** ISO expiry of the STS credential, when known. */
  expiration?: string
  /** The stored credential failed its last refresh; the user must sign in again. */
  stale?: boolean
  /** True when at least one account carries AK/SK, i.e. chat requests can be signed. */
  signable: boolean
  /** All stored accounts; requests rotate across them. */
  accounts: readonly CodeArtsAccountSummary[]
  models: readonly { id: string; name: string }[]
}

interface DoctorOut {
  schemaVersion: number
  version: string
  node: string
  platform: string
  authPath: string
  authFileExists: boolean
  signedIn: boolean
  /** The stored credential carries AK/SK, so SDK-HMAC signing is possible. */
  signable: boolean
  accounts: readonly CodeArtsAccountSummary[]
  hints: string[]
}

/** 一句话描述一个账号，供人类可读输出用。 */
function describeAccount(account: CodeArtsAccountSummary): string {
  const name = account.label ?? account.userName ?? account.id
  const notes: string[] = []
  if (account.stale) notes.push('needs sign-in')
  else if (typeof account.expiration === 'string') notes.push(`expires ${account.expiration}`)
  if (!account.signable) notes.push('no AK/SK')
  return notes.length === 0 ? name : `${name}  (${notes.join(', ')})`
}

function store(): CodeArtsAccountStore {
  return new CodeArtsAccountStore(codeartsAccountsPath())
}

async function status(jsonOutput: boolean): Promise<number> {
  const accounts = await store().list()
  const cred = await store().current()
  const out: StatusOut = {
    schemaVersion: JSON_SCHEMA_VERSION,
    version: CODEARTS_VERSION,
    signedIn: accounts.length > 0,
    signable: accounts.some(account => account.signable),
    accounts,
    models: FALLBACK_CODEARTS_MODELS.map(m => ({ id: m.id, name: m.name })),
  }
  if (cred !== undefined) {
    if (cred.label !== undefined) out.label = cred.label
    if (cred.storedAt !== undefined) out.storedAt = cred.storedAt
    if (cred.expiration !== undefined) out.expiration = cred.expiration
    if (cred.stale === true) out.stale = true
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return out.signedIn ? 0 : 1
  }

  if (out.signedIn) {
    process.stdout.write(`signed in — ${accounts.length} account${accounts.length === 1 ? '' : 's'}:\n`)
    for (const account of accounts) process.stdout.write(`  - ${describeAccount(account)}\n`)
    if (!out.signable) {
      process.stdout.write('warning: no account carries AK/SK, so requests cannot be signed and chats will be rejected\n')
    }
  } else {
    process.stdout.write('not signed in (no account stored; sign in from the CodeArts settings card)\n')
  }
  process.stdout.write(`models (${out.models.length}):\n`)
  for (const m of out.models) process.stdout.write(`  - ${m.id}  ${m.name}\n`)
  return out.signedIn ? 0 : 1
}

/**
 * 动态发现当前可用模型（三路：内置 / 限时福利 / agent-center）。
 *
 * 这是排查「模型选择器里没有某个模型」的第一手段：它打印的是上游真实返回，
 * 而不是插件里那份手维护的种子清单。未登录时退回种子清单并说明原因。
 */
async function models(jsonOutput: boolean): Promise<number> {
  const accounts = await store().list()
  if (accounts.length === 0) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({
        schemaVersion: JSON_SCHEMA_VERSION,
        version: CODEARTS_VERSION,
        discovered: false,
        reason: 'not signed in',
        models: FALLBACK_CODEARTS_MODELS.map(m => ({ id: m.id, name: m.name, benefit: isBenefitModel(m.id) })),
      }, null, 2) + '\n')
    } else {
      process.stdout.write('not signed in — showing the built-in seed catalog\n')
      for (const m of FALLBACK_CODEARTS_MODELS) {
        process.stdout.write(`  - ${m.id}  ${m.name}${isBenefitModel(m.id) ? '  [benefit]' : ''}\n`)
      }
    }
    return 1
  }

  const outcome = await discoverModels(store())
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION,
      version: CODEARTS_VERSION,
      discovered: outcome.anySucceeded,
      accounts: outcome.accounts.map(account => ({
        accountId: account.accountId,
        label: account.label,
        ok: account.ok,
        sources: account.sources,
        modelCount: account.models.length,
        errors: account.errors,
      })),
      models: outcome.models.map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        supportsImages: m.supportsImages,
        benefit: m.benefit === true || isBenefitModel(m.id),
      })),
    }, null, 2) + '\n')
    return outcome.anySucceeded ? 0 : 1
  }

  for (const account of outcome.accounts) {
    const name = account.label ?? account.accountId
    process.stdout.write(account.ok
      ? `discovered ${account.models.length} model(s) for ${name} via ${account.sources.join(', ')}\n`
      : `discovery failed for ${name}: ${account.errors.map(e => `${e.source}: ${e.message}`).join('; ')}\n`)
    for (const error of account.ok ? account.errors : []) {
      process.stdout.write(`  warning: ${error.source} source failed (${error.message})\n`)
    }
  }
  if (!outcome.anySucceeded) {
    process.stdout.write('no account could be queried; nothing to list\n')
    return 1
  }
  process.stdout.write(`models (${outcome.models.length}):\n`)
  for (const m of outcome.models) {
    const benefit = m.benefit === true || isBenefitModel(m.id)
    const flags = [
      benefit ? 'benefit' : '',
      m.supportsImages ? 'images' : '',
      `max ${m.maxTokens}`,
      `ctx ${m.contextWindow}`,
    ].filter(Boolean).join(', ')
    process.stdout.write(`  - ${m.id}  ${m.name}  (${flags})\n`)
  }
  return 0
}

/**
 * 本机用量账本（插件自己记的，不是账号额度）。
 *
 * 为什么要用 CLI 暴露它：账本是插件进程边跑边写的，GUI 卡片能看，但这个命令让
 * 「今天到底花了多少 token」在无图形界面时也能查，且输出可以直接贴进问题反馈。
 */
async function usage(jsonOutput: boolean): Promise<number> {
  const tracker = new CodeArtsUsageTracker({ path: codeartsUsagePath() })
  await tracker.load()
  const snapshot = tracker.snapshot()

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION,
      version: CODEARTS_VERSION,
      today: snapshot.today,
      allTime: snapshot.allTime,
      byModelToday: snapshot.byModelToday,
      byAccountToday: snapshot.byAccountToday,
      days: snapshot.days,
      lastAt: snapshot.lastAt,
    }, null, 2) + '\n')
    return 0
  }

  if (snapshot.allTime.requests === 0) {
    process.stdout.write('no usage recorded yet (nothing this plugin has sent)\n')
    return 0
  }
  process.stdout.write(`today      ${snapshot.today.requests} request(s), in ${snapshot.today.promptTokens} / out ${snapshot.today.completionTokens} tokens\n`)
  process.stdout.write(`all time   ${snapshot.allTime.requests} request(s), in ${snapshot.allTime.promptTokens} / out ${snapshot.allTime.completionTokens} tokens (${snapshot.days} day(s) kept)\n`)
  if (snapshot.byModelToday.length > 0) {
    process.stdout.write('today by model:\n')
    for (const entry of snapshot.byModelToday) {
      process.stdout.write(`  - ${entry.id}  ${entry.totals.requests} req  in ${entry.totals.promptTokens} / out ${entry.totals.completionTokens}\n`)
    }
  }
  const accounts = Object.entries(snapshot.byAccountToday)
  if (accounts.length > 0) {
    process.stdout.write('today by account:\n')
    for (const [id, totals] of accounts) {
      process.stdout.write(`  - ${id.slice(0, 12)}…  ${totals.requests} req  in ${totals.promptTokens} / out ${totals.completionTokens}\n`)
    }
  }
  process.stdout.write('note: CodeArts exposes no quota API; this counts requests this machine sent through the plugin\n')
  return 0
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const accountsPath = codeartsAccountsPath()
  const exists = existsSync(accountsPath)
  const accounts = await store().list()
  const signable = accounts.some(account => account.signable)

  const hints: string[] = []
  if (accounts.length === 0) {
    hints.push('No account stored yet: sign in from the CodeArts settings card.')
  } else {
    const stale = accounts.filter(account => account.stale)
    if (stale.length > 0) {
      hints.push(`${stale.length} of ${accounts.length} account(s) were marked stale after a failed refresh; sign in again.`)
    }
    if (!signable) {
      hints.push('No account carries AK/SK. CodeArts rejects unsigned chat requests — sign in with the OAuth flow rather than pasting a bare token.')
    }
  }
  if (!process.env.DSH_HOME) {
    hints.push('DSH_HOME is unset; the credential path fell back to ~/.dsh — set DSH_HOME if your harness lives elsewhere.')
  }

  const out: DoctorOut = {
    schemaVersion: JSON_SCHEMA_VERSION,
    version: CODEARTS_VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    authPath: accountsPath,
    authFileExists: exists,
    signedIn: accounts.length > 0,
    signable,
    accounts,
    hints,
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return hints.length === 0 ? 0 : 1
  }

  process.stdout.write(`dsh-codearts ${out.version}  (node ${out.node}, ${out.platform})\n`)
  process.stdout.write(`accounts: ${out.authPath}\n`)
  process.stdout.write(`  file exists : ${out.authFileExists ? 'yes' : 'no'}${exists ? ` (${statSync(accountsPath).size} bytes)` : ''}\n`)
  process.stdout.write(`  accounts    : ${accounts.length}\n`)
  for (const account of accounts) process.stdout.write(`    - ${describeAccount(account)}\n`)
  process.stdout.write(`  signable    : ${out.signable ? 'yes (AK/SK present)' : 'no (no AK/SK)'}\n`)
  if (hints.length === 0) {
    process.stdout.write('no issues found\n')
  } else {
    process.stdout.write('hints:\n')
    for (const hint of hints) process.stdout.write(`  - ${hint}\n`)
  }
  return hints.length === 0 ? 0 : 1
}

async function logout(jsonOutput: boolean): Promise<number> {
  const accountsPath = codeartsAccountsPath()
  const removed = (await store().list()).length
  await store().clear()
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, signedOut: true, removed, authPath: accountsPath }, null, 2) + '\n')
  } else {
    process.stdout.write(`signed out; removed ${removed} account${removed === 1 ? '' : 's'}\n`)
  }
  return 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const jsonOutput = args.includes('--json')
  const positional = args.filter(arg => !arg.startsWith('--'))
  const unknown = args.filter(arg => arg.startsWith('--') && arg !== '--json')

  const raw = positional[0] ?? 'status'
  const actions: readonly Action[] = ['doctor', 'logout', 'models', 'status', 'usage']
  if (!actions.includes(raw as Action)) {
    process.stderr.write(`dsh-codearts: expected doctor, logout, models, status, or usage; got ${JSON.stringify(raw)}\n`)
    process.exit(2)
  }
  if (unknown.length > 0) {
    process.stderr.write(`dsh-codearts: unknown flag ${JSON.stringify(unknown[0])} (only --json is supported)\n`)
    process.exit(2)
  }

  const action = raw as Action
  const code = action === 'doctor'
    ? await doctor(jsonOutput)
    : action === 'logout'
      ? await logout(jsonOutput)
      : action === 'models'
        ? await models(jsonOutput)
        : action === 'usage'
          ? await usage(jsonOutput)
          : await status(jsonOutput)
  process.exit(code)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
