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
  minTokensPerSecond: 85,
  /**
   * 吞吐淘汰线（tokens/s）：实测低于它的模型**不进入任何链**。
   *
   * ## 与 `minTokensPerSecond` 的区别（两者必须分开）
   *
   *   - `minTokensPerSecond` 是**请求期**判定：这一次流出来的正文太慢，就中止
   *     当前候选、换下一个。它只影响「这一轮」。
   *   - `excludeBelowTps` 是**分层期**判定：模型被实测证明「就是慢」，那么它
   *     连候选都不该当——用户明确要求「低于线的直接取消选择，不进组合模型」。
   *
   * 两条一起用才是完整语义：慢的模型既不该被排到前面，也不该占着候选名额在
   * 链尾兜底——兜底一次就要用户多等十几秒。
   *
   * ## 为什么默认是 85
   *
   * 用户的经验值：低于 85 tok/s 的模型在真实长回答里已经能明显感到卡顿
   * （按 800 字输出算，85 tok/s 约 9.4 秒写完；50 tok/s 要 16 秒）。85 是
   * 「还能忍」的下界，而不是「够快」的标准——真正的快慢排序仍由吞吐分档做。
   *
   * 0 = 关闭淘汰（只排序、不删除）。**没有实测数据的模型不会被淘汰**：淘汰的
   * 前提是「测出来慢」，而不是「还没测」——否则启动瞬间所有模型都会被清空。
   */
  excludeBelowTps: 85,
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
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { profiles: {}, slow: {}, lastProbeAt: 0 }
    return {
      profiles: parsed.profiles !== null && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      slow: parsed.slow !== null && typeof parsed.slow === 'object' ? parsed.slow : {},
      /**
       * 上一轮探测**完成**的时刻。
       *
       * 必须落盘：启动跳过窗口（`startupProbeSkipMinutes`）的判据是它，而它
       * 早先只存在于进程内存里——冷启动时恒为 0，`sinceLast` 等于当前时间戳
       * （约三千万分钟），**跳过窗口永远不命中**。于是「反复开关软件不会反复
       * 全量探测」这条承诺完全不成立，每次启动都无条件打近百个请求。
       */
      lastProbeAt: Number.isFinite(Number(parsed.lastProbeAt)) ? Number(parsed.lastProbeAt) : 0,
    }
  } catch {
    return { profiles: {}, slow: {}, lastProbeAt: 0 }
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

/**
 * 把「勾选集合」编码成配置字段的值——**空集合必须写成哨兵**。
 *
 * ## 为什么需要这个函数
 *
 * 本插件里空串有一个特殊含义：**「用户还没动过这条链」→ 用自动分层的全部
 * 候选**。它等价于「全选」。所以「我就要一条空链」不能用空串表示，必须用
 * `__none__` 哨兵。
 *
 * 这个区别极易写错。实测踩过：用户在设置页取消链里**最后一个**勾选成员，
 * 代码把空集合 `join(', ')` 成 `''` 写回，语义立刻反转成「没动过」→ 自动
 * 分层把整档候选全部填回链里——「取消最后一个 = 恢复全部」。用户完全无法
 * 把某条价格链清空，除非碰巧用「全不选」按钮走了另一个分支。
 *
 * 现在三处写回（`/chain/toggle`、`/chain/all`、`saveConfig`）都必须经过这里，
 * 从结构上消除漂移的可能。
 *
 * @param {Iterable<string>} ids
 * @returns {string} 逗号分隔的规范形式；空集合返回 `__none__`
 */
export function encodeMembers(ids) {
  const list = parseCustomModels([...ids].join(', '))
  return list.length === 0 ? NONE_SELECTED : list.join(', ')
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
        /**
         * `known: false` 表示**这个账号的余额查不到**（渠道包回了
         * `balance: null` + `error`，例如凭据失效）。
         *
         * 必须与「余额确实是 0」区分开：`planAccountOrder` 靠这个标记把它归到
         * 「未知」（夹在中间），而不是当成「只有长期积分」压到最后——后者会让
         * 一个可能还能用的账号永远排不上，而用户没有任何线索。
         */
        const known = account?.balance !== null && account?.balance !== undefined
        perAccount.push({
          accountId: account.accountId,
          nickname: typeof account.nickname === 'string' ? account.nickname : '',
          total: accountTotal,
          expiring: accountExpiring,
          nearestEnd,
          known,
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
  /** 没有 id 的账号：不能丢（否则 ordered 会比 accounts 短，reorder 必被拒）。 */
  const idless = []
  /** 停用账号：仍然排进 ordered，但**不参与轮换**。 */
  const disabled = []
  const enabledById = new Map()
  for (const account of accounts) {
    const id = String(account?.id ?? '')
    if (typeof account?.enabled === 'boolean') enabledById.set(id, account.enabled)
    if (id === '') { idless.push(account); continue }
    const balance = byId.get(id)
    /**
     * 余额**查询失败**（渠道包返回 `balance: null` + `error`）与「真的没有余额」
     * 必须分开：前者是「不知道」，按 README 的承诺要夹在中间，不能被压到最后。
     * 判据看显式标记而不是数值猜测——`known === false` 由 `annotateExpiry` 打上。
     */
    if (options.expiryFirst === false || balance === undefined || balance.known === false) {
      unknown.push(id)
      continue
    }
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
   * 除到期组之外的那些账号：合并成一个序列后轮换。
   *
   * 为什么合并而不是两组各自旋转：渠道包只关心「谁是第一个」，分组内部各转
   * 各的会让「未知」那一组永远压在「长期」之前——而它们其实同样该被轮换到。
   *
   * ## 轮换起点用「相对前移一位」，不用绝对游标
   *
   * ## 曾经踩的坑（必须留档）
   *
   * 渠道包的选号顺序就是**我们写回去的那个数组**。所以下一轮读回来的 `rest`
   * 已经被上一轮旋转过了。此时再按「绝对游标 0,1,2,3…」去旋转它，起点会落在
   * **三角数** `0,1,3,6,10,15…` 上，而不是 `0,1,2,3…`：
   *
   *   n=11 → 只有 6 个账号能当首位，另外 5 个**永远轮不到**（实测复现）；
   *   n=9  → 4 个；n=10 → 6 个。
   *
   * 这与「不要集中用几个账号」正好相反，而且因为渠道包只取「第一个可用账号」，
   * 被跳过的那几个就是彻底不用。
   *
   * 修法：**每次只相对前移一位**（起点恒为 1）。因为输入已经是上一轮的输出，
   * 「相对前移一位」等价于绝对意义上的逐个推进，n 轮刚好遍历全部 n 个。
   *
   * ## 停用账号不占位置
   *
   * 停用账号仍留在 `ordered` 里（`account.reorder` 要求集合不变），但排在最后
   * 且**不参与取模**——否则它会白白消耗一个轮换位，让实际用量在剩下的账号里
   * 偏斜（3 个账号停 1 个时，一个账号的出现频率会是另一个的 2 倍）。
   */
  const rest = [...unknown, ...lasting]
  const rotatable = rest.filter(id => enabledById.get(id) !== false)
  const restDisabled = rest.filter(id => enabledById.get(id) === false)
  disabled.push(...restDisabled)
  const rotationOn = options.rotation !== false
  /**
   * 用「稳定的基准序」而不是「上一轮写回的顺序」来做轮换。
   *
   * 这是比「相对前移」更稳的写法：把 rest 按 id 排序作为基准，游标在其中
   * 逐个推进。这样即使写回失败、账号增删、或上一轮被手工改过顺序，轮换仍然
   * 完整覆盖所有账号，不会跳位。
   *
   * 例外：用户有没有手工排过序？渠道包的 `account.reorder` 顺序可能来自用户
   * 拖拽。用 id 基准会覆盖那个意图——但「分散用量」是用户明确要求的规则，
   * 且到期优先那一层仍然保留用户可观察的语义，所以这里选规则优先。
   */
  const baseline = rotatable.slice().sort((a, b) => a.localeCompare(b))
  let start = 0
  if (baseline.length > 1 && rotationOn) {
    start = (accountCursor.get(provider) ?? 0) % baseline.length
    accountCursor.set(provider, (start + 1) % baseline.length)
  } else if (baseline.length > 0) {
    accountCursor.set(provider, 0)
  }
  const rotated = baseline.length === 0
    ? baseline
    : [...baseline.slice(start), ...baseline.slice(0, start)]

  return {
    /**
     * 该渠道的完整账号顺序（渠道包会按这个顺序选号）。
     *
     * 分层：到期优先 → 可轮换（本轮起点在前的环形序）→ 停用账号 → 无 id 条目。
     * 长度恒等于 `accounts.length`，满足 `account.reorder` 的「集合不可变」校验。
     */
    ordered: [...expiring, ...rotated, ...disabled, ...idless],
    /** 快到期、需要先用掉的账号（排在 `ordered` 最前面）。 */
    expiring,
    /** 本轮轮换起点落在基准序的第几位；0 表示没有轮换。 */
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
    /**
     * ## 0 值必须表示「关闭」，不能被默认值顶回去
     *
     * `slowTtfbMs` 与 `minTokensPerSecond` 的公开语义都是「0 = 关闭判定」
     * （设置页 `min: 0`、README、`DEFAULTS` 注释三处一致）。但早先这里用
     * `positive(options.slowTtfbMs, DEFAULTS.slowTtfbMs)` 兜底——`positive(0, 10000)`
     * 返回 10000，于是"关掉速度判定"之后分层**仍然按 50 tok/s 判慢**，用户把
     * 模型设成 0 却毫无变化。
     *
     * 所以这里改成：有限且 >= 0 就原样用，只有真的缺失（NaN / undefined /
     * 负数）才回落到默认值。`bandWidth` 早就这么写了，现在两处一致。
     */
    const numOr = (value, fallback) => {
      const n = Number(value)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    }
    const slowTtfb = numOr(options.slowTtfbMs, DEFAULTS.slowTtfbMs)
    const minTps = numOr(options.minTokensPerSecond, DEFAULTS.minTokensPerSecond)
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
     *
     * ## 每个桶都要有完整的比较键，否则比较器不是全序
     *
     * 早先 rank=1 桶里「有 ttfb 就比 ttfb、没有就跳过去比 rate」，于是
     * A(有ttfb, rate .05)、B(无ttfb, rate .3)、C(有ttfb, rate .3) 能构成环
     * （A<B、B<C、C<A）——同一批模型在两次 refresh 之间会整体换序，快速档取
     * 前 N 个时「谁进窗口」变得不可复现（实测 6 种输入排列产出 3 种输出）。
     *
     * 现在给 rank=1 一个**统一的桶内键**：没有 ttfb 的恒排在有 ttfb 之后，
     * 其余一律回落到 `byExpiryThenRate`（它自带 id 兜底）。
     */
    const classOf = row => {
      if (cache.has(row.id)) return cache.get(row.id)
      const value = options.preferMeasuredSpeed === false
        ? { rank: 1, ttfb: Number.POSITIVE_INFINITY }
        : (() => {
          const s = speedOf(row.id, { speedMemoryMinutes: options.speedMemoryMinutes })
          /**
           * 完全没有画像：rank 1，且 `ttfb` 必须是**数字**。
           *
           * 早先这里返回 `{ rank: 1 }`（`ttfb` 为 undefined），而另一条分支返回
           * `{ rank: 1, ttfb: Infinity }`。比较器里 `undefined !== Infinity` 为真，
           * 于是走 `Infinity < undefined ? -1 : 1`——**两个方向都返回 1**，
           * 比较器自相矛盾，排序结果取决于输入顺序（实测同一集合 6 种排列
           * 产出 4 种输出）。归一成同一个数字后才可能是全序。
           */
          if (s === undefined) return { rank: 1, ttfb: Number.POSITIVE_INFINITY }
          const tps = Number(s.tps)
          const hasTps = Number.isFinite(tps) && tps > 0
          /**
           * 「实测慢」的判据与请求期一致：首字太慢，或吞吐低于请求期门槛。
           * 注意**不能**把「没有 tps」当慢——只思考未作答的模型会因此被误杀。
           * 两项都是 0 时表示用户关掉了判定，对应条件自然为假。
           */
          const slow = (slowTtfb > 0 && Number.isFinite(s.ttfb) && s.ttfb > slowTtfb)
            || (hasTps && minTps > 0 && tps < minTps)
          if (!hasTps) {
            /**
             * 没有可比吞吐（没测过 / tps=0）。首字快的那批仍值得排在后面之前：
             * 它们至少证明了「能很快开始作答」。
             *
             * ## 但 `ttfb` 必须取「真实观测」而不是惩罚值
             *
             * 探测失败时写的是 `ttfb = PROBE_TIMEOUT_MS`（12 秒）——那是**惩罚**
             * 而不是观测。如果把它当成可比的 ttfb，一个「全部样本失败」的模型
             * 会以 12000 参与 rank=1 桶的排序，与「真的没测过」的模型混在一起，
             * 而这个 12000 又不是稳定值（换个超时上限就变），于是同一批模型在
             * 不同配置下会排出不同顺序。
             *
             * 所以：有失败样本且没有成功样本时，`ttfb` 一律给 +∞（等价于
             * 「没有可信首字」），只由 `byExpiryThenRate` 决定档内次序。
             */
            const hasObservableTtfb = Number.isFinite(s.ttfb) && s.ttfb > 0
              && (Number(s.failures) || 0) === 0
            const ttfbKey = hasObservableTtfb ? s.ttfb : Number.POSITIVE_INFINITY
            return slow ? { rank: 2, ttfb: ttfbKey } : { rank: 1, ttfb: ttfbKey }
          }
          /**
           * 合计耗时只作为**同档内**的细分：吞吐已由 band 表达，这里用
           * `首字 + 预期输出/吞吐` 处理「同档但一个首字 0.5s、一个 4s」。
           */
          const gen = useTotal ? expected / tps * 1000 : 0
          return {
            rank: slow ? 2 : 0,
            /**
             * 分档越高越慢，所以要**降序**比较。
             *
             * `bandWidth = 0`（用户关掉分档）时**所有模型同档**，此时主键必须
             * 退回纯 tps：早先这里给 `band: 0` 让跨档判断恒不触发，于是比较
             * 直接落到 `total`——而 `total` 含首字，一个 120 tok/s 但首字 4 秒
             * 的模型会排在 100 tok/s 但首字 0 秒的后面，与「严格按吞吐降序」
             * 的承诺相反（实测复现）。
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
      if (ca.rank === 0) {
        /**
         * 跨档：吞吐高的档（`band` 小）整档在前。
         *
         * **必须降序**：`Math.floor(tps / width)` 是「越大越快、档号越小」，
         * 写成升序会把最慢的模型排到第一条——这是分档排序唯一容易写反的地方。
         */
        if (ca.band !== cb.band) return cb.band - ca.band
        /**
         * 不分档时主键就是 tps 本身（严格降序）；分档时同档内再比合计耗时。
         */
        if (bandWidth === 0 && ca.tps !== cb.tps) return cb.tps - ca.tps
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
        if (Number.isFinite(ca.total) && Number.isFinite(cb.total)) {
          const diff = ca.total - cb.total
          if (diff !== 0) return diff
        }
        // tps 相同（或都不进档）：按 tps 再兜一次，保证同档内也单调。
        if (ca.tps !== cb.tps) return cb.tps - ca.tps
      } else if (ca.rank !== 2) {
        /**
         * rank=1 桶：统一的 ttfb 键（无数据恒为 +∞）。这一步保证桶内可比，
         * 不再出现「有时比 ttfb、有时比 rate」的环。
         */
        if (ca.ttfb !== cb.ttfb) return ca.ttfb < cb.ttfb ? -1 : 1
      }
      return byExpiryThenRate(a, b)
    }
  }

  /**
   * 是否该把这个模型**淘汰出所有链**。
   *
   * 判据在 `isDropped`（唯一的真相），这里只加一层**按 id 缓存**：
   * 一次分层要对四条链各判一遍，同一个模型会被问到 1–4 次，而每次都要读
   * 速度画像、算中位数。缓存让这件事退化成一次 Map 查询。
   *
   * **绝不能在这里另写一份判据**。之前就是这么漂的：这里判 `tps === 0`，
   * 而 `speedOf` 当时永远不返回 0，于是「超时模型该不该淘汰」两个入口
   * 各自都以为对方在处理，实际哪里都没处理。
   */
  const makeDropped = options => {
    const cut = Number(options.excludeBelowTps)
    const cache = new Map()
    return row => {
      if (!Number.isFinite(cut) || cut <= 0) return false
      const id = row.id
      if (cache.has(id)) return cache.get(id)
      const drop = isDropped(id, cut, options)
      cache.set(id, drop)
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
  /** 只排序、不淘汰：给「用户显式勾选」的链用（勾了就该在，只是排在后面）。 */
  const sortOnly = list => (Array.isArray(list) ? list : []).slice().sort(bySpeed)
  /** 淘汰 + 排序：给自动分层用。 */
  const pickUsable = list => sortOnly((Array.isArray(list) ? list : []).filter(row => !dropped(row)))

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
   * 免费链的排序器：**先由 `bySpeed` 决定，只有它判并列时才用额度偏好细分**。
   *
   * ## 早先为什么是错的
   *
   * 原实现是「两个模型 tps 落在同一档就无条件返回 quotaRank 差值」，等于把
   * 额度偏好提到 `bySpeed` 之上——两处实测误伤：
   *
   *   1. `bySpeed` 判定的「实测慢」（首字 11 秒、rank 2）被 quota 差值盖过，
   *      于是一个首字 11 秒的 codearts 模型排在 500ms 的 buddy 模型前面；
   *   2. `byExpiryThenRate` 的「到期优先」同样被盖过，有 500 点快到期积分的
   *      模型被排到只有长期积分的模型之后——正好浪费了要作废的额度。
   *
   * 两个都是「注释承诺了 A、代码执行了 B」。现在把额度偏好降为**真正的
   * 第三层**：吞吐档、到期、倍率都比完之后，还剩并列时才看渠道类型。
   *
   * 语义上这也更合理：额度渠道（按天给额度）与积分渠道只在「快慢、价格、
   * 到期都一样」时才值得区分——那时省下会清零的每日额度确实更划算。
   */
  const bySpeedWithQuota = (a, b) => {
    const primary = bySpeed(a, b)
    if (primary !== 0) return primary
    return quotaRank(a) - quotaRank(b)
  }
  /** 自动分层用：淘汰 + 排序（免费层多一层额度偏好做同档细分）。 */
  const freeOrdered = pickUsable(free).sort(bySpeedWithQuota)
  /**
   * 显式勾选用：**只排序、不淘汰**。
   *
   * 必须从原始 `free` 出发而不是从 `freeOrdered` 出发——后者已经过滤掉了
   * 被吞吐淘汰的模型。早先用 `sortOnly(freeOrdered)`，于是「全选」在 free 链上
   * 仍然少了几个（实测 12 个候选只进 9 个），而 low/high/custom 是对的，
   * 表现成「只有某一条链全选不全」这种极难定位的偏科。
   */
  const freeSortedAll = sortOnly(free).sort(bySpeedWithQuota)

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
    /**
     * 这里同样要尊重「0 = 关闭判定」。
     *
     * 早先用 `positive(config.minTokensPerSecond, ...)`：用户把门槛设成 0
     * （关掉速度判定）后，`positive(0, 85)` 返回 85，于是「实测 40 tok/s 但
     * 我关了判定」本该保留慢记录，却被当成达标清掉。与 `makeThroughputFirst`
     * 里的 `numOr` 保持一致：有限且非负就用原值。
     */
    const raw = Number(config.minTokensPerSecond)
    const minTps = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULTS.minTokensPerSecond
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
   * ## 勾了什么，链里就是什么
   *
   * 用户对「全选 / 全不选」的要求是**纯粹的集合语义**：全选 = 下面每一个都
   * 勾上，全不选 = 一个都不勾。所以只要用户动过复选框（`manual !== null`），
   * 就**不再套 `cap()`、也不再套吞吐淘汰**——两道筛子都会让「勾了却不在链里」：
   *
   *   - `cap()`：每条链 40 个、单渠道 6 个。实测 low 有 35 个候选，全选后链里
   *     只有 12 个；
   *   - 吞吐淘汰：实测 custom 有 98 个候选，全选后只剩 33 个。
   *
   * 这两道筛子仍然是**自动分层**（用户没动过这条链）的核心价值：替他挑一批
   * 合理候选、并把测出来慢的摘掉。区别就是「谁做的决定」——用户显式勾选时，
   * 决定权在用户；他没动过时，插件替他决定。
   *
   * 排序仍然保留（吞吐降序），因为「先试哪个」与「要不要用它」是两件事：
   * 用户可以全选 98 个，同时期望第一个是 200 tok/s 而不是 8 tok/s。
   */
  const assemble = (manual, autoList, manualList) =>
    (manual === null ? demote(cap(autoList)) : demote(manualList))

  return {
    free: assemble(freeManual, freeOrdered, freeSortedAll),
    low: assemble(lowManual, pickUsable(low), sortOnly(low)),
    high: assemble(highManual, pickUsable(high), sortOnly(high)),
    /**
     * Custom 不走 `cap`（它本来就是「用户挑的」），但**同样按吞吐降序**排。
     *
     * 淘汰的判断与三条价格链一致：用户没动过（auto，跟随池子）时摘掉实测慢的；
     * 一旦他在 Custom 里勾过，就严格按他的清单来。
     */
    custom: demote(customExplicit ? sortOnly(custom) : pickUsable(custom)),
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

/**
 * @param {Array<object>} list - 已按优先级排好的候选
 * @param {string} key - 游标键（链 id）
 * @param {number} band - 轮换窗口大小。**`1` = 不轮换**（永远用第一个），
 *   `0` / 负数 = 整条链轮换
 */
export function rotate(list, key, band = 0) {
  const rows = Array.isArray(list) ? list : []
  if (rows.length <= 1) return rows
  const id = String(key ?? '')
  /**
   * 轮换窗口大小。
   *
   * ## 这里的边界必须与文档一致
   *
   * `fastBandSize` 的语义是「只有吞吐最高的前 N 个参与轮流」：
   *
   *   - **N = 1 → 永远只用最快的那个**（不轮换）；
   *   - N ≥ 2 → 前 N 个轮流当链首，N 后面的原样接在后面兜底；
   *   - N = 0 或负数 → 整条链轮换（「关掉快速档」的老行为）。
   *
   * 早先写的是 `band > 1`，把 **1 排除在外**，于是 `fastBandSize=1` 反而落进
   * 「整链轮换」——用户设成最激进的「只用一个最快的」，得到的却是最分散的
   * 行为，每 N 次请求就轮到一个实测最慢的模型当链首。实测链首序列
   * `a b c d e`（整链）而不是 `a a a a a`。
   *
   * 所以判据是 `band >= 1`，并且 `size === 1` 时**直接返回原顺序**（游标
   * 不必前进，前进也没有第二个位置可去）。
   */
  const width = Number(band)
  const size = Number.isFinite(width) && width >= 1
    ? Math.min(Math.trunc(width), rows.length)
    : rows.length
  if (size <= 1) return rows
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
    /** 让「上一轮什么时候测完的」活过重启，见 `loadSpeedMemory`。 */
    lastProbeAt: probeState.lastCompletedAt || 0,
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
  /**
   * 恢复「上一轮探测完成时刻」。
   *
   * 不恢复它，启动跳过窗口（`startupProbeSkipMinutes`）就形同虚设——见
   * `loadSpeedMemory` 里 `lastProbeAt` 的注释。
   */
  if (Number.isFinite(data.lastProbeAt) && data.lastProbeAt > 0) {
    probeState.lastCompletedAt = data.lastProbeAt
    probeState.finishedAt = data.lastProbeAt
  }
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

/**
 * 某个模型的速度画像摘要（考虑过期）；没数据返回 undefined。
 *
 * ## 吞吐中位数怎么算（这里是淘汰与排序的唯一数据源）
 *
 * 早先的实现先用 `v > 0` 把 `tps = 0` 的样本**过滤掉**再取中位数，带来三个
 * 连锁错误（均有实测复现）：
 *
 *   1. **全部失败时 `tps` 变成 `undefined`**，于是 `makeDropped` /
 *      `filterDropped` 里那个 `tps === 0` 分支成了死代码——探测超时、空响应、
 *      只思考不作答的模型**永远淘汰不掉**，与用户「低于线的不进组合模型」的
 *      要求正相反。
 *   2. **失败被当成不存在**：7 次超时 + 1 次 150 tok/s，过滤后只剩一条 150，
 *      中位数就是 150——一个 87.5% 请求失败的模型被当成优质快模型。
 *   3. 偶数样本取上中位（`[40, 60]` → 60），系统性偏高约半档。
 *
 * 现在的规则：
 *
 *   - `tps` 用**全部**样本的中位数（失败样本按 0 参与），并单独回传
 *     `failures` / `samples`，让上层能区分「稳定快」与「偶尔才成功」；
 *   - 中位数取标准定义（偶数取中间两个的均值），不再系统性偏高；
 *   - `ttfb` 仍然只统计有效样本（失败时记的是超时上限，那是惩罚值而不是观测值，
 *     混进中位数会让真实首字被抬高）。
 */
export function speedOf(modelId, options = {}) {
  const entry = speedProfiles.get(String(modelId ?? ''))
  if (entry === undefined) return undefined
  const ttl = positive(options.speedMemoryMinutes, DEFAULTS.speedMemoryMinutes) * 60_000
  if (Date.now() - entry.at > ttl) {
    speedProfiles.delete(String(modelId))
    scheduleMemoryFlush()
    return undefined
  }
  /** 标准中位数：偶数取中间两个的均值，避免上偏。 */
  const median = nums => {
    if (nums.length === 0) return undefined
    const sorted = [...nums].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  const tpsSamples = entry.samples.map(s => {
    const value = Number(s?.tps)
    return Number.isFinite(value) && value > 0 ? value : 0
  })
  const ttfbSamples = entry.samples
    .map(s => Number(s?.ttfb))
    .filter(value => Number.isFinite(value) && value > 0)
  const failures = tpsSamples.filter(value => value === 0).length
  const successes = tpsSamples.length - failures
  /**
   * 有成功样本才给 ttfb：全是失败时那个 12 秒是「超时上限」这个惩罚值，
   * 不是真实首字观测。调用方靠 `failures === samples` 判断「这模型不行」。
   */
  return {
    ttfb: successes > 0 ? median(ttfbSamples) : undefined,
    /**
     * 有成功样本时取全部样本的中位数（失败按 0 计入，所以 7 次失败 + 1 次 150
     * 得到 0，而不是 150）；一个成功样本都没有时明确返回 **0**（不是
     * `undefined`）——`undefined` 的含义是「从没测过」，两者必须分开。
     */
    tps: successes > 0 ? median(tpsSamples) : 0,
    samples: entry.samples.length,
    failures,
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
/**
 * 清空速度画像与慢模型记忆。
 *
 * @param {{persist?:boolean}} [options] - `persist: false` 时**只清内存、不写盘**。
 *   测试脚本（`speedcheck.mjs` / `rankcheck.mjs`）需要它：那些脚本会调本函数
 *   做用例隔离，而默认的落盘会把用户真实积累的画像整份抹掉——实测复现过
 *   「按 README 跑一次 speedcheck，speed-memory.json 变成空文件」。
 *
 *   现在测试统一走 `testenv.mjs` 的 `isolate()`（临时 `DSH_HOME`），这个开关
 *   是第二道保险：即使某个脚本忘了隔离，也不会伤到真实数据。
 */
export function clearSlowModels(options = {}) {
  slowModels.clear()
  speedProfiles.clear()
  // 默认立刻落盘：用户点「清除记忆」就是要把它们永久清掉。
  if (options.persist !== false) flushSpeedMemoryNow()
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
  return rows.filter(row => !isDropped(row.id, cut, options))
}

/**
 * 「这个模型是否被吞吐淘汰」的**唯一判据**。
 *
 * 分层期（`makeDropped`）与请求期（`filterDropped`）都调它，只是前者多包一层
 * 缓存。两份实现各写一遍必然会漂移——实测就漂过：一处用 `tps === 0`、另一处
 * 依赖 `speedOf` 返回 0，而 `speedOf` 当时永远不返回 0，于是「超时模型该不该
 * 淘汰」在两处的答案都是「不淘汰」，却各自以为对方会处理。
 *
 * ## 规则
 *
 *   1. **没测过**（`speedOf === undefined`）→ 不淘汰。启动瞬间所有模型都没数据，
 *      按「没数据就淘汰」会得到空链。
 *   2. **有可比吞吐**（`tps > 0`）→ 低于线就淘汰。
 *   3. **有画像但没有可比吞吐**（`tps = 0`：全部样本失败，或样本都太短）→
 *      看它是否**确实被证明不行**：
 *        - 有失败样本且占比达到一半以上 → 淘汰（这就是「超时/空响应/只思考」
 *          那类模型，用户明确要求不进组合）；
 *        - 否则（样本都太短、没有失败）→ 不淘汰，只当作「还没测出可比吞吐」。
 *   4. 另外，被**请求期**判慢（`slowModels`）且仍在窗口内的，也淘汰——那是
 *      真实请求里的证据。
 *
 * @param {string} id
 * @param {number} cut - 淘汰线（tokens/s），调用方保证 > 0
 * @param {{speedMemoryMinutes?:number, slowMemoryMinutes?:number}} options
 * @returns {boolean}
 */
export function isDropped(id, cut, options = {}) {
  /**
   * ## 门槛 <= 0 表示「彻底关掉淘汰」
   *
   * 这是公开语义（`DEFAULTS` 注释、设置页 `min: 0`、README 三处一致）。
   * 早先这里没有守卫，只有调用方 `filterDropped` 在外面挡了一下——于是
   * **直接调用 `isDropped(id, 0, ...)` 的路径**（收紧逻辑就是这么调的）
   * 会把「全部样本失败」的模型仍判为不达标，与「关了淘汰」矛盾。
   *
   * 守卫放在这里而不是只放在调用方：判据函数本身要自洽，不能依赖每个调用方
   * 都记得先检查一遍。
   */
  const limit = Number(cut)
  if (!Number.isFinite(limit) || limit <= 0) return false
  const s = speedOf(id, { speedMemoryMinutes: options.speedMemoryMinutes })
  if (s === undefined) return false
  const tps = Number(s.tps)
  if (Number.isFinite(tps) && tps > 0) return tps < limit
  /**
   * `tps = 0`：没有可比吞吐。区分「测出来就是不行」与「样本太短」。
   */
  const failures = Number(s.failures) || 0
  const samples = Number(s.samples) || 0
  if (failures > 0 && samples > 0 && failures * 2 >= samples) return true
  // 剩余情况：看请求期是否判过它慢。
  return isSlow(id, { slowMemoryMinutes: options.slowMemoryMinutes })
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
/**
 * 估算 token 数：**中文按 1 字 1 token，其它按 3 字符 1 token**。
 *
 * ## 为什么不能一刀切 `chars / 3`
 *
 * 早先 `estimateTps` 固定用 `chars / 3`，对中文（1 字 ≈ 1 token）**系统性低估
 * 约 3 倍**。实测：
 *
 *   - 123 个中文字 / 925ms → 算出 **44 tok/s**（真实约 133）
 *   - 90 字 / 3000ms → 算出 **10 tok/s**（真实约 30）
 *
 * 而 `minTokensPerSecond` 与 `excludeBelowTps` 默认都是 50——于是**一段完全
 * 正常的中文回答会被判成「慢模型」**：这一轮被中止换人，模型被 `markSlow`，
 * 还会被淘汰线踢出候选链。中文用户的主场景直接命中，越用可选模型越少。
 *
 * 这不只是精度问题，是把正常行为判成故障。
 *
 * @param {string|number} textOrChars - 正文，或（兼容旧调用）字符数
 * @param {number} elapsedMs
 * @returns {number} tokens/s；输入无效时返回 0（不下结论）
 */
export function estimateTps(textOrChars, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const tokens = typeof textOrChars === 'string'
    ? countTokens(textOrChars)
    : Number.isFinite(textOrChars) && textOrChars > 0 ? textOrChars / 3 : 0
  if (tokens <= 0) return 0
  return tokens / (elapsedMs / 1000)
}

/**
 * 粗估一段文本的 token 数。
 *
 * 中文、日文假名、韩文按 **1 字符 ≈ 1 token**（这是主流分词器对 CJK 的经验
 * 值）；其余（拉丁、数字、标点、空白）按 **3 字符 ≈ 1 token**。
 *
 * 为什么不用真正的分词器：本插件只需要「快慢量级」，而引入一个分词器会带来
 * 词典体积与版本漂移；误差 ±20% 对「50 tok/s 合不合格」这种判断完全够用，
 * 3 倍的偏差才是真问题。
 */
export function countTokens(text) {
  const source = String(text ?? '')
  if (source === '') return 0
  let cjk = 0
  for (const ch of source) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x3040 && code <= 0x30ff) // 日文假名
      || (code >= 0x3400 && code <= 0x4dbf) // CJK 扩展 A
      || (code >= 0x4e00 && code <= 0x9fff) // CJK 基本区
      || (code >= 0xf900 && code <= 0xfaff) // CJK 兼容
      || (code >= 0xac00 && code <= 0xd7af) // 韩文
      || (code >= 0xff00 && code <= 0xffef) // 全角标点
    ) cjk += 1
  }
  const rest = [...source].length - cjk
  return cjk + rest / 3
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
  /**
   * 上一轮**完成**的时刻（也是这一轮的开始哨兵：开跑时清 0）。
   *
   * ⚠️ 用户点「停止」被取消的那一轮**不能**写这个值：它并没有测完，
   * 却会让 60 秒冷却与启动跳过窗口都以它为据（实测：停止后 60ms 再点测速
   * 被拒「距上一轮不足 60 秒」；一次 0 样本的取消轮还会让下一次启动的
   * 重测在 10 分钟窗口内被跳过）。
   */
  finishedAt: 0,
  /** 最近一次「真正测完」的时刻；会被落盘，供启动跳过窗口使用。 */
  lastCompletedAt: 0,
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
  /** 累积的正文本体，供 `countTokens` 按语言折算 token。 */
  let text = ''
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
        /**
         * 累积**实际文本**而不是字符数：`estimateTps` 要按语言折算 token，
         * 而「123 个字」在中文与英文里是完全不同的 token 量。
         */
        text += String(chunk.text ?? '')
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
    /**
     * ## 字符太少就不给吞吐，别把「秒回」测成「慢」
     *
     * 探测 prompt 是 `hi`，模型常常只回 3–33 个字符。`estimateTps` 是
     * 「字符/3 ÷ 秒」，分母只有几百毫秒时任何抖动都放大成数量级差异——实测：
     *
     *   - 3 字符 / 200ms → **4.9 tok/s**
     *   - 33 字符 / 465ms → **18.7 tok/s**
     *
     * 默认 `excludeBelowTps = 50`，于是**一个 200ms 就答完的模型会被判成
     * 实测慢并被踢出全部四条链**，而且每轮探测都追加一条同样偏低的样本，
     * 越测越沉。这比不测更糟。
     *
     * 与请求期判定用同一个门槛（`MIN_SPEED_SAMPLE_CHARS`）：字符不够时回
     * `tps: 0`——含义是「这次没测出可比吞吐」，由 `speedOf` 把它当作一次
     * **失败样本**（计入 failures），而不是当作「它很慢」。
     */
    const tps = chars >= MIN_SPEED_SAMPLE_CHARS ? estimateTps(text, genMs) : 0
    return {
      ok: true,
      ttfb: firstTextAt - startedAt,
      tps,
      ...chars < MIN_SPEED_SAMPLE_CHARS ? { note: `样本太短（${chars} 字），不计吞吐` } : {},
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
         *
         * 门槛从 `deps` 里取：`runProbe` 是模块级函数，**看不到** `apply` 里的
         * `config` 闭包。任何 `config.xxx` 出现在这里都是 ReferenceError。
         *
         * `tps === 0`（样本太短，见 `probeModel`）既不能算「快」也不能算
         * 「慢」——它是「这次没测出可比吞吐」，所以既不清慢记录、也不记慢。
         */
        const floor = positive(deps.minTokensPerSecond, DEFAULTS.minTokensPerSecond)
        if (Number(result.tps) > 0 && Number(result.tps) >= floor) {
          markFast(row.id)
        }
      } else {
        /**
         * ## 失败要分两类，不能一律记成「很慢」
         *
         * `isSpeedFailure` 认的是「超时 / 空响应 / 流提前结束」——这些确实说明
         * 这个模型干活不行，写一条 `tps:0` 的样本（并记慢）是合理的。
         *
         * 但 `HTTP 4xx/5xx`、`fetch failed`、`ECONNREFUSED` 是**请求或服务**的
         * 问题：换参数就能用、网关抖动也会自己恢复。早先对它们也写
         * `recordSpeed({ttfb: 12000, tps: 0})`，等于凭空造一条「首字 12 秒」的
         * 假观测——实测会让一个真实 80 tok/s 的模型排到 75 tok/s 的后面，并把它
         * 真实的慢记录顺手清掉（`markFast`）。
         *
         * 所以：**只有速度类失败才写样本、才记慢；其余失败什么都不改**。
         * 保留既有画像与慢记录，只记日志——「这次没测出来」不等于「它变慢/变快」。
         */
        if (isSpeedFailure(result.error)) {
          recordSpeed(row.id, { ttfb: PROBE_TIMEOUT_MS, tps: 0 })
          markSlow(row.id)
        } else {
          log(`探测跳过（非速度类失败，不改画像）：${row.id} — ${String(result.error ?? '').slice(0, 60)}`)
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
    /**
     * ## 被取消的一轮不能算「测完」
     *
     * `finishedAt` 同时被 60 秒冷却与启动跳过窗口当作「上一轮完成时间」。
     * 早先无论是否取消都写 `Date.now()`，于是：
     *
     *   - 用户点「停止」后 60 秒内再点「测速」会被拒（而那一轮根本没测完）；
     *   - 一次 `done: 0` 的取消轮，会让下一次启动的重测在 10 分钟窗口内被跳过
     *     ——用「什么都没测」当「刚测过」的证据。
     *
     * 所以：取消时把 `finishedAt` 归零（表示「没有可参考的完成时刻」），
     * 只有真正跑完才同时推进 `finishedAt` 与落盘用的 `lastCompletedAt`。
     */
    if (probeState.cancelled) {
      probeState.finishedAt = 0
      probeState.queue = []
      flushSpeedMemoryNow()
      return { started: true, total: pending.length, cancelled: true }
    }
    probeState.finishedAt = Date.now()
    probeState.lastCompletedAt = probeState.finishedAt
    probeState.queue = []
    /**
     * 显式落盘。
     *
     * 防抖定时器只会「1.5 秒内没新样本时写一次」，但探测刚跑完这段时间正是
     * 用户期待数据已保存的时刻——如果进程恰好在此刻退出，最后一批样本就丢了。
     * 这里直接落盘，把确定性给到调用方。`lastCompletedAt` 也在这里被写进
     * 落盘文件，让启动跳过窗口在重启后仍然有效。
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
 * 把一个 harness 图片块解析成可发送的 data URL / 远程 URL。
 *
 * ## 为什么不能只看 `attachment.url`
 *
 * DSH 的附件引用字段是 **`attachmentId`**（+ `mediaType`），不是 `url`：
 * 本机 dsh-attachment-local 返回 `{ attachmentId: AttachmentId(...) }`，渠道包
 * 的所有 `collectImages` 也以 `typeof block.attachment?.attachmentId === 'string'`
 * 为判据。
 *
 * 早先这里只认 `attachment.url`，于是**每一张图都被静默丢弃**；只发一张图
 * （没有文字）时 `messages` 直接变成空数组，整条链 400 全灭（用户目录里的
 * `last-request.json` 就是这条路径的实证：`messages must be a non-empty array`）。
 *
 * ## 解析顺序
 *
 *   1. `resolver`（内核的附件服务）——最可靠，能拿到真字节；
 *   2. `attachment.url`——有些调用方直接给现成 URL；
 *   3. `attachment.data` / `base64`——少数路径会直接带内容；
 *   4. 都没有 → 返回 `undefined`，由调用方写一个 `[image]` 占位而不是**假装
 *      什么都没发生**（至少要能让模型知道「这里原本有张图」）。
 *
 * @param {object} attachment
 * @param {(attachment:object)=>string|undefined} [resolver]
 * @returns {string|undefined}
 */
export function resolveImageUrl(attachment, resolver) {
  if (attachment === null || typeof attachment !== 'object') return undefined
  if (attachment.offloaded === true) return undefined
  try {
    const viaResolver = resolver?.(attachment)
    if (typeof viaResolver === 'string' && viaResolver !== '') return viaResolver
  } catch { /* 解析失败退回其它来源 */ }
  if (typeof attachment.url === 'string' && attachment.url !== '') return attachment.url
  const base64 = typeof attachment.base64 === 'string' ? attachment.base64
    : (typeof attachment.data === 'string' ? attachment.data : '')
  if (base64 !== '') {
    const mime = typeof attachment.mediaType === 'string' && attachment.mediaType !== ''
      ? attachment.mediaType
      : 'image/png'
    return `data:${mime};base64,${base64}`
  }
  return undefined
}

/**
 * harness 消息 → 网关 Chat 消息。
 *
 * 图片经 `resolveImageUrl` 解析（支持 `attachmentId` 与 `url` 两种形状）；
 * `tool` 角色消息保留 `tool_call_id`，否则网关无法把结果配回调用。
 *
 * @param {object} options - harness 的 stream options
 * @param {{resolveImage?:(attachment:object)=>string|undefined}} [deps]
 *   可选：内核附件解析器（`ctx.get('attachments')` 之类）。拿不到时退化为
 *   只认块里自带的 url / base64。
 */
export function toChatBody(options, deps = {}) {
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
  /**
   * ## system 消息必须合并，绝不能丢
   *
   * 早先这里是 `if (role === 'system') continue`——把所有 system 历史和
   * `options.system` 一起丢掉。但 DSH 的系统提示**恰恰是以 system 消息形式
   * 存在于 `options.messages` 里**（agent-loop 的 buildRequest 只传
   * `messages`/`tools`/`sessionId`/`signal`，从不传 `options.system`；
   * system/message 事件经 session.deriveMessages 进入 messages；上游
   * `messages.js` 也是把 system 与 developer 统一映射成 `role: 'system'`）。
   *
   * 丢掉它们的后果是模型收到一份「没有系统提示、没有工具说明、没有 developer
   * 指令」的裸对话：人格/安全约束/工具使用约定全部失效，而界面上看不出任何
   * 异常。这是功能层面的静默失效。
   *
   * ## 为什么按顺序合并成一条
   *
   * DSH 在 in-history 模式下会**追加多段** system 更新（不是替换）。逐段保留
   * 成多条 system 也行，但 OpenAI 兼容网关对「多条 system」的支持参差；合并
   * 成一条既保语义又最稳。`options.system`（若内核给了）排在最前。
   */
  const systemParts = []
  const topSystem = typeof options.system === 'string' ? options.system.trim() : ''
  if (topSystem !== '') systemParts.push(topSystem)
  for (const message of source) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue
    /**
     * 用 `flattenText` 而不是只取 text 块：developer 消息可能带
     * tool-addition / tool-removal 之类的结构块，摊平成文本至少不丢内容
     * （丢掉它们的代价比多几行文本大得多）。
     */
    const value = flattenText(message?.content).trim()
      || (typeof message?.content === 'string' ? message.content.trim() : '')
    if (value !== '') systemParts.push(value)
  }
  if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n\n') })

  for (const message of source) {
    const role = message?.role
    // system / developer 已经在上面合并过，这里跳过（不是丢弃）。
    if (role === 'system' || role === 'developer') continue

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
        /**
         * 图片：解析成 image_url；解析不出就放文本占位。
         *
         * 占位不是「凑数」——它让模型知道「这里原本有张图，只是拿不到」，
         * 比静默丢弃让模型凭空回答要好。而且它保证了 `parts` 非空，从而
         * 不会让这条消息整个消失（纯图片消息消失会导致 `messages: []` → 400）。
         */
        const url = resolveImageUrl(block.attachment, deps.resolveImage)
        if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
        else parts.push({ type: 'text', text: '[image unavailable]' })
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

  /**
   * ## 空 messages 必须兜底
   *
   * 上游对空 `messages` 是**明确拒绝**的（`messages must be a non-empty array`
   * → 400）。而有多种常见历史形状会把它清空：
   *
   *   - 全部 tool-call 都配不上对（会话被裁剪、或换过 provider 后 id 失配）；
   *   - 用户消息的 content 是空数组；
   *   - 历史只剩 system（旧版本还会把它丢掉）。
   *
   * 这些情况下把空数组发出去，结果是**整条链三个候选各 400、全部失败**，而
   * 用户看到的错误是「所有候选失败」——归因完全指错方向（他会去查网关、查账号，
   * 而真正的问题在本地序列化）。
   *
   * 兜底一个有内容的 user 消息，让请求至少是一个合法请求。
   */
  if (messages.length === 0) messages.push({ role: 'user', content: '(no content)' })

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
  /**
   * 正在进行中的 `refresh()`。
   *
   * ## 为什么必须单飞
   *
   * `refresh` 有 7 个并发入口：启动重试、定时器、`/refresh`、`/chain/toggle`、
   * `/chain/all`、`saveConfig`、端口就绪后的补刷。每一次都会在 `fetchRows`
   * 返回后**无条件**覆写 `tiers` / `allRows` / `status`，而 `expiryGeneration`
   * 只保护 credits 分支、保护不到分层结果本身。
   *
   * 于是最终状态由「谁最后完成」决定，实测两种坏结果：
   *
   *   - **慢的旧清单覆盖快的新清单**：老请求延迟 1.2 秒返回，把已经刷新的
   *     候选池又改回旧数据；
   *   - **故障被假成功掩盖**：后发起的刷新遇到 503 写了 `ok:false`，先发起的
   *     慢刷新随后成功落地，把 `error` 清空、`ok` 抹成 true——页面显示一切正常，
   *     而网关其实是坏的。
   *
   * 单飞之后同一时刻只有一轮在跑，其余调用直接复用它的结果（语义上也正确：
   * 「再刷新一次」发生在已有刷新进行中时，等它就行）。
   */
  let refreshInflight = null

  const log = message => { if (config.verbose) logger.info?.(`[baipiao] ${message}`) }

  /**
   * 按新配置重建刷新定时器。
   *
   * `refreshMinutes` 是可以在设置页随时改的，而早先定时器只在 `apply` 时按
   * 当时的分钟数创建一次：改成 5 分钟仍按 30 分钟跑，改成 0（文档说「只在启动
   * 时拉一次」）也停不掉已经建好的 30 分钟定时器。README 还承诺「改完立即生效」。
   */
  function startRefreshTimer(minutes) {
    if (timer !== undefined) { clearInterval(timer); timer = undefined }
    const value = Number(minutes)
    if (!Number.isFinite(value) || value <= 0) return
    timer = setInterval(() => { void refresh().catch(() => {}) }, value * 60_000)
    timer.unref?.()
  }

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

  /**
   * 「重测全部」之后，按吞吐门槛收紧四条链的**勾选集合**。
   *
   * ## 为什么需要它（与淘汰线的区别）
   *
   * `excludeBelowTps` 是**运行时**的筛子：它让慢模型不进链，但**不动用户的勾选
   * 清单**。所以重测之后，设置页上仍然是「勾着一堆 20 tok/s 的模型」——只是
   * 它们不在链里。用户看到的是「我勾了 60 个，实际只有 12 个在跑」。
   *
   * 用户要的是更直接的行为：**重测全部之后，默认只选中 ≥ 门槛的模型**。
   * 也就是把「勾选清单」本身收敛到通过门槛的那批。
   *
   * ## 三条必须守住的不变式
   *
   * 1. **未测出的模型不杀**。测速失败（超时、样本太短、HTTP 错误）不等于「它
   *    慢」，只是「这次没测出来」。把它们一起取消掉，会让一次网络抖动清空大半
   *    条链——而且用户没有任何办法知道为什么。它们保持原样。
   * 2. **用户手改过的链不覆盖**。只在该链当前是「跟随自动分层」（`all`）或
   *    上一次就是被本函数收敛过的 `explicit` 时动手；用户显式勾选的清单是
   *    他的意图，不能被一次重测悄悄改掉。
   * 3. **门槛为 0 时什么都不做**（用户关掉了淘汰）。
   *
   * ## 怎么写
   *
   * 写成**显式清单**（`explicit`）而不是留空串：留空串等于「没动过」，
   * 下次自动分层又会把慢模型加回来，看起来像「设置了没用」。
   *
   * @returns {{changed:string[], kept:Record<string,number>, dropped:Record<string,number>}}
   */
  function applyThroughputCut() {
    const cut = Number(config.excludeBelowTps)
    const summary = { changed: [], kept: {}, dropped: {} }
    if (!Number.isFinite(cut) || cut <= 0) return summary
    if (allRows.length === 0) return summary

    /**
     * 每条链的候选范围必须与页面一致：三条价格链按倍率归层，Custom 是池全集。
     * 用同一份 `chainCandidates`，否则会出现「页面上有的被取消了、页面外的
     * 反而被写进清单」。
     */
    const keys = ['free', 'low', 'high', 'custom']
    for (const key of keys) {
      const field = key === 'custom' ? 'customModels' : `members${key[0].toUpperCase()}${key.slice(1)}`
      /**
       * Custom 在 `auto` 下没有勾选清单（跟随池子），此时不动它——切到
       * explicit 会改变用户「新上架自动进来」的预期。
       */
      if (key === 'custom' && config.customMode !== 'explicit') continue

      const raw = String(config[field] ?? '').trim()
      const never = raw === ''
      const none = raw.toLowerCase() === NONE_SELECTED
      if (none) continue

      const current = never
        ? chainCandidates(key).map(row => String(row.id ?? '').toLowerCase())
        : parseCustomModels(raw)

      let kept = 0
      let dropped = 0
      const next = []
      for (const id of current) {
        /**
         * ## 判据必须与「淘汰」用同一套，不能只看 `throughputOf`
         *
         * `throughputOf` 在 `tps = 0`（**全部样本都失败**：每次探测都超时 /
         * 空响应 / 只思考不作答）时返回 `undefined`，与「从没测过」无法区分。
         * 早先这里只用它，于是那类模型被当成「没测出」而全部保留——实测
         * `codearts/deepseek-v4-flash` 有 7 个样本、4 次失败、tps 恒为 0，
         * 仍然留在勾选里，收紧等于没做。
         *
         * 正确做法：调用 `isDropped`（分层与请求期共用的那个唯一判据），
         * 它内部已经区分了「全部失败」与「样本太短」，并会照顾 `slowModels`。
         * 这里只关心「该不该保留」，不需要知道具体 tps。
         */
        const isOut = isDropped(id, cut, {
          speedMemoryMinutes: config.speedMemoryMinutes,
          slowMemoryMinutes: config.slowMemoryMinutes,
        })
        /**
         * 还想区分「真的低于门槛」与「没测出」——用 `speedOf` 的画像判断：
         *
         *   - 完全没有画像 → 保留（不变式 1：没测过 ≠ 慢）；
         *   - 有画像但被 `isDropped` 判掉 → 取消（覆盖「全部失败」这一类）。
         */
        const hasProfile = speedOf(id, { speedMemoryMinutes: config.speedMemoryMinutes }) !== undefined
        if (!hasProfile) { next.push(id); continue }
        if (isOut) { dropped += 1; continue }
        next.push(id)
        kept += 1
      }
      summary.kept[key] = kept
      summary.dropped[key] = dropped
      if (dropped === 0) continue

      config[field] = encodeMembers(next)
      if (key === 'custom') config.customMode = 'explicit'
      summary.changed.push(key)
    }

    if (summary.changed.length > 0) {
      persistSettings(config)
      log(`重测后按 ${cut} tok/s 收紧勾选：${summary.changed.map(k => `${k} -${summary.dropped[k]}`).join(' · ')}`)
    }
    return summary
  }

  /**
   * 重新拉取并分层（**单飞**）。
   *
   * 已有刷新在进行时直接复用那一轮的结果，不再开第二个——见 `refreshInflight`
   * 的注释（并发刷新会让旧清单覆盖新清单、让故障被假成功掩盖）。
   */
  async function refresh() {
    if (refreshInflight !== null) return refreshInflight
    refreshInflight = refreshOnce().finally(() => { refreshInflight = null })
    return refreshInflight
  }

  async function refreshOnce() {
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

    /**
     * 什么时候去查余额？
     *
     * 早先的条件只有「模型层要按到期排序」——`preferExpiringCredits`。那带来
     * 一个隐蔽的连带失效：**账号层的「到期优先 + 轮流」也被它关死了**。
     *
     * 因为 `reorderAccounts` 的唯一调用点在这个分支内部，而它需要逐账号余额
     * 才能判断「谁的积分先作废」。用户只是不想让**模型**按快到期排序（关掉
     * `preferExpiringCredits`），结果账号顺序再也不会更新——而
     * `accountExpiryFirst` / `accountRotation` 两个开关还显示着「开」，页面
     * 的 accountPlan 停在旧值，没有任何提示。
     *
     * 现在条件是三者之一：模型层要到期优先，**或**账号层要到期优先，**或**
     * 账号层要轮换。只要有一件事需要余额，就去查。
     */
    const wantsModelExpiry = config.preferExpiringCredits !== false
    const wantsAccountOrder = config.accountExpiryFirst !== false || config.accountRotation !== false
    if ((wantsModelExpiry || wantsAccountOrder) && config.expiryLookup !== false) {
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

    /**
     * 分层成功了，但启动重测可能还没跑（上一次试的时候 Key 还没就绪、或
     * 候选池还是空的）。这里补一次：`startStartupProbe` 内部有 `startupProbeDone`
     * 幂等，跑过了就是空操作。
     */
    if (!startupProbeDone) {
      try { startStartupProbe() } catch { /* 探测失败不影响分层 */ }
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
   * 一条链在设置页上**列出来的全部候选**。
   *
   * 这是「全选」的权威范围：全选必须等于「勾上我看到的每一个」，所以后端算
   * 全选清单时必须用**与页面同一套候选**，不能自己另算一份。
   *
   * 三条价格链按倍率归层（`tierOf`）；Custom 是候选池全集。两次排序都用
   * provider + 倍率，与 `viewState().eligible` 一致——否则页面顺序与后端写入
   * 的顺序不同，用户会看到「全选之后勾选数量对，但条目次序变了」。
   */
  function chainCandidates(key) {
    const options = {
      lowMaxRate: positive(config.lowMaxRate, DEFAULTS.lowMaxRate),
      longContextMin: positive(config.longContextMin, DEFAULTS.longContextMin),
    }
    const sort = list => list.slice().sort((a, b) =>
      String(a.provider).localeCompare(String(b.provider))
      || (a.rate ?? 99) - (b.rate ?? 99))
    const pool = poolRows()
    if (key === 'custom') return sort(pool)
    return sort(pool.filter(row => tierOf(row, options) === key))
  }

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
  /**
   * 把「勾选配置字段」翻译成页面能直接用的三态。
   *
   * @param {string} raw - 配置里的原始字符串
   * @param {'auto'|null} customMode - Custom 链的 auto 模式（其余传 null）
   * @returns {{mode:'all'|'none'|'explicit'|'auto', ids:string[], count:number}}
   */
  function memberView(raw, customMode) {
    if (customMode === 'auto') {
      // Custom 的 auto：跟随候选池，不存在「勾选清单」这个概念。
      return { mode: 'auto', ids: [], count: poolRows().length }
    }
    const text = String(raw ?? '').trim()
    /**
     * 空串 = 用户从没动过这条链 → 等于全选。
     *
     * 注意 Custom 的 auto 已经在上面拦掉了；这里剩下的空串只可能来自
     * 「三条价格链从未被勾选过」。
     */
    if (text === '') return { mode: 'all', ids: [], count: poolRows().length }
    // 哨兵 = 显式全不选。
    if (text.toLowerCase() === NONE_SELECTED) return { mode: 'none', ids: [], count: 0 }
    const ids = parseCustomModels(text)
    return { mode: 'explicit', ids, count: ids.length }
  }

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
      /**
       * 每条件链**用户勾选的**成员，以及「这份勾选该怎么读」。
       *
       * 三种状态必须能被页面无歧义地区分——否则复选框只能去猜：
       *
       *   - `explicit`：用户在复选框里动过，`ids` 就是**完整**的勾选清单，
       *     「全选」时它就是候选全集、「全不选」时是空数组；
       *   - `all`：用户没动过这条链，等于「全选」（用自动分层的候选全集）；
       *   - `custom` 额外有 `auto` 模式（跟随池子）。
       *
       * 早先这里只回 `parseCustomModels(...)`，空串（=全选）与哨兵（=全不选）
       * 都被解析成空数组，页面无法区分「一个都没勾」和「一个都没限制」，
       * 于是退回去读 `chains[key].links`（链的实际成员）——而那份成员经过
       * `cap` 与吞吐淘汰，天然比候选列表少，表现出来就是「点了全选只勾了一部分」。
       */
      members: {
        free: memberView(config.membersFree, null),
        low: memberView(config.membersLow, null),
        high: memberView(config.membersHigh, null),
        custom: memberView(config.customModels, config.customMode === 'explicit' ? 'explicit' : 'auto'),
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
      /**
       * ## 不回传掩码
       *
       * 早先这里回 `'••••••'`，前端把它当成受控 input 的 value。用户点进去
       * 补一个字符（最自然的「改 Key」动作），提交的就是 `'••••••sk-new'`，
       * 宿主原样落盘 → 之后所有网关调用 401。更糟的是再读仍显示掩码、
       * `gatewayKeyConfigured` 仍是 true，**界面完全看不出凭证已经损坏**。
       *
       * 现在恒回空串，用 `gatewayKeyConfigured` 表示「已配置」，前端用
       * placeholder 显示「已配置（留空表示不修改）」。`saveConfig` 里还有
       * 第二道闸：收到掩码或以掩码开头的值一律视为「未修改」。
       */
      gatewayKey: '',
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
    /**
     * ## 标志只在**真正开跑**之后置位
     *
     * 早先 `startupProbeDone = true` 写在所有跳过判定之前，而 `bootRefresh`
     * 只在首次分层成功后挂**一次** 5 秒定时器、没有任何重试路径。于是下面
     * 任何一个跳过理由都会让本次进程内**永不重测**：
     *
     *   - 定时器触发时网关 Key 还没就绪（渠道包刚启动）；
     *   - `allRows` 还是空（首次 refresh 成功但清单 0 行）；
     *   - 上一轮刚测完仍在跳过窗口内，但窗口随后就过期了。
     *
     * 用户看到的是「启动时自动重测全部」明明开着、画像却一直是旧的。
     */
    const skipMs = Math.max(0, Number(config.startupProbeSkipMinutes) || 0) * 60_000
    /**
     * 判据用 `lastCompletedAt`（会落盘）而不是 `finishedAt`（纯内存）。
     * `finishedAt` 在冷启动时是 0，`sinceLast` 会等于当前时间戳——窗口永远
     * 不命中，等于每次启动都全量探测。
     */
    const lastCompleted = probeState.lastCompletedAt || probeState.finishedAt || 0
    const sinceLast = Date.now() - lastCompleted
    if (skipMs > 0 && lastCompleted > 0 && sinceLast < skipMs) {
      log(`启动重测跳过：上一轮测速在 ${Math.round(sinceLast / 60_000)} 分钟前完成（窗口 ${Math.round(skipMs / 60_000)} 分钟）`)
      return
    }
    const { key } = resolveGatewayKey(config.gatewayKey)
    if (key === '') { log('启动重测跳过：网关 Key 尚未就绪（会在下次分层后重试）'); return }
    const list = probeTargets()
    if (list.length === 0) { log('启动重测跳过：候选池为空（会在下次分层后重试）'); return }
    const base = text(config.gatewayUrl) || DEFAULTS.gatewayUrl
    startupProbeDone = true
    log(`启动重测：${list.length} 个模型，后台进行`)
    void runProbe({
      list, base, key,
      /**
       * `force: true` 是「重测全部」的语义：连已有画像的也重测一遍，
       * 否则启动这道闸对老用户永远不生效（画像全都有，等于什么都不测）。
       */
      force: true,
      speedMemoryMinutes: config.speedMemoryMinutes,
      minTokensPerSecond: config.minTokensPerSecond,
      onProgress: (done, total) => { if (done % 25 === 0 || done === total) log(`启动重测 ${done}/${total}`) },
    }).then(result => {
      if (result.started !== true) {
        log(`启动重测未开始：${result.reason ?? '未知原因'}`)
        return
      }
      log(`启动重测已完成（${result.total} 个模型）`)
      /**
       * 启动重测同样要收敛勾选——用户要求的是「重测全部后默认只选 ≥ 门槛的」，
       * 而启动重测就是一次自动的「重测全部」。跑完还要 refresh 一次，因为清单
       * 变了，链成员随之变化。
       */
      if (result.cancelled !== true) {
        const cut = applyThroughputCut()
        if (cut.changed.length > 0) void refresh().catch(() => {})
      }
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
       *
       * 另外：`startStartupProbe` 现在会在「Key 没就绪 / 候选池为空」时**不置位**
       * 标志直接返回，所以下一次分层成功时还能再试一次（见 `refreshOnce` 末尾）。
       */
      if (!startupProbeDone) {
        const timer = setTimeout(() => { try { startStartupProbe() } catch { /* 探测失败不影响启动 */ } }, 5000)
        timer.unref?.()
      }
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
  /**
   * 用 `startRefreshTimer` 而不是直接 `setInterval`：定时器需要能在设置页
   * 改动 `refreshMinutes` 之后**重建**（见该函数注释）。
   */
  startRefreshTimer(positive(config.refreshMinutes, DEFAULTS.refreshMinutes) > 0
    ? Number(config.refreshMinutes)
    : 0)

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
    if (Object.hasOwn(patch, 'gatewayKey')) {
      const raw = String(patch.gatewayKey ?? '').trim()
      /**
       * ## 掩码不是 Key
       *
       * 前端可能把 `'••••••'`（或用户在它后面补了一个字符）原样提交回来。
       * 那不是用户的意图，而是「我改了别的字段，Key 没动」——必须当作**未修改**，
       * 否则落盘后 `resolveGatewayKey` 会把这个字面量当凭证，网关全部 401。
       *
       * 判据：以掩码字符（U+2022）开头，或全部由掩码字符组成。
       * 空串是「显式清除」，仍然照常生效。
       */
      const looksMasked = raw !== '' && /^[\u2022•\u25cf\u25CB]+/.test(raw)
      if (!looksMasked) next.gatewayKey = raw
    }
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
      next.customModels = encodeMembers(parseCustomModels(patch.customModels))
    }
    // 关闭的链：只接受已知的链名，防止写入任意值。
    for (const key of ['membersFree', 'membersLow', 'membersHigh']) {
      if (Object.hasOwn(patch, key)) next[key] = encodeMembers(parseCustomModels(patch[key]))
    }

    // `config` 是 const 绑定，改写它的字段而不是重新赋值——闭包里的所有
    // 读取点（adapter、定时器、refresh）共享同一个对象。
    for (const key of Object.keys(config)) delete config[key]
    Object.assign(config, next)
    // 落盘：customModels 等设置必须活过重启。
    persistSettings(config)
    /**
     * 刷新间隔可能刚被改过：重建定时器。
     *
     * 不重建的话，把「重新分层间隔」从 30 改成 5 仍按 30 分钟跑、改成 0 也
     * 停不掉旧定时器——而 README 承诺「改动保存后立即生效」。
     */
    startRefreshTimer(Number(config.refreshMinutes) > 0 ? Number(config.refreshMinutes) : 0)
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
      let settled = false
      const finish = value => { if (!settled) { settled = true; resolve(value) } }
      req.on('data', chunk => {
        size += chunk.length
        // 设置项都是小对象；超过 64 KiB 的一律当坏请求，避免把内存交给对方。
        if (size > 64 * 1024) { finish({ __tooLarge: true }); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > 64 * 1024) { finish({ __tooLarge: true }); return }
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') { finish({}); return }
        try { finish(JSON.parse(text)) } catch { finish(undefined) }
      })
      req.on('error', () => finish(undefined))
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
          /**
           * 只回文件名，不回绝对路径。
           *
           * 绝对路径会把本机用户名与目录结构暴露给任何能访问这个前缀路由的
           * 会话——而本插件其余端点刻意「不回传敏感/本机信息」（Key 只回布尔值）。
           * 诊断只需要知道「写到了哪个文件」，不需要知道盘符。
           */
          settingsFile: path.basename(settingsFile()),
          settingsDir: '~/.dsh/dsh-baipiao-stone',
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
              minTokensPerSecond: config.minTokensPerSecond,
              onProgress: (done, total) => { if (done % 25 === 0 || done === total) log(`自动测速 ${done}/${total}`) },
            }).then(result => {
              if (result.started !== true) return
              log(`重新分层后自动测速已完成（${result.total} 个模型）`)
              /**
               * 补测跑完也要收敛勾选。虽然这条路径测的是「还没有画像的」模型，
               * 但它同样会产生新画像——新画像跨过门槛的模型会因此被纳入，低于
               * 门槛的会被剔除。与「重测全部」保持同一套语义，用户不必记两条路径。
               */
              const cut = applyThroughputCut()
              if (cut.changed.length > 0) void refresh().catch(() => {})
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
        /**
         * 必须显式拒绝坏 body。
         *
         * 早先只写 `patch?.force === true`，于是「70KiB 的 body」或「根本不是
         * JSON」都会被当成合法请求——**直接触发一轮近百模型的全量探测**，
         * 白白消耗额度，对上游也是一串密集请求。
         */
        if (patch === undefined) return send(400, { error: 'request body must be a JSON object' })
        if (patch.__tooLarge === true) return send(413, { error: 'request body is too large (max 64 KiB)' })
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
        /**
         * 把 `runProbe` 的**真实结果**合并进应答。
         *
         * 早先这里是 `send(200, { started: true, candidates, ...probeSnapshot() })`，
         * 而 `probeSnapshot()` 不含 `started`——于是 `runProbe` 返回的
         * `{started:false, reason:'...'}` 被整个丢掉，`started` 恒为 true。
         *
         * 后果：前端 `started !== true` 的提示分支是死代码，「已有一轮在跑」、
         * 「60 秒冷却」、「所有模型都已有画像」这些真实原因永远显示不出来；
         * 前端反而进入轮询、1.5 秒后看到 running=false，最终提示「测速完成：
         * 0 个模型」——把「没开始」显示成「测完了但一个都没测」。
         */
        const result = await runProbe({
          list, base, key, force,
          speedMemoryMinutes: config.speedMemoryMinutes,
          minTokensPerSecond: config.minTokensPerSecond,
          onProgress: (done, total) => {
            if (done % 25 === 0 || done === total) log(`速度探测 ${done}/${total}`)
          },
        }).catch(error => {
          logger.warn?.(`[baipiao] 速度探测失败：${String(error?.message ?? error)}`)
          return { started: false, total: 0, reason: String(error?.message ?? error) }
        })
        /**
         * 「重测全部」跑完之后，把四条链的勾选收敛到**通过吞吐门槛**的那批。
         *
         * 这是用户要的「重测全部后默认只选 ≥ 门槛的模型」：不是再加一道运行时
         * 过滤（那已经有了），而是直接改勾选清单，让设置页显示的就是实际在用的。
         *
         * 只在真跑完时做——被取消的一轮（`cancelled`）样本不全，据此改清单会
         * 误杀还没测到的模型。
         */
        const cut = result.started === true && result.cancelled !== true
          ? applyThroughputCut()
          : null
        return send(200, { ...probeSnapshot(), candidates: list.length, ...result, cut })
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
        if (patch.__tooLarge === true) return send(413, { error: 'request body is too large (max 64 KiB)' })
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
        /**
         * 空集合必须写成哨兵：空串的语义是「没动过 → 用自动分层全量」，
         * 直接把空集合 join 成 '' 会把「取消最后一个」反转成「恢复全部」。
         */
        config[field] = encodeMembers(next)
        /**
         * Custom 只要被用户动过一次，就切到 `explicit`。
         *
         * 这是「取消某个模型没用」的根因修法：auto 会把候选池里没列出的模型
         * 补回来，于是取消动作被无声撤销。切到 explicit 后，链严格等于这份
         * 清单，取消就是真的取消。
         */
        if (key === 'custom') config.customMode = 'explicit'
        persistSettings(config)
        // await：让页面紧跟着读到的 /state 就是变更后的结果（见下方注释）
        await refresh().catch(() => {})
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
        if (patch.__tooLarge === true) return send(413, { error: 'request body is too large (max 64 KiB)' })
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
          config[field] = encodeMembers(baselineSet)
          if (key === 'custom') config.customMode = 'explicit'
          persistSettings(config)
          await refresh().catch(() => {})
          try { ctx.emit('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }
          log(`${CHAIN_LABELS[key]} 批量${patch.checked === true ? '选中' : '取消'} ${subset.length} 个`)
          return send(200, viewConfig())
        }
        /**
         * ## 全选 = 勾上**列表里现有的每一个**，语义上不留任何例外
         *
         * 用户的要求很明确：「全选就是选择下面所有的模型，取消全选就是一个都
         * 不选中」。所以这里必须写成**显式全集**，而不是早先那种「写空串，
         * 让自动分层重新挑一遍」。
         *
         * 写空串曾经看起来更优雅（空串 = 没动过 = 自动分层全量），但它有两个
         * 实测可见的毛病：
         *
         *   1. 自动分层对三条价格链会再套一层 `cap()`（每条链 40 个、单渠道
         *      6 个），于是「全选 35 个」之后链里只有 12 个——用户点了全选，
         *      列表上却只勾了一半；
         *   2. 空串与「用户从没动过」无法区分，页面无法表达「我确实全选了」。
         *
         * 现在：全选写 `encodeMembers(该链候选全集)`，并用 `capFor` 让显式
         * 勾选不再被截断。
         */
        if (patch.checked === true) {
          config[field] = encodeMembers(chainCandidates(key).map(row => String(row.id ?? '').toLowerCase()))
          /**
           * Custom 的「全选」也写**显式全集**，不再是「回到 auto」。
           *
           * 早先这里切到 `auto`（跟随候选池），理由是「以后新上架的模型会
           * 自动进来」。但那与用户对全选的定义冲突：全选就该是「这些全都勾上」，
           * 而且 `auto` 模式下 `customModels` 是空的，页面读 `members` 得到
           * `mode: 'auto'`、勾选数量 0——用户点了全选，看起来一个都没勾上
           * （实测：96 个候选，勾选显示 0）。
           *
           * 切成 explicit 还有个额外好处：它与「取消某个模型」的语义一致
           * （取消就是真的取消，不会被 auto 补回来）。
           */
          if (key === 'custom') config.customMode = 'explicit'
        } else {
          // 全不选：显式哨兵（空串会被理解成「全选」）。
          config[field] = NONE_SELECTED
          /**
           * Custom 的「全不选」= explicit + 空清单。
           *
           * 关键：**链空了，但候选模型一个都不能消失**。设置页的列表来自
           * 候选池，与链成员无关，所以取消全部勾选后模型仍然逐个列着，
           * 用户可以自己再挑回来。
           */
          if (key === 'custom') config.customMode = 'explicit'
        }
        persistSettings(config)
        await refresh().catch(() => {})
        try { ctx.emit('llm/adapters-updated') } catch { /* 老内核没有这个事件 */ }
        log(`${CHAIN_LABELS[key]} 已${patch.checked === true ? '全选' : '全不选'}`)
        return send(200, viewConfig())
      }
      if (method === 'POST' && route === '/config') {
        const patch = await readJson()
        if (patch === undefined) return send(400, { error: 'request body must be a JSON object' })
        if (patch.__tooLarge === true) return send(413, { error: 'request body is too large (max 64 KiB)' })
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
 * 内核附件服务 → 图片解析器（attachment → data URL）。
 *
 * ## 为什么要经过内核
 *
 * harness 的图片块只带 `attachmentId`，**没有字节也没有 URL**；真正的文件由
 * 内核的 `attachments` 服务管理。所以「把图发给上游」唯一正确的路径是：
 *
 *   `ctx.get('attachments').imageHostPath(ref)` → 读该文件 → 拼 data URL
 *
 * ## 为什么每次调用都重新 `ctx.get`
 *
 * 这是 cordis 的一个真坑：服务可能在插件 `apply` **之后**才被提供。在 apply
 * 时读一次并缓存住，会在「那时还没有 attachments」的组合里永久降级，而且
 * 日志里什么都看不到。所以按需查（代价可忽略）。
 *
 * ## 为什么要有上限与缓存
 *
 * 单图 8 MiB 是上游普遍收紧的请求体限制；缓存按 attachmentId（同一张图在一次
 * 会话里会被反复引用），超过 48 条就整体清空——比维护 LRU 简单，且够用。
 *
 * ## 拿不到就返回 undefined
 *
 * 由 `resolveImageUrl` 退化为占位文本。**绝不**因为读不到图就让整个请求失败：
 * 一张图丢了是图片问题，整轮失败是功能问题，后者严重得多。
 *
 * @param {object} ctx - 插件上下文
 * @param {{warn?:(msg:string)=>void}} logger
 * @returns {(attachment:object)=>string|undefined}
 */
function createImageResolver(ctx, logger) {
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return attachment => {
    const id = String(attachment?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
      if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
      const hostPath = attachments.imageHostPath(attachment)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) {
        logger.warn?.(`[baipiao] 图片 ${id} 有 ${size} 字节，超过 ${MAX_IMAGE_BYTES} 的发送上限，跳过`)
        return undefined
      }
      const media = typeof attachment.mediaType === 'string' && attachment.mediaType !== ''
        ? attachment.mediaType
        : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`[baipiao] 读取图片 ${id} 失败：${String(error?.message ?? error)}`)
      return undefined
    }
  }
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
  const body = toChatBody(options, { resolveImage: createImageResolver(ctx, logger) })
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
    const speed = { chars: 0, text: '', firstTextAt: 0, tooSlow: false }
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
          /**
           * 累积实际正文文本。`chars` 仍然保留（样本够不够长按字符判断），
           * 但 token 数必须按语言折算——中文按 1 字 1 token，否则正常中文回答
           * 会被稳定低估 3 倍、被判成慢模型（见 `estimateTps`）。
           */
          if (chunk.type === 'text-delta') {
            const delta = String(chunk.text ?? '')
            speed.text += delta
            speed.chars += delta.length
          }

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
              const tps = estimateTps(speed.text, elapsed)
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
      const tps = estimateTps(speed.text, elapsed)
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
        tps: estimateTps(speed.text, genMs),
      })
    }
    if (!speedEnabled || speed.chars === 0) {
      markFast(candidate.id)
    } else {
      const genMs = Math.max(1, Date.now() - speed.firstTextAt)
      if (estimateTps(speed.text, genMs) >= minTps) markFast(candidate.id)
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
