# DSH CodeArts Connect

把华为云 CodeArts 接入 DeepSeek Harness（DSH），实现在 DSH 对话窗口里直接使用 CodeArts 提供的模型（GLM-5.2、盘古、Qwen、DeepSeek 等）。

## 功能

- **账号登录**：在设置卡片里点一次「使用华为云账号登录」，浏览器完成授权后凭证自动落盘，无需手工填写密钥。
- **自动续期**：凭证过期前自动续期；续期失败会在卡片上提示重新登录，不会静默使用失效凭证。
- **多账号轮转**：可以存多个账号（在卡片上再登录一次即可添加）。某个账号的会话槽位被占时，
  请求会自动换到下一个账号，不必干等 —— 这是「停止生成后重新提问要等半分钟」的正解。
- **可选模型**：可在设置卡片里勾选要出现在模型选择器中的模型（配置项 `enabledModels`）。未勾选的模型只是不再被推荐，已经选定它的会话仍可继续使用；不勾选等同于提供全部模型。
- **模型清单自动发现**：启动后与每小时各拉一次账号真实可用的模型（内置 / 限时福利 / agent-center 三路合并），失败时退回内置种子清单。
- **本机用量**：卡片与 `dsh-codearts usage` 展示今日/累计的请求数与输入输出 token（按模型、按账号），以及每个账号的**会话槽位占用**（占用时正好解释了「为什么刚才要等半分钟」）。CodeArts 没有额度接口，这里只统计本机经插件发出的请求，官方额度明细见卡片上的链接。
- **图片输入**：支持视觉的模型可直接在对话里粘贴或拖入图片。
- **降级路径**：也可以在卡片里直接粘贴安全令牌，适用于脚本或排查场景。
- **命令行**：提供 `status` / `doctor` / `logout` 三个子命令，便于在无图形界面时检查登录状态。

## 安装

详见 [INSTALL.md](./INSTALL.md)。核心是把 `package.json` + `lib/` + `cordis.patch.yml` 放进
`profiles/<profile>/node_modules/dsh-codearts/`，并在 profile 的 `package.json`、
`node_modules/.package-map.json`、`node_modules/.modules.yaml` 登记。

```sh
# 从本仓库构建产物
pnpm install && pnpm run build
node scripts/deploy.mjs [profileDir]     # profileDir 默认 <用户目录>/.dsh/profiles/desktop
```

改代码调试时不必反复重启：见 [DEV.md](./DEV.md)（宿主侧走 `dsh-hmr` 模块热重载，客户端卡片走
`dsh-client-hmr` 自动替换进浏览器）。

## 使用

1. 打开 DSH 设置 → CodeArts 卡片 → 「使用华为云账号登录」。
2. 浏览器打开授权页 → 登录华为云账号 → 自动跳回本机回调，凭证写入
   `$DSH_HOME/.codearts-auth.json`。
3. 新建对话，provider 选择 `codearts`，再选一个模型即可开始。

## 命令行

```sh
dsh plugin --profile <profile> exec dsh-codearts status [--json]   # 登录状态与种子模型清单
dsh plugin --profile <profile> exec dsh-codearts models [--json]   # 向上游发现当前账号的真实模型
dsh plugin --profile <profile> exec dsh-codearts usage [--json]    # 本机用量账本（非账号额度）
dsh plugin --profile <profile> exec dsh-codearts doctor            # 不涉及密钥的环境诊断
dsh plugin --profile <profile> exec dsh-codearts logout            # 清除本插件保存的凭证
```

`models` 是排查「模型选择器里怎么没有某个模型」的第一手段：它打印上游真实返回的清单
（内置 / 限时福利 / agent-center 三路合并），而不是插件里那份手维护的种子清单。

`usage` 读的是插件自己的账本（`$DSH_HOME/.codearts-usage.json`，按天保留 60 天）——
**不是账号额度**：CodeArts 没有额度接口，官方明细在
`codearts.huaweicloud.com/portal/settings/personal-usage`，卡片上也有这个链接。

`doctor` 只输出路径、状态与版本，不会打印任何令牌内容，输出可以直接贴进问题反馈；`logout`
只删除本插件自己的凭证副本，不影响账号本身。

## 架构

沿用 `dsh-codebuddy-cli` 的结构：本地 loopback shim + pi-ai adapter。

```
DSH 对话窗口
   │  OpenAI /chat/completions 格式, Bearer=<本进程随机密钥>
   ▼
dsh-codearts shim  (127.0.0.1:随机端口)
   │  注入 x-auth-token: <华为云 STS security_token>
   │  + 华为云 AK/SK SDK-HMAC-SHA256 签名
   ▼
CodeArts /api/v2/chat/completions
```

shim 只监听回环地址，并校验 Host、Origin 与本进程随机密钥，其他本机进程无法冒用。

## 已知限制

- 凭证有效期约 2 小时，过期前会自动续期（刷新令牌与 DPoP 密钥绑定）；续期失败会提示重新登录。
- 上游对**每个账号**的并发会话数有硬性限制（3 个），每个会话占用约 1 分钟才释放，而且**中途
  停止生成并不减免这个占用**：即使只跑了不到一秒就停，同样会占满一个名额。这是上游行为，
  客户端无法提前释放。**在卡片上添加第二个账号即可化解** —— 插件会把请求自动轮转到还有余量
  的账号上。
- 只有一个账号时，刚停止过一次生成就立刻重新提问，仍可能要等约半分钟。插件会自动排队重试，
  不需要手动重发，但等待期间界面上不会有新内容。
- 上游的登录响应不返回用户标识（实测 `user_id` / `user_name` 都是空串），插件改用 DPoP 公钥
  作为账号标识。副作用：**对同一个账号重新登录会被当成一个新账号**，旧条目会因凭据失效而
  自行停用，可在卡片上删掉。
- **模型动态发现**：启动时与每小时各向上游拉一次真实模型清单（内置 / 限时福利 /
  agent-center 三路合并），拉不到就退回内置种子清单，不会因为上游抖动把模型选择器清空。
  某个模型没出现时，用 `dsh-codearts models` 看上游到底返回了什么。
- 上游标称的参数不一定可用：福利网关把 `max_tokens` 标成 393216，而聊天端点实测超过
  65536 就报 `InferHub.001001005.400`。插件按**实测上限**下发请求（免费 DeepSeek 系列
  65536、GLM-5.2 已实测可到 131072），没实测过的模型退回 65536 保守值。上下文长度用发现值，
  它只影响 DSH 的上下文计量与截断余量。
- 用量账本只统计**本机经插件发出**的请求：CodeArts 不提供额度/积分接口，所以卡片上的数字
  不等于账号总额度；官方明细请走卡片里的链接。账本按天保留 60 天，换机器/清 `$DSH_HOME` 即丢失。
- 目前只提供中文文档。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的账号在本机调用，请勿用于商业用途或
  超出个人合理使用的场景。
- 使用者需遵守华为云及 CodeArts 的服务条款；因使用本项目产生的任何后果（包括但不限于账号
  被限制、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与华为、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，
  其商标权利归各自所有。

## 致谢

- [dsh-codebuddy-cli](https://github.com/fu827707013/dsh-codebuddy-cli)（MIT）— 本插件的
  DSH 插件结构、loopback shim 与 provider 注册方式均以其为参照。

## 许可证

[MIT](./LICENSE)
