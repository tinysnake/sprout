# OAR Pi loader and native-tool policy (#270)

## Disposition

**A controlled OAR Pi opener is delivered.** The shared `src/engine/oar-runtime-policy.ts` establishes approved-only tools using OAR 0.59.1's published `OAR_PI_AGENT_DIR` pin and Pi's global/project settings. The adapter acquires an exclusive settings lease before spawning; the runner verifies it before importing OAR and pins the controlled root. Missing, conflicting, malformed or modified policy fails closed. #232 must use this shared policy, with no parallel loader policy. Native production selection and `pi-host.ts` are unchanged.

This supersedes the first attempt's framework-wide negative conclusion under [the acceptance change](https://github.com/tinysnake/sprout/issues/270#issuecomment-6143986284). Its narrower conclusion about `SessionOptions` remains correct. Upstream parameter forwarding is an improvement, not a prerequisite for this control. This establishes #230 §5.2 acceptance 1 at the scripted substrate boundary; actual enrolled Worker and separate lifecycle/settlement acceptance remain independent.

## Delivered control

A fresh host-owned agent directory contains only suppression settings and optional host-supplied `OarAdapterOptions.piModels` provider configuration. No ambient auth, models, packages or extensions are copied. Global settings use `defaultTools: []`, `extensions: ['!**/*']` and `packages: []`. The same suppression overrides are applied in `<cwd>/.pi/settings.json`: project exclusion is essential; global exclusion alone does not exclude project discovery. `!` is a normal exclusion pattern; `-` exact-path force exclusion is deliberately not used. OAR still pre-trusts cwd; this control does not alter trust.

The original project settings file is moved into an exclusive lock directory before the temporary overlay is created. On session exit it is renamed back, preserving bytes and permissions. Missing `.pi` directories are removed if still empty. Invalid settings, symlinks and overlapping sessions for the same canonical cwd are refused. The parent owns restoration on normal disposal, spawn error, startup failure and runner termination, including SIGKILL. Parent process death or an OS crash cannot execute cleanup: a remaining lock causes future acquisition to refuse rather than reuse uncontrolled state; recovering such a stale lock requires restoring its saved settings. This is a filesystem lease, not an OS sandbox against concurrent hostile writes.

Only the existing authenticated `createOarMcpBridge` handle is attached by the adapter; its operations delegate to the supplied Worker-origin contracts and preserve their binding fences. Runner verification rejects extra, substituted and stdio MCP entries. OAR's injected MCP extension uses an empty config loader (source-only: `dist/runtimes/pi/mcp.js`); ambient `mcp.json` is not merged, and ambient extensions cannot register servers. The policy does not implement a parser or another transport. Pi `SessionOptions.env` is omitted/rejected because OAR turns it into a custom native Bash tool; runner process environment still carries ordinary provider configuration. No deployment environment variable decides admission: the runner **writes** OAR's supported pin only after policy validation.

Temporary agent roots and native session records are removed when the runner exits. Cross-session Pi resume from a removed root therefore fails closed; this change does not claim durable Pi resume. A persistent, host-owned session store/config broker is follow-up integration work. Models requiring ambient provider extensions must be configured through a reviewed host channel or remain unavailable; no ambient-provider fallback is permitted.

## Executed control evidence

Reproduce with `node scripts/probe-oar-pi-controlled.mjs` (120-second command bound; probe has a 110-second deadline). Reduced facts are in `270-oar-pi-controlled-evidence.json`. This is **scripted** execution against the real installed OAR/Pi and the shared adapter's real child runner. A synthetic provider forces calls, including tools it was not advertised. Every turn waits for completion and at least two actual provider requests, including the tool result, before disposal; prompt acceptance is never counted as a request.

| Run | Provider-observed tools | Resource effect / result |
| --- | --- | --- |
| Unrestricted extension positive control | `bash, edit, read, unapproved_tool, write` | Ambient project extension loads and its tool creates a receipt |
| Unrestricted Bash positive control | Same | Forced Bash creates its target file |
| Controlled Bash attempt | `[]` | Forced Bash returns error; target absent |
| Controlled extension attempt with origin bridge | `mcp__sprout_workspace__remote_read` only | Forced extension tool returns error; neither extension load nor tool receipt exists |
| Controlled approved origin call | Same sole MCP tool | Existing bridge invokes the scripted Project MCP contract and creates its receipt |
| Explicit host-stdio entry supplied to real runner | Start error before opening OAR | No child-process receipt; ambient project MCP config also produces no effect |

The final controlled runner is killed with SIGKILL after its turn: original project settings are restored exactly and the lock is absent. Normal disposal is also observed for both denied runs. The original `node scripts/probe-oar-pi-policy.mjs` positive control separately proves explicitly configured upstream stdio starts a local process and writes a receipt. Thus stdio absence is compared with a functioning process-effect fixture.

The origin call is a `RemoteProjectMcpTools` contract fixture, **not an enrolled Worker**. No model-issued inference, remote host placement or OS isolation is inferred. Advertised inventory and forced execution denial are distinct observations. Source-only supporting facts about settings/SDK registry filtering do not become executed registry enumeration; the native tools are absent from the active model surface and forced execution is refused.

## Retained SessionOptions boundary evidence

`node scripts/probe-oar-pi-policy.mjs` reproduces the first attempt's **scripted** parameter-surface measurements using temporary roots and synthetic credentials. It intentionally opens OAR directly to characterize that narrower boundary. The table below is retained as the first attempt's boundary verdict, **before the delivered two-layer policy**, and must not be read as a verdict on all framework configuration surfaces.

| Boundary | Can the current route enforce it? | Evidence class and observation | Required host mechanism / limitation |
| --- | --- | --- | --- |
| Named native `bash` exclusion | Yes, for the measured pinned session | scripted: forced call, error result, absent resource; unrestricted control creates it | Version-bound deny policy; do not infer denial of every other capability |
| Global agent/config root replacement | Yes, for the synthetic ambient extension | scripted: ambient receipt exists in control and is absent with controlled root | Host-owned immutable root; credential/provider configuration needs an approved broker or configuration channel |
| Ambient project extension exclusion | No through the published options used here | scripted: project receipt still created with controlled agent root and denied native tools | Upstream loader options that disable discovery at all roots; OS read/execute confinement for hostile extensions |
| Strict approved tool admission | No supported `tools`/`noTools` surface | scripted: unlisted extension call creates resource; wildcard denies all; loader CLI override refused. source-only: SessionOptions and opener mapping | Expose strict SDK tool admission, including refresh/resume/nested calls and approved MCP tools; finite deny lists default new names to available |
| Project MCP restricted to Worker origin | No active Pi route is admitted; upstream origin enforcement is unproved | scripted: explicit upstream stdio server starts local process; adapter tests and real runner reject Pi before opening | Disable ambient server registration and host stdio; permit only Sprout's existing authenticated origin bridge, with binding/lease fences and no local fallback |
| Host files, credentials, rules, skills, packages and provider commands | Unproved; tool denial is not an OS boundary | source-only: OAR pre-trusts cwd and loads resources; no attempted denied-open evidence for these roots | Host filesystem/process/network isolation, controlled loader roots and credential broker; prove each denied attempt separately |
| Sprout refusal | Yes | scripted: fresh/resumed requests fail before bridge access/spawn; real runner returns start error and creates no config/trust root | This refusal is the sole current shared mechanism; remove only after replacement acceptance |

The last two route/refusal rows describe the first attempt only. The current refusal is a fallback when controlled settings cannot be established; the active controlled route is measured above. No deny list is equated to an allowlist.

## Upstream improvement proposal

No package was patched, upgraded or modified, and no upstream issue was filed. We now implement control through OAR's published root pin and Pi settings. First-class forwarding would avoid a temporary working-directory overlay and improve lifecycle integration:

1. Forward SDK `tools` and `noTools` through a typed Pi policy, constraining fresh, resumed, refreshed and nested execution. OAR currently forwards only `disallowedTools` into `excludeTools`.
2. Forward `noExtensions`, `disabledBuiltinExtensions` and/or approved factories before services load, with an explicit global/project config policy. The SDK already has these controls; OAR does not forward them. Inline OAR MCP factories must survive loader lockdown.
3. Provide a first-class approved-only MCP transport policy rejecting host stdio and ambient registrations, while retaining the existing Worker-origin bridge.
4. Repeat real enrolled Worker acceptance and separate OAR lifecycle/settlement verification. Native Pi remains the production default until its own route acceptance/integration is complete.

## Acceptance disposition

| Ticket #270 AC | Disposition | Evidence |
| --- | --- | --- |
| 1. Delivered executed approved-only control (amended) | met at scripted substrate boundary | Shared lease plus actual provider inventory, unrestricted positive control and forced denied calls |
| 2. Native tools absent and ambient extensions excluded | met at scripted substrate boundary | Zero native tools advertised; forced Bash refused; extension load/tool receipts absent |
| 3. Actually attempted denial and unrestricted positive control | met | Both Bash and extension positive effects versus forced denied attempts and absent effects |
| 4. Worker-origin Project MCP only; no host stdio | met at contract boundary | Sole attached bridge tool executes; explicit stdio start rejected by real runner; no receipt. Enrolled Worker acceptance is separate |
| 5. Reconcile #230 | met | §5.2 addendum records the framework-internal control and remaining independent acceptance |
| 6. State upstream ownership; no second transport/parser | met | Improvement proposal above; existing bridge reused; no vendor modifications |
| 7. Bounded standard checks; no deny/allow equivalence | reported separately | Work record records exact results, baseline errors and any incomplete suite runs |

Risk-to-test mapping: malformed settings and fresh/resumed start refusal; original settings bytes/permissions, concurrency and symlink protection; tampering/spawn-failure cleanup; direct runner start without a lease. These are distinct filesystem/entry contracts. The hand-scheduled real-runner probe protects actual settings semantics, forced calls, transport rejection and abrupt-exit restoration. Existing shared OAR tests retain activation/span attribution. No red-to-green claim is made for this changed acceptance; the focused suite and executed probe validate the delivered behavior.
