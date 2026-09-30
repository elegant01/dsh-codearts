import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { dshCss } from './scripts/dsh-css.mjs'

/** Read the npm version once so the build injects it into src/version.ts. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

/** Build-time define map; `src/version.ts` reads `__DSH_CODEARTS_VERSION__`. */
const VERSION_DEFINE = { __DSH_CODEARTS_VERSION__: JSON.stringify(PACKAGE_VERSION) }

/**
 * The client bundle runs in the browser, where `process` does not exist.
 * Any dependency that branches on `process.env.NODE_ENV` (React among them)
 * would throw at load time unless the expression is replaced at build time.
 * The host shell's own client preset defines these the same way.
 */
const CLIENT_ENV_DEFINE = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

// Build both the server bundle (lib/index.js) and the client bundle.
// The client bundle is consumed by the DSH web shell via the `dsh.client`
// manifest entry; it must stay framework-light (no node built-ins), and the
// DSH UI packages are left external (provided by the host shell).
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/bin.ts'],
    format: ['esm'],
    target: 'node22',
    dts: true,
    clean: true,
    outDir: 'lib',
    define: VERSION_DEFINE,
  },
  {
    entry: ['src/client/index.tsx'],
    format: ['cjs'],
    target: 'es2022',
    outDir: 'lib/client',
    define: { ...VERSION_DEFINE, ...CLIENT_ENV_DEFINE },
    deps: {
      neverBundle: [
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-ui-settings-plugins',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-session',
        '@deepseek-ai/dsh-api-session-controller',
        '@deepseek-ai/dsh-client-locale',
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
    // 样式走 dsh-css（下面 plugins 里），不用 tsdown 的 css 选项：
    // 那个要 @tsdown/css、仍是 experimental，且原来这行 `css: 'external'`
    // 类型上就不合法（要对象），只是没人检查这个文件所以一直没响。
    plugins: [dshCss({ packageName: 'dsh-codearts' })],
  },
])
