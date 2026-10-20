// 速度门槛与慢模型降级的单元验证。
import {
  estimateTps, markSlow, markFast, isSlow, clearSlowModels, demoteSlow,
  buildTiers, DEFAULTS, resetRotation,
} from './index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!ok) failures += 1
}

// ── estimateTps ──
// 短耗时不再被拒绝：字符数足够时，短窗口也能给出有意义的量级。
check('短耗时也能算（不再一刀切）', estimateTps(100, 200) > 0,
  estimateTps(100, 200).toFixed(1) + ' tok/s')
check('零耗时返回 0', estimateTps(100, 0) === 0)
check('1000 字 / 4 秒 ≈ 83 tok/s', Math.abs(estimateTps(1000, 4000) - 83.3) < 2,
  estimateTps(1000, 4000).toFixed(1))
check('3000 字 / 2 秒 = 500 tok/s', Math.abs(estimateTps(3000, 2000) - 500) < 1,
  estimateTps(3000, 2000).toFixed(1))
check('零字符返回 0', estimateTps(0, 5000) === 0)

// ── 慢模型记忆 ──
clearSlowModels()
check('初始不慢', isSlow('m1') === false)
markSlow('m1')
check('标记后为慢', isSlow('m1') === true)
markFast('m1')
check('标快后清除', isSlow('m1') === false)

// 过期
clearSlowModels()
markSlow('m2', Date.now() - 3 * 3600 * 1000)
check('超过记忆窗口自动失效', isSlow('m2', { slowMemoryMinutes: 120 }) === false)
markSlow('m3', Date.now() - 10 * 60 * 1000)
check('窗口内仍然有效', isSlow('m3', { slowMemoryMinutes: 120 }) === true)

// ── demoteSlow ──
clearSlowModels()
const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
markSlow('b')
const demoted = demoteSlow(rows, { slowMemoryMinutes: 120 }).map(r => r.id)
check('慢模型沉到链尾', demoted.join('') === 'acdb', demoted.join(''))
check('不丢成员', demoted.length === 4)

// 多个慢模型保持相对顺序
clearSlowModels()
markSlow('a')
markSlow('c')
const d2 = demoteSlow(rows, { slowMemoryMinutes: 120 }).map(r => r.id)
check('多个慢模型按原相对顺序排尾', d2.join('') === 'bdac', d2.join(''))

// ── buildTiers 会降级 ──
clearSlowModels()
// 用真实渠道名：tierOf 对不认识的 provider 一律归 high。
const synthetic = [
  { id: 'buddy/fast', provider: 'buddy', model: 'fast', rate: 0.1, free: false, vision: true, contextWindow: 1000000 },
  { id: 'buddy/slow', provider: 'buddy', model: 'slow', rate: 0.05, free: false, vision: true, contextWindow: 1000000 },
]
let t = buildTiers(synthetic, { ...DEFAULTS, perProviderLinks: 5, maxLinks: 5 })
check('未标慢时按倍率排（便宜的在前）', t.low[0].id === 'buddy/slow', t.low.map(r => r.id).join(' '))

markSlow('buddy/slow')
t = buildTiers(synthetic, { ...DEFAULTS, perProviderLinks: 5, maxLinks: 5 })
check('标慢后沉到链尾', t.low[t.low.length - 1].id === 'buddy/slow', t.low.map(r => r.id).join(' '))
check('慢模型仍在链里（不删除）', t.low.length === 2)

clearSlowModels()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
