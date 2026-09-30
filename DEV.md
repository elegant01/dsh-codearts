# 开发循环（改代码后不用重启 DSH）

这份文档解决一件事：**改插件代码后，怎样不用「退出 DSH → 重新打开 → 手动点开卡片验证」**。

结论先说：DSH 自带两条热重载链路，插件只要按它们的规矩部署，宿主侧和客户端改动都能自动生效。

| 改的是 | 生效方式 | 需要重启 DSH 吗 |
|---|---|---|
| `src/*.ts`（provider、shim、签名、状态路由…） | `dsh-hmr` 监听部署目录，重建后热重载插件条目 | 不需要（首次启用监听时可能要重启一次） |
| `src/client/*.tsx`、`*.module.css`（设置卡片 UI） | `dsh-client-hmr` 轮询客户端产物，变化后送进浏览器重新执行 bundle | 不需要，也不用刷新页面 |
| `package.json` 的 `dsh.*` 清单、换包版本、增删插件条目 | 宿主只在启动时读取这些 | **需要** |

## 一次性准备

```sh
pnpm run hmr:on        # 往 profile 的 cordis.patch.yml 写入 hmr 覆盖行（幂等、无 BOM、带备份）
pnpm run hmr:status    # 查看当前状态
pnpm run hmr:off       # 关掉，回到 base 默认（只监听 profile 配置）
```

`hmr:on` 做的是：把插件的部署目录加进 `@deepseek-ai/dsh-hmr` 的监听范围。

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: false
  config:
    root:
      - node_modules/dsh-codearts
    ignored: []
```

两个字段都不能省，原因都在 DSH 的实现里：

- `root` 默认是空表（`dsh-base` 的 patch 里写作 `root: []`），意思是**只监听 profile 配置文件、不监听模块**，所以改代码必须重启。
- `ignored` 的默认值里有一条排除 `node_modules` 的 glob，而插件恰好装在 `node_modules/dsh-codearts`，正好被默认值排除；而且它是按「相对 base 目录」做 picomatch 匹配的，所以覆盖行里必须显式写成空表。
- patch 是**整份 `config` 替换**而不是字段合并，所以 `root` 和 `ignored` 要一起给全。

改完这个 patch 通常不用重启：profile 的 patch 文件本身也在 HMR 的监听范围内（profile 里 `patchReload: live`），条目会重新加载。若发现没生效，重启一次 DSH 即可，之后就一直有效。

## 日常循环

```sh
pnpm run dev        # tsdown watch + 自动部署；Ctrl-C 退出
```

它会：监听 `src/` 的改动 → tsdown 重建 `lib/` → 包客户端 bundle → **原地同步**进 profile。剩下的交给 DSH：

- 宿主侧：改动落到部署目录的 `lib/*.mjs`，`dsh-hmr` 捕获到模块变化后重挂载插件条目。
- 客户端侧：`lib/client/index.js` 的 mtime/大小一变，`dsh-client-hmr` 就通过 `/plugins/events` 通知已打开的页面替换插件（页面里的 React 状态会丢，会话和工作区不受影响）。

其他用法：

```sh
pnpm run dev -- --once                  # 只构建并部署一次（等价于旧的 build + deploy）
pnpm run dev -- <profileDir>             # 指定 profile，默认 ~/.dsh/profiles/desktop
DSH_CODEARTS_DEV_DEBUG=1 pnpm run dev    # 打印 fs.watch 事件，排查「改了没反应」
pnpm run deploy                          # 只部署（可带 profileDir 与 --quiet）
```

## 两个必须守住的约定

这两条不是风格问题，破了热重载就不工作，都是踩过之后写进来的：

1. **部署必须原地覆盖写文件，不能清空目录再拷回。**
   `dsh-hmr` 只处理 chokidar 的 `change` 事件（add/unlink 不在处理之列），而「先删整个 `lib/` 再复制」产生的是 unlink + add。`scripts/deploy.mjs` 因此改成：内容不同的文件原地覆盖，源里没有的文件才删，内容相同的连 mtime 都不碰。

2. **绝不能用 PowerShell 5.1 的文本写入去碰 profile 里的 manifest / patch。**
   PS 5.1 的 `Set-Content` / `Out-File` 默认带 UTF-8 BOM，宿主的 `readProfileManifest` 是裸 `JSON.parse`，见 BOM 就抛 `DesktopHostFatalError`，启动直接崩，而且「自动恢复」会把 BOM 再写回去，于是无限崩溃。`scripts/` 下的脚本一律走 `fs.writeFileSync`（无 BOM）并在写完后复查前 3 字节。

## 排查

- **改了代码没反应**：先 `pnpm run hmr:status` 确认覆盖行在；再确认 `pnpm run dev` 真的部署了（日志里会有「已部署（新增 x / 覆盖 y / 清理 z）」）。
- **日志里出现「产物无有效变化，跳过部署」**：`lib/` 内容与上次部署一致。若你确实改了源码，多半是被构建常量折叠掉了（例如只改了被 `define` 替换掉的分支），或者 tsdown 还没重建完。
- **`lib/` 首次构建期间**：`dev` 会静默等待，不会报错。
- **事件很多但内容没变**：tsdown 清理输出目录时会瞬间产生大量文件事件，本脚本按内容指纹判断并自动退避（400ms → 最多 5s），不会空转刷盘。
- **插件加载失败**：看 `profiles/<profile>/.plugin-manager/logs/` 里的宿主日志，重载失败会在插件列表里显示并可重试。

## 脚本一览

| 脚本 | 作用 |
|---|---|
| `scripts/dev.mjs` | 开发循环：tsdown watch + 包客户端 bundle + 原地部署 |
| `scripts/deploy.mjs` | 部署：原地同步 `lib/` 与包内文件，按需登记 profile 的三份 manifest（改动前留 `*.bak-codearts-*` 备份） |
| `scripts/hmr.mjs` | 开关 profile 的 hmr 模块监听（`on` / `off` / `status`） |
| `scripts/wrap-client.mjs` | 把客户端 CJS 产物包成 `__ModuleLoader__` 自注册形态 |

## 依据

以上关于热重载的结论来自 DSH 自带文档与实现，而不是猜测：

- `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`：`hmr` 条目默认 `root: []`，注释写着「Profile configuration reloads by default; module roots are opt-in.」
- `@deepseek-ai/dsh-hmr` 的 README：`root` / `ignored` / `debounce` 的含义；「模块替换需要 Node loader 内部接口……HMR 本身不重启进程」；「通过插件管理器替换已安装包版本仍需要重启」。
- `@deepseek-ai/dsh-hmr` 的实现：只 `watch` 后注册 `change` 回调；`ignored` 以 `relative(watchBaseDir, path)` 做 picomatch 匹配；`partialReload()` 把改动映射回插件条目并重挂载。
- `@deepseek-ai/dsh-client-hmr` 的 README 与实现：宿主半侧 `stat` 轮询每个图条目的客户端产物（`artifactBaseline`），变化即 `clientModules.rebuilt(id)` 并通过 `/plugins/events` 推送 `rebuilt` 帧，浏览器半侧据此替换插件。
