#!/usr/bin/env node
/**
 * dsh-codearts 部署脚本（安全版，无 BOM）。
 *
 * 替代危险的 PowerShell 5.1 Set-Content/Out-File 文本写入：那些会带 UTF-8 BOM，
 * 导致 DSH 宿主 readProfileManifest 裸 JSON.parse 抛 DesktopHostFatalError 而连环崩溃。
 * 本脚本全部走 fs（二进制复制 / writeFileSync 无 BOM），写完用 BOM 校验兜底。
 *
 * 用法：node scripts/deploy.mjs [profileDir]
 *   profileDir 默认 <用户目录>/.dsh/profiles/desktop
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
const DEFAULT_PROFILE = join(HOME, '.dsh', 'profiles', 'desktop')
const PROFILE = process.argv[2] ?? DEFAULT_PROFILE
const SRC = dirname(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Za-z]):/, '$1:')

function bomFree(path) {
  const b = readFileSync(path)
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    throw new Error(`BOM detected in ${path} — 部署中止，请检查源文件`)
  }
}

function copyTree(src, dst) {
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) copyTree(s, d)
    else copyFileSync(s, d)
  }
}

function patchManifest(path, mutate) {
  if (!existsSync(path)) throw new Error(`manifest 不存在: ${path}`)
  bomFree(path)
  const raw = readFileSync(path, 'utf8')
  const json = JSON.parse(raw)
  mutate(json)
  // writeFileSync 默认无 BOM
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8')
  bomFree(path)
}

const PKG_NAME = 'dsh-codearts'
const PKG_VERSION = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).version ?? '0.1.0'

console.log('→ profile:', PROFILE)
console.log('→ 源目录:', SRC)

// 1) 二进制复制包本体
// 先清空 lib/ 再复制：copyTree 是合并语义，不清会残留旧 chunk（lib/lib/、过期
// catalog-*.mjs）导致部署目录膨胀、甚至被宿主加载到旧代码。
const dstPkg = join(PROFILE, 'node_modules', PKG_NAME)
const dstLib = join(dstPkg, 'lib')
if (existsSync(dstLib)) rmSync(dstLib, { recursive: true, force: true })
copyTree(join(SRC, 'lib'), dstLib)
for (const f of ['cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']) {
  const s = join(SRC, f)
  if (existsSync(s)) copyFileSync(s, join(dstPkg, f))
}
console.log('✓ 包本体已复制:', dstPkg)

// 2) profile/package.json 的 dependencies + bundles（缺 bundles 则插件不会被激活）
patchManifest(join(PROFILE, 'package.json'), (json) => {
  json.dependencies = json.dependencies ?? {}
  json.dependencies[PKG_NAME] = PKG_VERSION
  const bundles = json.dsh?.profile?.bundles
  if (Array.isArray(bundles) && !bundles.includes(PKG_NAME)) bundles.push(PKG_NAME)
})
console.log('✓ profile/package.json dependencies + bundles[dsh-codearts]')

// 3) .package-map.json
patchManifest(join(PROFILE, 'node_modules', '.package-map.json'), (json) => {
  json[PKG_NAME] = json[PKG_NAME] ?? { url: `./${PKG_NAME}`, dependencies: { [PKG_NAME]: PKG_NAME } }
  json['.'] = json['.'] ?? { dependencies: {} }
  json['.'].dependencies = json['.'].dependencies ?? {}
  json['.'].dependencies[PKG_NAME] = PKG_NAME
})
console.log('✓ .package-map.json')

// 4) .modules.yaml 的 hoistedLocations
patchManifest(join(PROFILE, 'node_modules', '.modules.yaml'), (json) => {
  json.hoistedLocations = json.hoistedLocations ?? {}
  json.hoistedLocations[`${PKG_NAME}@${PKG_VERSION}`] = [`node_modules\\${PKG_NAME}`]
})
console.log('✓ .modules.yaml hoistedLocations')

console.log('\n🎉 部署完成，全部 manifest 无 BOM。重启 DSH 即可。')
