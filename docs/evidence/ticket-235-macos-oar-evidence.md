# Ticket #235 — macOS and portable OAR evidence

This record covers the macOS host and platform portable checks. It does not establish Windows behavior. The supervised Windows checklist is [ticket-235-windows-supervised-checklist.md](ticket-235-windows-supervised-checklist.md).

## Tested version scope

- Platform: macOS `27.0.1` (build `26A434`), from `sw_vers -productVersion` and `sw_vers -buildVersion`.
- Node.js: `v26.11.1`; npm: `11.20.0` (`node --version`, `npm --version`). `package.json` requires `>=24.0.0`; `package-lock.json` repeats the same root engine requirement.
- OAR: `@botiverse/oar` `0.59.1`, exact in `package.json` and observed in the shared package manifest. `src/engine/oar.ts` also identifies `0.59.1` as its source version.
- Pi SDK: `@earendil-works/pi-coding-agent` `1.1.0`, pinned in `package-lock.json`.
- Native CLIs: Codex CLI `0.159.3` and Pi CLI `1.2.0` (`codex --version`, `pi --version`). They are host installations; these are the exact versions exercised, not versions installed by the repository lockfile.
- Readiness floors in `src/worker/readiness.ts`: Codex `0.154.0`, Pi `0.86.1`.

The runner entry exists at `src/engine/oar-runner-entry.ts`; the live model-issued journeys below opened OAR sessions through that runner. Production Worker selection in `src/worker/engine-selection.ts` selects the shared OAR adapter for Codex and Pi, forwards the selected executable paths, and retains Codex `read-only` selection on a host. No `SPROUT_USE_OAR_ENGINE` gate remains under `src/`.

## Model-issued journeys

| Engine | Evidence class | Observed result |
| --- | --- | --- |
| Codex | model-issued | `AC2: Live Codex Message continuation through an authenticated enrolled Worker` in `src/engine/oar-live-codex.test.ts` passed in the 5/6 file run. The test creates a Worker identity, requests and approves enrollment with `agent-run` and explicit Human model authorization, connects through the authenticated enrollment transport, and sends both turns through Runtime Message delivery. It observed Project instructions, the live model, `low` effort, incremental output, final `PONG`, positive prompt/completion usage from OAR `0.59.1`, and a continuation reply of `VIOLET` using the same conversation key. Readiness had installed/authenticated true while measured model availability remained unknown beside the explicit Human authorization. The session-start counter stayed unchanged through readiness and reconnect. The test also interrupted a live third turn and checked lease state against the recorded certainty/termination evidence. |
| Pi | model-issued | `AC2: Bounded live macOS Pi Message-to-reply demonstration through the enrolled path` in `src/engine/oar-live-pi.test.ts` passed in the 6/6 file run and the final 158/158 composition run. The authenticated enrolled Worker handled a Runtime Message, observed Project instructions/model/effort, streamed progress, returned `PONG`, and recorded positive usage. After Worker reconnect, readiness caused no session start; a second admitted Message recalled `VIOLET`, reused the same conversation-scoped native key, and retained the OAR usage classification. A third live turn was interrupted and its lease state was checked against certainty and process termination. |

These tests use Sprout's real Runtime Message admission, enrollment, Worker, OAR adapter, and native model turns. Their Core runtime and stores are isolated test instances; they are not a deployment against an external persistent Core.

A supplemental direct Codex MCP test is a remaining limitation. `AC8 & AC4 (F4): Bounded live macOS Codex execution discovers and invokes controlled MCP workspace tool through OAR` failed in the Codex file run, quick tier, and affected tier: the expected remote read callback was not invoked (`false !== true`). A preceding captured run reported that Codex said the workspace read needed approval while the session used `approvalPolicy: never`. This was a direct adapter conformance turn, not either enrolled Message journey. The host `read-only` sandbox was preserved; no broader permission setting was introduced.

## Version gate, readiness, and service startup

| Claim | Evidence class | Observation |
| --- | --- | --- |
| Unsupported Node is refused before work admission | scripted | `npm test -- src/engine/oar-node-support.test.ts src/worker/engine-selection.test.ts` passed 21/21. The Worker process ran Node `26.11.1`; a test-only preload supplied the unsupported `23.4.0` version fact to the production gate. Attempts to claim `24.0.0` through deployment environment input did not change that fact. The observation asserted the actionable Node 24+ refusal, no admitted run, no run-store write, no saved session key, and no OAR runner spawn. This proves the gate with a scripted version fact, not with an installed Node 23 binary. See `src/engine/oar-node-support.test.ts:29` and `src/worker/readiness.ts:564-599`. |
| Readiness and Human model authority remain separate | model-issued, scripted | The Codex live journey observed `installed=true`, `authenticated=true`, and `modelAvailability=unknown` beside a separate explicit Human model authorization. The Pi enrolled test counted session starts before and after readiness and reconnect. `src/worker/readiness.ts` applies the Node check to OAR runtimes without an environment gate. |
| Signed-in-user startup path | scripted | `node ./bin/sprout worker install-service` installed the real macOS LaunchAgent. `node ./bin/sprout worker status` reported `reconnecting`, protocol 3, `installed and loaded`, and “the Worker connection could not be established.” `uninstall-service` removed it; a second status returned `stopped`, protocol 3, `not-installed`, restoring the initial service state. No model turn was sent; after uninstall, `pgrep -fl oar-runner-entry` had no matches and the Pi policy directory was absent. The CLI service test also checks the foreground Worker action and LaunchAgent registration (`src/worker/cli/worker-cli-setup-status.test.ts:159`). |

The service registration and signed-in-user process startup ran on macOS, but the configured Core was unreachable. A live connected service, readiness receipt from that service, and restart-after-exit observation remain blocked on a reachable authenticated Core endpoint. No model turn was sent; after uninstall, `pgrep -fl oar-runner-entry` had no matches and the Pi policy directory was absent.

## Process proof, Pi storage, and authority preservation

| Claim | Evidence class | Observation |
| --- | --- | --- |
| macOS descendant termination and uncertainty | scripted, model-issued | The final composition suite passed 158/158, including the real child-process test `runner parent death leaves a surviving descendant visible until the process-group fence kills it` (`src/engine/oar.test.ts:946`) and the injected non-cooperative runner test that keeps recovery fenced when stop evidence is missing (`src/engine/oar.test.ts:1615`). The Codex and Pi enrolled journeys separately interrupted progressing model turns and checked lease retention/release against certainty and termination evidence. |
| Configured Pi session storage and native key preservation | scripted, model-issued | The 158/158 composition run passed both custom `sessionDirectory` refusal tests (`src/engine/oar.test.ts:293-309`) and the Pi policy spawn-failure restoration test (`src/engine/oar-pi-policy.test.ts:125`). The live Pi enrolled continuation reused the same authorized conversation key; its value was compared in-process but never logged or recorded. This covers the configured-storage refusal and cleanup on macOS, not Windows. |
| Enrollment, revocation, epoch, Project access, and sandbox | model-issued, protocol-only | Both live enrolled tests approve `agent-run` and a Human-selected model; the Project access grant was active at admission; Codex asserted the current host sandbox is `read-only` (`src/engine/oar-live-codex.test.ts:70-130`). Protocol tests in `src/environment/enrollment.test.ts`, `src/environment/enrollment-restart.test.ts`, and `src/worker/gateway-identity-epoch.test.ts` passed in the affected run, including revoked reconnect refusal and old-identity fencing. These checks do not describe an OS filesystem sandbox. |
| Windows process-tree proof | source-only | Windows evidence was not run. `waitForProcessTreeStopped()` returns `false` on Windows, and the existing POSIX descendant test explicitly skips there (`src/engine/oar.ts:887-891`, `src/engine/oar.test.ts:946-949`). A Windows fence implementation and real Windows process-tree evidence remain prerequisites. |

## Verification results

- Composition command `npm test -- src/engine/oar-live-pi.test.ts src/engine/oar-pi-policy.test.ts src/engine/oar.test.ts src/worker/engine-selection.test.ts src/host-config.test.ts`: **158 passed, 0 failed**, about 43 seconds. One earlier composition attempt failed the live stale-binding Pi conformance test; the isolated Pi file rerun passed 6/6 and both final composition reruns passed 158/158. The cause of that first failure was not established.
- `npm run test:audit`: **308 files**, missing 0, extra 0, duplicate 0.
- `npm run test:quick`: **2,230 passed, 1 failed** of 2,231; the failure was the direct Codex MCP read callback test described above.
- `npm run test:affected`: **2,242 passed, 1 failed** of 2,243; the same direct Codex MCP test failed.
- `npm run test:affected`: **2,242 passed, 1 failed** of 2,243; the same direct Codex MCP test failed.
- `npm run typecheck`: **not passed**. It stopped on the two recorded baseline diagnostics in `scripts/scratch/post-project-test-message.ts`: line 24 TS2741 and line 34 TS2353. The chained web check therefore did not run.
- `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json`: passed separately with exit code 0.
- Full `npm test`: **incomplete**. The repository's 175-second deadline reported `timed_out` after 2,216 partial results (2,215 pass, 1 fail). The timeout record marks candidates unproven; no causal attribution is made.
- `git diff --check`: passed with no output.

## Limits

Windows remains unverified because no real supervised Windows host, Windows CLI installation/login, or Windows descendant-fence implementation was available. A Windows skip, source declaration, simulated platform fact, or Unix process-group result does not discharge its criteria. The macOS LaunchAgent was exercised but could not connect because the configured Core was unreachable. The supplemental Codex MCP operation did not invoke its read callback. No native session-key value, credential, host path, personal identifier, or infrastructure address is recorded here.

Evidence classes are kept distinct: **model-issued** means a live native model turn through Runtime Message admission; **protocol-only** means enrollment/authority protocol behavior without inference; **scripted** means a controlled test or command observation without claiming a model-issued product journey; **source-only** means inspection of implementation or declarations without platform execution.
