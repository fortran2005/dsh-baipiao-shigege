/**
 * 验证「吞吐优先 + 快速档轮换 + 吞吐淘汰 + 账号排序」这一批新规则。
 *
 * 跑法：node rankcheck.mjs
 *
 * 为什么单独一个文件而不塞进 speedcheck：那个文件验的是「速度门槛与慢模型
 * 降级」这一层（请求期），这里验的是**候选选择与排序**（分层期），两者的
 * 输入与不变量完全不同。混在一起会让失败信息难以定位到底哪一层坏了。
 */
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
    speedOf, encodeMembers, toChatBody, estimateTps, countTokens,
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

clearSlowModels()
console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')

process.exit(failures === 0 ? 0 : 1)
