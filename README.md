# dsh-codearts

把华为云 CodeArts 接入 DeepSeek Harness（DSH）桌面版的插件。内置**华为云 OAuth2 登录**（PKCE + DPoP，真零配置），登录后即在 DSH 对话窗口使用 CodeArts 的模型（GLM-5.2、盘古、Qwen、DeepSeek 等）。

## 架构

沿用 `dsh-codebuddy-cli` 的标准做法：本地 loopback shim + pi-ai adapter。

```
DSH 对话窗口
   │  OpenAI /chat/completions 格式, Bearer=<本进程随机密钥>
   ▼
dsh-codearts shim  (127.0.0.1:随机端口)
   │  注入 x-auth-token: <华为云 STS security_token>
   │  + 华为云 AK/SK SDK-HMAC-SHA256 签名
   ▼
CodeArts /api/v2/chat/completions  (snap-access.cn-north-4.myhuaweicloud.com)
```

- `oauth.ts`：华为云 CodeArts OAuth2（PKCE + 本地回调）→ STS 换临时 AK/SK + security_token；刷新走 `/v1/oauth2/tokens`。
- `signer.ts`：华为云 AK/SK HMAC-SHA256 签名（SDK-HMAC-SHA256）。
- `dpop.ts`：DPoP ES256/P-256 证明 JWT，refresh_token 与其绑定。
- `upstream.ts`：`/api/v2/chat/completions` OpenAI 兼容 SSE，含请求翻译与流转换。
- `auth.ts`：凭证存储（`$DSH_HOME/.codearts-auth.json`），自动续期。

## 安装（桌面版 DSH）

详见 [INSTALL.md](./INSTALL.md)。核心：把 `package.json` + `lib/` + `cordis.patch.yml` 放进
`profiles/<profile>/node_modules/dsh-codearts/`，并在 profile 的 `package.json`、
`node_modules/.package-map.json`、`node_modules/.modules.yaml` 登记（与 `dsh-codebuddy-cli` 同方式）。

## 使用

1. 打开 DSH 设置 → CodeArts 卡片 → 「使用华为云账号登录」。
2. 浏览器打开授权页 → 华为云账号登录 → 自动跳回本机回调，凭证落盘。
3. 模型选择器切到 `codearts`，选 `GLM-5.2`（或 `deepseek-v4-flash` 等）即可对话。

也可走降级路径：直接在卡片里粘贴 `security_token`（需同时有 AK/SK 才能用 AK/SK 签名）。

## 独立探针（调试用）

```sh
node --experimental-strip-types scripts/probe-login.ts   # 走完整 OAuth 登录并落盘
node --experimental-strip-types scripts/probe-chat.ts "你的问题" [模型]  # 测真实聊天
```

## 目录结构

```
src/
  index.ts         插件入口：装配 shim / adapter / OAuth 路由 / 设置卡片
  shim.ts          loopback OpenAI 兼容代理
  adapter.ts       注册 codearts provider 进 DSH llm 缝
  auth.ts          OAuth 凭证存储 + 自动续期
  upstream.ts      CodeArts chat 调用 + 请求翻译 + SSE 转换
  signer.ts        华为云 AK/SK HMAC-SHA256 签名
  dpop.ts          DPoP ES256/P-256 证明 JWT
  oauth.ts         华为云 CodeArts OAuth2（PKCE + 本地回调 + STS 换 token）
  catalog.ts       静态种子模型清单
  web-status.ts    登录/状态/模型路由（供卡片调用）
  client/          Web 设置卡片（OAuth 登录 + 降级粘贴 token）
  bin.ts           status 命令行
```

## 已知限制

- 免费/福利模型（`deepseek-v4-flash-0731`、`glm-5.3-flash` 等）需要 `maas_type: benefit`
  头，并在聊天前先 `POST /api/v1/benefit/claim` 领取（幂等）；插件已自动处理，可零成本使用。
  商业模型（GLM-5.2 等）同样正常。
- 凭证有效期约 24 小时，过期后插件用 refresh_token 续期（refresh_token 与 DPoP 公钥绑定）；
  刷新失败会标记为「已过期」，卡片提示重新登录，不会静默使用过期凭证。
- 模型清单为静态种子，未做动态发现。其中 4 个福利模型 ID 经真实账号 `GET /v2/models`
  核对过；商业模型的 `contextWindow` / `maxTokens` / `supportsImages` 为占位值，未核对。
