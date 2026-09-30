#!/usr/bin/env node
/**
 * dsh-codearts CLI: inspect the stored token / model list.
 *
 *   dsh plugin --profile web exec dsh-codearts status
 *   dsh plugin --profile web exec dsh-codearts status --json
 *
 * @module dsh-codearts/bin
 */

import { codeartsAuthPath, loadCredential } from './auth.ts'
import { FALLBACK_CODEARTS_MODELS } from './catalog.ts'
import { CODEARTS_VERSION } from './version.ts'

/** Bumped when the `status --json` document changes shape. */
const JSON_SCHEMA_VERSION = 1

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
  models: readonly { id: string; name: string }[]
}

function buildStatus(): StatusOut {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    version: CODEARTS_VERSION,
    signedIn: false,
    models: FALLBACK_CODEARTS_MODELS.map(m => ({ id: m.id, name: m.name })),
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const wantStatus = args.length === 0 || args[0] === 'status'

  if (!wantStatus) {
    process.stderr.write('usage: dsh-codearts status [--json]\n')
    process.exit(2)
  }

  const out = buildStatus()
  const cred = await loadCredential(codeartsAuthPath())
  if (cred !== undefined) {
    out.signedIn = true
    if (cred.label !== undefined) out.label = cred.label
    if (cred.storedAt !== undefined) out.storedAt = cred.storedAt
    if (cred.expiration !== undefined) out.expiration = cred.expiration
    if (cred.stale === true) out.stale = true
  }

  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    if (out.signedIn) {
      process.stdout.write(`signed in${out.label ? ` as ${out.label}` : ''}${out.storedAt ? ` (stored ${new Date(out.storedAt).toISOString()})` : ''}\n`)
      if (out.stale === true) {
        process.stdout.write('credential marked stale after a failed refresh; sign in again\n')
      } else if (out.expiration !== undefined) {
        process.stdout.write(`expires ${out.expiration}\n`)
      }
    } else {
      process.stdout.write('not signed in (no token stored; paste a cloud_dragon_token in the plugin settings)\n')
    }
    process.stdout.write(`models (${out.models.length}):\n`)
    for (const m of out.models) process.stdout.write(`  - ${m.id}  ${m.name}\n`)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
