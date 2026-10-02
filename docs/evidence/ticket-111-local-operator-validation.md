# Ticket #111: local operator validation evidence

## Scope and isolation

This run started from commit `309657cd823e68942d42e0086c6e29a4e7258557`. All live macOS state used a dedicated temporary database, Task context root, Project workspace root, Worker state directory, and LaunchAgent plist directory below `.tmp/ticket-111/`. The Web listener used one unoccupied port from the assigned isolated range. No preview files, preview Worker state, existing daemon, or other port was used.

The host-local Operator credential, browser session and CSRF values, enrollment claim secret, Worker identity, and Worker configuration stayed in owner-only temporary files. They were not printed in evidence, committed, or sent to the issue.

## Version record

| Component | Observed version |
| --- | --- |
| Source revision | `309657cd823e68942d42e0086c6e29a4e7258557` |
| Sprout package | `0.0.0` |
| macOS | `26.6.2` |
| Node.js | `v26.9.0` |
| npm | `11.19.1` |
| Worker protocol | `3` |
| Codex CLI | `0.159.3` |
| Pi CLI | `0.99.2` |

The supported policy is Codex **>= `0.154.0`** and Pi **>= `0.86.1`**, without exact pinning, per the [owner decision on record-gap F2](https://github.com/tinysnake/sprout/issues/111#issuecomment-5945342529). The attempt-1 versions above qualify. Version availability is not the remaining execution blocker. The rework below records a real successful turn and separates the historical failure from controlled diagnosis.

The following sections retain attempt-1 observations. The round-3 evidence below supersedes its AC3 execution gap and records the limits of historical failure attribution.

## AC1: bootstrap and user-session service

The Sprout instance was started with `SPROUT_ENV_SOURCE=enrollment`, an isolated SQLite file, an isolated Task context root, the dedicated port, and a generated host-only Operator credential. `npm ci` installed the locked dependencies before startup. The live Web API returned the pending enrollment bootstrap. A production Worker CLI command claimed it from stdin, then a Human-authorized Web request approved the identity and `agent-run` permission.

Sanitized commands and observations from the macOS exercise:

```text
$ npm ci
added 130 packages

$ npm start
Sprout listening on http://<loopback>:<allocated-port>
environment: enrollment catalog (no enrolled instances)

$ <claim-secret-file> node bin/sprout worker enroll ws://<loopback>:<allocated-port> <enrollment-id>
Identity proven. Waiting for Human approval in Sprout Web; run `sprout worker start` afterwards.
exit: 5 (awaiting the separate Human approval)

$ SPROUT_WORKER_HOME=<isolated-worker-state> \
  SPROUT_LAUNCH_AGENTS_DIR=<isolated-launchagent-directory> \
  SPROUT_WORKSPACE_ROOT=<isolated-project-workspace-root> \
  node bin/sprout worker install-service
Installed LaunchAgent <service-label>. It starts at sign-in and restarts after an unexpected exit.

$ node bin/sprout worker status
state: connected
epoch: 1
protocol: 3
service: installed and loaded
```

The real signed-in-user LaunchAgent was loaded and started. Its plist and Worker state were directed into the isolated temporary area. A regression fix in this change passes an explicitly supplied workspace root through the LaunchAgent environment; without it, the service would fall back to a user-profile workspace root. `worker status` later reported epochs `2`, `3`, and `4` after controlled service restarts and the unexpected Worker-process termination described below.

Equivalent Windows 11 steps for owner exercise:

1. In the signed-in Windows user session, install the supported Node.js runtime and the Sprout Worker CLI. Install and sign Codex and/or Pi in locally using each engine's supported login flow.
2. In Sprout Web, create a pending enrollment with platform `windows` and the required capability request. Copy the one-use claim secret without placing it in shell history or an argument.
3. From the Worker checkout, run `node .\bin\sprout worker enroll wss://<core-private-host>:<allocated-port> <enrollment-id>` and provide the one-use claim on stdin. Use the operator-managed private network and WSS for a non-loopback Core.
4. Approve the claimed identity and requested capability permission in Web. Record explicit model authorization there, then request the Worker readiness probe.
5. In the same signed-in session, run `node .\bin\sprout worker install-service`, then `node .\bin\sprout worker status`. The product-managed service is a logon-triggered Scheduled Task. Use the default user-profile Worker and Project workspace roots unless a separately verified Windows service configuration is provided.
6. Add the approved Environment to a Project using the default workspace selection. Inspect the enrollment, compatibility, permission, engine readiness, connection, and workspace facts in Web.

Windows commands and service lifecycle were not executable on this macOS host. This section is an equivalent procedure, not Windows live evidence; the owner must schedule and accept that exercise separately.

## AC2: enrollment, readiness, and Project workspace

The production authenticated Web API and real Worker CLI exercised enrollment rather than a fixture Worker:

- `POST /api/auth/session` created the isolated Operator session. Subsequent Human requests carried the cookie and CSRF proof from private temporary storage.
- `POST /api/environments/enrollments` created one pending macOS enrollment and returned one-use claim material, which was stored privately and piped to `worker enroll` on stdin.
- The CLI proved Worker key possession and returned the expected awaiting-approval status. Web then approved the same identity and granted `agent-run` explicitly.
- The accepted Worker reported protocol `3`; Web reported `approved`, `online`, `compatible`, and `agent-run: allowed`. The authenticated readiness probe returned HTTP `201` and a committed Worker receipt.
- The Worker reported Codex and Pi as installed, authenticated, and engine-ready. The selected Codex model was unavailable on this Environment. After explicit Human authorization and a fresh probe, the Pi option reported compatible. Model/account readiness remained separate from installation and authentication.
- The first compatibility request reported the Codex model as unavailable and Pi availability as unknown until authorization. After the approved Pi model authorization, the Agent compatibility route reported an available Pi option. No inference was used for readiness probes.
- A real Project and Agent were created through Web. `POST /api/projects/<project-id>/access` selected the Worker-managed default workspace and returned `active` with an opaque workspace identity. The corresponding Project directory was observed under the isolated Worker workspace root. The active binding survived the Sprout restart.

A real Agent run submitted through `POST /api/runs` was accepted with HTTP `202` but settled `failed` before producing a recognized turn outcome. The Pi CLI version differed from the recorded probe pin. The run had no active lease or recovery record; it is not evidence of a completed run or of active-run interruption semantics.

A proposal-backed Task begin was also attempted through the production routes. It returned `409 no-compatible-agent`, although the Agent compatibility route had reported an available Pi option. This prevented a Task-held run from reaching the recovery exercise and is recorded below as unresolved live behavior.

## AC3: durable restart and recovery outcomes

Before the ordinary Sprout restart, the isolated database projected: enrollment approved, Worker online, protocol compatible, `agent-run` allowed, work safety clear, active Project workspace access, zero recovery records, and zero Force Release records.

The Sprout process was terminated and restarted against the same isolated database. The new process recorded the same-version migration as unchanged and startup as ready. The database retained the approved enrollment, capability permission, Project, and active workspace binding. During the restart window, Web recorded `connection: offline` and `compatibility: unknown`; its current connection view was `never-connected`. The still-running Worker CLI continued to report its old epoch `1` as connected, and did not establish a new accepted epoch until the isolated LaunchAgent was explicitly kickstarted. That same identity then connected at epoch `2`; Web returned to online and compatible, with no recovery or Force Release record.

An isolated Worker stop produced a sanitized host diagnostic with `service: running`, `worker: stopped`, `data: accessible`, and engine readiness `unknown`. Web diagnostics retained the enrollment as approved and recorded offline connection and unknown compatibility events while the `agent-run` grant remained intact. Restarting the isolated LaunchAgent restored the Worker at epoch `3`; Web returned online and compatible, and the database still had no recovery or Force Release records.

A separate unexpected kill of the isolated Worker process caused LaunchAgent restart and same-identity reconnection at epoch `4`. Web diagnostics contained the offline/unknown transition followed by a duplicate-same-key acceptance and online/compatible state. The host-local sample was taken after the restart had already completed, so it showed the recovered state rather than a stopped snapshot.

Attempt 1 did **not** exercise active-run disconnect, retained Worker evidence, recovery reconciliation, normal recovery, or Force Release. The round-3 live chain below now exercises those outcomes; the original observations remain historical evidence.

## AC4: sanitized diagnostics

The injected Worker stop and unexpected process kill used only the isolated environment. The host command `sprout worker status --diagnostics` returned the finite host-local facts described above. The authenticated Web diagnostics endpoint returned HTTP `200`, typed Environment state, and finite durable event kinds/states including `connection:offline`, `compatibility:unknown`, and later `connection:online` / `compatibility:compatible`.

These exports contained no credential, model/account identity, host path, raw command, or raw stderr. The host-local export described the Worker process state; Web described the Core's accepted connection and compatibility state. Reconnection restored both projections without editing runtime JSON or reenrolling the Worker.

## AC5: checks and privacy review

- Focused Worker service, #167 recovery journal, reconnect, Force Release, diagnostics, and Web recovery tests: **43 passed, 0 failed**.
- Focused production Web recovery/privacy/state tests: **14 passed, 0 failed**.
- `src/worker/cli/worker-cli-recovery.test.ts` (#167 product-path coverage): **5 passed, 0 failed**.
- `src/runtime-reconnect-retry-crash.test.ts`: initially reproduced an unhandled `database is not open` after runtime shutdown. After the shutdown drain change, it passed **three consecutive isolated runs** and passed in the focused group.
- Source split: `npm run test -- 'src/**/*.test.ts'` — **1634 passed, 0 failed**.
- Web split: `npm run test -- 'web/src/**/*.test.ts'` — **408 passed, 0 failed**.
- Combined suite: `npm run test -- 'src/**/*.test.ts' 'web/src/**/*.test.ts'` — **2042 passed, 0 failed**.
- `npm run typecheck` — passed.
- `npm run web:build` — passed; Vite emitted its existing large-chunk advisory.
- `npm run test:full` was redirected through a sanitizer that retained only failing TAP blocks; it captured **zero failures**.
- The direct `npm test` terminal summary reported `0 passed / 1 failed`, despite the raw full TAP run and all source/Web split runs passing. The combined `npm run test -- <source-glob> <web-glob>` command uses the same `scripts/test-summary.ts` and passed 2042/2042. This discrepancy remains for owner/tooling adjudication; it is not represented as a passing `npm test` result.
- Privacy review found no credentials, cookies, claim material, host names, user names, absolute local paths, real ports, or private network addresses in the committed evidence and source diff.
- **Owner acceptance: pending.**

## Deviations and follow-ups

- Windows bootstrap and user-session service steps are documented but not live-exercised here. The Windows live exercise remains an owner follow-up.
- **F2 — engine readiness versus turn execution:** the owner-approved minimum-version policy supersedes the original exact-pin concern. A successful Pi turn and controlled model failure are recorded below. Attempt-1 raw logs and selected Pi model were not retained, so its exact engine failure cause cannot be recovered from the evidence alone.
- **F3 — Core restart reconnect:** after the isolated Sprout restart, the Worker retained its old local connected epoch and needed an explicit LaunchAgent kickstart before the Core accepted a new epoch. Verify and correct automatic same-identity reconnect after a graceful Core restart.
- **F4 — Project Agent eligibility mismatch:** reproduced with the same durable Agent, selected Environment, active Project membership and workspace grant, fresh model authorization, and successful one-round execution. Fixed by sharing the durable Agent resolver between Task lifecycle and ordinary run admission; the regression and live Task begin/advance now pass.
- Round-3 AC3 live evidence follows. Windows live exercise and owner acceptance remain outside this rework's completed outcomes.
- The direct `npm test` summary discrepancy needs a reproducible explanation even though the combined `npm run test` and separated source/Web baselines pass.

**Disposition:** Partial. Mac enrollment, service, diagnostics, Project workspace, restart persistence, and production code checks are evidenced. AC3 recovery/Force Release and Windows live exercise remain pending; owner acceptance is pending.

## Windows live exercise — rework round 2 (F5)

### Base, triage, and isolation

The rework checkout was verified with `git log --oneline -1`: `23bf7ef7 record ticket 111 operator validation`. The attempt-1 Work record and both reviewer reports were read before this exercise. F5 identifies missing live Windows bootstrap and signed-in-user Scheduled Task evidence: the prior attempt supplied a procedure because no Windows host was available, so it did not satisfy AC1. This rework was assigned the owner-provided Windows host to obtain that evidence.

The intended Windows exercise required a dedicated temporary database, Worker state, Project workspace, and an occupancy-checked allocated port block. No Windows session was established, so no tree transfer, port occupancy check, bootstrap, service installation, or runtime operation occurred. Existing preview state and services were not touched.

### Sanitized prerequisite transcript

```text
$ ssh -o BatchMode=yes -o ConnectTimeout=15 <windows-host> <prerequisite-command>
<user>@<windows-host>: Permission denied (publickey,password,keyboard-interactive).
result: passwordless SSH authentication rejected
local command timeout: 45 seconds
connection timeout: 15 seconds
```

The SSH client reached authentication, but the owner-provided passwordless access did not authenticate. No credential workaround, password prompt, key provisioning, or authentication configuration change was attempted. No remote command outcome was obtained. Local shell version output from the attempted command is excluded because it does not establish Windows prerequisites.

### Acceptance status and next action

- **AC1 Windows / F5:** blocked before bootstrap. Neither host-local bootstrap nor the signed-in-user Scheduled Task lifecycle was exercised.
- **AC2 Windows:** enrollment, authenticated reconnect, protocol compatibility, capability permission, engine readiness, and Project workspace behavior were not exercised. Windows OpenSSH configuration, Node.js/npm availability, repository access at the required base, and installed engine versions remain unverified.
- **AC3 Windows:** ordinary Core restart, Worker disconnect/reconnect, active-run recovery, retained evidence, reconciliation, normal recovery, and Force Release were not exercised. The engine-pin decision remains pending; authentication prevented checking whether an installed engine could complete a turn.
- **AC4 Windows:** no Web or host-local diagnostic export was obtained. The SSH authentication rejection is an access prerequisite failure, not product diagnostic evidence.
- **AC5:** this change is documentation only. No production code or script changed; no production suite was rerun. Privacy review and `git diff --check` were performed for the evidence addition. Owner acceptance remains pending.

**Follow-up:** Restore the promised passwordless SSH access to the owner-provided Windows host, then redispatch F5 at the verified base. Repeat the allocated-port occupancy check before creating isolated runtime state. Resolve the engine-pin decision and obtain a successful turn before claiming the conditional active-run recovery chain.

**Disposition:** Blocked. F5 remains open; this rework records an actual SSH prerequisite failure and claims no Windows product acceptance result.

## Windows live exercise — corrected SSH account continuation (F5)

### Provenance, prerequisites, and isolation

The owner subsequently supplied the correct SSH account and confirmed passwordless access. The earlier blocked attempt above and commit `002a435e` remain an honest historical record: they used the implicit SSH account, not the owner-specified account used for this continuation. No credential workaround or authentication configuration change was made.

The production tree was transferred as a `git archive` tarball from verified base `23bf7ef7`. The SHA-256 matched on both hosts: `ee3af7592720da1212123f7d99ad3b723c42c96c00e35a5220543d86108e4c8a`. The remote installation therefore exercised that base tree, not the documentation-only continuation commit. Transfer files and smoke drivers were temporary and were not committed.

| Component | Windows observation |
| --- | --- |
| OS | Windows `10.0.26200`, AMD64 |
| Windows PowerShell | `5.1.26100.9444`; system locale supplied by owner as zh-CN |
| OpenSSH | Passwordless authentication succeeded; `sshd` running |
| User session | Interactive desktop process present; Worker task principal `Interactive` |
| Node.js | `v24.21.0` |
| npm | `10.2.0` |
| Git | `2.42.0.windows.2` |
| Codex CLI | `0.154.0`, matching the recorded Codex probe pin |
| Pi CLI | `0.87.1`, newer than the recorded Pi `0.86.1` probe pin |
| Worker protocol / schema | `3` / `27` |

All Windows state lived below a dedicated `<isolated-root>` with inheritance disabled and access granted to the current owner and SYSTEM. The Core database, Operator/session/CSRF data, one-use claim, Worker identity/configuration, logs, Task context root, and Project workspace root stayed there. The assigned port block was checked before startup and had zero occupied TCP ports. The Core listened only on `<loopback>:<allocated-port>` within that block. No preview state, existing Worker home, foreign process, or preview service was used.

Remote commands used passwordless SSH with `BatchMode=yes`, `ConnectTimeout=15`, and an explicit local timeout no greater than 180 seconds. Encoded PowerShell scripts avoided shell interpolation and localized command parsing. Version checks used the Pi `.cmd` shim after PowerShell refused its `.ps1` shim; no execution policy was changed. Raw host logs remained restricted temporary data, and only finite observations are recorded here.

### AC1 Windows: bootstrap and product-managed Scheduled Task

```text
$ ssh -o BatchMode=yes -o ConnectTimeout=15 <windows-host> <ASCII-safe-prerequisite-command>
SSH-OK; OpenSSH running; interactive session present
allocated block: zero occupied TCP ports

$ git archive --format=tar <verified-base>
transfer SHA-256: matched on Windows

$ npm.cmd ci --no-audit --no-fund
added 130 packages; exit 0

$ <isolated-Core-bootstrap>  # production src/main.ts, enrollment source, private credential file
Core listening on http://<loopback>:<allocated-port>

$ <claim-secret-file> node .\bin\sprout worker enroll ws://<loopback>:<allocated-port> <enrollment-id>
identity proven; exit 5 (awaiting Human approval)

$ node .\bin\sprout worker install-service
Installed Scheduled Task <isolated-worker-task>; exit 0

$ node .\bin\sprout worker status
state: connected; epoch: 1; protocol: 3; service: installed and loaded

$ node .\bin\sprout worker uninstall-service
Removed Scheduled Task <isolated-worker-task>; exit 0

$ node .\bin\sprout worker status
state: stopped; protocol: 3; service: not-installed
```

Windows Scheduled Tasks do not inherit the installing shell's isolation variables. The supported `SPROUT_CLI_PATH` override selected an owner-only temporary `.cmd` wrapper, which set `SPROUT_WORKER_HOME` and `SPROUT_WORKSPACE_ROOT`, changed into the isolated checkout, and dispatched the unchanged production CLI. The product registered the task, started it, inspected it, and removed it. This wrapper is an isolation harness, not a production source modification or evidence that arbitrary shell variables automatically propagate to the default Windows action.

Task Scheduler reported exactly one task with the isolated wrapper action, state `Running`, trigger `MSFT_TaskLogonTrigger`, principal logon type `Interactive`, restart count `3`, restart interval `PT1M`, `StartWhenAvailable=true`, and execution limit `PT0S`. Task installation/status and removal were exercised in the existing signed-in session. A real logoff/logon, sleep transition, or automatic unexpected-exit restart was not tested.

A detached Core launched through SSH disappeared when its SSH session ended. The durable exercise therefore used a separate, manually registered temporary Core harness task running production `src/main.ts`; it loaded the Operator credential from restricted temporary storage. This task was separate from the product-managed Worker task and was removed at cleanup.

### AC2 Windows: enrollment, permissions, readiness, and workspace

The production authenticated Web API returned `201` for Operator sign-in and pending Windows enrollment. The CLI consumed the one-use claim on stdin and proved identity; Web then approved the enrollment and explicitly allowed `agent-run`. The real Worker connected with protocol `3`; Web projected `approved`, `online`, `compatible`, `agent-run: allowed`, and work safety `clear`.

Explicit non-inference readiness requests returned `201` with committed Worker receipts. Codex and Pi were both installed, authenticated, and engine-ready. Before model authorization, model availability remained unknown. A real Agent and Project membership were created; model authorization was refreshed after the Agent configuration changed the requirement revision, then a fresh probe made the selected work option available. These were production Human-authorized routes, with no runtime JSON or database amendment.

A real Project was created through `POST /api/projects`. `POST /api/projects/<project-id>/access` selected the Worker-managed default workspace and returned active access with an opaque workspace identity. The isolated workspace root contained created directories. The same binding and workspace identity survived Worker reconnects and the Core restart completed with the intervention described below. No absolute workspace path was returned in the recorded Web projection.

Preliminary run attempts were refused before engine execution: the first lacked Project Agent membership; the next had membership but stale model authorization. After current-revision authorization and a fresh probe, compatibility was available and both subsequent engine attempts reached the production run path with the selected work option and workspace binding. These prerequisite refusals are not product inconsistencies.

### AC3 Windows: restart observations and conditional engine blocker

A controlled Worker disconnect used `Stop-ScheduledTask` followed by the production `worker stop` command. The wrapper task alone did not stop its detached Node child in this harness, so task stop alone is not claimed as a disconnect. After `worker stop`, host diagnostics reported `worker: stopped`; Web reported offline connection and unknown compatibility. Approval, capability permission, and active workspace access remained durable. `Start-ScheduledTask` restored the same Worker identity at epoch `2`, with online/compatible Web state, without reenrollment.

**F9 — graceful Core shutdown stalls with an accepted Worker connection:** The temporary Core harness requested the production SIGTERM handler in `src/main.ts` via `process.emit('SIGTERM')`; this exercises its handler rather than an OS-delivered Windows signal. In a bounded repeat, after 15 seconds the listener was absent, the Core Node process still existed, the Core task remained `Running`, and Worker status still said connected at epoch `3`. Stopping the isolated Worker let the Core task become `Ready` within the following three-second sample. Starting the Core and Worker tasks then restored the same identity at epoch `4`. The first observation showed the same intervention requirement and recovered at epoch `3`.

Source inspection supports the connection-dependent explanation: `src/runtime.ts:1945` awaits `api.close()` before closing the Worker gateway; `src/web/api.ts:1020` awaits the HTTP server close callback. The live differential establishes that releasing the Worker connection permits shutdown. This finding is separate from F8's retry-drain deadline. No source fix was made here, and automatic Worker reconnect across an uninterrupted ordinary Core restart is not claimed.

Actual authorized engine turns:

| Engine | Compatibility before submission | Durable result |
| --- | --- | --- |
| Codex `0.154.0`, authorized `gpt-5.4` | Available | Failed after approximately 23 seconds: `codex turn failed: the engine reported an error` |
| Pi `0.87.1`, authorized `openai-codex/gpt-5.4` | Available | Failed after approximately 8 seconds: `pi turn failed: the engine ended the turn with an error stop reason` |

Neither turn produced a recognized successful result or any recorded run event. Codex reached execution with hand-off attached; Pi recorded its chosen work option and workspace binding before failing. Installation, authentication, and compatibility do not establish turn success. The sanitized product failures above are the observed blockers; the underlying provider cause was not established, and no credential workaround was attempted. The engine-pin decision remains pending with the owner.

Because neither engine completed a successful turn, the conditional active-run disconnect, retained evidence, recovery reconciliation, normal recovery decision, and Force Release chain was not attempted. The final production recovery endpoint returned **zero recovery records and zero Force Release records**. No AC3 recovery acceptance is claimed.

### AC4 Windows: induced failure and sanitized diagnostics

```text
$ <stop-isolated-worker-task>
$ node .\bin\sprout worker stop
stop signalled to the isolated Worker

$ node .\bin\sprout worker status --diagnostics
service: running; data: accessible; worker: stopped; reachability: unknown
engine readiness: unknown

$ GET /api/operator/diagnostics  # authenticated Operator session
HTTP 200; enrollment: approved; connection: offline; compatibility: unknown
worker: not-connected; reachability: unknown; workSafety: clear
finite events: connection/offline, compatibility/unknown

$ <start-isolated-worker-task>
$ node .\bin\sprout worker status
connected; epoch: 2; protocol: 3; service: installed and loaded

$ GET /api/operator/diagnostics
HTTP 200; connection: online; compatibility: compatible; worker: connected
finite events: duplicate-same-key, connection/online, compatibility/compatible
```

The host-local `service: running` fact was returned even when Task Scheduler reported `Ready`; it must be read alongside `worker: stopped`, not as proof of a live Worker. The readiness endpoint's disconnected view was `never-connected`, while the diagnostic projection and durable events recorded `offline`. These are the actual projections observed, not normalized synonyms.

A live privacy check inspected both diagnostic exports in memory for the actual temporary Operator credential, session cookie, CSRF value, claim secret, host username, isolated root, absolute Windows paths, and concrete network addresses. It passed. Exported facts contained finite states and opaque subjects, with no raw command, raw stderr, account identity, or host path. The Core restart itself is reported separately under F9 because its listener was unavailable during shutdown.

### AC5, cleanup, and disposition

`npm.cmd run typecheck` passed on Windows at the transferred production base. No production code, scripts, or tests changed in this continuation; the source/Web suites were not rerun, and no new baseline counters are claimed. `git diff --check` and privacy review cover the documentation addition.

Cleanup used the production Worker stop and uninstall-service commands, verified the isolated Worker task absent, and observed stopped/not-installed CLI status. With the Worker stopped, the Core shutdown completed; its separate temporary harness task was unregistered. The assigned port block then had zero occupied TCP ports. The entire owned temporary exercise directory, including credentials, claim, Worker key, database, archives, scripts, logs, and workspaces, was removed. Existing services and engine login stores were preserved.

**Disposition:** Partial. F5's Windows bootstrap and signed-in-user Scheduled Task exercise is now evidenced, as are enrollment, readiness, workspace persistence, Worker reconnect, and sanitized diagnostics. F9 needs a separate shutdown repair. Successful engine turns, conditional AC3 recovery/Force Release, the pin decision, and owner acceptance remain pending.

**Attempt-1 disposition:** Partial. Its AC3 gap is addressed by the round-3 evidence below; Windows live exercise and owner acceptance are still pending.

## Round 3: engine diagnosis and AC3/AC5 evidence

### Isolation and version policy

The mandatory starting revision was verified as `23bf7ef7`. Each reproduction used a new isolated SQLite database, Task context root, Project workspace root, foreground Worker state, and Pi session directory. The listener stayed within this Job's assigned isolated allocation. No preview state, existing service, or other Job's processes were used. Foreground Workers replaced service installation for these interruption probes; attempt 1 remains the service-lifecycle evidence.

The successful replay used Codex CLI `0.159.3` and Pi CLI `1.0.0`. Both meet the owner-approved minimums above. The historical `0.99.2` Pi version also qualifies; this rework does not claim to have rerun that older executable. Engine protocol telemetry contains its older mapper baseline, which is not a measurement of the installed CLI version.

### Diagnosis: observed failure versus readiness and admission

The attempt-1 record retains `202 -> failed`, but neither its selected Pi model nor raw engine logs. Its raw smoke state was removed. The exact historical engine failure therefore remains **UNDETERMINED**. A controlled negative case reproduces the same accepted-then-failed shape with a known cause; it is not represented as proof of the original configuration.

The controlled failure and working configuration were exercised through the real enrollment-backed production API and real Pi CLI:

```text
POST /api/agents                                  -> 201
  engine=pi; workModel=magpie/codex/validation-missing-model; effort=low
POST /api/projects                               -> 201
  current Agent membership + selected Environment + default workspace
POST /api/environments/enrollments/<enrollment>/model-authorizations -> 200
POST /api/environments/enrollments/<enrollment>/probes               -> 201
GET  /api/agents/<negative-agent>/compatibility   -> 200; available=true
POST /api/runs                                   -> 202
GET  /api/runs/<negative-run>                     -> 200
  status=failed; events=0
  failure="pi turn failed: the engine ended the turn with an error stop reason"

Real engine log, captured privately with the same model selection:
  Warning: Model "codex/validation-missing-model" not found for provider "magpie".
  Using custom model id.
  message_end: stopReason=error
  turn_end: stopReason=error
  upstream status=400; type=invalid_request_error
  message: the selected model is not supported with the current login mode
  agent_settled; CLI exit=0

Working selection:
  engine=pi; workModel=magpie/codex/gpt-6-luna; effort=low
  fresh Human model authorization after Agent configuration is present
  same selected Environment, current Agent membership, active default workspace grant
POST /api/environments/enrollments/<enrollment>/probes -> 201
GET  /api/agents/<agent>/compatibility                 -> 200; available=true
POST /api/runs                                       -> 202
GET  /api/runs/<successful-run>                       -> 200
  status=completed; result.status=completed; result.text=VALIDATION_OK
```

This establishes that installation/authentication/readiness and a Human model authorization are not inference entitlement tests. The negative model reaches the real engine and fails despite compatibility being available. Selecting an actually supported provider-qualified model completes a recognized turn. No credentials or account identity appear in these excerpts.

Three product defects were then reproduced and fixed, each with a regression that failed before its fix:

- **F9 — Task admission used only the startup Agent registry.** With the same durable Web-created Agent, selected Environment, active Project membership/workspace grant, current authorization, and successful one-round execution, proposal begin still returned `409 no-compatible-agent`. Task lifecycle now uses the same current durable Agent resolver as ordinary run admission. Archiving an Agent continues to prevent Task advancement.
- **F10 — the Task recovery route bypassed Environment proof and history.** It could resume a disconnected Task without synchronized evidence, or resume a synchronized Task while leaving the Environment recovery record open. Enrollment-backed Task recovery now delegates to the Environment recovery service, preserving proof checks and recording the decision with the holder transition. Inapplicable actions retain their actionable refusal; injected development carriers retain their existing cleanup retry path.
- **F11 — active Worker channel loss was classified as failed.** The Core-side Worker session now settles channel loss as `interrupted`. This classification does not prove that the remote engine stopped; normal recovery still requires separately synchronized settlement, engine fence, and safe Task context.

The configured seed Agent can still require Codex while a durable Agent selects Pi. An overall readiness summary may consequently remain yellow; the tested Pi option's compatibility and Task admission use its own declared model. The successful configuration does not treat the unavailable Codex model as proof that Pi is unavailable.

### AC3: normal interruption, reconciliation, and recovery

The final replay loaded the fixes above. It began a Human-led proposal-backed Task, advanced a real Pi turn, waited for a real tool-call event, and terminated the actual foreground Worker during that turn. The Worker PID came from its isolated runtime record; terminating only the CLI wrapper is insufficient for an uncatchable signal.

For every row below, a separate host-local read-only SQLite connection captured the durable run, lease, Task, recovery, and Force Release rows. The authenticated Web diagnostics export, Environment recovery endpoint, and `sprout worker status --diagnostics` were sampled at that step. IDs are consistently replaced with placeholders; raw prompts, event bodies, paths, and connection material are omitted.

```text
POST /api/task-proposals/<normal-proposal>/begin -> 201
POST /api/tasks/<normal-task>/advances           -> 202

Before Worker termination:
  SQLite: run=running; events=1; Task=in-progress/running; lease=active
  recovery records=0; Force Release records=0
  Web: approved / online / compatible; workSafety=held
  Host: worker=connected; reachability=reachable; data=accessible

Terminate actual isolated Worker with SIGTERM during the turn:
  SQLite: run=interrupted; events=1; Task lifecycle=recovery; lease=recovering
  recovery: cause=worker-channel-lost; phase=recovery; evidenceSynchronized=false
  Web: offline / unknown; workSafety=recovery; interruption=interrupted
  Host: worker=stopped; reachability=unknown; data=accessible
  Retained Worker journal:
    engineStopped=true; acknowledged event prefix=1
    settlement.status=interrupted; settlementAcknowledged=false

Start the same enrolled Worker; authenticated epoch increases:
  durable decisions: reconnect-observed -> evidence-synchronized
  recovery evidence:
    retainedEventCount=1; turnSettlementObserved=true; terminalStatus=interrupted
    engineSessionStopped=true; taskContextPrepared=true; taskContextRecycled=false
  SQLite: run=interrupted; recoverySettlement={status:interrupted,eventCount:1}
    Task lifecycle=recovery; lease=recovering; recovery phase=recovery
  Worker journal: turns=[] after durable receipt/projection acknowledgment
  Web: online / compatible; workSafety=recovery
  Host: worker=connected; reachability=reachable; data=accessible

POST /api/tasks/<normal-task>/recovery {action:resume,reason:<operator-reason>} -> 200
  SQLite: recovery phase=resolved; decision=resumed; lease=active
    Task=blocked; activeRunId=null; run remains interrupted
  Web: recovery:resumed; workSafety=held
  Host: worker=connected; reachability=reachable; data=accessible
  No new run or automatic replay; the same Environment and Task lease remain held.

POST /api/tasks/<normal-task>/discard {reason:<operator-reason>} -> 200
  SQLite: Task=cancelled/discarded; lease=released; Force Release records=0
  Host filesystem: normal Task context manifest absent; Project workspace present
  Web: workSafety=clear
  Host: worker=connected; reachability=reachable; data=accessible
```

### AC3: unresolved proof and Force Release

A second Human-led Task reached a real in-flight Pi turn. The isolated Worker journal recorded that turn and `engineStopped=false` before the actual Worker was killed with SIGKILL. This deliberately exercised missing proof; a process kill cannot establish that its engine child stopped.

```text
Before SIGKILL:
  SQLite: run=running; events=0; Task=in-progress/running; lease=active
  Web: online / compatible; workSafety=held
  Host: worker=connected; reachability=reachable; data=accessible
  Worker journal: current turn retained; engineStopped=false; settlement absent

After SIGKILL of actual Worker:
  SQLite: run=interrupted; Task lifecycle=recovery; lease=recovering
  recovery: worker-channel-lost; phase=recovery; evidenceSynchronized=false
  Web: offline / unknown; workSafety=recovery
  Host: worker=stopped; reachability=unknown; data=accessible

Same-identity Worker reconnect and reconciliation:
  durable decisions: reconnect-observed -> evidence-synchronized
  evidence: retainedEventCount=0; turnSettlementObserved=false
    engineSessionStopped=false; taskContextPrepared=true; taskContextRecycled=false
  SQLite: run=interrupted; lease=recovering; recovery phase=recovery
  Web: online; workSafety=recovery
  Host: worker=connected; reachability=reachable; data=accessible
  Retained journal does not invent a terminal settlement or clear the inherited engine uncertainty.

POST /api/tasks/<force-task>/recovery {action:discard,reason:<operator-reason>} -> 409
  code=evidence-not-synchronized
  "Ordinary recovery requires an acknowledged terminal outcome, engine fence, and safe held context."
  SQLite: lease remains recovering; Task remains in recovery

POST /api/environments/recovery/<force-lease>/force-release -> 201
  acknowledgedRisks=true; typedConfirmation="FORCE RELEASE"; reason=<operator-reason>
  SQLite: recovery phase=resolved; decision=force-released
    run=interrupted; Task=cancelled/discarded; activeRunId=null; lease=released
    permanent Force Release records=1; Task forcedRelease disposition present
  unresolvedFacts retained permanently:
    "The Worker has not proved the interrupted engine session stopped."
    "The interrupted run has no durable terminal settlement and no retained events."
  Force Release: actor=operator; affectedRunIds=[<force-run>]
    projectWorkspacePreserved=true; unrecycledTaskContext=true
  Host filesystem: Force Released Task context manifest remains; Project workspace present
  Web: release:force-released; workSafety=clear; permanent Force Release history visible
  Host: worker=connected; reachability=reachable; data=accessible

Stop isolated Core, reopen SQLite through a new read-only connection:
  Force Release records=1; run=interrupted; Task=cancelled; lease=released
  forcedRelease disposition present; workspacePreserved=true; unrecycledContext=true
```

The host diagnostic export reports local process, reachability, and data-access facts; it does not contain Task/lease decision fields. The accompanying host-local SQLite and filesystem inspections verify those durable outcomes. Host engine readiness remains honestly `unknown` because the diagnostic command does not run a readiness or inference probe. The foreground service state is `unknown`, not an invented installed service.

### AC5: validation, attempts, and limits

- Durable Agent regression: initial fixture attempts were corrected; the valid red result was `no-compatible-agent`, followed by green. Focused Task/admission checks passed **25/25**.
- Task recovery/history regression: **2/3** before the fix (`recovery` versus expected `resolved`), then focused router/recovery checks passed **9/9**. The later proof/refusal and injected-cleanup refinement passed **7/7**.
- Worker interruption regression: **9/10** before the fix (`failed` versus expected `interrupted`), then focused Worker/gateway/recovery checks passed **19/19**.
- Earlier split after the Agent fix: source **1635/1635**, Web **408/408**. The first typecheck caught an optional-property fixture error, which was corrected.
- Next full split: source **1633/1635**, with the two old recovery-contract expectations described above; Web **408/408**. Those failures were attributed to the changed proof requirement, not to #167 or reconnect retry.
- Final split after the last refinement: source **1635/1635**, Web **408/408**; `npm run typecheck` passed. Each test command used `npm test` with a timeout below the required maximum. These counters include the added durable-Agent regression.
- `src/worker/cli/worker-cli-recovery.test.ts` remains unchanged from `de1f6f9e`; `src/runtime-reconnect-retry-crash.test.ts` remains unchanged from `b9e77a6a`. No #167 or reconnect-crash failure occurred in these attempts. General reconnect-crash attribution remains **UNDETERMINED** per the recorded a43 classification.
- The preliminary Force Release probes included one naturally completed turn and one kill of only the wrapper, which left the actual Worker connected. Neither was counted as active-run disconnection evidence. Both were discarded normally; the final replay targeted the actual Worker PID and asserted running state before termination.
- Added-line privacy scans and `git diff --check` passed before each implementation commit. Raw state/logs stayed in private temporary storage; only normalized excerpts appear here.
- **Owner acceptance remains pending.** This Worker cannot record it on the owner's behalf. Windows/F5 and shutdown-drain/F8 work remain on their parallel branches.

**Round-3 disposition:** AC3's live chain and AC5's successful minimum-version Pi turn are evidenced. Exact attribution of attempt 1 remains limited by missing historical logs/model configuration, and owner acceptance remains pending; this record does not declare Ticket #111 accepted.
