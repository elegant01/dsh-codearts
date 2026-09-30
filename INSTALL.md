# dsh-codearts 安装与验证指引

把华为云 CodeArts 接入 DeepSeek Harness 桌面版（DSH）的插件。

## 一、安装到 desktop profile

把插件复制并登记进 DSH 的 desktop profile，共三步：

- 包本体放到 `<用户目录>\.dsh\profiles\desktop\node_modules\dsh-codearts\`
  （含 `lib/`、`cordis.patch.yml`、`package.json`、`README.md`、`LICENSE`）
- 在 `profiles/desktop/package.json` 的 `dependencies` 声明 `dsh-codearts`
- 在 `node_modules/.package-map.json` 与 `node_modules/.modules.yaml` 登记

`scripts/deploy.mjs` 会自动完成这三步（并只在需要时写入 profiles 下的 manifest）：

```sh
node scripts/deploy.mjs [profileDir]     # profileDir 默认 <用户目录>/.dsh/profiles/desktop
```

> 备份：脚本改动的 profile 文件会留下 `*.bak-codearts-*` 备份，回滚直接还原即可。

> 部署是**原地覆盖**（内容没变的文件连 mtime 都不动）：这样已启用的 `dsh-hmr` 模块监听才能
> 把改动当成一次变更并热重载插件。开发循环与热重载的完整说明见 [DEV.md](./DEV.md)。

## 二、在 DSH 桌面端验证

1. **完全退出** DeepSeek Harness（托盘退出，确保进程不在）。
2. 重新打开 DSH。
3. 进入 **设置 → 插件/Providers**，应当能看到 `dsh-codearts`（CodeArts Connect）已注册。
4. 进入 **设置 → CodeArts 卡片**（或 Providers 里的 codearts）：
   - 点「使用华为云账号登录」→ 浏览器打开授权页 → 华为云账号登录；
   - 登录成功会自动跳回本机回调，凭证写入 `<用户目录>\.dsh\.codearts-auth.json`。
5. 新建对话，provider 选 **codearts**，模型选 `GLM-5.2`（或 `deepseek-v4-flash` 等），
   发送消息即可。

## 三、如果 GUI 里看不到插件 / 报加载错误

按顺序排查：

1. 确认 DSH 完全退出后再启动（热重载不扫描新插件）。
2. 看 `profiles/desktop/node_modules/dsh-codearts/lib/index.mjs` 是否存在。
3. 看 DSH 启动日志（如 `profiles/desktop/.plugin-manager/logs/`）里有没有
   `dsh-codearts` 相关的报错；把报错贴给开发者。
4. 若需要彻底卸载：删除 `node_modules/dsh-codearts` 目录，并从
   `profiles/desktop/package.json`、`node_modules/.package-map.json`、
   `node_modules/.modules.yaml` 里移除 `dsh-codearts` 条目（备份文件在，照着删即可）。

## 四、在其他机器 / 干净重装

1. 构建产物：`pnpm install && pnpm run build`（输出在 `lib/`）。
2. 把本插件的 `package.json` + `lib/` + `cordis.patch.yml` 整体复制到
   目标 DSH 的 `profiles/<profile>/node_modules/dsh-codearts/`。
3. 在目标 profile 的 `package.json` 的 `dependencies` 增加 `"dsh-codearts": "0.1.0"`。
4. 在 `node_modules/.package-map.json` 增加
   `"dsh-codearts": {"url":"./dsh-codearts","dependencies":{"dsh-codearts":"dsh-codearts"}}`
   并在 `"."` 的 `dependencies` 里加 `"dsh-codearts":"dsh-codearts"`。
5. 在 `node_modules/.modules.yaml` 的 `hoistedLocations` 增加
   `"dsh-codearts@0.1.0": ["node_modules\\dsh-codearts"]`。
6. 重启 DSH。

## 五、技术链路（已独立验证通过）

| 环节 | 结果 |
|---|---|
| OAuth 登录（本地回调 + PKCE + DPoP） | ✅ 浏览器登录 → 自动换 token → 落盘 |
| 换 token（STS `/v1/oauth2/tokens` 表单 + DPoP） | ✅ 拿到 AK/SK + refresh_token |
| 聊天鉴权（`x-auth-token` + AK/SK HMAC 签名） | ✅ HTTP 200 |
| 聊天端点 `/api/v2/chat/completions` | ✅ OpenAI 兼容 SSE |
| 模型 GLM-5.2 真实响应 | ⚠️ 上游原始 SSE 已抓到（探针），但插件内的 SSE **翻译层**（累计快照→增量）尚未端到端验证 |

> 说明：上表 ✅ 均为**独立探针**（`scripts/probe-*.ts`）直连华为云所得，绕过了 DSH 宿主
> 与插件进程内链路。插件进程内（shim → adapter → 卡片）的端到端仍需在 DSH GUI 内确认，
> 无头环境无法代验。

## 六、已知限制

- 免费/福利模型（`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813`、`deepseek-v4.1-flash`、
  `glm-5.3-flash`）已支持：聊天前自动 `claimBenefit`，并在签名前带 `maas_type: benefit`
  头，可零成本使用。商业模型（GLM-5.2 等）同样正常。
- 凭证有效期约 24 小时，过期后插件会自动用 refresh_token 续期。
- 无头环境无法渲染 DSH GUI，故 GUI 内的端到端渲染需你在本机确认。

## 七、部署禁忌（血泪教训：曾导致 DSH 启动直接崩溃）

⚠️ **绝不能用 Windows PowerShell 5.1 的 `Set-Content` / `Out-File` 写入任何 profile manifest**
（`profiles/desktop/package.json`、`node_modules/.package-map.json`、
`node_modules/.modules.yaml` 等）。PowerShell 5.1 的文本写入默认带 **UTF-8 BOM
（EF BB BF）**，而 DSH 宿主的 `readProfileManifest` 是裸 `JSON.parse`，见 BOM 就抛
`DesktopHostFatalError`，启动直接死；其"自动恢复"又用自己的写盘路径重写一遍，BOM
还在，于是反复弹「The recovery operation failed」无限崩溃。

**正确做法（任选其一）：**
1. **优先 `Copy-Item` 二进制复制**（如把改好的 package.json 复制进去）——`Copy-Item`
   不增删字节，不会带 BOM。
2. **用 Node `fs.writeFileSync`**（默认无 BOM）。
3. **用 PowerShell 7 的 `-Encoding utf8NoBOM`**（PS5.1 没有该选项）。

写入后务必用 Node 校验前 3 字节是否为 BOM：
```js
const fs=require('fs');const b=fs.readFileSync(p);
console.log(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF?'BOM!':'no-BOM');
```

> 历史事故：18:06–18:09 的部署用 PS5.1 写 `desktop/package.json` 带了 BOM，导致启动
> 连环崩溃；最终由用户侧另开 agent 用 Node 重写为无 BOM 修复（备份
> `package.json.bak-bomfix-*`）。全 `~/.dsh` 树已扫，仅此一个 BOM 文件。
