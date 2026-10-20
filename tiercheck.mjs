/**
 * 验证用户四项要求：
 *   1. 三条链都只含 1M 上下文模型；
 *   2. 不再区分「能看图」的独立链；
 *   3. 发图片时自动只用能看图的模型；
 *   4. 到期优先 + 同档轮换。
 *
 * 跑法：node tiercheck.mjs
 */
import {
  fetchRows, buildTiers, annotateExpiry, DEFAULTS, CHAIN_IDS,
  candidatesFor, rotate, resetRotation, hasImage, contextWindowOf, tierOf,
} from './index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

// ── 1. 真实分层：三条链都必须 1M ────────────────────────────────────────────
const fetched = await fetchRows(DEFAULTS)
if (!fetched.ok) { console.log('FETCH FAILED:', fetched.error); process.exit(1) }

const annotated = await annotateExpiry(fetched.rows, {
  windowDays: DEFAULTS.expiringWindowDays,
  rpc: async () => { throw new Error('skip in offline test') },
})
check('余额不可用时降级为未知（不误判为 0）',
  annotated.skipped.length > 0 && fetched.rows.every(r => r.expiringCredits === undefined))

const tiers = buildTiers(fetched.rows, DEFAULTS)
for (const key of ['free', 'low', 'high']) {
  const list = tiers[key]
  const minCtx = list.length === 0 ? 0 : Math.min(...list.map(r => r.contextWindow))
  check(`${key} 链非空`, list.length > 0, `${list.length} 个候选`)
  check(`${key} 链全部 ≥1M`, list.length > 0 && minCtx >= 1000000, `最小 ${minCtx}`)
}

// 门槛之外确实有被排除的模型（否则这个测试没有意义）
const allCtx = fetched.rows.map(r => r.contextWindow)
check('确实存在被 1M 门槛排除的模型',
  allCtx.some(c => c < 1000000), `${allCtx.filter(c => c < 1000000).length} 个 <1M`)

// ── 2. 三条链互不重叠 ──────────────────────────────────────────────────────
const ids = new Set()
let overlap = 0
for (const key of ['free', 'low', 'high']) {
  for (const row of tiers[key]) {
    if (ids.has(row.id)) overlap += 1
    ids.add(row.id)
  }
}
check('三条链没有重复模型', overlap === 0, `${overlap} 个重复`)

// ── 3. 图片筛选 ────────────────────────────────────────────────────────────
const textOnly = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
const withImage = [{ role: 'user', content: [
  { type: 'text', text: 'what is this' },
  { type: 'image', attachment: { url: 'data:image/png;base64,AAAA' } },
] }]

check('hasImage: 纯文本为 false', hasImage(textOnly) === false)
check('hasImage: 带图片为 true', hasImage(withImage) === true)

const chain = tiers.free
const noImageCandidates = candidatesFor(chain, textOnly)
const imageCandidates = candidatesFor(chain, withImage)
check('不带图片时不过滤', noImageCandidates.length === chain.length)
check('带图片时只剩能看图的',
  imageCandidates.every(r => r.vision === true) && imageCandidates.length <= chain.length,
  `${imageCandidates.length}/${chain.length}`)

// 链里若一个能看图的都没有，应返回空（让调用方明确报错，而不是发图给瞎子）
const noVisionChain = chain.filter(r => r.vision !== true)
check('链内无能看图模型时返回空', candidatesFor(noVisionChain, withImage).length === 0)

// ── 4. 轮换 ────────────────────────────────────────────────────────────────
resetRotation()
const sample = ['a', 'b', 'c', 'd']
const rotations = []
for (let i = 0; i < 5; i += 1) rotations.push(rotate(sample, 'test-chain').join(''))
check('轮换会改变起点', new Set(rotations).size === 4, rotations.join(' '))
check('轮换保留全部成员', rotations.every(r => r.length === 4 && new Set(r).size === 4))
check('轮换保持相对顺序（环形）', rotations.every(r => {
  const doubled = sample.join('') + sample.join('')
  return doubled.includes(r)
}), rotations.join(' '))

// ── 5. 到期优先排序 ────────────────────────────────────────────────────────
const synthetic = [
  { id: 'p/unknown', provider: 'p', model: 'unknown', rate: 0.1, free: false, vision: true, contextWindow: 1000000, expiringCredits: undefined },
  { id: 'p/lasting', provider: 'p', model: 'lasting', rate: 0.1, free: false, vision: true, contextWindow: 1000000, expiringCredits: 0 },
  { id: 'p/expiring', provider: 'p', model: 'expiring', rate: 0.5, free: false, vision: true, contextWindow: 1000000, expiringCredits: 100 },
  { id: 'p/small', provider: 'p', model: 'small', rate: 0.1, free: false, vision: true, contextWindow: 131072, expiringCredits: 0 },
]
const st = buildTiers(synthetic, { ...DEFAULTS, perProviderLinks: 10, maxLinks: 10 })
const order = st.high.map(r => r.id)
check('到期积分排在长期积分之前',
  order.indexOf('p/expiring') < order.indexOf('p/lasting'), order.join(' '))
check('未知余额排在「有到期」之后、「只有长期」之前',
  order.indexOf('p/expiring') < order.indexOf('p/unknown')
  && order.indexOf('p/unknown') < order.indexOf('p/lasting'), order.join(' '))
check('不足 1M 的模型被排除', !order.includes('p/small'), order.join(' '))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
