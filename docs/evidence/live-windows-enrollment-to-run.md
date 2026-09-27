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
