/**
 * dsh-baipiao-shigege —— 白嫖渠道自动分层
 *
 * 独立的 llm provider，不与 dsh-our-free-model 共享任何状态、不修改它的文件。
 *
 * 它做四件事：
 *   1. 通过渠道包自己的本地 OpenAI 网关（默认 127.0.0.1:8326）读取全部白嫖
 *      渠道模型，连同倍率、上下文窗口与图片能力；
 *   2. 按倍率分成 免费 / 低积分 / 高积分，三条链都要求 1M 上下文；
 *   3. 每层做成一条 fallback 链，作为**一个模型**暴露给选择器；
 *   4. 定时重新拉取，倍率一变就重新分层——不需要重启，也不需要人工改配置。
 *
 * 为什么走本地网关而不是直接 import 渠道包：渠道包是 dsh-our-free-model 的
 * vendored 目录，插件升级会整体覆盖；而网关是它的公开接口（`/v1/models` +
 * `/v1/chat/completions`），地址与 Key 稳定，插件升级不影响本插件。
 *
 * 设置界面：导出的 `Config`（schemastery）就是设置页表单的唯一来源。内核的
 * settings-controller 读 `schema.toJSON()` 自动生成控件，用户改的值写回这一
 * 行的 config 并以 `apply(ctx, config)` 的第二个参数回来。因此**没有**任何
 * 自定义 UI 需要维护，也不依赖 dsh-our-free-model 的设置页。
 *
 * @module dsh-baipiao-shigege
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { decodeChatSse } from './sse.js'

export const name = 'baipiao-stone'

/** `llm` 是唯一硬依赖。 */
export const inject = ['llm']

export const ROUTE = 'baipiao'
const ROUTE_LABEL = 'baipiao-shiggege'

// ── 配置默认值 ──────────────────────────────────────────────────────────────

/**
 * 默认值集中在这里，`Config` schema 与运行时回退都从它取值，避免两处漂移。
 * 设置页展示的默认值就是这个对象。
 */
export const DEFAULTS = Object.freeze({
  /**
   * 渠道数据源：任何兼容 OpenAI `/v1/models` + `/v1/chat/completions` 的端点。
   *
   * 默认值指向渠道包（`dsh-our-free-model` 内置的那个）在 8326 上开的网关，
   * 因为那是最省事的现成来源。但**这不是依赖**：把它改成任何别的兼容网关，
   * 插件照样工作——这是本插件与 our-free-model 解耦的关键。
   */
  gatewayUrl: 'http://127.0.0.1:8326',
  /** 网关 Key；留空则读 ~/.dsh/openai-gateway/api-key（渠道包写下的那个）。 */
  gatewayKey: '',
  /** 重新分层间隔（分钟）；0 = 只在启动时拉一次。 */
  refreshMinutes: 30,
  /** 低积分倍率上界；超过归入高积分。 */
  lowMaxRate: 0.3,
  /** 1M 链的上下文门槛。 */
  longContextMin: 1000000,
  /** 每层最多几个链接。 */
  maxLinks: 40,
  /** 同一渠道在一层里最多几条，避免单渠道故障吃掉整层。 */
  perProviderLinks: 6,
  /** 倍率超过此值不参与（躲开 20x 这类坑）。 */
  absurdRate: 5,
  /** 是否优先消耗快过期的积分。 */
  preferExpiringCredits: true,
  /** 「快过期」的判定窗口（天）。 */
  expiringWindowDays: 15,
  /**
   * 首个正文字符的等待上限（毫秒）。
   *
   * 实测重思考模型会在正文前先想 9 秒以上，而换一个模型可能 2 秒就开始答。
   * 超过这个时间还没有正文就放弃当前候选、换下一个。0 = 不限制。
   */
  firstTokenTimeoutMs: 10000,
  /** 首字延迟超过这个毫秒数的模型标记为「启动慢」，下轮排到链尾。 */
  slowTtfbMs: 10000,
  /**
   * 单次请求最多因为「首字太慢」放弃几个候选。
   *
   * ## 为什么必须设上限
   *
   * 放弃一个候选要付出完整的超时时间。实测一次上游拥塞时，free 链上连续 8 个
   * 候选都在 3 秒内没出正文，于是 8 × 3 秒 = 24 秒才拿到答案——**比直接等
   * 一个 11.6 秒的慢模型还慢**。超时本来是为了更快，失控时反而成了放大器。
   *
   * 上限的作用是把这个代价钉死：最多放弃 N 个，之后就老老实实等当前候选
   * 出结果。默认 2 —— 足够跳过最差的一两个，又不会把时间浪费在连续重试上。
   */
  maxSlowSkips: 2,
  /**
   * 是否向渠道包查询积分余额。
   *
   * 关掉它，插件就**完全**不依赖渠道包的任何接口，只靠网关的模型清单工作——
   * 那时排序退化为「按倍率」，但三条链照常可用。给「我只想用本插件、不想让
   * 它碰别的插件」的场景留的开关。
   */
  expiryLookup: true,
  /**
   * 启动时是否让上游（渠道包）先刷新模型清单与倍率。
   *
   * 开着才能保证「每次打开都是最新模型」；关掉则用上游缓存的清单分层，
   * 更快但可能拿到旧数据。
   */
  primeUpstream: true,
  /**
   * 速度门槛（tokens/s）。
   *
   * 输出正文的速度低于它，就中止当前候选、换下一个，并把这个模型记成「慢」、
   * 排到链尾。0 表示关闭速度判定（只按失败降级）。
   *
   * 为什么门槛要可配：不同上游的基线差很多，且「够快」是主观的。100 是
   * 「明显卡顿」的保守起点。
   */
  minTokensPerSecond: 50,
  /**
   * 吞吐淘汰线（tokens/s）：实测低于它的模型**不进入任何链**。
   *
   * ## 与 `minTokensPerSecond` 的区别（两者必须分开）
   *
   *   - `minTokensPerSecond` 是**请求期**判定：这一次流出来的正文太慢，就中止
   *     当前候选、换下一个。它只影响「这一轮」。
   *   - `excludeBelowTps` 是**分层期**判定：模型被实测证明「就是慢」，那么它
   *     连候选都不该当——用户明确要求「低于 50 tok/s 的直接取消选择，不进组合
   *     模型」。
   *
   * 两条一起用才是完整语义：慢的模型既不该被排到前面，也不该占着候选名额在
   * 链尾兜底——兜底一次就要用户多等十几秒。
   *
   * 0 = 关闭淘汰（只排序、不删除）。**没有实测数据的模型不会被淘汰**：淘汰的
   * 前提是「测出来慢」，而不是「还没测」——否则启动瞬间所有模型都会被清空。
   */
  excludeBelowTps: 50,
  /**
   * 吞吐分档的档宽（tokens/s）。
   *
   * 排序不是严格的逐个 tps 降序，而是「先按吞吐分档、档内按价格」：
   * 60 与 80 tok/s 的用户体感差别远小于 0.05 与 5 倍率的价格差别，硬按 tps
   * 排会让贵的模型仅仅因为快 5% 就挤到前面。
   *
   * 0 = 不分档（严格按 tps 降序）。
   */
  throughputBandTps: 25,
  /**
   * 「快速档」大小：真正被轮换调用的只有吞吐最高的前 N 个。
   *
   * ## 为什么不是「整条链轮流」
   *
   * 整条链轮流会让一个排在很后面的模型偶尔当链首——用户为它付出一次慢的代价，
   * 却只换来「用量分散」。快速档把轮换限制在**已经证明最快的那几个**里：
   *
   *   - 调用永远落在快的模型上（用户要的速度）；
   *   - 同档内轮流当链首，用量不会全压在第一名上（用户要的分散 + 风控）；
   *   - 快速档全部失败时仍然按原顺序降级到档外，可用性不受影响。
   *
   * 1 = 永远只用最快的那一个（最激进）；0 或负数等同 1。取值大于候选数时按
   * 候选数截断。
   */
  fastBandSize: 3,
  /**
   * 每次启动软件后，是否自动跑一次「重测全部」。
   *
   * 用户明确要求「每次开启软件就自动运行一次重测全部」。探测按渠道分组、
   * 单账号串行、带 200–500ms 抖动，所以它不会像「同时打几十个请求」那样触发
   * 风控；而且它在后台跑，不影响任何一次对话的延迟。
   *
   * 但**刚测过就不重复测**：见 `startupProbeSkipMinutes`。
   */
  probeOnStartup: true,
  /**
   * 启动重测的跳过窗口（分钟）：上一轮探测在这么多分钟内完成过，就不再重测。
   *
   * 作用场景是「一天里反复开关软件」——每次开都跑一轮全量探测既没必要，也是
   * 最容易被上游看出规律的那类流量。0 = 每次都测。
   */
  startupProbeSkipMinutes: 10,
  /**
   * 账号排序：优先用「积分快到期」的账号。
   *
   * 渠道包自己按**用户拖拽的顺序**选号（数组第一个可用账号），它不知道谁的
   * 积分要过期。本插件把各账号的积分包到期时间读出来，把快过期的账号排到
   * 该渠道的最前面，再通过渠道包的 `account.reorder` 落地——于是「先用会作废
   * 的额度」变成了真实的选号顺序，而不只是一个展示字段。
   */
  accountExpiryFirst: true,
  /**
   * 账号轮换：除快到期账号外，其余账号轮流当第一顺位。
   *
   * 这是「不要集中用几个账号」的落点。与快速档轮换同理：只改变**起点**，不改变
   * 「失败就换下一个」的语义。轮换按渠道分别计游标，互不干扰。
   */
  accountRotation: true,
  /**
   * 账号重排的节流间隔（分钟）。
   *
   * `account.reorder` 会写一次渠道包的设置文件。每次刷新都写既无必要，也会让
   * 「顺序」变得不可观察。10 分钟足够跟上积分到期与用量分布的变化。
   */
  accountReorderMinutes: 10,
  /** 判定速度前至少观察多少毫秒；太短的样本会被网络抖动放大。 */
  speedSampleMs: 3000,
  /** 慢模型记忆保留多久（分钟）；过期后重新给它机会。 */
  slowMemoryMinutes: 30,
  /** 速度画像保留多久（分钟）；过期后让模型重新证明自己。 */
  speedMemoryMinutes: 180,
  /**
   * 点「立即重新分层」时，是否顺带补测还没有速度数据的模型。
   *
   * ## 为什么默认关闭
   *
   * 开着的话，每点一次「立即重新分层」就在后台跑一轮全量探测（近百个模型）。
   * 用户并不知道自己触发了什么，而对上游平台来说那是一串密集请求——这是
   * 账号风控里最容易被判异常的一类流量。
   *
   * 关掉不等于失去能力：设置页有「测速」和「重测全部」两个显式按钮，想测
   * 的时候点一下即可；不测的时候链按倍率与已有画像排序，功能完全正常。
   * 更关键的是，**探测是后台任务**，与用户对话的请求路径完全分离——它测不测
   * 都不影响任何一次回答的延迟。
   */
  autoProbeOnRefresh: false,
  /**
   * 排序时是否优先用实测快的模型。
   *
   * 关掉则回到「到期 + 倍率」的传统排序；开着就用实测首字延迟给候选重排，
   * 让链在使用中**自我优化**——用过的模型里快的自然浮到前面。
   */
  preferMeasuredSpeed: true,
  /**
   * 排序时是否按「整轮吞吐」而不是只看首字。
   *
   * 用户要的是「一次提问后总体产出快」，也就是首字延迟 + 生成阶段合计。
   * 只看首字会把「首字 1 秒、每秒 8 个 token」的模型排在「首字 3 秒、每秒
   * 120 个 token」前面，而后者在真实长回答里反而先写完。打开后排序用
   * `首字 + 预期输出量 / 吞吐` 的合计耗时，吞吐越高越靠前。
   */
  preferThroughput: true,
  /**
   * 估算吞吐时的预期输出 token 数。
   *
   * 越大越偏向高吞吐模型（长回答场景）；越小越偏向首字快的模型（短问答）。
   */
  expectedOutputTokens: 800,
  /**
   * Custom 链的选法。
   *
   *   - `auto`（默认）：候选池的全集，新上架的模型会自动进来；
   *   - `explicit`：**严格等于** `customModels` 里勾选的那些——取消一个就真的
   *     少一个，不会再被「池里没列出的自动补齐」补回来。
   *
   * 只要用户在 Custom 里动过任何一个复选框，就会切到 `explicit`。
   */
  customMode: 'auto',
  /**
   * Custom 链：用户自己选定的模型 id 列表。
   *
   * 完整 id（形如 `provider/model`）。在 `explicit` 模式下这就是链的全部成员，
   * 顺序即勾选顺序（设置页会把已选的排到最前）。模型改名或下架后自动移除。
   */
  customModels: '',
  /**
   * 三条价格链**勾选过的**成员（逗号分隔完整 id）。
   *
   * 留空 = 该链用自动分层的全部候选（等价于「全选」）。非空 = 用户明确勾了
   * 哪些——取消勾选就写进这里，所以「取消后模型仍可见、随时能再勾上」。
   */
  membersFree: '',
  membersLow: '',
  membersHigh: '',
  /** 是否打印分层日志。 */
  verbose: true,
})

/**
 * 允许被落盘并读回的设置键。
 *
 * 就是 `DEFAULTS` 的键集合——落盘只应该存「本插件声明过的字段」。读取时用它
 * 过滤，旧版本遗留的废弃键（`disabledChains` / `disabledModels` / `manualFree`
 * 等）就会被静默丢弃，不会污染运行中的配置。
 */
export const ALLOWED_SETTING_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * 设置页的表单定义。
 *
 * 每个字段的 `description` 就是设置页上显示的那行说明，所以这里写的是
 * **用户视角**的话，不是给开发者看的注释。`.default()` 让没配置过的用户
 * 看到一个可用的初始值，而不是空白输入框。
 *
 * 这个导出是可选的：内核没有 settings-controller 的组合里，它只被忽略，
 * 插件照样按 `DEFAULTS` 运行。
 */
export let Config

try {
  const schemastery = await import('@deepseek-ai/schemastery')
  const Schema = schemastery.default ?? schemastery
  Config = Schema.object({
    gatewayUrl: Schema.string()
      .default(DEFAULTS.gatewayUrl)
      .description('渠道网关地址（渠道包自带的本地 OpenAI 网关，不含 /v1）'),
    gatewayKey: Schema.string()
      .default(DEFAULTS.gatewayKey)
      .description('网关 Key；留空则自动读取 ~/.dsh/openai-gateway/api-key'),
    refreshMinutes: Schema.number()
      .default(DEFAULTS.refreshMinutes)
      .description('每隔多少分钟重新拉取倍率并重新分层；0 = 只在启动时拉一次'),
    lowMaxRate: Schema.number()
      .default(DEFAULTS.lowMaxRate)
      .description('「低积分」的倍率上界，超过它归入「高积分」'),
    longContextMin: Schema.number()
      .default(DEFAULTS.longContextMin)
      .description('三条链的上下文门槛；达不到的模型不进入任何一条链'),
    maxLinks: Schema.number()
      .default(DEFAULTS.maxLinks)
      .description('每条链最多保留多少个候选模型'),
    perProviderLinks: Schema.number()
      .default(DEFAULTS.perProviderLinks)
      .description('同一渠道在一条链里最多出现几次，避免单渠道故障吃掉整条链'),
    absurdRate: Schema.number()
      .default(DEFAULTS.absurdRate)
      .description('倍率超过此值直接排除（避开 20x 这类不划算的模型）'),
    preferExpiringCredits: Schema.boolean()
      .default(DEFAULTS.preferExpiringCredits)
      .description('优先消耗快过期的积分（需要下面「查询积分余额」开着）'),
    expiringWindowDays: Schema.number()
      .default(DEFAULTS.expiringWindowDays)
      .description('多少天内到期的积分算「快过期」，优先用掉'),
    firstTokenTimeoutMs: Schema.number()
      .default(DEFAULTS.firstTokenTimeoutMs)
      .description('首个字等超过这么多毫秒就换下一个模型；0 = 一直等'),
    slowTtfbMs: Schema.number()
      .default(DEFAULTS.slowTtfbMs)
      .description('首字慢于这个毫秒数的模型，下轮排到链尾'),
    maxSlowSkips: Schema.number()
      .default(DEFAULTS.maxSlowSkips)
      .description('单次请求最多因首字太慢放弃几个候选；放弃一个就要付出一个超时的代价，设为 0 = 不放弃'),
    expiryLookup: Schema.boolean()
      .default(DEFAULTS.expiryLookup)
      .description('向渠道包查询积分余额；关掉后本插件不依赖任何其它插件，排序退化为按倍率'),
    primeUpstream: Schema.boolean()
      .default(DEFAULTS.primeUpstream)
      .description('启动时先让渠道包刷新模型清单与倍率，确保分层用的是最新数据'),
    minTokensPerSecond: Schema.number()
      .default(DEFAULTS.minTokensPerSecond)
      .description('输出速度低于这个值（tokens/s）就换下一个模型，并把它排到链尾；0 = 不判定速度'),
    excludeBelowTps: Schema.number()
      .default(DEFAULTS.excludeBelowTps)
      .description('实测吞吐低于这个值（tokens/s）的模型不进任何链（等于「取消选择」）；没测过的不受影响，0 = 不淘汰'),
    fastBandSize: Schema.number()
      .default(DEFAULTS.fastBandSize)
      .description('只有吞吐最高的前 N 个模型参与轮流调用；档外模型仍可兜底，1 = 永远只用最快的'),
    throughputBandTps: Schema.number()
      .default(DEFAULTS.throughputBandTps)
      .description('吞吐分档的档宽（tokens/s）：跨档按吞吐排，同档内按到期→倍率排；0 = 严格按吞吐'),
    probeOnStartup: Schema.boolean()
      .default(DEFAULTS.probeOnStartup)
      .description('每次启动软件后自动跑一次「重测全部」（后台进行，不影响对话）'),
    startupProbeSkipMinutes: Schema.number()
      .default(DEFAULTS.startupProbeSkipMinutes)
      .description('上一轮测速在这么多分钟内完成过，启动时就不重复测；0 = 每次都测'),
    accountExpiryFirst: Schema.boolean()
      .default(DEFAULTS.accountExpiryFirst)
      .description('优先用积分快到期的账号（会重排渠道包里的选号顺序）'),
    accountRotation: Schema.boolean()
      .default(DEFAULTS.accountRotation)
      .description('其余账号轮流当第一顺位，避免用量集中在少数账号上'),
    accountReorderMinutes: Schema.number()
      .default(DEFAULTS.accountReorderMinutes)
      .description('账号顺序重排的节流间隔（分钟）；0 = 每轮分层都重排'),
    speedSampleMs: Schema.number()
      .default(DEFAULTS.speedSampleMs)
      .description('判定速度前至少观察多少毫秒（太短的样本会被网络抖动放大）'),
    slowMemoryMinutes: Schema.number()
      .default(DEFAULTS.slowMemoryMinutes)
      .description('慢模型记忆保留多久（分钟），过期后重新给它机会'),
    speedMemoryMinutes: Schema.number()
      .default(DEFAULTS.speedMemoryMinutes)
      .description('速度画像保留多久（分钟），过期后让模型重新证明自己'),
    preferMeasuredSpeed: Schema.boolean()
      .default(DEFAULTS.preferMeasuredSpeed)
      .description('用实测首字延迟重排候选，让快的模型浮到链首（使用中自我优化）'),
    preferThroughput: Schema.boolean()
      .default(DEFAULTS.preferThroughput)
      .description('按「首字 + 生成耗时」的合计速度排序（吞吐高的优先），而不是只看首字'),
    expectedOutputTokens: Schema.number()
      .default(DEFAULTS.expectedOutputTokens)
      .description('估算合计耗时时的预期输出量（token）；越大越偏向高吞吐模型'),
    customMode: Schema.union(['auto', 'explicit'])
      .default(DEFAULTS.customMode)
      .description('Custom 链：auto = 候选池全集自动跟随；explicit = 严格按勾选清单'),
    autoProbeOnRefresh: Schema.boolean()
      .default(DEFAULTS.autoProbeOnRefresh)
      .description('点「立即重新分层」时自动补测还没有速度数据的模型'),
    customModels: Schema.string()
      .default(DEFAULTS.customModels)
      .description('Custom 链的成员（完整 id，逗号分隔）；由设置页的复选框勾选'),
    membersFree: Schema.string()
      .default(DEFAULTS.membersFree)
      .description('免费链勾选的成员（完整 id，逗号分隔）；留空表示全选'),
    membersLow: Schema.string()
      .default(DEFAULTS.membersLow)
      .description('低积分链勾选的成员；留空表示全选'),
    membersHigh: Schema.string()
      .default(DEFAULTS.membersHigh)
      .description('高积分链勾选的成员；留空表示全选'),
    verbose: Schema.boolean()
      .default(DEFAULTS.verbose)
      .description('在运行日志里打印每次分层的结果'),
  })
} catch {
  // 没有 schemastery 的组合：不导出 Config，设置页就没有这一项，
  // 但插件仍按 DEFAULTS 正常工作。
  Config = undefined
}


// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 数据根目录。
 *
 * 解析顺序（就近优先）：
 *   1. DSH_HOME 环境变量（测试与多实例场景）
 *   2. 插件目录旁的 .runtime-data —— 让「插件放在哪，数据就在哪」。
 *      开发副本（E 盘工作目录）与安装副本（~/.dsh/local-plugins）各自
 *      带着自己的设置与速度画像，互不串扰；发布副本没有这个目录时
 *      自动落回第 3 条，行为与旧版一致。
 *   3. ~/.dsh —— 传统位置，兼容老用户已有的数据。
 */
const LOCAL_DATA = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '.runtime-data')
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    if (fs.existsSync(path.join(LOCAL_DATA, 'settings.json'))) return LOCAL_DATA
  } catch { /* 目录不可读时按无此路径处理 */ }
  return path.join(os.homedir(), '.dsh')
}

/**
 * 用会话密钥为某个 authority 签一个短期 cookie。
 *
 * Web 服务用它自己的密钥校验 cookie；那份密钥就存在凭据库里
 * （`client-connection/browser-session`）。宿主侧读同一个文件、用同一个
 * HMAC 构造，就能以「已认证的本地客户端」身份访问自己的 API——这不是绕过
 * 鉴权，而是用同一套凭据走同一条路。
 *
 * 只用于 loopback、只用于本机、有效期 10 分钟。
 */
function mintCookie(secret, authority) {
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 10 * 60 * 1000 }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  return `${name}=v1.${body}.${sig}`
}

/** 读凭据库里的会话密钥；读不到返回 undefined（功能降级，不报错）。 */
function readSessionSecret() {
  try {
    const raw = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(raw)
    if (match === null) return undefined
    const secret = Buffer.from(match[1], 'base64url')
    return secret.length === 32 ? secret : undefined
  } catch {
    return undefined
  }
}

/**
 * 设置持久化文件路径。
 *
 * 本插件导出的 `Config` schema 会由内核的 settings-controller 自动生成表单，
 * 但**我们自己的设置页**（`settings.section`）走的是 `/api/baipiao-stone/config`
 * 这条 HTTP 路由，改的值只落在内存里——内核不知道，也不会帮我们写回 cordis.yml。
 * 所以这里自己落一份盘，重启后合并回来，customModels 的选择才不会丢。
 *
 * 放在 `~/.dsh/dsh-baipiao-stone/` 下，与网关 Key 同级；不进 profile 目录，避免
 * 与内核的 cordis 配置混在一起。
 */
function settingsFile() {
  return path.join(dshHome(), 'dsh-baipiao-stone', 'settings.json')
}

/**
 * 速度观测数据的落盘文件。
 *
 * ## 为什么单独一个文件
 *
 * `settings.json` 存的是**用户配置**（他选了什么），这份存的是**实测观测**
 * （模型到底多快）。两者性质不同：配置丢了要用户重设，观测丢了只是重新测。
 * 分开存的好处是写入互不干扰——探测跑的时候每测完一个就要落盘，如果和配置
 * 共用一个文件，高频写入会让用户的配置改动更容易被覆盖。
 *
 * ## 为什么必须落盘
 *
 * 早期版本把 `speedProfiles` / `slowModels` 放在内存 Map 里，**重启就归零**。
 * 结果是「按实测速度排序」这个功能形同虚设：每次启动都是「谁都没数据」，
 * 链永远按倍率排，用户感受到的就是「聚合后还是慢」——而这正是用户的核心诉求。
 */
function memoryFile() {
  return path.join(dshHome(), 'dsh-baipiao-stone', 'speed-memory.json')
}

/** 读落盘的速度观测；没有或损坏时返回空。 */
function loadSpeedMemory() {
  try {
    const raw = fs.readFileSync(memoryFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { profiles: {}, slow: {} }
    return {
      profiles: parsed.profiles !== null && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      slow: parsed.slow !== null && typeof parsed.slow === 'object' ? parsed.slow : {},
    }
  } catch {
    return { profiles: {}, slow: {} }
  }
}

/** 原子写速度观测。 */
function persistSpeedMemory(data) {
  try {
    const dir = path.dirname(memoryFile())
    fs.mkdirSync(dir, { recursive: true })
    const tmp = memoryFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, memoryFile())
  } catch { /* 写盘失败不影响本次使用 */ }
}

/**
 * 读落盘的设置；没有或损坏时返回空对象。
 *
 * 同时**丢弃已废弃的键**：本插件的字段集在迭代中变过（`disabledChains` /
 * `disabledModels` / `manualFree` 等已被复选框方案取代）。旧文件里残留的键
 * 不仅占地方，更危险的是会让「配置里到底有哪些字段」变得不可推断——比如
 * 某处若误读一个废弃字段，行为会与当前设计不一致。
 *
 * 所以这里只接受 `ALLOWED_SETTING_KEYS` 里的键，其余一律忽略（下次写盘时
 * 自然就没了）。
 */
function loadPersistedSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (ALLOWED_SETTING_KEYS.has(key) && value !== undefined) clean[key] = value
    }
    return clean
  } catch {
    return {}
  }
}

/** 把当前配置写盘（原子写：先写临时文件再改名）。 */
function persistSettings(config) {
  try {
    const dir = path.dirname(settingsFile())
    fs.mkdirSync(dir, { recursive: true })
    const tmp = settingsFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
    fs.renameSync(tmp, settingsFile())
  } catch { /* 写盘失败不影响本次使用 */ }
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 网关 Key：配置优先，其次读渠道包写下的 0600 文件。
 *
 * 这是本机回环地址的准入凭证，不是任何厂商的 Key。读不到就明确失败，
 * 而不是拿空串换一个 401。
 */
export function resolveGatewayKey(configured) {
  const direct = text(configured)
  if (direct !== '') return { key: direct, source: 'config' }
  const file = path.join(dshHome(), 'openai-gateway', 'api-key')
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored !== '') return { key: stored, source: file }
  } catch { /* 首次安装时不存在是正常的 */ }
  return { key: '', source: '' }
}

async function getJson(url, key, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) return { ok: false, status: response.status, error: body.slice(0, 300) }
    try {
      return { ok: true, status: response.status, value: JSON.parse(body) }
    } catch {
      return { ok: false, status: response.status, error: 'non-JSON response' }
    }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

// ── 价格与能力 ──────────────────────────────────────────────────────────────

/**
 * 从展示名读倍率。网关把倍率拼在名字尾部：`Deepseek-V4.1-Flash · x0.11`，
 * 促销时是 `x0.12→x0.06`——折后价才扣费，所以取**最后一个**。
 * 读不到返回 undefined；未知价不能当免费。
 */
export function rateOf(name) {
  const matches = [...String(name ?? '').matchAll(/x(\d+(?:\.\d+)?)/gi)]
  if (matches.length === 0) return undefined
  const last = Number(matches[matches.length - 1][1])
  return Number.isFinite(last) ? last : undefined
}

/** 渠道自己标的 0 积分模型。 */
export function markedFree(name) {
  return String(name ?? '').includes('免费')
}

/** 按天给额度、不扣积分的渠道。 */
export const QUOTA_PROVIDERS = new Set(['codearts', 'minimax', 'zcode'])

/**
 * 参与分层的白嫖渠道。
 *
 * ⚠️ **刻意不含 `cline`**：它一家就有 490+ 个模型，且绝大多数上下文窗口由
 * 上游实时下发、静态表里查不到。混进来有两个实际问题：候选上限会被它一家
 * 吃光，而且我们无法判断哪些够 1M——宁可整家不要，也不让不确定的模型进链。
 *
 * 这个集合之外的 provider 一律不碰：`our-free-model` 自己的免费车道、
 * `deepseek-account`、EAC 都不属于白嫖渠道。
 */
export const KNOWN_PROVIDERS = new Set([
  'buddy', 'workbuddy', 'lobsterai', 'trae', 'qoder', 'qodercn',
  'loomy', 'raccoon', 'codearts', 'minimax', 'zcode', 'gemini',
])

/** 不是聊天模型的 id。 */
const NOT_CHAT = [/content-safety/i, /llama-guard/i, /-safety$/i]

/**
 * 分层判定。
 * @returns {'free'|'low'|'high'}
 */
export function tierOf(row, options) {
  if (row.free || row.rate === 0) return 'free'
  if (QUOTA_PROVIDERS.has(row.provider)) return 'free'
  if (!KNOWN_PROVIDERS.has(row.provider)) return 'high'
  if (row.rate === undefined) return 'high'
  return row.rate <= options.lowMaxRate ? 'low' : 'high'
}

/**
 * 确知 1M 上下文的裸模型 id。
 *
 * 网关的 `/v1/models` **不报上下文窗口**，模型名也不可靠地编码它
 * （`glm-5.1` 是 200K 而 `glm-5.2` 是 1M）。所以只把**确知**的放进来：
 * 宁可少放几个，也不能让 128K 的模型混进 1M 链、在长上下文时炸掉。
 *
 * 三条链现在都要求 1M，所以这张表就是「哪些模型有资格参与」的唯一门槛。
 * 新增渠道 / 新模型时要按该渠道适配器自己的档位表核对后再加——凭模型名
 * 猜「看起来像 1M」正是这里最容易犯的错。
 */
const CONTEXT_1M_BARE = new Set([
  // ── buddy / workbuddy（CONTEXT_WINDOWS2）──
  'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
  'hy4-preview', 'hy4-preview-x', 'hy4-preview-f',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2',
  'kimi-k3-1', 'kimi-k3',
  // ── codearts（CONTEXT_WINDOWS）──
  'deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.2',
  // ── qoder / qodercn（档位表全部含 1M 档）──
  'ultimate', 'performance', 'efficient', 'smodel', 'cmodel',
  'kmodel_latest', 'kmodel', 'gmodel', 'gfmodel', 'dmodel', 'dfmodel',
  'mmodel', 'q37fmodel', 'gm51model', 'qmodel_38max',
  // ── lobsterai ──
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-flash',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5',
  'kimi-k3', 'kimi-k2.8-preview', 'kimi-k2.7-code',
  'qwen3.8-max', 'qwen3.7-max', 'minimax-m3', 'minimax-m3.1-flash',
  // ── trae ──
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash',
  'deepseek-v4-pro-official', 'deepseek-v4-flash-official',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5',
  'kimi-k3', 'kimi-k2.8-preview', 'kimi-k2.7-code',
  'qwen3.8-max', 'qwen3.8-flash',
  'minimax-m3', 'mimo-v2.6-pro', 'mimo-v2.6-flash',
  'doubao-seed-2.1-pro', 'doubao-seed-2.0-code', 'doubao-seed-2.1-turbo',
  // ── 其它渠道 ──
  'gemini-3.5-flash', 'gemini-3.8-flash', 'gpt-5.3-codex',
])

export const CONTEXT_DEFAULT = 131072

/**
 * 清理 Custom 死 id 所需的「清单完整度」下限。
 *
 * 本轮行数低于历史峰值的这个比例，就认为上游没给全，跳过清理。0.7 是个宽松
 * 但有效的阈值：正常的渠道波动（一两个模型下架）不会跌到 70% 以下，而启动
 * 瞬间的残缺清单通常只有一半甚至更少。
 */
const CUSTOM_PRUNE_MIN_RATIO = 0.7

/**
 * 「用户明确全不选」的标记值。
 *
 * 空串在本插件里有「没动过 → 用自动分层的全部候选」的含义，无法表达「我
 * 就要一条空链」。所以全不选写这个哨兵值；`buildTiers` 见到它就返回空集合。
 */
const NONE_SELECTED = '__none__'

/**
 * 解析 Custom 链配置为模型 id 数组。
 *
 * 接受逗号 / 分号 / 空白 / 换行分隔的输入，每项去前后空白；空项与重复项丢弃。
 * 大小写不敏感：比较时统一转小写（网关 id 本身就是小写）。
 */
export function parseCustomModels(raw) {
  const ids = String(raw ?? '')
    .split(/[\s,;]+/)
    .map(item => item.trim().toLowerCase())
    .filter(item => item !== '')
  return [...new Set(ids)]
}



/** 裸模型 id：去掉 provider 前缀与 `:free` / `:batch` 后缀。 */
export function bareId(modelId) {
  const bare = String(modelId ?? '').split('/').pop() ?? ''
  return bare.replace(/:(?:free|batch)$/i, '').toLowerCase()
}

/** 一个模型的上下文窗口；只对确知的返回 1M。 */
export function contextWindowOf(modelId) {
  return CONTEXT_1M_BARE.has(bareId(modelId)) ? 1000000 : CONTEXT_DEFAULT
}

// ── 拉取与分层 ──────────────────────────────────────────────────────────────

/** 读网关清单，转成带倍率与能力的行；只保留白嫖渠道。 */
export async function fetchRows(config) {
  const { key, source } = resolveGatewayKey(config.gatewayKey)
  if (key === '') {
    return { ok: false, error: `没有网关 Key：填 gatewayKey，或先让渠道包生成 ${path.join(dshHome(), 'openai-gateway', 'api-key')}` }
  }
  const base = text(config.gatewayUrl) || DEFAULTS.gatewayUrl
  const listed = await getJson(`${base.replace(/\/+$/, '')}/v1/models`, key)
  if (!listed.ok) {
    return { ok: false, error: `网关 ${base} 不可用（HTTP ${listed.status || '—'}）：${listed.error}` }
  }
  const data = Array.isArray(listed.value?.data) ? listed.value.data : []
  const rows = []
  for (const entry of data) {
    const id = text(entry?.id)
    if (id === '') continue
    const slash = id.indexOf('/')
    if (slash <= 0) continue
    const provider = id.slice(0, slash)
    const model = id.slice(slash + 1)
    if (!KNOWN_PROVIDERS.has(provider)) continue
    if (NOT_CHAT.some(pattern => pattern.test(model))) continue
    const display = String(entry?.name ?? '')
    const input = Array.isArray(entry?.input) ? entry.input : ['text']
    rows.push({
      id,
      provider,
      model,
      name: display || id,
      rate: rateOf(display),
      free: markedFree(display),
      vision: input.includes('image'),
      contextWindow: contextWindowOf(model),
      /**
       * 「这个渠道有没有快过期的积分」。由 `annotateExpiry` 在分层前填：
       *   - 正数 = 快到期积分的总量（先用它）；
       *   - 0     = 查过，确实没有快到期的；
       *   - 缺省  = 查不到（与「没有」区分，见 `expiryRank`）。
       */
      expiringCredits: undefined,
    })
  }
  return { ok: true, rows, keySource: source, gateway: base }
}

/**
 * 把「快过期积分」标注到每个渠道的行上。
 *
 * ## 数据来源
 *
 * 渠道包自己已经实现了全部 13 个渠道的余额查询（`credits.balances`），
 * 它能给出每个账号的积分包与各自的扣费截止时间（`deductionEndTime`）。
 * 本插件不重复实现那套协议，只**读它的结果**——渠道协议一变，我们跟着变，
 * 而不必改两处。
 *
 * ## 判据
 *
 * 一个账号算「有快过期积分」，当且仅当存在一个积分包满足：
 * 剩余 > 0，且扣费截止时间落在 `expiringWindowDays` 天内。
 *
 * 渠道级的 `expiringCredits` 是这些包的剩余之和；只要有一个账号有，这个
 * 渠道就算「有快到期的」。
 *
 * ## 失败即缺省
 *
 * 任何一步失败（RPC 不可用、渠道不支持余额、网络错误）都不写 0，而是
 * **保持 undefined**：把「查不到」当成「没有快过期积分」会让这些渠道被
 * 永久排到最后，那正是用户抱怨的浪费。
 *
 * @param {Array<object>} rows - `fetchRows` 的输出（就地修改）
 * @param {object} deps - `{ rpc(provider), windowDays }`
 * @returns {Promise<{annotated:string[], skipped:string[], credits:object, accounts:object}>}
 *   `accounts` 是逐账号的积分明细（见下文 `accountsOf`），供账号排序使用。
 */
export async function annotateExpiry(rows, deps) {
  const windowDays = positive(deps?.windowDays, DEFAULTS.expiringWindowDays)
  const windowMs = windowDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  const providers = [...new Set((Array.isArray(rows) ? rows : []).map(row => row.provider))]
  const annotated = []
  const skipped = []
  /**
   * 各渠道的积分汇总。
   *
   * `total` 是**所有未过期**积分包的剩余之和（含长期包），`expiring` 只算
   * 窗口内到期的。两个数都按渠道记，设置页要显示「还剩多少分」和「其中多少
   * 快到期」——用户关心的是「我现在还能花多少」，不是一个笼统的布尔值。
   */
  const credits = {}
  /**
   * 逐**账号**的积分明细。
   *
   * 形状：`{ [provider]: [{ accountId, nickname, total, expiring, nearestEnd }] }`
   *
   * 渠道级汇总只能回答「这个渠道有没有快过期的积分」，而账号排序需要的是
   * 「**哪个账号**的积分最先作废」——渠道包按账号列表顺序选号，要把快过期的
   * 账号顶到前面，就必须知道每个账号自己的数字。`nearestEnd` 是「最近一个
   * 会作废的积分包的截止时刻」，0 表示没有带期限的包。
   */
  const accountsOf = {}

  for (const provider of providers) {
    let payload
    try {
      payload = await deps.rpc(provider)
    } catch {
      skipped.push(provider)
      continue
    }
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : null
    if (accounts === null) { skipped.push(provider); continue }

    let expiring = 0
    let total = 0
    let sawAnyPackage = false
    const perAccount = []
    for (const account of accounts) {
      const packages = Array.isArray(account?.balance?.packages) ? account.balance.packages : []
      let accountTotal = 0
      let accountExpiring = 0
      let nearestEnd = 0
      for (const pkg of packages) {
        const remaining = Number(pkg?.remaining)
        if (!Number.isFinite(remaining) || remaining <= 0) continue
        sawAnyPackage = true
        total += remaining
        accountTotal += remaining
        const end = Number(pkg?.deductionEndTime)
        if (!Number.isFinite(end) || end <= 0) continue
        // 已经过期的包不计入「还能花多少」。
        if (end <= now) { total -= remaining; accountTotal -= remaining; continue }
        if (nearestEnd === 0 || end < nearestEnd) nearestEnd = end
        if (end - now <= windowMs) { expiring += remaining; accountExpiring += remaining }
      }
      if (typeof account?.accountId === 'string' && account.accountId !== '') {
        perAccount.push({
          accountId: account.accountId,
          nickname: typeof account.nickname === 'string' ? account.nickname : '',
          total: accountTotal,
          expiring: accountExpiring,
          nearestEnd,
        })
      }
    }
    // 一个积分包都没读到，说明这个渠道的余额协议不适用（或账号未登录）；
    // 那就不下判断，保持 undefined。
    if (!sawAnyPackage) { skipped.push(provider); continue }

    credits[provider] = { total, expiring }
    accountsOf[provider] = perAccount
    for (const row of rows) {
      if (row.provider === provider) row.expiringCredits = expiring
    }
    annotated.push(provider)
  }

  return { annotated, skipped, credits, accounts: accountsOf }
}

/**
 * 账号轮换游标（按渠道分开）。
 *
 * 为什么是「每个渠道一个游标」而不是全局一个：每个渠道的账号数是独立的，
 * 全局游标会让账号少的渠道永远从同一个位置开始。
 */
const accountCursor = new Map()

/** 测试缝：账号轮换游标是进程状态。 */
export function resetAccountRotation() {
  accountCursor.clear()
}

/**
 * 计算某个渠道的**账号顺序**（只算，不落地）。
 *
 * ## 规则（用户新规则）
 *
 *   1. **积分快到期、且真的还有余额的账号排最前**——它们不用就作废；
 *   2. 其余账号**轮流当第一顺位**（`accountRotation`）——避免用量集中在
 *      最初的那一个账号上；
 *   3. 查不到余额的账号夹在中间，既不当第一顺位，也不被丢到最后。
 *
 * ## 为什么「轮流」是从一个轮换点上取环形序列
 *
 * 渠道包的选号语义是「列表第一个可用账号」。要让它「轮流」，只能改列表顺序：
 * 第 N 次重排把第 N 个账号转到队首。这不是随机打乱——顺序里仍然保留了
 * 「到期优先」，只是把**同档内的起点**转了一下。
 *
 * ## 未启用的账号
 *
 * 停用的账号仍然参与排序（渠道包自己会跳过它们），但**不占用轮换起点**：
 * 否则一个停用账号会白白消耗一个位置，让实际用量在剩下的账号里偏斜。
 *
 * @param {object} input
 * @param {Array<{id:string, enabled?:boolean}>} input.accounts - 渠道包给出的账号（按其现有顺序）
 * @param {Array<{accountId:string, total:number, expiring:number, nearestEnd:number}>|undefined} input.balances
 * @param {string} input.provider
 * @param {{expiryFirst?:boolean, rotation?:boolean, windowDays?:number}} [input.options]
 * @returns {{ordered:string[], expiring:string[], cursor:number}}
 */
export function planAccountOrder(input) {
  const provider = String(input?.provider ?? '')
  const accounts = Array.isArray(input?.accounts) ? input.accounts : []
  const balances = Array.isArray(input?.balances) ? input.balances : []
  const options = input?.options ?? {}
  const byId = new Map()
  for (const row of balances) {
    if (typeof row?.accountId === 'string') byId.set(row.accountId, row)
  }
  const now = Date.now()
  const windowMs = positive(options.windowDays, DEFAULTS.expiringWindowDays) * 24 * 60 * 60 * 1000

  /**
   * 把账号分成三组：
   *
   *   - `expiring`：窗口内会作废、且剩余 > 0 —— 先用掉；
   *   - `unknown`：查不到余额 —— 中间；
   *   - `lasting`：只有长期积分（或余额为 0 但没到期）—— 最后。
   *
   * 余额为 0 的账号不放进 `expiring`：它没有可浪费的额度，而且很可能已经被
   * 上游限流；排前面只会让请求先失败一次。但它**也不被移除**——降级时仍可以
   * 落回去（渠道包自己会按限流标记过滤）。
   */
  const expiring = []
  const unknown = []
  const lasting = []
  for (const account of accounts) {
    const id = String(account?.id ?? '')
    if (id === '') continue
    const balance = byId.get(id)
    if (options.expiryFirst === false || balance === undefined) { unknown.push(id); continue }
    const end = Number(balance.nearestEnd)
    const hasEnding = Number.isFinite(end) && end > now && end - now <= windowMs
    if (hasEnding && Number(balance.expiring) > 0) expiring.push(id)
    else lasting.push(id)
  }
  /**
   * 到期组内部：**越早作废的越靠前**。
   *
   * 这是「先用快到期的」这条规则真正的落点——两个账号都在窗口内，先烧掉
   * 下周就作废的那个，而不是下下周的那个。
   */
  const endOf = id => {
    const balance = byId.get(id)
    const end = Number(balance?.nearestEnd)
    return Number.isFinite(end) && end > 0 ? end : Number.POSITIVE_INFINITY
  }
  expiring.sort((a, b) => endOf(a) - endOf(b))

  /**
   * 除到期组之外的那些账号：合并成一个序列后整体旋转。
   *
   * 为什么合并而不是两组各自旋转：渠道包只关心「谁是第一个」，分组内部各转
   * 各的会让「未知」那一组永远压在「长期」之前——而它们其实同样该被轮换到。
   * 合成一个序列再转，起点落在谁身上谁就先上；到期的那些仍然固定在最前面。
   */
  const rest = [...unknown, ...lasting]
  const rotationOn = options.rotation !== false
  let start = 0
  if (rest.length > 1 && rotationOn) {
    start = (accountCursor.get(provider) ?? 0) % rest.length
    accountCursor.set(provider, (start + 1) % rest.length)
  } else if (rest.length > 0) {
    accountCursor.set(provider, 0)
  }
  const rotated = rest.length === 0 ? rest : [...rest.slice(start), ...rest.slice(0, start)]

  return {
    /** 该渠道的完整账号顺序（渠道包会按这个顺序选号）。 */
    ordered: [...expiring, ...rotated],
    /** 快到期、需要先用掉的账号（排在 `ordered` 最前面）。 */
    expiring,
    /** 本轮轮换起点落在 `rest` 的第几位；0 表示没有轮换。 */
    cursor: start,
  }
}


/**
 * 分组成三条链。
 *
 * ## 三条链的共同门槛：1M 上下文
 *
 * 用户的要求是「免费 / 低积分 / 高积分都要求 1M，没达到的不放进去」。所以
 * 分层的第一道筛子是 `contextWindow >= longContextMin`，而不是先按价格分完
 * 再过滤——否则会出现「低积分层里混着 128K」的漏网。
 *
 * ## 不区分「能看图」
 *
 * 图片是**请求级**属性：同一条链里既有能看图的也有不能的。哪一轮带图片，
 * 由 `createChainStream` 在运行时把候选缩到 `vision === true` 的那些（见
 * `candidatesFor`），而不是靠单独开一条「1M+看图」链。这样选择器只有三项，
 * 用户不必为「这次要不要发图」换模型。
 *
 * ## 排序的唯一主键：实测吞吐（从大到小）
 *
 * 用户的要求是「4 个分类里面的模型按照吞吐量从大到小排序，调用时优先调用
 * 速度快的模型」。所以每条链的**首选排序键就是吞吐 tps 的降序**，不是倍率、
 * 不是首字、也不是到期。
 *
 * 这里有一个必须讲清的分层关系：**吞吐决定「谁先上」，到期/倍率决定「内部
 * 谁先上」**。完全按吞吐排会让 0.05 倍率与 5 倍率的模型混在一起，而用户既要
 * 快也要省——所以链被切成若干「吞吐档」（同一个 25 tok/s 的桶），档内仍然按
 * 到期 → 倍率排。跨档时吞吐优先，档内时省钱优先，两个诉求都不丢。
 *
 * 没有实测数据的模型不能当作「慢」（那会让新上架/刚重置的模型永久垫底），
 * 也不能当作「快」（那会让没验证过的模型抢在前面）。它们单独一档，排在
 * 「实测够快」之后、「实测偏慢」之前。
 *
 * ## 吞吐淘汰（`excludeBelowTps`）
 *
 * 实测吞吐低于门槛的模型**直接不进链**。这是用户明确要求的「低于 50 tok/s
 * 的模型直接取消选择，不进入组合模型」。
 *
 * 判据必须是「测出来慢」，而不是「没测」：只淘汰**确知**慢的。同时 `slowModels`
 * 里被请求期判慢的模型也算证据（它出现过并且很慢）。
 *
 * ## 不浪费积分：到期优先，其次轮换
 *
 * 每个候选带一个 `expiryRank`：
 *
 *   - `0`：已知有**快到期**的积分（`expiringCredits > 0`）——先用掉，否则作废；
 *   - `1`：余额未知（查不到）——不当作「没有」，排在已知到期之后；
 *   - `2`：只有长期积分。
 *
 * 链的执行器还会在**快速档内**轮换起点，避免一直打同一个模型（用户明确要求
 * 「最好不要集中用一个模型」）。
 *
 * @param {Array<object>} rows - `fetchRows` 的输出，每行可带 `expiringCredits`
 * @param {object} config
 */
export function buildTiers(rows, config) {
  const options = {
    lowMaxRate: positive(config.lowMaxRate, DEFAULTS.lowMaxRate),
    longContextMin: positive(config.longContextMin, DEFAULTS.longContextMin),
  }
  const maxLinks = Math.trunc(positive(config.maxLinks, DEFAULTS.maxLinks))
  const perProvider = Math.trunc(positive(config.perProviderLinks, DEFAULTS.perProviderLinks))
  const absurd = positive(config.absurdRate, DEFAULTS.absurdRate)

  const affordable = row => row.rate === undefined || row.rate <= absurd

  /**
   * 到期优先级：数字越小越先用。
   *
   * `expiringCredits` 由宿主侧的余额查询填进来；`undefined` 表示「这个渠道
   * 查不到余额」，与「确实没有快到期积分」必须区分开——前者排在中间，既
   * 不抢占真正要作废的额度，也不被永远压在最后。
   */
  const expiryRank = row => {
    if (typeof row.expiringCredits === 'number' && row.expiringCredits > 0) return 0
    if (row.expiringCredits === undefined) return 1
    return 2
  }

  /** 先按到期优先级，再按倍率；倍率相同按 id 稳定排序。 */
  const byExpiryThenRate = (a, b) => {
    const rank = expiryRank(a) - expiryRank(b)
    if (rank !== 0) return rank
    const rate = (a.rate ?? 99) - (b.rate ?? 99)
    if (rate !== 0) return rate
    return String(a.id).localeCompare(String(b.id))
  }

  /**
   * 吞吐为主键的排序器。
   *
   * ## 为什么主键换成吞吐（用户新规则）
   *
   * 用户的原话是「4 个分类里面的模型按照吞吐量从大到小排序，调用的时候就优先
   * 调用速度快的模型」。所以排序的第一关键字是**实测吞吐 tps 降序**。
   *
   * ## 分档：跨档看吞吐，档内看省钱
   *
   * 纯 tps 降序会把 0.05 倍率和 5 倍率混着排。链被切成 25 tok/s 一档：
   *
   *   - **跨档**：吞吐高的档整档排在前面——用户要的「优先用快的」；
   *   - **档内**：到期优先 → 倍率，保持原来「不浪费积分」的语义。
   *
   * 档宽固定而不是按百分位：百分位会让「全是 60 tok/s」的一批模型也硬分出
   * 三六九等，而它们其实一样快，此时该由价格决定先谁。
   *
   * ## 什么算「快」
   *
   *   - 有 tps 数据且达标 → 进对应的吞吐档（0 档最快）；
   *   - 没数据 / tps = 0（只思考未作答，测不出吞吐）→ 单独一档，排在有数据的
   *     之后、「实测偏慢」之前。没测过既不能当快，也不能当慢；
   *   - 实测慢（首字超 `slowTtfbMs` 或吞吐低于 `minTokensPerSecond`）→ 最后。
   *
   * 淘汰发生在更前面（`excludeBelowTps`），慢到被淘汰的模型**根本不会走到这里**。
   */
  const makeThroughputFirst = options => {
    const cache = new Map()
    const slowTtfb = positive(options.slowTtfbMs, DEFAULTS.slowTtfbMs)
    const minTps = positive(options.minTokensPerSecond, DEFAULTS.minTokensPerSecond)
    const expected = positive(options.expectedOutputTokens, DEFAULTS.expectedOutputTokens)
    const useTotal = options.preferThroughput !== false
    /**
     * 一档 25 tok/s：大约「差一倍体感」的粒度。0 = 不分档（严格按 tps 降序）。
     *
     * 注意这里**不能**用 `positive()` 兜底：`positive(0, 25)` 会得到 25，
     * 于是「0 = 不分档」这个约定永远不生效——用户把档宽填 0 却还是被分档，
     * 属于典型的「配置项看着生效、其实没生效」。
     */
    const bandRaw = Number(options.throughputBandTps)
    const bandWidth = Number.isFinite(bandRaw) && bandRaw > 0 ? bandRaw : 0
    /**
     * 分类结果：
     *
     *   `rank` 0 = 有吞吐数据（`band` 越小越快）；1 = 没有可比数据；2 = 实测慢。
     */
    const classOf = row => {
      if (cache.has(row.id)) return cache.get(row.id)
      const value = options.preferMeasuredSpeed === false
        ? { rank: 1 }
        : (() => {
          const s = speedOf(row.id, { speedMemoryMinutes: options.speedMemoryMinutes })
          if (s === undefined) return { rank: 1 }
          const tps = Number(s.tps)
          const hasTps = Number.isFinite(tps) && tps > 0
          /**
           * 「实测慢」的判据与请求期一致：首字太慢，或吞吐低于请求期门槛。
           * 注意**不能**把「没有 tps」当慢——只思考未作答的模型会因此被误杀。
           */
          const slow = (slowTtfb > 0 && Number.isFinite(s.ttfb) && s.ttfb > slowTtfb)
            || (hasTps && minTps > 0 && tps < minTps)
          if (!hasTps) {
            /**
             * 没有吞吐数据（或 tps=0）。首字快的那批仍值得排在后面之前：
             * 它们至少证明了「能很快开始作答」。
             */
            return slow ? { rank: 2, ttfb: s.ttfb } : { rank: 1, ttfb: s.ttfb }
          }
          /**
           * 合计耗时只作为**同档内**的细分：吞吐已由 band 表达，这里用
           * `首字 + 预期输出/吞吐` 处理「同档但一个首字 0.5s、一个 4s」。
           */
          const gen = useTotal ? expected / tps * 1000 : 0
          return {
            rank: slow ? 2 : 0,
            /**
             * 分档越高越慢，所以要**降序**比较。`bandWidth = 0` 时给 0，
             * 于是「跨档」这一步恒不触发，退化成严格按 tps 排。
             */
            band: bandWidth > 0 ? Math.floor(tps / bandWidth) : 0,
            tps,
            total: (Number.isFinite(s.ttfb) ? s.ttfb : 0) + gen,
          }
        })()
      cache.set(row.id, value)
      return value
    }
    return (a, b) => {
      const ca = classOf(a)
      const cb = classOf(b)
      if (ca.rank !== cb.rank) return ca.rank - cb.rank
      /**
       * 跨档：吞吐高的档（`band` 小）整档在前。
       *
       * **必须降序**：`Math.floor(tps / width)` 是「越大越快、档号越小」，
       * 写成升序会把最慢的模型排到第一条——这是分档排序唯一容易写反的地方。
       */
      if (ca.rank === 0 && ca.band !== cb.band) return cb.band - ca.band
      /**
       * ## 为什么这里**不能**留容差
       *
       * 早期写的是 `if (Math.abs(diff) > 1) return diff`——想让毫秒级的抖动
       * 不影响排序。但那会让比较器**不满足传递性**：A 比 B 快 0.5ms（判相等，
       * 落到下一个键）、B 比 C 快 0.5ms（同样判相等），而 A 比 C 快 1.5ms
       * （这次返回了差值）。于是「A<B、B<C，但 A>C」——排序结果取决于
       * V8 内部取了哪几对，链的顺序会莫名其妙地乱掉。
       *
       * 正确做法：**所有键都严格比较，最后一定回落到 id**，保证比较器是一个
       * 全序。抖动交给中位数与时间窗口去吸收，不靠比较器放水。
       */
      if (ca.rank === 0 && Number.isFinite(ca.total) && Number.isFinite(cb.total)) {
        const diff = ca.total - cb.total
        if (diff !== 0) return diff
      }
      // 没有吞吐数据：首字快的在前（同样只是同档内细分）。
      if (ca.rank !== 2 && Number.isFinite(ca.ttfb) && Number.isFinite(cb.ttfb)) {
        const diff = ca.ttfb - cb.ttfb
        if (diff !== 0) return diff
      }
      return byExpiryThenRate(a, b)
    }
  }

  /**
   * 是否该把这个模型**淘汰出所有链**。
   *
   * 判据只有一条：**实测**证明它慢。
   *
   *   - 速度画像里的吞吐低于 `excludeBelowTps`；
   *   - 或者它已经被请求期判成「慢模型」（`slowModels`，且仍在记忆窗口内）。
   *
   * 绝不因为「没有数据」淘汰：启动瞬间所有模型都还没测过，按「没数据就淘汰」
   * 会得到一条空链。这也意味着第一次启动时淘汰不生效——测完一轮才生效，
   * 而那正是用户要的「重测全部之后按结果挑」。
   */
  const makeDropped = options => {
    const cut = Number(options.excludeBelowTps)
    const cache = new Map()
    return row => {
      if (!Number.isFinite(cut) || cut <= 0) return false
      if (cache.has(row.id)) return cache.get(row.id)
      const s = speedOf(row.id, { speedMemoryMinutes: options.speedMemoryMinutes })
      const tps = Number(s?.tps)
      let drop = false
      if (Number.isFinite(tps) && tps > 0 && tps < cut) drop = true
      else if (tps === 0 && isSlow(row.id, { slowMemoryMinutes: options.slowMemoryMinutes })) {
        // tps = 0 且被标慢：只思考不回答、或请求期直接超时——两种都不该进链。
        drop = true
      }
      cache.set(row.id, drop)
      return drop
    }
  }

  /**
   * 第一道筛子：1M 上下文 + 倍率不离谱。
   *
   * 这是**候选池**——所有够格的模型都进 Custom 链（自动分级的结果就是「把
   * 13 个平台所有可用模型都放进 Custom」），三条价格链再从池里按勾选取子集。
   */
  const longEnough = rows.filter(row =>
    row.contextWindow >= options.longContextMin && affordable(row))

  /**
   * Custom 链的成员。
   *
   * 两种模式，语义必须分清，否则「取消一个模型」会失效：
   *
   *   - `auto`：候选池的**全集**，新上架的模型自动进来，成员顺序**由实测速度
   *     决定**（用户要的是吞吐，不是手排顺序）；
   *   - `explicit`：**严格等于** `customModels` 里勾选的清单，顺序即勾选顺序。
   *     取消一个就真的少一个——这是「取消了也没用」那个 bug 的修法。
   *
   * 旧版实现是「清单在前、其余自动补齐」，于是取消任何一项都会被补回来，
   * 用户永远无法把某个模型移出 Custom。现在不再补齐。
   *
   * `__none__` 是「显式全不选」的兼容写法：等价于 explicit + 空清单。
   */
  const customRaw = String(config.customModels ?? '').trim().toLowerCase()
  const customNone = customRaw === NONE_SELECTED
  const customOrder = customNone ? [] : parseCustomModels(config.customModels)
  const customExplicit = customNone || config.customMode === 'explicit'
  const custom = customExplicit
    // explicit：只保留清单里**仍存在**的模型，顺序即勾选顺序。
    ? customOrder
      .map(id => longEnough.find(row => String(row.id ?? '').toLowerCase() === id))
      .filter(row => row !== undefined)
    // auto：清单里的排前面（尊重用户手排的次序），其余自动补齐。
    : [
      ...customOrder.map(id => longEnough.find(row => String(row.id ?? '').toLowerCase() === id)).filter(Boolean),
      ...longEnough.filter(row => !customOrder.includes(String(row.id ?? '').toLowerCase())),
    ]

  const byLower = row => String(row.id ?? '').toLowerCase()

  /**
   * 三条价格链的成员：取「勾选的集合」。
   *
   * `membersXxx` 留空 = 用户还没动过 → 用自动分层（`tierOf`）给一个合理的
   * 初始集合，而不是空链。一旦用户勾选过，就以勾选为准。
   */
  const pickChecked = ids => ids
    .map(id => longEnough.find(row => byLower(row) === id))
    .filter(row => row !== undefined)
  const autoOf = tier => longEnough.filter(row => tierOf(row, options) === tier)

  const manualOf = key => {
    const raw = String(config[`members${key[0].toUpperCase()}${key.slice(1)}`] ?? '').trim()
    // 空串 = 没动过 → 交给自动分层；哨兵 = 全不选 → 空链；其余 = 勾选集合。
    return raw === '' ? null : (raw.toLowerCase() === NONE_SELECTED ? [] : parseCustomModels(raw))
  }
  const freeManual = manualOf('free')
  const lowManual = manualOf('low')
  const highManual = manualOf('high')
  const free = freeManual === null ? autoOf('free') : pickChecked(freeManual)
  const low = lowManual === null ? autoOf('low') : pickChecked(lowManual)
  const high = highManual === null ? autoOf('high') : pickChecked(highManual)

  /**
   * 免费层内部：真 0 积分优先，每日额度渠道排后。
   *
   * 每日额度当天不用就清零，但它每天都会刷新；真 0 积分不消耗任何额度。
   * 两者都算「免费」，把不会过期的放在前面更稳。
   */
  /**
   * 排序器：**吞吐降序**（用户新规则）。
   *
   * `cap` 之前排序，让「该进链的模型」的**顺序**就是它们进链的顺序——
   * 吞吐高的先被选中，也排在最前。这与慢模型降级（`cap` 之后）配合：
   * 先按吞吐排出理想顺序，再把已知慢的挪到末尾。
   */
  const bySpeed = makeThroughputFirst({
    speedMemoryMinutes: config.speedMemoryMinutes,
    preferMeasuredSpeed: config.preferMeasuredSpeed,
    preferThroughput: config.preferThroughput,
    expectedOutputTokens: config.expectedOutputTokens,
    slowTtfbMs: config.slowTtfbMs,
    minTokensPerSecond: config.minTokensPerSecond,
    throughputBandTps: config.throughputBandTps,
  })
  const dropped = makeDropped({
    speedMemoryMinutes: config.speedMemoryMinutes,
    slowMemoryMinutes: config.slowMemoryMinutes,
    excludeBelowTps: config.excludeBelowTps,
  })
  /**
   * 淘汰 + 排序，一步到位。
   *
   * 淘汰放在**最前面**（`cap` 之前），这样被淘汰的模型不会占掉 `maxLinks` /
   * `perProviderLinks` 的名额——否则「淘汰 5 个慢的」反而会把名额浪费在它们
   * 身上，链里剩下的成员数不变但可用性更差。
   */
  const pickUsable = list => (Array.isArray(list) ? list : []).filter(row => !dropped(row)).sort(bySpeed)

  /**
   * 免费层内部：真 0 积分优先，每日额度渠道排后。
   *
   * ## 这条偏好只在**同档内**生效
   *
   * 每日额度当天不用就清零，但它每天都会刷新；真 0 积分不消耗任何额度。
   * 所以在「吞吐差不多」时，把不会过期的放前面更划算。
   *
   * 但它**绝不能**压过吞吐：早先的实现是把免费链整个切成「非额度渠道 +
   * 额度渠道」两段，于是 `zcode/GLM-5.3`（103 tok/s）会排在
   * `codearts/deepseek-v4.1-flash`（86 tok/s）之后——虽然前者更快。用户的
   * 新规则是「吞吐从大到小」，额度偏好只能在档内做次要键。
   */
  const quotaRank = row => (QUOTA_PROVIDERS.has(row.provider) ? 1 : 0)
  /**
   * 免费链的排序器：吞吐为主键（与其它链完全一致），额度渠道作为**同档内**
   * 的次要键——比倍率更靠后，因为免费层里「省额度」不如「不浪费会作废的」。
   */
  const bySpeedWithQuota = (a, b) => {
    const rank = quotaRank(a) - quotaRank(b)
    const primary = bySpeed(a, b)
    /**
     * 只有两者落在**同一个吞吐档**时才让额度偏好插队。
     *
     * `bySpeed` 的内部状态拿不到，所以用 tps 的档号自己算一遍：同档 = 同
     * 「快慢级别」，此时让额度偏好生效不会推翻吞吐语义。
     */
    const bandOf = r => {
      const tps = throughputOf(r.id, config.speedMemoryMinutes)
      const width = Number(config.throughputBandTps)
      if (tps === undefined) return -1
      return Number.isFinite(width) && width > 0 ? Math.floor(tps / width) : tps
    }
    const ba = bandOf(a)
    const bb = bandOf(b)
    if (ba === bb && rank !== 0) return rank
    return primary
  }
  const freeOrdered = pickUsable(free).sort(bySpeedWithQuota)

  const cap = list => {
    const seen = new Map()
    const out = []
    for (const row of list) {
      const used = seen.get(row.provider) ?? 0
      if (used >= perProvider) continue
      seen.set(row.provider, used + 1)
      out.push(row)
      if (out.length >= maxLinks) break
    }
    return out
  }

  /**
   * 慢模型沉到链尾。
   *
   * 放在 `cap` **之后**：先按 throughput/到期/倍率挑出该进链的模型，再把其中
   * 实测偏慢的挪到末尾。
   *
   * ## 为什么「有达标吞吐」的模型不做降级
   *
   * `slowModels` 有两种来源：**请求期**判慢（某一次流得很慢/超时）与**探测期**
   * 判慢。前者是单次事件的证据，后者是专门的测速结果——两者冲突时当然信后者。
   *
   * 实测踩到的反例：`qodercn/dfmodel` 实测 **160 tok/s**（全池最快），但因为
   * 历史上某次请求头字慢被记了 `isSlow`，于是排序完又被打回链尾，链首变成了
   * 77 tok/s 的模型。用户要的是「吞吐从大到小」，这正好反了。
   *
   * 所以：**有达标吞吐就不降级**，并顺手清掉那条过期的慢记录。
   */
  const demote = list => {
    const minTps = positive(config.minTokensPerSecond, DEFAULTS.minTokensPerSecond)
    const out = []
    for (const row of Array.isArray(list) ? list : []) {
      const tps = throughputOf(row.id, config.speedMemoryMinutes)
      if (tps !== undefined && minTps > 0 && tps >= minTps && isSlow(row.id, { slowMemoryMinutes: config.slowMemoryMinutes })) {
        // 实测达标而记录说它慢：以实测为准，清掉过期记录。
        markFast(row.id)
      }
      out.push(row)
    }
    return demoteSlow(out, { slowMemoryMinutes: config.slowMemoryMinutes })
  }

  /**
   * 是否对某条链应用 `cap()`。
   *
   * `cap()` 是「帮你挑一批合理的候选」的启发式：单渠道最多 N 个、总数最多
   * M 个。它只应作用于**自动分层**——用户没动过这条链时，我们替他决定。
   *
   * 用户一旦显式勾选，就不能再截断：勾了什么就该跑什么。否则会出现
   * 「界面上勾了、链里没有」——因为界面列表（`eligible`）不经过 cap，
   * 而实际成员要经过，两者不一致时，用户点全选看起来就毫无反应。
   */
  const capFor = manual => (manual === null ? cap : list => list)

  const freeCap = capFor(freeManual)
  const lowCap = capFor(lowManual)
  const highCap = capFor(highManual)

  return {
    free: demote(freeCap(freeOrdered)),
    low: demote(lowCap(pickUsable(low))),
    high: demote(highCap(pickUsable(high))),
    /**
     * Custom 不 `cap`（用户在设置页勾了多少就该跑多少），但**同样按吞吐降序**
     * 排——用户的新规则是「4 个分类都按吞吐量从大到小排序」，Custom 不例外。
     *
     * 淘汰对 Custom **同样生效**：用户的原话是「低于 50 tok/s 的直接取消选择，
     * 不进入组合模型」——手选的清单里也不该留着测出来只有 8 tok/s 的模型。
     * 被淘汰的模型仍留在设置页的候选列表里（只是不进链），随时能取消阈值找回。
     */
    custom: demote(pickUsable(custom)),
  }
}

/**
 * 三层 → 三个虚拟模型 id。
 *
 * 前缀 `shigege-` 是显示名的一部分，所以 id 也用它：选择器与本地网关
 * 都按 id 认模型，两边写成一样，用户复制 id 去配置客户端时不会对不上。
 */
export const CHAIN_IDS = Object.freeze({
  free: 'shigege-free',
  low: 'shigege-low',
  high: 'shigege-high',
  custom: 'shigege-custom',
})

/**
 * 选择器里显示的名字。
 *
 * 用英文是因为模型选择器里其它条目也是英文（`deepseek-chat` 等），混排中文
 * 会让这一组看起来不像模型名。四个名字刻意保持「points」后缀一致，扫一眼
 * 就能按价格梯度读出来。
 */
export const CHAIN_LABELS = Object.freeze({
  free: 'shigege-Free points',
  low: 'shigege-Low points',
  high: 'shigege-Premium points',
  custom: 'shigege-Custom',
})

/**
 * 每条链的主题色，供设置页与选择器说明使用。
 *
 * 选色逻辑：free 绿、low 琥珀、premium 紫红，与「越往下越贵」的直觉一致；
 * custom 用紫罗兰，表示「自己选的」。值是 CSS 颜色，直接写进内联样式。
 *
 * 注意：**模型选择器本身不接受颜色**——它的模型描述对象只认 name /
 * description / inputModalities / context。所以颜色只能在设置页里生效；
 * 选择器里靠「统一后缀 + 递增的价位词」区分。
 */
export const CHAIN_COLORS = Object.freeze({
  free: '#3ECFA0',
  low: '#F2A65A',
  high: '#E36AA6',
  custom: '#9B6BFF',
})

// ── 请求级筛选与轮换 ────────────────────────────────────────────────────────

/**
 * 本轮消息里是否带图片。
 *
 * 只看 `type: 'image'` 块：harness 的图片一律是这个形状，文本块不会伪装成
 * 它。工具结果里回传的图片由渠道适配器自己处理，不在这个判断范围内。
 */
export function hasImage(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'image') return true
    }
  }
  return false
}

/**
 * 把一条链的候选按本轮请求筛一遍。
 *
 * 带图片时只留 `vision === true` 的候选；不带图片时原样返回（不做任何
 * 「优先纯文本」的偏好——那会让用量集中到少数模型上）。
 *
 * 带图片但链里一个能看图的都没有时，返回空数组：让调用方拿到明确的
 * 「这条链没有能看图的模型」，而不是把图片发给一个看不见它的模型。
 */
export function candidatesFor(list, messages) {
  const rows = Array.isArray(list) ? list : []
  if (!hasImage(messages)) return rows
  return rows.filter(row => row.vision === true)
}

/**
 * 轮换起点：每次调用把游标前移一位，返回一个「从该位开始、绕回开头」的
 * 旋转副本。
 *
 * 为什么不打乱顺序：链的语义是「前面的更该用」（吞吐优先、其次到期/倍率）。
 * 轮换只改变**从哪一位开始**，不改变优先级次序，所以第 N 次调用会从第 N
 * 个候选起试，失败仍按原顺序往后走——既分散了用量，又保留了「快和省」的顺序。
 *
 * ## 只在前 `band` 个里轮换（用户新规则的关键）
 *
 * 用户要的是「能用到速度快的，也能在模型之间把大部分账号都用到，不至于集中
 * 使用几个模型」。两条诉求同时满足的唯一方式是**把轮换限制在一个小窗口里**：
 *
 *   - 窗口 = 吞吐最高的前 `band` 个（`fastBandSize`）；
 *   - 窗口内轮流当链首 → 用量分散，但每个都是快的；
 *   - 窗口外原样接在后面 → 窗口内全失败时仍能降级，可用性不降。
 *
 * 整条链轮流是**错的**：那会让一个排在第 30 位、实测 8 tok/s 的模型偶尔当
 * 链首，用户为「分散用量」付一次十几秒的代价。窗口轮换把「分散」限制在
 * 「都够快」的集合里。
 *
 * 游标按 `model`（链 id）分开记，四条链互不干扰。纯内存状态：重启后从头
 * 开始，代价只是用量分布重新洗牌，不影响正确性。
 */
const rotationCursor = new Map()

export function rotate(list, key, band = 0) {
  const rows = Array.isArray(list) ? list : []
  if (rows.length <= 1) return rows
  const id = String(key ?? '')
  /**
   * 轮换窗口大小。
   *
   * `band <= 0` 或 `band >= length` 时退回「整条链轮换」——这是老行为，
   * 保留它是为了让单测与「关了快速档」的场景语义不变。
   */
  const size = Number.isFinite(band) && band > 1 ? Math.min(Math.trunc(band), rows.length) : rows.length
  const start = (rotationCursor.get(id) ?? 0) % size
  rotationCursor.set(id, (start + 1) % size)
  if (size === rows.length) return [...rows.slice(start), ...rows.slice(0, start)]
  // 窗口内旋转，窗口外原样接在后面。
  const inside = rows.slice(0, size)
  const outside = rows.slice(size)
  return [...inside.slice(start), ...inside.slice(0, start), ...outside]
}

/** 测试缝：轮换游标是进程状态。 */
export function resetRotation() {
  rotationCursor.clear()
}

// ── 速度门槛与慢模型记忆 ────────────────────────────────────────────────────

/**
 * 每个模型的**实测速度画像**。
 *
 * ## 为什么要记「速度」而不只是「慢」
 *
 * 实测数据说明了问题：同一条链上，`lobsterai/deepseek-flash` 首字 1.2 秒，
 * 而链首那个 0 积分模型 `workbuddy/hy4-preview-f` 要 **20.8 秒**才失败。
 * 按倍率排序时前者排在后面——因为「免费」被当成「应该优先用」，但用户真正
 * 感知的是**等了多久**。
 *
 * 所以这里不只记「慢/不慢」，而是记住**两个关键测度**：
 *
 *   - `ttfb`：首字延迟（用户等待的体感）；
 *   - `tps`：正文字符吞吐（干活的体感）。
 *
 * 排序时把有数据的排前面（实测快的优先），没数据的按原顺序排——这样链会
 * **自我优化**：用过的模型积累画像，快的自然浮到链首。
 *
 * ## 为什么记「最好成绩」而不是平均
 *
 * 上游速度波动大（同一模型实测 500ms 到 6.7s 都有）。用平均会让一次抖动
 * 拖累一个本来很快的模型。用**中位数**抗抖动，同时保留最近一次的值作参考。
 *
 * ## 过期
 *
 * 上游会换路由、换机器。记录带时间戳，超过 `speedMemoryMinutes` 自动失效，
 * 让模型重新证明自己——否则一次早高峰的慢会永久压着它。
 */
/**
 * 速度观测的持久化句柄。
 *
 * 用**防抖**写入而不是每次样本都写盘：探测一轮要测近百个模型，每个都写一次
 * 就是近百次小文件写入——既慢又费磁盘。攒 1.5 秒写一次，代价是一个进程崩溃
 * 可能丢最后一两个样本，完全可以接受（观测数据本来就是可重测的）。
 */
let memoryFlushTimer = null

/** 保证「退出前落盘」只注册一次（反复 apply 时不重复挂监听器）。 */
let processExitHookInstalled = false

/** 把两张表合并落盘。 */
function flushSpeedMemory() {
  memoryFlushTimer = null
  persistSpeedMemory({
    profiles: Object.fromEntries(speedProfiles),
    slow: Object.fromEntries(slowModels),
  })
}

/**
 * 安排一次落盘（防抖 1.5 秒）。
 *
 * `unref` 是因为它不该拖住进程退出——最后一批数据丢了也只是少几个样本。
 */
function scheduleMemoryFlush() {
  if (memoryFlushTimer !== null) return
  memoryFlushTimer = setTimeout(flushSpeedMemory, 1500)
  memoryFlushTimer.unref?.()
}

/** 立刻落盘（用于停止探测、进程退出前这类需要确定性落盘的时刻）。 */
export function flushSpeedMemoryNow() {
  if (memoryFlushTimer !== null) { clearTimeout(memoryFlushTimer); memoryFlushTimer = null }
  flushSpeedMemory()
}

/**
 * 从落盘恢复观测数据。
 *
 * 在 `apply` 里调用一次。恢复时要**丢掉已过期的样本**——否则一份很久以前的
 * 文件会让「过期即重测」的设计失效（模型明明已经换路由了，却还在用旧数据
 * 排序）。过期判据与 `speedOf` / `isSlow` 各自使用的窗口无关，这里用一个
 * 足够宽的固定上限（24 小时）做粗筛：比任何窗口都长，所以不会误删仍有效的，
 * 又能清掉明显陈旧的数据。
 */
const MEMORY_RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function restoreSpeedMemory() {
  const data = loadSpeedMemory()
  const now = Date.now()
  for (const [id, entry] of Object.entries(data.profiles)) {
    if (entry === null || typeof entry !== 'object') continue
    const at = Number(entry.at)
    if (!Number.isFinite(at) || now - at > MEMORY_RESTORE_MAX_AGE_MS) continue
    /**
     * 恢复时也要夹掉不可能的吞吐。
     *
     * `recordSpeed` 已经夹过一次，但落盘文件可能来自**加这道闸之前**的版本
     * （实测有一份 55666 tok/s 的样本就这么存下来了）。只写不读地加闸，等于
     * 老数据永远污染排序——所以读回来的路径也要过同一道闸。
     */
    const samples = (Array.isArray(entry.samples) ? entry.samples.slice(-8) : [])
      .map(sample => {
        const tps = Number(sample?.tps)
        return Number.isFinite(tps) && tps > MAX_PLAUSIBLE_TPS
          ? { ...sample, tps: MAX_PLAUSIBLE_TPS }
          : sample
      })
    if (samples.length === 0) continue
    speedProfiles.set(id, { samples, at })
  }
  for (const [id, entry] of Object.entries(data.slow)) {
    if (entry === null || typeof entry !== 'object') continue
    const at = Number(entry.at)
    if (!Number.isFinite(at) || now - at > MEMORY_RESTORE_MAX_AGE_MS) continue
    slowModels.set(id, { strikes: Number(entry.strikes) || 1, at })
  }
}

const speedProfiles = new Map()

/**
 * 「这个模型被实测判为慢」的计数。
 *
 * 与 `speedProfiles` 分开：速度画像记的是**度量和样本**（用于排序），这张表
 * 记的是**判定结果**（用于降级到链尾 + 设置页展示）。两者用途不同，所以要
 * 分开存——一个模型可能有多次速度样本但从未被判定为慢（因为每次都达标）。
 */
const slowModels = new Map()

/**
 * 吞吐的物理上限（tokens/s）。
 *
 * ## 为什么必须夹一刀
 *
 * 探测用「字符数 / 耗时」估算吞吐，样本很短时这个比值会失控。实测数据里有
 * 一条 `codearts/glm-5.3-flash` 记到了 **55666 tok/s**：那是「26 个字符在
 * 不到 1 毫秒内到达」的结果——上游把整段回答一次性推了过来，首字与末字之间
 * 几乎没有间隔。
 *
 * 这个数字一旦进入排序会带来两个真实后果：
 *
 *   1. 它所在的分档 2200+ 会顶掉所有正常模型，链首永远是它；
 *   2. 「快速档前 3 个」被这类虚高样本占满，真正的 100 tok/s 模型反而进不去。
 *
 * 2000 tok/s 远高于任何真实模型（人类阅读速度约 8，正常 LLM 输出 50–300），
 * 又足够高到不误伤「真的很快」的样本。
 */
export const MAX_PLAUSIBLE_TPS = 2000

/**
 * 记录一次实测速度。
 *
 * @param {string} modelId
 * @param {{ttfb?:number, tps?:number}} sample - 首字延迟（ms）与吞吐（tok/s）
 */
export function recordSpeed(modelId, sample) {
  const id = String(modelId ?? '')
  if (id === '') return
  /**
   * 夹掉不可能的吞吐值。
   *
   * 不丢弃整个样本（首字延迟仍然有效），只把 `tps` 裁到物理上限——这样
   * 「快得不真实」的样本既不会污染排序，也不会让首字数据跟着丢。
   */
  const raw = Number(sample?.tps)
  const tps = Number.isFinite(raw) && raw > MAX_PLAUSIBLE_TPS ? MAX_PLAUSIBLE_TPS : sample?.tps
  const previous = speedProfiles.get(id) ?? { samples: [], at: 0 }
  const next = { samples: [...previous.samples, { ...sample, tps }].slice(-8), at: Date.now() }
  speedProfiles.set(id, next)
  scheduleMemoryFlush()
}

/** 某个模型的速度画像摘要（考虑过期）；没数据返回 undefined。 */
export function speedOf(modelId, options = {}) {
  const entry = speedProfiles.get(String(modelId ?? ''))
  if (entry === undefined) return undefined
  const ttl = positive(options.speedMemoryMinutes, DEFAULTS.speedMemoryMinutes) * 60_000
  if (Date.now() - entry.at > ttl) {
    speedProfiles.delete(String(modelId))
    scheduleMemoryFlush()
    return undefined
  }
  // 取中位数：抗单次抖动。
  const med = values => {
    const nums = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
    if (nums.length === 0) return undefined
    return nums[Math.floor(nums.length / 2)]
  }
  return {
    ttfb: med(entry.samples.map(s => s.ttfb)),
    tps: med(entry.samples.map(s => s.tps)),
    samples: entry.samples.length,
    at: entry.at,
  }
}

/** 记录一次「这个模型慢」（与速度画像并存，供设置页展示）。 */
export function markSlow(modelId, at = Date.now()) {
  const previous = slowModels.get(modelId)
  const strikes = (previous?.strikes ?? 0) + 1
  slowModels.set(modelId, { strikes, at })
  scheduleMemoryFlush()
  return strikes
}

/** 记录一次「这个模型够快」；够快就清掉历史，不再压着它。 */
export function markFast(modelId) {
  slowModels.delete(modelId)
  scheduleMemoryFlush()
}

/** 这个模型当前是否被标记为慢（考虑过期）。 */
export function isSlow(modelId, options = {}) {
  const entry = slowModels.get(modelId)
  if (entry === undefined) return false
  const ttl = positive(options.slowMemoryMinutes, DEFAULTS.slowMemoryMinutes) * 60_000
  if (Date.now() - entry.at > ttl) {
    slowModels.delete(modelId)
    return false
  }
  return true
}

/** 测试缝 / 设置页「清除记忆」。 */
export function clearSlowModels() {
  slowModels.clear()
  speedProfiles.clear()
  // 立刻落盘：用户点「清除记忆」就是要把它们永久清掉。
  flushSpeedMemoryNow()
}

/** 只读快照，供设置页展示。 */
export function slowSnapshot() {
  return [...slowModels.entries()].map(([id, entry]) => ({ id, ...entry }))
}

/** 速度画像快照，供设置页展示「哪些模型实测快/慢」。 */
export function speedSnapshot(options = {}) {
  return [...speedProfiles.keys()]
    .map(id => ({ id, ...(speedOf(id, options) ?? {}) }))
    .filter(row => row.samples !== undefined)
    .sort((a, b) => (a.ttfb ?? 1e9) - (b.ttfb ?? 1e9))
}

/**
 * 排序：慢模型排到最后，其余保持原顺序。
 *
 * 这是「用户要的是干活速度」这一条在分层上的落点——慢模型不是被删掉，
 * 而是被推到链尾：前面都失败时它仍然能兜底，但正常情况轮不到它。
 */
export function demoteSlow(list, options = {}) {
  const rows = Array.isArray(list) ? list : []
  const fast = []
  const slow = []
  for (const row of rows) (isSlow(row.id, options) ? slow : fast).push(row)
  return [...fast, ...slow]
}

/** 某个模型当前的有效吞吐（tokens/s）；没有数据返回 undefined。 */
export function throughputOf(modelId, speedMemoryMinutes) {
  const s = speedOf(modelId, { speedMemoryMinutes })
  const tps = Number(s?.tps)
  return Number.isFinite(tps) && tps > 0 ? tps : undefined
}

/**
 * 逐个模型判断「是否该被淘汰出链」，剔除掉链里不该出现的成员。
 *
 * 与 `buildTiers` 里的 `makeDropped` 是**同一判据的两份实现**：一份在分层时用
 * （闭包里带缓存，一次算一条链），一份在请求时用（只看本轮候选）。
 * 为什么不共用一个：分层那版活在一个闭包里、持有那条链的缓存，而请求路径要
 * 用**最新**的速度画像——分层可能已经过去 30 分钟，中间又有新样本。
 *
 * @param {Array<object>} list
 * @param {{excludeBelowTps?:number, speedMemoryMinutes?:number, slowMemoryMinutes?:number}} options
 * @returns {Array<object>} 未被淘汰的候选，顺序不变
 */
export function filterDropped(list, options = {}) {
  const rows = Array.isArray(list) ? list : []
  const cut = Number(options.excludeBelowTps)
  if (!Number.isFinite(cut) || cut <= 0) return rows
  return rows.filter(row => {
    const s = speedOf(row.id, { speedMemoryMinutes: options.speedMemoryMinutes })
    const tps = Number(s?.tps)
    if (Number.isFinite(tps) && tps > 0) return tps >= cut
    // 没有吞吐数据：只有「被请求期判慢」的才淘汰，没测过的一律留下。
    if (tps === 0) return !isSlow(row.id, { slowMemoryMinutes: options.slowMemoryMinutes })
    return true
  })
}

/**
 * 一次「淘汰 + 按吞吐降序」的纯函数封装，供设置页的预览榜使用。
 *
 * 分离出来是为了让「设置页显示的榜」与「链里实际的顺序」用**同一套判据**：
 * 两处各写一份，迟早会漂移成「页面说它第一、实际排第三」。
 *
 * 与 `buildTiers` 的差别只在「分档」：这里给出的是**严格按吞吐降序**的直觉榜，
 * 便于用户一眼看出谁最快；`buildTiers` 再把它切成档、档内按价格排。
 */
export function rankCandidates(list, options = {}) {
  const usable = filterDropped(Array.isArray(list) ? list : [], options)
  const speedMemoryMinutes = options.speedMemoryMinutes
  return usable.slice().sort((a, b) => {
    const ta = throughputOf(a.id, speedMemoryMinutes)
    const tb = throughputOf(b.id, speedMemoryMinutes)
    if (ta !== tb) {
      if (ta === undefined) return 1
      if (tb === undefined) return -1
      return tb - ta
    }
    return String(a.id).localeCompare(String(b.id))
  })
}

/**
 * 判定速度所需的最少正文字符数。
 *
 * 低于这个量时，「字符数 / 耗时」的噪声大于信号：一个 5 字符的短句可能在
 * 20ms 内出完（看起来 83 tok/s），也可能在 900ms 内出完（看起来 1.8 tok/s），
 * 两者都不说明模型的真实吞吐。24 个字符大约是一句话的长度，足够得到稳定的
 * 量级判断，又不至于让短回答永远测不到。
 */
const MIN_SPEED_SAMPLE_CHARS = 24

/**
 * 从一段已经流出的正文里估速度。
 *
 * 用「正文 token 数 / 从首个正文到现在的秒数」。中文按 1 字 ≈ 1 token 粗估，
 * 英文按 4 字符 ≈ 1 token——这只是判断「快不快」的量级，不需要精确到与账单
 * 一致；精确值由上游的 usage 给。
 *
 * ## 为什么不再要求「耗时 ≥ 500ms」
 *
 * 早先版本用一个固定毫秒下限过滤短样本，结果是**快速完成的短回答完全测不到**
 * ——实测 32 字符 / 147ms 的回合被整段跳过，而它恰恰是「一句话等很久」的
 * 典型。现在把「样本够不够」交给调用方按**字符数**判断：字符够多时，再短的
 * 耗时也能算出有意义的量级。
 *
 * @param {number} chars - 已输出的正文字符数
 * @param {number} elapsedMs - 从首个正文增量到现在的毫秒数
 * @returns {number} tokens/s；输入无效时返回 0（不下结论）
 */
export function estimateTps(chars, elapsedMs) {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const tokens = chars / 3
  return tokens / (elapsedMs / 1000)
}


// ── 速度探测 ────────────────────────────────────────────────────────────────

/**
 * 速度探测的并发上限。
 *
 * ## 为什么必须并发、且必须设上限
 *
 * 串行探测 90 个模型 × 每个 3~8 秒 = 5~12 分钟，用户不可能等。并发能把墙钟
 * 压到分钟级，**但也不能全放**：
 *
 *   - 每个请求都真的消耗上游额度（免费模型也占配额、付费模型直接计费）；
 *   - 同时打几十个请求容易被上游限流，反而让所有探测都超时。
 *
 * 4 路并发是实测的平衡点：90 个模型约 1~2 分钟跑完，且不会把上游打爆。
 */
/**
 * 探测调度的两个上限。
 *
 * ## 为什么不是单一的「总并发数」
 *
 * 风控真正在意的是**同一账号的并发**。全局队列无法表达这一点：4 个工人
 * 从队尾随便取，相邻的常常是同一渠道，于是同一账号同时挨 4 个请求。
 *
 * 改成「每渠道串行」之后，单账号并发恒为 1；总并行度由渠道数决定，
 * 不再牺牲探测速度。
 *
 * ## 为什么还要有上限
 *
 * 渠道可能有二十几个（不同平台各自独立），全放出去对上游是另一类异常
 * 特征。8 是「够快但不夸张」的折中：近百个模型约 1–2 分钟跑完。
 */
export const PROBE_LANES_PER_PROVIDER = 1
export const PROBE_MAX_PROVIDERS = 8

/**
 * 两次探测请求之间的随机间隔（毫秒）。
 *
 * 固定间隔本身就是机器人特征。加抖动既让时序自然，也顺手把同渠道的
 * 请求拉开距离。上限取 500 而不是更大，是因为它直接线性拖慢探测——
 * 而探测慢意味着「按速度排序」要等更久才准。
 */
export const PROBE_JITTER_MS = [200, 500]

/**
 * 单次探测的等待上限。
 *
 * 探测发的是一个「极短」请求（只要一两个字的回答），所以首字延迟就是主要
 * 成本。给 12 秒：足以覆盖正常的上游排队，又能把病态慢的模型尽快判掉——
 * 那种模型正是用户最想在列表里一眼认出来的。
 */
export const PROBE_TIMEOUT_MS = 12_000

/**
 * 这次探测失败，算不算「这个模型慢」？
 *
 * 只把**速度/产出**类的失败算进来：
 *
 *   - 超时（`超时（12s）`）：连最小请求都等不到——最典型的「慢」；
 *   - 空响应 / 流提前结束：上游答应给了却不产出，实际用起来等于卡死；
 *   - 只思考不回答被当成成功处理（见 `probeModel`），不在这里。
 *
 * **不算**的是 `HTTP 4xx/5xx`：那是「请求或服务的问题」，不是「速度问题」。
 * 把它们也记成慢，会让一次网关抖动把一堆本来很快的模型永久踢出候选——这
 * 正是「淘汰」这个功能最危险的误伤方式。
 */
export function isSpeedFailure(error) {
  const text = String(error ?? '')
  if (text === '') return false
  if (/^超时/.test(text)) return true
  if (/空响应/.test(text)) return true
  if (/流提前结束/.test(text)) return true
  return false
}

/**
 * 速度探测的运行态。
 *
 * 放在模块级而不是 `apply` 闭包里，因为它是**进程级**的资源：同一进程里
 * 重复 apply（热重载）不该让探测状态分裂。
 */
const probeState = {
  running: false,
  total: 0,
  done: 0,
  startedAt: 0,
  finishedAt: 0,
  /** 待测队列；点「停止」时清空即可中断。 */
  queue: [],
  /** 用户点了停止。 */
  cancelled: false,
}

/** 只读快照，供设置页显示进度。 */
export function probeSnapshot() {
  return {
    running: probeState.running,
    total: probeState.total,
    done: probeState.done,
    startedAt: probeState.startedAt,
    finishedAt: probeState.finishedAt,
  }
}

/** 请求停止探测（当前在跑的那几个会自然结束，队列被清空）。 */
export function stopProbe() {
  probeState.cancelled = true
  probeState.queue = []
  // 停止时把已经测到的结果落盘，避免「点了停止、数据却没保存」。
  flushSpeedMemoryNow()
  return probeSnapshot()
}

/**
 * 探测单个模型：发一个最小请求，量出首字延迟与吞吐。
 *
 * ## 为什么用「一个字」的 prompt
 *
 * 探测要的是**延迟**，不是内容。让模型只回一两个字符就能把生成阶段压到最短，
 * 这样测出来的时间几乎全是「上游排队 + 首字」——正是用户等待的体感。
 *
 * ## 为什么同时记 tps
 *
 * 首字快但吐字慢的模型（常见于长思考模型）在首字这一项上会显得很好，实际
 * 用起来仍慢。所以正文窗口里的吞吐也一并记录，由 `estimateTps` 算。
 *
 * @returns {Promise<{ok:boolean, ttfb?:number, tps?:number, error?:string}>}
 */
export async function probeModel(modelId, deps) {
  const { base, key, timeoutMs = PROBE_TIMEOUT_MS } = deps
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  let firstTextAt = 0
  /** 第一个**任意可见**增量（正文或思考）的时刻——这才是用户实际等的。 */
  let firstVisibleAt = 0
  let chars = 0
  let reasoningChars = 0
  let sawFinish = false
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      /**
       * `max_tokens` 必须够大，否则会**系统性误判思考型模型**。
       *
       * 实测（同一批模型、不同预算）：
       *
       *   lobsterai/deepseek-flash  mt=16 -> 正文 3 字（思考 55）
       *                             mt=64 -> 正文 0 字（思考 169）
       *                             mt=256 -> 正文 29 字
       *   buddy/glm-5.3-flash       mt=16 -> 正文 0 字
       *                             mt=64 -> 正文 0 字
       *                             mt=256 -> 正文 167 字
       *
       * 这些模型先"想"很久，小预算全被思考阶段吃掉，正文一个字都留不下——
       * 于是它们会被判成「空响应」而沉到链尾，可实际上它们完全能用。
       *
       * 256 是实测的平衡点：思考型模型也能吐出正文，而探测成本仍远低于一次
       * 真实请求（真实请求常用 400+ 预算且要生成完整回答）。
       */
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 256,
        stream: true,
      }),
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      return { ok: false, error: `HTTP ${response.status} ${detail.slice(0, 60)}` }
    }
    for await (const chunk of decodeChatSse(response, controller.signal)) {
      if (chunk.type === 'text-delta') {
        if (firstVisibleAt === 0) firstVisibleAt = Date.now()
        if (firstTextAt === 0) firstTextAt = Date.now()
        chars += String(chunk.text ?? '').length
      }
      if (chunk.type === 'reasoning-delta') {
        if (firstVisibleAt === 0) firstVisibleAt = Date.now()
        reasoningChars += String(chunk.text ?? '').length
      }
      if (chunk.type === 'finish') sawFinish = true
    }
    /**
     * 判定分三种情况，不能只看「有没有正文」。
     *
     * 1. **有正文** → 正常，用首字延迟与吞吐记画像。
     * 2. **只想不说**（有思考、无正文）→ 记录 `ttfb = 首个可见增量的时刻`，
     *    但吞吐记 0。这类模型真实可用，只是预算是被思考吃掉了；但它的首字
     *    确实更晚，所以用实测时间参与排序（自然排在真正快的模型之后）。
     * 3. **彻底为空**（既无正文也无思考）→ 失败，记为超时量级的慢。
     *
     * 早先把第 2 种也当成功且用「很短的总耗时」当 ttfb，结果能思考的模型被
     * 误判成最快、挂到链首；后来改成一律失败，又把这些模型错误地沉到链尾。
     * 两种都是错的——必须分开。
     */
    if (firstTextAt === 0) {
      if (firstVisibleAt > 0) {
        return {
          ok: true,
          ttfb: firstVisibleAt - startedAt,
          tps: 0,
          note: `只思考未作答（思考 ${reasoningChars} 字）`,
        }
      }
      return { ok: false, error: sawFinish ? '空响应（未产出任何内容）' : '流提前结束' }
    }
    const genMs = Math.max(1, Date.now() - firstTextAt)
    return {
      ok: true,
      ttfb: firstTextAt - startedAt,
      tps: estimateTps(chars, genMs),
    }
  } catch (error) {
    const aborted = controller.signal.aborted
    return { ok: false, error: aborted ? `超时（${Math.round(timeoutMs / 1000)}s）` : String(error?.message ?? error).slice(0, 60) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动一轮速度探测（后台跑，不阻塞调用方）。
 *
 * ## 设计要点
 *
 *   1. **跳过已有画像的模型**：`only` 为空时只测「还没数据」的——重复测既费
 *      额度又没有新信息。用户想强制重测可以传 `force`。
 *   2. **并发 4 路**：把墙钟从十分钟压到一两分钟。
 *   3. **每测完一个就回报**：调用方（HTTP 层）能实时看到进度，用户不必干等。
 *   4. **可中断**：停止只清队列，在跑的那几个自然结束。
 *   5. **单飞**：已经在跑就不再开一轮，避免重复消耗额度。
 *
 * @param {object} deps - `{ list, base, key, force, onProgress }`
 * @returns {Promise<{started:boolean, total:number, reason?:string}>}
 */
/**
 * 两轮探测之间的最小间隔（毫秒）。
 *
 * ## 为什么需要它
 *
 * 用户连点「立即重新分层」或快速切换设置时，可能连续触发多轮全量探测。
 * 每一轮都是近百个请求——叠加起来就是明显的异常流量。60 秒的冷却足以
 * 挡住手抖式的重复触发，又不妨碍「确实想再测一次」的正常使用（等一分钟）。
 *
 * 注意：它**不**限制用户实际对话——探测与请求路径完全分离，这条规则
 * 只作用于后台测速任务。
 */
export const PROBE_COOLDOWN_MS = 60_000

export async function runProbe(deps) {
  if (probeState.running) {
    return { started: false, total: probeState.total, reason: '已有一轮探测在进行' }
  }
  const { list, base, key, force = false, onProgress } = deps
  /**
   * 冷却检查：只挡「非强制」的自动触发；用户显式点「重测全部」仍放行。
   *
   * 判断依据是上一轮的**结束**时间。距离太近就跳过，并把等待秒数回给
   * 调用方，让日志能说清「为什么这次没测」。
   */
  const sinceLast = Date.now() - (probeState.finishedAt || 0)
  if (force !== true && probeState.finishedAt > 0 && sinceLast < PROBE_COOLDOWN_MS) {
    const wait = Math.ceil((PROBE_COOLDOWN_MS - sinceLast) / 1000)
    return { started: false, total: 0, reason: `距上一轮探测不足 ${PROBE_COOLDOWN_MS / 1000} 秒，请 ${wait} 秒后再试` }
  }
  const pending = (Array.isArray(list) ? list : []).filter(row => {
    if (force) return true
    return speedOf(row.id, deps) === undefined
  })
  if (pending.length === 0) {
    return { started: false, total: 0, reason: '所有模型都已有速度画像（可勾选强制重测）' }
  }

  probeState.running = true
  probeState.cancelled = false
  probeState.total = pending.length
  probeState.done = 0
  probeState.startedAt = Date.now()
  probeState.finishedAt = 0
  probeState.queue = [...pending]

  /**
   * 按渠道分组。
   *
   * 同一个 provider 的模型共享账号，所以它们必须**串行**——这是把
   * 「单账号并发」压到 1 的关键。不同 provider 之间没有共享关系，可以并行。
   */
  const byProvider = new Map()
  for (const row of pending) {
    const provider = String(row.id ?? "").split("/")[0] || "unknown"
    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider).push(row)
  }

  /** 随机抖动，避免精确等间隔这种机器人特征。 */
  const jitter = () => {
    const [lo, hi] = PROBE_JITTER_MS
    return lo + Math.floor(Math.random() * Math.max(1, hi - lo))
  }

  /**
   * 一个渠道的工人：串行测完自己的队列。
   *
   * 每次请求前等一小段随机时间。这既是抖动，也天然把同一账号的请求
   * 拉开——不需要额外维护「上次请求时间」。
   */
  const providerWorker = async queue => {
    for (const row of queue) {
      if (probeState.cancelled) return
      await new Promise(resolve => setTimeout(resolve, jitter()))
      if (probeState.cancelled) return
      const result = await probeModel(row.id, { base, key })
      if (result.ok) {
        recordSpeed(row.id, { ttfb: result.ttfb, tps: result.tps })
        /**
         * 「测出来了、而且够快」就清掉慢记录。
         *
         * 不清的话，一个昨天被请求期判慢的模型即使今天测出 120 tok/s，仍会
         * 因为 `isSlow` 为真而被 `filterDropped` 挡在链外——「重测全部」就
         * 失去了「重新证明自己」的意义。
         */
        if (Number(result.tps) > 0 && Number(result.tps) >= positive(config.minTokensPerSecond, DEFAULTS.minTokensPerSecond)) {
          markFast(row.id)
        }
      } else {
        /**
         * 失败也记一笔「很慢」。
         *
         * 一个连最小请求都超时的模型，实际用起来只会更糟。给它一个等于超时
         * 上限的 ttfb，让速度排序把它沉到最后——这比「没数据」更能保护用户
         * 不再浪费一次完整请求的时间。
         */
        recordSpeed(row.id, { ttfb: PROBE_TIMEOUT_MS, tps: 0 })
        /**
         * **速度类**失败才记「慢」，HTTP 4xx 不算。
         *
         * 这个区别决定了它会不会被「吞吐淘汰」摘掉：超时 / 空响应 / 只思考
         * 不回答是「这个模型干活不行」，该淘汰；而 `HTTP 400` 多半是请求形状
         * 或该模型不支持这套参数——那不是慢，换个参数就能用，把它淘汰掉是
         * 误伤。
         */
        if (isSpeedFailure(result.error)) {
          markSlow(row.id)
        } else {
          markFast(row.id)
        }
      }
      probeState.done += 1
      try { onProgress?.(probeState.done, probeState.total) } catch { /* 回报失败不影响探测 */ }
    }
  }

  try {
    /**
     * 渠道之间并行，渠道内串行；最多同时开 PROBE_MAX_PROVIDERS 个渠道。
     *
     * 用「分批」而不是「信号量」实现上限：分批更简单，且每批之间的边界
     * 让上游看到的流量有自然起伏，而不是持续满速。
     */
    const groups = [...byProvider.values()]
    for (let start = 0; start < groups.length; start += PROBE_MAX_PROVIDERS) {
      if (probeState.cancelled) break
      const batch = groups.slice(start, start + PROBE_MAX_PROVIDERS)
      await Promise.all(batch.map(queue => providerWorker(queue)))
    }
  } finally {
    probeState.running = false
    probeState.finishedAt = Date.now()
    probeState.queue = []
    /**
     * 显式落盘。
     *
     * 防抖定时器只会「1.5 秒内没新样本时写一次」，但探测刚跑完这段时间正是
     * 用户期待数据已保存的时刻——如果进程恰好在此刻退出，最后一批样本就丢了。
     * 这里直接落盘，把确定性给到调用方。
     */
    flushSpeedMemoryNow()
  }
  return { started: true, total: pending.length }
}

// ── 积分汇总 ────────────────────────────────────────────────────────────────

/** 是否至少有一个渠道拿到了逐账号余额（账号排序的前提）。 */
function hasAccountBalances(accounts) {
  if (accounts === null || typeof accounts !== 'object') return false
  return Object.values(accounts).some(list => Array.isArray(list) && list.length > 0)
}

/**
 * 把逐渠道的积分汇总成一个总数。
 *
 * 只累加**查得到**的渠道；查不到的那些既不当作 0，也不去猜——它们单独计数，
 * 设置页会显示「其中 N 个渠道未知」。这样「还剩 X 分」是一个诚实的下界：
 * 真实可用的只会更多，不会更少。
 *
 * @param {Record<string, {total:number, expiring:number}>} credits
 */
export function summarizeCredits(credits) {
  const entries = Object.entries(credits ?? {})
  /**
   * 额度型渠道（`QUOTA_PROVIDERS`）的数字不能和积分相加。
   *
   * 实测 `zcode` 报的是「10 个账号 × 800 万」= 8000 万，`codearts` 报 12.9 万
   * ——这些是**平台侧的配额池**，不是用户能花的积分。把它们加进总额会让
   * 「可用积分」变成一个毫无意义的九位数，用户完全无法据此判断还剩多少。
   *
   * 所以分成两组：积分型渠道加总成 `total`，额度型渠道只记「有多少个」，
   * 由设置页单独用一句话说明。
   */
  let total = 0
  let expiring = 0
  const quota = []
  for (const [name, value] of entries) {
    if (QUOTA_PROVIDERS.has(name)) { quota.push(name); continue }
    total += Number(value?.total) || 0
    expiring += Number(value?.expiring) || 0
  }
  return {
    /** 可用的**积分**总量（已扣掉过期的包，不含额度型渠道）。 */
    total: Math.round(total * 100) / 100,
    /** 其中在 `expiringWindowDays` 内到期的部分。 */
    expiring: Math.round(expiring * 100) / 100,
    /** 有余额数据的渠道数。 */
    knownChannels: entries.length,
    /** 额度型渠道（按天给额度，数字不可与积分相加）。 */
    quotaChannels: quota,
    /** 逐渠道明细，供设置页展开。 */
    byChannel: Object.fromEntries(entries.map(([name, value]) => [name, {
      total: Math.round((Number(value?.total) || 0) * 100) / 100,
      expiring: Math.round((Number(value?.expiring) || 0) * 100) / 100,
      quota: QUOTA_PROVIDERS.has(name),
    }])),
  }
}

// ── 请求体 ──────────────────────────────────────────────────────────────────

/**
 * 把工具调用的参数归一成**合法 JSON 字符串**。
 *
 * 上游（OpenAI 兼容层）对 `tool_calls[].function.arguments` 的要求是
 * 「一个能被 JSON.parse 的字符串」。实测有四种坏输入会让整个请求 400：
 *
 *   - `undefined` / `null` —— 直接报 invalid function call；
 *   - 空串 `''` —— 同上；
 *   - 已经是对象 —— 有的实现接受，有的不接受，统一序列化更安全；
 *   - 半截 JSON（流式被截断）—— 这个最隐蔽，必须解析验证。
 *
 * 所以这里不信任输入：字符串就解析一次，解析失败或结果不是对象就退化成 `{}`。
 * 宁可让模型看到一个空参数重试，也不要让整条链因为一条历史消息全部失败。
 */
export function toArgumentsJson(value) {
  if (value === undefined || value === null) return '{}'
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '{}' }
  }
  const raw = String(value).trim()
  if (raw === '') return '{}'
  try {
    const parsed = JSON.parse(raw)
    // 只接受对象：数组/标量不是合法的函数参数。
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? raw : '{}'
  } catch {
    return '{}'
  }
}

/**
 * 把工具结果块的内容压成字符串。
 *
 * `role:"tool"` 的 content 在 OpenAI 协议里是字符串；把数组原样塞进去有的
 * 上游会接受、有的会报 400。这里统一摊平成文本。
 */
export function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map(block => (typeof block === 'string' ? block
      : block?.type === 'text' ? String(block.text ?? '') : ''))
    .filter(value => value !== '')
    .join('\n')
}

/**
 * harness 消息 → 网关 Chat 消息。
 *
 * 图片按 harness 的 block 形状取 `attachment.url`；`tool` 角色消息保留
 * `tool_call_id`，否则网关无法把结果配回调用。
 */
export function toChatBody(options) {
  const source = Array.isArray(options.messages) ? options.messages : []

  /**
   * 工具调用的**配对规则**——这是整条链能否回话的关键。
   *
   * ## 为什么不能「补 id」
   *
   * 早期版本给缺 id 的 tool-call 补占位 id，结果反而更糟：补出来的 id 在后文
   * 没有对应的 tool 结果，上游照样判
   * `assistant.tool_calls contains an invalid function call`。
   *
   * ## 正确做法：不成对就整组丢弃
   *
   * 参照渠道包自己的 `resolveToolPairing`（它天天在跑，规则经过实战验证）：
   *
   *   1. 收集全历史里所有 `tool-result` 的 `toolCallId`；
   *   2. 对每条 assistant 消息，取出其中带**有效名字**的 tool-call；
   *   3. 只有当这条消息里**每一个** call 都能在全历史里找到结果时，才保留这组；
   *      否则这一组 call **全部丢掉**；
   *   4. 只保留「被保留的 call」对应的 tool 结果。
   *
   * 丢掉的是历史里已经无法自圆其说的片段（比如上一轮被截断、或换过 provider
   * 后 id 失配）。模型看不到它们不影响继续对话，但留着会让整个请求 400。
   */
  const resultIds = new Set()
  for (const message of source) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type !== 'tool-result') continue
      const id = String(block.toolCallId ?? '').trim()
      if (id !== '') resultIds.add(id)
    }
    if (message?.role === 'tool') {
      const id = String(message.toolCallId ?? message?.source?.callId ?? '').trim()
      if (id !== '') resultIds.add(id)
    }
  }

  /** 每条 assistant 消息里被判定为「可保留」的 call id。 */
  const keepCallIds = new Set()
  for (const message of source) {
    if (message?.role !== 'assistant') continue
    const blocks = Array.isArray(message?.content) ? message.content : []
    const calls = blocks.filter(block => block?.type === 'tool-call')
    if (calls.length === 0) continue
    // 没名字的调用上游一定拒绝，直接排除在「可用」之外。
    const usable = calls.filter(block => typeof block.name === 'string' && block.name.trim() !== '')
    if (usable.length === 0) continue
    const paired = usable.every(block => resultIds.has(String(block.id ?? '').trim()))
    if (!paired) continue
    for (const block of usable) keepCallIds.add(String(block.id ?? '').trim())
  }

  const messages = []
  const system = typeof options.system === 'string' ? options.system.trim() : ''
  if (system !== '') messages.push({ role: 'system', content: system })

  for (const message of source) {
    const role = message?.role
    if (role === 'system') continue

    // 独立的 tool 消息：只有 id 属于「保留的调用」才发，否则丢弃。
    if (role === 'tool') {
      const id = String(message.toolCallId ?? message?.source?.callId ?? '').trim()
      if (!keepCallIds.has(id)) continue
      messages.push({ role: 'tool', tool_call_id: id, content: flattenText(message.content) || '(no output)' })
      continue
    }

    const blocks = Array.isArray(message?.content) ? message.content : null
    if (blocks === null) {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: String(message?.content ?? '') })
      continue
    }

    const parts = []
    let toolCalls = null
    /** 内嵌的 tool-result 先攒着，等这条消息处理完再按配对规则决定去留。 */
    const inlineResults = []

    for (const block of blocks) {
      if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
        const value = String(block.text ?? '')
        if (value !== '') parts.push({ type: 'text', text: value })
      } else if (block?.type === 'image') {
        const url = typeof block.attachment?.url === 'string' ? block.attachment.url : ''
        if (url !== '') parts.push({ type: 'image_url', image_url: { url } })
      } else if (block?.type === 'tool-result') {
        const id = String(block.toolCallId ?? '').trim()
        if (keepCallIds.has(id)) inlineResults.push({ id, content: flattenText(block.content) || '(no output)' })
      } else if (block?.type === 'tool-call') {
        const id = String(block.id ?? '').trim()
        // 没通过配对检验的调用不发给上游——这是「整组丢弃」的落点。
        if (!keepCallIds.has(id)) continue
        toolCalls ??= []
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name: String(block.name),
            // 必须是合法 JSON 的对象字符串：空串 / 半截 JSON / 标量一律归一成 {}。
            arguments: toArgumentsJson(block.arguments ?? block.input),
          },
        })
      }
    }

    if (parts.length === 1 && parts[0].type === 'text') {
      messages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: parts[0].text,
        ...toolCalls === null ? {} : { tool_calls: toolCalls },
      })
    } else if (parts.length > 0 || toolCalls !== null) {
      messages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: parts.length > 0 ? parts : '',
        ...toolCalls === null ? {} : { tool_calls: toolCalls },
      })
    }

    for (const result of inlineResults) {
      messages.push({ role: 'tool', tool_call_id: result.id, content: result.content })
    }
  }

  const body = { messages, stream: true }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: String(tool.name ?? ''),
        ...typeof tool.description === 'string' ? { description: tool.description } : {},
        parameters: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
  }
  if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  return body
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  /**
   * 配置合并：默认 < 内核传来的值 < 落盘设置。
   *
   * ## 这里踩过一个真实的坑（用户反馈「关闭模型后重启失效」）
   *
   * 诊断输出显示：内核每次启动都传来一整套**完整**字段，而每个值都等于
   * `Config` schema 的 `.default()`——也就是**默认值，不含用户意图**：
   *
   * ```
   * rawConfigReceived: { ..., "customModels":"", "membersFree":"" }
   * loadedDisabledCount: 36      ← 落盘里明明有 36 个
   * configDisabledCount: 0       ← 合并后被内核的空串覆盖成 0
   * ```
   *
   * 原因是内核的设置控制器从 schema 生成全量默认值并持久化，启动时整份传给
   * 插件。初版写 `{ ...DEFAULTS, ...落盘, ...内核 }`，于是这份默认值把插件
   * 自己写盘的用户选择全部盖掉。
   *
   * ## 规则：落盘是用户意图的唯一权威
   *
   * `~/.dsh/dsh-baipiao-stone/settings.json` 由本插件设置页写入，是「用户选过
   * 什么」的唯一记录。内核那份只是默认值，因此：
   *
   *   - 落盘里有的字段 → **以落盘为准**；
   *   - 落盘里没有的字段 → 用内核传来的值，再没有就用 `DEFAULTS`。
   *
   * 手工在 `cordis.patch.yml` 里写 config 的场景仍然有效：那种情况下内核传的
   * 是显式值，而落盘通常还没写过该字段，于是内核值生效。
   */
  // 恢复上次进程留下的速度观测——不恢复的话「按实测速度排序」每次重启都归零。
  restoreSpeedMemory()
  const persisted = loadPersistedSettings()
  const fromKernel = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(fromKernel)) {
    if (value !== undefined) config[key] = value
  }
  for (const [key, value] of Object.entries(persisted)) {
    if (value !== undefined) config[key] = value
  }
  const logger = ctx.logger ?? console

  let tiers = { free: [], low: [], high: [], custom: [] }
  /** 上一次拉到的全部模型行；设置页的「可选 1M 模型」清单就从它现算。 */
  let allRows = []
  /**
   * 历史最大清单行数。
   *
   * 用来判断「本轮清单是否完整」——见 `pruneStaleCustomModels`。上游清单在
   * 启动瞬间往往不全（网关刚起来、渠道还在登录），拿不完整的清单去判断
   * 「某个模型是不是下架了」会误删用户的选择。
   */
  let catalogPeak = 0
  /** 上一次余额查询的结果；首轮为空，等价于「全部未知」。 */
  let expiryState = { annotated: [], skipped: [] }
  /**
   * 余额查询的代号，用来丢弃过期应答。
   *
   * 每次发起查询前自增；应答回来时若代号已变，说明期间用户关掉了开关或又
   * 触发了一轮新的查询，这次应答的数据不该再写进状态。
   */
  let expiryGeneration = 0
  let status = {
    at: 0, ok: false, error: '', gateway: '', total: 0,
    /** 四条链里可调用的候选总数（去重后）。设置页顶部那行就显示它。 */
    callable: 0,
    /** 积分汇总；余额查询完成前为 undefined。 */
    credits: undefined,
    /**
     * 积分数字的采集时刻。
     *
     * 余额查询是异步的（一次全渠道要 10–20 秒），而分层是同步的。设置页
     * 顶部显示的是积分，如果只看 `at` 就分不清「这份积分是哪一轮查的」。
     * 前端据此判断「点了重新分层后，积分到底更新了没有」。
     */
    creditsAt: 0,
    /**
     * 是否有一轮余额查询正在进行。
     *
     * 点「立即重新分层」后接口会立刻返回（不等余额），此时
     * `creditsPending: true` 让页面显示「积分更新中…」而不是假装数字是新的。
     */
    creditsPending: false,
  }
  let timer

  const log = message => { if (config.verbose) logger.info?.(`[baipiao] ${message}`) }

  /**
   * 把 Custom 里已经查不到的模型 id（改名/下架）从配置里写掉。
   *
   * 判据：`customModels` 里每个 id，在本次拉到的清单里都找不到（大小写不敏感）。
   * 找到的保留，找不到的移除。清理后写盘，保证重启后也不会再出现。
   *
   * 注意：只删**确实不存在**的。上游暂时没返回某个模型（比如网关短暂故障只
   * 返回了一半清单）不应触发误删——所以这里只在 `fetched.rows` 非空且分层成功
   * 之后调用，且只比较「一个都没有」的 id。
   */
  function pruneStaleCustomModels(rows) {
    /**
     * 哨兵不是模型 id，不能被「查不到就删」的逻辑处理。
     *
     * 早期在这里直接跑 `parseCustomModels` 得到 `['__none__']`，而它当然
     * 不在本轮清单里，于是被判成「已下架」删掉、写成空串——空串在 auto 模式
     * 下等于「全选」，用户点的「全不选」就这样被**悄悄撤销**了。
     */
    if (String(config.customModels ?? '').trim().toLowerCase() === NONE_SELECTED) return
    const requested = parseCustomModels(config.customModels)
    if (requested.length === 0) return
    const list = Array.isArray(rows) ? rows : []

    /**
     * 闸：清单明显不完整时不动手。
     *
     * 早先版本在任何一次 refresh 都清理 Custom，结果踩了真实的坑：**重启后
     * 用户选过的模型全没了**。原因是启动瞬间上游清单往往不完整（网关刚起来、
     * 渠道还在登录），用户选的模型被判成「已下架」删掉并落盘——一次误判就
     * 把选择永久丢掉。
     *
     * 判据是「本轮行数 vs 历史峰值」：低于峰值的七成说明上游没给全，跳过。
     * 宁可留几个幽灵 id（它们不进链路，只占配置几行字），也不能因一次抖动
     * 删掉用户的选择。
     */
    if (catalogPeak > 0 && list.length < catalogPeak * CUSTOM_PRUNE_MIN_RATIO) {
      log(`本轮清单偏小（${list.length} < 峰值 ${catalogPeak} 的 ${Math.round(CUSTOM_PRUNE_MIN_RATIO * 100)}%），跳过 Custom 清理以免误删`)
      return
    }
    if (list.length > catalogPeak) catalogPeak = list.length

    const live = new Set(list.map(row => String(row.id ?? '').toLowerCase()))
    const kept = requested.filter(id => live.has(id))
    if (kept.length === requested.length) return
    const removed = requested.filter(id => !live.has(id))
    config.customModels = kept.join(', ')
    persistSettings(config)
    log(`Custom 里 ${removed.length} 个模型已改名/下架，已移除：${removed.join('、')}`)
  }

  /**
   * 本机 Web 服务的地址，用于访问渠道包自己的 RPC。
   *
   * 端口由 `webServer` 决定，插件拿不到就退化成默认值；`port` 在首次注册
   * 路由时刷新一次，之后沿用（宿主重启会重新走一遍 apply）。
   */
  const webPort = { value: 0 }

  /**
   * 调用渠道包的 `channel-pack` RPC（如 `credits.balances`）。
   *
   * ## 这是**可选增强**，不是依赖
   *
   * 只有「先用快到期的积分」这一条需要它。拿不到时（没装渠道包、渠道包
   * 换了接口、鉴权失败）`annotateExpiry` 会把所有渠道标成「未知」，三条链
   * 照常工作，只是排序退化成「按倍率」。因此这里的任何失败都只降级、不抛到
   * 调用栈上层。
   *
   * ## 为什么绕道 HTTP 而不是直接 import
   *
   * 渠道包是 `dsh-our-free-model` 的 vendored 目录，路径与内部结构会随对方
   * 升级变化。`/api/channel-pack` 是它对外承诺的接口，形状稳定；即使它换了
   * 实现，只要接口还在，本插件就不受影响。**这条路径失败也不影响三条链**。
   *
   * ## 为什么需要 cookie
   *
   * 那个端点和所有 `/api/*` 一样受会话鉴权保护。宿主侧用凭据库里的会话密钥
   * 自签一个短期 cookie，以本地已认证客户端的身份访问。
   */
  /**
   * 让上游（渠道包）把模型清单与倍率重新拉一遍。
   *
   * ## 为什么要这一步
   *
   * 渠道包自己会缓存模型清单。DSH 每次启动时，我们读到的可能是**上次进程**
   * 留下的清单——新上架的模型不在里面，改过的倍率也还是旧的。用户的要求是
   * 「每次打开都是最新模型」，所以启动时先踢它一脚。
   *
   * ## 为什么不是必须成功
   *
   * 这是对**另一个插件**的调用。它可能没装、版本不同、或者正忙。任何失败都
   * 只记一条日志然后继续分层——用缓存清单分层，总比不分层好。
   *
   * 端点 `POST /api/our-free-model/refresh` 带 `probe: true, force: true`，
   * 是渠道包自己「强制重新探测」的入口。
   */
  async function primeUpstreamCatalog() {
    if (config.primeUpstream === false) return
    const secret = readSessionSecret()
    const port = webPort.value
    if (secret === undefined || !port) {
      log('拿不到本机端口或会话密钥，跳过上游刷新（仍会分层）')
      return
    }
    const authority = `127.0.0.1:${port}`
    const controller = new AbortController()
    // 探测要跑一整轮上游请求，给足 90 秒；超时就放弃，不阻塞启动。
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const response = await fetch(`http://${authority}/api/our-free-model/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: mintCookie(secret, authority) },
        body: '{}',
        signal: controller.signal,
      })
      if (!response.ok) {
        log(`上游刷新返回 HTTP ${response.status}（用现有清单继续）`)
        return
      }
      const body = await response.json().catch(() => ({}))
      const total = Number(body?.catalog?.models?.length ?? body?.models?.length ?? 0)
      log(total > 0 ? `已让上游刷新模型清单：${total} 个模型` : '已触发上游刷新')
    } catch (error) {
      log(`上游刷新失败（用现有清单继续）：${String(error?.message ?? error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 调渠道包的 RPC。
   *
   * `opts.requiresExpiryLookup`（默认 true）：这是针对**积分**的调用，用户把
   * 「查询积分余额」关掉时就不该再发。账号重排是另一件事（它读的是同一份余额
   * 数据，但目的不是展示积分），由调用方显式关掉这个前置检查。
   */
  async function channelRpc(method, payload, timeoutMs = 30000, opts = {}) {
    if (opts.requiresExpiryLookup !== false && config.expiryLookup === false) {
      throw new Error('已在设置里关闭到期查询')
    }
    const secret = readSessionSecret()
    if (secret === undefined) throw new Error('读不到会话密钥（~/.dsh/.credentials.yaml）')
    const port = webPort.value
    if (!port) throw new Error('还不知道 Web 端口')
    const authority = `127.0.0.1:${port}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://${authority}/api/channel-pack`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: mintCookie(secret, authority),
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `baipiao-${Date.now()}`,
          method: 'channel-pack',
          payload: { method, payload },
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body?.result?.ok !== true) {
        throw new Error(body?.result?.error?.message ?? 'RPC 返回失败')
      }
      return body.result.value
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 上一次账号重排的时刻（毫秒）。节流用：`accountReorderMinutes`。
   * 按渠道记，因为不同渠道的账号变化节奏不同。
   */
  const accountReorderAt = new Map()
  /** 最近一次账号重排的结果，供设置页展示。 */
  let accountPlan = { at: 0, providers: {}, skipped: [] }

  /**
   * 把「先用快到期的账号、其余轮流」落到渠道包的**真实选号顺序**上。
   *
   * ## 为什么必须写回渠道包
   *
   * 渠道包选号用的是「账号数组里第一个可用账号」（见它自己的
   * `getAvailableAccount`），本插件拿不到那个数组。所以「优先用快到期的账号」
   * 只有一条路能真正生效：读出账号与其积分到期时间 → 算出目标顺序 → 用
   * `account.reorder` 写回去。写回之后，**每次请求**的选号都按新顺序走，
   * 包括渠道包自己的换号重试。
   *
   * ## 为什么是节流的
   *
   * `account.reorder` 要写一次渠道包的设置文件。每次 30 分钟的分层都写，
   * 既无必要（到期时间以天为单位变化），也让「顺序」变得不可观察。
   * 默认 10 分钟一次足够。
   *
   * ## 失败即降级
   *
   * 任何一步失败（渠道包没装、RPC 不通、账号列表变了）都只记日志，不影响
   * 分层与调用。这是可选增强，不是依赖。
   */
  async function reorderAccounts(accountsByProvider) {
    if (config.accountExpiryFirst === false && config.accountRotation === false) return
    const throttleMs = Math.max(0, Number(config.accountReorderMinutes) || 0) * 60_000
    const now = Date.now()
    const next = { at: now, providers: {}, skipped: [] }

    for (const [provider, balances] of Object.entries(accountsByProvider ?? {})) {
      const last = accountReorderAt.get(provider) ?? 0
      if (throttleMs > 0 && now - last < throttleMs) { next.skipped.push(`${provider}: 节流中`); continue }
      let accounts
      try {
        const value = await channelRpc('account.list', { provider }, 20_000, { requiresExpiryLookup: false })
        accounts = Array.isArray(value?.accounts) ? value.accounts : []
      } catch (error) {
        next.skipped.push(`${provider}: ${String(error?.message ?? error).slice(0, 60)}`)
        continue
      }
      if (accounts.length <= 1) { next.skipped.push(`${provider}: 只有一个账号`); continue }

      const plan = planAccountOrder({
        provider, accounts, balances,
        options: {
          expiryFirst: config.accountExpiryFirst !== false,
          rotation: config.accountRotation !== false,
          windowDays: config.expiringWindowDays,
        },
      })
      /**
       * 顺序没变就不写。
       *
       * `reorder` 会落盘并记一条日志；每轮都写同一种顺序会把日志灌满，也让
       * 「最近一次重排」这个时间戳失去意义。
       */
      const current = accounts.map(account => String(account?.id ?? ''))
      if (plan.ordered.length === current.length && plan.ordered.every((id, i) => id === current[i])) {
        accountReorderAt.set(provider, now)
        next.providers[provider] = { order: plan.ordered, changed: false, expiring: plan.expiring }
        continue
      }
      try {
        await channelRpc('account.reorder', { provider, orderedIds: plan.ordered }, 20_000, { requiresExpiryLookup: false })
        accountReorderAt.set(provider, now)
        next.providers[provider] = { order: plan.ordered, changed: true, expiring: plan.expiring }
        log(`账号顺序已更新（${provider}）：先到期 ${plan.expiring.length} 个，其余轮换起点 ${plan.cursor}`)
      } catch (error) {
        next.skipped.push(`${provider}: ${String(error?.message ?? error).slice(0, 60)}`)
      }
    }
    accountPlan = next
    return next
  }

  async function refresh() {
    const fetched = await fetchRows(config)
    if (!fetched.ok) {
      status = { ...status, at: Date.now(), ok: false, error: fetched.error }
      logger.warn?.(`[baipiao] 刷新失败，沿用上一份分层：${fetched.error}`)
      return { ok: false, error: fetched.error }
    }

    /**
     * 余额查询是**异步**的，不阻塞分层。
     *
     * 实测一次全渠道余额查询要 17 秒（13 个渠道逐个打上游），如果同步等它，
     * 每次刷新都会卡这么久——启动时更糟，第一条链要等半分钟才可用。
     *
     * 所以顺序是：先用上一次的到期数据（首轮为空，按「未知」处理）立刻分层，
     * 然后把新查到的余额合并进来、再分层一次。用户看到的是「先能用，随后
     * 按到期优先级微调」，而不是「等 17 秒」。
     */
    tiers = buildTiers(fetched.rows, config)
    allRows = fetched.rows

    // 清理 Custom 里的死 id：用户选过的模型若已改名/下架，就把它从配置里写掉，
    // 而不是每次都白查一遍、留一堆「幽灵 id」。
    pruneStaleCustomModels(fetched.rows)

    status = {
      at: Date.now(),
      ok: true,
      error: '',
      gateway: fetched.gateway,
      total: fetched.rows.length,
      /** 四条链去重后的候选数——「目前有多少个模型可以调用」。 */
      callable: countCallable(tiers),
      /**
       * 本轮因「实测吞吐低于淘汰线」而被移出所有链的模型数。
       *
       * 显示它是为了让淘汰**可见**：用户看到的模型数会比候选池少，如果没有
       * 这个数字，看起来就像「一堆模型凭空不见了」。具体名单在 `/config` 的
       * `dropped` 里。
       */
      dropped: droppedSnapshot().length,
      credits: status.credits,
      expiryKnown: expiryState.annotated.length,
      expiryUnknown: expiryState.skipped.length,
      /**
       * 积分的时间戳与「进行中」标志在这里**保留原值**：此刻手上的 `credits`
       * 还是上一轮查到的，这一轮刚发出、还没回来。给它们新的时间戳会让页面
       * 以为数字是新的——那正是「点了重新分层但积分没更新」看起来像 bug 的
       * 原因。真正的更新在下面的 `.then` 里落时间戳。
       */
      creditsAt: status.creditsAt ?? 0,
      creditsPending: status.creditsPending === true,
    }
    log(`已分层：免费 ${tiers.free.length} · 低积分 ${tiers.low.length} · 高积分 ${tiers.high.length}（共 ${fetched.rows.length} 个）`)
    try { ctx.emit('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }

    // 只有「要按到期排序」且「允许查询余额」时才去找渠道包；任一为假就完全
    // 不碰其它插件的接口，本插件只靠网关清单工作。
    if (config.preferExpiringCredits !== false && config.expiryLookup !== false) {
      status = { ...status, creditsPending: true }
      /**
       * 本轮余额查询的代号。
       *
       * 余额查询是异步的，而用户可能在它落地前把开关关掉、或触发下一轮刷新。
       * 用一个自增计数让**过期的应答被丢弃**——否则关掉开关后，在途的旧查询
       * 仍会把 credits / creditsAt 写进去，页面显示的数字来自一个已经不该跑的
       * 请求。
       */
      const generation = ++expiryGeneration
      void annotateExpiry(fetched.rows, {
        windowDays: config.expiringWindowDays,
        rpc: provider => channelRpc('credits.balances', { provider }),
      }).then(result => {
        /*
         * annotateExpiry 对每个渠道单独 try/catch，所以它自身几乎不会 reject；
         * 这里判断的是「这一轮到底有没有拿到任何渠道的余额」。
         *
         * 一个都没拿到时**不能**把 credits 写成 0：那会让顶部从「还剩 827」
         * 突然变成「0」，用户以为额度被扣光了。正确做法是保留上一轮的数值，
         * 只更新「已知/未知」计数，并且**不推进 creditsAt**——没有新数据就
         * 没有「已更新」可言。
         */
        const fresh = Object.keys(result.credits ?? {}).length > 0
        if (generation !== expiryGeneration) {
          log('余额查询结果已过期（期间开关或刷新状态变了），丢弃')
          return
        }
        expiryState = fresh ? result : expiryState
        // 用刚查到的到期数据重排一次：这一步很快（纯内存），但会让「先用
        // 快到期的」真正生效。没有新数据时沿用上一次的标注，不重排。
        if (fresh) tiers = buildTiers(fetched.rows, config)
        status = {
          ...status,
          expiryKnown: result.annotated.length,
          expiryUnknown: result.skipped.length,
          credits: fresh ? summarizeCredits(result.credits) : status.credits,
          /**
           * 只有真的拿到新数据才推进时间戳：前端拿它当「已更新」的信号，
           * 全失败时推进会让页面把旧数字当成新数字。
           */
          creditsAt: fresh ? Date.now() : (status.creditsAt ?? 0),
          creditsPending: false,
        }
        log(fresh
          ? `积分到期：${result.annotated.length} 个渠道已知，${result.skipped.length} 个未知（未知的按中间优先级处理）`
          : `本轮余额全部查询失败（${result.skipped.length} 个渠道），沿用上一轮的数值`)
        /**
         * 账号级排序：把「快到期优先 + 其余轮换」落到渠道包的真实选号顺序。
         *
         * 只在这一轮**拿到了逐账号余额**时才做：没有余额就分不出「谁的积分先
         * 作废」，硬排只会按 id 乱转，比不排更糟（会把用户手排的顺序冲掉）。
         *
         * 不 await：它要挨个渠道发 RPC 并写盘，不该拖住 refresh 的返回。
         */
        if (fresh && hasAccountBalances(result.accounts)
          && (config.accountExpiryFirst !== false || config.accountRotation !== false)) {
          void reorderAccounts(result.accounts).catch(error =>
            logger.warn?.(`[baipiao] 账号顺序重排失败（不影响调用）：${String(error?.message ?? error)}`))
        }
        try { ctx.emit('llm/adapters-updated') } catch { /* ignore */ }
      }).catch(error => {
        /*
         * 这条分支目前是**防御性**的：annotateExpiry 内部逐渠道吞异常，正常
         * 情况下不会走到这里。保留它是因为「余额查询抛错」这件事一旦发生，
         * 不清理 pending 就会让页面永远转在「更新中」——代价远比一行死代码大。
         */
        status = { ...status, creditsPending: false }
        logger.warn?.(`[baipiao] 余额查询异常：${String(error?.message ?? error)}`)
      })
    } else if (status.creditsPending === true) {
      /**
       * 不查余额的分支**必须**显式清掉「进行中」。
       *
       * ## 为什么这是一条独立的路径
       *
       * 上一轮可能刚把 `creditsPending` 置成 true（余额查询还在路上），用户
       * 随后把「查询积分余额」或「优先用完快到期的积分」关掉。那之后每次
       * `refresh` 都进不到上面那个 `annotateExpiry` 分支，也就永远走不到
       * 清 pending 的 `.then`/`.catch`——顶部会**永久**显示
       * 「可用积分（更新中…）」，看起来像卡死。
       *
       * 同理，进程在余额落地前被中断也会留下这个标记。所以「不查余额」不是
       * 「什么都不做」，而是明确宣告：没有在路上的余额查询。
       */
      expiryGeneration += 1
      status = { ...status, creditsPending: false }
      log('未开启余额查询，清掉「积分更新中」标记，并作废在途的余额应答')
    }

    return { ok: true, tiers: viewTiers() }
  }

  /**
   * 候选池：够 1M 且倍率不离谱的全部模型。
   *
   * 三条价格链与 Custom 共用同一道筛子，避免「这里能选、那里不能」的不一致。
   */
  const poolRows = () => allRows.filter(row =>
    row.contextWindow >= positive(config.longContextMin, DEFAULTS.longContextMin)
    && (row.rate === undefined || row.rate <= positive(config.absurdRate, DEFAULTS.absurdRate)))

  /**
   * 候选行的形状（设置页复选框列表用）。
   *
   * `rate` 让用户看到费率，`speed` 让用户按实测速度挑模型。没测过的 `speed`
   * 为 `undefined`，页面显示「—」——那是「还没测」，不是「很慢」。
   *
   * `dropped` 明确告诉页面「这个模型被测出来低于淘汰线、因此不在任何链里」。
   * 不传它的话，用户勾选时只会看到「勾了却不在链里」，没有任何解释。
   */
  const shape = row => ({
    id: row.id,
    provider: row.provider,
    rate: row.rate ?? null,
    vision: row.vision === true,
    speed: speedOf(row.id, { speedMemoryMinutes: config.speedMemoryMinutes }),
    dropped: filterDropped([row], {
      excludeBelowTps: config.excludeBelowTps,
      speedMemoryMinutes: config.speedMemoryMinutes,
      slowMemoryMinutes: config.slowMemoryMinutes,
    }).length === 0,
  })

  /**
   * 设置页读到的快照。
   *
   * 只回传**展示需要**的字段：链成员、倍率、能力交集，以及上次分层的时间与
   * 结果。不回传网关 Key——它已经以 `configured` 布尔值的形式出现在
   * `config` 视图里，明文没有任何一条界面需要它。
   */
  function viewState() {
    const view = key => {
      const list = membersOf(CHAIN_IDS[key])
      const cap = capacityOf(list)
      return {
        links: list.map(row => ({
          id: row.id,
          rate: row.rate ?? null,
          vision: row.vision === true,
          expiring: row.expiringCredits,
          /**
           * 实测吞吐（tokens/s）。链的顺序就是按它降序排的，把它带回去，
           * 用户才能在页面上核对「排第一的确实最快」。
           */
          tps: throughputOf(row.id, config.speedMemoryMinutes) ?? null,
        })),
        /** 这条链的快速档大小（参与轮换的候选数）。 */
        fastBand: Math.max(1, Math.trunc(Number(config.fastBandSize) || 1)),
        contextWindow: cap.contextWindow,
        vision: cap.anyVision,
        allVision: cap.vision,
        providers: [...new Set(list.map(row => row.provider))],
      }
    }
    return {
      status: { ...status },
      /**
       * 每条链**勾选**的成员 id。
       *
       * 复选框的初始勾选状态就读它。留空表示「用户还没动过这条链」，此时由
       * `chains[key].links` 里的自动分层结果作为初始勾选。
       */
      members: {
        free: parseCustomModels(config.membersFree),
        low: parseCustomModels(config.membersLow),
        high: parseCustomModels(config.membersHigh),
        custom: parseCustomModels(config.customModels),
      },
      chains: {
        free: view('free'),
        low: view('low'),
        high: view('high'),
        custom: view('custom'),
      },
      /**
       * Custom 链的选法（`auto` / `explicit`）。
       *
       * 页面据此决定「全不选之后要不要显示空链」，以及 checkbox 的勾选基准：
       * explicit 下 `members.custom` 就是权威；auto 下只有 `customModels` 里
       * 显式写过的那些，其余由候选池自动补齐。
       */
      customMode: config.customMode === 'explicit' ? 'explicit' : 'auto',
      /**
       * 可选进 custom 的 1M 模型清单（供设置页点选）。
       *
       * 与三条价格链同一门槛：contextWindow ≥ longContextMin 且倍率不离谱。
       * 按 provider 分组、组内按倍率升序，方便用户浏览。非 1M 的模型**不在**这里。
       *
       * 这是 **Custom 的候选全集**——与链成员无关。所以「全不选」之后模型
       * 一个都不会从这里消失，用户随时能再勾回来。`rate` 与 `speed` 一并带上，
       * 设置页才能显示费率和实测速度。
       */
      available: poolRows().map(shape).sort((a, b) => a.provider.localeCompare(b.provider) || (a.rate ?? 99) - (b.rate ?? 99)),

      /**
       * 按档位分组的可选模型（供三条价格链的复选框面板）。
       *
       * 「立即分级」的产物就是这个：把符合各链积分规则的模型挑出来，**不直接
       * 塞进链里**，而是交给用户勾选。所以这里只是候选清单——用户勾了哪些，
       * 由 `/chain/toggle` 写进 `membersFree` 等，之后 `buildTiers` 才按那份
       * 清单组装链。
       *
       * `custom` 这一档**就是候选池全集**：Custom 的复选框列表永远是全部可选
       * 模型，勾选与否只影响它是否进链，不影响它是否出现在列表里。
       */
      eligible: (() => {
        const options = {
          lowMaxRate: positive(config.lowMaxRate, DEFAULTS.lowMaxRate),
          longContextMin: positive(config.longContextMin, DEFAULTS.longContextMin),
        }
        const sort = list => list.map(shape).sort((a, b) => a.provider.localeCompare(b.provider) || (a.rate ?? 99) - (b.rate ?? 99))
        const pool = poolRows()
        return {
          free: sort(pool.filter(row => tierOf(row, options) === 'free')),
          low: sort(pool.filter(row => tierOf(row, options) === 'low')),
          high: sort(pool.filter(row => tierOf(row, options) === 'high')),
          custom: sort(pool),
        }
      })(),
    }
  }

  /**
   * 被淘汰的模型清单（实测吞吐低于门槛）。
   *
   * 取的是**候选池**与**速度画像**的交集：只有「在池里、且测出来慢」的才值得
   * 展示。链成员里本来就没有的（如上架前测过又下架的）不该出现在这里。
   */
  function droppedSnapshot() {
    const cut = Number(config.excludeBelowTps)
    if (!Number.isFinite(cut) || cut <= 0) return []
    const out = []
    for (const row of poolRows()) {
      if (!filterDropped([row], {
        excludeBelowTps: cut,
        speedMemoryMinutes: config.speedMemoryMinutes,
        slowMemoryMinutes: config.slowMemoryMinutes,
      }).length) {
        const speed = speedOf(row.id, { speedMemoryMinutes: config.speedMemoryMinutes })
        out.push({ id: row.id, tps: Number.isFinite(Number(speed?.tps)) ? Number(speed.tps) : null })
      }
    }
    // 最慢的排前面：用户想看的正是「哪些被砍了、有多慢」。
    return out.sort((a, b) => (a.tps ?? 999) - (b.tps ?? 999))
  }

  /**
   * 每条链的「快速档」：吞吐最高的前 N 个（真正参与轮换的那几个）。
   *
   * 用户要「能用到速度快的，也能分散到多个模型上」。页面上必须能看到这两个
   * 数字——`size` 是轮换窗口，`links` 是窗口内的成员。看不到就只能猜链到底
   * 会不会轮着用。
   */
  function fastBandSnapshot() {
    const size = Math.max(1, Math.trunc(Number(config.fastBandSize) || 1))
    const out = {}
    for (const key of ['free', 'low', 'high', 'custom']) {
      const list = tiers[key] ?? []
      out[key] = {
        size: Math.min(size, list.length),
        links: list.slice(0, size).map(row => ({
          id: row.id,
          tps: throughputOf(row.id, config.speedMemoryMinutes) ?? null,
          rate: row.rate ?? null,
        })),
      }
    }
    return out
  }

  /** 设置页读到的配置视图；Key 只回「有没有」。 */
  function viewConfig() {
    return {
      gatewayUrl: config.gatewayUrl,
      gatewayKey: config.gatewayKey === '' ? '' : '••••••',
      gatewayKeyConfigured: resolveGatewayKey(config.gatewayKey).key !== '',
      refreshMinutes: config.refreshMinutes,
      lowMaxRate: config.lowMaxRate,
      longContextMin: config.longContextMin,
      maxLinks: config.maxLinks,
      perProviderLinks: config.perProviderLinks,
      absurdRate: config.absurdRate,
      preferExpiringCredits: config.preferExpiringCredits !== false,
      expiringWindowDays: config.expiringWindowDays,
      expiryLookup: config.expiryLookup !== false,
      firstTokenTimeoutMs: config.firstTokenTimeoutMs,
      slowTtfbMs: config.slowTtfbMs,
      maxSlowSkips: config.maxSlowSkips,
      minTokensPerSecond: config.minTokensPerSecond,
      excludeBelowTps: config.excludeBelowTps,
      fastBandSize: config.fastBandSize,
      throughputBandTps: config.throughputBandTps,
      probeOnStartup: config.probeOnStartup !== false,
      startupProbeSkipMinutes: config.startupProbeSkipMinutes,
      accountExpiryFirst: config.accountExpiryFirst !== false,
      accountRotation: config.accountRotation !== false,
      accountReorderMinutes: config.accountReorderMinutes,
      speedSampleMs: config.speedSampleMs,
      slowMemoryMinutes: config.slowMemoryMinutes,
      speedMemoryMinutes: config.speedMemoryMinutes,
      preferMeasuredSpeed: config.preferMeasuredSpeed !== false,
      preferThroughput: config.preferThroughput !== false,
      expectedOutputTokens: config.expectedOutputTokens,
      autoProbeOnRefresh: config.autoProbeOnRefresh !== false,
      slowModels: slowSnapshot(),
      speedProfiles: speedSnapshot({ speedMemoryMinutes: config.speedMemoryMinutes }),
      /**
       * **被淘汰**的模型：实测吞吐低于门槛，已从所有链里移除。
       *
       * 单独回传而不是让页面自己从 `speedProfiles` 里筛，是为了让「淘汰线」
       * 只有一个权威来源——页面按同一份名单显示，不会出现「页面说淘汰了、
       * 链里还在」。
       */
      dropped: droppedSnapshot(),
      /** 每条链的「快速档」：真正参与轮换调用的那几个。 */
      fastBand: fastBandSnapshot(),
      /** 最近一次账号顺序重排的结果。 */
      accountPlan,
      customModels: config.customModels,
      /** Custom 是「跟随池子」还是「严格按勾选」；页面据此决定候选基准。 */
      customMode: config.customMode === 'explicit' ? 'explicit' : 'auto',
      membersFree: config.membersFree,
      membersLow: config.membersLow,
      membersHigh: config.membersHigh,
      verbose: config.verbose,
    }
  }


  /**
   * 探测范围：**候选池里去重后的全部模型**。
   *
   * 抽成函数是因为三个入口都要它：设置页的「测速 / 重测全部」、启动时的
   * 自动重测、以及将来的定时补充。三处各写一份必然漂移。
   */
  function probeTargets() {
    const seen = new Set()
    const list = []
    for (const row of allRows) {
      if (row.contextWindow < positive(config.longContextMin, DEFAULTS.longContextMin)) continue
      if (row.rate !== undefined && row.rate > positive(config.absurdRate, DEFAULTS.absurdRate)) continue
      const id = String(row.id ?? '').toLowerCase()
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      list.push({ id: row.id })
    }
    return list
  }

  /**
   * 每次启动后自动跑一次「重测全部」。
   *
   * ## 用户的要求
   *
   * 「每次开启软件就自动运行一次重测全部」——这样链里的吞吐排序、以及
   * 「低于 50 tok/s 的淘汰」在**当天第一次打开**时就是新鲜的，不用手动点。
   *
   * ## 为什么不会变成风控风险
   *
   * 探测本身已经按渠道分组、单账号串行、200–500ms 抖动（见 `runProbe`）：
   * 同时对同一账号只有一个请求在飞，这与「开一堆并发打同一个账号」是两类流量。
   * 另外这里还加了两道闸：
   *
   *   1. **上一轮测完不足 `startupProbeSkipMinutes` 就跳过**——反复开关软件
   *      不会反复全量探测，那才是真正会被看出规律的形态；
   *   2. 只在**首次分层成功之后**才启动，避免网关还没就绪时白测一堆超时。
   *
   * 探测在后台跑，不 await，不影响任何一次对话的延迟。
   */
  let startupProbeDone = false
  function startStartupProbe() {
    if (config.probeOnStartup === false) return
    if (startupProbeDone) return
    startupProbeDone = true
    const skipMs = Math.max(0, Number(config.startupProbeSkipMinutes) || 0) * 60_000
    const sinceLast = Date.now() - (probeState.finishedAt || 0)
    if (skipMs > 0 && probeState.finishedAt > 0 && sinceLast < skipMs) {
      log(`启动重测跳过：上一轮测速在 ${Math.round(sinceLast / 60_000)} 分钟前完成（窗口 ${Math.round(skipMs / 60_000)} 分钟）`)
      return
    }
    const { key } = resolveGatewayKey(config.gatewayKey)
    if (key === '') { log('启动重测跳过：没有网关 Key'); return }
    const list = probeTargets()
    if (list.length === 0) { log('启动重测跳过：候选池为空'); return }
    const base = text(config.gatewayUrl) || DEFAULTS.gatewayUrl
    log(`启动重测：${list.length} 个模型，后台进行`)
    void runProbe({
      list, base, key,
      /**
       * `force: true` 是「重测全部」的语义：连已有画像的也重测一遍，
       * 否则启动这道闸对老用户永远不生效（画像全都有，等于什么都不测）。
       */
      force: true,
      speedMemoryMinutes: config.speedMemoryMinutes,
      onProgress: (done, total) => { if (done % 25 === 0 || done === total) log(`启动重测 ${done}/${total}`) },
    }).then(result => {
      if (result.started === true) {
        log(`启动重测已开始（${result.total} 个模型）`)
        return
      }
      log(`启动重测未开始：${result.reason ?? '未知原因'}`)
    }).catch(error => logger.warn?.(`[baipiao] 启动重测失败（不影响调用）：${String(error?.message ?? error)}`))
  }

  /**
   * 首次刷新 + 有界重试。
   *
   * 插件挂载的时刻**早于**渠道包把网关拉起来：宿主启动时各 fiber 并行启动，
   * 我们的 `apply` 可能先跑，此时 `127.0.0.1:8326` 还没有监听。一次失败就
   * 永久空链，用户看到的是「链里没有可用模型」——这正是实测踩到的。
   *
   * 所以失败后按递增退避重试，成功一次就停。退避序列覆盖**约 100 秒**的
   * 启动窗口：实测网关从进程启动到开始监听需要十几秒到一分钟不等（取决于
   * 渠道包要登录多少个上游），早先的 2/5/10/20 秒累计只有 37 秒，经常还没等到
   * 网关起来就放弃了，用户看到的是空链。
   */
  let bootAttempt = 0
  const BOOT_DELAYS = [1000, 2000, 3000, 5000, 5000, 8000, 10000, 15000, 20000, 30000]
  async function bootRefresh() {
    // 先让渠道包把模型清单与倍率拉一遍，再分层——否则拿到的可能是上次
    // 进程留下的旧清单，倍率变了也不会反映。
    await primeUpstreamCatalog()
    const result = await refresh().catch(error => ({ ok: false, error: String(error?.message ?? error) }))
    if (result.ok === true) {
      /**
       * 成功就**重置退避计数**。
       *
       * 不重置会有个隐蔽后果：启动阶段若失败过几次、随后成功，计数仍停在高位；
       * 之后任何一次失败都会立刻「耗尽额度」直接放弃，而不是再退避重试。
       * 这正是实测踩到的——重启后网关晚一两秒就绪，分层空着等了 30 分钟。
       */
      bootAttempt = 0
      /**
       * 启动后延迟几秒再开始重测。
       *
       * 为什么不是立刻：`refresh` 刚结束，余额查询（异步）可能还在路上，
       * 而探测本身要占用网关与上游账号。错开 5 秒能让启动阶段的三股流量
       * （模型清单、余额、探测）不叠在一起——对风控更友好，也不影响分层。
       */
      const timer = setTimeout(() => { try { startStartupProbe() } catch { /* 探测失败不影响启动 */ } }, 5000)
      timer.unref?.()
      return
    }
    const delay = BOOT_DELAYS[bootAttempt]
    bootAttempt += 1
    if (delay === undefined) {
      logger.warn?.(`[baipiao] 启动阶段多次拉取失败，等下一轮定时刷新（${positive(config.refreshMinutes, DEFAULTS.refreshMinutes)} 分钟后）`)
      return
    }
    log(`首次拉取未就绪，${Math.round(delay / 1000)} 秒后重试`)
    const retry = setTimeout(() => { void bootRefresh() }, delay)
    retry.unref?.()
  }


  const membersOf = id => {
    if (id === CHAIN_IDS.free) return tiers.free
    if (id === CHAIN_IDS.low) return tiers.low
    if (id === CHAIN_IDS.high) return tiers.high
    if (id === CHAIN_IDS.custom) return tiers.custom
    return []
  }

  const labelOf = id => {
    const key = Object.keys(CHAIN_IDS).find(candidate => CHAIN_IDS[candidate] === id)
    return key === undefined ? id : CHAIN_LABELS[key]
  }

  /**
   * 展示能力：三条链现在都保证 1M，所以上下文取**实际最小值**（应当 ≥1M）；
   * 图片能力不再是链的属性——它随请求变化，因此这里报「部分支持」。
   */
  const capacityOf = list => ({
    contextWindow: list.length === 0 ? CONTEXT_DEFAULT : Math.min(...list.map(row => row.contextWindow)),
    vision: list.length > 0 && list.every(row => row.vision),
    anyVision: list.some(row => row.vision),
    maxOutput: 32768,
  })

  /**
   * 人类可读的上下文窗口。1M 写成「1M」而不是 977K——977 是 1000000/1024 的
   * 四舍五入，用户看到会以为不到 1M，而这条链的全部意义就是「够 1M」。
   */
  const humanContext = value => (value >= 1000000 ? `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`
    : `${Math.round(value / 1024)}K`)

  const describe = (id, list) => {
    const cap = capacityOf(list)
    const providers = [...new Set(list.map(row => row.provider))]
    const visionCount = list.filter(row => row.vision).length
    const isCustom = id === CHAIN_IDS.custom
    return [
      isCustom
        ? `${list.length} 个手动选择的模型`
        : `${list.length} 个候选，按顺序降级`,
      `上下文 ≥${humanContext(cap.contextWindow)}`,
      visionCount === 0 ? '纯文本'
        : visionCount === list.length ? '全部支持图片'
          : `${visionCount} 个支持图片（发图时自动只用它们）`,
      providers.length === 0 ? '暂无可用模型' : `渠道：${providers.join(' / ')}`,
    ].join(' · ')
  }

  /**
   * 四条链里**去重后**的候选总数。
   *
   * 自定义链与价格链可能重叠，所以不能简单相加——那会把同一个模型数两遍，
   * 用户看到的「可以调用」就虚高了。按模型 id 去重才是真正「有多少个模型能用」。
   */
  function countCallable(list) {
    const ids = new Set()
    for (const key of ['free', 'low', 'high', 'custom']) {
      for (const row of list[key] ?? []) ids.add(row.id)
    }
    return ids.size
  }

  function viewTiers() {
    const pick = list => list.map(row => ({
      id: row.id,
      rate: row.rate,
      provider: row.provider,
      vision: row.vision === true,
      expiringCredits: row.expiringCredits,
    }))
    return {
      free: pick(tiers.free),
      low: pick(tiers.low),
      high: pick(tiers.high),
      custom: pick(tiers.custom),
    }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: ROUTE_LABEL }
    },

    /**
     * 失败大多来自「这个渠道此刻不行」，重试同一模型意义不大——真正的重试
     * 是换链上的下一个。所以只留极少数瞬时错误码。
     */
    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
        initialDelayMs: 500,
        maxDelayMs: 4000,
        jitterRatio: 0.2,
      })
    },

    /** 没有厂商视觉计价协议时的同步估算。 */
    imageRequestPricing() {
      return {
        priceImages(images) {
          return images.map(image => image.offloaded === true
            ? { visualTokens: 0, text: '[image omitted]' }
            : { visualTokens: 1024, text: '[image]' })
        },
      }
    },

    async listModels(provider) {
      /**
       * 被用户关闭的链**不出现在选择器里**。
       *
       * 这是「点关闭就不再聚合」的落点：从 `listModels` 里过滤掉，选择器自然
       * 看不到它。`resolveModel` 仍然认得出它（见下），这样已经保存了该模型的
       * 会话不会因为解析失败而崩，只会拿到一个「这条链已关闭」的明确提示。
       */
      return Object.entries(CHAIN_IDS).map(([key, id]) => {
          const list = membersOf(id)
          const cap = capacityOf(list)
          return {
            provider,
            id,
            name: CHAIN_LABELS[key],
            description: describe(id, list),
            /**
             * 只要链里**有**能看图的模型就声明 image。
             *
             * 声明成交集（全部支持才声明）会让 harness 在发图前就把整条链判成
             * 「不支持图片」并直接拒绝——而我们真正想要的是「发图时自动只用
             * 那些能看图的候选」。所以这里用并集，筛选发生在 `candidatesFor`。
             */
            inputModalities: cap.anyVision ? ['text', 'image'] : ['text'],
          }
        })
    },

    async resolveModel(provider, model) {
      const list = membersOf(model)
      const cap = capacityOf(list)
      return {
        provider,
        id: model,
        name: labelOf(model),
        description: describe(model, list),
        inputModalities: cap.anyVision ? ['text', 'image'] : ['text'],
        context: { contextWindow: cap.contextWindow },
        defaultMaxTokens: cap.maxOutput,
      }
    },

    async prepareCall(provider, model) {
      const list = membersOf(model)
      return {
        model: await adapter.resolveModel(provider, model),
        stream: options => adapter.stream({ ...options, provider, model, __chain: list }),
      }
    },

    /**
     * 走链：逐个候选请求，**在第一个正文增量之前**失败就换下一个。
     * 一旦有正文交给调用方就不再切换，否则两个模型的文字会拼在一起。
     * 思考增量不算正文——想了很久才撞配额墙正是最值得降级的情形。
     *
     * 三个运行期调整（都不是静态分层能表达的）：
     *
     *   1. **带图片时只用能看图的候选**。图片是请求级属性，静态分层做不到；
     *      这里按本轮消息里有没有 image 块现算。
     *   2. **快速档内轮换起点**（`fastBandSize`）。永远从第一个开始会把用量全
     *      压在链首；整条链轮换又会轮到很慢的模型。只在「吞吐最高的前 N 个」
     *      里轮换，才是用户要的「用快的 + 不集中」。
     *   3. **请求期再淘汰一次**。`markSlow` 在流结束时写入，而分层最快也要等
     *      下一次 `refresh`（默认 30 分钟）；这中间用户还会被同一个慢模型反复
     *      拖慢。请求时再过滤一遍让它**下一次请求就消失**。
     */
    stream(options) {
      const list = options.__chain ?? membersOf(options.model)
      const candidates = candidatesFor(list, options.messages)
      /**
       * 请求期淘汰：与分层期同一判据（实测吞吐低于门槛），但不重新排序——
       * 顺序已经是分层时按吞吐排好的，这里只把「刚刚才被证明慢」的摘掉。
       */
      const usable = filterDropped(candidates, {
        speedMemoryMinutes: config.speedMemoryMinutes,
        slowMemoryMinutes: config.slowMemoryMinutes,
        excludeBelowTps: config.excludeBelowTps,
      })
      /**
       * 先把「实测慢」的候选沉到链尾，再决定起点。
       *
       * 为什么在请求时再降一次，而不是只依赖 `buildTiers` 里的那次：
       * `markSlow` 在流结束时写入，而分层最快也要等到下一次 `refresh`。
       * 代价是每个请求多一次 O(候选数) 的分组，实测链长 ≤40，可忽略。
       */
      const demoted = demoteSlow(usable, { slowMemoryMinutes: config.slowMemoryMinutes })
      const band = Math.trunc(Number(config.fastBandSize) || 0)
      // 四条链（含 custom）都用快速档轮换：只改变起点，不改变优先级/选择顺序。
      const ordered = rotate(demoted, options.model, band)
      return createChainStream({
        ctx, config, logger,
        list: ordered,
        model: options.model,
        options,
      })
    },
  }

  ctx.llm.registerAdapter([ROUTE], adapter)

  /**
   * 可选挂载：这两件事都不是本插件存在的理由，任何一个缺失或抛错都不能让
   * 整行加载失败——否则用户看到的是「插件不见了」，而不是「少了个能力」。
   */
  try {
    ctx.llm.registerConfigurableProviders?.([{
      provider: ROUTE,
      displayName: ROUTE_LABEL,
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
    }])
  } catch (error) {
    logger.warn?.(`[baipiao] 可配置 provider 声明失败（不影响模型可用）：${String(error?.message ?? error)}`)
  }

  // 首次拉取带退避重试：插件挂载通常早于渠道包把网关拉起来。
  void bootRefresh()

  const minutes = positive(config.refreshMinutes, DEFAULTS.refreshMinutes)
  if (minutes > 0) {
    timer = setInterval(() => { void refresh().catch(() => {}) }, minutes * 60_000)
    timer.unref?.()
  }

  try {
    ctx.effect(() => () => {
      if (timer !== undefined) clearInterval(timer)
    }, 'baipiao-stone: refresh loop')
  } catch {
    // 没有 effect 机制的组合里，定时器随进程结束即可。
  }

  // 只读诊断入口；不注册 HTTP 路由，避免与其它插件的信任围栏纠缠。
  try {
    ctx.set?.('baipiaoTiers', {
      status: () => ({ ...status }),
      tiers: viewTiers,
      refresh,
    })
  } catch { /* 诊断入口不是功能 */ }

  /**
   * 设置页的读写接口。
   *
   * 走 HTTP 前缀路由，不走 Typert Remote：Remote 需要在宿主侧再注册一份
   * 类型清单（`ctx.provide` + typert 注册），而那套清单在热升级时会缓存旧
   * 版本；前缀路由是 `our-free-model` 已经在用的稳定接口，重启即生效。
   *
   * 浏览器不能自己去请求 `127.0.0.1:8326`：那是另一个源，会被网关的信任
   * 围栏挡下；而且网关 Key 也不该出现在页面里。所以页面只跟宿主说话。
   *
   * 注册失败不是错误：没有 webServer 的组合里，设置页不会出现，三条链照常。
   */
  const saveConfig = patch => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('settings must be a JSON object'), { statusCode: 400 })
    }
    const next = { ...config }
    const numeric = ['refreshMinutes', 'lowMaxRate', 'longContextMin', 'maxLinks', 'perProviderLinks', 'absurdRate', 'expiringWindowDays', 'firstTokenTimeoutMs', 'slowTtfbMs', 'maxSlowSkips', 'minTokensPerSecond', 'excludeBelowTps', 'fastBandSize', 'throughputBandTps', 'startupProbeSkipMinutes', 'accountReorderMinutes', 'speedSampleMs', 'slowMemoryMinutes', 'speedMemoryMinutes', 'expectedOutputTokens']
    for (const key of numeric) {
      if (!Object.hasOwn(patch, key)) continue
      const raw = patch[key]
      if (raw === undefined || raw === null) { next[key] = DEFAULTS[key]; continue }
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) {
        throw Object.assign(new Error(`${key} must be a non-negative number`), { statusCode: 400 })
      }
      next[key] = value
    }
    if (Object.hasOwn(patch, 'gatewayUrl')) {
      const value = String(patch.gatewayUrl ?? '').trim()
      if (value !== '' && !/^https?:\/\//i.test(value)) {
        throw Object.assign(new Error('gatewayUrl must be an http(s) URL'), { statusCode: 400 })
      }
      next.gatewayUrl = value === '' ? DEFAULTS.gatewayUrl : value
    }
    if (Object.hasOwn(patch, 'gatewayKey')) next.gatewayKey = String(patch.gatewayKey ?? '').trim()
    if (Object.hasOwn(patch, 'verbose')) next.verbose = patch.verbose === true
    if (Object.hasOwn(patch, 'preferExpiringCredits')) next.preferExpiringCredits = patch.preferExpiringCredits === true
    if (Object.hasOwn(patch, 'expiryLookup')) next.expiryLookup = patch.expiryLookup === true
    if (Object.hasOwn(patch, 'preferMeasuredSpeed')) next.preferMeasuredSpeed = patch.preferMeasuredSpeed === true
    if (Object.hasOwn(patch, 'preferThroughput')) next.preferThroughput = patch.preferThroughput === true
    if (Object.hasOwn(patch, 'customMode')) {
      const mode = String(patch.customMode ?? '').trim().toLowerCase()
      if (mode !== 'auto' && mode !== 'explicit') {
        throw Object.assign(new Error('customMode must be "auto" or "explicit"'), { statusCode: 400 })
      }
      next.customMode = mode
    }
    if (Object.hasOwn(patch, 'autoProbeOnRefresh')) next.autoProbeOnRefresh = patch.autoProbeOnRefresh === true
    if (Object.hasOwn(patch, 'probeOnStartup')) next.probeOnStartup = patch.probeOnStartup === true
    if (Object.hasOwn(patch, 'accountExpiryFirst')) next.accountExpiryFirst = patch.accountExpiryFirst === true
    if (Object.hasOwn(patch, 'accountRotation')) next.accountRotation = patch.accountRotation === true
    if (Object.hasOwn(patch, 'primeUpstream')) next.primeUpstream = patch.primeUpstream === true
    // customModels 是字符串：用户用逗号/空格/分号分隔模型 id。保存前用 parse 归一化，
    // 让页面回显的是去重、小写后的规范形式。
    if (Object.hasOwn(patch, 'customModels')) {
      next.customModels = parseCustomModels(patch.customModels).join(', ')
    }
    // 关闭的链：只接受已知的链名，防止写入任意值。
    for (const key of ['membersFree', 'membersLow', 'membersHigh']) {
      if (Object.hasOwn(patch, key)) next[key] = parseCustomModels(patch[key]).join(', ')
    }

    // `config` 是 const 绑定，改写它的字段而不是重新赋值——闭包里的所有
    // 读取点（adapter、定时器、refresh）共享同一个对象。
    for (const key of Object.keys(config)) delete config[key]
    Object.assign(config, next)
    // 落盘：customModels 等设置必须活过重启。
    persistSettings(config)
    // 阈值或来源变了，立刻按新配置重算一次，页面随后读到的就是新结果。
    void refresh().catch(() => {})
    return viewConfig()
  }

  /**
   * 设置页用的 HTTP handler。
   *
   * 签名是 Node 原生的 `(req, res)`，**不是** Web 的 `Request/Response`——
   * `webServer.register` 把请求直接交给监听器，返回 Response 会被当成「没有
   * 应答」而由上层回一个空 400。这是实测踩到的第一个坑。
   */
  const api = async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/api\/baipiao-stone/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    }
    const readJson = () => new Promise(resolve => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        // 设置项都是小对象；超过 64 KiB 的一律当坏请求，避免把内存交给对方。
        if (size > 64 * 1024) { resolve(undefined); req.destroy(); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > 64 * 1024) { resolve(undefined); return }
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') { resolve({}); return }
        try { resolve(JSON.parse(text)) } catch { resolve(undefined) }
      })
      req.on('error', () => resolve(undefined))
    })

    try {
      if (method === 'GET' && route === '/state') return send(200, viewState())
      if (method === 'GET' && route === '/config') return send(200, viewConfig())
      /**
       * 诊断端点：看「落盘 / 载入 / 生效」三层的计数是否一致。
       *
       * 保留它是因为「设置不生效」这类问题无法从界面看出来——必须对比这三层
       * 才能定位是读取失败、被覆盖、还是没写盘。
       */
      if (method === 'GET' && route === '/diag') {
        const count = value => parseCustomModels(value).length
        return send(200, {
          settingsFile: settingsFile(),
          onDiskMembers: count(loadPersistedSettings().membersFree),
          loadedMembers: count(config.membersFree),
          custom: count(config.customModels),
        })
      }
      if (method === 'POST' && route === '/refresh') {
        await refresh()
        /**
         * 「立即重新分层」顺带补测**还没有速度数据**的模型。
         *
         * 用户诉求：点重新分层时，每个模型的速度都能显示出来，好挑快的。分层
         * 只按价格挑模型，速度必须实测——所以两件事在这里合并：分层完立刻开始
         * 探测缺失的部分。
         *
         * 只测缺失的（不 force）：重复测已有数据的模型既费额度又无新信息；想
         * 整体重测的用户可以点「重测全部」。
         *
         * 探测在后台跑（不 await），端点仍立刻返回；进度由页面轮询 /probe/status。
         */
        try {
          const { key } = resolveGatewayKey(config.gatewayKey)
          if (key !== '' && config.autoProbeOnRefresh !== false) {
            const base = text(config.gatewayUrl) || DEFAULTS.gatewayUrl
            const list = probeTargets()
            void runProbe({
              list, base, key, force: false,
              speedMemoryMinutes: config.speedMemoryMinutes,
              onProgress: (done, total) => { if (done % 25 === 0 || done === total) log(`自动测速 ${done}/${total}`) },
            }).then(result => {
              if (result.started === true) log(`重新分层后自动测速 ${result.total} 个模型`)
            }).catch(error => logger.warn?.(`[baipiao] 自动测速失败：${String(error?.message ?? error)}`))
          }
        } catch (error) {
          logger.warn?.(`[baipiao] 自动测速启动失败（不影响分层）：${String(error?.message ?? error)}`)
        }
        return send(200, viewState())
      }
      if (method === 'POST' && route === '/slow/clear') {
        clearSlowModels()
        return send(200, viewConfig())
      }
      /**
       * 启动速度探测（后台跑，立刻返回）。
       *
       * 探测近百个模型要一两分钟，**不能**让 HTTP 请求一直挂着——那样页面会
       * 转圈到超时，用户以为卡死了。所以这个端点只负责「开跑」就返回，进度由
       * 页面轮询 `/probe/status` 拿。
       *
       * `force: true` 表示连已有画像的也重测（用户想刷新数据）；默认只测没有
       * 数据的，避免重复消耗上游额度。
       */
      if (method === 'POST' && route === '/probe') {
        const patch = await readJson()
        const force = patch?.force === true
        const { key } = resolveGatewayKey(config.gatewayKey)
        if (key === '') return send(400, { error: '没有渠道网关 Key，无法探测' })
        const base = text(config.gatewayUrl) || DEFAULTS.gatewayUrl
        /**
         * 探测范围：**候选池里去重后的全部模型**（`probeTargets`）。
         *
         * 用候选池而不是某条链的成员——用户要的是「所有模型的速度，好让我挑
         * 快的」，而不是只测某条链里的。
         */
        const list = probeTargets()
        // 不 await：让它后台跑，端点立刻返回。
        void runProbe({
          list, base, key, force,
          speedMemoryMinutes: config.speedMemoryMinutes,
          onProgress: (done, total) => {
            if (done % 25 === 0 || done === total) log(`速度探测 ${done}/${total}`)
          },
        }).catch(error => logger.warn?.(`[baipiao] 速度探测失败：${String(error?.message ?? error)}`))
        return send(200, { started: true, candidates: list.length, ...probeSnapshot() })
      }
      /** 探测进度；页面轮询它来更新进度。 */
      if (method === 'GET' && route === '/probe/status') {
        return send(200, { ...probeSnapshot(), profiles: speedSnapshot({ speedMemoryMinutes: config.speedMemoryMinutes }) })
      }
      if (method === 'POST' && route === '/probe/stop') {
        stopProbe()
        return send(200, { ...probeSnapshot() })
      }
      /**
       * 切换某个模型在某条链里的勾选状态——**单模型粒度，自动保存**。
       *
       * 页面只提交「哪条链、哪个模型、勾还是取消」，服务端读改写该链的成员
       * 集合后立刻写盘。这样页面不必维护整套集合，也不会因为并发点击而丢失
       * 改动。
       *
       * 取消勾选**不删除**模型：它仍在候选池与 Custom 里，随时能再勾回来。
       * 这正是用户要的「取消后还是可见的，下次需要再勾选上」。
       */
      if (method === 'POST' && route === '/chain/toggle') {
        const patch = await readJson()
        if (patch === undefined) return send(400, { error: 'request body must be a JSON object' })
        const key = String(patch?.key ?? '').trim().toLowerCase()
        if (!Object.keys(CHAIN_IDS).includes(key)) {
          return send(400, { error: `unknown chain "${key}"` })
        }
        const id = String(patch?.id ?? '').trim().toLowerCase()
        if (id === '') return send(400, { error: 'model id is required' })

        const field = key === 'custom' ? 'customModels' : `members${key[0].toUpperCase()}${key.slice(1)}`
        /**
         * 初次勾选时的基准：用户还没动过这条链（字段为空）时，以**当前链的
         * 实际成员**为基准，否则以已保存的勾选为基准。
         *
         * 不加这一步会有个反直觉的后果：用户第一次只是「取消一个」，结果因为
         * 基准是空集，其余模型全被判成未勾选、整条链只剩取消后剩下的——
         * 看起来就像「点一下清空了大半条链」。
         */
        /**
         * 哨兵 `__none__` 只是「显式全不选」的标记，不是模型 id。
         *
         * 把它当基线带进勾选清单，会让配置变成 `"__none__, xxx"`——功能上
         * 还能跑（哨兵只在与整串相等时才生效），但落盘里留着一个永远不该
         * 出现的 id，下次读配置的人会被绊住。这里先剔掉它。
         */
        const stored = parseCustomModels(config[field]).filter(item => item !== NONE_SELECTED)
        /**
         * 「从 auto 切到 explicit」的这一次点击，基线必须是**当前链的成员**，
         * 而不是落盘里的那份旧清单。
         *
         * 旧版本 `customModels` 的语义是「排在最前面」，不是「只要这些」。升级
         * 后落盘里往往只剩一个 id，而 `customMode` 还不存在、默认 `auto`
         * ——此时链 = 候选池全集，看起来完全正常。
         *
         * 用户第一次点「取消某一个」时，若基线取那份只有 1 个 id 的旧清单，
         * 链会从全集**塌成 1 个**（其余模型看起来凭空消失）。所以切换的那一次
         * 取并集：旧清单 ∪ 当前实际成员。
         */
        const chainMembers = membersOf(CHAIN_IDS[key]).map(row => String(row.id ?? '').toLowerCase())
        const switchingToExplicit = key === 'custom' && config.customMode !== 'explicit'
        const baseline = switchingToExplicit
          ? [...new Set([...stored, ...chainMembers])]
          : (stored.length > 0 ? stored : chainMembers)
        const next = patch.checked === true
          ? [...baseline, id]
          : baseline.filter(item => item !== id)
        config[field] = parseCustomModels(next).join(', ')
        /**
         * Custom 只要被用户动过一次，就切到 `explicit`。
         *
         * 这是「取消某个模型没用」的根因修法：auto 会把候选池里没列出的模型
         * 补回来，于是取消动作被无声撤销。切到 explicit 后，链严格等于这份
         * 清单，取消就是真的取消。
         */
        if (key === 'custom') config.customMode = 'explicit'
        persistSettings(config)
        void refresh().catch(() => {})
        try { ctx.emit('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }
        log(`${CHAIN_LABELS[key]}：${id} ${patch.checked === true ? '已勾选' : '已取消'}`)
        return send(200, viewConfig())
      }
      /**
       * 整条链全选 / 全不选——链头部那个复选框的落点。
       *
       * 全选写空串：空串在本插件里的语义是「用自动分层的全部候选」，等价于
       * 全选，而且以后新上架的模型会自动进来（比写死一份 id 快照更好）。
       */
      if (method === 'POST' && route === '/chain/all') {
        const patch = await readJson()
        if (patch === undefined) return send(400, { error: 'request body must be a JSON object' })
        const key = String(patch?.key ?? '').trim().toLowerCase()
        if (!Object.keys(CHAIN_IDS).includes(key)) {
          return send(400, { error: `unknown chain "${key}"` })
        }
        const field = key === 'custom' ? 'customModels' : `members${key[0].toUpperCase()}${key.slice(1)}`
        /**
         * 带 `ids` 时是**集合操作**，不是整链置位。
         *
         * 这是搜索批量勾选的落点：页面把筛出来的那几个 id 传上来，这里只对
         * 它们做「加入 / 移出」，链里其它成员原样不动。
         *
         * 为什么不能在前端用多次 /chain/toggle 模拟：N 次请求、N 次落盘、
         * N 次 refresh，慢且中途失败会留下半套状态。
         */
        const subset = Array.isArray(patch?.ids)
          ? [...new Set(patch.ids.map(id => String(id ?? '').trim().toLowerCase()).filter(id => id !== ''))]
          : null
        if (subset !== null) {
          if (subset.length === 0) return send(400, { error: 'ids must not be empty' })
          /**
           * 基线：主清单（未动过 / 全选）视为「候选池全集」，这样从池里移出
           * 几个是「全集减几」而不是「只剩这几个」——直接拿空串当基线会把
           * 其余模型意外清掉，正是搜索批量操作最容易踩的坑。
           */
          const stored = parseCustomModels(config[field]).filter(item => item !== NONE_SELECTED)
          const declared = String(config[field] ?? '').trim()
          const baselineSet = new Set(
            declared === '' || declared.toLowerCase() === NONE_SELECTED
              ? poolRows().map(row => String(row.id ?? '').toLowerCase())
              : stored,
          )
          for (const id of subset) {
            if (patch.checked === true) baselineSet.add(id)
            else baselineSet.delete(id)
          }
          /**
           * 集合操作后必须落到 explicit。
           *
           * 对 Custom 来说，auto 模式会忽略清单、把整个池子补回来——那样
           * 「取消」永远无效。所以只要用户用复选框动过，就固定为 explicit。
           * 空集合写成哨兵，保住「我就要一条空链」的语义。
           */
          config[field] = baselineSet.size === 0 ? NONE_SELECTED : [...baselineSet].join(', ')
          if (key === 'custom') config.customMode = 'explicit'
          persistSettings(config)
          void refresh().catch(() => {})
          try { ctx.emit('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }
          log(`${CHAIN_LABELS[key]} 批量${patch.checked === true ? '选中' : '取消'} ${subset.length} 个`)
          return send(200, viewConfig())
        }
        if (patch.checked === true) {
          config[field] = ''
          /**
           * Custom 的「全选」= 回到 auto：候选池全集，新上架的自动进来。
           * 这是唯一会让 Custom 重新变回「跟随池子」的动作。
           */
          if (key === 'custom') config.customMode = 'auto'
        } else {
          // 全不选：空串有「全选」语义，所以写显式哨兵。
          config[field] = NONE_SELECTED
          /**
           * Custom 的「全不选」= explicit + 空清单。
           *
           * 关键：**链空了，但候选模型一个都不能消失**。设置页的列表来自
           * `eligible.custom` 的候选池，与链成员无关，所以取消全部勾选后模型
           * 仍然逐个列着，用户可以自己再挑回来。
           */
          if (key === 'custom') config.customMode = 'explicit'
        }
        persistSettings(config)
        void refresh().catch(() => {})
        try { ctx.emit('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }
        log(`${CHAIN_LABELS[key]} 已${patch.checked === true ? '全选' : '全不选'}`)
        return send(200, viewConfig())
      }
      if (method === 'POST' && route === '/config') {
        const patch = await readJson()
        if (patch === undefined) return send(400, { error: 'request body must be a JSON object' })
        return send(200, saveConfig(patch))
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
      return send(status, { error: String(error?.message ?? error) })
    }
  }

  try {
    ctx.inject(['webServer'], scoped => {
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix',
        path: '/api/baipiao-stone',
        handler: api,
      }), 'baipiao-stone: api routes')

      /**
       * 记下本机端口，供 `channelRpc` 使用。
       *
       * `webServer` 的地址字段在不同内核版本里叫法不同，所以逐个试；都拿不到
       * 就保持 0——那时余额查询会降级为「未知」，三条链照常工作。
       */
      try {
        const server = scoped.webServer
        const candidate = server.port ?? server.address?.()?.port ?? server.info?.()?.port ?? 0
        const port = Number(candidate)
        if (Number.isInteger(port) && port > 0) webPort.value = port
      } catch { /* 端口拿不到就降级 */ }

      // 端口可能晚于注册才绑定：再探一次，仍然拿不到就等下一轮刷新时用默认值。
      if (webPort.value === 0) {
        const timer = setTimeout(() => {
          try {
            const server = scoped.webServer
            const candidate = server.port ?? server.address?.()?.port ?? server.info?.()?.port ?? 0
            const port = Number(candidate)
            if (Number.isInteger(port) && port > 0) {
              webPort.value = port
              void refresh().catch(() => {})
            }
          } catch { /* ignore */ }
        }, 3000)
        timer.unref?.()
      }
    })
  } catch (error) {
    logger.warn?.(`[baipiao] 设置页接口注册失败（不影响三条链）：${String(error?.message ?? error)}`)
  }

  /**
   * 把默认选中的模型指向「白嫖 · 免费」。
   *
   * 为什么不是「让 provider 排到选择器最前」：选择器的分组顺序就是
   * `ctx.llm.listProviders()` 的**注册顺序**，而内核自带的 `deepseek-account`
   * 在 bundle 第 70 行就注册了，任何插件都排不到它前面。能改的是「打开时默认
   * 选中哪个」——那才是用户实际感知的「一进来就是它」。
   *
   * 只在用户还没选过模型时设一次：覆盖用户主动选过的模型，比多一次点击更烦人。
   */
  try {
    const defaultModel = ctx.get?.('agentDefaultModel')
    if (defaultModel !== undefined && typeof defaultModel.select === 'function') {
      const current = defaultModel.currentSelection?.()
      if (current === undefined || current === null || current.provider === undefined) {
        defaultModel.select({ provider: ROUTE, model: CHAIN_IDS.free })
        log(`默认模型已设为 ${ROUTE}/${CHAIN_IDS.free}`)
      }
    }
  } catch (error) {
    logger.warn?.(`[baipiao] 设置默认模型失败（不影响使用）：${String(error?.message ?? error)}`)
  }

  /**
   * 进程退出前落盘。
   *
   * `exit` 只允许同步操作，而 `flushSpeedMemoryNow` 正是同步写文件，所以适合
   * 挂在这里。`beforeExit` 覆盖正常退出（事件循环排空），`exit` 覆盖显式
   * `process.exit()`。重复挂载（热重载）时监听器会被重复添加，所以用一个模块
   * 级标记确保只挂一次。
   */
  if (!processExitHookInstalled) {
    processExitHookInstalled = true
    const flush = () => { try { flushSpeedMemoryNow() } catch { /* 退出路径不抛错 */ } }
    process.once?.('beforeExit', flush)
    process.once?.('exit', flush)
  }

  logger.info?.(`[baipiao] 已挂载：provider "${ROUTE}"，网关 ${config.gatewayUrl}，每 ${minutes} 分钟重新分层`)
}

/**
 * 一条链的执行器。切换判定只在这里，避免 prepareCall 与 stream 各写一份。
 * `held` 缓冲保证未提交的候选不泄漏给调用方。
 */
async function* createChainStream({ ctx, config, logger, list, model, options }) {
  const signal = options.signal
  if (list.length === 0) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: `链 ${model} 当前没有可用模型（网关未就绪或分层为空）`, code: 'UNAVAILABLE' } } }
    return
  }
  const { key } = resolveGatewayKey(config.gatewayKey)
  if (key === '') {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '没有渠道网关 Key，无法调用白嫖模型', code: 'MISSING_CREDENTIAL' } } }
    return
  }
  const base = text(config.gatewayUrl) || DEFAULTS.gatewayUrl
  const body = toChatBody(options)
  const tried = []
  /**
   * 本次请求已因「首字太慢」放弃的候选数。
   *
   * 超过 `maxSlowSkips` 之后不再启用首字超时：继续放弃只会把时间浪费在
   * 连续重试上（实测 8 个候选 × 3 秒 = 24 秒），不如让当前候选跑完。
   */
  let slowSkips = 0
  const maxSkips = Math.max(0, Math.trunc(Number(config.maxSlowSkips ?? DEFAULTS.maxSlowSkips) || 0))

  for (const candidate of list) {
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
      return
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    let committed = false
    /**
     * 首字超时。
     *
     * 实测某些「重思考」模型会在正文之前先想 9 秒以上（`workbuddy/hy4-preview-f`
     * 实测首字 11.6 秒，其中 9.4 秒在思考）。这段时间里用户什么都看不到，
     * 而我们明明可以换一个 2 秒内就开始作答的模型。
     *
     * 计时从**请求发出**开始，覆盖「排队 + 思考」，因为用户感知的等待就是
     * 从点下发送到看见第一个字。到点还没正文就中止，换下一个。
     *
     * `firstTokenTimeoutMs = 0` 表示不限制（回到旧行为：一直等）。
     */
    const startedAt = Date.now()
    const ttfbLimit = Number(config.firstTokenTimeoutMs)
    const ttfbEnabled = Number.isFinite(ttfbLimit) && ttfbLimit > 0
    /** 这次中止是不是首字超时造成的——决定要不要记「启动慢」。 */
    let ttfbAborted = false
    let ttfbTimer = null
    // 放弃额度用尽后就不必再挂超时：让这个候选跑完，别再刷新一个 3 秒的代价。
    const ttfbActive = ttfbEnabled && slowSkips < maxSkips
    if (ttfbActive) {
      ttfbTimer = setTimeout(() => {
        if (committed) return
        ttfbAborted = true
        controller.abort()
      }, ttfbLimit)
      ttfbTimer.unref?.()
    }
    const clearTtfbTimer = () => { if (ttfbTimer !== null) { clearTimeout(ttfbTimer); ttfbTimer = null } }

    let response
    try {
      response = await fetch(`${base.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ ...body, model: candidate.id }),
        signal: controller.signal,
      })
    } catch (error) {
      clearTtfbTimer()
      signal?.removeEventListener('abort', onAbort)
      /**
       * 超时如果在**响应头到达之前**就触发，`fetch` 会以 AbortError 失败，
       * 而不是进入下面的流读取。这时同样要归因于「首字超时」：记慢、计数，
       * 否则这个候选被白白放弃，既不降级也不消耗放弃额度。
       */
      if (ttfbAborted) {
        slowSkips += 1
        markSlow(candidate.id)
        tried.push(`${candidate.id}: 首字超过 ${Math.round(ttfbLimit / 1000)} 秒未出现（连接阶段）`)
        logger?.warn?.(`[baipiao] ${candidate.id} 连接阶段首字超时（${Math.round(ttfbLimit / 1000)}s），已换下一个（本次已放弃 ${slowSkips}/${maxSkips}）`)
        continue
      }
      tried.push(`${candidate.id}: ${String(error?.message ?? error)}`)
      continue
    }

    if (!response.ok || response.body === null) {
      clearTtfbTimer()
      const detail = await response.text().catch(() => '')
      signal?.removeEventListener('abort', onAbort)
      /**
       * 400 时把出问题的请求体转储下来。
       *
       * 「assistant.tool_calls contains an invalid function call」这类错误无法
       * 从上游消息反推出到底哪条历史不对——必须看真正发出去的 body。转储只在
       * 400/422 时发生，写到 ~/.dsh/dsh-baipiao-stone/last-request.json。
       */
      if (response.status === 400 || response.status === 422) {
        try {
          const dumpPath = path.join(dshHome(), 'dsh-baipiao-stone', 'last-request.json')
          fs.mkdirSync(path.dirname(dumpPath), { recursive: true })
          fs.writeFileSync(dumpPath, JSON.stringify({
            at: new Date().toISOString(),
            model: candidate.id,
            status: response.status,
            error: detail,
            body: { ...body, model: candidate.id },
          }, null, 2), 'utf8')
        } catch { /* 转储失败不影响主流程 */ }
      }
      tried.push(`${candidate.id}: HTTP ${response.status} ${detail.slice(0, 100)}`)
      continue
    }

    /** 这一轮到底产出了什么，决定「空响应」是不是该换下一个。 */
    let sawReasoning = false
    let finishKind = ''
    const held = []
    /**
     * 速度采样状态。
     *
     * 只有**正文**计入速度：思考阶段的 token 不算，否则一个想很久但答得快的
     * 模型会被误判成慢。`firstTextAt` 是第一个正文字符到达的时刻，那之前的
     * 等待属于首字延迟，由首字超时单独管。
     */
    const speed = { chars: 0, firstTextAt: 0, tooSlow: false }
    const minTps = Number(config.minTokensPerSecond)
    const sampleMs = positive(config.speedSampleMs, DEFAULTS.speedSampleMs)
    const speedEnabled = Number.isFinite(minTps) && minTps > 0

    try {
      for await (const chunk of decodeChatSse(response, controller.signal)) {
        if (chunk.type === 'reasoning-delta') sawReasoning = true
        if (chunk.type === 'finish') finishKind = chunk.reason?.kind ?? ''
        if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') {
          // 正文一开始，首字计时就没意义了。
          clearTtfbTimer()
          committed = true
          const now = Date.now()
          if (speed.firstTextAt === 0) speed.firstTextAt = now
          if (chunk.type === 'text-delta') speed.chars += String(chunk.text ?? '').length

          /**
           * 速度判定：观察窗口够长才下结论。
           *
           * 一旦判定为慢，**立刻中止这个候选**并换下一个——用户的诉求是
           * 「不要慢，直接换」。已经流出的正文会被丢弃（还在 `held` 里，
           * 尚未交给调用方），所以切换对调用方仍然不可见。
           */
          if (speedEnabled && !speed.tooSlow) {
            const elapsed = now - speed.firstTextAt
            if (elapsed >= sampleMs) {
              const tps = estimateTps(speed.chars, elapsed)
              if (tps > 0 && tps < minTps) {
                speed.tooSlow = true
                controller.abort()
                break
              }
            }
          }
        }
        if (committed) {
          if (held.length > 0) {
            for (const pending of held.splice(0)) yield pending
          }
          yield chunk
        } else {
          held.push(chunk)
        }
      }
    } catch (error) {
      clearTtfbTimer()
      // 首字超时：这是我们主动放弃，不是上游故障。记「启动慢」并换下一个。
      if (ttfbAborted) {
        signal?.removeEventListener('abort', onAbort)
        slowSkips += 1
        markSlow(candidate.id)
        tried.push(`${candidate.id}: 首字超过 ${Math.round(ttfbLimit / 1000)} 秒未出现`)
        logger?.warn?.(`[baipiao] ${candidate.id} 首字超时（${Math.round(ttfbLimit / 1000)}s），已换下一个（本次已放弃 ${slowSkips}/${maxSkips}）`)
        continue
      }
      // 速度判定主动 abort 时，错误是预期的，不算候选故障之外的失败。
      if (speed.tooSlow) {
        signal?.removeEventListener('abort', onAbort)
        markSlow(candidate.id)
        tried.push(`${candidate.id}: 速度低于 ${minTps} tok/s`)
        logger?.warn?.(`[baipiao] ${candidate.id} 速度不达标，已换下一个`)
        continue
      }
      signal?.removeEventListener('abort', onAbort)
      if (committed) {
        for (const pending of held) yield pending
        yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error?.message ?? error), code: 'STREAM_CUT' } } }
        return
      }
      tried.push(`${candidate.id}: ${String(error?.message ?? error)}`)
      continue
    }
    signal?.removeEventListener('abort', onAbort)
    clearTtfbTimer()

    /**
     * 首字延迟记录。
     *
     * 首字慢的模型这次虽然答出来了，但用户为它多等了几秒。记成「启动慢」，
     * 下一轮它会排到链尾——这正是「我要的是干活速度」的落点：慢一次就被
     * 降级，而不是每次都要重新忍受。
     *
     * 只在正文确实产出时才有 `firstTextAt`；空响应走下面的分支。
     */
    const ttfb = speed.firstTextAt > 0 ? speed.firstTextAt - startedAt : 0
    const slowTtfb = Number(config.slowTtfbMs)
    if (ttfb > 0 && Number.isFinite(slowTtfb) && slowTtfb > 0 && ttfb > slowTtfb) {
      markSlow(candidate.id)
      tried.push(`${candidate.id}: 首字 ${ttfb}ms 偏慢`)
      logger?.warn?.(`[baipiao] ${candidate.id} 首字 ${ttfb}ms 超过 ${slowTtfb}ms，已记为启动慢`)
    }

    /**
     * 流结束后的补判。
     *
     * 只在增量途中判定是不够的：实测一个短回答可能「首字等 4 秒、正文 0.8 秒
     * 就吐完」，正文窗口根本没跨过 `sampleMs`，于是永远走不到判定分支——而
     * 这恰恰是最该被判定的一类（用户感受是「等了 5 秒才看到答案」）。
     *
     * ## 判据：看字符数，不看毫秒数
     *
     * 需要**足够多的字符**才下结论：
     *
     *   - 字符太少时，几毫秒的抖动就能把速度算成任意值，结论不可靠；
     *   - 字符够了，就用「字符数 / 实际耗时」判——哪怕整个回答只花了 150ms，
     *     32 个字符在 147ms 内出完也意味着约 72 tok/s，这个判断有意义。
     *
     * 之前用「耗时 ≥ sampleMs/2」作门槛，导致快速完成的短回答被整体跳过：
     * 实测 147ms / 32 字符的情况一次都没被判过。
     *
     * 计时从**首个正文字符**开始，不含首字延迟：首字慢是另一种问题（排队 /
     * 思考），不该混进吞吐判定，否则正常速度但首字慢的模型会被误杀。
     */
    if (speedEnabled && !speed.tooSlow && speed.firstTextAt > 0
      && speed.chars >= MIN_SPEED_SAMPLE_CHARS) {
      const elapsed = Math.max(1, Date.now() - speed.firstTextAt)
      const tps = estimateTps(speed.chars, elapsed)
      if (tps > 0 && tps < minTps) speed.tooSlow = true
    }

    if (speed.tooSlow) {
      markSlow(candidate.id)
      tried.push(`${candidate.id}: 速度低于 ${minTps} tok/s`)
      logger?.warn?.(`[baipiao] ${candidate.id} 速度不达标，已换下一个`)
      continue
    }

    if (!committed) {
      /**
       * 没有正文有两种截然不同的原因，不能一概当作「这个模型坏了」：
       *
       * - `max-tokens`：预算被思考阶段吃光了。模型本身是好的，换下一个大概率
       *   会重演同一幕（同一条链的预算一样小），但**也可能**换到一个不怎么
       *   思考的模型就答出来了。所以换下一个，同时把原因记清楚。
       * - 其它（`stop` 等）：真的什么都没说。这是上游的毛病，直接换。
       *
       * 两种情况都不把已产生的思考帧交给调用方——一旦交了，这一轮就锁死在
       * 这个模型上了，而这正是最该降级的场景。
       */
      /**
       * 空响应也记一笔「慢画像」。
       *
       * 实测最坏的情况不是慢，而是**慢且失败**：`workbuddy/hy4-preview-f`
       * 花了 20.8 秒才返回空。如果不记下来，下一轮它还会排在最前，用户再等
       * 20 秒。这里给它一个很大的 ttfb（等于实际等待），让速度排序把它沉下去。
       */
      recordSpeed(candidate.id, { ttfb: Date.now() - startedAt, tps: 0 })
      markSlow(candidate.id)
      tried.push(`${candidate.id}: ${sawReasoning ? '只思考未作答' : '空响应'}（${finishKind || '无结束原因'}）`)
      continue
    }
    /**
     * 这一轮答完了——记录速度画像，并清掉它的慢记录。
     *
     * ## 画像记什么
     *
     * `ttfb`（首字延迟）与 `tps`（正文吞吐）分别记录：
     *
     *   - 首字延迟就是用户实际等待的秒数，是体感的大头；
     *   - 吞吐决定「看到第一行之后，剩下的还要等多久」。
     *
     * 两者都只在这一轮**确实产出了正文**时才记——空响应/只思考不记。
     */
    if (speed.chars > 0) {
      const genMs = Math.max(1, Date.now() - speed.firstTextAt)
      recordSpeed(candidate.id, {
        ttfb: speed.firstTextAt - startedAt,
        tps: estimateTps(speed.chars, genMs),
      })
    }
    if (!speedEnabled || speed.chars === 0) {
      markFast(candidate.id)
    } else {
      const genMs = Math.max(1, Date.now() - speed.firstTextAt)
      if (estimateTps(speed.chars, genMs) >= minTps) markFast(candidate.id)
    }
    for (const pending of held) yield pending
    return
  }

  logger?.warn?.(`[baipiao] 链 ${model} 全部候选失败：${tried.slice(0, 5).join(' | ')}`)
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: `链 ${model} 的 ${list.length} 个候选全部失败：${tried.slice(0, 3).join(' | ')}`,
        code: 'ALL_CANDIDATES_FAILED',
      },
    },
  }
}

export default { name, inject, apply, Config }
