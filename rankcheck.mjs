/**
 * 验证「吞吐优先 + 快速档轮换 + 吞吐淘汰 + 账号排序」这一批新规则。
 *
 * 跑法：node rankcheck.mjs
 *
 * 为什么单独一个文件而不塞进 speedcheck：那个文件验的是「速度门槛与慢模型
 * 降级」这一层（请求期），这里验的是**候选选择与排序**（分层期），两者的
 * 输入与不变量完全不同。混在一起会让失败信息难以定位到底哪一层坏了。
 */
import {
  buildTiers, DEFAULTS, rotate, resetRotation, clearSlowModels,
  markSlow, markFast, recordSpeed, filterDropped, rankCandidates, throughputOf,
  planAccountOrder, resetAccountRotation, isSpeedFailure,
  resetRotation as _resetRotation,
} from './index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

/** 构造一行候选：默认 1M、可看图、倍率 0.1。 */
const row = (id, extra = {}) => ({
  id,
  provider: String(id).split('/')[0],
  model: String(id).split('/')[1] ?? '',
  name: id,
  rate: 0.1,
  free: false,
  vision: true,
  contextWindow: 1000000,
  expiringCredits: 0,
  ...extra,
})

// ── 1. 吞吐降序：链的顺序就是「谁快谁在前」 ────────────────────────────────
clearSlowModels()
resetRotation()
resetAccountRotation()
const ids = ['buddy/slow', 'buddy/fast', 'trae/mid', 'trae/fastest']
recordSpeed('buddy/slow', { ttfb: 800, tps: 8 })
recordSpeed('buddy/fast', { ttfb: 1600, tps: 120 })
recordSpeed('trae/mid', { ttfb: 700, tps: 60 })
recordSpeed('trae/fastest', { ttfb: 3000, tps: 240 })

const rows = ids.map(id => row(id))
let tiers = buildTiers(rows, { ...DEFAULTS, excludeBelowTps: 0, perProviderLinks: 10, maxLinks: 10 })

const highOrder = tiers.low.map(r => r.id)
check('low 链按吞吐降序（最快在最前）',
  highOrder[0] === 'trae/fastest', highOrder.join(' > '))
check('首字慢但吞吐高仍排前面（吞吐优先于首字）',
  highOrder.indexOf('trae/fastest') < highOrder.indexOf('buddy/fast'), highOrder.join(' > '))

// 同一档（60 与 120 都在 2 档 / 4 档）会按价格排，但跨档必须按吞吐。
const noBand = { ...DEFAULTS, excludeBelowTps: 0, throughputBandTps: 0, perProviderLinks: 10, maxLinks: 10 }
const strict = buildTiers(rows, noBand).low.map(r => r.id)
check('档宽 0 = 严格按吞吐降序',
  strict.join(',') === 'trae/fastest,buddy/fast,trae/mid,buddy/slow', strict.join(' > '))

// ── 2. 吞吐淘汰：低于线的直接不进链 ────────────────────────────────────────
recordSpeed('buddy/slow', { ttfb: 800, tps: 8 })
const cut = buildTiers(rows, { ...DEFAULTS, excludeBelowTps: 50, perProviderLinks: 10, maxLinks: 10 })
const cutOrder = cut.low.map(r => r.id)
check('低于淘汰线的模型不进链', !cutOrder.includes('buddy/slow'), cutOrder.join(' '))
check('淘汰不影响达标的模型', cutOrder.includes('trae/fastest') && cutOrder.length === 3)

const never = buildTiers([row('buddy/unmeasured')], { ...DEFAULTS, excludeBelowTps: 50 })
check('没有实测数据的模型**不会**被淘汰', never.low.length === 1, `low=${never.low.length}`)

// ── 3. 快速档轮换：只在前 N 个里转 ─────────────────────────────────────────
resetRotation()
const sample = ['a', 'b', 'c', 'd', 'e']
const heads = []
for (let i = 0; i < 6; i += 1) heads.push(rotate(sample, 'band-chain', 3)[0])
check('快速档内轮换：链首只在前 3 个里转',
  heads.every(h => ['a', 'b', 'c'].includes(h)), heads.join(' '))
check('快速档轮换会回到头一个（3 次一循环）', heads.slice(0, 3).join('') !== 'aaa', heads.join(' '))
const rotatedOnce = rotate(sample, 'band-chain', 3)
check('档外成员保持原顺序接在后面',
  rotatedOnce.slice(3).join('') === 'de', rotatedOnce.join(''))

resetRotation()
const whole = []
for (let i = 0; i < 5; i += 1) whole.push(rotate(sample, 'whole-chain', 0)[0])
check('band=0 退回整条链轮换', new Set(whole).size === 5, whole.join(' '))

// ── 4. 过滤函数与分层用的是同一判据 ────────────────────────────────────────
const gated = filterDropped(rows, { excludeBelowTps: 50, speedMemoryMinutes: 180 })
check('filterDropped 与分层淘汰一致',
  !gated.some(r => r.id === 'buddy/slow') && gated.length === 3, gated.map(r => r.id).join(' '))
check('filterDropped 关掉淘汰时原样返回',
  filterDropped(rows, { excludeBelowTps: 0 }).length === rows.length)

const ranked = rankCandidates(rows, { excludeBelowTps: 50, speedMemoryMinutes: 180 })
check('rankCandidates 严格按吞吐降序',
  ranked.map(r => r.id).join(',') === 'trae/fastest,buddy/fast,trae/mid', ranked.map(r => r.id).join(' > '))
check('throughputOf 无数据返回 undefined', throughputOf('nope/none') === undefined)

// ── 5. 账号排序：先到期，再轮换 ────────────────────────────────────────────
resetAccountRotation()
const day = 24 * 60 * 60 * 1000
const accounts = [
  { id: 'buddy-a', enabled: true },
  { id: 'buddy-b', enabled: true },
  { id: 'buddy-c', enabled: true },
  { id: 'buddy-d', enabled: true },
]
const balances = [
  { accountId: 'buddy-a', nickname: 'a', total: 100, expiring: 0, nearestEnd: 0 },
  { accountId: 'buddy-b', nickname: 'b', total: 80, expiring: 80, nearestEnd: Date.now() + 2 * day },
  { accountId: 'buddy-c', nickname: 'c', total: 50, expiring: 50, nearestEnd: Date.now() + 5 * day },
  { accountId: 'buddy-d', nickname: 'd', total: 10, expiring: 0, nearestEnd: 0 },
]
const plan = planAccountOrder({
  provider: 'buddy', accounts, balances,
  options: { expiryFirst: true, rotation: true, windowDays: 15 },
})
check('快到期账号排最前面（越早作废越前）',
  plan.ordered.slice(0, 2).join(',') === 'buddy-b,buddy-c', plan.ordered.join(' > '))
check('到期账号数量正确', plan.expiring.length === 2, String(plan.expiring.length))
check('其余账号一个不少', plan.ordered.length === accounts.length)

resetAccountRotation()
const rotations = []
for (let i = 0; i < 4; i += 1) {
  rotations.push(planAccountOrder({
    provider: 'buddy', accounts, balances,
    options: { expiryFirst: true, rotation: true, windowDays: 15 },
  }).ordered.slice(2).join(','))
}
check('其余账号轮流当第一顺位', new Set(rotations).size >= 2, rotations.join(' | '))
check('轮换不改变「到期优先」这一层',
  rotations.every(r => !r.startsWith('buddy-b') && !r.startsWith('buddy-c')), rotations.join(' | '))

const noExpiry = planAccountOrder({
  provider: 'buddy', accounts, balances,
  options: { expiryFirst: false, rotation: false, windowDays: 15 },
})
check('关掉到期优先后按原顺序', noExpiry.ordered.join(',') === 'buddy-a,buddy-b,buddy-c,buddy-d',
  noExpiry.ordered.join(' '))
check('关掉轮换后顺序稳定', (() => {
  const a = planAccountOrder({ provider: 'x', accounts, balances, options: { rotation: false } }).ordered.join(',')
  const b = planAccountOrder({ provider: 'x', accounts, balances, options: { rotation: false } }).ordered.join(',')
  return a === b
})())

// 余额为 0 的账号即使快到到期，也不排第一
const zeroPlan = planAccountOrder({
  provider: 'buddy',
  accounts,
  balances: [
    { accountId: 'buddy-a', total: 0, expiring: 0, nearestEnd: Date.now() + day },
    { accountId: 'buddy-b', total: 80, expiring: 80, nearestEnd: Date.now() + 2 * day },
  ],
  options: { expiryFirst: true, rotation: false, windowDays: 15 },
})
check('余额为 0 的账号不占「快到期」首位', zeroPlan.expiring.join(',') === 'buddy-b', zeroPlan.expiring.join(' '))

// ── 6. 探测失败的归因 ─────────────────────────────────────────────────────
check('超时算速度失败', isSpeedFailure('超时（12s）') === true)
check('空响应算速度失败', isSpeedFailure('空响应（未产出任何内容）') === true)
check('HTTP 400 不算速度失败（不该被淘汰）', isSpeedFailure('HTTP 400 invalid tool call') === false)
check('HTTP 500 不算速度失败', isSpeedFailure('HTTP 500 upstream error') === false)

clearSlowModels()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
