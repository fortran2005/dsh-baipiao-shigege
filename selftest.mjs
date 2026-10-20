/**
 * 端到端自检：三条链、设置接口、真实调用（文本 / 图片 / 工具）。
 * 跑法：node selftest.mjs
 */
import { apply, DEFAULTS, Config, CHAIN_IDS } from './index.js'

const registered = {}
const ctx = {
  logger: { info: () => {}, warn: m => console.log('WARN', m) },
  llm: {
    registerAdapter: (routes, adapter) => { registered.routes = routes; registered.adapter = adapter },
    registerConfigurableProviders: () => {},
  },
  emit: () => {},
  effect: run => { run(); return () => {} },
  set: () => {},
  get: () => undefined,
  inject: () => {},
}

apply(ctx, { ...DEFAULTS, verbose: false })
await new Promise(resolve => setTimeout(resolve, 7000))

const adapter = registered.adapter
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

// 1. 设置 schema
const json = Config.toJSON()
const refs = json.refs
const root = Object.entries(refs).find(([, r]) => r.dict)
const fields = Object.keys(root?.[1]?.dict ?? {})
check('设置界面有 26 个可配置项', fields.length === 26, fields.join(', '))
check('每个字段都有说明文字',
  Object.values(root[1].dict).every(ref => typeof refs[ref]?.meta?.description === 'string'))

// 2. 三条链
check('provider 路由为 baipiao', registered.routes?.[0] === 'baipiao')
const models = await adapter.listModels('baipiao')
check('注册了 4 条链', models.length === 4, models.map(m => m.name).join(' / '))
check('四个名字都带 shigege- 前缀', models.every(m => m.name.startsWith('shigege-')),
  models.map(m => m.name).join(' / '))

// 内置四条链都要声明 1M + 图片；custom 是用户自选、可能为空，不强求。
for (const id of [CHAIN_IDS.free, CHAIN_IDS.low, CHAIN_IDS.high]) {
  const info = await adapter.resolveModel('baipiao', id)
  check(`${id} 声明 1M 上下文`, info.context.contextWindow >= 1000000, String(info.context.contextWindow))
  check(`${id} 声明可接收图片`, info.inputModalities.includes('image'))
}
check('custom 链已注册', (await adapter.resolveModel('baipiao', CHAIN_IDS.custom)).id === CHAIN_IDS.custom)

// 3-6. 真实调用较慢（思考阶段可能数十秒），默认只跑离线检查。
// 需要完整验证时：BPS_ONLINE=1 node selftest.mjs
const ONLINE = process.env.BPS_ONLINE === '1'
if (!ONLINE) {
  console.log('SKIP  在线调用（设 BPS_ONLINE=1 启用）')
  console.log(failures === 0 ? '离线检查全部通过' : `${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

const run = async (model, options) => {
  let text = ''
  let reason = ''
  for await (const chunk of adapter.stream({
    provider: 'baipiao', model,
    signal: new AbortController().signal, ...options,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') reason = chunk.reason.kind
  }
  return { text, reason }
}

const plain = await run(CHAIN_IDS.free, {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
  maxTokens: 600,
})
check('文本调用成功', plain.reason === 'stop' && plain.text.includes('PONG'), plain.text.slice(0, 40))

// 4. 真实调用：图片（同一条链，运行期自动挑能看图的模型）
let imageAnswer = ''
for await (const chunk of adapter.stream({
  provider: 'baipiao', model: CHAIN_IDS.free,
  signal: new AbortController().signal,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What colour is this image? One word.' },
      { type: 'image', attachment: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } },
    ],
  }],
  maxTokens: 800,
})) {
  if (chunk.type === 'text-delta') imageAnswer += chunk.text
}
check('同一条链接受图片并作答', imageAnswer.trim().length > 0, imageAnswer.slice(0, 40))

// 5. 真实调用：工具
let toolCall = null
for await (const chunk of adapter.stream({
  provider: 'baipiao', model: CHAIN_IDS.free,
  signal: new AbortController().signal,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Beijing? Use the tool.' }] }],
  tools: [{
    name: 'get_weather', description: 'Get weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }],
  maxTokens: 800,
})) {
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolCall = chunk.block
}
check('工具调用参数完整', toolCall !== null && toolCall.name === 'get_weather'
  && typeof toolCall.arguments === 'string' && toolCall.arguments.includes('Beijing'),
  toolCall === null ? '(no call)' : `${toolCall.name}(${toolCall.arguments})`)

// 6. 轮换不破坏链：连续三轮都要能启动
const started = []
for (let i = 0; i < 3; i += 1) {
  let chunks = 0
  for await (const _ of adapter.stream({
    provider: 'baipiao', model: CHAIN_IDS.high,
    signal: new AbortController().signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 8,
  })) {
    chunks += 1
    if (chunks > 2) break
  }
  started.push(chunks > 0)
}
check('连续三轮都能启动（轮换不破坏链）', started.every(Boolean))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
