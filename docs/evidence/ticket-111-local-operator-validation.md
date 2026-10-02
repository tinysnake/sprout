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

The existing readiness evidence documents Codex `0.154.0` and Pi `0.86.1` as the pinned probe contracts. The installed CLIs on this host were newer. Their exact versions are reported above; this run does not claim a successful Agent turn on the documented pins.

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

The active-run disconnect, retained Worker evidence, recovery reconciliation, normal recovery decision, and Force Release were **not** exercised live. The Pi run failed before a recognized turn outcome, and Task begin was refused as described above. No durable recovery or Force Release result is claimed. The product-path #167 journal tests and the reconnect crash-window test are automated evidence only.

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
- **F2 — pinned engine readiness versus turn execution:** installed Codex/Pi CLIs were newer than the referenced probe pins. The authorized Pi run failed before a recognized turn outcome, and the selected Codex model was unavailable. Obtain the pinned CLIs or have the owner accept a revised pin, then repeat AC2/AC3 on a successful run path.
- **F3 — Core restart reconnect:** after the isolated Sprout restart, the Worker retained its old local connected epoch and needed an explicit LaunchAgent kickstart before the Core accepted a new epoch. Verify and correct automatic same-identity reconnect after a graceful Core restart.
- **F4 — Project Agent eligibility mismatch:** proposal-backed Task begin returned `no-compatible-agent` after compatibility reported an available Pi option. Reconcile the Task admission and compatibility projections before repeating Task-held recovery and Force Release.
- Full active-run disconnect, retained evidence synchronization, normal recovery, and Force Release remain live acceptance gaps. Automated #167 and recovery tests do not substitute for those host observations.
- The direct `npm test` summary discrepancy needs a reproducible explanation even though the combined `npm run test` and separated source/Web baselines pass.

**Disposition:** Partial. Mac enrollment, service, diagnostics, Project workspace, restart persistence, and production code checks are evidenced. AC3 recovery/Force Release and Windows live exercise remain pending; owner acceptance is pending.
