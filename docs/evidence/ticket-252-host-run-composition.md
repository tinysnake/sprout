# Ticket #252 — Host-run composition evidence

**Scope:** final verification ticket for #225. This record reports observations from the verification lane; it does not accept or close #225.

**Test platform:** macOS. Installed engine CLIs observed in this session: Pi `1.1.0`, Codex CLI `0.159.3`, Claude Code CLI `2.1.294`.

**Work-session constraint:** do not launch any other agent from this job.

## Service startup and Settings reconnect

- Started the actual service with `npm start -- --execution-mode environment-hosted`, restarted the same service with `npm start -- --execution-mode host-run`, and restarted with `npm start` omitting the argument. The observed process modes were `environment-hosted -> host-run -> environment-hosted`.
- All three starts reopened the same temporary SQLite database. One authenticated Settings session was kept across restarts; an authenticated `GET /api/operator/settings` after each restart reported the new effective mode. The omission after Host-run returned to Environment-hosted.
- The temporary service database contained its schema and the operator session, not a seeded Task or Agent Run. Placement and lease retention across mode changes are covered by the existing SQLite lifecycle scenarios in `src/task/environment-lifecycle.test.ts`; this startup run does not claim live Task placement retention.
- Strengthened the Settings DOM reconnect scenario to change the reported mode in both directions. The displayed mode moved from Environment-hosted to Host-run and back after reconnect, became stale offline, and exposed no browser mutation control. Targeted `npm test -- 'web/src/modules/settings/settings.dom.test.ts'`: 18 tests passed, 0 failed.

## Live scenario results

### Pi

| No-Environment baseline conversation | **Completed one bounded turn after the product readiness fix.** The trusted product facts were ready for installation, authentication, exact model availability, and adapter controls. The final response was exactly `PONG`; no Environment or remote tools were attached. | Inline product-adapter harness: 60-second turn bound; completed in 2,178 ms with 656 prompt and 6 completion tokens. It printed 2 message events, `exactPong: true`, and `streamedPong: false`. |
| Product readiness diagnosis | **A genuine product defect was found and fixed.** Under the installed Pi CLI `1.1.0`, product readiness had returned all facts `unknown` even though its pinned SDK package root existed. The sandboxed child exited before structured output because a runtime dependency was omitted from its file-read allowlist. | Red/green `npm test -- 'src/engine/pi-host.test.ts'`: 8 passed / 1 failed before the fix; 9 passed / 0 failed after. Product readiness after the fix: status `ready`, installation `ready`, authentication `ready`, model availability `available`, adapter controls `ready`, SDK version `1.0.4`. |
| Host isolation preflight | **Blocked by a probe-only version check; not rerun.** The round-one disposable probe requires Pi CLI `1.0.4`, while the installed CLI is `1.1.0`. This does not describe the product readiness path: the product loads its own pinned SDK `1.0.4` and does not query the Pi CLI version. | Round-one command: `node scripts/probe-pi-host-isolation.mjs`; result `fixture-or-isolation-prerequisite-failed` at `platform`. |
| Remote read/edit/command, stdio/HTTP Project MCP, and Task lifecycle | **Passed in one bounded model-issued Host-run Task.** The model read and edited the authorized workspace file, ran the bounded `node --version` command check, called the approved stdio and HTTP Project MCP tools once each, and safely ended the Task after completion. This is not a repository test suite run. | `node scripts/probe-pi-host-run-task.ts`: `model-issued-host-run-task-passed`; run completed; all five operations completed with expected inputs, matching workspace bindings, and the Task lease active; command and both MCP outputs matched; five authorized HTTP MCP requests used the configured fixture authorization; the Task returned to idle after the run, the claim was accepted, the lease was released, and the edited workspace file persisted. |
| Stale binding, editor tools, context restoration, and interruption/recovery | Not run. The Pi Task probe does not exercise these scenarios. | No evidence claimed. |

The product chain is: configured Pi profile → `createProductionHostPiAdapter` → `HostPiEngineAdapter.readiness` → a sandboxed `pi-host-runner.mjs` readiness child. The product detects the SDK under its pinned `1.0.4` release package root, then checks that package version, configured authentication, exact model availability, and adapter controls in the child. The child statically imports `pi-runner-events.ts`, which imports `environment/privacy.ts`, which imports `environment/iana-tlds.ts`. `isolationProfile` allowed `privacy.ts` but omitted `iana-tlds.ts`; the child hit a sandbox permission denial before producing structured output. `runProbeChild` then rejected, and the outer catch in `probeHostPi` returned `unknown` for every fact. A temporary diagnostic profile adding only the missing module read rule returned all four readiness facts true. The committed fix adds that dependency to the product's allowlist, and the regression assertion failed before the fix and passed after it.

This resolves the Pi question as a product defect, not a probe-only issue. It was a sandbox dependency omission, not a failure caused by CLI `1.1.0`. The post-fix baseline turn verifies only a no-Environment conversation; it does not establish model-issued host isolation or a Host-run Message/Task outcome.

### Codex

| Scenario | Actual result | Evidence |
| --- | --- | --- |
| Full origin-sensitive model-issued run | **Incomplete after one bounded run.** The readiness probe reported installation, authentication, model availability, adapter controls, and dynamic tool support ready. The app server accepted the required workspace and Project MCP tool catalog, but the completed model turn issued **zero** workspace or Project MCP calls. The remote file remained `REMOTE_BEFORE`; both same-name host sentinels remained byte-identical; no sentinel read attempt occurred. | Command: `SPROUT_HOST_CODEX_MODEL=gpt-6.1-sol SPROUT_HOST_CODEX_CONFORMANCE_MODE=full node scripts/codex-host-conformance.ts`; Codex CLI `0.159.3`, macOS `sandbox-exec`. |

The model emitted 73 message events and 3 notices, then completed without using the accepted dynamic tools. The run recorded 12,600 prompt tokens and 49 completion tokens; billing basis was `unknown` and provider cost estimate was `unavailable`. This is not a pass and does not establish denied host reads/writes or no fallback. The attempt was not retried in round one. **Round two disposition: Codex was not attempted.** Ticket #249's accepted limitation documents seven rounds with the same catalog-accepted, zero-dynamic-tool-call outcome; round one reproduced it, and another run of the same approach with a different model would not be a materially different verification. No new Codex evidence is claimed. The separate #248 host-authority prerequisite remains unresolved.

### Claude Code

| Scenario | Actual result | Evidence |
| --- | --- | --- |
| Origin-sensitive model-issued remote operation | **Passed for this bounded fixture.** Claude Code `2.1.294` completed a model-issued run on macOS. It read the selected remote marker, called the approved stdio Project MCP tool with that marker, edited the remote proof file, then attempted one parent traversal. The Worker refused the traversal as `invalid-path`; both remote proof files matched; the sentinel adjacent to the selected Worker workspace remained unchanged; the run lease was released. | Command: `node scripts/claude-host-conformance.mjs`; evidence tier `model-issued`; elapsed `14,428 ms`. |

The run reported 1,962 prompt tokens and 283 completion tokens. It did **not** exercise HTTP MCP, a local Sprout-host sentinel, denied host writes, no-fallback behavior, stale binding, context restoration, interruption/recovery, Task lifecycle, or a mode-changing restart. Those outcomes are not inferred from this pass.

## Acceptance matrix

The seven original criteria are tracked in the final work record on #252. This evidence file records each bounded engine scenario before proceeding to another one.

| Engine | No-Environment conversation | Remote read/edit/test | stdio/HTTP/editor tools | Stale binding | Context restoration | Interruption/recovery | Task lifecycle | Host read/write denial, no fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pi | Bounded PONG baseline turn completed | Model-issued Task remote read/edit/command check completed; command was `node --version`, not a repository test suite | stdio and HTTP Project MCP calls completed; editor tools not run | Not run | Not run | Not run | Bounded Task completed safely; lease released and workspace persisted | Not evidenced; no Sprout-host file operation attempt |
| Codex | Not run | No operations issued | Catalog accepted; no tool called | Not run | Not run | Not run | Not run | Not evidenced; no sentinel read attempt |
| Claude Code | Not run | Model-issued remote read/edit; no command test | stdio Project MCP passed; HTTP/editor not run | Not run | Not run | Not run | Not run | No local host read/write attempt; no fallback proof |

## Repository verification

- `npm run typecheck`: passed, exit 0 after the Pi sandbox allowlist fix.
- Inventory audit against the declared default globs `src/**/*.test.ts` and `web/src/**/*.test.ts`: 322 files partitioned into 242 `src/` and 80 `web/src/`; 0 overlap, 0 duplicates, 0 missing, and 0 extras. Three `scripts/*.test.ts` files are outside the default suite.
- `npm test -- 'src/engine/pi-host.test.ts'`: 8 passed / 1 failed before the fix on the new allowlist assertion; after the fix, 9 passed, 0 failed.
- `npm test -- 'src/**/*.test.ts'` (180-second command timeout): 242 files, 1,966 passed, 0 failed, 41,585 ms.
- `npm test -- 'web/src/**/*.test.ts'` (180-second command timeout): 80 files, 517 passed, 0 failed, 113,064 ms.
- Combined: 322 files, 2,483 passed, 0 failed, matching the baseline at `80f02d0a7`.
- The targeted Settings DOM run from round one passed 18/18 tests and remains included in the Web partition.
- `node scripts/probe-pi-host-run-task.ts` (180-second command bound): `model-issued-host-run-task-passed`, run status `completed`; remote read, edit, and bounded command check (`node --version`) plus stdio and HTTP Project MCP each completed once with expected inputs, matching bindings, and the Task lease active. The command check was not a repository test suite. The Task returned to idle after the run, its completion claim was accepted, the lease was released, and the edited Project workspace file persisted. The fixture confirmed the expected HTTP authorization on five requests with one tool call and no mismatches.
- `src/execution-mode.test.ts` covers argument parsing and refusal before host configuration/database setup. `src/task/environment-lifecycle.test.ts` covers SQLite placement/lease preservation and mismatch refusal before Task advancement. `src/web/views.test.ts`, `web/src/modules/tasks/tasks.dom.test.ts`, and `web/src/modules/settings/settings.dom.test.ts` cover placement projections, mismatch presentation, and read-only mode refresh behavior.

## Acceptance assessment

1. **Startup modes and Settings reconnect — verified for the composed service/API/browser path.** The actual service forwarded both explicit values, omission returned to Environment-hosted, the same temporary database and authenticated Settings session survived restarts, and the browser test refreshed the displayed mode in both directions. The live service database did not contain a Task or Agent Run.
2. **Three-engine composed acceptance matrix — incomplete.** Pi completed a no-Environment baseline turn and a separate bounded Host-run Task with model-issued remote read/edit/command, stdio/HTTP Project MCP, and safe Task completion. The command check was `node --version`, not a repository test suite. Claude completed its bounded remote read/edit/stdio-MCP and Worker traversal-refusal fixture. Codex issued zero dynamic workspace/Project MCP calls. Editor tools, stale-binding denial, context restoration, and interruption/recovery remain unrun; the required matrix was not completed across all three engines.
3. **Mode-changing restart and lifecycle — deterministic checks passed; live Task composition is partial.** `src/task/environment-lifecycle.test.ts` verifies SQLite placement/lease preservation across restart and refusal of mismatched Task advancement without changing the lease. The Pi model-issued Task returned to idle after the run, held its Task lease throughout all five operations, accepted its bounded completion claim, released the lease, and preserved the edited workspace file. This attempt did not restart the live service with a seeded Task or exercise no-replay reconciliation, deliberately authorized new work, every mismatch control, or Human cleanup/emergency controls live.
4. **Model-issued isolation and no fallback — unmet.** No current-run evidence proves denied Sprout-host reads and writes across the three engines. Pi's baseline conversation had no host-file operation; Codex issued no remote operation; Claude's traversal denial was enforced by the Worker workspace boundary and was not a Sprout-host filesystem denial. The Codex production host-authority prerequisite in #248 remains unresolved. A timeout or an untouched sentinel is not a denial proof.
5. **Operational views and truthful usage — repository projection checks passed; live matrix partial.** The views distinguish process mode, recorded placement, Engine host/profile readiness, Work Environment, and mismatch reason. Live usage evidence is limited to Pi's 656 prompt / 6 completion tokens (billing basis not established), Codex's 12,600 / 49 tokens with billing basis `unknown` and cost estimate `unavailable`, and Claude's 1,962 / 283 tokens. No billed cost is claimed; usage for the missing model-issued operations is unavailable.
6. **Prior-ticket ownership and scope docs — preserved with one narrow verification repair.** This branch updates final acceptance evidence and strengthens the Settings reconnect test. The verification also repairs the Host Pi sandbox allowlist's missing runtime import and adds a regression assertion; it does not replace the prior adapter or Runtime implementation. Existing glossary, ADR-0016, and roadmap updates remain in scope. #225 remains open and untouched.
7. **Required checks and bounded engine scenarios — repository checks passed; feature acceptance remains unmet.** The commands and each live outcome are recorded above. `git diff --check 80f02d0a7..HEAD` is recorded in the final work record after the final commit.

## Prior scope evidence and known limits

- Ticket #248's accepted amendment explicitly leaves the Codex model-facing host-authority exclusion prerequisite unresolved. It does not claim broader host isolation or unblock production Host-run adoption.
- Ticket #249's accepted amendment records seven rounds of the same Codex zero-model-issued-tool-call limitation. Round one of #252 made one additional full run and reproduced it; this round made no Codex attempt because no materially different verification approach was available. The limitation remains named and is not waived.
- Ticket #251 and `docs/research/claude-host-run-conformance.md` contain prior Claude evidence. The new Claude run recorded here is a separate bounded fixture outcome and does not expand that evidence to host-sentinel denial or the full lifecycle matrix.
- The prompt named `scripts/codex-host-conformance.mjs`; the repository's existing harness is `scripts/codex-host-conformance.ts`. The existing TypeScript harness was reused without adding a replacement.

## Unsupported paths and boundaries

- Pi product readiness now succeeds on the installed CLI `1.1.0` host because the adapter uses its separate pinned SDK package `1.0.4`; no Pi CLI-version compatibility claim is made. The disposable isolation probe's CLI `1.0.4` pin remains a probe limitation and its isolation scenario was not run again. The bounded no-Environment turn and one Host-run Task completed, but model-issued Sprout-host read/write denial, editor tools, stale binding, context restoration, interruption/recovery, and a repository test command through the remote workspace remain unevidenced.
- Codex CLI `0.159.3` reported ready profile facts and an accepted dynamic catalog on the round-one run, but the model issued no dynamic tool calls. No round-two or round-three attempt was made because #249's seven-round history and the prior #252 result provide no materially different verification approach; no Codex remote operation or host read/write denial is claimed. Production Host-run Codex remains gated by #248.
- Claude Code CLI `2.1.294` passed only remote read/edit/stdio-MCP and Worker path traversal refusal on macOS. HTTP MCP, editor tools, local Sprout-host read/write denial, stale binding, context restoration, interruption/recovery, Task lifecycle, and Windows isolation remain unevidenced by this run.
- The Claude fixture's enrolled Worker had no remote engine facts and still completed the model-issued operation. That demonstrates no remote model-engine login requirement for this specific Claude fixture only.
- No private service endpoint, port, credential, account identity, or local home path is recorded here. The Human's normal service invocation was not changed.
