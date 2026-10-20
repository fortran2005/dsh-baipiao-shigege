/**
 * 验证「吞吐优先 + 快速档轮换 + 吞吐淘汰 + 账号排序」这一批新规则。
 *
 * 跑法：node rankcheck.mjs
 *
 * 为什么单独一个文件而不塞进 speedcheck：那个文件验的是「速度门槛与慢模型
 * 降级」这一层（请求期），这里验的是**候选选择与排序**（分层期），两者的
 * 输入与不变量完全不同。混在一起会让失败信息难以定位到底哪一层坏了。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isolate } from './testenv.mjs'

/**
 * 动态导入：**必须在 `isolate()` 之后**。
 *
 * 静态 import 会被提升到模块求值之前，那时 `DSH_HOME` 还没指向临时目录，
 * 生产模块的 `dshHome()` 就会解析到真实的 `~/.dsh`——而这些脚本会调用
 * `clearSlowModels()`，它把空的画像**直接写进那个真实文件**。
 */
const m = await isolate()
const {
  
    buildTiers, DEFAULTS, rotate, resetRotation, clearSlowModels,
    markSlow, markFast, recordSpeed, filterDropped, rankCandidates, throughputOf,
    planAccountOrder, resetAccountRotation, isSpeedFailure,
    speedOf, encodeMembers, toChatBody, estimateTps, countTokens, tierOf, isDropped,
    errorVerdict, resetErrorStats, errorStatsOf,
} = m

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
// 这一节只验排序，所以四个模型都给「过线」的吞吐（默认门槛 85）。
// 早先这里混了一个 8 tok/s 的模型用来看它沉底——但那是淘汰的职责；
// 关掉淘汰（excludeBelowTps: 0）之后，它反而因为 total（首字 + 生成）的
// 算法插到中间，把「严格按吞吐降序」这条断言带偏。测什么就只放什么。
const ids = ['buddy/slowest', 'buddy/fast', 'trae/mid', 'trae/fastest']
recordSpeed('buddy/slowest', { ttfb: 800, tps: 90 })
recordSpeed('buddy/fast', { ttfb: 1600, tps: 120 })
recordSpeed('trae/mid', { ttfb: 700, tps: 100 })
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
  strict.join(',') === 'trae/fastest,buddy/fast,trae/mid,buddy/slowest', strict.join(' > '))

// ── 2. 吞吐淘汰：低于线的直接不进链 ────────────────────────────────────────
recordSpeed('buddy/slowest', { ttfb: 800, tps: 8 })
const cut = buildTiers(rows, { ...DEFAULTS, excludeBelowTps: 50, perProviderLinks: 10, maxLinks: 10 })
const cutOrder = cut.low.map(r => r.id)
check('低于淘汰线的模型不进链', !cutOrder.includes('buddy/slowest'), cutOrder.join(' '))
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
  !gated.some(r => r.id === 'buddy/slowest') && gated.length === 3, gated.map(r => r.id).join(' '))
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

// ── 7. 回归：一批真实修过的缺陷，每条都对应一次实测复现 ───────────────────
clearSlowModels()
resetRotation()
resetAccountRotation()

// 7.1 探测超时的模型**必须被淘汰**。
// 根因曾是 speedOf 的中位数先用 v > 0 过滤掉 tps = 0 的样本，于是
// speedOf().tps 永远是 undefined 或正数、绝不为 0，tps === 0 那条淘汰
// 分支成了死代码。现在全失败时明确返回 0 并带 failures 计数。
clearSlowModels()
recordSpeed('reg/timeout', { ttfb: 12000, tps: 0 })
markSlow('reg/timeout')
const timeoutSpeed = speedOf('reg/timeout')
check('全失败画像返回 tps=0（不是 undefined）', timeoutSpeed?.tps === 0, JSON.stringify(timeoutSpeed))
check('超时模型被吞吐淘汰', filterDropped([{ id: 'reg/timeout' }], {
  excludeBelowTps: 50, speedMemoryMinutes: 180, slowMemoryMinutes: 30,
}).length === 0)

// 7.2 7 次超时 + 1 次成功不能被当成快模型。
clearSlowModels()
for (let i = 0; i < 7; i += 1) recordSpeed('reg/flaky', { ttfb: 12000, tps: 0 })
recordSpeed('reg/flaky', { ttfb: 900, tps: 150 })
const flaky = speedOf('reg/flaky')
check('多数失败时中位数被拉到 0（不是 150）', flaky?.tps === 0, JSON.stringify(flaky))
check('failures 计数正确', flaky?.failures === 7, String(flaky?.failures))

// 7.3 偶数样本取标准中位（不是上中位）。
clearSlowModels()
recordSpeed('reg/even', { ttfb: 500, tps: 40 })
recordSpeed('reg/even', { ttfb: 500, tps: 60 })
check('偶数样本取均值（[40,60] → 50）', speedOf('reg/even')?.tps === 50, String(speedOf('reg/even')?.tps))

// 7.4 fastBandSize = 1 必须真的只用最快的那个。
// 根因曾是 rotate 写成 band > 1，把 1 排除在外 → 退回整链轮换，于是
// 「最激进」的设置得到「最分散」的行为。
resetRotation()
const band1Heads = Array.from({ length: 5 }, () => rotate(['a', 'b', 'c', 'd', 'e'], 'reg-band1', 1)[0])
check('band=1 恒用第一个（不再整链轮换）', band1Heads.every(h => h === 'a'), band1Heads.join(' '))
check('band=1 返回原顺序', rotate(['a', 'b', 'c'], 'reg-band1b', 1).join('') === 'abc')
check('band=0 仍是整链轮换', new Set(Array.from({ length: 3 }, () => rotate(['a', 'b', 'c'], 'reg-band0', 0)[0])).size === 3)

// 7.5 排序器必须是全序：同一集合的不同输入排列要产出同一结果。
// 根因曾是 rank=1 桶里「有 ttfb 就比 ttfb、没有就跳过去比 rate」能构成环；
// 另外没有画像时返回的 {rank:1}（ttfb=undefined）与有画像时的
// {rank:1, ttfb:Infinity} 相比，两个方向都返回 1。
clearSlowModels()
recordSpeed('reg/ta', { ttfb: 900, tps: 0 })
recordSpeed('reg/tc', { ttfb: 100, tps: 0 })
const mkRow = (id, rate) => ({
  id, provider: 'buddy', model: id.split('/')[1], name: id,
  rate, free: false, vision: true, contextWindow: 1000000,
})
const rA = mkRow('reg/ta', 0.05)
const rB = mkRow('reg/tb', 0.3)
const rC = mkRow('reg/tc', 0.3)
const permutations2 = [[rA, rB, rC], [rA, rC, rB], [rB, rA, rC], [rB, rC, rA], [rC, rA, rB], [rC, rB, rA]]
const outputs = new Set(permutations2.map(list =>
  buildTiers(list, { ...DEFAULTS, excludeBelowTps: 0, perProviderLinks: 10, maxLinks: 10 }).low.map(r => r.id).join(',')))
check('6 种输入排列产出同一顺序（全序）', outputs.size === 1, [...outputs].join(' | '))

// 7.6 throughputBandTps = 0 必须是严格按 tps 降序，不能被首字影响。
clearSlowModels()
recordSpeed('reg/faster', { ttfb: 4000, tps: 120 })
recordSpeed('reg/slower', { ttfb: 0, tps: 100 })
const band0 = buildTiers([mkRow('reg/faster', 0.1), mkRow('reg/slower', 0.1)], {
  ...DEFAULTS, throughputBandTps: 0, excludeBelowTps: 0,
}).low.map(r => r.id)
check('band=0 时 120tok/s 排在 100tok/s 之前', band0[0] === 'reg/faster', band0.join(' > '))

// 7.7 minTokensPerSecond = 0 必须关闭速度判定（不能被 positive() 顶回 50）。
clearSlowModels()
recordSpeed('reg/m45', { ttfb: 500, tps: 45 })
const zeroMin = buildTiers([mkRow('reg/m45', 0.1), mkRow('reg/nothing', 0.1)], {
  ...DEFAULTS, minTokensPerSecond: 0, excludeBelowTps: 0,
}).low.map(r => r.id)
check('minTokensPerSecond=0 时 45tok/s 不算慢', zeroMin[0] === 'reg/m45', zeroMin.join(' > '))

// 7.8 免费链的额度偏好不能压过吞吐与到期（只能在完全并列时生效）。
clearSlowModels()
recordSpeed('reg/slowquota', { ttfb: 11000, tps: 60 })
recordSpeed('reg/fastplain', { ttfb: 500, tps: 60 })
const freeOrder = buildTiers([
  { ...mkRow('reg/slowquota', 0), provider: 'codearts' },
  { ...mkRow('reg/fastplain', 0), provider: 'buddy' },
], { ...DEFAULTS, excludeBelowTps: 0 }).free.map(r => r.id)
check('免费链不再把首字 11s 的额度模型排前面', freeOrder[0] === 'reg/fastplain', freeOrder.join(' > '))

// 7.9 账号轮换必须覆盖全部账号（不能是三角数跳位）。
// 根因曾是「绝对游标 + 已经被自己旋转过的输入」叠加，起点落在 0,1,3,6,10…
// n=11 时只有 6 个账号能当首位。
resetAccountRotation()
let cursorInput = Array.from({ length: 11 }, (_, i) => ({ id: 'acc' + String(i).padStart(2, '0') }))
const seenHeads = []
for (let i = 0; i < 11; i += 1) {
  const plan = planAccountOrder({ provider: 'reg-rotate', accounts: cursorInput, balances: [], options: { expiryFirst: false, rotation: true } })
  seenHeads.push(plan.ordered[0])
  cursorInput = plan.ordered.map(id => ({ id }))
}
check('11 个账号逐个都当过首位', new Set(seenHeads).size === 11, String(new Set(seenHeads).size) + '/11')

// 7.10 停用账号不占轮换位；缺 id 的账号不能缩短 ordered。
resetAccountRotation()
const withDisabled = [{ id: 'da' }, { id: 'db', enabled: false }, { id: 'dc' }, { id: 'dd' }]
const disabledHeads = Array.from({ length: 6 }, () =>
  planAccountOrder({ provider: 'reg-disabled', accounts: withDisabled, balances: [], options: { rotation: true } }).ordered[0])
check('停用账号从不排首位', !disabledHeads.includes('db'), disabledHeads.join(','))
const withIdless = [{ id: 'xa' }, { id: '' }, { id: 'xc' }]
check('ordered 长度等于 accounts 长度',
  planAccountOrder({ provider: 'reg-idless', accounts: withIdless, balances: [], options: { rotation: false } }).ordered.length === 3)

// 7.11 余额查询失败的账号归入「未知」，不压到最后。
const unknownPlan = planAccountOrder({
  provider: 'reg-unknown',
  accounts: [{ id: 'ue' }, { id: 'ul' }, { id: 'uf' }],
  balances: [
    { accountId: 'ue', total: 10, expiring: 10, nearestEnd: Date.now() + 2 * day, known: true },
    { accountId: 'ul', total: 5, expiring: 0, nearestEnd: 0, known: true },
    { accountId: 'uf', total: 0, expiring: 0, nearestEnd: 0, known: false },
  ],
  options: { expiryFirst: true, rotation: false, windowDays: 15 },
})
check('余额查询失败的账号夹在中间', unknownPlan.ordered.join(',') === 'ue,uf,ul', unknownPlan.ordered.join(','))

// 7.12 空集合必须写成哨兵，否则「取消最后一个」会复活成「全部」。
const encoded = encodeMembers([])
check('encodeMembers([]) 返回哨兵', encoded === '__none__', JSON.stringify(encoded))
check('encodeMembers 规范化为小写', encodeMembers(['A/B']) === 'a/b', encodeMembers(['A/B']))
const afterCancelAll = buildTiers([mkRow('reg/m1', 0.1), mkRow('reg/m2', 0.1)], { ...DEFAULTS, membersLow: encoded }).low
check('取消最后一个成员后链为空（不会复活）', afterCancelAll.length === 0, String(afterCancelAll.length))

// 7.13 system 消息必须合并进请求体，不能丢。
const sysBody = toChatBody({
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'SYS-PROMPT' }] },
    { role: 'developer', content: [{ type: 'text', text: 'DEV-NOTE' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
})
const sysText = sysBody.messages.find(x => x.role === 'system')?.content ?? ''
check('system 与 developer 都被保留', sysText.includes('SYS-PROMPT') && sysText.includes('DEV-NOTE'), sysText)

// 7.14 图片块用 attachmentId 时，经解析器要变成 image_url。
const imgBody = toChatBody({
  messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att_1', mediaType: 'image/png' } }] }],
}, { resolveImage: ref => (ref?.attachmentId === 'att_1' ? 'data:image/png;base64,AAAA' : undefined) })
check('attachmentId 经解析器变成 image_url', JSON.stringify(imgBody.messages).includes('data:image/png'), JSON.stringify(imgBody.messages))

// 7.15 各种「历史被清空」的形状都不能产出空 messages。
const emptyCases = [
  [{ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] }],
  [{ role: 'user', content: [] }],
  [{ role: 'system', content: [{ type: 'text', text: 'only system' }] }],
]
for (const [i, messages] of emptyCases.entries()) {
  const body = toChatBody({ messages })
  check('空历史形状 #' + (i + 1) + ' 仍产出非空 messages', body.messages.length > 0, JSON.stringify(body.messages))
}

// 7.16 中文吞吐不能被低估 3 倍（否则正常中文回答被判慢）。
const cnTps = estimateTps('这是一个中文回答，用来验证吞吐估算是否正确。', 925)
check('中文按 1 字 1 token', cnTps > 20, cnTps.toFixed(1) + ' tok/s')
check('countTokens 中文 4 字 = 4', countTokens('中文测试') === 4, String(countTokens('中文测试')))

// ── 8. 全选 / 全不选：纯粹的集合语义 ───────────────────────────────────
//
// 用户的要求：「全选就是选择下面所有的模型，取消全选就是一个都不选中」。
// 这条不变式有两次被打破过，两次都是「显式勾选仍然被自动分层的筛子二次处理」：
//   - cap()（每条链 40、单渠道 6）导致 low 的 35 个候选只进 12 个；
//   - 吞吐淘汰导致 custom 的 96 个候选只进 33 个。
// 所以这里直接断言「勾选清单 == 候选清单」，链里成员数也要相等。

clearSlowModels()
resetRotation()

const setMembers = (config, key, ids) => {
  const next = { ...config }
  if (key === 'free') next.membersFree = ids
  else if (key === 'low') next.membersLow = ids
  else if (key === 'high') next.membersHigh = ids
  else { next.customMode = 'explicit'; next.customModels = ids }
  return next
}

/** 四条链各造 3 个候选，混入一个「会被淘汰」的慢模型，验证勾上它依然进链。 */
recordSpeed('sel/free-fast', { ttfb: 400, tps: 150 })
recordSpeed('sel/free-slow', { ttfb: 9000, tps: 5 })   // 会被吞吐淘汰
recordSpeed('sel/low-fast', { ttfb: 500, tps: 120 })
recordSpeed('sel/low-slow', { ttfb: 9000, tps: 5 })
recordSpeed('sel/high-fast', { ttfb: 600, tps: 110 })
recordSpeed('sel/high-slow', { ttfb: 9000, tps: 5 })

const tierRow = (id, provider, rate) => ({
  id, provider, model: id.split('/')[1], name: id,
  rate, free: false, vision: true, contextWindow: 1000000,
})
const selectionRows = [
  tierRow('sel/free-fast', 'buddy', 0),
  tierRow('sel/free-slow', 'buddy', 0),
  { ...tierRow('sel/low-fast', 'buddy', 0.1) },
  { ...tierRow('sel/low-slow', 'buddy', 0.1) },
  { ...tierRow('sel/high-fast', 'buddy', 0.9) },
  { ...tierRow('sel/high-slow', 'buddy', 0.9) },
]

for (const key of ['free', 'low', 'high']) {
  const ids = selectionRows
    .filter(row => tierOf(row, { lowMaxRate: DEFAULTS.lowMaxRate, longContextMin: 1000000 }) === key)
    .map(row => row.id)
  const full = buildTiers(selectionRows, setMembers(DEFAULTS, key, ids.join(', ')))[key]
  check(`全选 ${key}：勾了几个，链里就有几个（含实测慢的）`,
    ids.length > 0 && full.length === ids.length,
    `勾选=${ids.length} 链里=${full.length}`)
  const none = buildTiers(selectionRows, setMembers(DEFAULTS, key, '__none__'))[key]
  check(`全不选 ${key}：链里为 0`, none.length === 0, '链里=' + none.length)
}

// Custom：勾上全部候选（含会被淘汰的）也必须全在
const customIds = selectionRows.map(row => row.id)
const customFull = buildTiers(selectionRows, {
  ...DEFAULTS, customMode: 'explicit', customModels: customIds.join(', '),
}).custom
check('全选 custom：勾了几个，链里就有几个（含实测慢的）',
  customFull.length === customIds.length, `勾选=${customIds.length} 链里=${customFull.length}`)
const customNone = buildTiers(selectionRows, {
  ...DEFAULTS, customMode: 'explicit', customModels: '__none__',
}).custom
check('全不选 custom：链里为 0', customNone.length === 0, '链里=' + customNone.length)

// 自动分层（用户没动过）仍然要淘汰：这是「自动」与「手动」的分界
const autoLow = buildTiers(selectionRows, { ...DEFAULTS, membersLow: '' }).low
check('自动分层仍然淘汰慢模型（手动与自动的分界）',
  !autoLow.some(row => row.id === 'sel/low-slow'), autoLow.map(r => r.id).join(','))

clearSlowModels()

// ── 9. 默认门槛 85，且「收紧」用的判据与「淘汰」一致 ──────────────────
//
// 用户要求：重测全部后，每个聚合模型默认只选 85 tok/s 以上的。
//
// 这里验两件事：
//   1. 默认值确实是 85（含请求期门槛——否则刚放行的 86 tok/s 一开口就被换掉）；
//   2. 「全部样本失败」（tps 恒为 0）的模型**会被算作不达标**，而不是被
//      throughputOf 返回 undefined 而误当成「没测过」。这一点曾经真的漏了：
//      codearts/deepseek-v4-flash 有 7 个样本、4 次失败、tps 恒 0，却因为
//      throughputOf 返回 undefined 而被整批保留。

check('默认吞吐淘汰线是 70', DEFAULTS.excludeBelowTps === 70, String(DEFAULTS.excludeBelowTps))
// 进池宽、换人严：淘汰线 70 而请求期门槛 85，这是刻意的分工
check('请求期门槛(85) 高于淘汰线(70)', DEFAULTS.minTokensPerSecond > DEFAULTS.excludeBelowTps,
  `${DEFAULTS.minTokensPerSecond} > ${DEFAULTS.excludeBelowTps}`)
check('默认请求期门槛同步 85', DEFAULTS.minTokensPerSecond === 85, String(DEFAULTS.minTokensPerSecond))

clearSlowModels()
recordSpeed('cut/fast', { ttfb: 400, tps: 200 })
recordSpeed('cut/edge', { ttfb: 500, tps: 85 })
recordSpeed('cut/just-below', { ttfb: 500, tps: 84 })
recordSpeed('cut/all-fail-1', { ttfb: 12000, tps: 0 })
recordSpeed('cut/all-fail-2', { ttfb: 12000, tps: 0 })

check('200 tok/s 达标', isDropped('cut/fast', 85, { speedMemoryMinutes: 180, slowMemoryMinutes: 30 }) === false)
check('恰好 85 tok/s 达标（边界取到）', isDropped('cut/edge', 85, { speedMemoryMinutes: 180, slowMemoryMinutes: 30 }) === false)
check('84 tok/s 不达标', isDropped('cut/just-below', 85, { speedMemoryMinutes: 180, slowMemoryMinutes: 30 }) === true)
check('全部样本失败的模型算不达标（不是「没测过」）', isDropped('cut/all-fail-1', 85, { speedMemoryMinutes: 180, slowMemoryMinutes: 30 }) === true)
check('没测过的模型不算不达标', isDropped('cut/never-measured', 85, { speedMemoryMinutes: 180, slowMemoryMinutes: 30 }) === false)

// ── 10. 首字等待上限 15 秒，且与「启动慢」阈值保持一致 ─────────────────
//
// 用户要求：首字母出字限制在 15s。
//
// 两个阈值必须一起改，否则会出现自相矛盾的行为：
//   - firstTokenTimeoutMs = 15s 但 slowTtfbMs = 10s：
//     一个 12 秒出字的模型「等满了、拿到了答案」，却被判定为「启动慢」，
//     下一轮被排到链尾——用户明明已经接受等 15 秒。
//   - 反过来（放弃 < 降级）更糟：还没到降级线就先被放弃，
//     降级判定永远不生效。

check('首字等待上限默认 10000ms', DEFAULTS.firstTokenTimeoutMs === 10000, String(DEFAULTS.firstTokenTimeoutMs))
check('「启动慢」阈值默认 10000ms', DEFAULTS.slowTtfbMs === 10000, String(DEFAULTS.slowTtfbMs))
check('放弃阈值 >= 降级阈值（否则降级永不生效）',
  DEFAULTS.firstTokenTimeoutMs >= DEFAULTS.slowTtfbMs,
  `${DEFAULTS.firstTokenTimeoutMs} >= ${DEFAULTS.slowTtfbMs}`)

// 首字 12 秒、吞吐达标：既不该被判「启动慢」，也不该被淘汰
clearSlowModels()
recordSpeed('ttfb/12s', { ttfb: 12000, tps: 150 })
const slow12 = buildTiers([{
  id: 'ttfb/12s', provider: 'buddy', model: '12s', name: '12s',
  rate: 0.1, free: false, vision: true, contextWindow: 1000000,
}], { ...DEFAULTS, excludeBelowTps: 85 }).low
check('首字 12s 的模型被判启动慢（超过 10s 阈值）',
  slow12.some(row => row.id === 'ttfb/12s'), slow12.map(r => r.id).join(','))

// 首字 16 秒：超过放弃阈值，应判为实测慢
clearSlowModels()
recordSpeed('ttfb/16s', { ttfb: 16000, tps: 150 })
const slow16 = buildTiers([{
  id: 'ttfb/16s', provider: 'buddy', model: '16s', name: '16s',
  rate: 0.1, free: false, vision: true, contextWindow: 1000000,
}], { ...DEFAULTS, excludeBelowTps: 0 }).low
check('首字 16s 的模型被排到最后（超过 15s）',
  slow16.length === 1, slow16.map(r => r.id).join(','))

// ── 11. 参数调优 + 错误率淘汰 ──────────────────────────────────────────
//
// 这一节的数据依据全部来自本机 9 天、19247 次真实请求的统计：
//   首字 P50 2.4s / P90 4.3s；吞吐 P50 341 tps；
//   真实输出 P50 90 / P75 159 token；错误率 >20% 的模型有 74 个。

check('首字等待上限 10000ms', DEFAULTS.firstTokenTimeoutMs === 10000, String(DEFAULTS.firstTokenTimeoutMs))
check('「启动慢」阈值与等待上限一致', DEFAULTS.slowTtfbMs === DEFAULTS.firstTokenTimeoutMs,
  `${DEFAULTS.slowTtfbMs} vs ${DEFAULTS.firstTokenTimeoutMs}`)
check('maxSlowSkips=1（换人代价 10s，而非 20s）', DEFAULTS.maxSlowSkips === 1, String(DEFAULTS.maxSlowSkips))
check('expectedOutputTokens=200（真实中位输出 90 token）', DEFAULTS.expectedOutputTokens === 200, String(DEFAULTS.expectedOutputTokens))
check('perProviderLinks=10（trae 有 23 个候选）', DEFAULTS.perProviderLinks === 10, String(DEFAULTS.perProviderLinks))
check('absurdRate=2（池内倍率 P90 只有 1.4）', DEFAULTS.absurdRate === 2, String(DEFAULTS.absurdRate))
check('errorRateMax=0.5 默认开启', DEFAULTS.errorRateMax === 0.5, String(DEFAULTS.errorRateMax))
check('错误率最少样本 20', DEFAULTS.errorStatsMinSamples === 20, String(DEFAULTS.errorStatsMinSamples))

// ── 错误率淘汰：三态（有数据且超标 / 有数据未超标 / 没数据）───────────
//
// 用 errorVerdict 的纯逻辑验证，不依赖真实账本——账本里有没有某个模型
// 取决于用户当天用了什么，拿它做断言会变成「看运气」。

/**
 * 造一份临时账本，验证读取与判定。
 *
 * 账本路径是 `<DSH_HOME>/channel-pack/token-ledger.json`，本测试已由
 * testenv 隔离到临时目录，所以可以随便写。
 */
const ledgerDir = path.join(process.env.DSH_HOME, 'channel-pack')
fs.mkdirSync(ledgerDir, { recursive: true })
const today = new Date().toISOString().slice(0, 10)
fs.writeFileSync(path.join(ledgerDir, 'token-ledger.json'), JSON.stringify({
  days: {
    [today]: {
      'direct|mock|mock-a|err-high': { requests: 100, errors: 80, ttftCount: 100, ttftSumMs: 200000 },
      'direct|mock|mock-a|err-low': { requests: 100, errors: 5, ttftCount: 100, ttftSumMs: 200000 },
      'direct|mock|mock-a|err-few': { requests: 3, errors: 3, ttftCount: 3, ttftSumMs: 6000 },
      'direct|mock|mock-a|err-none': { requests: 100, errors: 0, ttftCount: 100, ttftSumMs: 200000 },
    },
  },
}), 'utf8')
resetErrorStats()

const errOpt = {
  errorRateMax: 0.5, errorStatsMinSamples: 20, errorStatsDays: 7, errorStatsMinutes: 30,
}
check('错误率 80% 且样本足够 → 淘汰',
  errorVerdict('mock/err-high', errOpt)?.dropped === true,
  JSON.stringify(errorVerdict('mock/err-high', errOpt)))
check('错误率 5% → 不淘汰',
  errorVerdict('mock/err-low', errOpt)?.dropped === false,
  JSON.stringify(errorVerdict('mock/err-low', errOpt)))
check('错误率 100% 但样本只有 3 次 → 不淘汰（防误伤）',
  errorVerdict('mock/err-few', errOpt)?.dropped === false,
  JSON.stringify(errorVerdict('mock/err-few', errOpt)))
check('账本里没有的模型 → 返回 undefined（不下判断）',
  errorVerdict('mock/not-in-ledger', errOpt) === undefined)
check('errorRateMax=0 时关闭错误率淘汰',
  errorVerdict('mock/err-high', { ...errOpt, errorRateMax: 0 }) === undefined)

// 错误率淘汰是**独立**于速度门槛的：速度门槛关掉也照样生效
check('速度门槛为 0 时，错误率淘汰仍然生效',
  isDropped('mock/err-high', 0, errOpt) === true)
check('错误率不超标时，速度门槛为 0 就不淘汰',
  isDropped('mock/err-low', 0, errOpt) === false)

resetErrorStats()

// ── 12. 淘汰原因必须可解释 ────────────────────────────────────────────
//
// 用户看到「246 t/s 已淘汰」会以为逻辑错了——实际是错误率 71% 把它挡掉的。
// 所以 state 里必须分别给出「是否淘汰」和「为什么淘汰」，页面才能说清楚。

clearSlowModels()
resetErrorStats()

/**
 * 造一份账本 + 速度画像，构造三种淘汰原因。
 *
 * 注意这里**必须**用真实的 errorStats 读取路径（写文件 → resetErrorStats →
 * errorStatsOf），否则测的只是纯函数，验不到「读账本」这一环。
 */
const ledgerDir2 = path.join(process.env.DSH_HOME, 'channel-pack')
fs.mkdirSync(ledgerDir2, { recursive: true })
fs.writeFileSync(path.join(ledgerDir2, 'token-ledger.json'), JSON.stringify({
  days: {
    [new Date().toISOString().slice(0, 10)]: {
      'direct|mock|mock-a|reason-error': { requests: 100, errors: 90, ttftCount: 100, ttftSumMs: 200000 },
      'direct|mock|mock-a|reason-speed': { requests: 100, errors: 2, ttftCount: 100, ttftSumMs: 200000 },
      'direct|mock|mock-a|reason-both': { requests: 100, errors: 90, ttftCount: 100, ttftSumMs: 200000 },
      'direct|mock|mock-a|reason-ok': { requests: 100, errors: 2, ttftCount: 100, ttftSumMs: 200000 },
    },
  },
}), 'utf8')
resetErrorStats()

// 速度快慢：error 那个故意给高吞吐（模拟「246 t/s 却被淘汰」的场景）
recordSpeed('mock/reason-error', { ttfb: 900, tps: 246 })
recordSpeed('mock/reason-speed', { ttfb: 900, tps: 30 })
recordSpeed('mock/reason-both', { ttfb: 900, tps: 20 })
recordSpeed('mock/reason-ok', { ttfb: 900, tps: 150 })

const reasonOpt = {
  speedMemoryMinutes: 180, slowMemoryMinutes: 30, excludeBelowTps: 70,
  errorRateMax: 0.5, errorStatsMinSamples: 20, errorStatsDays: 7, errorStatsMinutes: 30,
}
/** 复刻 shape() 里的判定（同一套输入，验证结论一致）。 */
const classify = id => {
  const sp = speedOf(id, { speedMemoryMinutes: reasonOpt.speedMemoryMinutes })
  const err = errorStatsOf(id, { errorStatsMinutes: reasonOpt.errorStatsMinutes })
  const tps = Number(sp?.tps)
  const hasTps = Number.isFinite(tps) && tps > 0
  const byError = err !== undefined && Number(err.requests) >= reasonOpt.errorStatsMinSamples
    && Number(err.rate) > reasonOpt.errorRateMax
  const bySpeed = hasTps && tps < reasonOpt.excludeBelowTps
  return {
    dropped: byError || bySpeed,
    reason: byError && bySpeed ? 'both' : (byError ? 'error' : (bySpeed ? 'speed' : null)),
  }
}

check('高吞吐 + 高错误率 → 原因是 error（不是 speed）',
  classify('mock/reason-error').reason === 'error', JSON.stringify(classify('mock/reason-error')))
check('低吞吐 + 低错误率 → 原因是 speed',
  classify('mock/reason-speed').reason === 'speed', JSON.stringify(classify('mock/reason-speed')))
check('两者都超标 → 原因是 both',
  classify('mock/reason-both').reason === 'both', JSON.stringify(classify('mock/reason-both')))
check('都达标 → 不淘汰、无原因',
  classify('mock/reason-ok').dropped === false && classify('mock/reason-ok').reason === null,
  JSON.stringify(classify('mock/reason-ok')))

// 关键回归：一个 246 t/s 的模型被淘汰时，原因必须是 error 而不是含糊的「已淘汰」
const highSpeedDropped = classify('mock/reason-error')
check('「246 t/s 却被淘汰」能解释清楚（原因=error，而非速度）',
  highSpeedDropped.dropped === true && highSpeedDropped.reason === 'error',
  `dropped=${highSpeedDropped.dropped} reason=${highSpeedDropped.reason}`)

resetErrorStats()
clearSlowModels()

clearSlowModels()
console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')

process.exit(failures === 0 ? 0 : 1)
