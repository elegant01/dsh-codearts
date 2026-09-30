import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

/** Sentinels that must never appear in CLI output. */
const FAKE_TOKEN = 'FAKE-STS-TOKEN-SENTINEL'
const FAKE_SECRET = 'FAKE-SECRET-SENTINEL'
const FAKE_AK = 'FAKEAKSENTINEL'

interface CliResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Runs the CLI against a throwaway DSH_HOME. Spawned as a child process
 * because the CLI calls process.exit, and sandboxed because `logout` deletes
 * a credential file — the developer's real one must never be the target.
 */
async function cli(home: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--experimental-strip-types', BIN, ...args], {
      env: { ...process.env, DSH_HOME: home },
      // Keep the run hermetic: no ambient DSH_HOME from the parent shell wins.
      windowsHide: true,
    })
    return { stdout, stderr, code: 0 }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

let home: string
let authPath: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-codearts-cli-'))
  authPath = join(home, '.codearts-auth.json')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function seed(): Promise<void> {
  await writeFile(authPath, JSON.stringify({
    token: FAKE_TOKEN,
    accessKeyId: FAKE_AK,
    secretAccessKey: FAKE_SECRET,
    label: 'sandbox-user',
    storedAt: Date.now(),
    expiration: '2030-01-01T00:00:00Z',
  }), 'utf8')
}

describe('status', () => {
  it('reports signed-out with a non-zero exit when no credential is stored', async () => {
    const res = await cli(home, ['status'])
    expect(res.stdout).toContain('not signed in')
    expect(res.code).toBe(1)
  })

  it('reports signed-in with a zero exit once a credential is stored', async () => {
    await seed()
    const res = await cli(home, ['status'])
    expect(res.stdout).toContain('signed in')
    expect(res.stdout).toContain('sandbox-user')
    expect(res.code).toBe(0)
  })

  it('emits a machine-readable document with --json', async () => {
    await seed()
    const res = await cli(home, ['status', '--json'])
    const doc = JSON.parse(res.stdout) as { signedIn: boolean; signable: boolean; schemaVersion: number; models: unknown[] }
    expect(doc.signedIn).toBe(true)
    expect(doc.signable).toBe(true)
    expect(doc.schemaVersion).toBe(1)
    expect(doc.models.length).toBeGreaterThan(0)
  })

  it('flags a pasted-token credential as not signable', async () => {
    await writeFile(authPath, JSON.stringify({ token: FAKE_TOKEN, storedAt: Date.now() }), 'utf8')
    const res = await cli(home, ['status', '--json'])
    expect((JSON.parse(res.stdout) as { signable: boolean }).signable).toBe(false)
  })

  it('defaults to the status action when no action is given', async () => {
    const res = await cli(home, [])
    expect(res.stdout).toContain('models (')
  })
})

describe('doctor', () => {
  it('never prints token material', async () => {
    await seed()
    const res = await cli(home, ['doctor'])
    const combined = res.stdout + res.stderr
    expect(combined).not.toContain(FAKE_TOKEN)
    expect(combined).not.toContain(FAKE_SECRET)
    expect(combined).not.toContain(FAKE_AK)
  })

  it('says it is signed in once a credential exists', async () => {
    await seed()
    const res = await cli(home, ['doctor'])
    expect(res.stdout).toContain('signed in   : yes')
    expect(res.stdout).toContain('signable    : yes')
  })

  it('reports no file and exits non-zero on a fresh home', async () => {
    const res = await cli(home, ['doctor'])
    expect(res.stdout).toContain('file exists : no')
    expect(res.code).toBe(1)
  })
})

describe('logout', () => {
  it('removes the credential and reports signed-out afterwards', async () => {
    await seed()
    const res = await cli(home, ['logout'])
    expect(res.code).toBe(0)
    expect(existsSync(authPath)).toBe(false)
    expect((await cli(home, ['status'])).stdout).toContain('not signed in')
  })

  it('leaves no token material in its own output', async () => {
    await seed()
    const res = await cli(home, ['logout'])
    expect(res.stdout + res.stderr).not.toContain(FAKE_TOKEN)
  })

  // The safety property that matters most: logout targets the DSH_HOME it was
  // given, and nothing else.
  it('only touches the credential inside the given DSH_HOME', async () => {
    await seed()
    const other = await mkdtemp(join(tmpdir(), 'dsh-codearts-cli-other-'))
    try {
      const otherAuth = join(other, '.codearts-auth.json')
      await writeFile(otherAuth, JSON.stringify({ token: 'OTHER', storedAt: Date.now() }), 'utf8')

      await cli(home, ['logout'])

      expect(existsSync(authPath)).toBe(false)
      expect(existsSync(otherAuth)).toBe(true)
      expect((await readFile(otherAuth, 'utf8')).length).toBeGreaterThan(0)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('argument handling', () => {
  it('rejects an unknown action', async () => {
    const res = await cli(home, ['frobnicate'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('expected doctor, logout, or status')
  })

  it('rejects an unknown flag', async () => {
    const res = await cli(home, ['status', '--verbose'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown flag')
  })
})
