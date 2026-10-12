# #229 rework: evidence plan and observations

Historical first-attempt report: [OAR Claude origin prototype](oar-claude-origin-prototype.md). This rework supersedes its unavailable-command classification; other original results and the accepted bounded attribution experiment remain historical evidence.

### Triage

The original Dispatch required controlled discovery and model-issued read/edit/command plus forbidden-path coverage. The first Work record and the independent FAIL agree that the experiment never supplied command or model-issued stopped-origin/nested observations, and automatic-loader markers only showed absence. This is an incomplete verification design, not an observed failure of the remote read/edit dispatcher. The first attempt reported limitations honestly but treated remedies as sufficient closure of required observations. Its scripted nested/failure denials and source-inspected flags cannot supply model-issued or loader execution evidence. The artifacts at c9a95a503 preserve that distinction and the accepted bounded attribution result; that result needs no rework.

The new base 06f829dee includes #227's accepted additive fixed command, whose rework report and JSON were read. The shared fixture will remain byte-frozen. F1 now needs route-specific observation only. F2's native Agent/Task/Skill/ToolSearch are deliberately absent from the pinned restricted catalog; an inadmissible invocation must remain unproved, not be replaced with a synthetic nested tool. F3 needs positive controls and observable denial, with unreachable managed/plugin/resource loaders individually identified rather than inferred safe from silence.

### Next attempt

- Unmet criterion: #229 criteria 2 and 3: controlled automatic discovery and model-issued work read/edit/command, host/nested/loader denials, and no remote-failure local fallback.
- Current explanation: the original authority omitted commands and its probes did not distinguish suppressed discovery from attempted-and-denied resource access; model failure/nested scenarios were absent.
- Change or experiment: expose only the accepted fixed command through the existing Claude MCP route, issue real work and stopped-origin turns, request nested invocation under the unchanged exclusions, and add positive/negative loader canary controls with explicit unreachable-path dispositions.
- Expected observation: correlated native calls and callbacks, work-only command effects, rejected model read/command after origin loss and unchanged host markers; loader entry/read/execute outcomes distinguished from non-entry, or an explicit unproved mechanism and bounded remedy.

### Outcome

**F1 is fixed in the bounded Claude CLI experiment; F2 is unproved because native nested tools are excluded, and F3 is partially evidenced but remains unproved overall, so this is not a universal compatibility or acceptance pass.**

The final live repeat used the actual stopped origin transport, not an early injected unavailable response. All three turns completed; 11 native tool uses matched 11 bridge callbacks. One successful command returned the work origin marker and created its work-only effect; resumed model read and command requests failed after actual origin shutdown. Five native loader sources have positive, attempted-and-denied, and restricted non-entry controls. Other loader routes require further observations before criterion 3 can be claimed generally.

### Evidence

- Pi session ID: 01a12f56-213e-708e-9ae6-5aa7b2801f7b
- Rework base: `06f829dee`, merging original Ticket artifacts `c9a95a503` with accepted integration `379ac92da`. Full original Dispatch, Work record and independent FAIL were read directly on #229 before edits. #227's accepted command rework report and JSON were read from this base; its Pi observations are not reused as Claude evidence.
- Pins: OAR **0.35.0**, source **8adde16fe2d12ae54af7d4dff86c3f224380a5c7**; existing archive SHA-256 **a6c7329f743cdf0ffea6e619aa3b708e2b9180087fc3ad3dbaba9b509fc58cc8** independently rechecked. Claude Code **2.1.294**, executable SHA-256 **def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53**; macOS **27.0.1**, Node **26.11.1**. Backend **group/auto-mimo-v2-6-flash[1m]**, effort **high**. This non-Claude-native backend evidences Claude CLI/OAR projection behavior only, not Claude-native model compatibility. No upgrade, installation, login or backend substitution.
- **F1 — fixed, criterion 3, model-issued:** [live evidence](oar-claude-rework-origin-evidence.json) records work read, exact edit/check and command using the frozen `fixture-origin-command`, empty argv, cwd `.`, timeout 5000 ms contract. Work command effect equals `ORIGIN_COMMAND:REMOTE_ORIGIN`; host command effect remains `HOST_COMMAND_UNCHANGED`. Host origin, edit effect and sentinel all remain unchanged. After `await origin.stop()`, both resumed model requests traverse the same dispatcher and invoke the stopped origin RPC; rejection/timeout becomes a failed tool result. Both failure callbacks have `originStopped=true`, `ok=false`, `originUnavailable=true`. No local work tools appear in the catalog, no host effect appears, and no fallback executor is introduced. The earlier guard-based failure run was superseded by this real-transport repeat. These checks close the bounded model command/failure observation, not arbitrary shell or enrolled cross-host execution.
- **F2 — unproved, criterion 3:** the real prompt requested Agent/Task delegation if callable. Native catalogs on open/resume contain exactly the three approved MCP work tools; Agent, Task, Skill and ToolSearch are excluded by empty builtins, explicit disallowedTools and disabled skills. No native nested tool use occurred. That mechanism makes the nested invocation inadmissible on this pinned restricted route. Scripted `nested` operation rejection remains scripted and is not a model-issued attack. Bounded remedy: a separate pinned native nested-route conformance experiment, with explicit authority for a nested builtin and the same outer resource denials, or upstream invalid-tool invocation telemetry demonstrating rejection before dispatch. This rework does not enable subagents or treat a synthetic remote nested operation as that proof.
- **F3 — unproved overall, criteria 2 and 3; partial scripted evidence:** [loader evidence](oar-claude-loader-evidence.json) contains 15 native CLI cases for user/project/local/explicit settings hooks and an explicit disposable plugin hook. Each positive case records entry and successful synthetic host read/write; each denied case records entry plus both `EPERM`/`EACCES` denials and no host effect; each restricted case records no entry/effect after the positive control established observability. The canary code is deliberately readable and executable in scratch so it can report its denied host IO. These observations prove the tested hook's host IO boundary, not unreadability of every loader source. Native processes all exit 1 on synthetic authentication/closed-route setup, with no per-case timeout; that exit is not a model-turn pass. No real auth is supplied to these controls.
- F3 remaining inventory: `CLAUDE.md`/rules lack audited read-attempt observation; skills are disabled by `--disable-slash-commands` (pinned help says bare alone still allows slash-name resolution); automatic installed-plugin registry/agents/LSP entry is untraced even though explicit plugin hooks were controlled; managed policy/MCP has no provisioned controllable system source and cannot be redirected through `setting-sources`; MCP resources/prompts are not advertised by the approved tools-only bridge; explicit plugin URL/add-dir/agents are absent from the constructed OAR launch. Each is **unproved**, not fixed by absent markers. The evidence JSON gives a mechanism and one bounded remedy per route. Required next prerequisite: authorized native file-read auditing plus disposable automatic plugin/skill/context controls; a separately provisioned managed-policy fixture for that system source. No real policy or installed plugin registry was changed.
- Final verification: all three changed modules pass `node --check`; `git diff --check`, JSON parsing, privacy pattern checks, frozen-fixture fingerprint and assertions comparing all 11 native tool names to callback operations pass. All recorded bounded live predicates and the five three-case loader controls are true.
- Evidence separation: **model-issued** = 11 observed native tool-use frames and corresponding real-model callbacks/resource effects in the live OAR run; **protocol-only** = exact catalog, model/effort, same-ID resume, fresh ID/empty catalog; **scripted** = direct OS/fixture negatives, the extra direct failed RPC and all native loader canaries; **source-only** = pinned OAR option/launch limits and inspected exclusion/dispatch implementation. No lower class inherits model-issued status. The origin is a separate local sandbox, not an enrolled Worker. The accepted deterministic attribution result was not reopened; live background crash/resume remains unproved.

Repository checks used the existing linked dependency tree without package-manager mutation, default concurrency and deadlines. Each check had an explicit 180-second outer bound; suites retained their internal 175-second deadline. The extracted unchanged-base control used `6fe675fe77f46403eabf623c5e6300d3ab4e0a3c` inside this worktree and the same dependency symlink, then was removed. Relevant test/runner/configuration files have no diff against that base. Exact counters and full 1/5/15-minute loads are in [check evidence](oar-claude-rework-checks.json); machine has 10 logical CPUs.

| Check | Counters and exit | 1-minute load start → end | Disposition |
|---|---|---|---|
| Ticket quick | tests/pass 2131/2131; fail/cancelled/skipped/todo 0; exit 0 | 18.66 → 21.40 | Passed |
| Ticket affected | tests/pass 2131/2131; fail/cancelled/skipped/todo 0; exit 0 | 22.84 → 19.34 | Passed |
| Base focused `test-summary` | tests/pass 8/8; fail/cancelled/skipped/todo 0; exit 0 | 16.93 → 15.79 | All earlier failing cases passed |
| Ticket focused `test-summary` | tests/pass 8/8; fail/cancelled/skipped/todo 0; exit 0 | 15.79 → 13.85 | Matched control passed |
| Base typecheck | seven diagnostics; exit 2; test counters inapplicable | 13.85 → 12.90 | Same two scratch and five missing-Playwright-related diagnostics |
| Ticket typecheck | seven diagnostics; exit 2; test counters inapplicable | 12.90 → 12.90 | Baseline reproduced; not green |
| Ticket full | no final counters; exit 124 at 175 seconds | 11.37 → 17.07 | Incomplete; not green |
| Base full | no final counters; exit 124 at 175 seconds | 13.58 → 5.77 | Timeout reproduced on unchanged base; consistent with supplied #254 provenance |

The prior three test-summary failures are not reproducible in these tier/focused runs. Their unchanged source and passing matched controls do not prove a specific timing/load cause; disposition is **historical unresolved transient, no stable Ticket regression observed**, not a repaired bug. Full timeout and all seven type errors are baseline-reproduced here. No deadline, concurrency or unrelated code was changed.

### Changes

- `scripts/probe-oar-claude-origin.mjs`: expose the accepted fixed command, add model command and actual stopped-transport failure turns, record separate rework evidence, request nested delegation only if admitted.
- `scripts/prototype-claude-fixture-bridge.mjs`: disposable three-tool schema/transport for this fixture only; no general MCP proxy, production adapter or nested admission.
- `scripts/probe-oar-claude-loaders.mjs`: native positive/denied/restricted controls and explicit remaining loader inventory.
- New sanitized live/loader/check JSON and this report; original evidence/attribution artifacts retained. The first-attempt report links here to prevent its unavailable-command row being read as current.
- Shared fixture SHA-256 **f95a7d05324cc8f528ff4e60a7ad1fb25e29e55dad4ee193ed87d6bc23e3012a**, unchanged from `06f829dee`. No production source, web, manifest, harness, domain or ADR changes.

### Deviations

- F2 cannot supply a model-issued nested invocation through a catalog that excludes that tool; this is reported unproved with a named mechanism and remedy, not fixed by scripted rejection.
- F3 improves observability for five hook sources but does not supply comprehensive automatic resource-loader exclusion. Remaining controls stay unproved and require the named bounded experiments/provisioning; acceptance was not weakened.
- Context7 CLI is unavailable; find-docs used installed pinned help and the exact OAR package without installing tooling. No reference/vendor code was copied; existing AionUi/Cumora design provenance remains as documented in the first attempt.
- Final live probe repeated after replacing the premature failure guard with a real stopped-origin RPC. Repository checks preceded that probe-only correction; syntax, evidence assertions and diff checks cover the final probe, while unchanged repository behavior has the recorded provenance.

### New fog

Automatic context/skill/plugin-agent/LSP read attempts and controlled managed policy remain unobserved. No native nested invocation occurs under this catalog. Historical test-summary failure timing attribution remains unresolved despite passing matched controls. Windows, enrolled Worker placement, arbitrary shell, remote cancellation/fencing and live background crash/resume remain outside demonstrated compatibility.

### Follow-ups

- Orchestrator: reconcile F1's bounded fix, F2's excluded-route unproved conclusion and F3's remaining prerequisites; do not promote this record to universal criterion-3 acceptance or Claude-native compatibility.
- For F3, supply a disposable automatic plugin registry/skill/context fixture with native read-attempt auditing; provision managed-policy controls separately under appropriate authority. Keep explicit hook results separate from automatic discovery evidence.
- For F2, decide whether upstream rejected-tool telemetry or a separately authorized nested-builtin sandbox experiment is the needed observation; keep subagent admission outside production.
- Keep #254/full-suite timeout and baseline type/dependency remediation outside #229; preserve production execution and the pinned substrate.
