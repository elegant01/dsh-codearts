# dsh-codearts 项目约定

## 推送与发布：默认不动

- **只有用户明确说「推 github」「发版」「发布」时，才做完整推送链路**：
  `git push origin main` → 打 `vX.Y.Z` tag → 推 tag → 建 GitHub Release → 由 CI
  （`.github/workflows/release.yml`，npm Trusted Publisher / OIDC）发布到 npm。
- 平时改完代码的正常收尾只到这几步：`pnpm -s build` → `pnpm -s typecheck` →
  `pnpm -s test` → `pnpm -s deploy`（同步 `lib` 到本机
  `~/.dsh/profiles/desktop/node_modules/dsh-codearts`）。
  **不要自行 `git push`、不要打 tag、不要建 Release、不要 `npm publish`。**
- 本地 `git commit` 可以做（把改动记成一版），但停在本机，等用户发话再推。
- 用户说「发吧」而不带「推 github」时，先问清楚是「只部署到本机」还是「全流程发布」。

## npm 发布的坑

- 本机 `~/.npmrc` 的 npmjs 令牌属于 `yxzpro`，而包 owner 是 `elegant01`，直接
  `npm publish` 会 404（npm 对无权限的包统一回 404，不代表包不存在）。
- 发布只能走 Release 触发的 CI：本地能做的只有推 tag 和建 Release 的前置动作。
- npm 收包后有 1 分钟左右的读端延迟，`registry.npmjs.org/.../latest` 才会翻新；
  CI 日志里出现的 “Your package is being processed” 是正常现象，不是失败。

## 构建链路备忘

- `scripts/dsh-css.mjs` 是 tsdown 插件，构建时把 `*.module.css` 编成虚拟模块**并回写
  `*.module.css.d.ts`** —— 新增 CSS 类名必须先 `pnpm -s build` 再跑 typecheck。
- 改动 `src` 里的宿主侧模块（`web-status.ts`、`usage.ts`、`shim.ts` 等）不会被 HMR
  热载，需要重启 DSH 才生效；部署后立刻查 `/api/codearts/status` 看到旧结构是正常的。