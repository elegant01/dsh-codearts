#!/usr/bin/env node
/**
 * 把 tsdown 产出的 CJS client bundle 包进 DSH 期望的自注册形态：
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-codearts",                 // 必须逐字等于包名
 *     factory(require) {                  // require 由 __ModuleLoader__ 注入，解析 react / @deepseek-ai/*
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       <原 cjs 内容，import 已转成 require(...)，exports.xxx = ...>
 *       return module.exports;
 *     }
 *   });
 *
 * 宿主的 settings.plugin.item 槽位按 <script> 方式拼这个文件，ESM 会直接崩；
 * 只有 __ModuleLoader__ 自注册形态能活。与 dsh-codebuddy-cli 的 client.js 一致。
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'

const SRC = dirname(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Za-z]):/, '$1:')
const cjsPath = join(SRC, 'lib', 'client', 'index.cjs')
const outPath = join(SRC, 'lib', 'client', 'index.js')
const id = 'dsh-codearts'

if (!existsSync(cjsPath)) {
  console.error('wrap-client: 找不到', cjsPath, '——请先 build')
  process.exit(1)
}

const cjs = readFileSync(cjsPath, 'utf8')
const wrapped =
  'window.__ModuleLoader__.load({\n' +
  `  id: ${JSON.stringify(id)},\n` +
  '  factory(require) {\n' +
  '    var module = { exports: {} };\n' +
  '    var exports = module.exports;\n' +
  cjs +
  '\n    return module.exports;\n' +
  '  }\n' +
  '});\n'

writeFileSync(outPath, wrapped, 'utf8')
rmSync(cjsPath, { force: true })
console.log(`wrap-client: ${id} 已包成 __ModuleLoader__ 自注册形态 -> lib/client/index.js (${wrapped.length} bytes)`)
