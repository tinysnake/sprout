# Codex remote-work controls through OAR (#228)

Scope: Run `r226`, first attempt, fixed Sprout base `6fe675fe77f46403eabf623c5e6300d3ab4e0a3c`, branch `r226-ticket-228`. This is bounded feasibility evidence for #230. It changes no production execution, public Engine Interface, Runtime admission, Worker operations, lease policy, or manifests.

## Verdict

**Unmodified OAR 0.35.0 does not expose the typed executor-binding or restricted custom-tool controls needed to admit this Codex remote-work scenario.** Native executor binding was evaluated first, followed by the restricted external-tool alternative. Both stop at a named upstream control prerequisite. This refutes availability through the inspected supported OAR surface; it does not refute Codex's native executor capability or prove that every possible native configuration workaround fails.

No OAR Codex session, model turn, or executor was started. There are **zero model-issued tool calls and no new protocol-only runtime observations**. The prototype refuses admission before opening a session rather than substituting local execution or treating MCP attachment as tool exclusion. Model-issued command, patch/read/edit, host denial, failure, binding change and resume remain **unproved**. Missing controls are the established prerequisite; authentication was not inspected and is not claimed missing.

The runnable [probe](../../scripts/probe-oar-codex-origin.mjs) executes the actual pinned OAR Codex request builder and the unchanged shared origin fixture. Its [allowlisted JSON](oar-codex-origin-evidence.json) separates these scripted observations from unavailable live evidence. This is not an end-to-end OAR execution pass or #225 production acceptance.

## Versions and inputs

| Component | Pin / observation | Scope |
|---|---|---|
| OAR | `@botiverse/oar` **0.35.0**, spec source `8adde16fe2d12ae54af7d4dff86c3f224380a5c7` | Existing exact npm archive; no install or upgrade |
| OAR archive SHA-256 | `a6c7329f743cdf0ffea6e619aa3b708e2b9180087fc3ad3dbaba9b509fc58cc8` | Enforced by probe; four imported/inspected modules compared byte-for-byte with archive members |
| Codex | `codex-cli` **0.159.3** | Existing executable, bounded `--version` |
| Native executor | **0.159.3**, same Codex executable | `exec-server --help` available; service not started, transport/auth behavior not exercised |
| Node / platform | **26.11.1 / macOS** | Live inventory; Node meets OAR's >=24 floor |
| Shared fixture SHA-256 | `9d050f9f0943a0b3f4244f25ca0fe1cdacd4f49a5ff8be9b2c2d72de9814ab23` | Enforced; `scripts/prototype-origin-fixture.mjs` unchanged |
| Selected native model / effort / auth | **Not selected or inspected** | No inference admission; the Pi harness's provider identity is not substituted into native Codex |

OAR's Codex MCP comments cite upstream testing on **0.160.1**; the installed executable is **0.159.3**. That is an evidence-version mismatch, not permission to upgrade or inherit the upstream test result. No floating version was used. Context7 lookup returned `fetch failed`; interface findings below use the exact archive and existing pinned research instead of current documentation assumptions.

The full #228 body and its sole Dispatch comment were read through the existing deterministic Forge helper. The accepted #227 report, result matrix, reusable scenario contract, final JSON and earlier incomplete-turn JSON were read from integration commit `465bd94b31cf7ec0bed83ae6946376e39c0a6d1d`. They are reusable inputs, not changes imported into this branch. In particular, the earlier incomplete Pi turn is not terminal-completion evidence. The present probe uses the shared fixture directly, with no Codex-specific fixture clone.

## Source findings and route order

### 1. Native executor binding

The pinned `SessionOptions` contains exactly `cwd`, `model`, `effort`, `resume`, `env`, `systemPrompt`, `appendSystemPrompt` and `mcpServers`. It has no executor registration/selection, environment list, dynamic-tool registration, tool-policy or controlled-resource-loader member.

The actual `codexThreadOpen` builder produces `thread/start` and `thread/resume` parameters with cwd, model/instructions, `approvalPolicy: never`, effort where applicable and MCP configuration. The probe calls both builders and observes that neither supplies `environments`. The session's prompt path likewise sends `turn/start` with thread ID, input and correlation ID, without environment selection. No `environment/add` registration or typed binding hook appears in this runtime. The app-server client's private request method is native transport owned by OAR, not a supported executor-binding Interface for Sprout.

The existing 0.159.3 local app-server/executor attachment research remains **prior protocol-only evidence** for Codex itself. It cannot prove that an OAR-controlled model command, patch, image or nested agent uses that executor. Registering an executor through a second connection, substituting a protocol-rewriting executable wrapper, or reaching into OAR's private client would create another protocol owner and is excluded here.

**Bounded native remedy:** an upstream OAR typed executor-binding option/hook, implemented within OAR's existing Codex transport. It must register one application-authorized executor before thread opening, select it on new/resumed sessions and every applicable turn/child path, read back the selection, and refuse an unavailable binding without local fallback. Endpoint and lease authority stay outside model arguments. A fresh native session is the declared alternative for a changed binding; old authority must be fenced before the new session admits work. This remedy is not implemented by this ticket.

### 2. Restricted external tools, evaluated after the native gap

`mcpServers` is a real typed attachment mechanism. Calling the actual builder confirms its configuration is supplied on both open and resume. It is **additive** to native/user configuration, not an exact tool catalog. OAR's implementation explicitly preserves other fields from same-name user MCP declarations. Stdio attachments run through Codex on the engine host; this is not ADR-0019's Worker-origin Project MCP execution.

A controlled native `CODEX_HOME` and explicit feature settings may reduce ambient configuration, while `OAR_CODEX_SANDBOX` can choose a native sandbox posture. Neither alone supplies the missing explicit empty native Environment selection, complete work-tool restriction or typed external-tool dispatch. Disabling shell does not exclude patch, image, nested or automatic read paths. Read-only writes and cwd do not establish host read isolation.

The OAR Codex session records server-initiated dynamic-tool requests as `toApp` requests but **never answers them**. Its sealed public Session has no typed custom-tool result callback. Using `rawEvents` to observe such a request is not an execution bridge. A native dynamic-tool implementation already present in Sprout is not evidence that OAR can dispatch it.

**Bounded fallback remedy:** one upstream OAR policy/typed-tool hook which supplies explicit detached native execution, an exact approved tool catalog, and typed callback/result handling through OAR's existing parser, on open and resume. It must retain Worker-origin execution and be validated with an outer engine isolation profile. Merely attaching a host-local MCP command does not supply this remedy. Retaining a bounded native Codex exception is an alternative adoption decision for #230, with removal gated on this same scenario passing through OAR; no second parser is added inside an OAR Adapter.

### Cross-cutting findings

OAR defaults to `danger-full-access`, selected from **the runner's process environment** `OAR_CODEX_SANDBOX`; a per-session `options.env` entry is not the setting read by this code. Future integration must fix the existing host posture before opening each isolated runner, never race mutations of a shared process environment. `inherit` delegates to native configuration and is not itself a restriction. The production Sprout host default remains `read-only` and is unchanged here.

OAR starts its Codex app-server with the caller's process cwd, while the thread gets `options.cwd`. Thus setting thread cwd alone is not proof that startup configuration/resource discovery occurs only in a controlled scratch directory. No hostile ambient-resource test was performed.

Image input is mapped to native `localImage` paths, which Codex reads itself. This does not demonstrate remote image routing. Nested-session attribution likewise does not demonstrate nested execution confinement. Client methods such as host filesystem RPC and shell execution are not exposed by this prototype; they must never become an arbitrary model-callable RPC tool. An observed raw record is not authorization to invoke its method.

## Result matrix

Common #227 shape and evidence classes: **model-issued** means observed real-model tool requests and effects; **protocol-only** means actual native/OAR wire, catalog or lifecycle observations; **scripted** means deterministic builder/fixture/version calls; **source-only** means implementation inspection. No weaker class inherits a stronger one. All new positive behavior below is scripted, not model-issued or protocol-only.

| Required control / scenario | Result and evidence class | Limit / one bounded remedy where needed |
|---|---|---|
| Exact versions / unchanged shared fixture | **Compatible, scripted:** OAR archive/modules and fixture hashes enforced; Codex 0.159.3 observed | Executor version is same-binary inventory only |
| Native executor binding through OAR | **Unavailable/refuted for inspected public route, source-only + scripted builder:** no binding hook or selected Environment in open/resume; turn omission inspected | Remedy: upstream typed executor binding in OAR's existing transport, with selection readback |
| Restricted external work-tool route | **Unproved, source-only:** MCP attachments exist; exact native-tool exclusion and typed dynamic-tool answers do not | Remedy: upstream detached-execution/catalog/callback policy hook |
| Same relative `origin.txt` on host/work | **Compatible fixture prerequisite, scripted:** separate origin returns `REMOTE_ORIGIN`; host remains `HOST_ORIGIN` | Codex origin unproved. Remedy: one model-issued read after the binding hook is available |
| Same relative `effect.txt`, work edit | **Compatible fixture prerequisite, scripted:** work-only write, host effect unchanged | Codex patch/edit unproved. Remedy: one model-issued native patch/edit with observed work-only effect |
| Shell / command origin | **Unavailable:** unchanged fixture rejects `command`; no Codex executor admitted | Remedy: one bounded allowlisted executor command against the shared work origin after native binding exists; do not clone the fixture |
| Explicit forbidden host sentinel requests | **Compatible fixture prerequisite, scripted:** read and write path requests denied; sentinel unchanged | No model-issued denial. Remedy: repeat both explicit requests in the admitted OAR Codex turn |
| Outer host read/write isolation | **Unproved for Codex:** fixture origin OS read/write opens denied, **scripted**, bypassing path validation | No engine was sandboxed. Remedy: one direct engine OS read/write negative plus the model negatives under the selected engine profile |
| Engine auth ownership / host-local credentials | **Unproved:** no auth inspected or passed to any child; origin has no credential allowance | Remedy: verify authorized engine-only auth access and denied work-tool read/write before inference admission |
| Arbitrary model endpoints / lease claims | **Excluded by prototype admission declaration:** no selector tool or endpoint accepted | No runtime enforcement exercised. Remedy: one invalid-selector/lease-claim call against the typed binding hook |
| Direct executor without remote model-account login | **Unproved:** same executable advertises standalone service, **scripted inventory** only | Remedy: start one credential-free direct executor and complete the model-origin scenario with auth retained only on the engine host |
| Enabled search | **Unavailable:** no search operation admitted | Remedy: one origin-sensitive search through the selected executor after binding exists |
| Image work | **Unproved, source-only:** OAR image input uses native local paths | Remedy: distinct synthetic work/host images with one permitted image read and one denied host image request |
| Nested/codemode/extension work paths | **Unproved:** no nested agent/tool invoked; no child-origin confinement evidence | Remedy: one bounded nested invocation with forbidden host access under the selected policy |
| Automatic instructions/skills/config loading | **Unproved, source-only:** native discovery retained; app-server spawn cwd differs from thread cwd | Remedy: one planted hostile ambient resource under an explicit controlled-startup policy |
| Client-operation exposure | **Compatible surface restriction, source-only:** no raw RPC capability added; public OAR Session is sealed | Model attack unproved. Remedy: one forbidden client-method attempt after typed tools are admitted |
| Typed MCP registration | **Compatible builder surface, scripted:** attachment config constructed on open and resume | No live catalog/tool call. Remedy: one real typed registration/call through the policy hook on 0.159.3 |
| Remote Project MCP origin | **Unavailable for host-stdio attachment route, source-only:** Codex launches on engine host | Remedy: typed tools discovered/executed by the approved Worker, registered through the upstream callback hook |
| MCP withdrawal | **Unproved:** no attachment process started; public in-place replacement absent | Remedy: close/fence old session and prove fresh-session catalog omits old tools |
| Safe binding change / stale calls | **Unproved; fresh-session alternative declared**, not exercised | Remedy: revoke old generation, open fresh with new authority, then observe a denied old callback |
| Session continuation | **Unproved:** resume builder omits executor selection; MCP config must be supplied again | Remedy: one same-native-ID resumed model turn with binding/catalog readback after upstream controls exist |
| Remote failure without local fallback | **Unproved for Codex:** stopped fixture call fails on its 10-second timeout, host unchanged, **scripted** | No Codex session exists to fall back. Remedy: one model-issued failing operation after executor disconnection with host effects and origin observed |
| Remote cancellation/fencing | **Unproved:** local fixture stop is not a model-command/remote-descendant stop proof | Remedy: one long executor operation with observed origin settlement or fencing before lease release |
| Windows / enrolled cross-host Environment | **Unavailable:** local macOS sandbox fixture only | Remedy: repeat the unchanged identity/effect/denial contract on the authorized target platform and enrolled Worker |

## Reproduction, bounds and privacy

Use the existing 0.35.0 archive and its unpacked package, the existing Codex 0.159.3 executable, Node 24+, macOS `sandbox-exec`, and an explicit outer **60-second** timeout:

```sh
OAR_PROBE_ROOT=<unpacked-oar-package> \
OAR_PROBE_ARCHIVE=<oar-0.35.0-archive> \
node scripts/probe-oar-codex-origin.mjs
```

`CODEX_PROBE_BINARY` may name that same pinned executable. Missing versions, archive/module drift or unsupported platform fail the probe without installing, logging in or selecting another model. The harness has a 45-second overall deadline, 10-second subprocess and fixture-RPC limits, and the unchanged origin's own 150-second limit. Successful cleanup stops the origin before deleting scratch data. It opens no service listener and emits no native stdout/stderr, model text, auth, endpoint, process ID, or host path. The origin profile's Homebrew runtime read allowance is inherited from #227 and is broad; it proves only the declared fixture file-content negatives, not production sandbox completeness or metadata secrecy.

The expected report is **refused-before-session** with zero model calls, not compatibility success. The executed OAR code is its real unmodified internal request builder; the deep import is a disposable source-contract probe, not a proposed production API or a substituted session implementation. An assertion failure exits nonzero with an allowlisted stage only.

## Verification and handoff to #230

- Feasibility probe: exit 0; exact pins and scripted fixture assertions passed. No live Codex execution claimed.
- `npm run test:quick`: 2,131 tests, 2,131 pass, 0 fail/cancelled/skipped/todo.
- `npm run test:affected`: 2,131 tests, 2,131 pass, 0 fail/cancelled/skipped/todo; selected 279 files (the quick tier).
- `npm test`: 2,397 tests, 2,397 pass, 0 fail/cancelled/skipped/todo; exit 0, approximately 138 seconds, explicit 180-second command bound (repository subprocess deadline 175 seconds).
- `npm run typecheck`: **exit 2**, two existing errors in unchanged `scripts/scratch/post-project-test-message.ts`: missing `Message.scopeId` (line 24), invalid `WakePlan.messageId` (line 34). The file is byte-identical to the fixed base; web typecheck was not reached because the command uses `&&`.
- Initial checks before repository dependency installation failed: quick 1,781 tests / 1,694 pass / 87 fail; typecheck missing Node type definitions. `npm ci --ignore-scripts` restored repository dependencies; final results above supersede those setup attempts. No engine installation occurred.
- `git diff --check`: exit 0, clean.
- Branch diff over `src`, `web`, `package.json` and `package-lock.json` is empty; public `EngineAdapter`/`EngineSession`, native production adapters and manifests are unchanged.

For #230: record **Codex #225 through current OAR: unavailable pending named upstream controls**, with runtime behavior unproved. Keep this separate from #227's bounded Pi model evidence and from prior Codex protocol probes. Choose an upstream typed hook or retain a bounded native exception; a source-level gap does not require changing #225's acceptance, moving Environment-hosted execution, or claiming production compatibility. After the hook exists, the exact native-first scenario above is the resumption condition. Authentication/model authority and an authorized executor/work host must then be verified rather than assumed.

## Sources

- OAR pinned [SessionOptions](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/contracts/session-options.ts), [Codex opener](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/codex/open.ts), [Codex session](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/codex/session.ts), [app-server client](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/codex/app-server-client.ts). Actual inspected distribution hashes are in the evidence JSON.
- Accepted #227 [report and reusable contract at integration baseline](https://github.com/tinysnake/sprout/blob/465bd94b31cf7ec0bed83ae6946376e39c0a6d1d/docs/research/oar-pi-origin-prototype.md).
- [Prior Codex native/protocol evidence](codex-claude-host-run-remote-work-compatibility.md), [ordering verdict](225-226-ordering-verdict.md), [OAR seam recommendation](oar-engine-seam-recommendation.md), [integration spec](oar-integration-spec.md), [historical integration plan](oar-sprout-integration-plan.md), [Pi isolation precedent](pi-host-isolation-prototype.md).
- [ADR-0016](../adr/0016-immutable-execution-mode-at-startup.md), [ADR-0019](../adr/0019-project-mcp-tools-run-on-the-environment-worker.md), [references policy](../references.md). No reference code was copied; this ticket introduces no process transport/parser to compare or replace.
