/**
 * dsh-css —— 把 `*.module.css` 编成一个虚拟 JS 模块。
 *
 *   .module.css ──lightningcss──> 压缩后的 css 文本 + { 局部名: 作用域名 } 映射
 *
 * 产出的模块在被 import 时注入一份
 *   <style data-plugin="<包名>" data-plugin-css="<包名>/<文件名>">
 * 已存在就跳过，所以重复挂载 / 多个 bundle 引同一份都不会叠加。
 *
 * 为什么要自己写：宿主的 __ModuleLoader__ 只吃一个 JS 文件，没有 css 通道；
 * 而官方的 @tsdown/css 还是 experimental 且没装。dsh-codebuddy-cli 走的是同一条
 * 路子（它的产物里能看到 `\0dsh-css:` 虚拟模块和 `[hash]_[local]` 作用域名）。
 *
 * 同时把映射表回写成 `x.module.css.d.ts`，于是 `styles.card` 打错字是编译错误，
 * 不是页面上一个没样式的裸元素。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const VIRTUAL = '\0dsh-css:'
/**
 * 虚拟 id 必须以 .mjs 结尾：rolldown 按 id 后缀决定用哪个 loader，
 * 以 .css 结尾会被它内置的 css 插件接管（然后抱怨 @tsdown/css 没装）。
 * 参照物 dsh-codebuddy-cli 的产物里也是 `…module.css.mjs` 这个形态。
 */
const SUFFIX = '.mjs'

/** lightningcss 默认就是 `[hash]_[local]`（6 位 hash），和参照物一致。 */
const PATTERN = '[hash]_[local]'

function moduleSource(css, exports, packageName, file) {
  const map = Object.fromEntries(
    Object.entries(exports ?? {}).map(([local, info]) => [local, info.name]),
  )
  const tagId = `${packageName}/${basename(file)}`
  return [
    'const css = ' + JSON.stringify(css) + ';',
    'const tagId = ' + JSON.stringify(tagId) + ';',
    'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
    '  const tag = document.createElement("style");',
    '  tag.dataset.plugin = ' + JSON.stringify(packageName) + ';',
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    'export default ' + JSON.stringify(map, null, 2) + ';',
    '',
  ].join('\n')
}

function declarationSource(exports) {
  // 按类名排序再输出：lightningcss 返回的键序不稳定，不排的话每次构建都会把
  // 这个生成文件改一遍（内容其实一模一样），把 diff 搞得全是噪声。
  const entries = Object.entries(exports ?? {})
    .map(([local]) => local)
    .sort()
    .map(local => `  readonly ${JSON.stringify(local)}: string`)
  return [
    '// 由 dsh-css 在构建时生成，别手改。',
    'declare const styles: {',
    ...(entries.length > 0 ? entries : ['  readonly [key: string]: string']),
    '}',
    'export default styles',
    '',
  ].join('\n')
}

export function dshCss({ packageName } = {}) {
  if (typeof packageName !== 'string' || packageName === '') {
    throw new Error('dsh-css: packageName is required')
  }
  return {
    name: 'dsh-css',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const from = importer === undefined || importer === '' ? process.cwd() : dirname(importer)
      return VIRTUAL + resolve(from, source) + SUFFIX
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return null
      const file = id.slice(VIRTUAL.length, -SUFFIX.length)
      const result = transform({
        filename: file,
        code: readFileSync(file),
        minify: true,
        cssModules: { pattern: PATTERN, dashedIdents: false },
      })
      const exports = result.exports ?? {}
      writeFileSync(`${file}.d.ts`, declarationSource(exports), 'utf8')
      return moduleSource(result.code.toString('utf8'), exports, packageName, file)
    },
  }
}
