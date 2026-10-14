# Ticket #235 — Human-supervised Windows acceptance checklist

This checklist is a future Windows-host execution plan, not Windows evidence. Run it on a real, Human-supervised Windows Worker host with the required CLIs installed and signed in. Do not substitute Wine, a container, CI emulation, or another simulated platform.

## Entry conditions

1. Check out the reviewed Ticket #235 commit and record its SHA. The code in that commit must include an accepted Windows descendant fence before starting OAR work. The current implementation requests `taskkill /T /F`, but `waitForProcessTreeStopped()` returns `false` on Windows, so it cannot prove the tree stopped or safely release a lease. Until that Windows implementation and its Windows process-tree test exist, record AC3 as blocked and stop before live cancellation, runner-exit, or replacement tests.
2. Confirm the host is Windows 11 and record the exact edition/build from `Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber`.
3. Confirm Node is at least 24, OAR is exactly 0.59.1, and record the installed Codex CLI and Pi CLI versions. The repository lock pins `@earendil-works/pi-coding-agent` 1.1.0; readiness floors are Codex 0.154.0 and Pi 0.86.1. Record actual values rather than inferring them from package metadata.
4. Confirm both native CLIs are installed and signed in through Sprout's authenticated, non-inference readiness probe. A missing CLI or login is an unmet prerequisite. Do not treat a successful version command as proof of authentication or model entitlement.
5. Before a Pi run, confirm the host Pi policy lease is clear and no OAR runner is live:

   ```powershell
   $agentLock = Join-Path $env:USERPROFILE '.pi\agent\.sprout-oar-policy'
   if (Test-Path $agentLock) { Get-Item $agentLock } else { 'no host agent lock held' }
   Get-CimInstance Win32_Process |
     Where-Object { $_.CommandLine -match 'oar-runner-entry' } |
     Select-Object ProcessId, ParentProcessId
   ```

   If another OAR Pi session owns the lease, wait for it to finish. Do not remove its lock.

## Version, package, and runner observations

Run from the reviewed checkout in PowerShell:

```powershell
node --version
npm.cmd --version
(Get-Content .\package.json -Raw | ConvertFrom-Json).engines.node
(Get-Content .\node_modules\@botiverse\oar\package.json -Raw | ConvertFrom-Json).version
$lock = Get-Content .\package-lock.json -Raw | ConvertFrom-Json
$lock.packages.'node_modules/@earendil-works/pi-coding-agent'.version
codex --version
pi --version
Test-Path .\src\engine\oar-runner-entry.ts
```

Expected: Node satisfies `>=24.0.0`; OAR is `0.59.1`; the Pi SDK lock entry is `1.1.0`; both CLI commands return their actual versions; the runner entry exists beside the shared OAR adapter. Also run the repository's scripted gate observation:

```powershell
npm.cmd test -- src/engine/oar-node-support.test.ts
```

Expected: the unsupported `23.4.0` input is refused before Message admission, with the actionable “Node.js 24+ is required by OAR … upgrade … before admitting work” guidance; no run, session, or runner is created. This is a scripted version-input observation, not evidence that Windows runs Node 23.

## Signed-in-user Worker service

Use the assigned review Core and an enrollment created for this Worker. Keep the claim secret on standard input when the CLI requests it; never put it in command arguments or captured output.

```powershell
node .\bin\sprout worker enroll <core-url> <enrollment-id>
node .\bin\sprout worker status
node .\bin\sprout worker install-service
node .\bin\sprout worker status
```

Approve the pending enrollment in Sprout with the `agent-run` capability. In Task Scheduler, inspect the task reported by `install-service` and record only sanitized properties: logon trigger, signed-in user context, `worker start --foreground` action, restart policy, and task state. Expected status is `connected`, a current epoch, protocol 3, and `service: installed and loaded`.

Force one Worker exit only after no run is active, then observe Task Scheduler restart and a fresh connection epoch. Finally remove the task and verify `service: not-installed`:

```powershell
node .\bin\sprout worker uninstall-service
node .\bin\sprout worker status
```

Capture command names, exit codes, sanitized status fields, and the task's relevant settings. Replace task names, user identities, paths, Core addresses, enrollment IDs, and epochs with placeholders in any repository or issue record.

## Readiness, authority, and Project access

1. Connect the authenticated Worker and request the ordinary Sprout readiness probe from Sprout Web: open **Environments**, select the enrolled Worker Environment, then click **Request Readiness Probe**. Capture separate facts for executable/version, authentication, model catalog or model availability, and adapter capability.
2. Confirm the probe and a reconnect do not create an Agent session, model turn, usage record, or run. The observed session count and usage count must remain unchanged until a Human sends a Message.
3. Have a Human explicitly authorize the selected Codex model and the selected Pi model. Capture the Human-approval provenance separately from measured readiness. For Codex, account entitlement may remain `unknown`; local catalog presence is not entitlement. For Pi, the probe does not claim a measured model catalog.
4. Grant the Project access to this Environment through the supported Project access surface. Confirm that revocation removes the grant and prevents later Project execution.

## Model-issued Codex journey

Configure one Project Agent for the installed Codex CLI, the Human-authorized model, `low` effort, and a Project instruction containing a harmless marker such as `PROJECT_RULE_MARKER`. Keep the current Windows host sandbox selection in effect.

1. From the Project conversation, send: `Remember the word VIOLET. Reply with only PONG.`
2. Capture the admitted run ID, streamed non-final progress, final `PONG` reply, positive prompt/completion usage, the selected model and effort, and the Project instruction marker observed by the session.
3. Send: `What word did I ask you to remember? Reply with only that word.` in the same conversation.
4. Capture the final `VIOLET` reply, the same conversation-scoped native session key being reused (record only whether it matches; never record its value), and the usage outcome.

Both turns must pass through the existing Runtime Message admission path on the authenticated enrolled Worker. Do not substitute a direct adapter call, mocked Worker, or protocol fixture for this journey.

## Model-issued Pi journey and configured storage compatibility

After the host Pi policy lease check above, configure one Project Agent for the host Pi provider/model and Human-authorized model. Use Project instructions that ask the model to remember `VIOLET`, reply `PONG`, and answer a later recall request. Keep Pi's built-in tools empty under the existing OAR policy.

1. Send the first request through Runtime Message admission and capture streaming, final `PONG`, selected model/effort/instructions, usage, and the conversation-scoped native key's presence without recording its value.
2. Reconnect the Worker, verify that reconnect caused no model turn, then send the recall request. Capture final `VIOLET` and confirmation that the same authorized conversation continued.
3. With an isolated test Project and a conversation that already has a saved key, copy the previously configured Pi session directory and leave the original untouched. Stop/uninstall the scheduled service for this Worker. In a dedicated PowerShell window, capture the current Pi host configuration variable locally without recording its value, create an isolated copy, and start the enrolled Worker in the foreground:

   ```powershell
   $hadPiSessionDirectory = Test-Path Env:SPROUT_PI_SESSION_DIR
   $previousPiSessionDirectory = $env:SPROUT_PI_SESSION_DIR
   $legacySource = Read-Host 'Previously configured Pi session directory'
   $isolatedCopy = Join-Path $env:TEMP ("sprout-pi-session-compat-" + (New-Guid).Guid)
   Copy-Item -LiteralPath $legacySource -Destination $isolatedCopy -Recurse
   $env:SPROUT_PI_SESSION_DIR = $isolatedCopy
   node .\bin\sprout worker start --foreground
   ```

   From Sprout Web, send a Message to that same test conversation. Expect one admitted run to fail with the configured-session-directory compatibility message before OAR creates a runner or Pi session; capture the run/admission result, confirm no usage was attributed, and verify the saved native key remains unchanged. Do not record the directory or key value. Stop the foreground Worker with Ctrl+C, then restore the original Pi configuration (`if ($hadPiSessionDirectory) { $env:SPROUT_PI_SESSION_DIR = $previousPiSessionDirectory } else { Remove-Item Env:SPROUT_PI_SESSION_DIR }`), delete only the temporary copy, and reinstall the service.
4. Inject a bounded startup failure through the `EngineAdapter`/`EngineSession` conformance seam. Run `npm.cmd test -- src/engine/oar-pi-policy.test.ts src/engine/oar.test.ts`; verify startup cleanup and that no session key is deleted or rewritten. Do not turn this into a second deployment gate or a new secret-intake path.

## Windows execution-tree, uncertainty, and Worker replacement

Run these only after the Windows descendant fence prerequisite at the top is implemented and accepted on Windows. Use the dedicated Windows process-tree test added with that implementation and capture its raw assertion results; the existing POSIX process-group test skips on Windows and cannot discharge this criterion.

For each scenario—Human cancellation during streamed output, runner parent exit with a surviving child, and Worker replacement at a newer enrollment epoch—capture:

- the runner and a deliberately long-lived descendant before termination;
- the OS-level fence action and independent observation that every descendant has stopped;
- the run's terminal/uncertain outcome and the recovery journal's `engineStopped` evidence;
- lease state before and after proof, showing that missing proof keeps the lease protected;
- replacement connection epoch, old-channel closure, and absence of automatic run replay.

Expected: ordinary release occurs only after observed tree termination or an established Windows fence; missing evidence remains uncertain and retains protection. A `taskkill` request or runner-parent exit alone is not proof. Do not describe this as an OS filesystem sandbox.

## Revocation, epoch, and closeout

1. Revoke the Worker enrollment. Confirm the Worker cannot reconnect, the previous epoch is non-authoritative, and the Project grant does not authorize another Worker or Environment.
2. Confirm the saved identity and native session key remain host-local and are not included in the evidence record.
3. Stop and uninstall the signed-in-user service only after all runs and recovery records are settled. Record the sanitized final `worker status` and Scheduled Task absence.
4. From the reviewed commit, run these PowerShell commands and record each exit code and pass/fail/skip count:

   ```powershell
   npm.cmd test -- src/engine/oar-node-support.test.ts src/worker/engine-selection.test.ts
   npm.cmd test -- src/engine/oar-live-pi.test.ts src/engine/oar-pi-policy.test.ts src/engine/oar.test.ts src/worker/engine-selection.test.ts src/host-config.test.ts
   npm.cmd run test:audit
   npm.cmd run test:quick
   npm.cmd run test:affected
   npm.cmd run typecheck
   .\node_modules\.bin\tsc --noEmit -p web/tsconfig.json
   git diff --check
   npm.cmd test
   ```

   The first command must observe unsupported-version refusal before Message admission and exercise Windows host selection. A passing test that simulates Windows facts is scripted evidence; it does not replace the real-host observations above. Record the full suite as incomplete if the repository deadline reports `timed_out`; never count a timeout as a pass. Record skipped macOS-only tests explicitly; a skip is not a Windows pass.

## Evidence capture map

| Ticket criterion | Required Windows observation |
| --- | --- |
| AC1 — versions, runner packaging, signed-in-user startup | Version command results, package/runner presence, Task Scheduler properties, connected status after install and restart |
| AC2 — Codex and Pi model-issued journeys | Two enrolled Runtime Message conversations per engine with instructions/model/effort, streaming, final reply, continuation, and usage |
| AC3 — cancellation, runner exit, replacement | Windows process-tree/fence test plus the three real Worker lifecycle observations and protected lease states |
| AC4 — readiness and Human authority | Probe/reconnect produce no inference; independent measured facts and Human-authorized models remain distinguishable |
| AC5 — Pi storage and native key | Compatibility refusal before session, saved-key preservation, successful same-conversation continuation, and startup cleanup |
| AC6 — enrollment, revocation, epoch, Project access, sandbox | Approval and Project grant, current host sandbox selection, revoke/reconnect refusal, epoch fencing |
| AC7 — evidence and repository checks | Sanitized command record and test counters with each row labelled model-issued, protocol-only, scripted, or source-only |

Record exact OS, Node, OAR, Pi SDK, Codex CLI, and Pi CLI versions; commands and exit codes; observed outcomes; and any prerequisite that remains unmet. Never publish host paths, private addresses, credentials, personal identities, or native session-key values.