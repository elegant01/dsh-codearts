# 更新日志

本文件记录本插件的重要改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.1] - 2026-10-28

### 新增

- **底部那一行改成段式，与 `dsh-codebuddy-cli` 同构**：`积分 24,091 · Provider CodeArts ·
  Model DeepSeek-V4.1-Flash-1017 · x0.18`。积分挪到最前，倍率单独成段（不再粘在模型名
  尾巴上），段与段用 ` · ` 连接，和邻居那一行的观感一致。**只有积分那一段**是开积分弹层
  的按钮（原来的设定不变）：模型、倍率、排队都是纯文本，点它们不会弹面板。
  `/api/codearts/status` 与 `/api/codearts/models` 的模型条目因此多了一个 `ratio` 字段
  （`x0.18`；福利恒为 `x0.00`；上游没给倍率的模型缺席），免得客户端去拆显示名。
- **对话底部那行先说自己是谁了**：中间是 `Provider CodeArts · Model <模型名> · <倍率>`。
  这一段**不受**「显示剩余积分 / 显示上游排队位置」两个开关影响，始终出现；
  开关只管积分与排队两段。
- 这一行以前是靠邻居插件（`dsh-codebuddy-cli` 的 dock 会替任何 provider 画
  `Provider <id> · Model <id>`）顺带显示的，但它在 codearts 下只给模型 **id**、
  给不出倍率，而且受那个插件自己的「切换到其它 provider 时也显示这一行」开关控制
  （关了整行就消失）。现在身份行由本插件自己负责，不依赖别人。
- **选中我们的模型时，那一行里别人的条目会暂时消失**：我们改不了别人的注册，但
  `conversation.composer.dock` 是 list 槽位、每条注册都被宿主平铺成同一个
  `[data-composer-dock]` 行里的兄弟节点，所以我们这条会认出新出现的**别人**、给它们
  打上 `data-codearts-dock-suppressed` 属性，由我们注入的一条 CSS 隐藏。切换 provider
  或卸载时逐个摘掉属性，别人的行立刻回来。**不碰**宿主自己的轮次/token 统计 pill
  （`data-composer-stat`）和上下文占用格子。规则与边界在 `src/client/dock-suppress.ts`，
  单测见 `test/dock-suppress.spec.ts`。
- **模型勾选区标出「识图」**：`/api/codearts/enabled-models` 的 choices 多了
  `supportsImages`，卡片给支持图片输入的模型挂一个「识图」Tag。声明了 `reasoning` 之外
  的模型能力本来就该在勾选时看得见，不然只有发了图才知道谁不吃图。
- **新增 `DeepSeek-V4.1-Flash-1017` 种子条目**（1,048,576 context）。

### 修复

- **`deepseek-v4.1-flash` 带图必报 `The request model is not multimodal`（issue #4）**：
  这个裸别名在上游不算多模态，种子目录却标了 `supportsImages: true`，于是带图的请求在
  出网前就被当成合法、到了上游才被拒。现在它标 false；多模态的是带日期的 `-1017`。
  上游发现接口对 `-1017` 的 `supports_images` 也给 false，但 issue 报告者实测带图可用，
  按实测为准标 true。
- **模型目录为空时会干等一小时**：启动/热重载后第一次模型发现如果正好撞上上游抖动，
  目录会一直空着，期间每条消息都死在 pi-ai 的 `has no configured model`，而重试要等整
  整 `CATALOG_REFRESH_MS`（1 小时）。现在发现循环自我重排：目录为空时 60 秒后重试，
  有货后回到每小时。

### 开发

- **`scripts/deploy.mjs` 不再改写 profile 的依赖版本**：它以前把仓库 `version` 无条件写成
  profile `dependencies` 的值，本地产物先于 npm 发布升版本时，profile 就会依赖一个
  registry 里不存在的 specifier，宿主重载后整个 bundle 掉线（表现是模型选择器里
  provider 消失，而 HTTP 路由还活着）。现在只在缺这一条时才补，版本不一致时打一行提示。
  仍建议**先发布、再升仓库版本**。

## [1.2.0] - 2026-10-27

### 新增

- **对话底部那行积分可以点开看明细了**：以前只有一行聚合数字（多账号把所有号加在
  一起），看不出是哪个号还剩多少。现在那一行是个按钮，点开是逐号明细——账号名、各自
  剩余积分、哪个号有积分将在本周期结束时作废、最近刷新时间，右上角一个「刷新积分」。
  它是唯一绕开 60 秒积分缓存的出口（`GET /api/codearts/status?force=1`）：点了必定打
  上游，不会拿旧数字糊弄。弹层用 fixed 定位挂在按钮上方（放不下就翻到下方），不撑宽
  宿主那条共享的 composer dock 行。
- **两个显隐开关**：设置卡片新增「显示」页，分别管输入框下方那一行的**剩余积分**与
  **上游排队位置**（`showCreditDock` / `showQueueDock`）。默认都开，老配置行为不变。
  开关值随 `/status` 一起下发，底部条每 60 秒读一次，所以关掉最多要等一分钟才见效——
  这句写在设置页上，不让人自己猜。

## [1.1.4] - 2026-10-26

### 修复

- **升级到 1.1.3 报「更新失败：`ERR_PNPM_IGNORED_BUILDS`」**：1.1.3 为修 issue #2 把
  `@earendil-works/pi-ai` 移进 `dependencies`，连带拉入 `@google/genai` / `protobufjs`
  （都带安装期脚本）；pnpm 11 默认拦截未批准的依赖脚本并以非零码退出，DSH 更新器据此
  判失败（包其实已装上）。现在 pi-ai 改为**构建期打包进 `lib/`**：它的厂商 SDK 全是
  懒加载 lane，插件只用 OpenAI 一路，tree-shaking 后 `@google/genai` / `protobufjs`
  不进产物也不进依赖树 —— 安装时零新增 npm 包，脚本拦截绝根；pi-ai 版本漂移（issue #2
  的根因）在结构上一并不可能了。1.1.3 用户侧的临时处理见 INSTALL「八」。
- 产物体积随之涨到约 1.1 MB（含 pi-ai 核心 + openai SDK 的 openai-completions 懒加载
  chunk），功能与接口不变。

## [1.1.3] - 2026-10-26

### 修复

- **与 billion-context 同用时账号被永久禁用，报「当前没有可用账号」（issue #1）**：
  billion-context 拦下 SDK-HMAC-SHA256 签名请求做压缩、找不到重签凭据时在本地回 403
  （`signed_request_requires_resign`），插件把它当凭据失效，账号被禁用且没有任何恢复
  路径。现在按 body 里的拒签标记识别这类本地拦截：不再禁用账号，直接回 400（宿主不会
  再拿它重试 5 次），报错里给出 `resign.passthrough` 的配置方法。带标记的 401/403 之外
  的真凭据失效行为不变。
- **重新登录救不回被禁用的账号**：`disabled` 以前只能靠重启清掉，`pool.sync()` 对同一
  userId 保留运行时状态。现在登录成功（OAuth 与手工贴 token 两条路）会调用池的
  `revive()`，清掉该账号的禁用/冷却/错误计数。
- **「没有可用账号」不再一概而论**：一个账号都选不出来时，报错分清原因——全禁用（401，
  附各号最后错误并提示重新登录）、全在冷却（429，附剩余秒数）、本地并发槽位全满
  （429，说明每账号 2 个在飞上限）。
- **已登录却报「积分不可用：statistics HTTP 0 Failed to parse URL from [object
  Request]」（模型清单同时变空，issue #2）**：出网原本是 `fetch(new Request(url, ...), {signal})`
  ——邻居插件（如 IP 池出口路由）会把 `globalThis.fetch` 换成它自己那份 undici 的
  fetch，而 `globalThis.Request` 还是另一份实例。undici 用 `instanceof` 认自己的
  Request，认不出就当 URL 字符串处理，于是每条请求在出网之前抛错（HTTP 0）。现在
  `Request` 只当签名的载体，出网统一走 `dispatch()`：交「字符串 URL + 已展开的普通
  头 + 原字节请求体」，7 处调用点一并收口。
- **选中 CodeArts 模型后每条消息都「本轮运行失败：Cannot read properties of undefined
  (reading 'length')」（issue #2）**：`@earendil-works/pi-ai` 过去只写在 `peerDependencies`
  （`>=0.84.2 <2.0.0`），区间不会被安装流程强制满足；插件自己没有 `node_modules` 时
  import 直接落到 profile 顶层被别的插件 hoist 上来的旧版。旧版的 `estimateMessageTokens`
  没有 `role:"system"` 分支，而宿主（`dsh-llm-pi-ai` 0.2.1-rc.2 起）会把系统提示折叠成
  一条 content 为**字符串**的 system 消息交给 provider —— 字符串被按字符遍历，读到
  `block.name.length` 就崩，且崩在出网之前。现在 pi-ai 移进 `dependencies`（`^1.3.0`，
  自带一份），并在启动时探测这份能不能估折叠后的 system 消息：不满足就在日志和积分
  卡片上明说「pi-ai 不兼容，需要 >= 1.3.0」，不再让每条消息各自崩在一个看不懂的
  TypeError 上。

## [1.1.1] - 2026-10-22

### 修复

- **带思考档位的模型（GLM-5.2 / GLM-5.2-ArkTS-SPARK）每轮必失败，报
  `Message role cannot empty`**：1.1.0 给这些模型声明了 `reasoning`，宿主 pi-ai 于是
  把系统提示从 `role:"system"` 换成 OpenAI 的新叫法 `role:"developer"` 发出来，
  华为网关只认 system/user/assistant/tool，认不出来就回这一句黑话。出口处统一把
  `developer` 归一回 `system`，与档位无关（Default/High/Max 之前都必现）。
- 新增 `GET /api/codearts/debug`：回最近 8 次出站请求的**形状**摘要（消息条数、
  每条的 role 名、工具数），只含 role 名不含任何内容。上游的参数错误全是同一句
  黑话，没有这个就分不清是宿主发的还是插件拼的。

## [1.1.0] - 2026-10-21

### 新增

- 思考强度：模型发现时拉 `thinking-variants`，只给上游声明过档位的模型（GLM-5.2 /
  GLM-5.2-ArkTS-SPARK：high / max）露出推理选择器，请求以 `reasoning_effort` 透传；
  这路失败不影响目录。
- 上游排队：发请求前先向 `/api/v1/queue/status` 挂号并轮询（每 5 秒一次，最多替
  用户等 20 秒），轮到才开流；等待期间对话底部积分条显示「排队第 N 位」。20 秒
  还没轮到就不挂请求，直接回一句上游自己的排队文案（第几位 / 共多少条）加
  「请稍后重试」；结束、取消、放弃都会 `DELETE` 清号，不留幽灵排队。
- 新接口 `GET /api/codearts/queue`，给卡片读排队快照。

## [1.0.1] - 2026-10-21

### 文档

- 新增本更新日志，README 中英文版均增加入口。
- 修正 README 中「CodeArts 不提供积分接口」的过时说明。

## [1.0.0] - 2026-10-21

### 新增

- 逐账号积分：缓存按账号分槽，状态接口输出 `creditsByAccount`，一个号失败不影响其他号。
- 「全部账号领取」：逐号串行签到并逐号显示结果；对话底部积分条按所有账号合计。
- 用量四段式：今日合计 / 近 30 天 / 今日按账号 / 今日按模型。
- 模型用量横向条形行（模型 · 条 · token · 占比 · 请求数），展示前 5 名。

### 变更

- 设置页改为 账号 / 模型 / 用量 三个 tab。
- 每张账号卡独立边框，与「全部账号领取」行之间加分隔。
- 积分卡显示「已用 / 总额度 / 即将到期」、更新时间与额度重置日。
- 去掉账号隐藏功能，账号始终显示。
- 状态接口透出 `last30` 与 `byAccountToday`。

## [0.5.3] - 2026-10-21

### 新增

- 模型下拉、插件卡片、CLI 都带倍率（如 `GLM-5.2 · x0.70`）；福利模型显示 ` · x0.00 · 福利`。
- 「刷新模型列表」按钮：立刻重拉内置 / 限时福利 / agent-center 三路。

### 修复

- 福利模型被上游判定无权益（`benefit not found`）后当天置灰并说明原因，刷新可立刻恢复。
- 华为侧 TPM 限额（HTTP 200 + 流内 error_code）改为本地排队指数退避（3s → 30s），
  不再无意义地切换账号；错误信息会写明等待时长。

### 变更

- 移除手维护的种子模型清单：未登录或三路全失败时目录为空。
- CLI `status` / `models` 不再输出种子模型（`--json` schema 升到 6）。

## [0.5.2] - 2026-10-19

### 修复

- `deploy` 适配 pnpm 不再写 `.package-map.json` 的变化。
- 指定 `packageManager: pnpm@11.24.0`，修复 Release workflow 中 pnpm 版本缺失。

## [0.5.1] - 2026-10-19

### 修复

- 底部共享 composer 槽位中的积分条不再被其他插件挤掉，也不挤掉宿主统计。

## [0.5.0] - 2026-10-19

### 变更

- 兼容 dsh 0.2 宿主线，peer range 覆盖整条 0.2.x。

## [0.4.2] - 2026-10-16

### 新增

- 应用内领取每日签到积分，走福利中心 `/v1/ops/delivery` + `/v1/ops/claim`。

## [0.4.1] - 2026-10-14

### 修复

- 「领取积分」按钮改为打开官网登录页，不再直接调用未登录状态的接口。

## [0.4.0] - 2026-10-10

### 新增

- 手动领取积分按钮，按天去重。
- 文档补充 HMR module-watch 会阻止 pnpm 替换插件的风险提示。

## [0.3.0] - 2026-10-10

### 新增

- 从 CodeArts 官方 API 读取并显示账号的真实积分余额。

## [0.2.1] - 2026-10-08

### 新增

- 首个 npm 发布版本：OAuth2 登录（PKCE + DPoP）、模型发现、CLI 与状态卡。
