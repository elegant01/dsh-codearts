# DSH CodeArts Connect

English | [中文](./README.md)

Brings Huawei Cloud CodeArts into DeepSeek Harness (DSH), so the models CodeArts offers
(GLM-5.2, Pangu, Qwen, DeepSeek, …) are usable straight from the DSH chat window.

## Features

- **Account sign-in**: click “Sign in with Huawei Cloud” once in the settings card; the
  browser finishes authorization and the credential is stored automatically — no keys to
  copy by hand.
- **Automatic renewal**: the credential is renewed before it expires. If renewal fails the
  card tells you to sign in again instead of silently using a dead credential.
- **Multiple accounts with rotation**: store more than one account (sign in again from the
  card). When one account has no free session slot, the request moves to the next account
  instead of waiting — this is the actual fix for “I stopped a generation and the next
  question takes half a minute”.
- **Optional models**: choose which models appear in the picker (config `enabledModels`).
  Unchecking one only stops recommending it; sessions already using it keep working. An
  empty selection means “offer everything”.
- **Model discovery**: the plugin fetches the account’s real model list on startup and
  hourly (built-in, limited-time benefit and agent-center sources merged) and falls back to
  the built-in seed list when that fails.
- **Local usage**: the card and `dsh-codearts usage` show today’s and lifetime request and
  token counts (per model, per account), plus each account’s **session-slot occupancy** —
  which is exactly why a turn had to wait. CodeArts exposes no quota API, so these are the
  requests this machine sent through the plugin; the card links to the official usage page.
- **Image input**: models with vision support accept pasted or dropped images in a chat.
- **Fallback path**: you can also paste a bare security token in the card, for scripts or
  troubleshooting.
- **CLI**: `status` / `models` / `usage` / `identity` / `doctor` / `logout` for checking
  sign-in state, discovering models and reading usage without a GUI.

## Install

See [INSTALL.en.md](./INSTALL.en.md) for the full walkthrough. In short: put
`package.json` + `lib/` + `cordis.patch.yml` into
`profiles/<profile>/node_modules/dsh-codearts/` and register the package in the profile’s
`package.json`, `node_modules/.package-map.json` and `node_modules/.modules.yaml`.

```sh
# build from this repository
pnpm install && pnpm run build
node scripts/deploy.mjs [profileDir]     # defaults to <home>/.dsh/profiles/desktop
```

Debugging does not require restarting DSH every time: see [DEV.md](./DEV.md) (Chinese) —
host-side changes hot-reload through `dsh-hmr`, and the client card is swapped into the
browser by `dsh-client-hmr`.

## Usage

1. Open DSH settings → CodeArts card → “Sign in with Huawei Cloud”.
2. The browser opens the authorization page → sign in → it redirects back to a local
   callback and the credential is written to `$DSH_HOME/.codearts-auth.json`.
3. Start a new conversation, pick the `codearts` provider, then pick a model.

## CLI

```sh
dsh plugin --profile <profile> exec dsh-codearts status [--json]   # sign-in state + seed model list
dsh plugin --profile <profile> exec dsh-codearts models [--json]   # discover the account's real models
dsh plugin --profile <profile> exec dsh-codearts usage [--json]    # local usage ledger (not account quota)
dsh plugin --profile <profile> exec dsh-codearts identity [--fix]  # stable account ids; merge duplicates
dsh plugin --profile <profile> exec dsh-codearts doctor            # secret-free diagnostics
dsh plugin --profile <profile> exec dsh-codearts logout            # drop the credential this plugin stored
```

`models` is the first thing to run when a model is missing from the picker: it prints what
the upstream actually returns (built-in / limited-time benefit / agent-center, merged)
rather than the hand-maintained seed list.

`usage` reads the plugin’s own ledger (`$DSH_HOME/.codearts-usage.json`, kept per day for
60 days) — **not an account balance**: CodeArts has no quota API. Official detail lives at
`codearts.huaweicloud.com/portal/settings/personal-usage`, which the card also links to.

`identity` prints the stable upstream `user_id` for each stored account (the same id twice
means a duplicate entry); `--fix` merges those onto the stable key and backfills
`user_name` / `domain_id`.

`doctor` prints only paths, booleans and versions — never token material — so its output is
safe to paste into a bug report. `logout` removes only this plugin’s own copy of the
credential; nothing outside the plugin is touched.

## Architecture

The structure follows `dsh-codebuddy-cli`: a local loopback shim plus a pi-ai adapter.

```
DSH chat window
   │  OpenAI /chat/completions, Bearer=<per-process random secret>
   ▼
dsh-codearts shim  (127.0.0.1:random port)
   │  injects x-auth-token: <Huawei Cloud STS security_token>
   │  + Huawei Cloud AK/SK SDK-HMAC-SHA256 signature
   ▼
CodeArts /api/v2/chat/completions
```

The shim binds loopback only and validates Host, Origin and the per-process secret, so
other local processes cannot impersonate it.

## Known limitations

- Credentials last about 2 hours and are renewed before expiry (the refresh token is bound
  to the DPoP key). When renewal fails, the card asks you to sign in again.
- The upstream caps concurrent sessions **per account** at 3, and a session is only
  released after about a minute — **stopping a generation does not give the slot back**:
  even a run that lasted under a second occupies one for the full minute. That is upstream
  behaviour and the client cannot release it early. **Adding a second account in the card
  works around it**, because requests rotate to an account with room.
- With a single account, asking again right after stopping a generation may still take
  about half a minute. The plugin queues and retries automatically; the UI simply shows
  nothing new while it waits.
- The login response carries no user identity (measured: `user_id` / `user_name` are empty
  strings), so after signing in the plugin asks
  `/snap-manager/v1/current/user` for the stable `user_id` and keys accounts on that: a
  re-login of the same account updates the existing entry instead of creating a new one.
  When that probe fails (network, API change) the old behaviour returns — accounts keyed by
  their DPoP public key, where a re-login looks like a new account and the old entry goes
  stale on its own. Legacy duplicates can be merged with `dsh-codearts identity --fix`
  (running it without `--fix` is read-only).
- Advertised parameters are not always usable: the benefit gateway advertises `max_tokens`
  393216, while the chat endpoint rejects anything above 65536 with
  `InferHub.001001005.400`. Requests are clamped to the **measured** ceiling per model
  (65536 for the free DeepSeek family, 131072 for GLM-5.2, which was measured); models
  without a measurement fall back to the conservative 65536. Context length uses the
  discovered value, which only affects DSH’s context meter and truncation margin.
- The usage ledger counts only requests **this machine sent through the plugin**, so its
  numbers are not an account total; the card links to the official page. The ledger keeps
  60 days and is lost when you move machines or clear `$DSH_HOME`.
- Docs: README and INSTALL have English versions; [DEV.md](./DEV.md) (hot-reload dev loop)
  is Chinese-only for now.

## Changelog

See [CHANGELOG.md](https://github.com/elegant01/dsh-codearts/blob/main/CHANGELOG.md) for the changes in each release.

## Disclaimer

- This project is **for personal study and research only**. It drives the user’s own
  account from the user’s own machine; do not use it commercially or beyond reasonable
  personal use.
- Users must comply with the Huawei Cloud and CodeArts terms of service. Any consequence of
  using this project (including but not limited to account restrictions or service
  interruption) is the user’s own responsibility.
- The author is not liable for any direct or indirect loss caused by using or misusing this
  project.
- This project is not affiliated with, authorized by, or endorsed by Huawei or DeepSeek.
  Product names appear only to describe compatibility, and their trademarks belong to their
  respective owners.

## Acknowledgements

- [dsh-codebuddy-cli](https://github.com/fu827707013/dsh-codebuddy-cli) (MIT) — this
  plugin’s DSH plugin structure, loopback shim and provider registration follow it.

## License

[MIT](./LICENSE)
