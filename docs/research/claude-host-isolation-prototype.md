# Claude builtin exclusion and remote-origin prototype (#250)

Run `r225`, Job `r225-pro-worker-a1`, attempt 1; base `1d88fb0f`.
Disposable experiment only. No production adapter, engine replacement, installation,
login, permission interceptor, domain change or UI change.

## Verdict

**Partial evidence; combined production acceptance is blocked.**

Evidence tier: **`model-issued (Claude Code CLI pinned at 2.1.294, non-Claude backend via local gateway)`**.

A native-only diagnostic, with isolated configuration but **without the engine's
outer file profile**, performed real typed MCP reads, writes and checks at the
separate origin. The accepted initial catalog contained exactly
`mcp__origin__remote_read` and `mcp__origin__remote_write`, with no builtins.
Eight model-issued calls in the first turn and one after resume read the remote
marker, wrote and checked the remote effect, and denied host-sentinel and existing
engine-auth-file reads/writes plus a symlink escape. Host fixtures stayed unchanged.
This establishes useful native-control and origin evidence; it does not establish
criterion 4 or combined production safety.

With the engine's outer profile enabled, the CLI version probe and engine-local
auth helper succeeded, and the CLI invoked that helper, but the work launch
emitted no initial catalog or native initialization event before a 40-second
process-group kill. No isolated model-issued remote call occurred. Removing MCP
from an earlier otherwise isolated launch produced the same pre-init timeout.
The startup resource/operation causing that timeout has **not** been identified.
The configured gateway was reachable in a separate non-inference models-list
probe (HTTP status 200); that does not establish its behavior inside the native
CLI profile. Authentication was not missing and no installation/login is requested.

The unblock condition is a reviewed runtime/profile configuration that lets this
pinned native CLI initialize and complete the **same model-issued experiment
under outer isolation**, while preserving host, Project, history and auth-file
negative checks. Opening broad home-directory access or using the native-only
result as a fallback does not meet that condition. Dependent integration remains
blocked; this report does not accept or close the Ticket.

## Artifacts and reproduction

- `scripts/probe-claude-host-isolation.mjs`: disposable bounded supervisor,
  authentication helper, stdio MCP bridge and fact-only event collector.
- `scripts/prototype-origin-fixture.mjs`: reused unchanged from #239.
- `claude-host-isolation-prototype-evidence.json`: final combined-profile failure.
- `claude-native-remote-diagnostic.json`: final model-issued native-only diagnostic.
- `claude-native-empty-catalog-diagnostic.json`: earlier native-only empty-catalog
  control, including resume and interrupt observations.
- `claude-prototype-verification.json`: exact disjoint test target manifest,
  timeout split, counters, platform and executable fingerprint.

On the already configured engine host, assign `CLAUDE_PROBE_PORT` from the Job's
port block at runtime, then run `node scripts/probe-claude-host-isolation.mjs` with
an explicit 180-second command timeout. The default run applies the engine outer
profile. `CLAUDE_PROBE_NATIVE_ONLY=1` explicitly omits that profile for diagnostic
comparison; it always records the resulting acceptance gap.
`CLAUDE_PROBE_EMPTY_CATALOG=1` additionally removes explicit MCP attachment.
These switches are disposable experimental modes, never production fallbacks.
Each invocation replaces the default fact snapshot; preserve diagnostic snapshots
separately when reproducing. No service survives cleanup.

The existing CLI must report exactly `2.1.294 (Claude Code)`. macOS `26.6.2`, Node
`26.9.0`; CLI SHA-256:
`def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53`.
The executable is identified at runtime. No engine or speculative reference is
fetched. The Human's installation/configuration prerequisite is already satisfied.

## Seven acceptance criteria

| Criterion | Result and evidence |
|---|---|
| 1. Model-issued typed remote read/change/check; same-name host and host denials | **Evidenced in native-only diagnostic; combined run blocked.** `REMOTE_ORIGIN` came from the origin process, `REMOTE_MODEL_EFFECT` was written and read back, host origin/effect/sentinel remained unchanged. Absolute host/auth read/write requests and symlink read failed at origin path policy. This is a separate local sandbox fixture, not an enrolled remote deployment. |
| 2. Actual builtin exclusion and accepted initial catalog | **Evidenced in native-only diagnostic.** Native `system/init` catalog exactly two named MCP tools; all observed tool-use blocks have those names. Empty-MCP fresh session reports an empty catalog. `--tools ''` constructs the empty builtin set; redundant `--disallowedTools` excludes local/nested work paths. The probe does not independently attribute an effect to each redundant flag. `--allowedTools` grants approval only for the two MCP tools; it is not used as a whitelist. No permission callback or bypass mode is used. |
| 3. Automatic loading and nested paths | **Bounded native diagnostic evidence; exhaustive production admission remains open.** Scratch HOME/config/TMP roots, `--bare`, empty settings sources, explicit settings, strict MCP, disabled skills and Chrome, explicit system prompt. Planted personal-style hook/plugin config, Project skill/context and ambient MCP canaries did not add tools or create the hook marker in the successful diagnostic. No builtin work controls remain in its initial catalog. Managed settings and features built into the engine are residual sources to inventory; strict MCP alone does not control them. |
| 4. Native controls plus outer host isolation and usable engine-local auth | **Unmet: production blocker.** Scripted engine/origin/bridge OS negatives deny host, other-Project and Agent-history sentinel read/write. Engine direct origin read/write is denied. Actual auth settings are engine-readable but not writable; origin and bridge cannot read/write them. Auth helper works and is invoked by the CLI under the profile. The profile-protected CLI turn nevertheless times out before initialization; successful native-only turns omit this protection. |
| 5. Stdio/origin attachment, session transitions, events/usage/interrupt/resume | **Partial.** Scripted stdio MCP initialize/list/call works under bridge isolation. Native-only CLI reports origin connected, performs calls and resumes with the same native session identity; changed empty catalog uses a fresh native session. Neutral event/token/interrupt facts are below. Combined-profile attachment, remote cancellation/fencing and E7 attribution remain unproved. |
| 6. Evidenced production control contract and negative results | **Partial, fail-closed contract below.** Version/platform, exact native catalog and sanitized negatives are recorded. No passing combined-isolation production profile is available. This is a control-admission contract, not a compatible production implementation. |
| 7. Standing references pinned; no engine installation/login or replacement | **Met for consultation and scope.** Three standing reference slices were read at the inherited #239 pins below. No code copied, credential files synchronized, engines replaced or universal interception claimed. Failed combined controls keep integration blocked. |

## Controlled surfaces and negative evidence

Authentication uses only the existing engine-local settings file, read at runtime
by an explicit `apiKeyHelper`; credentials are emitted only to the native engine's
helper channel. No credential file is copied into scratch or the origin. The
supervisor obtains only the existing non-secret model/gateway routing settings
needed for the isolated launch; gateway location and model payloads are never
retained. The bridge/origin have no auth-file read allowance. Native-only means the
trusted engine lacks the outer host-file restriction; bridge/origin remain isolated.

`--bare` skips settings/plugin hooks, LSP/plugin synchronization, attribution,
auto-memory, background prefetch, keychain reads and automatic CLAUDE.md discovery
according to the **pinned installed help**. It still permits skills by name, so
`--disable-slash-commands` is necessary. The probe also uses
`--setting-sources ''`, explicit `--settings`, `--strict-mcp-config`, `--no-chrome`,
an explicit system prompt, scratch `CLAUDE_CONFIG_DIR`/HOME and engine-native
temporary-root configuration. No explicit plugin directory, agent definition,
IDE attachment, add-dir, cloud session, remote control or alternate model/account
is admitted. Environment variables are built explicitly rather than inherited.
Admin-managed policy remains a native source: future production admission must
inventory it and fail on unexpected work/configuration sources.

Refused model work paths: Bash/Read/Write/Edit/Glob/Grep, Agent/Task delegation,
Skill, ToolSearch, WebFetch/WebSearch and any tool absent from the exact catalog.
The origin exposes only schema-checked relative read/write operations. Absolute
paths, traversal and symlinks are refused; shell and nested operations return
`unsupported-operation`. A model's narrative refusal is not evidence; the catalog,
observed callbacks, denied results and final fixture state supply the evidence.

Retained harmless engine controls are authentication-helper execution, native
configuration/model selection, prompt transport, inference network access,
progress/result/usage events, engine-local temporary/session storage, same-binding
resume, fresh session construction and process-group interrupt/kill. They are not
model-visible work tools. The test engine profile also permits writes to the null
device; adding that narrow allowance did not resolve startup. No auto-approval or
callback is represented as universal interception.

The reused macOS `sandbox-exec` profile denies file-content reads and writes except
explicit runtime/system/script roots, scratch runner/control roots and the literal
native auth file (read only). Metadata remains allowed. Origin writes only its own
root and has no network; the bridge has no host/auth/workspace data allowance and
uses the disposable broker connection. Runtime allowance includes a broad read-only
Homebrew tree; a production minimum-runtime inventory and system-secret assessment
remain open. This is file-data sentinel isolation, not a full syscall sandbox or
metadata confidentiality. The unauthenticated local fixture broker is not an
enrollment or Worker authority boundary.

Earlier startup diagnosis found a denied open in the engine's default temporary
area. Explicit `CLAUDE_CODE_TMPDIR` removed that immediate error. This did not fix
the later pre-init timeout. Boot/version probes must use the admitted runner cwd;
a version diagnostic from an inadmissible cwd failed and was corrected. These
are probe findings, not evidence that the final blocker has been resolved.

## Engine Interface observations and safe transitions

The successful native-only stream emitted `system`, `assistant`, `user` and
`result` records. Assistant tool-use blocks correlate with nine observed broker
calls across the work turn and resume. Completed turns report `result/success`,
exit 0, and token fields `input_tokens`, `output_tokens`, `cache_read_input_tokens`
and `cache_creation_input_tokens`. Preserve their native meaning; cache dimensions
are separate and these are not attributable billed cost. No raw text, prompts,
model payloads, native session IDs or credential values are stored in these artifacts.

Resume passes the captured opaque native session ID back only for the same
catalog/origin. The final probe records `resumeMatchesRequested=true`. A changed
catalog/origin starts a new native session instead of resuming; the empty-catalog
turn records a different native identity and no MCP tools. This demonstrates the
fresh-session policy, not safe in-place catalog replacement or generation fencing.

A fresh empty-catalog turn receives process-group SIGINT after 1.5 seconds, exits 0,
and emits no completion result. Initialization was observed. Record it as a local
interrupt request followed by local process exit; do not infer a completed answer,
usage of zero, recoverable interrupted-session resume, or remote-operation stop.
The separate same-binding resume test follows a completed work turn, not this
interrupted one. Interrupted-session resume and Worker-observed cancellation remain
unexercised.

Real Claude model behavior is unexercised. The **E7 root-turn attribution race
(upstream Claude issue #55 in #226) cannot be confirmed or refuted on this backend**;
it remains an open evidence gap. Event counts and successful final results do not
resolve that attribution question.

## Production control-admission contract

1. Pin and verify the CLI fingerprint/version, supported platform, original
   engine-local auth and authorized model route. Sprout never installs or logs in.
   Freeze configuration, all discovery sources and the catalog before a turn.
2. Construct an empty builtin set plus exact typed MCP catalog, verify native
   initialization against that expected catalog, and fail before work on any
   unknown tool/server/control source. Approval grants are independent of tool
   availability; callbacks do not supply universal interception.
3. Admit only a reviewed outer profile that passes both direct OS negatives and
   a real model-issued read/change/check under that same profile. **The profile
   demonstrated here is not admissible: that combined check fails to initialize.**
   Neither successful auth nor native-only compatibility is a fallback pass.
4. Keep authentication with the engine; origin/work executors cannot receive its
   credential storage. Typed operations preserve selected origin and validate
   schema/path authority remotely. Production must add enrollment, Project
   authority, leases, binding generations and uncertain-outcome settlement;
   this fixture supplies none of those guarantees.
5. Resume only the same immutable catalog/origin binding after appropriate
   settlement. Change binding with a fresh native session. Do not reuse a native
   session across mode/host/origin/authority transitions merely because resume works.
6. Translate neutral progress/tool/result/usage facts at the existing Engine
   Interface; interrupted exit without result remains incomplete. Release remote
   work only on Worker-observed termination or an established fence. E7 remains
   unresolved on this backend, so no universal root-turn attribution claim is admitted.
7. Keep dependent Claude integration blocked until the combined profile works and
   each remaining production prerequisite is separately evidenced. Windows,
   enrolled cross-host execution, credential refresh, interrupted-session recovery,
   production cancellation/fencing and real-Claude-model behavior were not run.

## Standing integration references

Consulted through GitHub at these already standing revisions; no copied code:

- Cumora `622498370cf76965a18d3c5041b040f0e57237d0`,
  `server/src/agents/computer/engine.ts`: engine/session supervision and fail-closed
  host boundaries. Adopt the seam and failure discipline, not unsandboxed opt-in.
- AionUi `6744099b279b991c17e31c243f0920477bd31cb6`,
  `docs/prds/conversations/acp/permissions.md`: approval lifecycle. Approval UI and
  automatic grants do not establish availability or host read isolation.
- Paperclip `06484b3c4153b6201f1a07304694793b1fdf36dd`,
  `packages/adapters/claude-local/src/server/execute.remote.test.ts`: separate
  engine/target routing and mocked native event mapping. Do not adopt credential
  synchronization; mocked remote transport is not live enrolled-origin evidence.

Context7 executable was unavailable; no documentation package or speculative
reference was installed. Pinned installed CLI help supplied the native flag
surface, and behavior probes supply the claims above. The prototype skill's HTML
presentation is superseded by this Ticket's required executable CLI experiment.
No domain/ADR/UI projection changed: production remains at its existing Engine
Interface and Host-run Pi capability, with Claude admission blocked.

## Repository verification

`npm run typecheck`: exit 0. Initial checkout lacked installed Node type dependencies;
`npm ci --ignore-scripts --no-audit --no-fund` restored locked repository dependencies,
then typecheck passed. No manifest, production, test or runner code changed.

The four initial disjoint `npm test` partitions cover every default-suite file.
Sorted targets are assigned round-robin by index modulo four; the committed
verification JSON records all targets and asserts exact union/no duplication.
Every npm-test invocation had an explicit 180-second outer bound. Background
partitions used a 175-second internal suite deadline to retain timeout diagnostics.

| Partition | Files | Result |
|---|---:|---|
| 1 | 77 | 524 tests/pass; fail/cancelled/skipped/todo 0 |
| 2 | 77 | Timed out at 175 seconds, exit 124; no passing counters claimed |
| 3 | 77 | 609 tests/pass; fail/cancelled/skipped/todo 0 |
| 4 | 76 | 616 tests/pass; fail/cancelled/skipped/todo 0 |
| 2a, first half of partition 2 | 38 | 331 tests/pass; fail/cancelled/skipped/todo 0 |
| 2b, remaining half of partition 2 | 39 | 275 tests/pass; fail/cancelled/skipped/todo 0 |

Passing bounded runs cover **307 files / 2,355 tests**, zero failures. The timeout
was replaced by two successful disjoint halves, never counted as a pass. Its
reported candidate was `web/src/app/production-chat-reply.dom.test.ts:561`; this
is not a proven cause. Typecheck, probe syntax and whitespace checks passed.
No monolithic passing run is claimed. No prototype review gate was requested.
