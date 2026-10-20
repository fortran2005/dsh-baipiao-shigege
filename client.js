/**
 * dsh-baipiao-shigege —— 浏览器半身。
 *
 * 在设置侧边栏贡献一页「baipiao-shiggege」，展示三条链的实时分层结果，并提供
 * 阈值 / 刷新间隔等设置项。
 *
 * 数据来源：宿主半身注册的 `/api/baipiao-stone/state` 与 `/config` 路由。
 * 页面本身不抓网关，因为浏览器到 `127.0.0.1:8326` 的跨源请求会被网关的
 * 信任围栏拒绝——由宿主代取，浏览器只读结果。
 *
 * 手写 ModuleLoader bundle：无构建步骤，除 shell 提供的 react 外无依赖。
 * 所有颜色走主题变量，切换深浅色不用改代码。
 */
window.__ModuleLoader__.load({
  id: 'dsh-baipiao-shigege',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback } = React

    const NS = 'settings.baipiaoStone'
    const inject = ['slots', 'locale']

    // ── 文案 ────────────────────────────────────────────────────────────────

    const DICT = {
      zh: {
        /**
         * 左侧导航与设置页的显示名。
         *
         * 用户要求导航栏写中文「白嫖-石哥哥」——原来那串 `baipiao-shiggege`
         * 是 provider id 样式，放在中文导航里既不是模型名也不易读。
         * provider id 本身不变（`baipiao`），只换显示名。
         */
        navLabel: '白嫖-石哥哥',
        sectionLabel: '白嫖-石哥哥',
        title: '白嫖-石哥哥',
        sub: '把白嫖渠道模型按价格自动分成三条 1M 降级链，另加一条自定义链（自己挑模型）。',
        refreshNow: '立即重新分层',
        callableModels: '个模型可调用',
        creditsLeft: '可用积分',
        creditsExpiring: '其中快到期',
        creditsUpdating: '可用积分（更新中…）',
        creditsStale: '已重新分层；本轮余额查询未成功，积分沿用上次的数值',
        creditsStillUpdating: '已重新分层；余额查询仍在进行，稍后会自动更新',
        creditsQuota: '另有 {n} 个额度型渠道（按天给额度，不计入积分）',
        refreshing: '正在重新分层…',
        statusOk: '上次分层：{time}',
        statusFailed: '分层失败：{reason}',
        statusNever: '尚未完成首次分层',
        chain: '链路',
        links: '候选',
        context: '上下文',
        image: '图片',
        providers: '渠道',
        yes: '支持',
        no: '不支持',
        empty: '这条链当前没有候选模型',
        settings: '设置',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        probeStart: '测速（后台跑）',
        probeForce: '重测全部',
        probeStop: '停止测速',
        probeRunning: '测速中 {done}/{total}',
        probeDone: '测速完成：{n} 个模型；已按 {cut} tok/s 收敛勾选（{changed}）',
        probeCutNone: '无需收敛',
        probeIdle: '测速：测出每个模型的实际速度，用来按速度挑模型',
        probeEmpty: '所有模型都已有速度数据',
        speedCol: '实测速度',
        autoProbe: '重新分层时自动测速',
        autoProbeHint: '默认关闭。开启后每点一次「立即重新分层」都会在后台补测全部模型——那是近百个请求，对账号风控不友好。需要时用上方「测速」按钮手动触发即可，日常按倍率与已有画像排序，功能不受影响。',
        saveFailed: '保存失败：{reason}',
        reset: '恢复默认',
        note: '改动保存后立即生效，无需重启。倍率与模型清单由渠道网关提供，插件每 {n} 分钟自动同步一次。',
        gatewayUrl: '渠道网关地址',
        gatewayUrlHint: '渠道包自带的本地 OpenAI 网关，不含 /v1',
        gatewayKey: '网关 Key',
        gatewayKeyHint: '留空则自动读取 ~/.dsh/openai-gateway/api-key',
        gatewayKeySet: '已配置。留空表示不修改；输入新值可覆盖',
        gatewayKeyPlaceholder: '已配置（留空不变）',
        refreshMinutes: '重新分层间隔（分钟）',
        refreshMinutesHint: '0 表示只在启动时拉取一次',
        lowMaxRate: '低积分倍率上界',
        lowMaxRateHint: '超过此倍率归入「高积分」',
        longContextMin: '1M 链上下文门槛',
        longContextMinHint: '同时要求模型支持图片输入',
        maxLinks: '每条链候选上限',
        absurdRate: '排除倍率高于',
        absurdRateHint: '避开 20x 这类不划算的模型',
        preferExpiringCredits: '优先用完快到期的积分',
        preferExpiringCreditsHint: '查不到余额的渠道按中间优先级处理，不会被永远排到最后',
        expiryLookup: '查询积分余额',
        expiryLookupHint: '关掉后本插件不依赖任何其它插件；排序退化为按倍率',
        firstTokenTimeoutMs: '首字等待上限（毫秒）',
        firstTokenTimeoutMsHint: '第一个字等超过这么久就换下一个模型；重思考模型往往先想 9 秒以上，0 = 一直等',
        slowTtfbMs: '首字慢于多少毫秒算「启动慢」',
        slowTtfbMsHint: '首字慢的模型下轮排到链尾，避免每次都重新忍受',
        maxSlowSkips: '单次最多放弃几个慢模型',
        maxSlowSkipsHint: '放弃一个就要付出一个超时的代价，太多反而更慢；0 = 不放弃',
        minTokensPerSecond: '最低速度（tokens/秒）',
        minTokensPerSecondHint: '输出低于这个速度就换下一个模型，并把它排到链尾；0 = 不判定',
        excludeBelowTps: '吞吐淘汰线（tokens/秒）',
        excludeBelowTpsHint: '实测吞吐低于这个值的模型直接移出全部链（等于取消选择）。点「重测全部」跑完后，四条链的勾选会自动收紧到通过这条线的模型；没测过的模型不受影响，0 = 不淘汰',
        fastBandSize: '快速档大小（同时轮换几个）',
        fastBandSizeHint: '只有吞吐最高的前 N 个模型参与轮流调用。档内轮流当链首，档外只在档内全失败时兜底。1 = 永远只用最快的那个',
        throughputBandTps: '吞吐分档档宽（tokens/秒）',
        throughputBandTpsHint: '跨档按吞吐排，同档内按到期→倍率排；0 = 严格按吞吐降序',
        probeOnStartup: '启动时自动重测全部',
        probeOnStartupHint: '每次打开软件后自动跑一轮「重测全部」，这样吞吐排序和淘汰线当天就是新鲜的。后台进行，不影响对话',
        startupProbeSkipMinutes: '启动重测的跳过窗口（分钟）',
        startupProbeSkipMinutesHint: '上一轮测速在这个时间内完成过，启动时就不重复测；0 = 每次都测',
        accountExpiryFirst: '账号优先用快到期的',
        accountExpiryFirstHint: '把积分最快作废的账号排到该渠道的选号第一位，会写回渠道包的账号顺序',
        accountRotation: '其余账号轮流使用',
        accountRotationHint: '除快到期账号外，其余账号轮流当第一顺位，避免用量集中在少数账号上',
        accountReorderMinutes: '账号顺序重排间隔（分钟）',
        accountReorderMinutesHint: '重排会写渠道包的设置文件，不需要每轮都写；0 = 每轮都重排',
        droppedTitle: '已淘汰（实测低于吞吐线）',
        droppedNone: '没有——没有被淘汰的模型',
        droppedHint: '这些模型实测吞吐低于淘汰线，已从四条链里移除。把淘汰线调低或清空速度画像可以找回',
        fastBandTitle: '快速档（参与轮换的模型）',
        fastBandNone: '链里还没有候选',
        fastBandHint: '每次请求在快速档内轮流选链首：既优先用快的，又不会把用量全压在第一名上。档内全部失败时才降级到档外',
        accountPlanTitle: '账号顺序（快到期优先 + 轮流）',
        accountPlanNone: '还没有重排过——需要「查询积分余额」开着，并等一轮余额查询完成',
        accountPlanChanged: '已重排',
        accountPlanSame: '顺序未变',
        accountPlanExpiring: '先到期 {n} 个',
        droppedTag: '已淘汰',
        tpsTag: '吞吐',
        droppedStat: '个已淘汰',
        speedSampleMs: '测速观察窗口（毫秒）',
        speedSampleMsHint: '样本太短会被网络抖动放大，默认 3 秒',
        slowMemoryMinutes: '慢模型记忆（分钟）',
        slowMemoryMinutesHint: '过期后重新给它机会，避免一次慢就永久垫底',
        speedMemoryMinutes: '速度画像记忆（分钟）',
        speedMemoryMinutesHint: '记录每个模型实测的首字延迟与吞吐，用于自动排序',
        preferMeasuredSpeed: '按实测速度重排候选',
        preferMeasuredSpeedHint: '实测快的浮到链首、实测慢的沉底，链会越用越快；关掉则回到按倍率排序',
        preferThroughput: '按整轮吞吐排序',
        preferThroughputHint: '排序键 = 首字 + 生成长度/吞吐。吞吐大的模型即使在首字上慢一点，整体也更早写完',
        expectedOutputTokens: '估算用的输出量（token）',
        expectedOutputTokensHint: '越大越偏向高吞吐模型（长回答）；越小越偏向首字快的模型（短问答）',
        customMode: 'Custom 严格按勾选',
        customModeAuto: '跟随候选池（自动）',
        customModeExplicit: '严格按勾选（推荐）',
        customModeHint: '开启后 Custom 只包含你勾选的模型，取消一个就真的少一个；关闭则整个候选池都进链',
        speedProfiles: '实测速度画像（首字延迟 / 吞吐）',
        speedProfilesNone: '还没有实测数据——用几次之后这里会显示每个模型的实际速度',
        slowModels: '当前被标记为慢的模型',
        slowModelsNone: '没有——所有模型都在正常速度',
        clearSlow: '清除慢模型记忆',
        pickModelsShort: '选择模型',
        expiringWindowDays: '「快过期」判定窗口（天）',
        expiringWindowDaysHint: '剩余积分在这个天数内到期，就先把它用掉',
        perProviderLinks: '单渠道候选上限',
        perProviderLinksHint: '避免一个渠道故障吃掉整条链',
        verbose: '打印分层日志',
        total: '共 {n} 个渠道模型参与分层',
        free: 'shigege-Free points',
        low: 'shigege-Low points',
        high: 'shigege-Premium points',
        custom: 'shigege-Custom',
        customModels: '自定义模型（逗号分隔）',
        customModelsHint: '从 13 个平台挑模型 id 填进来，只进 Custom 链、不进自动分层；改名/下架的会自动移除',
        searchModels: '搜索模型…',
        searchModelsInChain: '在本链里搜索模型…',
        clearSearch: '清除搜索',
        searchMatched: '匹配 {n} 个',
        searchNoMatch: '没有匹配的模型',
        addToCustom: '加入',
        removeFromCustom: '移出',
      },
      en: {
        navLabel: 'Free-pick · Shigege',
        sectionLabel: 'Free-pick · Shigege',
        title: 'Free-pick · Shigege',
        sub: 'Three 1M price-tier fallback chains plus a custom chain you pick yourself.',
        refreshNow: 'Re-tier now',
        callableModels: 'models callable',
        creditsLeft: 'credits left',
        creditsExpiring: 'expiring soon',
        creditsUpdating: 'credits left (updating…)',
        creditsStale: 'Re-tiered; this balance refresh failed, credits kept from the last successful one',
        creditsStillUpdating: 'Re-tiered; the balance refresh is still running and will update shortly',
        creditsQuota: '+{n} quota-based channels (daily allowance, not counted)',
        refreshing: 'Re-tiering…',
        statusOk: 'Last tiered: {time}',
        statusFailed: 'Tiering failed: {reason}',
        statusNever: 'No successful tiering yet',
        chain: 'Chain',
        links: 'Links',
        context: 'Context',
        image: 'Images',
        providers: 'Channels',
        yes: 'yes',
        no: 'no',
        empty: 'No candidates in this chain right now',
        settings: 'Settings',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        probeStart: 'Measure speeds',
        probeForce: 'Re-measure all',
        probeStop: 'Stop',
        probeRunning: 'Measuring {done}/{total}',
        probeDone: 'Done: {n} models measured; selection narrowed to >= {cut} tok/s ({changed})',
        probeCutNone: 'nothing to narrow',
        probeIdle: "Measure each model's real speed so you can pick fast ones",
        probeEmpty: 'All models already have speed data',
        speedCol: 'Measured speed',
        autoProbe: 'Auto-measure on re-tier',
        autoProbeHint: 'Off by default. When on, every Re-tier fires a full background sweep (~100 requests), which upstream platforms tend to flag. Use the Measure buttons instead; daily ordering still works from rates and existing profiles.',
        saveFailed: 'Save failed: {reason}',
        reset: 'Reset to defaults',
        note: 'Changes apply immediately; no restart needed. Rates and rosters come from the channel gateway, re-synced every {n} minutes.',
        gatewayUrl: 'Channel gateway URL',
        gatewayUrlHint: 'The channel pack\'s local OpenAI gateway, without /v1',
        gatewayKey: 'Gateway key',
        gatewayKeyHint: 'Leave empty to read ~/.dsh/openai-gateway/api-key',
        gatewayKeySet: 'Configured. Leave empty to keep it, or type a new value',
        gatewayKeyPlaceholder: 'configured (leave empty)',
        refreshMinutes: 'Re-tier interval (minutes)',
        refreshMinutesHint: '0 means fetch once at startup',
        lowMaxRate: 'Low-tier rate ceiling',
        lowMaxRateHint: 'Anything above this rate is billed as high tier',
        longContextMin: '1M chain context floor',
        longContextMinHint: 'The model must also accept images',
        maxLinks: 'Max candidates per chain',
        absurdRate: 'Exclude rates above',
        absurdRateHint: 'Skips traps like 20x models',
        preferExpiringCredits: 'Spend expiring credits first',
        preferExpiringCreditsHint: 'Channels whose balance cannot be read sit in the middle, never last',
        expiryLookup: 'Query credit balances',
        expiryLookupHint: 'Off means this plugin depends on nothing else; ordering falls back to rate',
        firstTokenTimeoutMs: 'First-token wait limit (ms)',
        firstTokenTimeoutMsHint: 'Switch models if the first word takes longer than this; heavy reasoners often think 9s+ first, 0 = wait forever',
        slowTtfbMs: 'Slow-start threshold (ms)',
        slowTtfbMsHint: 'Models slower to first token move to the chain tail next round',
        maxSlowSkips: 'Max slow models to skip per request',
        maxSlowSkipsHint: 'Each skip costs a full timeout, so too many is slower; 0 = never skip',
        minTokensPerSecond: 'Minimum speed (tokens/s)',
        minTokensPerSecondHint: 'Slower than this and the chain moves on, demoting the model to the tail; 0 disables',
        excludeBelowTps: 'Throughput cut-off (tokens/s)',
        excludeBelowTpsHint: 'Models measured below this are removed from every chain. After a full re-measure, each chain is auto-narrowed to the models above this line. Unmeasured models are kept; 0 disables',
        fastBandSize: 'Fast band size (how many rotate)',
        fastBandSizeHint: 'Only the N fastest models rotate as chain head. The rest stay as fallback. 1 = always the single fastest',
        throughputBandTps: 'Throughput band width (tokens/s)',
        throughputBandTpsHint: 'Across bands throughput wins, inside a band expiry then rate wins; 0 = strict throughput order',
        probeOnStartup: 'Re-measure all on startup',
        probeOnStartupHint: 'Runs a full measurement after every launch so ordering and the cut-off are fresh. Background only',
        startupProbeSkipMinutes: 'Startup probe skip window (minutes)',
        startupProbeSkipMinutesHint: 'Skip the startup sweep if the last one finished within this window; 0 = always run',
        accountExpiryFirst: 'Use expiring accounts first',
        accountExpiryFirstHint: 'Puts the account whose credits expire soonest first in the channel-pack account order',
        accountRotation: 'Rotate the remaining accounts',
        accountRotationHint: 'The other accounts take turns as first choice so usage does not pile on a few',
        accountReorderMinutes: 'Account reorder interval (minutes)',
        accountReorderMinutesHint: 'Reordering writes the channel-pack settings file; 0 = on every tiering',
        droppedTitle: 'Dropped (below the throughput cut-off)',
        droppedNone: 'None — nothing has been dropped',
        droppedHint: 'These measured below the cut-off and are out of all four chains. Lower the cut-off or clear speed profiles to bring them back',
        fastBandTitle: 'Fast band (the models that rotate)',
        fastBandNone: 'This chain has no candidates yet',
        fastBandHint: 'Each request rotates the chain head inside the fast band, so it is both fast and spread out. Falls back outside the band only if the whole band fails',
        accountPlanTitle: 'Account order (expiring first, then rotate)',
        accountPlanNone: 'No reorder yet — needs credit-balance lookup on and one completed balance sweep',
        accountPlanChanged: 'reordered',
        accountPlanSame: 'unchanged',
        accountPlanExpiring: '{n} expiring first',
        droppedTag: 'dropped',
        tpsTag: 'tps',
        droppedStat: 'dropped',
        speedSampleMs: 'Speed sample window (ms)',
        speedSampleMsHint: 'Shorter samples get inflated by network jitter; 3 s is the default',
        slowMemoryMinutes: 'Slow-model memory (minutes)',
        slowMemoryMinutesHint: 'Expires so one bad turn does not bench a model forever',
        speedMemoryMinutes: 'Speed profile memory (minutes)',
        speedMemoryMinutesHint: 'Records measured first-token latency and throughput for ordering',
        preferMeasuredSpeed: 'Reorder by measured speed',
        preferMeasuredSpeedHint: 'Fast models float up, slow ones sink; the chain gets faster with use',
        preferThroughput: 'Order by end-to-end throughput',
        preferThroughputHint: 'Sort key = first token + output length / throughput; high-throughput models finish sooner overall',
        expectedOutputTokens: 'Expected output (tokens)',
        expectedOutputTokensHint: 'Larger favors high-throughput models (long answers); smaller favors fast first tokens (short Q&A)',
        customMode: 'Custom follows the checklist only',
        customModeAuto: 'Follow candidate pool (auto)',
        customModeExplicit: 'Checklist only (recommended)',
        customModeHint: 'On: Custom holds exactly the models you checked, so unchecking really removes one. Off: the whole pool joins the chain',
        speedProfiles: 'Measured speed profiles (TTFB / throughput)',
        speedProfilesNone: 'No measurements yet; use it a few times and real speeds appear here',
        slowModels: 'Models currently marked slow',
        slowModelsNone: 'None — every model is running at normal speed',
        clearSlow: 'Clear slow-model memory',
        pickModelsShort: 'Pick models',
        expiringWindowDays: 'Expiring window (days)',
        expiringWindowDaysHint: 'Credits lapsing within this many days get used first',
        perProviderLinks: 'Max candidates per channel',
        perProviderLinksHint: 'Keeps one failing channel from eating a whole chain',
        verbose: 'Log tiering results',
        total: '{n} channel models tiered',
        free: 'shigege-Free points',
        low: 'Low credits',
        high: 'High credits',
        /**
         * Custom 链与自定义模型选择器的文案。
         *
         * 这几条以前只写在 zh 字典里，英文界面会回落到中文（`t()` 的兜底就是
         * 中文原文）。补齐后两个语言各有一套完整键集。
         */
        custom: 'shigege-Custom',
        customModels: 'Custom models (comma-separated)',
        customModelsHint: 'Pick model ids from the platforms; they only go into Custom, never auto-tiered; renamed ones auto-removed',
        searchModels: 'Search models…',
        searchModelsInChain: 'Search models in this chain…',
        clearSearch: 'Clear search',
        searchMatched: '{n} matched',
        searchNoMatch: 'No matching models',
        addToCustom: 'Add',
        removeFromCustom: 'Remove',
      },
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const CSS = `
.bps_root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);}
.bps_hero{display:flex;flex-direction:column;gap:6px;}
.bps_hero h2{margin:0;font-size:17px;font-weight:600;letter-spacing:-.2px;}
.bps_sub{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);}
.bps_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.bps_btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border-radius:9px;padding:6px 12px;font:inherit;font-size:12.5px;
  cursor:pointer;transition:background .14s ease,border-color .14s ease;}
.bps_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}
.bps_btn:disabled{opacity:.55;cursor:default;}
.bps_btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff;}
.bps_btn.primary:hover:not(:disabled){filter:brightness(1.06);}
.bps_btn.ghost{background:transparent;}
.bps_note{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}
.bps_err{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#d9534f);}
.bps_ok{margin:0;font-size:12px;color:var(--dsw-alias-state-success-primary,#2e9e5b);}
.bps_chains{display:flex;flex-direction:column;gap:12px;}
/* 每张链卡片占一整行，卡片内每个模型一行一个——宽度足够放完整 id 与速度。 */
.bps_checkrow{display:flex;align-items:center;}
.bps_checkrow .bps_check{flex:1;min-width:0;}
.bps_checkrow .bps_linkid{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bps_cardoff{opacity:.55;}
.bps_btnsave{border-color:#3ECFA0;color:#3ECFA0;}
.bps_btnsave:hover{background:color-mix(in srgb,#3ECFA0 14%,transparent);}
.bps_toggle{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary);border-radius:7px;padding:2px 9px;font:inherit;
  font-size:11px;cursor:pointer;}
.bps_toggle:hover{border-color:var(--dsw-alias-state-business-primary);
  color:var(--dsw-alias-state-business-primary);}
.bps_checkbox{flex:0 0 auto;margin:0;accent-color:#9B6BFF;}
.bps_linkrow{display:flex;align-items:center;gap:7px;}
.bps_linkid{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bps_linkon{color:var(--dsw-alias-state-business-primary);font-weight:600;}
.bps_mini{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:0 6px;font:inherit;
  font-size:12px;line-height:17px;cursor:pointer;}
.bps_mini:hover{border-color:#E36AA6;color:#E36AA6;}
.bps_minion{font-size:11px;padding:0 7px;}
.bps_minion:hover{border-color:var(--dsw-alias-state-business-primary);
  color:var(--dsw-alias-state-business-primary);}
.bps_toggleon{border-color:var(--dsw-alias-state-business-primary);
  color:var(--dsw-alias-state-business-primary);}
.bps_card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  border-radius:12px;padding:12px 13px;display:flex;flex-direction:column;gap:8px;
  border-left-width:3px;border-left-style:solid;}
.bps_cardhead{display:flex;align-items:center;gap:8px;}
.bps_cardname{font-size:13.5px;font-weight:600;letter-spacing:-.1px;display:flex;align-items:center;gap:7px;}
.bps_dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent);}
.bps_count{margin-left:auto;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);white-space:nowrap;}
.bps_cap{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}
.bps_tag{padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);}
.bps_list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;
  max-height:190px;overflow:auto;}
.bps_list li{display:flex;align-items:baseline;gap:7px;font-size:11.5px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);}
.bps_rate{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}
.bps_form{display:grid;grid-template-columns:repeat(auto-fit,minmax(268px,1fr));gap:12px;}
.bps_field{display:flex;flex-direction:column;gap:4px;}
.bps_field label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);}
.bps_field input[type=text],.bps_field input[type=number]{width:100%;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;}
.bps_field input:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);
  outline-offset:1px;border-color:transparent;}
.bps_speed{flex:0 0 auto;font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary);min-width:74px;text-align:right;}
.bps_speedfast{color:#3ECFA0;}
.bps_speedslow{color:#E36AA6;}
.bps_check{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;}
.bps_hint{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary);}
/* 链内搜索：一条细搜索行，不抢卡片本身的视觉重心。 */
.bps_csearchrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.bps_csearch{box-sizing:border-box;flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  border-radius:7px;padding:4px 9px;font:inherit;font-size:11.5px;}
.bps_csearch:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);
  outline-offset:1px;border-color:transparent;}
.bps_csearch::placeholder{color:var(--dsw-alias-label-tertiary);}
.bps_csearchclear{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);
  cursor:pointer;font-size:15px;line-height:1;padding:2px 5px;border-radius:5px;}
.bps_csearchclear:hover{color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);}
.bps_csearchhint{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;}
.bps_stats{display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;
  padding:10px 13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);}
.bps_stat{display:flex;align-items:baseline;gap:6px;}
.bps_statnum{font-size:16px;font-weight:650;letter-spacing:-.3px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);}
.bps_statlabel{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.bps_statwarn .bps_statnum{color:#F2A65A;}
.bps_section{display:flex;flex-direction:column;gap:10px;padding-top:4px;}
.bps_sectiontitle{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);}
.bps_picker{display:flex;flex-direction:column;gap:8px;}
.bps_search{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:6px 10px;font:inherit;font-size:12.5px;}
.bps_pickerlist{margin:0;padding:0;list-style:none;max-height:320px;overflow:auto;
  display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;padding:6px;background:var(--dsw-alias-bg-layer-1);}
.bps_pickitem{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;
  cursor:pointer;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.bps_pickitem:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);}
.bps_pickon{background:color-mix(in srgb,#9B6BFF 12%,transparent);}
.bps_pickid{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary);}
.bps_picktag{flex:0 0 auto;font-size:11px;}
/* 已淘汰标记：与 👁 并排，用弱化的红色，不抢 id 的视线。 */
.bps_droppedtag{color:var(--dsw-alias-state-error-primary,#e5484d);opacity:.85;}
.bps_pickrate{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}
.bps_pickbtn{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-state-business-primary);}
/* 主面板外壳：左导航入口点进来时用这一套，而不是设置对话框的窄栏。 */
.bps_page{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden;}
.bps_pagehead{flex:none;padding:26px clamp(20px,4vw,48px) 10px;}
.bps_pagetitle{margin:0;font-size:20px;font-weight:500;line-height:28px;letter-spacing:-.2px;}
.bps_pagebody{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;
  padding:4px clamp(20px,4vw,48px) 48px;}
.bps_pagebody .bps_root{max-width:960px;margin:0 auto;}
`

    // ── 宿主接口 ────────────────────────────────────────────────────────────

    /**
     * 同源 HTTP 前缀路由（`/api/baipiao-stone`）。
     *
     * 不走 `ctx.remote`：Typert Remote 需要在宿主侧再注册一份类型清单，那套
     * 清单在热升级时会缓存旧版本；前缀路由是 `our-free-model` 已经在用的稳定
     * 接口，浏览器拿到的就是宿主进程的实时状态。
     *
     * 也**不**让浏览器直接请求 `127.0.0.1:8326`：那是另一个源，会被网关的
     * 信任围栏挡下，而且网关 Key 不该出现在页面里。
     */
    const API_BASE = '/api/baipiao-stone'

    function makeApi() {
      const call = async (path, init) => {
        let response
        try {
          response = await fetch(API_BASE + path, {
            credentials: 'same-origin',
            headers: { accept: 'application/json', ...init?.body === undefined ? {} : { 'content-type': 'application/json' } },
            ...init,
          })
        } catch (error) {
          throw new Error(`无法连接宿主接口：${String(error?.message ?? error)}`)
        }
        const text = await response.text()
        let body
        try { body = text === '' ? {} : JSON.parse(text) } catch { body = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return body
      }
      return {
        state: () => call('/state'),
        config: () => call('/config'),
        saveConfig: patch => call('/config', { method: 'POST', body: JSON.stringify(patch) }),
        refresh: () => call('/refresh', { method: 'POST', body: '{}' }),
        clearSlow: () => call('/slow/clear', { method: 'POST', body: '{}' }),
        // 单模型勾选 / 取消：立即保存。
        toggleMember: (key, id, checked) => call('/chain/toggle', { method: 'POST', body: JSON.stringify({ key, id, checked }) }),
        // 全选 / 全不选。`ids` 存在时只对这几个模型生效（搜索后的批量操作）。
        toggleAll: (key, checked, ids) => call('/chain/all', {
          method: 'POST',
          body: JSON.stringify(ids === undefined ? { key, checked } : { key, checked, ids }),
        }),
        // 速度探测：开跑 / 查进度 / 停止。
        probe: force => call('/probe', { method: 'POST', body: JSON.stringify({ force }) }),
        probeStatus: () => call('/probe/status'),
        probeStop: () => call('/probe/stop', { method: 'POST', body: '{}' }),
      }
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    const CHAIN_ORDER = ['free', 'low', 'high', 'custom']

    /**
     * 每条链的主题色。
     *
     * 模型选择器本身不接受颜色（它的描述对象只认 name / description /
     * inputModalities / context），所以「一眼看出四个模型」这件事只能在
     * 设置页里做到：卡片标题、左边框、色点都用这个色值。
     *
     * 色相按价位递增：中性蓝 → 绿 → 琥珀 → 紫红。
     */
    const CHAIN_COLORS = {
      free: '#3ECFA0',
      low: '#F2A65A',
      high: '#E36AA6',
      custom: '#9B6BFF',
    }

    /** 模块级 API 单例；`makeApi()` 只闭包了 `fetch` 与常量。 */
    let apiSingleton = null

    /**
     * 积分轮询的「代号」，用来作废过期的轮询。
     *
     * 用户连点两次「立即重新分层」时，两个 `followCredits` 会同时轮询并互相
     * 覆盖 `state`。用一个自增计数让后发起的那个顶掉前一个：每轮先比对代号，
     * 不一致就直接退出。
     *
     * 放在**模块级**而不是 `useRef`：shell 注入的 React 是精简实现，不能假设
     * `useRef` 存在（本文件其余部分也刻意只用 useState/useEffect/useCallback）。
     */
    let creditsWatch = 0

    const formatTime = value => {
      if (!Number.isFinite(value) || value <= 0) return '—'
      try { return new Date(value).toLocaleString() } catch { return '—' }
    }

    const humanContext = value => {
      if (!Number.isFinite(value) || value <= 0) return '—'
      return value >= 1000000 ? `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`
        : `${Math.round(value / 1024)}K`
    }

    const formatRate = value => (typeof value === 'number' && Number.isFinite(value) ? `x${value}` : '—')

    /**
     * 实测速度的显示格式。
     *
     * 用户的新规则是「按吞吐量从大到小排序」，所以**吞吐放在前面**——列表顺序
     * 由它决定，显示时它就该是最显眼的那个。首字延迟作为补充（`1.2s`），因为
     * 它仍然是「点下发送到看见第一个字」的体感来源。
     *
     * 两者都没有就是「—」，表示「还没测过」，而不是「很慢」——这个区别很重要，
     * 否则用户会以为模型坏了。
     */
    const formatSpeed = speed => {
      if (speed === null || speed === undefined) return '—'
      const ttfb = Number(speed.ttfb)
      const tps = Number(speed.tps)
      const parts = []
      if (Number.isFinite(tps) && tps > 0) parts.push(`${Math.round(tps)}t/s`)
      if (Number.isFinite(ttfb) && ttfb > 0) {
        parts.push(ttfb >= 1000 ? `${(ttfb / 1000).toFixed(1)}s` : `${Math.round(ttfb)}ms`)
      }
      return parts.length > 0 ? parts.join(' · ') : '—'
    }

    /**
     * 积分数字的显示格式。
     *
     * 积分可能上千，也可能是 0.04 这样的小数——两种情况都要能读。所以：
     * 小于 10 保留两位，小于 1000 保留一位整数化，再大就加千分位。用户看
     * 的是「大概还剩多少」，不需要账单级的精度。
     */
    const formatCredits = value => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value === 0) return '0'
      if (value < 10) return value.toFixed(2).replace(/\.?0+$/, '')
      if (value < 1000) return value.toFixed(1).replace(/\.0$/, '')
      return value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 一条链的卡片。
     *
     * `color` 是这个组件唯一的装饰性输入：左侧色条、标题色、色点都用它。
     * 四张卡片因此能一眼区分——这是模型选择器做不到的（那边不接受颜色），
     * 所以设置页要把这件事补上。
     */
    /**
     * 一条链的卡片：**每个模型一个复选框**，链头一个全选复选框。
     *
     * ## 交互
     *
     * - 链头复选框：勾 = 全选本链全部候选，取消 = 全不选；
     * - 每个模型前的复选框：勾 = 放进本链，取消 = 移出本链；
     * - **取消后模型仍在列表里可见**（它还在候选池与 Custom 里），随时能再勾上；
     * - 每次勾选**立即保存**，没有单独的「保存」按钮。
     *
     * `checklist` 就是该链的全部候选（宿主侧按档位算好），所以「可选」与
     * 「已选」在同一份列表里——这正是「取消后仍然可见」的实现方式。
     */
    function ChainCard({ t, name, chain, color, options, selected, onToggleOption, onToggleAll, busy }) {
      const links = Array.isArray(chain?.links) ? chain.links : []
      const accent = typeof color === 'string' && color !== '' ? color : undefined
      const list = Array.isArray(options) ? options : []
      /**
       * 本卡片的搜索词。
       *
       * 纯本地状态：每条链的候选集不同，搜索词天然是各自局部的；刷新 state
       * 不会重置它（组件没卸载），用户搜完连点几个复选框不会被打断。
       */
      const [query, setQuery] = useState('')
      const needle = query.trim().toLowerCase()
      const filtering = needle !== ''
      /**
       * 筛选结果。
       *
       * 匹配完整 id（含 provider 前缀），这样 glm、trae/glm、trae 都能
       * 命中——用户不需要记住是不是要带渠道名前缀。
       */
      const filtered = filtering
        ? list.filter(row => String(row.id).toLowerCase().includes(needle))
        : list
      const isOn = row => selected.has(String(row.id).toLowerCase())
      /**
       * 全选复选框的勾选状态**基于筛选结果**。
       *
       * 搜索时它回答的是「搜出来的这些是不是都选了」，而不是「整条链是不是
       * 都选了」——后者在搜索场景下没有意义，还会误导。
       */
      const allOn = filtered.length > 0 && filtered.every(isOn)
      const someOn = filtered.some(isOn)
      return h('div', {
        className: 'bps_card',
        style: accent === undefined ? undefined : { borderLeftColor: accent },
      },
      h('div', { className: 'bps_cardhead' },
        h('label', { className: 'bps_check bps_allcheck' },
          h('input', {
            type: 'checkbox', checked: allOn, disabled: busy,
            // indeterminate 由 ref 设置：它表示「部分选中」，比显示未选中更诚实。
            ref: el => { if (el != null) el.indeterminate = someOn && !allOn },
            // 搜索时把筛选结果一并带上：后端据此只动这几个，不碰整条链。
            /**
             * 每次都把**明确的 id 列表**传上去（不再传 undefined 表示「整条链」）。
             *
             * 两种语义原来混在一起：「不传 ids」= 整链置位，绕过后端对候选范围的
             * 计算；「传 ids」= 只动这几个。既然用户的要求是「全选就是选中下面
             * 全部」，那就统一按**列表**来做集合操作——页面看到哪些，就传哪些。
             * 搜索时自然只作用于筛选结果，这正是原来的设计意图。
             */
            onChange: () => onToggleAll(!allOn, (filtering ? filtered : list).map(row => row.id)),
          }),
          h('span', { className: 'bps_cardname', style: accent === undefined ? undefined : { color: accent } },
            accent === undefined ? null : h('span', { className: 'bps_dot', style: { background: accent } }),
            name)),
        h('span', { className: 'bps_count' }, filtering
          ? `${filtered.filter(isOn).length}/${filtered.length}`
          : `${links.length}/${list.length}`)),

      h('div', { className: 'bps_cap' },
        h('span', { className: 'bps_tag' }, `${t('context')} ≥${humanContext(chain?.contextWindow)}`),
        h('span', { className: 'bps_tag' }, `${t('image')}: ${chain?.vision === true ? t('yes') : t('no')}`)),

      /**
       * 搜索行。
       *
       * 只在有候选时出现——空链上放一个搜索框毫无意义。候选不多时也保留，
       * 因为「少数几个里定位」和「批量改」的诉求是一样的。
       */
      list.length === 0 ? null : h('div', { className: 'bps_csearchrow' },
        h('input', {
          type: 'search',
          className: 'bps_csearch',
          value: query,
          placeholder: t('searchModelsInChain'),
          disabled: busy,
          'aria-label': t('searchModelsInChain'),
          onChange: event => setQuery(event.target.value),
        }),
        filtering
          ? h('button', {
            type: 'button',
            className: 'bps_csearchclear',
            disabled: busy,
            onClick: () => setQuery(''),
            title: t('clearSearch'),
            'aria-label': t('clearSearch'),
          }, '×')
          : null,
        filtering
          ? h('span', { className: 'bps_csearchhint' },
            t('searchMatched').replace('{n}', String(filtered.length)))
          : null),

      list.length === 0
        ? h('p', { className: 'bps_note' }, t('empty'))
        : filtered.length === 0
          ? h('p', { className: 'bps_note' }, t('searchNoMatch'))
          : h('ul', { className: 'bps_list bps_checklist' },
            filtered.map(row => {
            const on = isOn(row)
            return h('li', { key: row.id, className: 'bps_checkrow' },
              h('label', { className: 'bps_check' },
                h('input', {
                  type: 'checkbox', checked: on, disabled: busy,
                  onChange: () => onToggleOption(row.id, !on),
                }),
                h('span', {
                  // 已勾选的用加粗区分：位置不动，但「选没选」依然一眼可辨。
                  className: on ? 'bps_linkid bps_linkon' : 'bps_linkid',
                }, row.id),
                row.vision === true ? h('span', { className: 'bps_picktag' }, '👁') : null,
                /**
                 * 已淘汰标记。
                 *
                 * 淘汰的模型**仍然留在列表里**（只是不进链），用户才能看到「它
                 * 为什么不在」并决定要不要调低门槛。勾上它不会有副作用——分层
                 * 时会再按同一判据过滤一遍。
                 */
                row.dropped === true ? h('span', { className: 'bps_picktag bps_droppedtag' }, t('droppedTag')) : null,
                // 实测速度：首字延迟 + 吞吐。没测过显示「—」，测过就一眼看出快慢。
                h('span', {
                  className: Number.isFinite(row.speed?.ttfb) && row.speed.ttfb > 10000
                    ? 'bps_speed bps_speedslow'
                    : (Number.isFinite(row.speed?.ttfb) ? 'bps_speed bps_speedfast' : 'bps_speed'),
                }, formatSpeed(row.speed)),
                h('span', { className: 'bps_rate' }, formatRate(row.rate))))
            })))
    }

    /**
    /**
     * 数字输入：空串表示「不设置」，交回默认值。
     *
     * 用本地 draft 而不是直接读 `value`：用户键入 `1.` 或清空时不该立刻提交，
     * 否则中间态会被当成合法值写进配置。失焦或回车才提交。
     */
    function NumberField({ label, hint, value, min, step, onCommit }) {
      const [draft, setDraft] = useState(String(value ?? ''))
      useEffect(() => { setDraft(String(value ?? '')) }, [value])
      const reset = () => setDraft(String(value ?? ''))
      const commit = () => {
        /**
         * 清空输入框 = **交回默认值**。
         *
         * 这里必须提交 `null` 而不是 `undefined`：`JSON.stringify` 会把值为
         * `undefined` 的键整个丢掉，宿主根本收不到这个字段——于是「清空」
         * 变成「什么都不改」，用户以为改成功了，输入框还会被 `useEffect`
         * 悄悄填回旧值（宿主侧那条 `null → DEFAULTS` 的分支永远走不到）。
         */
        const next = draft.trim() === '' ? null : Number(draft)
        if (next !== null && !Number.isFinite(next)) { reset(); return }
        if (next !== null && min !== undefined && next < min) { reset(); return }
        if (next !== value) onCommit(next)
      }
      return h('div', { className: 'bps_field' },
        h('label', null, label),
        h('input', {
          type: 'number', value: draft, step: step ?? 1, min: min ?? 0,
          onChange: event => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); commit() } },
        }),
        hint === undefined ? null : h('p', { className: 'bps_hint' }, hint))
    }

    /** 文本输入：与 NumberField 同样的「失焦/回车才提交」策略。 */
    function TextField({ label, hint, value, placeholder, onCommit }) {
      const [draft, setDraft] = useState(value ?? '')
      useEffect(() => { setDraft(value ?? '') }, [value])
      return h('div', { className: 'bps_field' },
        h('label', null, label),
        h('input', {
          type: 'text', value: draft,
          placeholder: placeholder === undefined || placeholder === '' ? undefined : placeholder,
          onChange: event => setDraft(event.target.value),
          onBlur: () => { if (draft !== (value ?? '')) onCommit(draft) },
          onKeyDown: event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (draft !== (value ?? '')) onCommit(draft)
          },
        }),
        hint === undefined ? null : h('p', { className: 'bps_hint' }, hint))
    }

    /**
     * 说明：这里**不**包错误边界。
     *
     * 函数组件里的 try/catch 兜不住子组件的渲染期异常——React 是在返回
     * 元素之后才去渲染子树的，那时已经离开了这个 try 块。类组件
     * （`componentDidCatch`）才是唯一真正能兜住的地方，但 shell 注入的
     * React 是精简实现，不能假设 `React.Component` 存在。
     *
     * 因此策略是「不制造异常」而不是「接住异常」：所有子组件都通过
     * `h(...)` 交给 React 调用（直接调用带 hook 的函数会触发
     * "Invalid hook call" 并让整块面板留白），文案函数包了三层兜底，
     * 数据加载失败只影响内容、不影响骨架。
     */

    function SettingsPage(props) {
      /**
       * 文案函数优先用 **shell 给的 `props.t`**——它已经绑好本 section 的
       * 命名空间，是宿主唯一认可的取词途径。`fallbackT` 只在内核没有提供
       * `t` 的老组合里兜底（那时中文直出，比整页空白好）。
       */
      /**
       * 文案函数。三道兜底，保证它**永远不抛错、永远返回字符串**：
       *
       *   1. 优先用 shell 给的 `props.t`——它绑好了本 section 的命名空间；
       *   2. 没有就用自己的 `fallbackT`（apply 阶段绑定的翻译器）；
       *   3. 都没有就返回中文原文。
       *
       * 关键在于第 1 步要**包一层 try/catch**：`props.t` 是宿主注入的，
       * 命名空间未注册时它可能直接抛错。一旦在渲染期抛出，shell 会把整块
       * 区域留白——用户看到的就是「侧边栏有入口、右边一片空」。
       */
      const zh = DICT.zh
      const shellT = props.t
      const own = props.fallbackT
      const t = key => {
        if (typeof shellT === 'function') {
          try {
            const value = shellT(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch { /* 宿主翻译器不可用，落到下一层 */ }
        }
        if (typeof own === 'function') {
          try {
            const value = own(key)
            if (typeof value === 'string' && value !== '') return value
          } catch { /* 同上 */ }
        }
        return zh[key] ?? key
      }
      const ctx = props.ctx
      // 模块级单例即可：`makeApi` 只闭包了 `fetch` 与常量，没有随渲染变化的状态。
      // 用模块级对象而不是 `useMemo`，避免依赖某个具体的 React 实现细节。
      const api = apiSingleton ?? (apiSingleton = makeApi())

      const [state, setState] = useState(undefined)
      const [config, setConfig] = useState(undefined)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      /** 测速进度：running/done/total。轮询宿主拿。 */
      const [probe, setProbe] = useState({ running: false, done: 0, total: 0, finishedAt: 0 })

      /**
       * 测速：开跑后在后台轮询进度。
       *
       * ## 为什么是轮询而不是等 HTTP 返回
       *
       * 近百个模型要跑一两分钟。如果让这个请求一直挂着，浏览器/网关的超时可能
       * 先把它掐掉，而且页面期间无法响应。所以端点只负责「开跑」就返回，进度
       * 由这里每隔 1.5 秒问一次。
       *
       * 跑完后主动拉一次 state/config：被测出的速度出现在候选列表里（带颜色），
       * 而且链的排序也会变。
       */
      const startProbe = async force => {
        /** 当前门槛，用于完成提示（配置尚未加载时退回默认 85）。 */
        const cutCutThreshold = Number(config?.excludeBelowTps ?? 85)
        setBusy(true); setNotice(''); setError('')
        try {
          const started = await api.probe(force)
          if (started.started !== true) {
            setNotice(t('probeEmpty'))
            setProbe({ running: false, done: 0, total: 0, finishedAt: Date.now() })
            return
          }
          setProbe({ running: true, done: 0, total: started.total ?? 0, finishedAt: 0 })
          /**
           * 轮询直到宿主说「跑完了」。
           *
           * 同时把**最后一次**的快照留在局部变量里：完成提示要说「测了多少个」，
           * 而渲染闭包里的 `probe.total` 是点击那一刻的值（正常首次点击恒为 0），
           * 用它拼提示会永远显示「测速完成：0 个模型」。
           */
          let last = { running: true, done: 0, total: started.total ?? 0, finishedAt: 0 }
          for (;;) {
            await new Promise(r => setTimeout(r, 1500))
            const s = await api.probeStatus()
            last = { running: s.running === true, done: s.done ?? 0, total: s.total ?? 0, finishedAt: s.finishedAt ?? 0 }
            setProbe(last)
            if (last.running !== true) break
          }
          await refreshBoth()
          /**
           * 完成提示带上「收敛结果」。
           *
           * 用户点「重测全部」之后最想知道的是「现在到底选中了多少个」，
           * 而不是「测了多少个」。宿主在 /probe 的应答里回了 cut 明细
           * （哪条链被收敛、各取消了几个），这里如实转述。
           */
          const cut = started?.cut ?? null
          const changedText = cut !== null && Array.isArray(cut.changed) && cut.changed.length > 0
            ? cut.changed.map(k => k + ' -' + (cut.dropped?.[k] ?? 0)).join(' / ')
            : t('probeCutNone')
          setNotice(t('probeDone')
            .replace('{n}', String(last.total || 0))
            .replace('{cut}', String(cutCutThreshold))
            .replace('{changed}', changedText))
        } catch (caught) {
          setError(t('saveFailed').replace('{reason}', String(caught?.message ?? caught)))
        } finally { setBusy(false) }
      }

      const stopProbe = async () => {
        try {
          await api.probeStop()
          setProbe(p => ({ ...p, running: false }))
          setNotice(t('saved'))
        } catch (caught) {
          setError(String(caught?.message ?? caught))
        }
      }

      const load = useCallback(() => {
        setError('')
        Promise.all([api.state(), api.config()])
          .then(([nextState, nextConfig]) => { setState(nextState); setConfig(nextConfig) })
          .catch(caught => setError(String(caught?.message ?? caught)))
      }, [api])

      useEffect(() => { load() }, [load])

      const save = async patch => {
        setBusy(true); setNotice(''); setError('')
        try {
          const next = await api.saveConfig(patch)
          setConfig(next)
          setNotice(t('saved'))
          // 阈值变了，分层结果随之变化；立刻取一次新结果。
          const fresh = await api.state()
          setState(fresh)
        } catch (caught) {
          setError(t('saveFailed').replace('{reason}', String(caught?.message ?? caught)))
        } finally { setBusy(false) }
      }

      const refresh = async () => {
        setBusy(true); setNotice(''); setError('')
        const before = Number(state?.status?.creditsAt ?? 0)
        try {
          const fresh = await api.refresh()
          setState(fresh)
          setNotice(t('saved'))
        } catch (caught) {
          setError(t('saveFailed').replace('{reason}', String(caught?.message ?? caught)))
          setBusy(false)
          return
        }
        /**
         * 先解除 `busy`，再去追积分。
         *
         * 分层已经完成了，按钮该能再点。如果让 `busy` 盖住整个余额轮询，
         * 极端情况下（多个渠道串行超时）用户会看着一个按不动的按钮好几分钟
         * ——那比标签停在「更新中」更难受，而且分层本身早就好了。
         */
        setBusy(false)
        await followCredits(before)
      }

      /**
       * 等本轮余额查询落地，并把结果换上。
       *
       * ## 退出判据是 `creditsPending`，不是时间
       *
       * 宿主在 `refresh()` 里同步置 `creditsPending: true`，随后异步跑余额查询，
       * 落地（或失败）时清成 false。所以「不再 pending」本身就等于「这轮有结论
       * 了」——数字要么是新的，要么确定拿不到，两种情况都该停止轮询。
       *
       * 上限 300 轮只作兜底：宿主对 9 个渠道**串行**查余额、单次 timeout 30 秒，
       * 理论最坏 270 秒。正常情况下 10–20 秒就退出。
       *
       * @param {number} before - 点击前的 `creditsAt`。
       */
      const followCredits = async before => {
        const generation = ++creditsWatch
        for (let round = 0; round < 300; round += 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          if (generation !== creditsWatch) return
          let snapshot
          try { snapshot = await api.state() } catch { return }
          if (generation !== creditsWatch) return
          setState(snapshot)
          if (snapshot?.status?.creditsPending !== true) {
            /**
             * 收尾文案要区分「真的刷新了」和「这轮没拿到」。
             *
             * 宿主只在确实拿到新余额时才推进 `creditsAt`，所以时间戳没动就
             * 说明这一轮所有渠道都查询失败、数字仍是旧的。此时提示「已保存」
             * 会让用户以为积分已经更新，实际看到的是上一轮的数值。
             */
            const advanced = Number(snapshot?.status?.creditsAt ?? 0) > before
            setNotice(advanced ? t('saved') : t('creditsStale'))
            return
          }
        }
        // 轮询到上限仍在更新中：明确告知，而不是静默停在一个「更新中」的标签。
        if (generation === creditsWatch) setNotice(t('creditsStillUpdating'))
      }

      // 与宿主侧 parseCustomModels 同口径：逗号/空格/分号分隔、去重、小写。
      const parseList = raw => [...new Set(String(raw ?? '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => x !== ''))]

      /**
       * 某条链当前的成员 id（复选框的勾选状态）。
       *
       * 直接读 state 里链的**实际成员**——那是宿主算完的真相（含自动分层结果），
       * 比读配置字段更可靠：`membersFree` 为空时代表「全选」，而不是「空链」，
       * 拿它当勾选状态会全部显示未勾选。Custom 链例外，它的成员就是配置本身。
       */
      /**
       * 某条链当前的成员 id（复选框的勾选状态）。
       *
       * 三条价格链读 state 里链的**实际成员**——那是宿主算完的真相（含自动
       * 分层结果），比读配置字段更可靠：`membersFree` 为空时代表「全选」，
       * 而不是「空链」，拿它当勾选状态会全部显示未勾选。
       *
       * Custom 反过来：它的成员**就是配置里勾选的清单**。auto 模式下宿主会把
       * 整个池子补进来、`links` 显示为全集，那不是用户的勾选意图；所以这里
       * 只用 `customModels`。全不选（哨兵）时返回空数组——但候选列表照旧
       * 完整，只是没有一项被勾上。
       */
      const membersOf = (key, st, cfg) => {
        /**
         * ## 复选框状态必须读「用户勾了什么」，不是「链里实际有什么」
         *
         * 早先三条价格链读 `st.chains[key].links`（链的实际成员）。那份成员是
         * 经过 `cap()`（每条链 40、单渠道 6）与吞吐淘汰之后的**结果**，天然比
         * 候选列表少——实测 low 的 35 个候选只有 12 个在链里，于是用户点「全选」
         * 之后，列表上只勾了 12 个，看起来就是「全选不起作用」。
         *
         * 现在宿主在 `state.members[key]` 里直接回一份三态：
         *
         *   - `mode: 'all'`      → 没动过，等于全选；勾上当前候选全集
         *   - `mode: 'none'`     → 显式全不选；一个都不勾
         *   - `mode: 'explicit'` → `ids` 就是完整勾选清单
         *   - `mode: 'auto'`     → 仅 Custom：跟随候选池
         */
        const view = st?.members?.[key]
        if (view !== null && typeof view === 'object') {
          if (view.mode === 'none') return []
          if (view.mode === 'explicit') return Array.isArray(view.ids) ? view.ids : []
          // all / auto：勾上候选全集（由调用方通过候选列表对齐）。
          const pool = key === 'custom'
            ? (st?.eligible?.custom ?? st?.available ?? st?.chains?.custom?.links ?? [])
            : (st?.eligible?.[key] ?? [])
          const ids = pool.map(row => String(row.id ?? '').toLowerCase())
          if (ids.length > 0) return ids
          return (st?.chains?.[key]?.links ?? []).map(row => row.id)
        }
        /**
         * 兜底：旧宿主没有 `state.members`（升级前）时仍按老规则读配置字段，
         * 至少不会把「全不选」误显示成全选。
         */
        if (key === 'custom') {
          const raw = String(cfg?.customModels ?? '').trim().toLowerCase()
          if (raw === '__none__') return []
          if (raw === '') return (st?.chains?.custom?.links ?? []).map(row => row.id)
          return parseList(raw)
        }
        return (st?.chains?.[key]?.links ?? []).map(row => row.id)
      }

      /**
       * 一条链的**全部候选**（复选框列表）。
       *
       * 三条价格链：用宿主算好的该档位候选（`eligible[key]`）。
       * Custom 链：候选池全集（同样由宿主算好）。
       *
       * 同时把「已在链里但不在候选集里」的模型并进来——否则用户看不到它，
       * 也就无法取消勾选。
       */
      /**
       * 一条链的**全部候选**（复选框列表）。
       *
       * - 三条价格链：宿主算好的该档位候选（`eligible[key]`）；
       * - Custom：**候选池全集**（`eligible.custom`，宿主已按同一道 1M + 倍率
       *   筛子算好）。
       *
       * 关键：候选列表与「链成员」完全解耦。所以「全部取消」之后模型一个都
       * 不会消失——它们在候选池里，只是复选框没被勾上，用户随时能自己再挑。
       * 这是「custom 里全不选后列表空了」那个 bug 的修法。
       *
       * Custom 的候选来源三层兜底：`eligible.custom` → `available` →
       * `chains.custom.links`，兼顾还没重启的旧宿主。
       */
      const optionsForChain = (key, st) => {
        const pool = key === 'custom'
          ? (st?.eligible?.custom ?? st?.available ?? st?.chains?.custom?.links ?? [])
          : (st?.eligible?.[key] ?? [])
        const byId = new Map()
        for (const row of pool) byId.set(String(row.id).toLowerCase(), row)
        const selectedIds = membersOf(key, st, config)
        for (const id of selectedIds) {
          const lower = String(id).toLowerCase()
          if (!byId.has(lower)) byId.set(lower, { id, rate: null, vision: undefined })
        }
        return [...byId.values()].sort((a, b) => {
          /**
           * 排序：**吞吐降序**（用户新规则）。
           *
           * 用户的新规则是「4 个分类里面的模型按照吞吐量从大到小排序」，所以
           * 设置页的候选列表也按吞吐排——列表顺序与链里的调用顺序一致，用户
           * 在页面上看到的第一个就是实际会先被调用的那个。
           *
           * 没有吞吐数据的排在后面（按 id 稳定排序）：它们既没被证明快，也没被
           * 证明慢，不该抢在实测快的模型前面。
           *
           * 位置仍然**与勾选状态无关**：曾经按「已勾选优先」排，结果用户点第
           * 3 行时那一行立刻跳到第 1 行，看起来像「点哪儿都是选中第一个」。
           */
          const ta = Number(a.speed?.tps)
          const tb = Number(b.speed?.tps)
          const ha = Number.isFinite(ta) && ta > 0
          const hb = Number.isFinite(tb) && tb > 0
          if (ha && hb && ta !== tb) return tb - ta
          if (ha !== hb) return ha ? -1 : 1
          return String(a.id).localeCompare(String(b.id))
        })
      }

      /** 刷新 config 与 state，让页面立刻反映宿主的真实状态。 */
      const refreshBoth = async () => {
        const [nextConfig, fresh] = await Promise.all([api.config(), api.state()])
        setConfig(nextConfig)
        setState(fresh)
      }

      /**
       * 切换单个模型在某条链里的勾选状态——**立即保存**。
       *
       * 不维护本地草稿：宿主返回的就是真相，直接用它刷新页面。这样并发点击
       * 也不会丢改动，而且行为与「自动保存」的承诺一致。
       */
      const toggleMember = async (key, id, on) => {
        setBusy(true); setNotice(''); setError('')
        try {
          await api.toggleMember(key, id, on)
          await refreshBoth()
        } catch (caught) {
          setError(t('saveFailed').replace('{reason}', String(caught?.message ?? caught)))
        } finally { setBusy(false) }
      }

      /**
       * 全选 / 全不选。
       *
       * @param {string} key - 链名
       * @param {boolean} on - true 全选，false 全不选
       * @param {string[]} [ids] - 只对这些 id 生效；省略表示整条链
       *
       * 带 `ids` 时语义是「把这几个加入 / 移出」，而不是「整链置为全选」。
       * 两者差别在搜索场景下很关键：搜到 3 个点全选，不该把另外 93 个也选中。
       */
      const toggleAllMembers = async (key, on, ids) => {
        setBusy(true); setNotice(''); setError('')
        try {
          await api.toggleAll(key, on, ids)
          await refreshBoth()
        } catch (caught) {
          setError(t('saveFailed').replace('{reason}', String(caught?.message ?? caught)))
        } finally { setBusy(false) }
      }

      const chainNames = {
        free: t('free'),
        low: t('low'),
        high: t('high'),
        custom: t('custom'),
      }

      const status = state?.status ?? {}
      const statusLine = status.ok === true
        ? t('statusOk').replace('{time}', formatTime(status.at))
        : status.error !== undefined && status.error !== ''
          ? t('statusFailed').replace('{reason}', status.error)
          : t('statusNever')

      return h('div', { className: 'bps_root' },
        h('div', { className: 'bps_hero' },
          h('h2', null, t('title')),
          h('p', { className: 'bps_sub' }, t('sub')),
          /**
           * 汇总行：多少个模型可调用 + 还剩多少积分。
           *
           * 放在按钮**上方**，因为它是「当前状态」而不是「操作」——用户先
           * 想知道现在有什么，再决定要不要点重新分层。
           */
          h('div', { className: 'bps_stats' },
            h('span', { className: 'bps_stat' },
              h('span', { className: 'bps_statnum' },
                Number.isFinite(status.callable) && status.callable > 0 ? String(status.callable) : '—'),
              h('span', { className: 'bps_statlabel' }, t('callableModels'))),
            h('span', { className: 'bps_stat' },
              h('span', { className: 'bps_statnum' },
                status.credits === undefined ? '—' : formatCredits(status.credits.total)),
              h('span', { className: 'bps_statlabel' },
                status.creditsPending === true ? t('creditsUpdating') : t('creditsLeft'))),
            status.credits !== undefined && status.credits.expiring > 0
              ? h('span', { className: 'bps_stat bps_statwarn' },
                h('span', { className: 'bps_statnum' }, formatCredits(status.credits.expiring)),
                h('span', { className: 'bps_statlabel' }, t('creditsExpiring')))
              : null,
            /**
             * 已淘汰数：让「模型数比候选池少」有解释。
             *
             * 只有真的有淘汰时才显示——0 的时候多一个「0 个已淘汰」只是噪声。
             */
            Number.isFinite(status.dropped) && status.dropped > 0
              ? h('span', { className: 'bps_stat bps_statwarn' },
                h('span', { className: 'bps_statnum' }, String(status.dropped)),
                h('span', { className: 'bps_statlabel' }, t('droppedStat')))
              : null),
          // 额度型渠道的数字不能与积分相加，单独一句话说明，避免「8 千万分」的误解。
          status.credits !== undefined
            && Array.isArray(status.credits.quotaChannels)
            && status.credits.quotaChannels.length > 0
            ? h('p', { className: 'bps_note' },
              t('creditsQuota').replace('{n}', String(status.credits.quotaChannels.length)))
            : null,
          h('div', { className: 'bps_row' },
            h('button', { type: 'button', className: 'bps_btn', disabled: busy, onClick: refresh },
              busy ? t('refreshing') : t('refreshNow')),
            /**
             * 测速按钮：后台跑，不阻塞页面。
             *
             * 「立即分层」只负责把模型按价格挑出来；速度得**实测**才知道，所以
             * 单独一个入口。跑的时候显示进度（done/total），可以随时停。
             */
            probe.running
              ? h(Fragment, null,
                h('button', { type: 'button', className: 'bps_btn', onClick: stopProbe }, t('probeStop')),
                h('p', { className: 'bps_note' },
                  t('probeRunning').replace('{done}', String(probe.done)).replace('{total}', String(probe.total))))
              : h(Fragment, null,
                h('button', { type: 'button', className: 'bps_btn', disabled: busy, onClick: () => startProbe(false) },
                  t('probeStart')),
                h('button', { type: 'button', className: 'bps_btn ghost', disabled: busy, onClick: () => startProbe(true) },
                  t('probeForce'))),
            h('p', { className: 'bps_note' }, statusLine),
            Number.isFinite(status.total) && status.total > 0
              ? h('p', { className: 'bps_note' }, t('total').replace('{n}', String(status.total)))
              : null)),

        notice !== '' ? h('p', { className: 'bps_ok' }, notice) : null,
        error !== '' ? h('p', { className: 'bps_err' }, error) : null,

        h('div', { className: 'bps_chains' },
          CHAIN_ORDER.map(key => h(ChainCard, {
            key, t,
            name: chainNames[key],
            chain: state?.chains?.[key],
            color: CHAIN_COLORS[key],
            busy,
            // 该链的全部候选（宿主按档位算好），勾选与未勾选都在同一份列表里。
            options: optionsForChain(key, state),
            selected: new Set(membersOf(key, state, config).map(x => String(x).toLowerCase())),
            // 单模型切换：立即提交、立即落盘，没有保存按钮。
            onToggleOption: (id, on) => toggleMember(key, id, on),
            // 链头全选 / 全不选。第二个参数是「只对这些 id 生效」，
            // 搜索框有内容时由卡片传入筛选结果。
            onToggleAll: (on, ids) => toggleAllMembers(key, on, ids),
          }))),

        h('div', { className: 'bps_section' },
          h('div', { className: 'bps_sectiontitle' }, t('settings')),
          config === undefined
            ? h('p', { className: 'bps_note' }, '…')
            : h('div', { className: 'bps_form' },
              h(TextField, {
                label: t('gatewayUrl'), hint: t('gatewayUrlHint'),
                value: config.gatewayUrl, onCommit: value => save({ gatewayUrl: value }),
              }),
              /**
               * 网关 Key：宿主恒回空串（不再回掩码）。
               *
               * 早先宿主回 `'••••••'`，这里把它当成受控 input 的值——用户点进去
               * 补一个字符就提交了「掩码+新值」，落盘后所有网关调用 401，而界面
               * 仍显示「已配置」，根本看不出凭证坏了。
               *
               * 现在用 placeholder 表达「已配置」，留空 = 不修改；想清除就输入
               * 新值或显式清空（宿主对空串按「清除」处理）。
               */
              h(TextField, {
                label: t('gatewayKey'),
                hint: config.gatewayKeyConfigured === true ? t('gatewayKeySet') : t('gatewayKeyHint'),
                value: config.gatewayKey,
                placeholder: config.gatewayKeyConfigured === true ? t('gatewayKeyPlaceholder') : '',
                onCommit: value => save({ gatewayKey: value }),
              }),
              h(NumberField, {
                label: t('refreshMinutes'), hint: t('refreshMinutesHint'),
                value: config.refreshMinutes, min: 0,
                onCommit: value => save({ refreshMinutes: value }),
              }),
              h(NumberField, {
                label: t('lowMaxRate'), hint: t('lowMaxRateHint'),
                value: config.lowMaxRate, min: 0, step: 0.05,
                onCommit: value => save({ lowMaxRate: value }),
              }),
              h(NumberField, {
                label: t('longContextMin'), hint: t('longContextMinHint'),
                value: config.longContextMin, min: 1, step: 1000,
                onCommit: value => save({ longContextMin: value }),
              }),
              h(NumberField, {
                label: t('maxLinks'), hint: undefined,
                value: config.maxLinks, min: 1,
                onCommit: value => save({ maxLinks: value }),
              }),
              h(NumberField, {
                label: t('perProviderLinks'), hint: t('perProviderLinksHint'),
                value: config.perProviderLinks, min: 1,
                onCommit: value => save({ perProviderLinks: value }),
              }),
              h(NumberField, {
                label: t('absurdRate'), hint: t('absurdRateHint'),
                value: config.absurdRate, min: 0, step: 0.5,
                onCommit: value => save({ absurdRate: value }),
              }),
              h(NumberField, {
                label: t('expiringWindowDays'), hint: t('expiringWindowDaysHint'),
                value: config.expiringWindowDays, min: 1,
                onCommit: value => save({ expiringWindowDays: value }),
              }),
              h('div', { className: 'bps_field' },
                h('label', null, t('preferExpiringCredits')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.preferExpiringCredits === true,
                    onChange: event => save({ preferExpiringCredits: event.target.checked }),
                  }),
                  h('span', null, config.preferExpiringCredits === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('preferExpiringCreditsHint'))),
              h('div', { className: 'bps_field' },
                h('label', null, t('expiryLookup')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.expiryLookup === true,
                    onChange: event => save({ expiryLookup: event.target.checked }),
                  }),
                  h('span', null, config.expiryLookup === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('expiryLookupHint'))),
              h(NumberField, {
                label: t('firstTokenTimeoutMs'), hint: t('firstTokenTimeoutMsHint'),
                value: config.firstTokenTimeoutMs, min: 0, step: 1000,
                onCommit: value => save({ firstTokenTimeoutMs: value }),
              }),
              h(NumberField, {
                label: t('slowTtfbMs'), hint: t('slowTtfbMsHint'),
                value: config.slowTtfbMs, min: 0, step: 500,
                onCommit: value => save({ slowTtfbMs: value }),
              }),
              h(NumberField, {
                label: t('maxSlowSkips'), hint: t('maxSlowSkipsHint'),
                value: config.maxSlowSkips, min: 0,
                onCommit: value => save({ maxSlowSkips: value }),
              }),
              h(NumberField, {
                label: t('minTokensPerSecond'), hint: t('minTokensPerSecondHint'),
                value: config.minTokensPerSecond, min: 0,
                onCommit: value => save({ minTokensPerSecond: value }),
              }),
              /**
               * 吞吐淘汰线：用户明确要求「低于 50 tok/s 的直接取消选择」。
               *
               * 与上面的「最低速度」分开两项，因为它们的作用时刻不同：这一项
               * 决定**谁进链**（分层期），上面那项决定**这一轮要不要换人**
               * （请求期）。合成一项会让「只想排序、不想删模型」没法表达。
               */
              h(NumberField, {
                label: t('excludeBelowTps'), hint: t('excludeBelowTpsHint'),
                value: config.excludeBelowTps, min: 0,
                onCommit: value => save({ excludeBelowTps: value }),
              }),
              h(NumberField, {
                label: t('fastBandSize'), hint: t('fastBandSizeHint'),
                value: config.fastBandSize, min: 1,
                onCommit: value => save({ fastBandSize: value }),
              }),
              h(NumberField, {
                label: t('throughputBandTps'), hint: t('throughputBandTpsHint'),
                value: config.throughputBandTps, min: 0,
                onCommit: value => save({ throughputBandTps: value }),
              }),
              h(NumberField, {
                label: t('speedSampleMs'), hint: t('speedSampleMsHint'),
                value: config.speedSampleMs, min: 500, step: 500,
                onCommit: value => save({ speedSampleMs: value }),
              }),
              h(NumberField, {
                label: t('slowMemoryMinutes'), hint: t('slowMemoryMinutesHint'),
                value: config.slowMemoryMinutes, min: 1,
                onCommit: value => save({ slowMemoryMinutes: value }),
              }),
              h(NumberField, {
                label: t('speedMemoryMinutes'), hint: t('speedMemoryMinutesHint'),
                value: config.speedMemoryMinutes, min: 1,
                onCommit: value => save({ speedMemoryMinutes: value }),
              }),
              h('div', { className: 'bps_field' },
                h('label', null, t('preferMeasuredSpeed')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.preferMeasuredSpeed === true,
                    onChange: event => save({ preferMeasuredSpeed: event.target.checked }),
                  }),
                  h('span', null, config.preferMeasuredSpeed === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('preferMeasuredSpeedHint'))),
              /**
               * 吞吐优先：排序键从「首字」扩到「首字 + 生成耗时」。
               *
               * 用户要的是「一次提问后整体产出快」。只看首字会把「首字 1 秒但
               * 每秒 8 个 token」排在「首字 3 秒但每秒 120 个 token」前面，而
               * 后者在真实长回答里反而先写完。
               */
              h('div', { className: 'bps_field' },
                h('label', null, t('preferThroughput')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.preferThroughput === true,
                    onChange: event => save({ preferThroughput: event.target.checked }),
                  }),
                  h('span', null, config.preferThroughput === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('preferThroughputHint'))),
              h(NumberField, {
                label: t('expectedOutputTokens'), hint: t('expectedOutputTokensHint'),
                value: config.expectedOutputTokens, min: 1, step: 100,
                onCommit: value => save({ expectedOutputTokens: value }),
              }),
              /**
               * Custom 选法：跟随池子 / 严格按勾选。
               *
               * 这是「取消某个模型没用」的开关——explicit 下取消就是真的取消。
               */
              h('div', { className: 'bps_field' },
                h('label', null, t('customMode')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.customMode === 'explicit',
                    onChange: event => save({ customMode: event.target.checked ? 'explicit' : 'auto' }),
                  }),
                  h('span', null, config.customMode === 'explicit' ? t('customModeExplicit') : t('customModeAuto'))),
                h('p', { className: 'bps_hint' }, t('customModeHint'))),
              h('div', { className: 'bps_field' },
                h('label', null, t('autoProbe')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.autoProbeOnRefresh === true,
                    onChange: event => save({ autoProbeOnRefresh: event.target.checked }),
                  }),
                  h('span', null, config.autoProbeOnRefresh === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('autoProbeHint'))),
              /**
               * 启动自动重测：用户明确要求「每次开起软件就自动运行一次重测全部」。
               *
               * 与上面那项的区别是触发时机：那项是「点立即重新分层时」，
               * 这顶是「进程启动后」。两个都开不会冲突——探测是单飞的。
               */
              h('div', { className: 'bps_field' },
                h('label', null, t('probeOnStartup')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.probeOnStartup === true,
                    onChange: event => save({ probeOnStartup: event.target.checked }),
                  }),
                  h('span', null, config.probeOnStartup === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('probeOnStartupHint'))),
              h(NumberField, {
                label: t('startupProbeSkipMinutes'), hint: t('startupProbeSkipMinutesHint'),
                value: config.startupProbeSkipMinutes, min: 0,
                onCommit: value => save({ startupProbeSkipMinutes: value }),
              }),
              /**
               * 账号层：快到期优先 + 轮流。
               *
               * 这两项是「不要集中用几个模型/账号」诉求在**账号**维度的落点，
               * 与上面的快速档（模型维度）互补。
               */
              h('div', { className: 'bps_field' },
                h('label', null, t('accountExpiryFirst')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.accountExpiryFirst === true,
                    onChange: event => save({ accountExpiryFirst: event.target.checked }),
                  }),
                  h('span', null, config.accountExpiryFirst === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('accountExpiryFirstHint'))),
              h('div', { className: 'bps_field' },
                h('label', null, t('accountRotation')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.accountRotation === true,
                    onChange: event => save({ accountRotation: event.target.checked }),
                  }),
                  h('span', null, config.accountRotation === true ? t('yes') : t('no'))),
                h('p', { className: 'bps_hint' }, t('accountRotationHint'))),
              h(NumberField, {
                label: t('accountReorderMinutes'), hint: t('accountReorderMinutesHint'),
                value: config.accountReorderMinutes, min: 0,
                onCommit: value => save({ accountReorderMinutes: value }),
              }),
              h('div', { className: 'bps_field' },
                h('label', null, t('verbose')),
                h('label', { className: 'bps_check' },
                  h('input', {
                    type: 'checkbox', checked: config.verbose === true,
                    onChange: event => save({ verbose: event.target.checked }),
                  }),
                  h('span', null, config.verbose === true ? t('yes') : t('no'))))),

          // 慢模型清单：让用户看到「谁被降级了」，并能一键清空。
          h('div', { className: 'bps_section' },
            h('div', { className: 'bps_sectiontitle' }, t('slowModels')),
            (() => {
              const slow = Array.isArray(config?.slowModels) ? config.slowModels : []
              if (slow.length === 0) return h('p', { className: 'bps_note' }, t('slowModelsNone'))
              return h(Fragment, null,
                h('ul', { className: 'bps_list' },
                  slow.map(row => h('li', { key: row.id },
                    h('span', null, row.id),
                    h('span', { className: 'bps_rate' }, `×${row.strikes}`)))),
                h('div', { className: 'bps_row' },
                  h('button', {
                    type: 'button', className: 'bps_btn ghost', disabled: busy,
                    onClick: async () => {
                      setBusy(true)
                      try {
                        const next = await api.clearSlow()
                        setConfig(next)
                        setNotice(t('saved'))
                      } catch (caught) {
                        setError(String(caught?.message ?? caught))
                      } finally { setBusy(false) }
                    },
                  }, t('clearSlow'))))
            })()),

          /**
           * 已淘汰清单：让「低于吞吐线的模型不进链」这件事**可见**。
           *
           * 没有这一块，用户会看到候选池里列着一个模型、勾上了、却怎么也不
           * 在链里——那看起来就是 bug。列出它、并给出「调低门槛或清空画像」
           * 的出路，才是可解释的。
           */
          h('div', { className: 'bps_section' },
            h('div', { className: 'bps_sectiontitle' }, t('droppedTitle')),
            (() => {
              const dropped = Array.isArray(config?.dropped) ? config.dropped : []
              if (dropped.length === 0) return h('p', { className: 'bps_note' }, t('droppedNone'))
              return h(Fragment, null,
                h('ul', { className: 'bps_list' },
                  dropped.slice(0, 30).map(row => h('li', { key: row.id },
                    h('span', null, row.id),
                    h('span', { className: 'bps_speed bps_speedslow' },
                      Number.isFinite(row.tps) ? `${Math.round(row.tps)}t/s` : '—')))),
                h('p', { className: 'bps_hint' }, t('droppedHint')))
            })()),

          /**
           * 快速档：显示「这次会轮到哪几个」。
           *
           * 用户的核心诉求是「既要快、又要分散」。这两件事只体现在快速档里：
           * 档内轮流 = 分散，档内都是最快的那几个 = 快。所以它必须能看见。
           */
          h('div', { className: 'bps_section' },
            h('div', { className: 'bps_sectiontitle' }, t('fastBandTitle')),
            h('p', { className: 'bps_hint' }, t('fastBandHint')),
            (() => {
              const bands = config?.fastBand
              if (bands === null || typeof bands !== 'object') return h('p', { className: 'bps_note' }, t('fastBandNone'))
              return h('ul', { className: 'bps_list' },
                CHAIN_ORDER.map(key => {
                  const band = bands[key]
                  const links = Array.isArray(band?.links) ? band.links : []
                  if (links.length === 0) return null
                  return h('li', { key },
                    h('span', { className: 'bps_cardname' }, chainNames[key]),
                    h('span', { className: 'bps_rate' },
                      links.map(row => `${row.id.split('/').pop()}${Number.isFinite(row.tps) ? ' ' + Math.round(row.tps) + 't/s' : ''}`).join(' · ')))
                }).filter(Boolean))
            })()),

          /**
           * 账号顺序：让用户看到「哪些账号因为快到期被提前、其余怎么轮」。
           *
           * 这是账号维度唯一可观察的地方——不展示的话，用户只能看到渠道包
           * 里顺序莫名其妙地变了。
           */
          h('div', { className: 'bps_section' },
            h('div', { className: 'bps_sectiontitle' }, t('accountPlanTitle')),
            (() => {
              const plan = config?.accountPlan
              const providers = plan !== null && typeof plan === 'object' && plan.providers !== null && typeof plan.providers === 'object'
                ? Object.entries(plan.providers)
                : []
              if (providers.length === 0) return h('p', { className: 'bps_note' }, t('accountPlanNone'))
              return h('ul', { className: 'bps_list' },
                providers.map(([provider, info]) => h('li', { key: provider },
                  h('span', null, provider),
                  h('span', { className: 'bps_rate' },
                    [
                      info?.changed === true ? t('accountPlanChanged') : t('accountPlanSame'),
                      t('accountPlanExpiring').replace('{n}', String(Array.isArray(info?.expiring) ? info.expiring.length : 0)),
                    ].join(' · ')))))
            })()),

          /**
           * 实测速度画像：让用户看到「链为什么这样排」。
           *
           * 这是本次改进的可观测面——排序现在依赖实测数据，如果不展示，用户
           * 无法判断「链自我优化」有没有在起作用。
           */
          h('div', { className: 'bps_section' },
            h('div', { className: 'bps_sectiontitle' }, t('speedProfiles')),
            (() => {
              const profiles = Array.isArray(config?.speedProfiles) ? config.speedProfiles : []
              if (profiles.length === 0) return h('p', { className: 'bps_note' }, t('speedProfilesNone'))
              return h('ul', { className: 'bps_list' },
                profiles.slice(0, 20).map(row => h('li', { key: row.id },
                  h('span', null, row.id),
                  h('span', { className: 'bps_rate' },
                    `${Number.isFinite(row.ttfb) ? Math.round(row.ttfb) + 'ms' : '—'} · ${Number.isFinite(row.tps) ? row.tps.toFixed(0) + 't/s' : '—'}`))))
            })()),

          h('p', { className: 'bps_note' },
            t('note').replace('{n}', String(config?.refreshMinutes ?? 30)))))
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────

    // ── 左导航入口 ──────────────────────────────────────────────────────────

    /**
     * 左侧导航「自动化任务」下面的独立入口。
     *
     * ## 为什么是 `sidebar.panellist` + `main` 一对
     *
     * 侧边栏的全局入口是一个**主面板**：`sidebar.panellist` 只负责画那一行
     * （图标 + 文案），点击后由 ui-sidebar 调 `ctx.layout.selectPanel(id)`，
     * 主区域再按同一个 id 去 `main` 槽位里找 `key` 相同的条目渲染。
     *
     * 所以两处 `id` / `key` 必须**完全一致**，否则点击后主区域是空白——
     * 这是这条路径唯一容易踩的坑。
     *
     * ## 为什么 order 是 11
     *
     * 「自动化任务」那一行是 `order: 10`（ui-schedule 注册），「插件」是 `0`。
     * 取 11 就紧贴在自动化任务下面，正是用户要的位置。
     *
     * ## 为什么整段都包 try/catch
     *
     * 老宿主可能没有声明 `sidebar.panellist` 槽位（它是「插件页搬进侧边栏」
     * 之后才有的）。那种情况下注册会抛错，但设置页仍然可用——一个入口而已，
     * 不该连累整个插件。
     */
    const PANEL_ID = 'baipiao-stone'

    /** 导航行图标：与设置页链色点同源的简洁图形，不依赖图标库。 */
    function PanelGlyph({ size }) {
      const edge = Number.isFinite(size) ? size : 16
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
      h('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.55 }),
      h('circle', { cx: 8, cy: 8, r: 2.6, fill: '#9B6BFF' }))
    }

    /**
     * 主面板外壳：设置页内容 + 一页标题。
     *
     * 复用同一个 `SettingsPage`，避免两套界面漂移——导航入口与设置页看到的
     * 永远是同一份实时状态。
     */
    function PanelPage(props) {
      return h('div', { className: 'bps_page' },
        h('div', { className: 'bps_pagehead' },
          h('h1', { className: 'bps_pagetitle' }, props.title ?? 'baipiao-shigege')),
        h('div', { className: 'bps_pagebody' }, h(SettingsPage, props)))
    }

    function apply(ctx) {
      const bind = () => {
        const dictionaries = { zh: DICT.zh, en: DICT.en }
        try {
          return typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : key => dictionaries.zh[key] ?? key
        } catch { return key => dictionaries.zh[key] ?? key }
      }
      const t = bind()

      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'baipiao-stone: dictionaries')
      } catch { /* locale 服务缺席时退化为中文直出 */ }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-baipiao-shigege')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'baipiao-stone: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'baipiao-stone',
        order: 36,
        label: () => t('sectionLabel'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, fallbackT: t, ctx })))

      /**
       * 左导航入口 + 主面板。
       *
       * 两步分开注册，但共用一个 id：侧边栏点那一行 → `selectPanel(id)` →
       * 主区域按 `entryKey` 找到 `main` 里 `key` 相同的条目。
       */
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, props => h(PanelPage, { ...props, fallbackT: t, ctx, title: t('navLabel') })))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          // 10 是「自动化任务」；11 紧贴在它下面。
          order: 11,
          /**
           * 导航栏文案单独取 `navLabel`。
           *
           * 与设置页的 `sectionLabel` 分开是有意的：侧边栏是中文短标签，
           * 将来任一侧要改字，不必牵动另一侧。
           */
          label: () => t('navLabel'),
          locale: NS,
        }, PanelGlyph))
      } catch { /* 老宿主没有这两个槽位：设置页仍然可用 */ }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'baipiao-stone'
    return module.exports
  },
})
