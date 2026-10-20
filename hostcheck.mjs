/**
 * 宿主半身自检：四条链、设置接口、配置写回。
 * 跑法：node hostcheck.mjs
 */
import { apply, DEFAULTS, Config } from './index.js'

const registered = {}
const routes = []
const logs = []

const ctx = {
  logger: { info: m => logs.push(m), warn: m => logs.push('WARN ' + m) },
  llm: {
    registerAdapter: (providers, adapter) => { registered.providers = providers; registered.adapter = adapter },
    registerConfigurableProviders: () => {},
  },
  emit: () => {},
  effect: run => { run(); return () => {} },
  set: () => {},
  get: () => undefined,
  inject: (services, fn) => {
    // Pretend webServer exists so the API registration path runs.
    fn({
      webServer: { register: spec => { routes.push(spec); return () => {} } },
      effect: run => { run(); return () => {} },
    })
  },
}

apply(ctx, { ...DEFAULTS, verbose: false })
await new Promise(resolve => setTimeout(resolve, 6000))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

check('provider 路由', JSON.stringify(registered.providers) === '["baipiao"]')
check('四条链', (await registered.adapter.listModels('baipiao')).length === 4)
check('设置接口已注册', routes.length === 1, routes[0]?.path)
check('接口挂在 /api/baipiao-stone', routes[0]?.path === '/api/baipiao-stone')

// Drive the handler exactly as webServer does: Node's (req, res) pair.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const handler = routes[0].handler
const call = (path, init = {}) => new Promise((resolve, reject) => {
  const body = init.body === undefined ? '' : String(init.body)
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = init.method ?? 'GET'
  req.url = `/api/baipiao-stone${path}`
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; return this },
    end(text) {
      let parsed = {}
      try { parsed = text === undefined || text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text } }
      resolve({ status: this.status, body: parsed })
    },
  }
  Promise.resolve(handler(req, res)).catch(reject)
})

const state = await call('/state')
check('GET /state 返回四条链', state.status === 200
  && ['free', 'low', 'high', 'custom'].every(k => Array.isArray(state.body.chains?.[k]?.links)),
  Object.entries(state.body.chains ?? {}).map(([k, v]) => `${k}:${v.links.length}`).join(' '))

const config = await call('/config')
check('GET /config 回传设置项', config.status === 200 && typeof config.body.lowMaxRate === 'number')
check('GET /config 不回传明文 Key', config.body.gatewayKey === '' || config.body.gatewayKey === '••••••')

const saved = await call('/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ lowMaxRate: 0.25 }),
})
check('POST /config 写回并生效', saved.status === 200 && saved.body.lowMaxRate === 0.25,
  String(saved.body.lowMaxRate))

const bad = await call('/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ gatewayUrl: 'not-a-url' }),
})
check('POST /config 拒绝非法 URL', bad.status === 400, bad.body.error)

const refreshed = await call('/refresh', { method: 'POST', body: '{}' })
check('POST /refresh 重新分层', refreshed.status === 200
  && refreshed.body.chains?.free?.links?.length > 0,
  `free=${refreshed.body.chains?.free?.links?.length}`)

// Config schema still renders 9 fields.
const json = Config.toJSON()
const root = Object.entries(json.refs).find(([, r]) => r.dict)
check('设置 schema 是 26 项', Object.keys(root?.[1]?.dict ?? {}).length === 26,
  Object.keys(root?.[1]?.dict ?? {}).join(', '))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
