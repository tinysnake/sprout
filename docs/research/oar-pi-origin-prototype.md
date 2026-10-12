# Pi remote-work controls through OAR (#227)

Scope: Run `r226`, first attempt, fixed Sprout base `6fe675fe77f46403eabf623c5e6300d3ab4e0a3c`. Disposable feasibility evidence only. Production adapters, Runtime admission, Worker protocol, leases, manifests and the shared origin fixture are unchanged.

## Verdict

**OAR 0.35.0 preserves a bounded Pi extension-based read/edit route on macOS.** Two real turns using exactly `magpie/codex/gpt-6.1-sol` exercised five typed work-tool callbacks. The first read returned the separate work origin's marker, the edit changed only the work effect, and explicit host-sentinel read and write requests were denied by execution policy. The second turn continued the same native session with the current controls reapplied. Independent direct OS opens proved host-sentinel read/write denial and denied direct engine access to the work origin.

This is a viable **candidate mechanism**, not complete #225 compatibility or production acceptance. Command/search/image/nested execution, real remote MCP origin, binding-generation fencing, Windows isolation and remote-stop proof remain unavailable or unproved. Each gap has a bounded remedy below. The work origin is a separate, credential-free sandboxed process on the same machine; it is not an enrolled Environment Worker or a cross-host deployment. #253 supplied source-level ordering evidence, not the composite enrolled-Worker result referenced by #230.

Machine-readable, allowlisted facts: [oar-pi-origin-evidence.json](oar-pi-origin-evidence.json). Runnable experiment: [probe-oar-pi-origin.mjs](../../scripts/probe-oar-pi-origin.mjs).

## Inspected and exercised versions

| Component | Version / pin | Evidence |
|---|---|---|
| OAR candidate | `@botiverse/oar` **0.35.0**, spec source commit `8adde16fe2d12ae54af7d4dff86c3f224380a5c7` | Exact npm tarball, unmodified opener/session/MCP/lifecycle/turn-helper modules; pinned GitHub opener also consulted |
| OAR tarball SHA-256 | `a6c7329f743cdf0ffea6e619aa3b708e2b9180087fc3ad3dbaba9b509fc58cc8` | Downloaded archive fingerprint |
| Pi coding SDK / Pi AI / Pi MCP | **1.0.4 / 1.0.4 / 1.0.4** | Existing installed release, selected explicitly; no engine installation/login |
| Current harness release | 1.1.0 is also present | Not substituted for the selected experimental SDK |
| Platform | macOS **27.0.1**, Node **26.11.1** | Live platform/version observations; Node meets OAR's `>=24` floor |
| Model / effort | `magpie/codex/gpt-6.1-sol`, `low` | Exact model read-back; OAR rejected an initial `off` request because this model clamps it to `low` |
| Shared fixture SHA-256 | `9d050f9f0943a0b3f4244f25ca0fe1cdacd4f49a5ff8be9b2c2d72de9814ab23` | Existing #239 script reused unchanged |

No floating OAR upgrade occurred. OAR's native dependency range is `^1.0.2`; the experiment binds the existing SDK 1.0.4 through a Node resolve hook, without patching OAR or replacing the SDK with a stub. The adapter imports OAR's internal Pi session module to avoid loading unrelated runtimes from the aggregate entrypoint. That deep import is a disposable experiment detail, not a proposed public dependency contract.

## Source findings and actual mechanism

The pinned `SessionOptions` exposes cwd, model, effort, resume, environment overlay, system-prompt replace/append and session MCP attachments. It has no standard `tools`, `noTools`, custom-tool-operation or resource-loader injection member. The Pi opener pre-trusts cwd, uses `OAR_PI_AGENT_DIR`, loads `createAgentSessionServices`, retains native resource discovery, and creates the session from those services. Its direct custom-tool seam only replaces bash to overlay environment variables; that remains host bash. Cwd, prompt instructions and `env` alone cannot select a remote executor.

However, the opener loads Pi extensions from the controlled agent directory before resolving the requested model, then calls `bindExtensions` on every open, including resume. A scratch-only reviewed extension therefore registers the existing Magpie provider factory and the two typed fixture tools. Scratch `settings.json` sets `defaultTools` to those names; `session_start` reapplies `setActiveTools` and checks the exact catalog. A `tool_call` hook blocks every other tool name. The real first turn confirms that the extension loaded through OAR, rather than through a replacement SDK opener. The hook's broader adversarial enforcement is source-only; the exact active catalog is protocol-only, and the observed permitted/denied requests are model-issued.

The existing EngineAdapter/EngineSession shape is implemented locally inside the disposable harness. `startSession` receives an injected `RemoteWorkspaceTools` capability, rejects other authority objects, and maps read/edit to the pinned origin bridge. `run().completion`, native key, interrupt acceptance and close follow the existing port shape. Progress is deliberately declared `none`; this experiment does not certify final-answer selection, usage or production event mapping. No new public testing Interface or product admission route is added.

The `remote_write` fixture tool uses `RemoteWorkspaceTools.edit`, requiring the existing work effect to equal `REMOTE_UNCHANGED` before replacing it. Host sentinel write attempts fail the origin read/path checks before any write can happen. This is a denied write request, not a successful write followed by restoration. No local file executor exists in the bridge. The separate origin validates relative paths and independently confines file-content access at the OS boundary.

OAR's Pi MCP implementation loads the SDK MCP extension and a session registration extension, uses direct typed exposure, escapes literal environment/header values and validates server namespaces. MCP stdio processes are started on the **engine host**, inheriting its environment. This is insufficient for ADR-0019's remote Project MCP placement. The synthetic MCP fixture here has only a harmless `ping` tool; it does not forward workspace operations, receive copied credentials, or constitute a general MCP proxy. Its tool is registered but excluded from the work catalog and never model-called.

OAR has no public live MCP attachment replacement/removal method. `Session.withdraw` withdraws held **inputs**, not servers. Closing the old session and opening a fresh session without `mcpServers` removed the synthetic MCP tool; the old synthetic server PID was observed absent after close. Resume explicitly supplied the MCP configuration again and registered its tool again.

Pi session disposal awaits native abort when running, then emits extension shutdown. The shutdown helper bounds hooks to 10 seconds and disposes afterward; native abort before that helper has no equivalent bound. `promptAndWait` waits indefinitely for native settlement after an accepted abort. The experiment therefore supervises the runner process group independently. Neither accepted abort nor a local process-group kill proves a remote operation stopped.

## Result matrix

Evidence classes are separate: **model-issued** means observed callbacks from a real model turn; **protocol-only** means actual SDK/OAR lifecycle/catalog observations without a model exercising that feature; **scripted** means deterministic calls or OS probes; **source-only** means inspected implementation. A weaker class does not inherit a stronger class from another row.

| Required control / scenario | Result and evidence class | Limit / one bounded remedy where needed |
|---|---|---|
| Same relative `origin.txt` on host/work | **Demonstrated, model-issued:** read callback returned `REMOTE_ORIGIN`; host marker stayed `HOST_ORIGIN` | Separate local sandbox origin only |
| Same relative `effect.txt`, work edit | **Demonstrated, model-issued:** work became `OAR_MODEL_EFFECT`; host stayed `HOST_UNCHANGED` | Whole fixture-content replacement through injected edit; arbitrary patches unproved. Remedy: one bounded patch case through the same origin capability |
| Explicit forbidden host sentinel requests | **Demonstrated, model-issued:** both read and write requests reached the controlled handler and returned denial; sentinel unchanged | Execution path policy, independent of model cooperation; OS probes separately below |
| Outer host read/write isolation | **Demonstrated, scripted:** direct engine and origin sentinel opens denied; engine's direct work-marker read denied | File-data macOS sandbox only; metadata/system reads remain allowed. Remedy for production scope: inventory runtime read roots and repeat the negatives on the selected production sandbox |
| Engine auth ownership | **Demonstrated, scripted:** engine auth readable but write-open denied; work origin has no auth allowance | No model-issued actual-auth attack in this ticket. Remedy: extend this OAR turn with the #239 credential read/write negatives |
| Pi native work-tool restriction through OAR | **Demonstrated, protocol-only:** exact active catalog is `remote_read`, `remote_write` on open/resume/fresh; **source-only:** guard blocks other tool names | Restriction uses controlled Pi settings/extensions, not a standard OAR tool-policy option. All native tools are not physically unregistered. Remedy for strong exclusion: a small upstream Pi opener policy hook supplying `tools`/`noTools` and a controlled loader, then rerun this scenario |
| Arbitrary ambient extensions/config/skills | **Unproved:** scratch HOME/agent directory avoids normal home discovery; only the reviewed fixture extension was deliberately installed | OAR retains default discovery, and does not prove a planted hostile project extension is excluded. Remedy: add a planted ambient-extension negative under the proposed loader hook |
| Enabled search | **Unavailable:** no search capability admitted; native grep/find/ls not in active catalog | Remedy: add one bounded origin-side search operation and model-issued same-name marker search |
| Image work | **Unavailable:** no image-reading capability admitted | Remedy: add one synthetic image to each origin and a bounded permitted-read/forbidden-host-image case |
| Shell / command origin | **Unavailable:** no command capability admitted; native bash/PowerShell excluded from active catalog | No model-issued command success is claimed. Remedy: additive fixture operation for one allowlisted command, executed in the isolated work process; repeat same-name command and failure cases |
| Nested/codemode/extension work paths | **Unavailable/unproved:** no nested model tool admitted; trusted extension code still executes on the engine host | Remedy: one adversarial nested/extension invocation against the selected exclusion hook; do not expose general shell helpers |
| Typed MCP registration | **Demonstrated, protocol-only:** actual OAR `mcpServers` registered `mcp__fixture__ping` in Pi's all-tool catalog; repeated on resume | No model MCP invocation or remote MCP origin. Remedy: one model call to a Worker-origin synthetic tool after an upstream typed-tool registration hook can preserve ADR-0019 |
| MCP withdrawal | **Demonstrated, protocol-only:** old synthetic server absent after close, fresh session without attachment has no old MCP tool | In-place withdrawal unavailable. Remedy if required: add a bounded upstream request-boundary attach/detach hook; otherwise retain close-and-fresh policy |
| Safe binding change | **Declared fresh-session alternative:** fresh native ID, same limited catalog, old MCP absent, **protocol-only** | Does not switch to a second authority or prove stale generation rejection. Remedy: two origin capabilities with generation fencing and one denied stale callback |
| Session continuation | **Demonstrated, model-issued + protocol-only:** same native ID, second real read turn, two successful turn outcomes; extension starts on all three opens | Does not certify production durable recovery/usage accounting |
| Remote failure without local fallback | **Demonstrated, scripted:** stop origin, then `RemoteWorkspaceTools.read('origin.txt')` fails; local markers remain unchanged | No model turn after origin loss. Remedy: one failure turn with an observed rejected read callback and unchanged host effect |
| Remote cancellation/fencing | **Unproved, source-only lifecycle gap:** abort delivery differs from terminal/remote-stop evidence | Remedy: one origin-side long-operation cancellation case with observed origin settlement, supervised independently of engine abort |
| Turn terminal/liveness reliability | **Unproved beyond the final successful repeat:** one earlier first turn completed its tool work but was projected non-completed; native cause was not retained | Remedy: one bounded repeat series retaining allowlisted native kind/outcome and cancellation timing, with no inferred settlement after timeout |
| Windows | **Unavailable:** no Windows work host exercised | Remedy: rerun this fixed contract on an authorized Windows host with a selected read-isolation mechanism |
| Enrolled/cross-host Work Environment | **Unavailable:** local sandbox fixture only | Remedy: run the same identity/effect/denial contract through an enrolled Worker; do not reuse #253 as that evidence |

The absence of model-issued command, remote MCP and full host-authority exclusion is a valid bounded prototype finding, not a compatibility pass. The selected route should remain a native exception or a limited experimental OAR policy until the required gaps are resolved.

## Reusable scenario contract for #228 and #229

Reuse [prototype-origin-fixture.mjs](../../scripts/prototype-origin-fixture.mjs) unchanged. No engine-specific fixture clone is needed.

1. Construct the three origins with existing marker values. Keep host and work `origin.txt` and `effect.txt` names identical. The work origin receives no engine credential access. Declare authority before opening a session.
2. Record exact engine/OAR/platform/model versions and the actual catalog before prompting. Refuse missing controls, versions or auth; never substitute a model/account or local executor.
3. In a bounded real turn, read `origin.txt`, edit `effect.txt` to an engine-specific synthetic marker, and explicitly attempt forbidden host sentinel read/write. Record observed tool requests and resource effects, not assistant assertions. For command acceptance add an allowlisted origin-side command; the existing fixture has no command operation.
4. Separately bypass tool-path validation with `os-negative` and direct engine opens. Require read and write denial; cwd or an unchanged sentinel alone cannot establish read isolation.
5. Close/reopen the native key with current authority and controls. Distinguish deliberate same-binding continuation from a changed binding, which must use a fresh native session and reject old authority.
6. Register a synthetic typed MCP attachment, observe shutdown, and open fresh without it. Keep engine-local registration distinct from the remote Worker MCP-origin requirement.
7. Stop the origin and issue another real capability request; require failure and unchanged host state. Do not redirect to host tools. Model-issued failure and remote-stop proof require their own observed cases.
8. Emit only allowlisted booleans, counters and version identifiers; clean up scratch state after children settle. Report each unsupported path and one bounded remedy; do not collapse the matrix into a universal pass.

## Reproduction, bounds and privacy

Prerequisites: macOS `sandbox-exec`; Node 24+; existing Pi SDK 1.0.4; existing authorized Magpie provider checkout, login and cached catalog; an unpacked exact OAR 0.35.0 package. `OAR_PROBE_ROOT` selects the unpacked package, `PI_PROBE_PACKAGE_ROOT` optionally selects the existing pinned SDK, and `PI_PROBE_PROVIDER_ROOT` optionally selects the reviewed provider checkout (default `../pi-extensions/pi-magpie`). There is no automatic engine install, login, network catalog refresh or alternative account/model.

Example (supply an explicit outer 180-second timeout through the command runner):

```sh
OAR_PROBE_ROOT=<unpacked-oar-0.35.0>/package node scripts/probe-oar-pi-origin.mjs
```

The supervisor has a 170-second overall deadline, kills the engine process group at 140 seconds, and uses the shared origin's 150-second bound and 10-second RPC limits. Each model turn requests abort after 60 seconds; the outer process-group deadline handles OAR's unbounded post-abort wait. The synthetic MCP fixture exits within 120 seconds. No service listener or port is used.

The scratch engine directory contains symlinks to existing auth/catalog files, never copied values. Lock sidecars can be created in scratch; the actual host targets have literal read allowances and OS-denied writes. This addresses the default storage lock limitation recorded in #239 without widening host writes. Provider factory modules are explicitly imported, not the provider's interactive extension entrypoint. A resolve hook binds their Pi compatibility import to the selected release. The origin is started separately by the supervisor, not as a descendant of the engine sandbox; nested sandboxes cannot widen inherited denials.

Runtime roots and the system/Homebrew trees are read-only allowances inherited from #239's prototype profile, not an inventory of minimum production reads. Inference networking is allowed for the engine; origin networking is denied. Prompts, model text, raw OAR records, native stderr, credentials, endpoints and absolute host paths are not retained. Experimental process IDs stay in scratch for termination observation and are not published. The final JSON reconstructs booleans/counters and a fixed failure vocabulary.

Initial bounded runs exposed two harness configuration faults: Pi auto-discovery recognizes `.js`/`.ts`, not `.mjs`, and this model does not support effort `off`. Changing the scratch extension suffix and explicitly requesting supported `low` produced successful turns; no engine/OAR upgrade or identity substitution was used. These are diagnosed experiment setup faults, not missing authentication prerequisites.

One later repeat completed all four required work requests but its first turn was not classified completed; its resumed turn and all resource-effect checks succeeded. That run is retained separately in [incomplete-turn evidence](oar-pi-origin-incomplete-turn-evidence.json). Its original projection did not preserve the native reason, so timeout versus another terminal failure cannot be attributed. The harness now records allowlisted native kind/outcome and uses a 60-second turn limit (previously 45), still under the same 140/170-second supervision. The final repeat reported `ended` / `completed` for both turns. A repeated successful turn does not resolve the earlier terminal uncertainty; production terminal/liveness reliability remains a separate conformance prerequisite.

## Prior evidence and references

Consumed the existing [engine seam recommendation](oar-engine-seam-recommendation.md), [integration plan](oar-sprout-integration-plan.md), [integration specification](oar-integration-spec.md), [ordering verdict](225-226-ordering-verdict.md) and [native Pi isolation evidence](pi-host-isolation-prototype.md). Their different inspected OAR versions are historical context; this experiment pins 0.35.0.

Standing references were checked via `docs/references.md`. AionUi `dc78ccd8472e0787404d295bbd817e31f3133cf1`, `src/process/acp/infra/ProcessAcpClient.ts`, was consulted directly: single ownership of process/transport, startup failure observation and lifecycle cleanup are retained as design guidance; no code was copied. Cumora's port design and Paperclip's workspace/authority separation remain inherited repository decisions. None proves the host read boundary.

Primary OAR sources at commit `8adde16fe2d12ae54af7d4dff86c3f224380a5c7`:

- [Session options](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/contracts/session-options.ts)
- [Pi opener](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/open.ts)
- [Pi MCP attachment](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/mcp.ts)
- [Pi session](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/session.ts), [shutdown](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/lifecycle.ts), [turn helpers](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/observe/turns.ts)

Reviewed npm module SHA-256 values:

| Module | SHA-256 |
|---|---|
| Pi opener | `e1317b26c535d81f378490e3b1d65a70dcba24faf1ed3cfde2b0e33b894d8f1a` |
| Pi MCP | `4b38f3d7dbd57fdbe3673ca9f9f56a92d23a94c4dfb4e05c50754b093b6a696c` |
| Pi session | `1012131c3c12e3d78b1df7d20e2a55114e1da8023bd03867643d3aaa4202701e` |
| Pi lifecycle | `9a8a74bc730b270f868d8cd8e826ba3ebb021dbb93dd64bb4d172cde60831d51` |
| Turn helpers | `402776ac4ed95347ae892b4a6c99accb518344e7d37b774dce346322b4d29c29` |

The script checks package versions, not these fingerprints; immutable admission needs artifact verification. Context7 CLI was not installed; pinned package sources and installed SDK declarations supplied the API facts instead of current-version assumptions.

## Repository verification

- `npm run test:quick`, explicit 180-second bound: **tests 2131, pass 2131, fail 0**.
- `npm run typecheck`, explicit 180-second bound: **exit 2, two TypeScript diagnostics**, both in existing `scripts/scratch/post-project-test-message.ts`: missing `Message.scopeId` at line 24 and unknown `WakePlan.messageId` at line 34. The identical command on an independently extracted fixed base reproduced both diagnostics. No unrelated production/scratch repair was made.
- `npm run test:affected`, explicit 180-second bound: **tests 2131, pass 2131, fail 0**.
- `npm test`, explicit 180-second subprocess bound: **tests 2397, pass 2397, fail 0**, exit 0 in 155.3 seconds.
- Final model probe: both turns reported native `ended` / `completed`, five observed work-tool callbacks, three extension starts, current catalog reapplied, and all recorded origin/denial/MCP/fresh-session facts true.
- Probe syntax and `git diff --check`: clean. Shared fixture and established production execution remain byte-identical to the fixed base.

Typecheck is not claimed green. Ticket acceptance and production integration remain Orchestrator decisions.

## Bounded F1 rework after the independent FAIL

This section appends the rework result to the original attempt. The preceding matrix, original observations and incomplete-turn artifact are historical; their unavailable-command classification describes the first attempt. The top-level evidence JSON is retained, with new observations under `rework`.

### Triage

F1 was an incomplete acceptance experiment: criterion 2 explicitly required a model-issued command, but the original authority and extension admitted only read/edit. Reporting command as unavailable and proposing a remedy did not supply that required observation. The reopen preserved acceptance, and the independent review correctly failed that omission while preserving the demonstrated controls. No observed command routing failure needed repair; the missing capability and observation needed to be added.

### Next attempt

- Unmet criterion: #227 acceptance criterion 2, model-issued read/edit/command on the work fixture with execution-controlled host-sentinel denial.
- Current explanation: no command was admitted in the first experiment, so the model could not exercise one.
- Change or experiment: add one fixed origin command and invoke it through injected authority and the actual pinned OAR route in a real model turn.
- Expected observation: a command callback returns the work marker and creates a work-only command effect while read/edit, sentinel denials and the other preserved observations remain true.

### Result and evidence classes

**F1 fixed for acceptance criterion 2 in this bounded local macOS scenario.** The final rework run observed exactly one `remote_command` callback in the first real model turn, alongside the original work read/edit and forbidden sentinel read/write calls. The command returned `REMOTE_ORIGIN`. Both turns ended/completed; the resumed turn performed another work read, for six callbacks total. The acceptance check requires these observed callbacks and final resource effects together, not assistant claims or a scripted command success.

- **Model-issued:** work read, edit to `OAR_MODEL_EFFECT`, command returning `REMOTE_ORIGIN`, explicit sentinel read/write requests denied by the origin execution path, and resumed work read. After the turn, work `command-effect.txt` equals `ORIGIN_COMMAND:REMOTE_ORIGIN`; host `command-effect.txt` remains `HOST_COMMAND_UNCHANGED`. Host origin/effect and sentinel markers remain unchanged.
- **Protocol-only:** exact three-tool active catalog (`remote_command`, `remote_read`, `remote_write`) on open/resume/fresh; same native ID on resume; synthetic typed MCP registration/re-registration, shutdown observation and absence after fresh open without the attachment. This still supplies no model-issued or remote Worker MCP proof.
- **Scripted:** original direct OS denials and auth ownership checks; four rejected command variants (executable, argv, cwd and timeout); untouched work command marker before the model; origin stopped followed by failed read and command capability calls without local fallback. These failure and allowlist checks are not model-issued evidence.
- **Source-only:** the fixed command dispatcher, native-tool guard and previously inspected OAR limitations. Reading their implementation supplies no additional model-issued claim.

Versions remain OAR **0.35.0**, source **8adde16fe2d12ae54af7d4dff86c3f224380a5c7**, Pi SDK/AI/MCP **1.0.4/1.0.4/1.0.4**, Node **26.11.1**, macOS **27.0.1**, model **magpie/codex/gpt-6.1-sol**, supported effort **low**. No installation/login or floating upgrade was performed.

### Additive fixture contract and limits

The shared fixture is extended **only additively**: all existing operations, paths and marker values are preserved. Two new same-name `command-effect.txt` files start at `HOST_COMMAND_UNCHANGED` and `REMOTE_COMMAND_UNCHANGED`. The new operation accepts only `fixture-origin-command`, empty argv, cwd `.` and timeout 5000 ms. It launches a fixed Node child in the work origin's cwd, inherits the origin sandbox and network denial, reads relative `origin.txt` and writes the separate relative command effect. It exposes no caller-selected shell code. Existing host/work edit markers are untouched by this command. This is one allowlisted command proof; arbitrary shell remains unavailable.

The injected `RemoteWorkspaceTools.command` follows the existing port shape; the extension and supervisor forward it to the same origin process. Existing production paths, manifests, EngineAdapter/EngineSession definitions, Environment placement and synthetic MCP contract are unchanged. Credentials remain referenced locally and read-only. Scratch prompts, process identifiers and host paths are not published.

### Rework repository checks and remaining uncertainty

Locked repository dependencies were restored with `npm ci --ignore-scripts` in this checkout, without changing manifests or lockfile. Each required check used an explicit 180-second command bound:

| Check | Rework result |
|---|---|
| `npm run test:quick` | tests 2131, pass 2131, fail 0; exit 0 |
| `npm run test:affected` | tests 2131, pass 2131, fail 0; exit 0 |
| `npm test` | internal 175000 ms timeout; no final counters; incomplete, not green |
| `npm run typecheck` | exit 2; same two previously baseline-reproduced scratch errors: missing `Message.scopeId` and unknown `WakePlan.messageId` |
| Probe syntax / JSON / diff whitespace | pass |

The live probe retained its 60-second turn, 140-second engine and 170-second supervisor bounds; the added command has its own 5-second subprocess bound. The final repeat completed the model scenario and all original true boolean observations remained true. Repository checks remain unresolved for independent acceptance; F1's evidence disposition does not turn those checks green. The original intermediate terminal uncertainty and all previously named gaps outside the fixed command remain. In particular, general shell, model-issued remote-failure/MCP paths, hostile-extension exclusion, Windows, enrolled cross-host execution and remote cancellation settlement are still unproved/unavailable. No production compatibility claim is added.
