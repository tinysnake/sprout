# Ticket #235 — macOS and portable OAR evidence

This record covers the macOS host and platform portable checks. It does not establish Windows behavior. The supervised Windows checklist is [ticket-235-windows-supervised-checklist.md](ticket-235-windows-supervised-checklist.md).

## Tested version scope

- Platform: macOS `27.0.1` (build `26A434`), from `sw_vers -productVersion` and `sw_vers -buildVersion`.
- Node.js: `v26.11.1`; npm: `11.20.0` (`node --version`, `npm --version`). `package.json` requires `>=24.0.0`; `package-lock.json` repeats the same root engine requirement.
- OAR: `@botiverse/oar` `0.59.1`, exact in `package.json` and observed in the shared package manifest. `src/engine/oar.ts` also identifies `0.59.1` as its source version.
- Pi SDK: `@earendil-works/pi-coding-agent` `1.1.0`, pinned in `package-lock.json`.
- Native CLIs: Codex CLI `0.159.3` and Pi CLI `1.2.0` (`codex --version`, `pi --version`). They are host installations; these are the exact versions exercised, not versions installed by the repository lockfile.
- Readiness floors in `src/worker/readiness.ts`: Codex `0.154.0`, Pi `0.86.1`.

The runner entry exists at `src/engine/oar-runner-entry.ts`; the live model-issued journeys below opened OAR sessions through that runner. Production Worker selection preserves native Codex/Pi by default and selects OAR only through `SPROUT_USE_OAR_ENGINE=codex|pi|all`. The selected Codex host sandbox remains `read-only`. OAR Pi uses the bundled Pi SDK; the host Pi executable path is used by native Pi selection and readiness probes, not passed as an OAR executable installation.

## Model-issued journeys

| Engine | Evidence class | Observed result |
| --- | --- | --- |
| Codex | model-issued | `AC2: Live Codex Message continuation through an authenticated enrolled Worker` in `src/engine/oar-live-codex.test.ts` passed in the 6/6 file run. The test explicitly opts in to OAR through the production Worker selection, creates a Worker identity, requests and approves enrollment with `agent-run` and explicit Human model authorization, connects through the authenticated enrollment transport, and sends both turns through Runtime Message delivery. It observed Project instructions, the live model, `low` effort, incremental output, final `PONG`, positive prompt/completion usage from OAR `0.59.1`, and a continuation reply of `VIOLET` using the same conversation key. Readiness had installed/authenticated true while measured model availability remained unknown beside the explicit Human authorization. The session-start counter stayed unchanged through readiness and reconnect. The test also interrupted a live third turn and checked lease state against the recorded certainty/termination evidence. |
| Pi | model-issued | `AC2: Bounded live macOS Pi Message-to-reply demonstration through the enrolled path` in `src/engine/oar-live-pi.test.ts` passed in the 7/7 file run and 160/160 composition run. The authenticated enrolled Worker handled a Runtime Message through the OAR Pi opt-in, observed Project instructions/model/effort, streamed progress, returned `PONG`, and recorded positive usage. After Worker reconnect, readiness caused no session start; a second admitted Message recalled `VIOLET`, reused the same conversation-scoped native key, and retained the OAR usage classification. A third live turn was interrupted and its lease state was checked against certainty and process termination. |

These tests use Sprout's real Runtime Message admission, enrollment, Worker, OAR adapter, and native model turns. Their Core runtime and stores are isolated test instances; they are not a deployment against an external persistent Core.

The supplemental direct Codex MCP experiment established a product limitation under the current host policy. With the production host selection's `read-only` sandbox, the controlled Worker-origin remote workspace read callback was not invoked (`false !== true`). The gate's controlled experiment changed only that adapter's sandbox literal to `danger-full-access` and the callback test passed; the Codex file now passes 6/6 with that adapter-level conformance configuration. The production host selection remains `read-only`. This is a limitation of the OAR Codex path under the selected host sandbox, not merely a fixture mismatch and not evidence of an OS network restriction. The adapter conformance test exercises the bridge with a reachable sandbox and does not claim the production read-only path can invoke it. The enrolled Runtime Message journey continues to assert the host's current sandbox selection.

## Version gate, readiness, and service startup

| Claim | Evidence class | Observation |
| --- | --- | --- |
| Unsupported Node is refused before work admission | scripted | `npm test -- src/engine/oar-node-support.test.ts` passed 2/2. Read-only host discovery found an installed Node `22.23.3`; the Worker process ran on that actual executable with only the syntax flag needed by the test module. No preload replaced `process.versions.node`, and no `SPROUT_NODE_VERSION` input is used. The test observed the actionable Node 24+ refusal through an authenticated Worker and Runtime Message, no admitted run, no run-store write, no saved session key, and no OAR runner spawn. See `src/engine/oar-node-support.test.ts` and `src/worker/readiness.ts`. |
| Readiness and Human model authority remain separate | model-issued, scripted | The Codex live journey observed `installed=true`, `authenticated=true`, and `modelAvailability=unknown` beside separate explicit Human model authorization. The Pi enrolled test counted session starts before and after readiness and reconnect. `src/worker/readiness.ts` applies the Node floor only when Codex/Pi are selected for OAR (or for the always-OAR Claude runtime). |
| Signed-in-user startup path | scripted | A locally reachable in-memory Core test runtime was stood up, and an actual macOS LaunchAgent installed through `worker install-service` connected to it. `worker status` reported `connected`; the Core observed the authenticated Worker and a readiness receipt. The LaunchAgent was uninstalled, status returned `stopped` / `not-installed`, the isolated state was removed, and no runner or Pi policy lease remained. No model turn was sent. The CLI service test also checks the foreground Worker action and LaunchAgent registration (`src/worker/cli/worker-cli-setup-status.test.ts:159`). |

The local Core service journey now completed on macOS. It used an in-memory test Core and did not establish deployment persistence or restart-after-exit behavior. Windows service startup remains unobserved and blocked on a real supervised Windows host.

## Process proof, Pi storage, and authority preservation

| Claim | Evidence class | Observation |
| --- | --- | --- |
| macOS descendant termination and uncertainty | scripted, model-issued | The final composition suite passed 160/160, including the real child-process test `runner parent death leaves a surviving descendant visible until the process-group fence kills it` (`src/engine/oar.test.ts:946`) and the injected non-cooperative runner test that keeps recovery fenced when stop evidence is missing (`src/engine/oar.test.ts:1615`). The Codex and Pi enrolled journeys separately interrupted progressing model turns and checked lease retention/release against certainty and termination evidence. |
| Live Worker replacement and revocation | scripted | The new scenario in `src/engine/oar-live-pi.test.ts` connected an authenticated Worker, replaced it with a second Worker at a higher enrollment epoch, confirmed the first connection was no longer current, then revoked the live enrollment and observed reconnect refusal with the `revoked` category. It did not issue a model turn for these lifecycle observations. |
| Configured Pi session storage through admission | scripted | The same scenario delivered a Runtime Message through the authenticated enrolled OAR Pi Worker. The Message was admitted; the selected adapter observed and raised the configured session-directory refusal, and the Core reported session-start failure without creating a session key. Readiness was explicitly scripted for this fault scenario. |
| Enrollment, Project access, and sandbox | model-issued, protocol-only | Both live enrolled tests approve `agent-run` and a Human-selected model; the Project access grant was active at admission; Codex asserted the current host sandbox is `read-only` (`src/engine/oar-live-codex.test.ts`). Protocol tests in `src/environment/enrollment.test.ts`, `src/environment/enrollment-restart.test.ts`, and `src/worker/gateway-identity-epoch.test.ts` cover additional protocol-only revocation/reconnect and old-identity fencing. These checks do not describe an OS filesystem sandbox. |
| Windows process-tree proof | source-only | Windows evidence was not run. `waitForProcessTreeStopped()` returns `false` on Windows, and the existing POSIX descendant test explicitly skips there (`src/engine/oar.ts:887-891`, `src/engine/oar.test.ts:946-949`). A Windows fence implementation and real Windows process-tree evidence remain prerequisites. |

## Verification results

- `npm test -- src/engine/oar-live-codex.test.ts`: **6 passed, 0 failed**. The adapter MCP conformance fixture uses `danger-full-access` so the controlled bridge read is reachable; production selection remains `read-only`. The controlled `read-only` experiment did not invoke the Worker-origin MCP read callback (`false !== true`), establishing a product limitation for the selected sandbox configuration. This is not hidden by the fixture and is not evidence of an OS network restriction.
- `npm test -- src/engine/oar-live-pi.test.ts`: **7 passed, 0 failed**.
- Composition command `npm test -- src/engine/oar-live-pi.test.ts src/engine/oar-pi-policy.test.ts src/engine/oar.test.ts src/worker/engine-selection.test.ts src/host-config.test.ts`: **160 passed, 0 failed**.
- Focused Node support, engine selection, and readiness tests: **39 passed, 0 failed**. The Node refusal used the discovered Node `22.23.3` executable, not an injected version fact.
- `npm run test:quick`: **2,231 passed, 0 failed**.
- `npm run test:affected`: **2,243 passed, 0 failed**.
- `npm run test:audit`: **308 files**, missing 0, extra 0, duplicate 0.
- `npm run typecheck`: **not passed**. It stopped on exactly the two baseline diagnostics in `scripts/scratch/post-project-test-message.ts`: line 24 TS2741 and line 34 TS2353. The chained web check therefore did not run.
- `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json`: passed separately with exit code 0.
- Full `npm test`: **incomplete**. The repository's 175-second deadline reported `timed_out` after 2,117 partial results (2,117 pass, 0 fail). The timeout record marks candidates unproven; no causal attribution is made.
- `git diff --check`: passed with no output.

## Limits

Windows remains unverified because no real supervised Windows host, Windows CLI installation/login, or Windows descendant-fence implementation was available. A Windows skip, source declaration, simulated platform fact, or Unix process-group result does not discharge its criteria. The macOS LaunchAgent was exercised but could not connect because the configured Core was unreachable. The supplemental Codex MCP operation did not invoke its read callback. No native session-key value, credential, host path, personal identifier, or infrastructure address is recorded here.

Evidence classes are kept distinct: **model-issued** means a live native model turn through Runtime Message admission; **protocol-only** means enrollment/authority protocol behavior without inference; **scripted** means a controlled test or command observation without claiming a model-issued product journey; **source-only** means inspection of implementation or declarations without platform execution.
