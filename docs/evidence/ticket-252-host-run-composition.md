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

| Scenario | Actual result | Evidence |
| --- | --- | --- |
| No-Environment baseline conversation | **Blocked before model turn.** `scripts/probe-pi-host-turn.ts` reported `host-pi-readiness-unavailable`; installation, authentication, model availability, and adapter controls were all `unknown`. No Pi session was started. | Command: `node scripts/probe-pi-host-turn.ts` |
| Host isolation preflight | **Blocked before model turn.** `scripts/probe-pi-host-isolation.mjs` reported `fixture-or-isolation-prerequisite-failed` at `platform`. The installed Pi CLI is `1.1.0`; this existing probe requires exactly `1.0.4`. | Command: `node scripts/probe-pi-host-isolation.mjs` |
| Remote read/edit/test, MCP, Task lifecycle, and recovery | Not run in this attempt. | `scripts/probe-pi-host-run-task.ts` is available; no evidence from it is claimed here. |

The Pi results are blockers, not passes. They establish neither model-issued host isolation nor a Host-run Message/Task outcome for the installed Pi profile.

### Codex

| Scenario | Actual result | Evidence |
| --- | --- | --- |
| Full origin-sensitive model-issued run | **Incomplete after one bounded run.** The readiness probe reported installation, authentication, model availability, adapter controls, and dynamic tool support ready. The app server accepted the required workspace and Project MCP tool catalog, but the completed model turn issued **zero** workspace or Project MCP calls. The remote file remained `REMOTE_BEFORE`; both same-name host sentinels remained byte-identical; no sentinel read attempt occurred. | Command: `SPROUT_HOST_CODEX_MODEL=gpt-6.1-sol SPROUT_HOST_CODEX_CONFORMANCE_MODE=full node scripts/codex-host-conformance.ts`; Codex CLI `0.159.3`, macOS `sandbox-exec`. |

The model emitted 73 message events and 3 notices, then completed without using the accepted dynamic tools. The run recorded 12,600 prompt tokens and 49 completion tokens; billing basis was `unknown` and provider cost estimate was `unavailable`. This is not a pass and does not establish denied host reads/writes or no fallback. The attempt was not retried. The separate #248 host-authority prerequisite remains unresolved.

### Claude Code

| Scenario | Actual result | Evidence |
| --- | --- | --- |
| Origin-sensitive model-issued remote operation | **Passed for this bounded fixture.** Claude Code `2.1.294` completed a model-issued run on macOS. It read the selected remote marker, called the approved stdio Project MCP tool with that marker, edited the remote proof file, then attempted one parent traversal. The Worker refused the traversal as `invalid-path`; both remote proof files matched; the sentinel adjacent to the selected Worker workspace remained unchanged; the run lease was released. | Command: `node scripts/claude-host-conformance.mjs`; evidence tier `model-issued`; elapsed `14,428 ms`. |

The run reported 1,962 prompt tokens and 283 completion tokens. It did **not** exercise HTTP MCP, a local Sprout-host sentinel, denied host writes, no-fallback behavior, stale binding, context restoration, interruption/recovery, Task lifecycle, or a mode-changing restart. Those outcomes are not inferred from this pass.

## Acceptance matrix

The seven original criteria are tracked in the final work record on #252. This evidence file records each bounded engine scenario before proceeding to another one.

| Engine | No-Environment conversation | Remote read/edit/test | stdio/HTTP/editor tools | Stale binding | Context restoration | Interruption/recovery | Task lifecycle | Host read/write denial, no fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pi | Blocked before model turn | Not run | Not run | Not run | Not run | Not run | Not run | Not evidenced in this attempt |
| Codex | Not run | No operations issued | Catalog accepted; no tool called | Not run | Not run | Not run | Not run | Not evidenced; no sentinel read attempt |
| Claude Code | Not run | Model-issued remote read/edit; no command test | stdio Project MCP passed; HTTP/editor not run | Not run | Not run | Not run | Not run | No local host read/write attempt; no fallback proof |

## Repository verification

- `npm run typecheck` exited `0` after the Settings test change.
- Inventory audit: 322 default-suite files partitioned into 242 `src/` files and 80 `web/src/` files; partitions had 0 overlap, 0 missing files, and 0 extras.
- `npm test -- 'src/**/*.test.ts'` (180-second command timeout): 242 files, 1,966 passed, 0 failed, 42,187 ms.
- `npm test -- 'web/src/**/*.test.ts'` (180-second command timeout, after the two-direction Settings test change): 80 files, 517 passed, 0 failed, 142,285 ms.
- Combined: 322 files, 2,483 passed, 0 failed, matching the stated baseline at `feb40a3b2`.
- The targeted Settings DOM run after its change passed 18/18 tests in 20,436 ms; it is also included in the final Web partition.
- `src/execution-mode.test.ts` covers argument parsing and refusal before host configuration/database setup. `src/task/environment-lifecycle.test.ts` covers SQLite placement/lease preservation and mismatch refusal before Task advancement. `src/web/views.test.ts`, `web/src/modules/tasks/tasks.dom.test.ts`, and `web/src/modules/settings/settings.dom.test.ts` cover placement projections, mismatch presentation, and read-only mode refresh behavior.

## Acceptance assessment

1. **Startup modes and Settings reconnect — verified for the composed service/API/browser path.** The actual service forwarded both explicit values, omission returned to Environment-hosted, the same temporary database and authenticated Settings session survived restarts, and the browser test refreshed the displayed mode in both directions. The live service database did not contain a Task or Agent Run.
2. **Three-engine composed acceptance matrix — incomplete.** The single bounded Claude Code scenario completed remote read/edit/stdio-MCP and Worker traversal refusal. Pi was blocked before a turn; Codex completed with zero tool calls. HTTP MCP, editor operations, stale-binding denial, context restoration, interruption/recovery, and Task lifecycle were not run as one model-issued matrix across all engines in this attempt.
3. **Mode-changing restart and lifecycle — deterministic checks passed, live Task composition incomplete.** The test suite covers persisted placement and held leases across SQLite restart and refuses mismatched Task advancement without changing the lease. This attempt did not restart the live service with a seeded Task or exercise every mismatch control through real engines.
4. **Model-issued isolation and no fallback — unmet.** No current-run evidence proves denied Sprout-host reads and writes across the three engines. Codex issued no remote operation; Pi did not start; Claude's traversal denial was enforced by the Worker workspace boundary and was not a Sprout-host filesystem denial. The Codex production host-authority prerequisite in #248 remains unresolved. A timeout or an untouched sentinel is not a denial proof.
5. **Operational views and truthful usage — repository projection checks passed; live matrix partial.** The views keep process mode, recorded placement, Engine host profile, Work Environment, and mismatch reason distinct. The Codex run reported `unknown` billing basis and `unavailable` cost estimate; no billed cost is claimed. The Claude run reported token counts only.
6. **Prior-ticket ownership and scope docs — preserved.** This branch adds final acceptance evidence, clarifies the Host Engine readiness term, records the current limitation in ADR-0016, updates the roadmap feature scope, and strengthens the Settings reconnect test. It does not replace prior adapter or Runtime implementations. #225 remains open and untouched.
7. **Required checks and bounded engine scenarios — repository checks passed; feature acceptance remains unmet.** The commands and each live outcome are recorded above. `git diff --check feb40a3b2..HEAD` is recorded in the final work record after the final commit.

## Prior scope evidence and known limits

- Ticket #248's accepted amendment explicitly leaves the Codex model-facing host-authority exclusion prerequisite unresolved. It does not claim broader host isolation or unblock production Host-run adoption.
- Ticket #249's accepted amendment records an earlier Codex full run and minimal read probe with zero model-issued Sprout tool calls. This verification made one new bounded full run; the catalog was accepted, but the model again issued zero workspace or Project MCP calls.
- Ticket #251 and `docs/research/claude-host-run-conformance.md` contain prior Claude evidence. The new Claude run recorded here is a separate bounded fixture outcome and does not expand that evidence to host-sentinel denial or the full lifecycle matrix.
- The prompt named `scripts/codex-host-conformance.mjs`; the repository's existing harness is `scripts/codex-host-conformance.ts`. The existing TypeScript harness was reused without adding a replacement.

## Unsupported paths and boundaries

- Pi `1.1.0` readiness was unknown, and the existing Pi isolation probe accepts only Pi `1.0.4`; no Pi model turn or isolation claim is made.
- Codex CLI `0.159.3` had ready local profile facts and an accepted dynamic catalog, but no model-issued tool calls. No Codex remote operation or host read/write denial is claimed. Production Host-run Codex remains gated by #248.
- Claude Code CLI `2.1.294` passed only remote read/edit/stdio-MCP and Worker path traversal refusal on macOS. HTTP MCP, editor tools, local Sprout-host read/write denial, stale binding, context restoration, interruption/recovery, Task lifecycle, and Windows isolation remain unevidenced by this run.
- The Claude fixture's enrolled Worker had no remote engine facts and still completed the model-issued operation. That demonstrates no remote model-engine login requirement for this specific Claude fixture only.
- No private service endpoint, port, credential, account identity, or local home path is recorded here. The Human's normal service invocation was not changed.
