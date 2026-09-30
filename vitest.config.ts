import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: {
    __DSH_CODEARTS_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  test: {
    // Both suffixes: this repo already had *.test.ts before *.spec.ts became
    // the convention, and a narrow glob would silently stop running it.
    include: ['test/**/*.{test,spec}.ts'],
    environment: 'node',
  },
})
