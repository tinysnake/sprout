# Live Windows enrollment-to-run evidence

The Windows enrollment-to-run journey is tracked in #122 (E8). This document
records the sanitized live observations from that journey and the pi-engine
addendum: versions, commands, outcomes, and — explicitly — limitations. It
contains no private host, user, path, network, or credential data; hosts are
`<windows-host>` / `<core-host>`, users are `<operator>`, and identifiers keep
only their public prefixes.

Two sessions produced the evidence:

- The **main E8 journey** on the real Windows 11 host over the operator-managed
  private network (defects #153–#158 found and fixed en route).
- The **pi-engine addendum** (defects #160/#161 found and fixed), ending in a
  completed Agent run on the enrolled Windows environment.

The fixes landed on `m113-integration` (top `115c5f18`), squash-merged into
master as `f5b71ec9` (PR #163). This document was verified against master
`4b572b5a`: `npm test` 1491 pass / 0 fail, `npm run typecheck` clean,
`npm run web:build` succeeds.

## Environment

| Fact | Value |
| --- | --- |
| Host OS | Windows 11 Pro (`NT 10.0.26200.0`), reported by the host and by the running Agent |
| Engine | pi `0.87.1` on the Windows host |
| Core | review instance of this repository, reachable at `ws://<core-host>:<port>` |
| Transport | Worker-initiated WS/WSS on the operator-managed private network (ADR-0012); SSH is only the operator's host-control channel, never the enrollment or runtime protocol |
| Worker | the E3 CLI (`sprout worker ...`) running in the signed-in user's session |

## Commands actually exercised (sanitized)

```sh
# Enroll: identity generation + proof, claim secret supplied on stdin
# (never as an argv argument, so it never enters shell or process history)
sprout worker enroll ws://<core-host>:<port> enroll-<id>

# Run and inspect the Worker in the signed-in user's session
sprout worker start
sprout worker status
sprout worker reset --yes
```

On the host side, a logon-triggered Scheduled Task named `<worker-task>` was
registered manually by the operator (PowerShell `Register-ScheduledTask`,
`-AtLogOn`) and driven with `schtasks /Run` / `schtasks /End` cycles, interleaved
with `Get-CimInstance Win32_Process` checks that the `worker start` process
returned after each restart and after a forced `Stop-Process` kill.

The Web journey used the production surfaces: pending enrollment claimed,
proved, inspected, and approved; readiness probe committed (requirement revision
`rf2d38180`); model authorization recorded on the enrollment (revision
`r19196459`); Task begin with a lease; run `run-mujbj9of-660f7d30` with work
option `{engine: pi, workModel: <provider>/<model>, configurationVersion: 5}`.

## Outcomes

- **Enrollment completed live on Windows**: identity generated and persisted
  host-locally, proof verified, approval observed, Worker connected and admitted
  dynamically without a core restart or a runtime JSON edit for the connection
  path itself.
- **`worker start` reached a connected state on Windows** and survived Task
  stop/start and forced-kill cycles, returning under the logon task each time.
- **A real Pi Agent run settled on the enrolled Windows environment**:
  `run-mujbj9of-660f7d30` completed; the Agent queried the host live and
  reported Windows 11 Pro and pi 0.87.1. The review verdict is recorded on #122.
- **Readiness probes stayed non-inference** throughout (ADR-0013); probes
  committed and reported over the same neutral Worker JSON-RPC as on macOS.

### Defects found and fixed on the journey

| Ticket | Defect | Disposition |
| --- | --- | --- |
| #153 | Server refusal reasons sanitized away by `diagnosticOf()`; `where.exe` localized stderr noise | **Open** (follow-up; includes removing a temporary `DEBUG-E8` line in `worker-cli.ts`) |
| #154 | POSIX mode check always failed on Windows (`isRestrictive`) — ACL-based restriction helper added | Closed after acceptance |
| #155 | Endpoint scheme: the operator-selected `ws`/`wss` was not honored | Closed |
| #156 | Process-identity probe had no win32 branch — `start` refused | Closed after acceptance |
| #157 | Directory fsync unsupported on win32 — platform-aware `syncDirectory` | Closed |
| #158 | Readiness command execution through npm `.cmd`/`.bat` shims | Closed |
| #159 | Web-created enrollments carry `capabilityRequests: []`, so no shipped surface can ever become catalog-eligible | **Open** (follow-up; interim manual config amendment recorded on the review instance) |
| #160 | Provider-scoped model ids corrupted by the identifier boundary | Closed after acceptance |
| #161 | cmd.exe could not carry the run prompt in argv — pi prompt moved to stdin on win32 | Closed after acceptance |
| #162 | Catalog eligibility projection not republished after restart; terminal-Task recovery deadlock leaves the instance Red | **Open** (follow-up; records resolved manually on the review instance) |

## Limitations

These are the honest boundaries of this evidence; none of them is claimed as
passing:

1. **`install-service` / `uninstall-service` on Windows (resolved in #164).**
   Previously macOS-only; #164 delivered and live-verified the product-managed
   logon Scheduled Task lifecycle on the Windows 11 host (see #164 addendum below).
2. **Sleep / logoff / logon transitions were not exercised.** Only Scheduled
   Task stop/start and forced process-kill cycles were, so the offline /
   reconnecting / recovery behavior across a real logon cycle and sleep is
   **not yet evidenced**; likewise unsafe-lease-reassignment absence across
   those transitions was not observed live.
3. **Capability and model authorization needed a manual amendment.** #159 means
   no shipped surface requests `agent-run` capability, so the review instance's
   approval/authorization gap was closed by a recorded manual configuration
   amendment — no auto-grant exists in the product, and the Human-approval
   requirement itself was honored, but the "no runtime data edit" clause of
   #122's admission acceptance depends on fixing #159.
4. **#162 defects were found and resolved out of band.** The stale catalog
   projection and the terminal-Task recovery deadlock were worked around
   manually on the review instance to finish the verification; they are filed
   with acceptance of their own.
5. **The Agent's in-run self-report was vague** (read-only verification attempts
   inside the run failed), so host versions above come from the host probes and
   the run output, not from the Agent's narrative.
6. **One review instance, one host, one successful run.** No second Windows
   host, no Windows Server target (explicitly out of scope in #122).

## Links

- E8 ticket and review verdict: #122
- macOS counterpart: `live-macos-enrollment-to-run.md`
- ADRs: ADR-0012 (enrollment-backed Worker channel), ADR-0013 (non-inference
  readiness), ADR-0008/ADR-0009 (Windows 11 floor, signed-in-user boundary)

## #164 addendum: product-managed Windows Scheduled Task service registration

On the live Windows 11 host (`Microsoft Windows NT 10.0.26200.0`, PowerShell 7.6.6, Node v24.21.0), verified the product-managed Scheduled Task lifecycle delivered in #164.

### Commands and live observations (sanitized)

1. **Install service**:
   ```sh
   sprout worker install-service
   ```
   Output:
   ```text
   Installed Scheduled Task dev.sprout.worker.<hash>. It starts at sign-in and restarts after an unexpected exit.
   ```
   Exit code: 0.

2. **Verify Scheduled Task properties and logon trigger**:
   Queried Task Scheduler via `Get-ScheduledTask -TaskName dev.sprout.worker.<hash>`:
   ```json
   {
       "TaskName": "dev.sprout.worker.<hash>",
       "State": "Running",
       "TriggerType": "MSFT_TaskLogonTrigger",
       "TriggerUser": "<domain>\\<user>",
       "ActionExecute": "C:\\Program Files\\nodejs\\node.exe",
       "ActionArguments": "\"C:\\<repo-path>\\bin\\sprout\" worker start --foreground",
       "ActionWorkingDir": "C:\\Users\\<user>",
       "RestartCount": 3,
       "RestartInterval": "PT1M",
       "StartWhenAvailable": true,
       "ExecutionTimeLimit": "PT0S",
       "DisallowStartIfOnBatteries": false,
       "StopIfGoingOnBatteries": false
   }
   ```
   Verified:
   - Supervised process runs the foreground reconnect loop: `worker start --foreground` (no identity secrets or claim material in argv/action).
   - Logon trigger (`-AtLogOn`) bound to the signed-in interactive user session (`<domain>\<user>`).
   - Settings specify `RestartCount: 3`, `RestartInterval: PT1M` (1 minute), `StartWhenAvailable: true`, and `ExecutionTimeLimit: PT0S` (unbounded execution time).
   - Battery-run policy configured (`DisallowStartIfOnBatteries: false`, `StopIfGoingOnBatteries: false`).

3. **Check status projection**:
   ```sh
   sprout worker status
   ```
   Output:
   ```text
   state: connected
   epoch: <epoch>
   protocol: 3
   service: installed and loaded
   ```
   Exit code: 0. Truthfully reports `state: connected` with active gateway connection epoch and `service: installed and loaded`.

4. **Forced process kill and recovery**:
   Killed the active worker process (`taskkill /F /PID <pid>`).
   Immediate status query:
   ```text
   state: stopped
   protocol: 3
   service: installed and loaded
   ```
   Task Scheduler `schtasks /Run /TN dev.sprout.worker.<hash>` cycle re-invoked the action; the Worker reconnected outbound to Sprout Gateway with a fresh epoch (`epoch: <epoch+1>`), and status returned to:
   ```text
   state: connected
   epoch: <epoch+1>
   protocol: 3
   service: installed and loaded
   ```

5. **Uninstall service**:
   ```sh
   sprout worker uninstall-service
   ```
   Output:
   ```text
   Removed Scheduled Task dev.sprout.worker.<hash>.
   ```
   Exit code: 0.
   Task absent from Task Scheduler (`Get-ScheduledTask` returns empty).
   Follow-up `status` query reports:
   ```text
   state: stopped
   protocol: 3
   service: not-installed
   ```
   A repeated `uninstall-service` reports honestly:
   ```text
   Scheduled Task dev.sprout.worker.<hash> was not installed.
   ```
   Exit code: 0.

## Session-lifecycle and parity addendum (rounds 2–3: #159, #164, #165, #166, #167, #168)

This addendum records the live evidence that closed the original journey's
session-lifecycle limitations. Integration merges: `9042530a` (#159),
`bb33978e` (#166), `766d3858` (#167); full suite `1549 passed / 0 failed` with
`npm run typecheck` clean at the integration head. The deployed build on
`<windows-host>` was verified by content hash of the changed modules.

### Sleep — true S4 hibernation

- Early suspension attempts bounced within seconds (device wake-armed); a real
  S4 sleep via `shutdown /h` produced a sustained unreachability window of
  roughly ten minutes against probes, with paired kernel sleep/resume events
  (resume markers `42`/`107`, wake-timer restoration, and a clock-resync
  `Kernel-General` entry on resume).
- An in-flight run froze for **86 seconds** across the S4 boundary
  (journal iterations `…:42` → `…:08+86s`) and then continued to completion —
  **no replay, no duplicate turns**; the lease stayed `active` with no
  reassignment (no sweeper ran, so nothing unsafe could occur).
- The Worker channel survived the S4 cycle on the same socket and epoch. The
  core showed stale-`online` during the freeze: the gateway has **no
  heartbeat/keepalive**, so silence alone never flips the connection state —
  recorded as a known behavior, not claimed as passing.

### Scheduled Task restart and forced kill

- At a 1-second sampling cadence: `schtasks /End` → `never-connected`/red
  within 1–2 s (fail-closed `stopped` local state per #166); `schtasks /Run` →
  `online`/green within 1–4 s; a forced `taskkill /F` produced the same
  fail-closed transition, task `Ready` (no auto-restart), and reconnection
  within seconds of the next `/Run`. Epochs advanced across every reconnect.
- Observed task results: `0x4` (`refused`), `0x40010004`
  (`SCHED_S_TASK_TERMINATED`, session end), `0x41301` (`SCHED_S_TASK_RUNNING`
  while alive). No exit `13` occurred after #167's connector fix.

### Recovery journal: defect #167 and its live proof

- Before the fix, recovery `recovery-mu…` stayed `phase: recovery` /
  `evidenceSynchronized: false` for over twelve hours (channel-lost cause,
  interrupted decisions repeating) because the product foreground serve path
  never built the `WorkerRecoveryJournal`.
- On the first reconnect with the fixed build: `phase: resolved`,
  `evidenceSynchronized: true`, `unresolvedFacts: []`, turn settlement and
  engine-session stop observed, `workSafety` back to `held`, readiness
  `online`/`green`. This is the pre-/post-fix contrast that closes #122's
  retained-evidence reconciliation parity item.

### Supersession and remote close: defect #168 and its live proof

- A same-identity competing connection was accepted at a newer epoch; the
  gateway closed the product channel, and the product Worker **recorded
  `reconnecting` and re-dialed to a new epoch** instead of dying: a 400 ms
  local-status poll captured `connected → reconnecting (~2 s) → connected
  (new epoch)` twice, with the competing connection closed `{"closed":true}`
  by the newer epoch each time; the task remained running throughout
  (`0x41301`).
- The pre-fix non-settling behavior reproduces deterministically: with only
  the connector change reverted to the pre-#167 content, the focused recovery
  suite fails with `timed out waiting for retained Worker settlement…` /
  `timed out waiting for idle Task recovery reached resolved phase`; with the
  fix in place the full suite is `1549/0`. (The revert was restored
  immediately; the worktree was left clean.)

### Logoff → logon cycle

- `logoff` ended the interactive session hosting the Worker: the process was
  gone within a second, the core flipped `online` → `never-connected`/red
  ("Lease recovery is required") within 1 s, `workSafety` entered
  `recovery`, and the task reported `0x40010004` then `Ready`. No lease
  reassignment occurred during the outage.
- A fresh interactive logon fired the task's `MSFT_TaskLogonTrigger`: the task
  entered `Running`, the Worker connected at a **new epoch**, and the core
  returned to `online`/`green` with `workSafety: held` and every recovery
  record `resolved` — the logon-opened recovery auto-resolved.

### Revocation finale (macOS parity)

- `POST …/revoke` returned `status: revoked`; the local CLI reported
  `state: revoked` with `the Worker enrollment was refused` (task result
  `0x4`); the core readiness reported `never-connected`/red with
  `Enrollment is revoked; a fresh reset and Human approval are required.`
  — byte-for-byte parity with `live-macos-enrollment-to-run.md`.
- The protection record opened at revocation remained `recovery` with the
  lease held: after revocation nothing may reconnect, so the state stays
  protected until a fresh reset and Human approval, and no automatic
  reassignment is possible. State, identity, and config under
  `%USERPROFILE%\.sprout\worker\` were preserved.

### Runs across the cycles

- Two real runs bracketing the sleep/restart cycles completed and settled
  (`run-mu…` with 60 journal lines across the 6-second sleep attempt, and
  40 lines across the 86-second S4 freeze), single-attempt, **no replay**.

### Updated limitations

1. `install-service`/`uninstall-service`: **resolved in #164** (see that
   addendum; the original limitation above is retained as history).
2. Sleep / logoff / logon: **resolved by this addendum** (both exercised
   live, with no unsafe lease reassignment and no automatic run replay).
3. Capability/model authorization: **resolved by #159 plus the shipped
   claim/approve flow** — round 2 rotated the session through reset → claim →
   approve with model authorizations over the product surfaces only, with no
   runtime JSON edit.
4. **#162 remains open** (stale catalog projection and terminal-Task recovery
   deadlock were resolved out of band on the review instance).
5. The single-host limit stands: one Windows 11 host, one review instance.
6. New honest notes: no gateway heartbeat (stale-`online` under silence);
   the first sleep attempts bounce on wake-armed devices; the local runtime
   record is not rewritten when a session kill ends the process, so
   core-side state is authoritative for that window.
