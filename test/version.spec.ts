import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CODEARTS_VERSION } from '../src/version.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('CODEARTS_VERSION', () => {
  it('reports the package.json version under vitest (define is shared with tsdown)', () => {
    expect(CODEARTS_VERSION).toBe(pkg.version)
  })

  it('is a non-empty string', () => {
    expect(typeof CODEARTS_VERSION).toBe('string')
    expect(CODEARTS_VERSION).not.toBe('')
  })
})
