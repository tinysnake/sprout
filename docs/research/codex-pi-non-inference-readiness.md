# Non-inference Codex and Pi readiness probes

**Issue**: [#114](https://github.com/tinysnake/sprout/issues/114) (part of map #113)

**Research date**: 2026-09-21; **rework revision**: 2026-09-22 (r0-rework2, addressing the independent re-review verdict on `2178d38e`; r0-rework1 addressed the review verdict on `2d58fb9e`).

**Scope**: Codex CLI `0.154.0` and Pi `0.86.1` — the versions installed on the supported macOS research host. Codex `0.154.0` is also the version already probed and adapter-pinned by [#45](https://github.com/tinysnake/sprout/issues/45) and `src/engine/codex.ts`; Pi has moved from `0.85.1` (#45's pin) to `0.86.1`, and every Pi claim below was re-verified against `0.86.1` sources.

**Boundary (ADR-0013)**: a readiness probe is Worker-executed and strictly non-inference. It may inspect executable/version state, use documented authentication-status operations, and read non-inference model metadata only when the operation cannot create model usage or cost. It never sends a prompt, never starts a model turn, never exports a credential, and never uses a credential-printing mode. A required fact that cannot be established this way stays `unknown` and blocks admission.

**Method**: every command below was executed live on the supported host, including negative controls (fresh `CODEX_HOME` with no credentials, and a blackhole proxy making all outbound HTTP fail) to prove that the probe results are produced without network model traffic. Every primary-source claim was additionally checked against the pinned first-party source for the pinned version, and **every retained candidate has a sanitized live before/after authentication-store observation (mtime + size + content hash)** proving it did not mutate authentication state. All live outputs were sanitized before recording: no account identity, host identity, absolute home paths, credentials, or raw diagnostics are retained in this report.

## Revision note (r0-rework1)

This revision resolves the six findings of the independent review verdict on commit `2d58fb9e`:

1. **Pi `--list-models` removed as a readiness candidate.** The pinned `main.ts` calls `runMigrations(cwd)` before creating the model runtime; `migrations.ts` can rename legacy `oauth.json`, rewrite `settings.json` (deleting `apiKeys`) and write `auth.json`. This is now demonstrated live (§3.3) and the operation is prohibited; Pi local-catalog presence is classified `unavailable` and E4 blocks on it.
2. **C4 credential guard now matches the real Codex sentence**, and **C1 requires the structured `account/read` path** instead of allowing the credential-adjacent `login status` line.
3. **All primary-source links audited**: dead `.js` Pi links replaced with the pinned `.ts` paths; every Codex link pinned to the resolved commit; the **resolved Codex commit is recorded**; ADR-0013 is cited by exact audit path/commit.
4. **Fact classification made single-valued and explicit**; local catalog presence and account entitlement are separate facts; unknown blocks admission unconditionally.
5. **Live before/after auth-store hash/mtime evidence added for every retained candidate** (§4.1).
6. **Codex `doctor` exit semantics corrected** (§2.1).

## Revision note (r0-rework2)

This revision resolves the single blocking auditability finding of the independent re-review verdict on commit `2178d38e`:

1. **Codex refresh-default citation corrected.** The report previously attributed `params.refresh_token.unwrap_or(false)` to `get_account_response` at `6b9826e3`. At that exact commit `get_account_response` uses `let do_refresh = params.refresh_token;`, and the field is a non-optional `bool` with `#[serde(default, skip_serializing_if = "std::ops::Not::not")]` in `codex-rs/app-server-protocol/src/protocol/v2/account.rs` (`GetAccountParams`). The operational conclusion is unchanged and is now cited to the actual pinned implementation and protocol definition (§2.3, [C3]).

No other evidence was weakened or rewritten; the correction is report-only.

## Executive summary

A truthful, strictly non-inference readiness probe exists for the authentication dimension of both engines at the pinned versions. The model-availability dimension is **unavailable for both** and must stay `unknown` and block admission.

- **Codex**: authentication status is fully answerable locally. The app-server RPC `account/read` with `params: {}` (never `refreshToken: true`) returns a structured authentication fact and never refreshes or sends model traffic; `codex login status` reads `auth.json` without refreshing, but in API-key mode it prints a credential-adjacent sentence and therefore must not be consumed. Model availability has no strictly local operation that establishes account entitlement: `model/list` and `codex debug models` use `RefreshStrategy::OnlineIfUncached` (a backend catalog `GET /models` on cache miss, whose non-billability is unproven), and `codex debug models --bundled` is strictly local but stale, proving only binary capability.
- **Pi**: authentication status is fully answerable locally via `pi auth check --json --no-refresh`, which reads `auth.json` through a `ReadOnlyAuthStorage` and returns a machine-readable `{status, provider, reason?, authType?}` object. **`pi --list-models` is not a valid readiness operation**: it runs startup migrations that can rewrite authentication state, so it is prohibited and Pi local-catalog presence is `unavailable`. The credential-printing commands `pi auth print-api-key` and `pi auth print-bearer-token` (and `auth check --credentials`) are prohibited and gated by ADR-0013.
- **Unsupported facts**: Codex `login status` in API-key mode prints `Logged in using an API key - <first-8>***<last-5>`; this is credential-adjacent output that a readiness adapter must never parse or persist. Neither engine's status operation proves that the *configured or requested* model is available *to this account*. Those facts remain `unavailable` and block admission.

## 1. Pinned versions and primary sources

| Engine | Installed (research host) | Primary source pin |
|---|---|---|
| Codex CLI | `codex-cli 0.154.0` (standalone unix package, npm-free) | [`openai/codex`](https://github.com/openai/codex/releases/tag/rust-v0.154.0) tag `rust-v0.154.0` → resolved commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Pi | `0.86.1` (npm `@earendil-works/pi-coding-agent@0.86.1`) | [`earendil-works/pi`](https://github.com/earendil-works/pi/releases/tag/v0.86.1) tag `v0.86.1` → resolved commit `13cbf77df2396303013a41646bcfa77b4271ae56` |

The installed Pi dist (`dist/cli/auth-check.js`, `dist/core/model-runtime.js`, `dist/core/remote-catalog-provider.js`, `dist/migrations.js`) was diffed against the tagged sources above; the relevant semantics match. The Codex Rust sources at the resolved `rust-v0.154.0` commit were read directly for each claim cited below. The two research-host engine versions are also the versions Sprout's existing adapters execute against (`codex-cli 0.154.0` per `src/engine/codex.ts` headers; Pi `0.86.1` observed via `pi --version`).

Tag resolution (recorded so `rust-v0.154.0` is auditable and does not drift):

```sh
git ls-remote https://github.com/openai/codex refs/tags/rust-v0.154.0 refs/tags/rust-v0.154.0^{}
# 36eab01061df3cde5f95ec20a526777b430091ba  refs/tags/rust-v0.154.0          (annotated tag object)
# 6b9826e3aa83b1a5947db50f4332cb9c65f1b340  refs/tags/rust-v0.154.0^{}       (resolved commit)
git ls-remote https://github.com/earendil-works/pi refs/tags/v0.86.1
# 13cbf77df2396303013a41646bcfa77b4271ae56  refs/tags/v0.86.1
```

Durability note: both CLIs ship rapid-release, so every exit code, field name, and default below is `version-unstable` in the sense that it must be re-verified when either executable changes (see §6, clause C5). "Version-unstable" is a durability caveat on each classification, **not** a second classification: every required fact below has exactly one classification in §5.

## 2. Codex 0.154.0

### 2.1 Version probe

```sh
codex --version
# codex-cli 0.154.0
```

`codex doctor` also prints the version plus runtime and install facts, but it performs network reachability probes (a `HEAD` on a CDN route and a route probe using `default_headers()` — originator and user-agent only, no credential material, per `login/src/auth/default_headers`). Doctor is acceptable as a *diagnostic*, not as the minimal readiness probe.

**Exit semantics (corrected)**: `codex doctor` exits `1` if and only if the aggregate report status is `Fail` (`cli/src/doctor.rs` `run_doctor`: `if report.overall_status == CheckStatus::Fail { std::process::exit(1) }`); otherwise it exits `0`. A missing credential is a `Fail` check, so a fresh `CODEX_HOME` is one cause of exit `1`, while an authenticated run exits `0`. The earlier claim that the process "exits `0` even when auth is missing" was wrong and is removed. There is no exit code that distinguishes "auth missing" from any other failing check.

### 2.2 Authentication status: `codex login status`

```sh
codex login status
# Logged in using ChatGPT        (exit 0, stderr)
# Not logged in                  (exit 1, stderr)
```

Live probes (sanitized):

| Scenario | Output (stderr) | Exit |
|---|---|---|
| Authed, network blackholed | `Logged in using ChatGPT` | `0` |
| Fresh `CODEX_HOME`, no credentials | `Not logged in` | `1` |
| API-key-shaped credential store (synthetic, redacted) | `Logged in using an API key - <first-8>***<last-5>` | `0` |

Semantics, from `cli/src/login.rs` `run_login_status` at `6b9826e3`:

- Loads auth via `AuthConfig::load_auth`, which reads the credential store and never performs a token refresh. Proactive refresh exists only on `AuthManager::auth()` (`should_refresh_proactively` → `refresh_token()`), which `run_login_status` does not call. Confirmed by the network-blackholed probe succeeding.
- Output is **stderr text only; there is no `--json` flag** (`codex login status --json` → `error: unexpected argument '--json' found`, exit `2`).
- Mode-dependent messages: ChatGPT → `Logged in using ChatGPT`; API key → `Logged in using an API key - {safe_format_key(key)}`; access token / personal access token / Bedrock variants each have their own line.
- `safe_format_key(key)` (`cli/src/login.rs`) returns `***` for keys of length ≤ 13, otherwise `{first 8}***{last 5}`.
- **Prohibited surface**: the API-key mode sentence embeds a masked key fragment. A readiness adapter must not consume it; per ADR-0013 it must prefer the structured RPC in §2.3. This is now enforced structurally by C1 (below), not merely stated.

### 2.3 Structured auth status: app-server `account/read`

Transport: `codex app-server --listen stdio://` (JSON-RPC; the same supervised transport ADR-0001 pins for runs).

Request (after `initialize`):

```json
{"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}
```

Response schema (`GetAccountResponse` in the generated protocol schema; obtain the full schema with `codex app-server generate-json-schema --out <dir>`):

```json
{"account": {"type": "chatgpt", "planType": "<plan>", "email": null},
 "requiresOpenaiAuth": true}
```

Live probes (sanitized):

| Scenario | Result |
|---|---|
| Authed ChatGPT, network blackholed | `account.type = chatgpt`, `requiresOpenaiAuth: true` |
| Fresh `CODEX_HOME` | `account: null`, `requiresOpenaiAuth: true` |

Semantics, from `app-server/src/request_processors/account_processor.rs` `get_account_response` and `app-server-protocol/src/protocol/v2/account.rs` `GetAccountParams` at `6b9826e3`:

- `get_account_response` reads `let do_refresh = params.refresh_token;` (a plain `bool`, not an `Option`; there is no `unwrap_or(false)` in this function). The field `GetAccountParams.refresh_token: bool` carries `#[serde(default, skip_serializing_if = "std::ops::Not::not")]` in `codex-rs/app-server-protocol/src/protocol/v2/account.rs`, so an omitted wire `refreshToken` deserializes to `false`. `refresh_token_if_requested(do_refresh)` then performs the OAuth refresh only when the field is explicitly `true`. The readiness contract must send `params: {}` (or omit `refreshToken`), never `refreshToken: true`.
- For contrast only: the separately-named `get_auth_status_response` handler (the v1 `getAuthStatus` RPC) does call `params.refresh_token.unwrap_or(false)`, because `GetAuthStatusParams.refresh_token` is an `Option<bool>` in `codex-rs/app-server-protocol/src/protocol/v1.rs`. That handler is a different RPC and is not the `account/read` path used here; the earlier report text mistakenly carried its expression onto `get_account_response`.
- With refresh not requested, the handler reads in-process auth state (`provider.account_state()`); no model or billable endpoint is contacted. The blackholed probe returning a full account proves this.
- `account/read` returns `email` (and `planType`) for ChatGPT accounts. The Worker readiness contract must reduce the response to `{authenticated: bool, authMode: "chatgpt" | "api_key" | ...}` and must not persist `email` or `planType` (privacy rule in `AGENTS.md`).
- **Process side effects (not auth-state side effects)**: starting `codex app-server` under a fresh `CODEX_HOME` creates the server's state files (`logs_*.sqlite`, `memories_*.sqlite`, `queue_*.sqlite`, `installation_id`). The authentication store is untouched (verified in §4.1); C4 asserts auth-store immutability, and the server's own state files are out of the readiness fact set.
- Related non-inference reads on the same transport (available, not required for E4): `modelProvider/capabilities/read` → static provider capability flags (measured).

### 2.4 Model availability: no operation establishes account entitlement

Three catalog surfaces exist; none is a strictly local proof of account entitlement:

- RPC `model/list` (`ModelListParams {cursor, includeHidden, limit}` → `{data: Model[], nextCursor?}`), served by `app-server/src/models.rs` `supported_models` → `thread_manager.list_models(RefreshStrategy::OnlineIfUncached, ...)`; results are then filtered by `build_available_models` → `ModelPreset::filter_by_auth` using the auth manager's `current_auth_uses_codex_backend`.
- CLI `codex debug models` (default), same `RefreshStrategy::OnlineIfUncached`.
- CLI `codex debug models --bundled`, strictly local (bundled catalog only).

`RefreshStrategy::OnlineIfUncached` semantics (`models-manager/src/manager.rs` at `6b9826e3`): use cache if fresh (`MODEL_CACHE_FILE = "models_cache.json"`, `DEFAULT_MODEL_CACHE_TTL = 300s`), else perform an online catalog fetch (`model-provider/src/models_endpoint.rs` `MODELS_ENDPOINT = "/models"` against `model-provider-info/src/lib.rs` `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`). On transport error the manager logs and falls back to the last known remote models or the bundled catalog, so the command still succeeds offline — but a cache-miss *is* a network metadata request.

Live probes (sanitized; catalog shapes drift, so counts are observations, not contracts):

| Scenario | Result |
|---|---|
| `codex debug models --bundled`, fresh `CODEX_HOME`, blackholed | 11 entries, no network |
| `codex debug models` (default), fresh `CODEX_HOME`, blackholed | 11 entries (bundled fallback) |
| `codex debug models` (default), warm cache, network available | 11 entries (cached/remote shape) |
| `model/list` RPC, warm cache, authed | 5 entries |
| `model/list` RPC, fresh `CODEX_HOME`, blackholed | 6 entries |

Unambiguous classifications forced by these measurements:

- `localCatalogPresence` (the installed binary knows a model id): **provable for Codex** via `codex debug models --bundled`, which is strictly local and never reads or writes the auth store. It proves **binary capability only** and is explicitly *not* a model-availability fact.
- `accountEntitlement` (this account may use the target model now): **unavailable** for Codex. Catalog filtering is auth-mode-level (`uses_codex_backend`), not account-entitlement-level; the bundled catalog is stale (its slug set does not match the cached/remote catalog); and `model/list` cache-miss is a network call whose billing neutrality is unproven. Required by C3 to be recorded `unknown` and to block admission.
- `onlineCatalogMetadata`: **unavailable**. `model/list` / `codex debug models` must not be claimed non-billable from source alone: it is a metadata `GET` (no prompt, no tokens), but #114 requires that a network metadata request not be called non-billable without primary-source or measured evidence, and neither is in evidence. It must not gate admission.

### 2.5 Prohibited operations

- `codex login --with-api-key` / `--with-access-token` / `--device-auth`: state-changing login flows.
- `codex logout`: state-changing.
- `account/usage/read`, `account/rateLimits/read` with refresh, `account/login/start`, `ChatgptAuthTokensRefreshParams`: usage/billing or refresh surfaces (documented in #45's report).
- Any `codex exec` / `turn/start`: inference.
- Parsing or persisting the masked API-key fragment from `login status`.

## 3. Pi 0.86.1

### 3.1 Version probe

```sh
pi --version
# 0.86.1
```

`pi --version` returns before the startup migration block (see `main.ts`: the version branch precedes `runMigrations`), so it is safe even on an installation with legacy auth files (verified live).

### 3.2 Authentication status: `pi auth check --json --no-refresh`

```sh
pi auth check --json --no-refresh --provider openai-codex
# {"status":"ready","provider":"openai-codex","authType":"oauth"}   (stdout, exit 0)
```

Live probes (sanitized), all with the installed `0.86.1`:

| Scenario | Output | Exit |
|---|---|---|
| Valid unexpired OAuth, network blackholed | `{"status":"ready","provider":"openai-codex","authType":"oauth"}` | `0` |
| Same, plain text (no `--json`) | `ready` | `0` |
| Unknown provider | `{"status":"not_ready","provider":"does-not-exist","reason":"provider_not_found"}` | `1` |
| Unresolvable `--model` | `{"status":"invalid","provider":"nonexistent-model-xyz","reason":"invalid_state"}` | `2` |
| Legacy install (only `oauth.json`/`settings.json`, no `auth.json`) | `{"status":"not_ready","provider":"openai-codex","reason":"credentials_not_configured"}` | `1` |

Semantics, from `packages/coding-agent/src/cli/auth-check.ts`, `cli/auth-command.ts`, `core/auth-storage.ts`, and `main.ts` at `13cbf77d`:

- `main.ts` handles the auth command (`runAuthCommand`) **before** the startup migration block, so `auth check` never runs `runMigrations`. The legacy-install probe above confirms this: `oauth.json`/`settings.json` were left untouched and no `auth.json` was written.
- `--no-refresh` swaps in `ReadOnlyAuthStorage` (`core/auth-storage.ts` `class ReadOnlyAuthStorage`); `checkProviderAuth` is called with `{ refresh: false }`, so with a valid unexpired OAuth credential it inspects the stored credential only — no network call (proven by the blackholed probe and by `packages/ai/src/models.ts` `checkProviderAuth`).
- `createAuthCheckModelRuntime` creates the runtime with `allowModelNetwork: false` and `refreshOnCreate: false`.
- Exit contract (set in `main.ts` `runAuthCommand`): `ready` → `0`, `not_ready` → `1`, `invalid`/argument error → `2`.
- JSON schema: `{status: "ready" | "not_ready" | "invalid", provider: string, reason?: "provider_not_found" | "credentials_not_configured" | "credential_not_available" | "invalid_state", authType?: "api_key" | "oauth"}`.
- **Prohibited modes**: `pi auth check --credentials`, `pi auth print-api-key`, `pi auth print-bearer-token` print credential material (`print-bearer-token` even *refreshes* expired OAuth tokens by default, and `--min-expiry` forces refresh). ADR-0013 excludes all of them from readiness. `--no-refresh` must be present in every probe invocation.
- Default refresh behavior (no `--no-refresh`) also must not be used: it constructs a writable `AuthStorage` (`AuthStorage.create()`) and may perform an OAuth refresh — a network call with state side effects.

### 3.3 Model availability: `pi --list-models` is prohibited (authentication-state side effect)

`pi --list-models` was a candidate in the previous revision. It is **removed**: at the pinned version it is not read-only for authentication state.

**Primary source.** `packages/coding-agent/src/main.ts` at `13cbf77d` calls `runMigrations(cwd)` before creating the model runtime and before reaching the `parsed.listModels !== undefined` branch. `packages/coding-agent/src/migrations.ts` `runMigrations` → `migrateAuthToAuthJson`, which (lines cited at the pin):

- renames `oauth.json` to `oauth.json.migrated` (`renameSync(oauthPath, `${oauthPath}.migrated`)`),
- rewrites `settings.json` with `apiKeys` deleted (`delete settings.apiKeys`; `writeFileSync(settingsPath, ...)`),
- writes `auth.json` containing the migrated credentials (`writeFileSync(authPath, ..., { mode: 0o600 })`).

There is no flag that skips `runMigrations` at this pin; `--offline` / `PI_OFFLINE=1` only disables network refresh, not migrations.

**Live demonstration (sanitized, isolated throwaway agent dir).** With a synthetic legacy install (`oauth.json` + `settings.json.apiKeys`, credentials redacted) and no `auth.json`:

| Operation | `auth.json` | `oauth.json` | `settings.json` | Verdict |
|---|---|---|---|---|
| `pi auth check --json --no-refresh --provider openai-codex` | not created | unchanged | unchanged | auth store unchanged |
| `pi --list-models openai-codex` | **created** (with migrated credentials) | **renamed** to `oauth.json.migrated` | **rewritten**, `apiKeys` removed | auth store **changed** |

With a *clean* agent dir (no legacy files), `--list-models` still writes `models-store.json` (a catalog overlay), so it is not a no-write operation either. It creates `auth.json` only when legacy auth files exist, but that is exactly the case a readiness probe cannot rule out.

**Consequence.** `pi --list-models` is prohibited for readiness. Pi `localCatalogPresence` is therefore **unavailable**: no operation at `0.86.1` reads the local catalog without potentially migrating authentication state. E4 must block on the Pi target-model fact rather than run this command. (Redirecting `PI_CODING_AGENT_DIR` to a throwaway directory would run migrations away from the real store, but it also points the catalog lookup away from the real `models.json`/`models-store.json`, so it is not a faithful local-catalog probe and is not claimed here; it is recorded as new fog.)

**Interpretation limit.** Even if a safe listing existed, it would list locally *known* models; `pi auth check` only proves *a* credential exists for the provider. Neither proves the account can actually use a specific model (quota, plan gating, per-model enablement). That composition is `unavailable`.

## 4. Side-effect inventory (both engines)

| Operation | Process/file side effects | Network | Credential exposure | Refresh |
|---|---|---|---|---|
| `codex --version` | none | none | none | none |
| `codex login status` | none (read-only `auth.json` load) | none | API-key mode prints masked fragment | none |
| `codex app-server` + `account/read` `{}` | spawns server process; creates server state files under `CODEX_HOME`; no auth writes | none (refresh off) | none (`email`/`planType` in response — must be dropped) | only if `refreshToken: true` |
| `codex app-server` + `model/list` | may write `models_cache.json` under `CODEX_HOME` | `GET /models` on cache miss | none | none |
| `codex debug models --bundled` | none | none | none | none |
| `codex doctor` | none observed | HEAD + route reachability probes (no auth headers) | none | none |
| `pi --version` | none | none | none | none |
| `pi auth check --json --no-refresh` | none (`ReadOnlyAuthStorage`; no migrations) | none | none | none (blocked) |
| `pi auth check --json` (no flag) | **may persist rotated OAuth token** | refresh possible | none | yes |
| `pi auth check --credentials` / `print-*` | none/refresh | possible | **prints credential** | possible |
| `pi --list-models [pattern]` | **PROHIBITED**: runs startup migrations — may create `auth.json`, rename `oauth.json`, rewrite `settings.json`; writes `models-store.json` | none for the listing itself | none printed, but migrated credentials are persisted | none |

### 4.1 Live before/after authentication-store observations

Each retained candidate was run on the supported host while recording `mtime`, `size`, and `sha256` of the relevant authentication store immediately before and after. Only the equality result is recorded here; digests are not retained. "UNCHANGED" means all three matched.

| Candidate | Auth store observed | Before → after |
|---|---|---|
| `codex --version` | `$CODEX_HOME/auth.json` | UNCHANGED |
| `codex login status` | `$CODEX_HOME/auth.json` | UNCHANGED |
| `codex debug models --bundled` | `$CODEX_HOME/auth.json` | UNCHANGED |
| `codex app-server` + `account/read {}` | `$CODEX_HOME/auth.json` | UNCHANGED |
| `pi --version` | `$PI_CODING_AGENT_DIR/auth.json` | UNCHANGED |
| `pi auth check --json --no-refresh` | `$PI_CODING_AGENT_DIR/auth.json` | UNCHANGED |
| `pi --list-models` (clean store) | `$PI_CODING_AGENT_DIR/auth.json` | UNCHANGED (but `models-store.json` created) |
| `pi --list-models` (legacy store) | `$PI_CODING_AGENT_DIR/{auth,oauth,settings}.json` | **CHANGED** (see §3.3) |

Negative network control: `codex login status`, `pi auth check --json --no-refresh`, and `codex debug models --bundled` all returned their normal results with an outbound blackhole proxy and a fresh `CODEX_HOME` proving no refresh/network dependency. `codex app-server` was run with a fresh `CODEX_HOME` and `account/read {}` returned `account: null` while leaving the auth store absent/unchanged.

No candidate sent a prompt, started a model turn, emitted model usage, or printed credential material during these observations.

## 5. Fact classification

Every required fact has exactly one classification. `version-unstable` is a durability caveat (re-probe on version bump), not a second classification.

`provable` — a pinned-version operation establishes the fact non-inference, locally, without credential exposure or auth-state change:

- **Codex executable present and version** — `codex --version`.
- **Codex authentication state and mode, including logged-out** — app-server `account/read` with `params: {}` → `{account: null | {type, ...}, requiresOpenaiAuth}`.
- **Codex local catalog presence (binary knows a model id)** — `codex debug models --bundled` slug match. Establishes *binary capability only*.
- **Pi executable present and version** — `pi --version`.
- **Pi provider credential present and type, provider resolution** — `pi auth check --json --no-refresh` three-state contract.

`unavailable` — no non-inference source exists at the pinned versions; must remain `unknown` and block admission:

- **Codex account entitlement for a specific target model** — catalog filtering is auth-mode-level, not account-entitlement-level; the bundled catalog is stale; `model/list` cache-miss is an unproven-cost network call.
- **Codex online catalog metadata / billing neutrality of `model/list`** — unproven.
- **Pi local catalog presence** — the only local listing operation (`--list-models`) runs startup migrations that may change authentication state; it is prohibited (§3.3).
- **Pi account entitlement for a specific target model** — no local non-inference source.
- **Credential validity at the provider right now (both engines)** — requires a refresh or an authenticated endpoint call, both excluded; stale/expired-but-present credentials read as `ready`/`Logged in`. ADR-0013 accepts this: the fact stays `unknown` and blocks, and the first real run is the authoritative validator.

**Admission rule (unconditional, per ADR-0013)**: any required fact classified `unavailable` is recorded as `unknown` and admission MUST NOT proceed while it is unknown. In particular, a target model required by the Environment keeps the Environment Yellow, regardless of local catalog presence and regardless of authentication status.

## 6. E4 adapter contract (testable)

E4 (`#118`) implements `Worker` readiness probes satisfying all of the following. Each clause is falsifiable with the commands in this report.

**C1 — Codex auth probe (structured only).** The adapter MUST use app-server `account/read` with `params: {}` (never `refreshToken: true`) over the supervised stdio transport. `account != null` → authenticated, `authMode` from the `Account.type` variant; `account: null` → `not_ready`. The adapter MUST NOT invoke or consume `codex login status` output: that surface is `unavailable` for readiness because API-key mode emits a credential-adjacent sentence. If for any reason a `login status` capture exists in the implementation, it is a hard probe failure unless the entire stderr equals exactly one allowlisted literal (`Logged in using ChatGPT`, `Not logged in`, `Logged in using workload identity`); any line matching the API-key sentence (C4) fails the probe rather than being ignored.

**C2 — Pi auth probe.** `pi auth check --json --no-refresh --provider <p>`; parse stdout JSON; `status: "ready"` → authenticated with `authType`; `not_ready` → `not_ready` with `reason`; exit `2` or non-JSON → probe error (not `not_ready`), do not retry with refresh. The adapter's own argument builder MUST reject the strings `--credentials`, `print-api-key`, `print-bearer-token`.

**C3 — Model facts (both engines), two independent facts, unconditional admission rule.**
1. `localCatalogPresence` — Codex: `provable` via `debug models --bundled` slug match (binary capability only). Pi: `unavailable`; the adapter MUST NOT run `pi --list-models` (migration side effect, §3.3), and a test asserts `--list-models` is absent from the Pi argument builder.
2. `accountEntitlement` — `unavailable` for both engines. The adapter MUST record it as `unknown`.
3. Admission rule — if the Environment requires a target model, admission MUST NOT proceed while `accountEntitlement` is `unknown`; the Environment stays Yellow. Local catalog presence never substitutes for account entitlement and MUST never be promoted to a model-available fact.

**C4 — Side-effect guard tests.**
- With an outbound-network blackhole proxy, C1 and C2 still return their normal results (proves no refresh/network).
- Authentication-store immutability: for each auth probe, `auth.json`/`auth_dot_json` (and the Codex/Pi auth stores named in §4.1) have unchanged `mtime`, `size`, and content hash after the probe (proves no auth-state change). For Pi the guard also asserts that `oauth.json` was not renamed and `settings.json` was not rewritten, because that is the mutation `--list-models` causes.
- Credential-pattern assertion on probe stdout/stderr: no line may match the **actual Codex sentence** `^Logged in using an API key( - .*)?$`, and no token may match the masked-fragment form `[A-Za-z0-9_\-]{8}\*{3}[A-Za-z0-9_\-]{5}` or the short-key form `Logged in using an API key - \*\*\*`.

**C5 — Version pin check.** The adapter records `codex --version` / `pi --version` output with the readiness fact; E4's supported-version table must be updated (and C1–C4 re-run) whenever the recorded version changes.

**C6 — Privacy reduction.** Persisted readiness facts are limited to `{engine, version, authenticated, authMode, authType, modelIdPresent, probedAt, probeExitCode}`. `email`, `planType`, masked key fragments, raw provider ids beyond the engine's own provider slug, and any stderr beyond the accepted literals are discarded at the probe boundary.

If E4 cannot satisfy C1–C6 on a future engine version (for example Pi removes `--no-refresh`, Codex makes `account/read` refresh by default, or a migration-safe Pi catalog probe appears), that is **new fog**: stop before implementing and re-open research rather than weakening a guard.

## 7. New fog

- **Migration-safe Pi local-catalog probe.** No documented flag at `0.86.1` skips `runMigrations`. The only workaround considered — redirecting `PI_CODING_AGENT_DIR` to a throwaway directory — would move the catalog lookup away from the real `models.json`/`models-store.json`, so it is not a faithful probe. Whether Pi exposes a documented read-only catalog operation on a later version is unknown; until then Pi local catalog presence is `unavailable` and blocks.
- The one deliberate unknown (account-level model entitlement for both engines) is classified `unavailable` and handled by C3 rather than silently promoted. It blocks admission.
- No fog blocks E4's *implementation*: E4 can implement the authentication probes and the unconditional blocking rule now.

## 8. Primary sources

### Codex (`rust-v0.154.0` → commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`)

All links below are pinned to the resolved commit so they cannot drift.

- **[C1]** [`codex-rs/cli/src/login.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/cli/src/login.rs) — `run_login_status`, message literals, exit codes, `safe_format_key`, no-refresh load path
- **[C2]** [`codex-rs/login/src/auth/manager.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/login/src/auth/manager.rs) — `load_auth`, `AuthConfig::load_auth`, `should_refresh_proactively`, `refresh_token`
- **[C3]** [`codex-rs/app-server/src/request_processors/account_processor.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/request_processors/account_processor.rs) — `get_account_response` (`let do_refresh = params.refresh_token;`), `refresh_token_if_requested`; and [`codex-rs/app-server-protocol/src/protocol/v2/account.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/account.rs) — `GetAccountParams.refresh_token: bool` with `#[serde(default, skip_serializing_if = "std::ops::Not::not")]` (omitted wire field → `false`), `GetAccountResponse`
- **[C4]** [`codex-rs/app-server/src/models.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/models.rs) — `supported_models` with `RefreshStrategy::OnlineIfUncached`
- **[C5]** [`codex-rs/models-manager/src/manager.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/models-manager/src/manager.rs) — `RefreshStrategy`, `MODEL_CACHE_FILE`, `DEFAULT_MODEL_CACHE_TTL`, `build_available_models`
- **[C6]** [`codex-rs/model-provider/src/models_endpoint.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/model-provider/src/models_endpoint.rs) and [`codex-rs/model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/model-provider-info/src/lib.rs) — `MODELS_ENDPOINT = "/models"`, `CHATGPT_CODEX_BASE_URL`
- **[C7]** [`codex-rs/cli/src/doctor.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/cli/src/doctor.rs) and [`codex-rs/login/src/auth/default_client.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/login/src/auth/default_client.rs) — `run_doctor` exit semantics (`overall_status == Fail → exit 1`) and headerless reachability probes
- **[C8]** `codex app-server generate-json-schema --out <dir>` at `0.154.0` — `GetAccountParams` (non-optional `refreshToken: bool`, default absent), `GetAccountResponse`, `Account`, `ModelListParams`, `ModelListResponse`, `Model`

### Pi (`v0.86.1` → commit `13cbf77df2396303013a41646bcfa77b4271ae56`)

All paths audited at the resolved commit (HTTP 200 at the pin):

- **[P1]** [`packages/coding-agent/src/cli/auth-check.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/cli/auth-check.ts) — `checkProviderAuth`, `createAuthCheckModelRuntime` (`allowModelNetwork: false`, `refreshOnCreate: false`)
- **[P2]** [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/main.ts) — `--no-refresh` wiring, exit codes 0/1/2, auth command handled before `runMigrations`, `--list-models` branch after `runMigrations`
- **[P3]** [`packages/coding-agent/src/migrations.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/migrations.ts) — `runMigrations`, `migrateAuthToAuthJson` (`renameSync(oauthPath, ...)`, `delete settings.apiKeys`, `writeFileSync(authPath, ...)`)
- **[P4]** [`packages/coding-agent/src/core/model-runtime.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/model-runtime.ts) — `refreshFromNetwork` requires explicit `allowModelNetwork: true`; `FileModelsStore` vs `InMemoryCodingAgentModelsStore`
- **[P5]** [`packages/coding-agent/src/core/models-store.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/models-store.ts) — `FileModelsStore` (persists `models-store.json`), `InMemoryCodingAgentModelsStore`
- **[P6]** [`packages/coding-agent/src/core/remote-catalog-provider.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/remote-catalog-provider.ts) — pi.dev catalog overlay, refresh interval, persistence to `models-store.json`
- **[P7]** [`packages/ai/src/models.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/models.ts) — `checkProviderAuth` local-only OAuth check, `getAvailable`
- **[P8]** [`packages/ai/src/auth/resolve.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/auth/resolve.ts) — OAuth refresh-on-read window (why `--no-refresh` is mandatory), no-network `resolveApiKey`
- **[P9]** [`packages/ai/src/auth/oauth/openai-codex.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/auth/oauth/openai-codex.ts) — local credential derivation, `refresh` (network) — the prohibited path
- **[P10]** [`packages/coding-agent/src/core/auth-storage.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/auth-storage.ts) — `ReadOnlyAuthStorage` (`class ReadOnlyAuthStorage`) vs writable `AuthStorage.create()`
- **[P11]** [`packages/coding-agent/src/cli/list-models.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/cli/list-models.ts) — `listModels` (documented for completeness; **prohibited** as a readiness probe)

### Sprout baseline

- **[S1]** ADR-0013, `Readiness probes never perform model inference`. This decision file is **not present in the `2d58fb9e` tree** and is not yet on `origin/master`; it was introduced by the #113 decision commit and is auditable at:
  - commit `326a1e18170a140e406525ed0cf407f327797df6` (branch `m113-ticket-115-e1`), blob `cd64f56e76a8af600c9ff8442f4b9bbf6d2eb8a5`, path `docs/adr/0013-readiness-probes-never-perform-model-inference.md`
  - audit locally with `git show 326a1e18:docs/adr/0013-readiness-probes-never-perform-model-inference.md`
  - operative boundary, quoted verbatim: *"it may inspect executable/version state, use documented authentication-status operations, and read or fetch non-inference model metadata only when that operation cannot create model usage or cost. It never sends a prompt, starts a model turn, exports a credential, or uses a credential-printing mode. … A required engine or model that cannot be established through such a probe remains `unknown` and is ineligible for admission; it is never promoted to ready by assumption."*
- **[S2]** [ADR-0001: Codex runs through app-server](../adr/0001-codex-runs-through-app-server.md) — app-server transport is Sprout's Codex surface
- **[S3]** [`src/engine/codex.ts`](../../src/engine/codex.ts) — existing supervised app-server child process (transport reuse for `account/read`)
- **[S4]** [#45 research report](codex-pi-usage-cost-telemetry.md) — usage/cost surfaces deliberately excluded here; evidence-strength conventions reused
