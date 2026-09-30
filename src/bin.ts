#!/usr/bin/env node
/**
 * dsh-codearts CLI: sign-in state, diagnostics and sign-out.
 *
 *   dsh plugin --profile web exec dsh-codearts status        # sign-in state + models
 *   dsh plugin --profile web exec dsh-codearts status --json # machine-readable
 *   dsh plugin --profile web exec dsh-codearts doctor        # secret-free diagnostics
 *   dsh plugin --profile web exec dsh-codearts logout        # drop the plugin's credential
 *
 * `doctor` never prints token material — only paths, booleans and versions —
 * so its output is safe to paste into a bug report. `logout` removes only this
 * plugin's own credential copy; nothing outside the plugin is touched.
 *
 * @module dsh-codearts/bin
 */

import { existsSync, statSync } from 'node:fs'
import { codeartsAuthPath, clearCredential, loadCredential } from './auth.ts'
import { FALLBACK_CODEARTS_MODELS } from './catalog.ts'
import { CODEARTS_VERSION } from './version.ts'

/** Bumped when a `--json` document changes shape. */
const JSON_SCHEMA_VERSION = 1

type Action = 'doctor' | 'logout' | 'status'

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
  /** True when the credential carries AK/SK, i.e. chat requests can be signed. */
  signable: boolean
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
  hints: string[]
}

function buildStatus(): StatusOut {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    version: CODEARTS_VERSION,
    signedIn: false,
    signable: false,
    models: FALLBACK_CODEARTS_MODELS.map(m => ({ id: m.id, name: m.name })),
  }
}

async function status(jsonOutput: boolean): Promise<number> {
  const authPath = codeartsAuthPath()
  const out = buildStatus()
  const cred = await loadCredential(authPath)
  if (cred !== undefined) {
    out.signedIn = true
    out.signable = typeof cred.accessKeyId === 'string' && cred.accessKeyId !== '' &&
      typeof cred.secretAccessKey === 'string' && cred.secretAccessKey !== ''
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
    process.stdout.write(`signed in${out.label ? ` as ${out.label}` : ''}${out.storedAt ? ` (stored ${new Date(out.storedAt).toISOString()})` : ''}\n`)
    if (out.stale === true) {
      process.stdout.write('credential marked stale after a failed refresh; sign in again\n')
    } else if (out.expiration !== undefined) {
      process.stdout.write(`expires ${out.expiration}\n`)
    }
    if (!out.signable) {
      process.stdout.write('warning: stored credential has no AK/SK, so requests cannot be signed and chats will be rejected\n')
    }
  } else {
    process.stdout.write('not signed in (no credential stored; sign in from the CodeArts settings card)\n')
  }
  process.stdout.write(`models (${out.models.length}):\n`)
  for (const m of out.models) process.stdout.write(`  - ${m.id}  ${m.name}\n`)
  return out.signedIn ? 0 : 1
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const authPath = codeartsAuthPath()
  const exists = existsSync(authPath)
  const cred = await loadCredential(authPath)
  const signable = cred !== undefined &&
    typeof cred.accessKeyId === 'string' && cred.accessKeyId !== '' &&
    typeof cred.secretAccessKey === 'string' && cred.secretAccessKey !== ''

  const hints: string[] = []
  if (!exists) {
    hints.push('No credential file yet: sign in from the CodeArts settings card (or paste a token).')
  } else if (cred === undefined) {
    hints.push('The credential file exists but could not be parsed; sign in again to rewrite it.')
  } else if (cred.stale === true) {
    hints.push('The credential was marked stale after a failed refresh; sign in again.')
  } else if (!signable) {
    hints.push('Stored credential has no AK/SK. CodeArts rejects unsigned chat requests — sign in with the OAuth flow rather than pasting a bare token.')
  }
  if (!process.env.DSH_HOME) {
    hints.push('DSH_HOME is unset; the credential path fell back to ~/.dsh — set DSH_HOME if your harness lives elsewhere.')
  }

  const out: DoctorOut = {
    schemaVersion: JSON_SCHEMA_VERSION,
    version: CODEARTS_VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    authPath,
    authFileExists: exists,
    signedIn: cred !== undefined,
    signable,
    hints,
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return hints.length === 0 ? 0 : 1
  }

  process.stdout.write(`dsh-codearts ${out.version}  (node ${out.node}, ${out.platform})\n`)
  process.stdout.write(`credential: ${out.authPath}\n`)
  process.stdout.write(`  file exists : ${out.authFileExists ? 'yes' : 'no'}${exists ? ` (${statSync(authPath).size} bytes)` : ''}\n`)
  process.stdout.write(`  signed in   : ${out.signedIn ? 'yes' : 'no'}\n`)
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
  const authPath = codeartsAuthPath()
  await clearCredential(authPath)
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, signedOut: true, authPath }, null, 2) + '\n')
  } else {
    process.stdout.write(`signed out; removed ${authPath}\n`)
  }
  return 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const jsonOutput = args.includes('--json')
  const positional = args.filter(arg => !arg.startsWith('--'))
  const unknown = args.filter(arg => arg.startsWith('--') && arg !== '--json')

  const raw = positional[0] ?? 'status'
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(raw as Action)) {
    process.stderr.write(`dsh-codearts: expected doctor, logout, or status; got ${JSON.stringify(raw)}\n`)
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
      : await status(jsonOutput)
  process.exit(code)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
