#!/usr/bin/env node
/**
 * dsh-codearts 部署脚本（安全版，无 BOM）。
 *
 * 替代危险的 PowerShell 5.1 Set-Content/Out-File 文本写入：那些会带 UTF-8 BOM，
 * 导致 DSH 宿主 readProfileManifest 裸 JSON.parse 抛 DesktopHostFatalError 而连环崩溃。
 * 本脚本全部走 fs（二进制复制 / writeFileSync 无 BOM），写完用 BOM 校验兜底。
 *
 * 同步语义：**原地覆盖**，不删目录重建。
 *   - tsdown 的产物带内容哈希（catalog-<hash>.mjs），改名后的块靠"删旧"处理，而不是清空目录；
 *   - dsh-hmr 只监听 chokidar 的 `change` 事件（不处理 add/unlink），
 *     `rm -rf lib` 再拷回只会产生 unlink+add，热重载不会触发；
 *     原地覆盖才会让已加载模块的 mtime 变化，从而被 hmr 捕获。
 *
 * manifest 只在内容真的变化时才写：profile 的 package.json 被 dsh-hmr 的配置监听盯着，
 * 无谓的写入会触发一次整 profile 重新组合。
 *
 * 用法：node scripts/deploy.mjs [profileDir] [--quiet]
 *   profileDir 默认 <用户目录>/.dsh/profiles/desktop
 *
 * 也可以作为模块使用：`import { deploy } from './deploy.mjs'`（scripts/dev.mjs 就靠它）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 包内需要进 profile 的顶层文件（lib/ 之外）。 */
export const PACKAGE_ROOT_FILES = ['cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']

/** 仓库根目录（本文件在 scripts/ 下）。 */
export const SOURCE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 默认 profile 目录。 */
export function defaultProfileDir() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return join(home, '.dsh', 'profiles', 'desktop')
}

/**
 * 校验文件前 3 字节不是 UTF-8 BOM；命中即抛错中止部署。
 * @param {string} path
 */
export function assertNoBom(path) {
  const b = readFileSync(path)
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    throw new Error(`BOM detected in ${path} — 部署中止，请检查源文件`)
  }
}

/** 两个文件内容是否逐字节相同（大小不同直接判否）。 */
function sameBytes(a, b) {
  const sa = statSync(a).size
  if (sa !== statSync(b).size) return false
  return readFileSync(a).equals(readFileSync(b))
}

/**
 * 把 src 树同步进 dst：内容不同的**原地覆盖**，源里没有的删掉。
 * 内容相同的文件不动（保持 mtime，避免无意义的热重载）。
 * @param {string} src
 * @param {string} dst
 * @param {{added:number,updated:number,unchanged:number,pruned:number}} stats
 */
function syncTree(src, dst, stats) {
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true })
  const names = new Set(readdirSync(src))
  for (const name of names) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) {
      syncTree(s, d, stats)
      continue
    }
    if (existsSync(d) && statSync(d).isFile() && sameBytes(s, d)) {
      stats.unchanged++
      continue
    }
    const existed = existsSync(d)
    copyFileSync(s, d) // 原地覆盖 => chokidar 的 change 事件
    if (existed) stats.updated++
    else stats.added++
  }
  for (const name of readdirSync(dst)) {
    if (names.has(name)) continue
    rmSync(join(dst, name), { recursive: true, force: true })
    stats.pruned++
  }
}

/** 需要改动 manifest 时先留一份备份，回滚直接还原即可。 */
function backup(path) {
  const stamp = Date.now()
  const dst = `${path}.bak-codearts-${stamp}`
  copyFileSync(path, dst)
  return dst
}

/**
 * 就地改一个 JSON manifest，只有语义真的变了才落盘（无 BOM）。
 * @param {string} path
 * @param {(json: any) => void} mutate
 * @returns {{changed: boolean, backup?: string}}
 */
function patchManifest(path, mutate) {
  if (!existsSync(path)) throw new Error(`manifest 不存在: ${path}`)
  assertNoBom(path)
  const original = readFileSync(path, 'utf8')
  const before = JSON.parse(original)
  const json = JSON.parse(original)
  mutate(json)
  // 语义比较：格式差异（缩进/键序）不算变化，免得白写一次触发 profile 重载。
  if (JSON.stringify(before) === JSON.stringify(json)) return { changed: false }
  const backupPath = backup(path)
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8') // writeFileSync 默认无 BOM
  assertNoBom(path)
  return { changed: true, backup: backupPath }
}

/**
 * 把构建产物部署进 profile。
 * @param {{profileDir?: string, quiet?: boolean, log?: (line: string) => void}} [options]
 * @returns {{profileDir: string, packageDir: string, version: string, files: object, manifests: object}}
 */
export function deploy(options = {}) {
  const profileDir = options.profileDir ?? defaultProfileDir()
  const quiet = options.quiet === true
  const log = options.log ?? ((line) => { if (!quiet) console.log(line) })

  const src = SOURCE_DIR
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  const pkgName = pkg.name ?? 'dsh-codearts'
  const pkgVersion = pkg.version ?? '0.1.0'

  const srcLib = join(src, 'lib')
  if (!existsSync(srcLib)) {
    throw new Error(`找不到构建产物 ${srcLib} —— 先跑 pnpm run build`)
  }
  log(`→ profile: ${profileDir}`)
  log(`→ 源目录: ${src}`)

  // 1) 包本体：lib/ 原地同步 + 顶层文件覆盖
  const packageDir = join(profileDir, 'node_modules', pkgName)
  const files = { added: 0, updated: 0, unchanged: 0, pruned: 0 }
  syncTree(srcLib, join(packageDir, 'lib'), files)
  for (const name of PACKAGE_ROOT_FILES) {
    const s = join(src, name)
    if (!existsSync(s)) continue
    const d = join(packageDir, name)
    if (existsSync(d) && sameBytes(s, d)) {
      files.unchanged++
      continue
    }
    const existed = existsSync(d)
    if (!existsSync(packageDir)) mkdirSync(packageDir, { recursive: true })
    copyFileSync(s, d)
    if (existed) files.updated++
    else files.added++
  }
  log(
    `✓ 包本体已同步: ${packageDir}` +
      ` (新增 ${files.added} / 覆盖 ${files.updated} / 未变 ${files.unchanged} / 清理 ${files.pruned})`,
  )
  if (!existsSync(join(packageDir, 'lib', 'client', 'index.js'))) {
    log('⚠ 缺少 lib/client/index.js —— 客户端卡片不会加载（build 后需要 wrap-client）')
  }

  // 2) profile/package.json 的 dependencies + bundles（缺 bundles 则插件不会被激活）
  const manifests = {}
  manifests.profilePackage = patchManifest(join(profileDir, 'package.json'), (json) => {
    json.dependencies = json.dependencies ?? {}
    json.dependencies[pkgName] = pkgVersion
    const bundles = json.dsh?.profile?.bundles
    if (Array.isArray(bundles) && !bundles.includes(pkgName)) bundles.push(pkgName)
  })
  log(
    manifests.profilePackage.changed
      ? '✓ profile/package.json dependencies + bundles'
      : '· profile/package.json 无需改动',
  )

  // 3) .package-map.json
  manifests.packageMap = patchManifest(join(profileDir, 'node_modules', '.package-map.json'), (json) => {
    json[pkgName] = json[pkgName] ?? { url: `./${pkgName}`, dependencies: { [pkgName]: pkgName } }
    json['.'] = json['.'] ?? { dependencies: {} }
    json['.'].dependencies = json['.'].dependencies ?? {}
    json['.'].dependencies[pkgName] = pkgName
  })
  log(manifests.packageMap.changed ? '✓ .package-map.json' : '· .package-map.json 无需改动')

  // 4) .modules.yaml 的 hoistedLocations
  manifests.modulesYaml = patchManifest(join(profileDir, 'node_modules', '.modules.yaml'), (json) => {
    json.hoistedLocations = json.hoistedLocations ?? {}
    json.hoistedLocations[`${pkgName}@${pkgVersion}`] = [`node_modules\\${pkgName}`]
  })
  log(manifests.modulesYaml.changed ? '✓ .modules.yaml hoistedLocations' : '· .modules.yaml 无需改动')

  const changedFiles = files.added + files.updated + files.pruned
  log(changedFiles === 0 ? '\n· 产物无变化，manifest 全部无 BOM。' : '\n🎉 部署完成，全部 manifest 无 BOM。')
  if (changedFiles > 0) {
    log(
      '  提示：profile 已启用 dsh-hmr 的模块监听时，宿主插件会被热重载；\n' +
        '        客户端产物变化由 dsh-client-hmr 自动送进浏览器，无需刷新页面。',
    )
  }
  return { profileDir, packageDir, version: pkgVersion, files, manifests }
}

/** CLI 入口。 */
function main(argv) {
  const quiet = argv.includes('--quiet')
  const profileDir = argv.find((arg) => !arg.startsWith('--'))
  try {
    deploy({ profileDir: profileDir ?? defaultProfileDir(), quiet })
    if (!quiet) console.log('重启 DSH 即可（若未启用 hmr 模块监听）。')
  } catch (error) {
    console.error(`部署失败: ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
