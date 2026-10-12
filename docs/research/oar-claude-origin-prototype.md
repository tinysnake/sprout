# Claude builtin exclusion and root attribution through OAR (#229)

> Historical first attempt. The [rework record](oar-claude-rework.md) and its separate evidence supersede the unavailable-command and scripted-only failure classifications below. Remaining nested/automatic-loader gaps are explicitly unproved; neither attempt establishes Claude-native model compatibility.

Run `r226`, Job `r226-pro-worker-a3`, first attempt. Fixed branch base:
`6fe675fe77f46403eabf623c5e6300d3ab4e0a3c`. The accepted #227 report and evidence
were read from integration commit `465bd94b31cf7ec0bed83ae6946376e39c0a6d1d`;
they were not merged into this branch. The full #229 body and its sole Dispatch
comment were read through the authorized own-ticket tracker access.

## Verdict

**Claude through pinned OAR has bounded read/edit isolation feasibility with two
small prototype hooks; unmodified OAR is insufficient for #225 compatibility.**

The actual OAR Claude session, launch, MCP handoff, kernel and turn helper completed
three model turns through the existing EngineAdapter/EngineSession shape. Nine
model-issued MCP calls read `REMOTE_ORIGIN`, changed only the work effect to
`OAR_CLAUDE_EFFECT`, checked it, denied host/auth read and write requests and a
symlink escape, then checked the effect after same-binding resume. The observed
native catalog was exactly two approved MCP tools on open and resume, and empty
on a fresh session without attachment. All host markers remained unchanged.

This is the existing **non-Claude model behind Claude Code**, not a Claude-native
model result. The work origin is a separate local sandbox process, not an enrolled
Environment Worker or a cross-host deployment. Commands, comprehensive discovery
exclusion, changed-authority fencing, remote cancellation and Windows remain
unproved or unavailable. Direct OAR MCP repository descriptors have the wrong
execution/network origin for ADR-0019. No production adapter, Host-run feature,
engine installation/login, dependency upgrade, push or merge was performed.

The upstream #55 sequence deterministically reproduces premature root completion
on OAR 0.35.0. A small projection hook prevents that settlement in the scripted
contract, including unknown autonomous origin, child result, retained pending
steerability, root-only usage and pending abort intent. Live crash/resume with an
actual background task remains unproved. Repository checks are **not all green**.

## Versions and reproducible artifacts

| Component | Pin / observation |
|---|---|
| OAR | `@botiverse/oar` **0.35.0**, spec source `8adde16fe2d12ae54af7d4dff86c3f224380a5c7` |
| Existing unpacked archive | SHA-256 `a6c7329f743cdf0ffea6e619aa3b708e2b9180087fc3ad3dbaba9b509fc58cc8` (the #227 archive reused; no download/upgrade) |
| Claude Code | **2.1.294**, executable SHA-256 `def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53` |
| Platform | macOS **27.0.1**, Node **26.11.1**; meets OAR Node 24 floor |
| Authorized existing model | `group/auto-mimo-v2-6-flash[1m]`, configured effort **high**; exact native model report matched, effort read back on each open |
| Shared fixture | Unchanged `scripts/prototype-origin-fixture.mjs`, SHA-256 `9d050f9f0943a0b3f4244f25ca0fe1cdacd4f49a5ff8be9b2c2d72de9814ab23` |
| Dependencies | Existing installed `cross-spawn`/`which`, selected from the harness release via a resolve hook; no stub or install |

[Live evidence](oar-claude-origin-evidence.json) contains the actual OAR module
fingerprints for launch, session, projection and MCP handoff. Version checks refuse
a package other than 0.35.0 and a CLI other than 2.1.294. Fingerprints are recorded,
not enforced by the probe: immutable production artifact admission is still needed.
Historical native reports used an older OS version; that is recorded platform
drift, not an OAR upgrade or a claim of cross-platform equivalence.

Artifacts:

- [Origin probe](../../scripts/probe-oar-claude-origin.mjs): actual OAR route,
  controlled executable launch hook, same shared fixture, existing native
  auth/bridge helper, separate origin and engine/bridge OS profiles.
- [Engine seam driver](../../scripts/prototype-oar-engine-seam.mjs): disposable
  EngineAdapter/EngineSession-shaped conformance driver; no registered product
  adapter, Runtime admission route, final-answer or production-usage certification.
- [Attribution probe](../../scripts/probe-oar-claude-attribution.mjs) and
  [scripted evidence](oar-claude-attribution-evidence.json): deterministic external
  CLI frames consumed by the actual pinned OAR session and helper.
- [Attribution hook](../../scripts/prototype-claude-origin-hook.mjs): delegates
  parsing to the unchanged vendor projection; no vendor parser copied.
- [Repository verification facts](oar-claude-verification.json): bounded checks,
  exact counters where available, timeout classifications and diagnostic limits.
- [Initial effect-mismatch evidence](oar-claude-origin-initial-effect-mismatch.json):
  an earlier initialized run completed native turns and denials but failed the
  exact requested work-effect assertion. It is not a passing read/edit/check run.

Supply these existing prerequisites, then execute each command with an explicit
outer timeout of at most 180 seconds:

```sh
OAR_PROBE_ROOT=<unpacked-oar-0.35.0>/package \
OAR_PROBE_DEPS=<existing-harness-release> \
CLAUDE_PROBE_PORT=<assigned-disposable-port> \
node scripts/probe-oar-claude-origin.mjs

OAR_PROBE_ROOT=<unpacked-oar-0.35.0>/package \
OAR_PROBE_DEPS=<existing-harness-release> \
node scripts/probe-oar-claude-attribution.mjs
```

The live probe requires an explicitly supplied assigned disposable port, refuses a conflict,
and leaves no service running. Port values and endpoints are not evidence artifacts.
The supervisor has a 170-second deadline, the executable hook 145 seconds, origin
150 seconds and RPCs 10–12 seconds. Work/resume/fresh turn limits are 100/25/15
seconds, under the supervisor; OAR's potentially unbounded post-abort wait is
covered by the process-group deadline. The fault probe has 3-second turn limits,
a 20-second supervisor and 10-second synthetic CLI lifetime.

## Actual controls and necessary hooks

Pinned SessionOptions has cwd/model/effort/resume/env/system-prompt/MCP attachment;
it has no builtin selection, strict discovery or controlled-loader member. The
Claude launch adds `--dangerously-skip-permissions` and merges the host environment.
That is not interception or isolation. `mcpServers` is additive to native discovery.

The disposable executable hook receives OAR's native launch, removes its permission
bypass flag, replaces the child environment with a constructed allowlist and adds:

- `--bare`, `--tools ''` and redundant disallowing of Bash, Read, Write, Edit,
  Glob, Grep, Agent, Task, Skill, ToolSearch, WebFetch and WebSearch;
- disabled slash commands and Chrome, empty settings sources, explicit settings,
  and `--strict-mcp-config`;
- `--permission-mode dontAsk`, `--permission-prompts none`, and approval grants
  only for `mcp__origin__remote_read` and `mcp__origin__remote_write`.

Approval grants are independent of tool availability; there is no auto-approval
callback and no universal interception claim. Model-visible harmless engine tools:
**none**. Engine-local harmless controls are prompt/stream transport, explicit
model/effort selection, read-only auth helper, scratch session/config/temp storage,
MCP stdio connector, inference networking and supervised termination. None is a
model-visible work tool.

The native auth helper reads the original engine-owned settings; no credential
file/value is copied to the origin. The engine profile allows that literal file
read-only, runtime/system/script roots and control roots. The origin and bridge
cannot read/write auth or host sentinels; the engine and bridge cannot directly
read/write the work fixture. The inherited literal ICU timezone-data admission
is retained. Broad read-only runtime/system allowances and metadata access are
prototype limitations, not a complete OS sandbox or minimum resource inventory.

OAR hands MCP config over a FIFO outside the runner. Initial launches failed with
MCP `EPERM` before initialization because the profile allowance used a noncanonical
path. Canonicalizing only that FIFO's literal read allowance enabled initialization;
no home directory, work origin or write allowance was widened. The engine starts
only a fixed stdio connector; an independently sandboxed supervisor-owned bridge
forwards to the separate fixture origin. This avoids nested sandbox application.
It is local test wiring, not ADR-0019 Worker authority or a general MCP proxy.

The first initialized run's exact effect assertion was false despite native success.
The final prompt explicitly required the exact synthetic string without added
whitespace, and the repeated run passed. The earlier actual content was not retained,
so its cause is not inferred. Native completion alone is never counted as work proof.

## Result matrix

The common #227 shape is retained. **Model-issued** = observed native tool-use
frames and corresponding real-model callbacks/resource effects. **Protocol-only** =
actual OAR/CLI catalog, native identity, model/effort and session observations.
**Scripted** = injected CLI events, direct OS opens or direct fixture calls.
**Source-only** = inspected pinned implementation. A weaker class never inherits a
stronger class from another row, prior ticket, or successful installation.

| Required control / scenario | Result and evidence class | Limit / one bounded remedy where needed |
|---|---|---|
| Same relative `origin.txt` on host/work | **Compatible within fixture, model-issued:** remote marker observed; host marker unchanged | Separate same-machine origin, not an enrolled deployment |
| Same relative `effect.txt`, work edit/check | **Compatible within fixture, model-issued:** exact `OAR_CLAUDE_EFFECT` written and read back; host effect unchanged | Whole-file fixture write only. Remedy for arbitrary patch: one bounded origin-side patch case |
| Explicit forbidden host/auth read and write | **Compatible within fixture, model-issued:** four requests reached origin policy and were denied; host sentinel unchanged | No inference from assistant refusal; actual auth values never forwarded |
| Symlink escape | **Compatible within fixture, model-issued:** remote symlink read denied | Traversal separately **scripted**, not a model traversal claim |
| Outer host read/write isolation and auth ownership | **Compatible for tested file data, scripted:** direct opens deny engine/bridge/origin sentinel access; only engine can read original auth; all auth writes denied; engine/bridge direct work access denied | Broad system/runtime reads remain. Remedy: inventory minimum runtime reads and repeat negatives under the selected production profile |
| Native builtin exclusion through OAR | **Unmodified route refuted, source-only; hook route compatible within fixture, protocol-only:** exact two approved tools on open/resume; empty fresh catalog | Standard SessionOptions lacks controls. Remedy: upstream immutable Claude launch-policy option for tools, discovery and constructed environment |
| Automatic configuration, MCP, skills, hooks and context | **Partially compatible, protocol-only + scripted:** planted ambient MCP did not enter catalog, hook marker absent; native bare/strict/source flags applied | Absence of a marker does not prove unreadability or exhaustive resource exclusion. Managed policy and every plugin/resource path unproved. Remedy: one controlled-source inventory with planted read/execute canaries for each admitted loader |
| Nested Agent/Task/Skill/ToolSearch work | **Unavailable in observed catalog, protocol-only; origin nested op denied, scripted** | No model-issued nested attack or general extension execution claim. Remedy: one bounded adversarial nested invocation against the proposed exclusion option |
| Shell/command origin | **Unavailable:** shared fixture has no command operation and Bash is excluded | Remedy: add one allowlisted command additively to the shared fixture, then require a model-issued command and failure case |
| Search and image work | **Unavailable:** no search/image operation admitted | Remedy: add one bounded origin-side search/image scenario to the common fixture contract |
| Typed MCP attachment and discovery | **Compatible as local test transport, protocol-only + model-issued:** connected approved server and nine matching native tool-use/callback observations | This does not validate arbitrary repository descriptors or MCP resources/prompts |
| Project MCP process/network origin | **Direct descriptor route refuted, source-only:** Claude starts stdio commands and HTTP clients on its engine host; connector test is explicitly engine-local | Remedy: a Worker-origin typed-tool registration hook, with server startup and HTTP connections retained at the approved Worker under ADR-0019 |
| MCP removal | **Compatible close-and-fresh alternative, protocol-only:** fresh session without attachment reports zero tools | In-place detach and remote stop not proved. Remedy: explicit close/fresh policy with observed Worker termination or fencing |
| Same-binding resume and current controls | **Compatible within fixture, protocol-only + model-issued:** same native ID, exact catalog, current model/effort, real effect read after resume | Not interrupted recovery or durable usage certification |
| Changed binding | **Declared fresh-session alternative, protocol-only:** fresh native ID without prior attachment | A second authority and stale-generation rejection unproved. Remedy: two origin capabilities with one denied stale callback |
| Remote failure without local fallback | **Compatible only scripted:** stop origin, direct capability read fails; host markers stay unchanged | No model-issued failure turn. Remedy: one resumed model read after origin loss with rejected callback and unchanged host effect |
| Pending root attribution, original OAR | **Refuted, scripted:** autonomous task-notification result settles host prompt as completed before root text and makes steer unavailable | No corrected version substituted. Remedy: the bounded hook below, then upstream origin/input lifecycle handling |
| Pending root attribution, bounded hook | **Compatible for represented race, scripted:** background and unknown-origin results do not settle root; steer stays accepted; child result ignored; actual root text settles; root usage excludes background; pending abort preserved | Live background/crash-resume and full command-lifecycle correlation unproved. Remedy: one bounded live crash/resume race using the pinned native CLI with a controlled background fixture |
| Remote cancellation/fencing | **Unproved:** local disposal and process-group supervision do not prove remote work stopped | Remedy: one long origin operation with observed termination or generation fence before lease release |
| Windows / enrolled cross-host Work Environment | **Unavailable:** this run used macOS local sandbox origins | Remedy: repeat this fixed contract on authorized Windows and enrolled cross-host Worker placements |

## Attribution hook boundary

[Upstream #55](https://github.com/botiverse/oar/issues/55) was OPEN when fetched;
it describes Claude 2.1.284 resuming a dead background shell, issuing a stopped
task notification and a zero-turn `result` with `origin.kind = task-notification`
after the host prompt is queued but before it starts. The same ordering can occur
without a crash. No issue comments or closing fix were present. These are upstream
source facts, distinct from this experiment's installed CLI 2.1.294.

The fault fixture supplies that ordering over stdio to unchanged OAR 0.35.0.
Its lifecycle notifications are minimal scripted context; this probe does not
verify native command-lifecycle ID fields or correlation. Its original projection maps every result to turn-ended and uses only
`parent_tool_use_id` for attribution. Autonomous `origin` without a parent is
therefore root-attributed; the session clears its active prompt and the helper
settles before `ROOT_ONLY` arrives. A positive tagged child result confirms that
the test distinguishes child attribution from the missing autonomous origin case.

The hook delegates the native fold, then for a non-null `origin` result restores
the prior projection state, suppresses root terminal/usage events and assigns a
synthetic autonomous path. Thus the session's own active state and the external
waiter both remain pending. It does not invent completion, translate autonomous
results into Sprout Tasks or admit nested agents. Unknown origin kinds are also
excluded from root settlement. This is a bounded policy for the represented
sequence, not complete vendor turn parsing, a universal turn identity guarantee,
or a shipped production fix. The protocol lacks a separately verified correlation
for every possible untagged late result; the live race remains a prerequisite.

## Repository verification

Every invocation used an explicit outer timeout of at most 180 seconds. Logs and
timeout diagnostics stayed local; only sanitized counters/classifications are here.

| Check | Observed result |
|---|---|
| Initial dependency-free quick attempt | 1,781 tests; 1,694 pass, 87 fail; uncaught missing `ws`; not a valid green gate |
| `npm run test:quick` after existing-dependency reuse | **2,131 tests, 2,131 pass, 0 fail/cancelled/skipped/todo**, exit 0 |
| First `npm run test:affected` with concurrent probes | Outer 180-second timeout; no final counters; not passing |
| Isolated `npm run test:affected` | **2,131 tests, 2,128 pass, 3 fail**, 0 cancelled/skipped/todo; exit 1 |
| `npm test` | Repository internal **175-second suite deadline**, under outer 180-second bound; no final counters; not passing |
| `npm run typecheck` | **Exit 2, seven diagnostics**: two existing scratch-file type errors; missing Playwright declaration plus four induced implicit-any diagnostics in the existing browser test |
| Live origin probe, final | Three completed turns, nine model calls; all six recorded bounded live predicates true; command unavailable and live crash/resume unproved explicitly retained |
| Attribution conformance | Three deterministic cases and pending-abort assertion pass; original defect reproduced; both hooked cases preserve root work |
| Probe syntax / `git diff --check` | Clean |

The three affected failures are existing `src/test-summary.test.ts` cases at
lines 37, 75 and 180: suite-deadline test names were reported as fixture filenames,
concurrent hung tests likewise reported filenames, and pre-kill completed results
were absent. Those files and their implementation are unchanged. The cause and
baseline reproducibility of these failures were not established in this session;
quick previously passed them. No timing or runner patch was made to force green.

This worktree initially lacked repository dependencies. Its lockfile matched the
existing primary checkout, whose installed tree was linked into this worktree
without package-manager mutation. That installation lacks Playwright. Initial
typecheck also lacked Node types. The repeat exposed the two scratch errors already
recorded and base-reproduced by #227, plus the five dependency-related diagnostics.
No install or primary-worktree modification was performed. Typecheck is not green.

The branch diff over **`src`, `web`, `package.json` and `package-lock.json` is empty**.
The shared origin fixture is byte-identical to the fixed base. No production tests,
manifest, service, domain or ADR changed. Existing native execution is preserved.

## Implications for #230

Treat Claude as a limited feasibility candidate requiring a launch-policy hook and
an attribution fix. Neither the accepted Pi result nor this result supplies
composite enrolled-Worker evidence. Keep direct Project MCP descriptors away from
the engine host. Prefer a small upstream policy/typed-registration option over a
second parser or a production executable wrapper with hidden global settings.

The existing native Claude round-2 report, OAR integration specification, accepted
#227 common contract and ADR-0016/0019 supplied the comparison. `docs/references.md`
was checked; its already documented AionUi process-ownership design and Cumora
engine seam remain guidance, not newly verified isolation evidence. No standing
reference source or vendor parser was copied. Context7 was unavailable; the
find-docs workflow used pinned package modules and installed help under the
no-install constraint. The result does not waive the repository validation failures
or extend production runtime support.
