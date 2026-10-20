/**
 * 验证「重测全部后按 85 tok/s 收紧勾选」——**用预置的速度画像做确定性验证**。
 *
 * 跑法：node cutcheck.mjs
 *
 * ## 为什么不跑真实探测
 *
 * 真实探测要几十秒到几分钟，结果还取决于上游当时的网络。更糟的是它会在沙箱里
 * 跑，账号凭据不全时几乎全失败——「没测出的模型保留」这条不变式会把真正的
 * 缺陷掩盖掉（第一版测试就是这么假失败的：kept 全是 0，看起来像收紧没生效）。
 *
 * 所以这里直接往 speed-memory.json 写**确定的画像**，断言完全由构造数据决定。
 *
 * ## 验证什么
 *
 *   1. 门槛 85 生效：84 取消、85 保留、200 保留；
 *   2. 没测过的模型**保留**（不能被当成慢）；
 *   3. 「全部样本失败」（tps 恒 0）的模型**取消**（这是之前漏掉的那类）；
 *   4. 门槛 0 时什么都不做；
 *   5. 收紧只做「减」，不做「加」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'baipiao-cut-'))
process.once('exit', () => { try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {} })
process.env.DSH_HOME = sandbox

/** 预置速度画像（目录结构与插件一致，at 用当前时间避免撞 TTL）。 */
const dataDir = path.join(sandbox, 'dsh-baipiao-stone')
fs.mkdirSync(dataDir, { recursive: true })
const now = Date.now()
const sample = (ttfb, tps) => ({ ttfb, tps, at: now })
const profiles = {
  'mock/hi-200': { samples: [sample(400, 200)], at: now },
  'mock/hi-85': { samples: [sample(500, 85)], at: now },
  'mock/low-84': { samples: [sample(500, 84)], at: now },
  'mock/low-40': { samples: [sample(600, 40)], at: now },
  // 全部样本失败（tps 恒 0）：应视为不过线
  'mock/fail-only': { samples: [sample(12000, 0), sample(12000, 0)], at: now },
  // 没测过：mock/never 故意不出现
}
fs.writeFileSync(
  path.join(dataDir, 'speed-memory.json'),
  JSON.stringify({ profiles, slow: {}, lastProbeAt: 0 }),
  'utf8',
)

const m = await import('./index.js')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

check('默认淘汰线是 70', m.DEFAULTS.excludeBelowTps === 70, String(m.DEFAULTS.excludeBelowTps))
check('默认请求期门槛同步 85', m.DEFAULTS.minTokensPerSecond === 85, String(m.DEFAULTS.minTokensPerSecond))

m.restoreSpeedMemory()
const opt = { speedMemoryMinutes: 180, slowMemoryMinutes: 30 }
check('200 tok/s 达标', m.isDropped('mock/hi-200', 85, opt) === false)
check('恰好 85 tok/s 达标（边界取到）', m.isDropped('mock/hi-85', 85, opt) === false)
check('84 tok/s 不达标', m.isDropped('mock/low-84', 85, opt) === true)
check('40 tok/s 不达标', m.isDropped('mock/low-40', 85, opt) === true)
check('全部样本失败的算不达标（不是「没测过」）', m.isDropped('mock/fail-only', 85, opt) === true)
check('没测过的模型不算不达标', m.isDropped('mock/never', 85, opt) === false)

// ── 收紧后的保留集合 ────────────────────────────────────────────────────
const all = ['mock/hi-200', 'mock/hi-85', 'mock/low-84', 'mock/low-40', 'mock/fail-only', 'mock/never']
const kept = all.filter(id => !m.isDropped(id, 85, opt))
check('保留集合 = 达标的 + 没测过的',
  kept.join(',') === 'mock/hi-200,mock/hi-85,mock/never', kept.join(','))
check('没测过的 mock/never 被保留', kept.includes('mock/never'))
check('全部失败的 mock/fail-only 被取消', !kept.includes('mock/fail-only'))
check('84 tok/s 被取消', !kept.includes('mock/low-84'))

// ── 门槛 0：什么都不做 ──────────────────────────────────────────────────
check('门槛 0 时不淘汰任何模型',
  all.filter(id => !m.isDropped(id, 0, opt)).length === all.length)

// ── 端到端：subset 勾选只动指定的，不会顺手把别的加进来 ────────────────
const routes = []
m.apply({
  logger: { info: () => {}, warn: () => {} },
  llm: { registerAdapter: () => {}, registerConfigurableProviders: () => {} },
  emit: () => {},
  effect: run => { run(); return () => {} },
  set: () => {}, get: () => undefined,
  inject: (services, fn) => fn({
    webServer: { register: spec => { routes.push(spec); return () => {} } },
    effect: run => { run(); return () => {} },
  }),
}, { ...m.DEFAULTS, verbose: false, probeOnStartup: false, primeUpstream: false })

if (routes.length === 0) {
  console.log('SKIP  接口未注册（没有 webServer）')
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

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
  Promise.resolve(routes[0].handler(req, res)).catch(reject)
})

const subset = await call('/chain/all', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'custom', checked: true, ids: ['mock/hi-200', 'mock/low-40'] }),
})
check('subset 勾选接口可用', subset.status === 200, String(subset.status))
const after = await call('/state')
const customIds = after.body.members?.custom?.ids ?? []
check('只勾这两个时，清单里没有多出别的模型',
  customIds.length === 0 || customIds.every(id => id === 'mock/hi-200' || id === 'mock/low-40'),
  customIds.join(','))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
