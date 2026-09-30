# dsh-codearts install & verification guide

English | [中文](./INSTALL.md)

The plugin that brings Huawei Cloud CodeArts into DeepSeek Harness Desktop (DSH).

## 1. Install into the desktop profile

Copying and registering the plugin takes three steps:

- put the package into `<home>/.dsh/profiles/desktop/node_modules/dsh-codearts/`
  (containing `lib/`, `cordis.patch.yml`, `package.json`, `README.md`, `LICENSE`)
- declare `dsh-codearts` under `dependencies` in `profiles/desktop/package.json`
- register it in `node_modules/.package-map.json` and `node_modules/.modules.yaml`

`scripts/deploy.mjs` does all three (and only writes the profile manifests when something
actually changes):

```sh
node scripts/deploy.mjs [profileDir]     # defaults to <home>/.dsh/profiles/desktop
```

> Backups: any profile file the script changes is backed up as `*.bak-codearts-*`; rolling
> back is just restoring it.

> Deployment **overwrites in place** (a file whose content is unchanged is not even
> touched): that is what lets an enabled `dsh-hmr` module watch see the change and reload
> the plugin. The full dev-loop and hot-reload story is in [DEV.md](./DEV.md) (Chinese).

## 2. Verify in DSH Desktop

1. **Fully quit** DeepSeek Harness (quit from the tray; make sure the process is gone).
2. Start DSH again.
3. Open **Settings → Plugins/Providers**: `dsh-codearts` (CodeArts Connect) should be
   registered there.
4. Open **Settings → the CodeArts card** (or codearts under Providers):
   - click “Sign in with Huawei Cloud” → the browser opens the authorization page → sign in;
   - after a successful sign-in it redirects to a local callback, and the credential is
     written to `<home>/.dsh/.codearts-auth.json`.
5. Start a new conversation, pick the **codearts** provider and a model such as `GLM-5.2`
   (or `deepseek-v4-flash`), then send a message.

## 3. If the GUI does not show the plugin, or loading fails

Check in this order:

1. Make sure DSH was fully quit before starting again (hot reload does not scan for *new*
   plugins).
2. Check that `profiles/desktop/node_modules/dsh-codearts/lib/index.mjs` exists.
3. Look for `dsh-codearts` errors in the DSH startup log (for example under
   `profiles/desktop/.plugin-manager/logs/`) and send them to the developer.
4. To uninstall completely: delete the `node_modules/dsh-codearts` directory and remove the
   `dsh-codearts` entries from `profiles/desktop/package.json`,
   `node_modules/.package-map.json` and `node_modules/.modules.yaml` (the backups show
   exactly what to delete).

## 4. Another machine / clean reinstall

1. Build: `pnpm install && pnpm run build` (output lands in `lib/`).
2. Copy this plugin’s `package.json` + `lib/` + `cordis.patch.yml` into the target DSH’s
   `profiles/<profile>/node_modules/dsh-codearts/`.
3. Add `"dsh-codearts": "<version>"` to `dependencies` in the target profile’s
   `package.json`.
4. In `node_modules/.package-map.json` add
   `"dsh-codearts": {"url":"./dsh-codearts","dependencies":{"dsh-codearts":"dsh-codearts"}}`
   and add `"dsh-codearts":"dsh-codearts"` to the `"."` entry’s `dependencies`.
5. In `node_modules/.modules.yaml` add
   `"dsh-codearts@<version>": ["node_modules\\dsh-codearts"]` to `hoistedLocations`.
6. Restart DSH.

## 5. Technical chain (verified independently)

| Step | Result |
|---|---|
| OAuth sign-in (local callback + PKCE + DPoP) | ✅ browser sign-in → token exchange → stored |
| Token exchange (STS `/v1/oauth2/tokens`, form + DPoP) | ✅ AK/SK + refresh_token obtained |
| Chat auth (`x-auth-token` + AK/SK HMAC signature) | ✅ HTTP 200 |
| Chat endpoint `/api/v2/chat/completions` | ✅ OpenAI-compatible SSE |
| Model discovery (built-in / benefit / agent-center) | ✅ merged live, see `dsh-codearts models` |
| Local usage ledger (per day, per model, per account) | ✅ recorded from the stream’s usage frame |
| Account identity (`/snap-manager/v1/current/user`) | ✅ stable `user_id` returned |

> The ✅ rows above were confirmed against a live account from this machine. The end-to-end
> path *inside* the plugin process (shim → adapter → card) still needs to be seen in the DSH
> GUI, which a headless environment cannot do for you.

## 6. Known limitations

- Free / limited-time benefit models (`deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`,
  `deepseek-v4.1-flash`, `glm-5.3-flash`) are supported: the plugin claims the benefit
  before chatting and sends the `maas_type: benefit` header before signing, so they cost
  nothing. Commercial models (GLM-5.2 and friends) work normally too.
- The model list is **discovered** (built-in `/v1/model/builtin`, benefit
  `/api/v1/gateway/config`, agent-center `gpts.models`, merged), refreshed at startup and
  hourly, falling back to the built-in seed list when a source fails or nobody is signed in.
  `dsh-codearts models` shows what upstream really returns.
- The advertised `max_tokens` exceeds what the chat endpoint accepts (the benefit gateway
  advertises 393216; the endpoint reports `InferHub.001001005.400` above 65536). Requests
  are clamped to the measured ceiling — see `MEASURED_MAX_TOKENS`.
- Usage shown in the card and by `dsh-codearts usage` is a **local ledger**
  (`$DSH_HOME/.codearts-usage.json`, kept per day for 60 days): CodeArts has no quota API.
  Official detail is at
  `codearts.huaweicloud.com/portal/settings/personal-usage`.
- Credentials last about 24 hours and are renewed automatically with the refresh token.
- A headless environment cannot render the DSH GUI, so the GUI end-to-end path has to be
  confirmed on your machine.

## 7. Deployment taboo (hard-won: it crashed DSH on startup)

⚠️ **Never write any profile manifest** (`profiles/desktop/package.json`,
`node_modules/.package-map.json`, `node_modules/.modules.yaml`, …) **with Windows
PowerShell 5.1’s `Set-Content` / `Out-File`**. PS 5.1 writes UTF-8 **with a BOM
(EF BB BF)** by default, and the DSH host reads those files with a bare `JSON.parse` — a
BOM makes it throw `DesktopHostFatalError` and startup dies outright. Its “automatic
recovery” then rewrites the file through its own path, BOM included, so the crash repeats
forever behind “The recovery operation failed”.

**Do this instead (any one of them):**

1. **Prefer `Copy-Item`** (binary copy of an already-correct file) — it never adds or
   removes bytes, so no BOM.
2. **Use Node’s `fs.writeFileSync`** (no BOM by default).
3. **Use PowerShell 7’s `-Encoding utf8NoBOM`** (PS 5.1 has no such option).

After writing, always check the first three bytes with Node:

```js
const fs=require('fs');const b=fs.readFileSync(p);
console.log(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF?'BOM!':'no-BOM');
```

> History: a deployment between 18:06 and 18:09 wrote `desktop/package.json` with a BOM via
> PS 5.1, which crashed startup repeatedly. It was fixed by rewriting the file with Node
> (backup `package.json.bak-bomfix-*`). A scan of the whole `~/.dsh` tree found that one
> file only.
