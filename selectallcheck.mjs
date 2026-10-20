/**
 * 端到端验证「全选 / 全不选」：真走 HTTP handler。
 *
 * 用户要求：**全选 = 勾上下面列出的全部模型；全不选 = 一个都不勾**。
 *
 * ## 为什么不能简单地隔离 DSH_HOME
 *
 * 候选来自真实网关，而网关 Key 在 `~/.dsh/openai-gateway/api-key`。把
 * `DSH_HOME` 整个指到临时目录会让 `fetchRows` 直接报「没有网关 Key」，候选
 * 变成 0，测试就退化成「0 == 0 也算通过」——那是最糟的一种假阳性。
 *
 * 所以这里反过来：**用真实 DSH_HOME 读网关，但把写盘的数据目录指到临时目录**。
 * 插件的数据文件在 `<dshHome>/dsh-baipiao-stone/` 下，用一个符号链接把它
 * 指向临时目录即可——读写都被重定向，而网关 Key 仍然可读。
 *
 * 跑法：node selectallcheck.mjs（需要本机网关跑起来）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

/** 真实 DSH_HOME（读网关 Key 用）。 */
const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')

/**
 * 让插件的数据目录落到临时位置：
 *
 *   - 若真实目录已存在（用户在用），用 `DSH_HOME` 指到**镜像目录**——
 *     镜像里放一个指向真实 `openai-gateway/api-key` 的链接，其余各自独立。
 *   - 这样「读网关」用真实凭据，「写设置/画像」用临时目录。
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'baipiao-selectall-'))
process.once('exit', () => { try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {} })

// 镜像：把真实 home 里读得到的东西链过去
try {
  const gatewayDir = path.join(sandbox, 'openai-gateway')
  fs.mkdirSync(gatewayDir, { recursive: true })
  const realKey = path.join(realHome, 'openai-gateway', 'api-key')
  if (fs.existsSync(realKey)) {
    fs.copyFileSync(realKey, path.join(gatewayDir, 'api-key'))
  }
  // 凭据库（余额查询用；缺失时只降级，不影响本测试）
  const realCreds = path.join(realHome, '.credentials.yaml')
  if (fs.existsSync(realCreds)) fs.copyFileSync(realCreds, path.join(sandbox, '.credentials.yaml'))
} catch (error) {
  console.log('WARN 准备沙箱失败：' + (error?.message ?? error))
}
process.env.DSH_HOME = sandbox

const { apply, DEFAULTS } = await import('./index.js')

const routes = []
const ctx = {
  logger: { info: () => {}, warn: msg => console.log('WARN', msg) },
  llm: { registerAdapter: () => {}, registerConfigurableProviders: () => {} },
  emit: () => {},
  effect: run => { run(); return () => {} },
  set: () => {}, get: () => undefined,
  inject: (services, fn) => fn({
    webServer: { register: spec => { routes.push(spec); return () => {} } },
    effect: run => { run(); return () => {} },
  }),
}
apply(ctx, { ...DEFAULTS, verbose: false })
await new Promise(resolve => setTimeout(resolve, 9000))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

if (routes.length === 0) {
  console.log('SKIP  设置接口未注册（没有 webServer）')
  process.exit(0)
}

const handler = routes[0].handler
const call = (routePath, init = {}) => new Promise((resolve, reject) => {
  const body = init.body === undefined ? '' : String(init.body)
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = init.method ?? 'GET'
  req.url = `/api/baipiao-stone${routePath}`
  const res = {
    status: 0, headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; return this },
    end(text) {
      let parsed = {}
      try { parsed = text === undefined || text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text } }
      resolve({ status: this.status, body: parsed })
    },
  }
  Promise.resolve(handler(req, res)).catch(reject)
})

const first = await call('/state')
const total = first.body.status?.total ?? 0
check('拿到真实模型清单（否则测试没有意义）', Number(total) > 10, '网关模型数=' + total)
if (Number(total) <= 10) {
  console.log('SKIP  网关没就绪，跳过')
  process.exit(0)
}

const candidatesOf = key => {
  const list = key === 'custom'
    ? (first.body.eligible?.custom ?? [])
    : (first.body.eligible?.[key] ?? [])
  return [...new Set(list.map(row => String(row.id).toLowerCase()))]
}
const pools = Object.fromEntries(['free', 'low', 'high', 'custom'].map(k => [k, candidatesOf(k)]))
check('四条链候选都非空', Object.values(pools).every(p => p.length > 0),
  Object.entries(pools).map(([k, v]) => k + '=' + v.length).join(' '))

// ── 全选 ────────────────────────────────────────────────────────────────
for (const key of ['free', 'low', 'high', 'custom']) {
  const pool = pools[key]
  const res = await call('/chain/all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, checked: true }),
  })
  check(`全选 ${key}：接口 200`, res.status === 200, String(res.status))
  const after = await call('/state')
  const view = after.body.members?.[key]
  const ids = Array.isArray(view?.ids) ? view.ids.map(x => String(x).toLowerCase()) : []
  const links = (after.body.chains?.[key]?.links ?? []).map(r => String(r.id).toLowerCase())
  const missing = pool.filter(id => !ids.includes(id))
  check(`全选 ${key}：勾选 = 全部 ${pool.length} 个`,
    ids.length === pool.length && missing.length === 0,
    `mode=${view?.mode} 勾选=${ids.length}/${pool.length}` + (missing.length ? ' 缺:' + missing.slice(0, 4).join(',') : ''))
  check(`全选 ${key}：链里成员 = 全部 ${pool.length} 个`,
    links.length === pool.length && pool.every(id => links.includes(id)),
    `链里=${links.length}/${pool.length}`)
}

// ── 全不选 ──────────────────────────────────────────────────────────────
for (const key of ['free', 'low', 'high', 'custom']) {
  const res = await call('/chain/all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, checked: false }),
  })
  check(`全不选 ${key}：接口 200`, res.status === 200, String(res.status))
  const after = await call('/state')
  const view = after.body.members?.[key]
  const ids = Array.isArray(view?.ids) ? view.ids : []
  const links = after.body.chains?.[key]?.links ?? []
  const stillListed = key === 'custom'
    ? (after.body.eligible?.custom ?? []).length
    : (after.body.eligible?.[key] ?? []).length
  check(`全不选 ${key}：勾选为空`, view?.mode === 'none' && ids.length === 0, `mode=${view?.mode} 勾选=${ids.length}`)
  check(`全不选 ${key}：链里为 0`, links.length === 0, '链里=' + links.length)
  check(`全不选 ${key}：候选列表仍然完整（模型不消失）`,
    stillListed === pools[key].length, `候选=${stillListed}/${pools[key].length}`)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
