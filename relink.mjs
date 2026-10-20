#!/usr/bin/env node
/**
 * dsh-baipiao-shigege —— 重新链接脚本（持久化保障）
 *
 * 权威副本：~/.dsh/local-plugins/dsh-baipiao-shigege
 * profile ：~/.dsh/profiles/desktop
 *
 * 为什么需要它
 * ------------
 * profile 的 package.json 用 `link:../../local-plugins/dsh-baipiao-shigege` 指向权威副本，
 * pnpm 在 node_modules 下产生一个**目录联接（junction / symlink）**，因此权威副本里的
 * 改动（包括新增文件）立刻对运行中的 DSH 可见，且 pnpm install 不会复制一份陈旧副本。
 *
 * 但是 pnpm 的 `file:` 语义是「打包目录内容 + 硬链接进 node_modules」：一旦有人把
 * package.json 改回 `file:`，或某次插件操作按 `file:` 重新解析，node_modules 下会变成
 * 一个**独立的目录**（文件是硬链接，nlink=2）。此时：
 *   - 原地编辑（echo >> file、writeFile）仍会同步（同 inode）；
 *   - 但编辑器/工具用「临时文件 + rename」保存、或从 git 检出、或 pnpm 重新解包时，
 *     inode 被替换 → node_modules 里留下旧内容，且**新增文件完全不可见**。
 * 这就是「本地副本被覆盖/不同步」的真实机制。
 *
 * 本脚本做四件事（幂等，可反复运行）：
 *   1. 若 node_modules/dsh-baipiao-shigege 不是指向权威副本的联接，先改名备份再重建联接；
 *   2. 把 package.json 的依赖值收敛为 `link:<相对路径>`（改前备份）；
 *   3. 确保 bundles 列表里有 dsh-baipiao-shigege（DSH 靠它加载 bundle patch）；
 *   4. 确保 pnpm-lock.yaml 的 importer 条目与 package.json 一致，并做导入自检。
 *
 * 用法：
 *   node relink.mjs            # 修复并自检
 *   node relink.mjs --check    # 只检查，不写盘；不同步时退出码 1
 *   node relink.mjs --dry-run  # 打印将要做的事，不写盘
 *
 * 回滚：脚本每次修改前都会把原文件备份成
 *   package.json.bak-relink-<时间戳> / pnpm-lock.yaml.bak-relink-<时间戳>
 * 并把被替换的旧 node_modules 目录改名为 .bak-relink-<时间戳>。
 * 手工回滚：
 *   cd ~/.dsh/profiles/desktop
 *   copy /Y package.json.bak-relink-<时间戳> package.json
 *   copy /Y pnpm-lock.yaml.bak-relink-<时间戳> pnpm-lock.yaml
 *   rmdir node_modules\dsh-baipiao-shigege
 *   move node_modules\.bak-relink-<时间戳> node_modules\dsh-baipiao-shigege
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const AUTH = path.dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-baipiao-shigege'
const PROFILE = path.resolve(AUTH, '..', '..', 'profiles', 'desktop')
const MODULES = path.join(PROFILE, 'node_modules')
const LINK = path.join(MODULES, PKG_NAME)
const PROFILE_PKG = path.join(PROFILE, 'package.json')
const PROFILE_LOCK = path.join(PROFILE, 'pnpm-lock.yaml')

const argv = new Set(process.argv.slice(2))
const CHECK = argv.has('--check')
const DRY = argv.has('--dry-run') || CHECK
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

const log = (msg) => console.log(msg)
const changes = []
const problems = []

/** 读 JSON；失败返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 备份并写回（DRY 时只记录）。 */
function writeWithBackup(file, text, label) {
  const backup = `${file}.bak-relink-${STAMP}`
  if (DRY) {
    changes.push(`would back up ${file} -> ${path.basename(backup)} and rewrite (${label})`)
    return backup
  }
  if (fs.existsSync(file)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, text, 'utf8')
  changes.push(`rewrote ${path.basename(file)} (${label}); backup=${backup}`)
  return backup
}

/** 权威副本自检。 */
function checkAuthoritative() {
  const manifest = readJson(path.join(AUTH, 'package.json'))
  if (manifest === undefined) throw new Error(`权威副本缺少 package.json：${AUTH}`)
  if (manifest.name !== PKG_NAME) throw new Error(`权威副本 package.json 的 name 是 ${manifest.name}，期望 ${PKG_NAME}`)
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml']) {
    if (!fs.existsSync(path.join(AUTH, file))) throw new Error(`权威副本缺少 ${file}：${AUTH}`)
  }
  return manifest
}

/** 期望的依赖写法：相对 profile 的 link: 路径，Windows 下用 / 分隔。 */
function expectedSpec() {
  const rel = path.relative(PROFILE, AUTH).split(path.sep).join('/')
  return `link:${rel}`
}

/** node_modules 下的条目当前形态。用 lstat，断链的联接也要能识别（existsSync 会把断链当不存在）。 */
function inspectLink() {
  const st = fs.lstatSync(LINK, { throwIfNoEntry: false })
  if (st === undefined) return { kind: 'missing' }
  if (st.isSymbolicLink()) {
    let real
    try {
      real = fs.realpathSync.native(LINK)
    } catch (error) {
      return { kind: 'broken-link', error: String(error) }
    }
    const same = path.resolve(real).toLowerCase() === path.resolve(fs.realpathSync.native(AUTH)).toLowerCase()
    return { kind: same ? 'junction-ok' : 'junction-wrong', target: real }
  }
  if (st.isDirectory()) {
    const probe = path.join(LINK, 'index.js')
    const st2 = fs.existsSync(probe) ? fs.statSync(probe) : undefined
    const authProbe = path.join(AUTH, 'index.js')
    const authId = fs.statSync(authProbe)
    const hardlinked = st2 !== undefined && st2.dev === authId.dev && st2.ino === authId.ino
    return { kind: hardlinked ? 'hardlink-copy' : 'independent-copy' }
  }
  return { kind: 'not-a-directory' }
}

/** 用 junction 把 node_modules/dsh-baipiao-shigege 指向权威副本。 */
function relink() {
  const state = inspectLink()
  if (state.kind === 'junction-ok') {
    log(`[ok] node_modules/${PKG_NAME} 已经是指向权威副本的联接`)
    return
  }
  const detail = state.kind === 'junction-wrong' ? ` -> ${state.target}` : ''
  log(`[fix] node_modules/${PKG_NAME} 形态为 ${state.kind}${detail}；重建为 junction`)
  if (DRY) {
    changes.push(`would remove node_modules/${PKG_NAME} (${state.kind}) and create junction -> ${AUTH}`)
    return
  }
  if (state.kind !== 'missing') {
    // 旧条目一律留作备份：可能是硬链接副本、独立副本，或指向别处的联接。
    let backup = path.join(MODULES, `.bak-relink-${STAMP}`)
    for (let i = 2; fs.lstatSync(backup, { throwIfNoEntry: false }) !== undefined; i += 1) {
      backup = path.join(MODULES, `.bak-relink-${STAMP}-${i}`)
    }
    fs.renameSync(LINK, backup)
    changes.push(`moved node_modules/${PKG_NAME} -> node_modules/${path.basename(backup)}`)
  }
  fs.mkdirSync(MODULES, { recursive: true })
  // 兜底：rename 之后仍可能残留（例如文件系统竞态或非联接的普通文件）。
  if (fs.lstatSync(LINK, { throwIfNoEntry: false }) !== undefined) fs.rmSync(LINK, { recursive: true, force: true })
  fs.symlinkSync(AUTH, LINK, 'junction')
  changes.push(`created junction node_modules/${PKG_NAME} -> ${AUTH}`)
}

/** 收敛 package.json：依赖写法 + bundles 列表。 */
function fixManifest() {
  const raw = fs.readFileSync(PROFILE_PKG, 'utf8')
  const manifest = JSON.parse(raw)
  const want = expectedSpec()
  let dirty = false

  manifest.dependencies ??= {}
  if (manifest.dependencies[PKG_NAME] !== want) {
    log(`[fix] dependencies["${PKG_NAME}"]: ${JSON.stringify(manifest.dependencies[PKG_NAME])} -> ${JSON.stringify(want)}`)
    manifest.dependencies[PKG_NAME] = want
    dirty = true
  } else {
    log(`[ok] dependencies["${PKG_NAME}"] = ${want}`)
  }

  const profileSection = (manifest.dsh ??= {}).profile ??= {}
  const bundles = (profileSection.bundles ??= [])
  if (!bundles.includes(PKG_NAME)) {
    log(`[fix] bundles 列表补上 ${PKG_NAME}`)
    bundles.push(PKG_NAME)
    dirty = true
  } else {
    log(`[ok] bundles 列表已包含 ${PKG_NAME}`)
  }

  if (dirty) writeWithBackup(PROFILE_PKG, JSON.stringify(manifest, undefined, 2) + '\n', 'dependencies + bundles')
  return manifest
}

/**
 * 保障 peer 依赖解析（**这是 link: 方案唯一的功能性代价，必须由本脚本兜住**）。
 *
 * 为什么需要：`link:` 让 DSH 通过联接加载插件，Node 会先把联接解析成**真实路径**
 * （即 local-plugins/...），于是插件里的 `import('@deepseek-ai/schemastery')`
 * 从**权威副本**向上找 node_modules —— 而 schemastery 只装在 profile 里。
 * 结果是 index.js 顶层的 try/catch 吞掉 MODULE_NOT_FOUND，`Config` 变成 undefined，
 * **设置页表单整块消失**（其余功能仍按 DEFAULTS 正常工作，所以不会报错，极难发现）。
 *
 * 兜法：在权威副本里放一个 node_modules，把插件需要的 peer 逐个联接到 profile 的副本。
 * 这样无论从哪条路径加载，解析都能命中，且不复制代码、不引入版本漂移。
 *
 * @param manifest - 权威副本的 package.json。
 */
function fixPeerResolution(manifest) {
  const peers = Object.keys(manifest.peerDependencies ?? {})
  // index.js 实际会动态 import 的构建期依赖：即使没写进 peerDependencies 也要保障。
  const needed = [...new Set([...peers, '@deepseek-ai/schemastery'])]
  const localModules = path.join(AUTH, 'node_modules')
  let fixed = false

  for (const name of needed) {
    const target = path.join(localModules, ...name.split('/'))
    const current = fs.lstatSync(target, { throwIfNoEntry: false })
    if (current !== undefined) continue

    // 从 profile 找这个包的落点（pnpm 的真实位置）。
    let source
    try {
      source = path.dirname(createRequire(PROFILE_PKG).resolve(`${name}/package.json`))
    } catch {
      // 解析不到（既没装也没有 ./package.json 导出）就跳过：不是每个 peer 都在这里可解析。
      continue
    }
    log(`[fix] ${name}: 权威副本里缺 peer 依赖，联接 profile 的副本`)
    if (DRY) {
      changes.push(`would link ${path.relative(AUTH, target)} -> ${source}`)
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(source, target, 'junction')
    changes.push(`linked ${name} into ${path.basename(AUTH)}/node_modules (peer resolution)`)
    fixed = true
  }

  if (!fixed && !DRY && needed.length > 0) log('[ok] peer 依赖解析可用（权威副本内的 node_modules 已就绪）')
}

/** 收敛 lockfile 的 importer 条目（只动 importer，不重解依赖）。 */
function fixLockfile(spec) {
  if (!fs.existsSync(PROFILE_LOCK)) {
    problems.push('缺少 pnpm-lock.yaml；请运行 `dsh plugin --profile desktop install` 或 `node relink.mjs` 后再检查')
    return
  }
  let text = fs.readFileSync(PROFILE_LOCK, 'utf8')
  const entry = `      ${PKG_NAME}:\n        specifier: ${spec}\n        version: ${spec}\n`
  const entryRe = new RegExp(`^ {6}${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n(?: {8}.*\\n)+`, 'm')
  const existing = entryRe.exec(text)
  if (existing !== null && existing[0] === entry) {
    log(`[ok] pnpm-lock.yaml importer 条目与 package.json 一致`)
    return
  }
  if (existing !== null) {
    log(`[fix] pnpm-lock.yaml importer 条目改写为 ${spec}`)
    text = text.replace(entryRe, entry)
    writeWithBackup(PROFILE_LOCK, text, `importer ${PKG_NAME} -> ${spec}`)
    return
  }
  const anchor = '    dependencies:\n'
  const at = text.indexOf(anchor)
  if (at === -1) {
    problems.push('pnpm-lock.yaml 里找不到 importers 的 dependencies 段，未自动修改；请跑 `pnpm install --lockfile-only`')
    return
  }
  log(`[fix] pnpm-lock.yaml importer 补上 ${PKG_NAME} -> ${spec}`)
  const insertAt = at + anchor.length
  text = `${text.slice(0, insertAt)}${entry}${text.slice(insertAt)}`
  writeWithBackup(PROFILE_LOCK, text, `importer ${PKG_NAME} -> ${spec}`)
}

/** 运行期自检：解析 + 导入（只读，--check 也跑）。 */
async function verify() {
  if (DRY && !CHECK) return
  const require = createRequire(PROFILE_PKG)
  let resolvedPkg
  try {
    resolvedPkg = require.resolve(`${PKG_NAME}/package.json`)
  } catch (error) {
    problems.push(`从 profile 解析不到 ${PKG_NAME}/package.json：${error.message}`)
    return
  }
  const manifest = require(`${PKG_NAME}/package.json`)
  log(`[ok] 从 profile 解析到 ${resolvedPkg}`)
  if (manifest.name !== PKG_NAME) problems.push(`解析到的 package.json name=${manifest.name}，期望 ${PKG_NAME}`)
  if (manifest.dsh?.bundle === undefined) problems.push('package.json 缺少 dsh.bundle，DSH 不会加载它')
  const mod = await import(pathToFileURL(path.join(AUTH, 'index.js')).href)
  if (mod.name !== 'baipiao-stone') problems.push(`index.js 导出的 name=${mod.name}，期望 'baipiao-stone'`)
  else log(`[ok] index.js 导出 name='baipiao-stone'（export 数量 ${Object.keys(mod).length}）`)
  // Config 是「设置页表单」的开关：peer 依赖解析失败时它会静默变 undefined。
  if (mod.Config === undefined) {
    problems.push('index.js 的 Config 是 undefined —— peer 依赖（@deepseek-ai/schemastery）解析失败，设置页会整块消失；运行 `node relink.mjs` 修复')
  } else {
    // Config 是 Schemastery schema；字段数取 toJSON().refs 里 type:'object' 那一层的 dict。
    let fieldCount = 0
    try {
      const refs = mod.Config.toJSON().refs ?? {}
      const objectRef = Object.values(refs).find((ref) => ref?.type === 'object')
      fieldCount = Object.keys(objectRef?.dict ?? {}).length
    } catch {
      fieldCount = -1
    }
    log(`[ok] Config schema 可用（设置页表单正常，${fieldCount < 0 ? '字段数未知' : `${fieldCount} 个字段`}）`)
  }
  const linkStat = inspectLink()
  if (linkStat.kind !== 'junction-ok') problems.push(`node_modules 链接形态异常：${linkStat.kind}`)
  else log('[ok] node_modules 链接形态：junction -> 权威副本')
  // pnpm 把不在依赖树里的条目挪进 .ignored；这里只提示，不擅自删除。
  const ignored = path.join(MODULES, '.ignored', PKG_NAME)
  if (fs.lstatSync(ignored, { throwIfNoEntry: false }) !== undefined) {
    log(`[note] pnpm 曾把旧副本挪到 node_modules/.ignored/${PKG_NAME}，可安全删除`)
  }
}

log(`权威副本：${AUTH}`)
log(`profile ：${PROFILE}${DRY ? '（只检查，不写盘）' : ''}`)
checkAuthoritative()
relink()
const manifest = fixManifest()
fixPeerResolution(manifest)
fixLockfile(expectedSpec())
await verify()

if (changes.length > 0) {
  log('\n本次改动：')
  for (const line of changes) log(`  - ${line}`)
}
if (problems.length > 0) {
  log('\n问题：')
  for (const line of problems) log(`  ✗ ${line}`)
  process.exit(1)
}
log(`\n结论：${PKG_NAME} 已锚定到权威副本；DSH 加载与 pnpm 安装都不会再产生陈旧副本。`)
log('回滚：见本文件顶部注释（package.json.bak-relink-* / pnpm-lock.yaml.bak-relink-* / node_modules/.bak-relink-*）')
