# dsh-baipiao-shigege

把白嫖渠道的模型按价格自动分成三条 **1M 降级链**，另加一条自己挑的 **Custom 链**，并在使用中按实测速度自我优化。

> DeepSeek Harness (DSH) 插件 · 版本 0.1.0 · MIT

---

## 它解决什么问题

白嫖渠道动辄上百个模型，倍率、上下文、速度各不相同。手动挑模型有三个麻烦：

1. **不知道现在能用什么** —— 哪个渠道还有额度、哪个模型 1 块钱能用多久；
2. **挑出来的模型会挂** —— 单个模型限流或宕机，整个会话就卡住；
3. **快的不一定排前面** —— 首字快的模型可能吐字极慢，整体反而更慢。

这个插件把「能用什么」和「该先用谁」都自动化了：

- 从你的本地渠道网关拉全部模型，带倍率、上下文、图片能力；
- 按倍率分成 **免费 / 低积分 / 高积分** 三条链，每条都只收够 1M 上下文的模型；
- 每条链是一个 **fallback 链**，作为**一个模型**出现在选择器里：链首失败自动换下一个；
- 定时重新拉取，倍率一变自动重新分层，不用重启、不用改配置。

---

## 四条链

| 链 | 选择器里的名字 | 说明 |
|---|---|---|
| 免费 | `shigege-Free points` | 倍率 ≤ 免费判定线 |
| 低积分 | `shigege-Low points` | 倍率 ≤ `低积分倍率上界` |
| 高积分 | `shigege-Premium points` | 其余（超过 `排除倍率高于` 的不参与） |
| 自定义 | `shigege-Custom` | 你自己勾选的模型 |

三条价格链都要求 **上下文 ≥ 1M**；达不到的模型不进入任何一条。

---

## 安装

### 方式一：作为本地链接（推荐，改代码即时生效）

```bash
# 1) 把仓库放到任意位置，例如 ~/.dsh/local-plugins/
git clone <repo-url> ~/.dsh/local-plugins/dsh-baipiao-shigege

# 2) 在 profile 的 package.json 里加一条 link: 依赖
#    文件：~/.dsh/profiles/desktop/package.json
#    "dependencies": { "dsh-baipiao-shigege": "link:../../local-plugins/dsh-baipiao-shigege" }

# 3) 把包名加进 bundles 列表（同一个 package.json）
#    "dsh": { "profile": { "bundles": [ ..., "dsh-baipiao-shigege" ] } }

# 4) 让 pnpm 建好 node_modules 联接
cd ~/.dsh/profiles/desktop && pnpm install

# 5) 重启 DeepSeek Harness
```

### 方式二：直接放进 node_modules

```bash
git clone <repo-url> ~/.dsh/profiles/desktop/node_modules/dsh-baipiao-shigege
```

然后在 profile 的 `package.json` 里把 `dsh-baipiao-shigege` 加进 `dsh.profile.bundles`，重启 DSH。

> ⚠️ 不要写成 `"dsh-baipiao-shigege": "file:./node_modules/dsh-baipiao-shigege"` —— 这种自引用依赖在 `node_modules` 被清空后无法重新安装。

---

## 前置条件

需要一个**兼容 OpenAI 协议的本地网关**，能提供：

- `GET /v1/models`：模型清单，展示名里带倍率（形如 `DeepSeek-V4.1-Flash · x0.11`）；
- `POST /v1/chat/completions`：流式对话。

默认指向 `http://127.0.0.1:8326`（渠道包自带的本地网关）。**这不是硬依赖**——把它改成任何兼容网关，插件照样工作。网关 Key 会依次从以下位置读取：

1. 插件设置里的「网关 Key」；
2. `~/.dsh/openai-gateway/api-key`。

---

## 配置项

在 **设置 → 白嫖-石哥哥**，或左侧导航同名入口里调整，改完立即生效：

### 分层

| 项 | 默认 | 说明 |
|---|---|---|
| 渠道网关地址 | `http://127.0.0.1:8326` | 不含 `/v1` |
| 重新分层间隔 | 30 | 分钟；0 = 只在启动时拉一次 |
| 低积分倍率上界 | 0.3 | 超过此倍率归入「高积分」 |
| 1M 链上下文门槛 | 1000000 | 达不到的模型不进任何链 |
| 每条链候选上限 | 40 | |
| 单渠道候选上限 | 6 | 避免一个渠道故障吃掉整条链 |
| 排除倍率高于 | 5 | 躲开 20x 这类不划算的模型 |

### 速度与吞吐

| 项 | 默认 | 说明 |
|---|---|---|
| 按实测速度重排候选 | 开 | 实测快的浮到链首 |
| **按整轮吞吐排序** | **开** | 排序键 = 首字 + 生成量/吞吐 |
| 估算用的输出量 | 800 | 越大越偏向高吞吐模型 |
| 首字等待上限 | 10000 | 毫秒；超过就换下一个，0 = 一直等 |
| 最低速度 | 50 | tokens/s；低于就换下一个并沉到链尾 |
| 单次最多放弃几个慢模型 | 2 | 放弃一个要付一个超时的代价 |

**为什么按吞吐而不是只看首字**：首字 1 秒但每秒 8 个 token 的模型，与首字 3 秒但每秒 120 个 token 的模型，后者在长回答里反而先写完。排序键用 `首字 + 预期输出/吞吐`，才对应你真实感知的「问完到写完」。

### 自定义链

| 项 | 默认 | 说明 |
|---|---|---|
| Custom 严格按勾选 | 开 | 开启后链**严格等于**勾选清单；关闭则整个候选池都进链 |

勾选与取消**立即保存**，没有「保存」按钮。取消某个模型后它仍然留在候选列表里（只是复选框没勾），随时可以再勾回来。

---

## 数据与持久化

| 路径 | 内容 |
|---|---|
| `~/.dsh/dsh-baipiao-stone/settings.json` | 你的设置与勾选 |
| `~/.dsh/dsh-baipiao-stone/speed-memory.json` | 实测速度画像（重启不丢） |
| `~/.dsh/dsh-baipiao-stone/last-request.json` | 上游 400/422 时的请求体转储，便于排查 |

> 目录名用的是插件早期名字 `dsh-baipiao-stone`。这是有意的：改名零功能收益，却有一次丢 `gatewayKey`、自定义选择与速度画像的风险。

---

## 常见问题

**设置页空白 / 表单项全没了？**
插件 `import('@deepseek-ai/schemastery')` 失败时会静默降级为 `Config = undefined`，设置页表单随之消失，其余功能正常。若用 `link:` 方式安装，需保证权威副本能解析到 schemastery：

```bash
cd <插件目录> && node relink.mjs    # 内置 fixPeerResolution 会建好联接
```

**点了「立即重新分层」，顶部积分没变？**
积分查询是异步的（逐个渠道串行，10–20 秒）。分层立即完成，积分随后回填，期间顶部显示「可用积分（更新中…）」。若长时间不消失，检查网关与渠道登录状态。

**某个模型取消勾选后又回来了？**
确认「Custom 严格按勾选」为开启状态。关闭时链会跟随整个候选池，取消动作不生效。

**链里的模型总是不回我的渠道？**
检查「渠道网关地址」与 Key；插件只跟网关说话，不直接连各渠道。

---

## 开发

```bash
node --check index.js && node --check client.js   # 语法门禁
node selftest.mjs                                  # 自检
node tiercheck.mjs                                 # 分层逻辑
```

结构：

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半身：注册 llm provider、拉取分层、HTTP 设置接口、速度探测 |
| `client.js` | 浏览器半身：设置页 + 左侧导航入口（手写 ModuleLoader bundle，无构建步骤） |
| `sse.js` | SSE 解码 |
| `cordis.patch.yml` | 挂载行 |

---

## 许可

MIT
