# Non-inference Codex and Pi readiness probes

**Issue**: [#114](https://github.com/tinysnake/sprout/issues/114) (part of map #113)

**Research date**: 2026-09-21

**Scope**: Codex CLI `0.154.0` and Pi `0.86.1` — the versions installed on the supported macOS research host. Codex `0.154.0` is also the version already probed and adapter-pinned by [#45](https://github.com/tinysnake/sprout/issues/45) and `src/engine/codex.ts`; Pi has moved from `0.85.1` (#45's pin) to `0.86.1`, and every Pi claim below was re-verified against `0.86.1` sources.

**Boundary (ADR-0013)**: a readiness probe is Worker-executed and strictly non-inference. It may inspect executable/version state, use documented authentication-status operations, and read non-inference model metadata only when the operation cannot create model usage or cost. It never sends a prompt, never starts a model turn, never exports a credential, and never uses a credential-printing mode. A required fact that cannot be established this way stays `unknown` and blocks admission.

**Method**: every command below was executed live on the supported host, including negative controls (fresh `CODEX_HOME` with no credentials, and a blackhole proxy making all outbound HTTP fail) to prove that the probe results are produced without network model traffic. Every primary-source claim was additionally checked against the tagged first-party source for the pinned version. All live outputs were sanitized before recording: no account identity, host identity, absolute home paths, credentials, or raw diagnostics are retained in this report.

## Executive summary

A complete, truthful, non-inference readiness probe exists for both engines at the pinned versions, but the two probes have sharply different shapes:

- **Codex**: authentication status is fully answerable locally. `codex login status` reads `auth.json` without refreshing tokens or touching the network; the app-server RPC `account/read` (with `refreshToken` absent or `false`) is the structured equivalent and never sends model traffic. Model availability has no strictly local operation: both `model/list` and `codex debug models` use `RefreshStrategy::OnlineIfUncached`, which is a **backend catalog fetch on cache miss** (a metadata `GET /models` request, not inference, but still a network call that must be proven non-billable before it may be claimed). `codex debug models --bundled` is strictly local but ships a stale catalog (11 entries including retired models) that does not match the live catalog (7 entries), so bundled presence cannot establish target-model availability.
- **Pi**: everything needed is strictly local. `pi auth check --json --no-refresh` reads `auth.json` via a `ReadOnlyAuthStorage` and returns a machine-readable `{status, provider, authType}` object; the CLI model path never enables catalog network refresh (`allowModelNetwork: false` on the auth-check runtime, and the `--list-models` runtime is created without network either). `pi --list-models [pattern]` answers model availability from the local `models.json` plus any cached `models-store.json` overlay with no network access. The credential-printing commands `pi auth print-api-key` and `pi auth print-bearer-token` (and `auth check --credentials`) are **prohibited** for readiness use and are gated by ADR-0013.
- **Unsupported facts**: Codex `login status` in API-key mode prints a masked key fragment (`<first-8>***<last-5>`) — a credential-adjacent output that a readiness adapter must not parse or persist; Codex has no JSON output for login status at all. Neither engine's status operation proves that the *configured or requested* model is available *to this account*; Codex model catalogs are auth-mode-filtered and Pi `--list-models` shows every locally-known model regardless of what the authenticated account may use. Those gaps remain classification `unavailable`, not assumptions.

## 1. Pinned versions and primary sources

| Engine | Installed (research host) | Primary source pin |
|---|---|---|
| Codex CLI | `codex-cli 0.154.0` (standalone unix package, npm-free) | [`openai/codex` tag `rust-v0.154.0`](https://github.com/openai/codex/releases/tag/rust-v0.154.0) |
| Pi | `0.86.1` (npm `@earendil-works/pi-coding-agent@0.86.1`) | [`earendil-works/pi` tag `v0.86.1`](https://github.com/earendil-works/pi/releases/tag/v0.86.1), commit `13cbf77df2396303013a41646bcfa77b4271ae56` |

The installed Pi dist (`dist/cli/auth-check.js`, `dist/core/model-runtime.js`, `dist/core/remote-catalog-provider.js`) was diffed against the tagged sources above; the relevant semantics match. The Codex Rust sources at `rust-v0.154.0` were read directly for each claim cited below. The two research-host engine versions are also the versions Sprout's existing adapters execute against (`codex-cli 0.154.0` per `src/engine/codex.ts` headers; Pi `0.86.1` observed via `pi --version`).

Version-unstable warning: both CLIs ship rapid-release. Every exit code, field name, and default below must be re-verified when either executable changes (see §6).

## 2. Codex 0.154.0

### 2.1 Version probe

```sh
codex --version
# codex-cli 0.154.0
```

`codex doctor` also prints the version plus runtime and install facts, but it performs network reachability probes (HEAD on a CDN route, and a `GET /models` route probe using `default_headers()` — originator and user-agent only, no credential material, per `login/src/auth/default_client.rs` `default_headers`). Doctor is acceptable as a *diagnostic*, not as the minimal readiness probe, and its process exit code is `0` even when auth is missing (the failure is a check status, not the exit code — measured: fresh-home `codex doctor` exits `1` while the authed run exits `0`, but the auth finding itself is a `✗` line; only aggregate failure changes the code).

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

Semantics, from `cli/src/login.rs` `run_login_status` at `rust-v0.154.0`:

- Loads auth via `AuthConfig::load_auth` → the free `load_auth`, which reads the credential store and never performs a token refresh. Proactive refresh exists only on `AuthManager::auth()` (`should_refresh_proactively` → `refresh_token()`), which `run_login_status` does not call. Confirmed by the network-blackholed probe succeeding.
- Output is **stderr text only; there is no `--json` flag** (`codex login status --json` → `error: unexpected argument '--json'`, exit `2`).
- Mode-dependent messages: ChatGPT → `Logged in using ChatGPT`; API key → `Logged in using an API key - <first-8>***<last-5>` via `safe_format_key`; access token / personal access token / Bedrock variants each have their own line.
- **Unsupported-fact flag**: the API-key mode message embeds a masked key fragment. A readiness adapter must match only the exact literal lines (`Logged in using ChatGPT`, `Not logged in`, `Logged in using workload identity`) and must not parse or persist the API-key line; per ADR-0013 the adapter should prefer the structured RPC in §2.3 precisely to avoid this surface.

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

Semantics, from `app-server/src/request_processors/account_processor.rs` `get_account_response`:

- `params.refreshToken` is **absent-by-default `false`**; `refresh_token_if_requested(do_refresh)` performs the OAuth refresh only when explicitly `true`. The readiness contract must send `params: {}` (or omit `refreshToken`), never `refreshToken: true`.
- With refresh not requested, the handler reads in-process auth state (`provider.account_state()`); no model or billable endpoint is contacted. The blackholed probe returning a full account proves this.
- `account/read` returns `email` for ChatGPT accounts. The Worker readiness contract must reduce the response to `{authenticated: bool, authMode: "chatgpt" | "api_key" | ...}` and must not persist `email` or `planType` (privacy rule in `AGENTS.md`).
- Related non-inference reads on the same transport (available, not required for E4): `account/rateLimits/read` (account quota window — a *usage* fact, out of scope per #114's non-goals) and `modelProvider/capabilities/read` → `{"namespaceTools": true, "imageGeneration": true, "webSearch": true}` (measured; static provider capability flags).

### 2.4 Model availability: no strictly local operation

Two catalog surfaces exist and both have a network-on-miss path:

- RPC `model/list` (`ModelListParams {cursor, includeHidden, limit}` → `{data: Model[], nextCursor?}`), served by `app-server/src/models.rs` `supported_models` → `thread_manager.list_models(RefreshStrategy::OnlineIfUncached, ...)`.
- CLI `codex debug models` (and its `--bundled` variant), same `RefreshStrategy::OnlineIfUncached`.

`RefreshStrategy::OnlineIfUncached` semantics (`models-manager/src/manager.rs`): use cache if fresh (5-minute TTL, `models_cache.json` under `CODEX_HOME`), else `GET https://chatgpt.com/backend-api/codex/models` (endpoint path `/models`, `CHATGPT_CODEX_BASE_URL` in `model-provider-info/src/lib.rs`; client built by `model-provider/src/models_endpoint.rs`). On transport error the manager logs and falls back to the last known remote models or the bundled catalog (`load_remote_models_from_file`), so the command still succeeds offline — but a cache-miss *is* a network metadata request.

Live probes (sanitized):

| Scenario | Result |
|---|---|
| Default catalog, network blackholed, warm cache | 7 models (local cache hit) |
| Fresh `CODEX_HOME`, network blackholed | 6 models (bundled-fallback shape differs from warm-cache shape) |
| `codex debug models --bundled` (no network ever) | 11 models, including slugs absent from the live catalog (`gpt-5.2`, `gpt-5.4`, …) |
| Warm cache, network available | 7 models |

Classifications forced by these measurements:

- `model/list` / `codex debug models` **must not** be claimed non-billable from source alone: it is a metadata `GET` (no prompt, no tokens), but #114's acceptance requires "a network metadata request is not called non-billable without primary-source or measured evidence". The endpoint is an unauthenticated-cost metadata route (the doctor's own route probe treats `401`/`403` as *expected* responses, meaning the call is normally made without account-cost side effects), but a cost/usage-side-effect statement requires either an official OpenAI statement or a measured billing-neutrality observation — neither is in evidence here. Until then it classifies `version-unstable`/`unavailable` as a *readiness* fact and must not gate admission.
- `--bundled` is strictly local but stale by design; bundled presence proves only *binary capability*, not *account availability*. Classified `provable` for "the binary knows the model id", `unavailable` for "the model is available to this account".
- Auth-mode filtering is real: `build_available_models` filters presets by `uses_codex_backend`, and `account/read` cannot tell whether a *specific* model id is enabled for the account. Required fact "target model is available" therefore has **no local non-inference source at `0.154.0`** and stays `unknown` under ADR-0013 unless E4's contract accepts the weaker fact.

### 2.5 Prohibited operations

- `codex login --with-api-key` / `--with-access-token` / `--device-auth`: state-changing login flows.
- `codex logout`: state-changing.
- `account/usage/read`, `account/rateLimits/read` with refresh, `account/login/start`, `ChatgptAuthTokensRefreshParams`: usage/billing or refresh surfaces (documented in #45's report).
- Any `codex exec` / `turn/start`: inference.
- Parsing the masked API-key fragment from `login status`.

## 3. Pi 0.86.1

### 3.1 Version probe

```sh
pi --version
# 0.86.1
```

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
| `--credentials` added | JSON gains a `credentials` field containing the bearer/API credential | `0` |

Semantics, from `packages/coding-agent/src/cli/auth-check.ts` and `src/main.ts` at `v0.86.1`:

- `--no-refresh` swaps in `ReadOnlyAuthStorage`: the probe **cannot** write a refreshed token even if the resolution path requested one; `refresh: false` is passed to `checkProviderAuth`. With a valid unexpired OAuth credential, `checkProviderAuth` → `Models.checkProviderAuth` returns `{source: "OAuth", type: "oauth"}` by inspecting the stored credential only — no network call (proven by the blackholed probe and by `packages/ai/src/models.ts` `checkProviderAuth`).
- Exit contract (set in `src/main.ts`): `ready` → `0`, `not_ready` → `1`, `invalid`/argument error → `2`.
- JSON schema: `{status: "ready" | "not_ready" | "invalid", provider: string, reason?: "provider_not_found" | "credentials_not_configured" | "credential_not_available" | "invalid_state", authType?: "api_key" | "oauth"}`.
- **Prohibited modes**: `pi auth check --credentials`, `pi auth print-api-key`, `pi auth print-bearer-token` print credential material (`print-bearer-token` even *refreshes* expired OAuth tokens by default, and `--min-expiry` forces refresh). ADR-0013 excludes all of them from readiness. `--no-refresh` must be present in every probe invocation.
- Default refresh behavior (no `--no-refresh`) also must not be used: it constructs a writable `AuthStorage` and may perform an OAuth refresh — a network call with state side effects.

### 3.3 Model availability: `pi --list-models [pattern]`

```sh
pi --list-models openai-codex
# provider        model                context  max-out  thinking  images
# openai-codex    gpt-5.3-codex-spark  128K     128K     yes       no
# openai-codex    gpt-5.5              272K     128K     yes       yes
# ...
```

Live probes (sanitized):

| Scenario | Result |
|---|---|
| Full listing, network blackholed | identical table to the networked run (172 model rows observed) |
| `pi --list-models gpt-5` (fuzzy filter) | only matching rows |

Semantics, from `src/main.ts` and `src/core/model-runtime.ts` at `v0.86.1`:

- The `--list-models` runtime is created via `createAgentSessionServices` → `ModelRuntime.create(...)` **without** `allowModelNetwork: true`, so `refreshFromNetwork` is `false` (`ModelRuntime.create` requires the opt-in flag) and `runtime.refresh({allowNetwork: false})` never reaches the pi.dev catalog endpoint. Setting `PI_OFFLINE=1` or passing `--offline` achieves the same explicitly; the blackhole probe proves the default path is already network-free for this command.
- Sources of the listing, in merge order: built-in provider catalogs shipped with the binary (e.g. `openai-codex.models.js`), the user `models.json` (user-defined providers/models), and the persisted pi.dev catalog overlay in `models-store.json` (written by *earlier* networked refreshes, e.g. `pi update` — 4-hour revalidation window, `remote-catalog-provider.ts`).
- **Interpretation limit**: `--list-models` lists locally *known* models; `pi auth check` only proves *a* credential exists for the provider. Neither op proves the account can actually use a specific model (quota, plan gating, per-model enablement). That composition stays `unavailable`; E4 must decide whether "model id ∈ local catalog AND provider auth = ready" is a sufficient admission fact or whether the target-model fact stays `unknown` (Yellow, no admission) — the map's fog is resolved in the sense that **no stronger fact exists at `0.86.1`**.

## 4. Side-effect inventory (both engines)

| Operation | Process/file side effects | Network | Credential exposure | Refresh |
|---|---|---|---|---|
| `codex --version` | none | none | none | none |
| `codex login status` | none (read-only `auth.json` load) | none | API-key mode prints masked fragment | none |
| `codex app-server` + `account/read` `{}` | spawns server process; no auth writes | none (refresh off) | none (`email` present in response — must be dropped) | only if `refreshToken: true` |
| `codex app-server` + `model/list` | may write `models_cache.json` under `CODEX_HOME` | `GET /models` on cache miss | none | none |
| `codex debug models --bundled` | none | none | none | none |
| `codex doctor` | none observed | HEAD + route `GET /models` reachability probes (no auth headers) | none | none |
| `pi --version` | none | none | none | none |
| `pi auth check --json --no-refresh` | none (`ReadOnlyAuthStorage`) | none | none | none (blocked) |
| `pi auth check --json` (no flag) | **may persist rotated OAuth token** | refresh possible | none | yes |
| `pi auth check --credentials` / `print-*` | none/refresh | possible | **prints credential** | possible |
| `pi --list-models [pattern]` | none for listing itself | none (overlay comes from earlier `pi update`) | none | none |

## 5. Fact classification

`provable` — a pinned-version operation establishes the fact non-inference, locally, without credential exposure or auth-state change:

- Codex executable present and version (`--version`).
- Codex authentication state and mode, including logged-out (`login status` exit codes; `account/read` with empty params → `{account: null | {...type...}, requiresOpenaiAuth}`).
- Pi executable present and version (`--version`).
- Pi provider credential present, type, provider resolution (`auth check --json --no-refresh` three-state contract).
- Pi target-model id present in the local effective catalog (`--list-models` filtered, offline).

`version-unstable` — true today, but the surface is explicitly subject to change and must be re-probed on version bumps:

- Codex `login status` literal strings and exit codes (no JSON contract; strings are the interface).
- Codex `account/read` response field set (`email`/`planType` presence and types).
- Codex model catalog shape and the `OnlineIfUncached` TTL/path.
- Pi `auth check` JSON field names, reasons, and exit-code mapping (0/1/2).
- Pi `--list-models` table format (human table; no `--json` for model listing in `0.86.1`).

`unavailable` — no non-inference source exists at the pinned versions; must remain `unknown` for admission:

- Codex: whether the *account* can use a specific model id (catalog filtering is auth-mode-level, not account-entitlement-level; bundled catalog is stale; `model/list` cache-miss is an unproven-cost network call).
- Codex: any account quota/credit fact without `account/usage/read`-class billable-adjacent calls (excluded, #45).
- Pi: account-level per-model entitlement.
- Both: whether credentials are *valid at the provider right now* without a refresh or an authenticated non-inference endpoint call (stale/expired-but-present credentials read as `ready`/`Logged in`). ADR-0013 accepts this: unknown facts block, and the first real run is the authoritative validator.

## 6. E4 adapter contract (testable)

E4 (`#118`) implements `Worker` readiness probes satisfying all of the following. Each clause is falsifiable with the commands in this report.

**C1 — Codex auth probe.** `codex login status` exits `0` and stderr equals exactly one of the accepted literals (`Logged in using ChatGPT`, `Logged in using workload identity`), or the adapter uses `account/read` with `params: {}` over app-server stdio and maps `account != null` → authenticated, `authMode` from the `Account.type` variant. Exit `1`/`account: null` → `not_ready`. The API-key-mode `login status` line must not be consumed (structurally prefer `account/read`).

**C2 — Pi auth probe.** `pi auth check --json --no-refresh --provider <p>`; parse stdout JSON; `status: "ready"` → authenticated with `authType`; `not_ready` → `not_ready` with `reason`; exit `2` or non-JSON → probe error (not `not_ready`), do not retry with refresh. The strings `--credentials`, `print-api-key`, `print-bearer-token` must be rejected by the adapter's own argument builder.

**C3 — Model fact (both engines).** The adapter records `modelId ∈ localCatalog` (Pi: `--list-models <pattern>` row match; Codex: `debug models --bundled` slug match or `model/list` cache-warm result) as `provable`; it records `accountEntitlement` as `unknown` and admission treats `unknown` as blocking (Yellow), per ADR-0013.

**C4 — Side-effect guard tests.** With an outbound-network blackhole proxy: C1 and C2 still return their normal results (proves no refresh/network); `auth.json`/`auth_dot_json` mtime and content hash unchanged after the probe (proves no auth-state change); probe stdout/stderr asserted free of credential patterns (Codex masked-key regex `^[A-Za-z0-9_\-]{8}\*{3}[A-Za-z0-9_\-]{5}$` must never match).

**C5 — Version pin check.** The adapter records `codex --version` / `pi --version` output with the readiness fact; E4's supported-version table must be updated (and C1–C4 re-run) whenever the recorded version changes.

**C6 — Privacy reduction.** Persisted readiness facts are limited to `{engine, version, authenticated, authMode, authType, modelIdPresent, probedAt, probeExitCode}`. `email`, `planType`, masked key fragments, raw provider ids beyond the engine's own provider slug, and any stderr beyond the accepted literals are discarded at the probe boundary.

If E4 cannot satisfy C1–C6 on a future engine version (for example Pi removes `--no-refresh`, or Codex makes `login status` refresh), that is **new fog**: stop before implementing and re-open research rather than weakening a guard.

## 7. New fog

- None blocking E4's implementation. The one deliberate unknown (account-level model entitlement) is *classified* in §5 and handled by C3 rather than silently promoted; the map-level fog "which documented operations can prove authentication and model availability without inference/credential exposure/refresh/usage/cost" is resolved for the pinned versions by §2–§5.

## 8. Primary sources

### Codex (`rust-v0.154.0`)

- **[C1]** [`cli/src/login.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/cli/src/login.rs) — `run_login_status`: messages, exit codes, `safe_format_key`, no-refresh load path
- **[C2]** [`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/manager.rs) — `load_auth`, `AuthConfig::load_auth`, `should_refresh_proactively`, `get_token`
- **[C3]** [`app-server/src/request_processors/account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/account_processor.rs) — `get_account_response`, `refresh_token_if_requested`
- **[C4]** [`app-server/src/models.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/models.rs) — `supported_models` with `RefreshStrategy::OnlineIfUncached`, `model_from_preset`
- **[C5]** [`models-manager/src/manager.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/models-manager/src/manager.rs) — `RefreshStrategy`, cache TTL, bundled fallback, endpoint contract
- **[C6]** [`model-provider/src/models_endpoint.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/model-provider/src/models_endpoint.rs) and [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/model-provider-info/src/lib.rs) — `GET /models` endpoint, `CHATGPT_CODEX_BASE_URL`
- **[C7]** [`cli/src/doctor.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/cli/src/doctor.rs) and [`login/src/auth/default_client.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/default_client.rs) — doctor auth check (no refresh) and headerless reachability probes
- **[C8]** `codex app-server generate-json-schema --out <dir>` at `0.154.0` — `GetAccountParams`, `GetAccountResponse`, `Account`, `ModelListParams`, `ModelListResponse`, `Model`

### Pi (`v0.86.1`, commit `13cbf77df2396303013a41646bcfa77b4271ae56`)

- **[P1]** [`packages/coding-agent/src/cli/auth-check.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/cli/auth-check.ts) — `checkProviderAuth`, `createAuthCheckModelRuntime` (`allowModelNetwork: false`, `refreshOnCreate: false`)
- **[P2]** [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/main.ts) — `--no-refresh` → `ReadOnlyAuthStorage`, exit codes 0/1/2, `--list-models` runtime creation
- **[P3]** [`packages/coding-agent/src/core/model-runtime.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/model-runtime.ts) — `refreshFromNetwork` requires explicit `allowModelNetwork: true`
- **[P4]** [`packages/coding-agent/src/core/remote-catalog-provider.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/remote-catalog-provider.ts) — pi.dev catalog overlay, refresh interval, persistence to `models-store.json`
- **[P5]** [`packages/ai/src/models.ts`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/models.ts) — `checkProviderAuth` local-only OAuth check, `getAvailable`
- **[P6]** [`packages/ai/src/auth/resolve.js`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/auth/resolve.js) — OAuth refresh-on-read window (why `--no-refresh` is mandatory), no-network `resolveApiKey`
- **[P7]** [`packages/ai/src/auth/oauth/openai-codex.js`](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/auth/oauth/openai-codex.js) — `toAuth` (local derivation), `refresh` (network) — the prohibited path

### Sprout baseline

- **[S1]** [ADR-0013](../adr/0013-readiness-probes-never-perform-model-inference.md) — probe boundary, unknown-blocks-admission
- **[S2]** [ADR-0001](../adr/0001-codex-runs-through-app-server.md) — app-server transport is Sprout's Codex surface
- **[S3]** [`src/engine/codex.ts`](../../src/engine/codex.ts) — existing supervised app-server child process (transport reuse for `account/read`)
- **[S4]** [#45 research report](codex-pi-usage-cost-telemetry.md) — usage/cost surfaces deliberately excluded here; evidence-strength conventions reused
