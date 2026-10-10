# Ticket #252 — Host-run composition evidence

**Scope:** final verification ticket for #225. This record reports observations from the verification lane; it does not accept or close #225.

**Test platform:** macOS. Installed engine CLIs observed in this session: Pi `1.1.0`, Codex CLI `0.159.3`, Claude Code CLI `2.1.294`.

**Work-session constraint:** do not launch any other agent from this job.

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

## Prior scope evidence and known limits

- Ticket #248's accepted amendment explicitly leaves the Codex model-facing host-authority exclusion prerequisite unresolved. It does not claim broader host isolation or unblock production Host-run adoption.
- Ticket #249's accepted amendment records an earlier Codex full run and a minimal read probe that completed with zero model-issued Sprout tool calls. That is not conformance evidence. The current run must be observed independently.
- Ticket #251 and `docs/research/claude-host-run-conformance.md` contain the prior Claude model-issued fixture result. This ticket will report only scenarios run in this verification attempt as new live evidence.

## Unsupported paths and boundaries

- The existing Pi isolation probe is pinned to Pi `1.0.4`; the installed Pi CLI `1.1.0` is outside that probe's accepted version.
- This session has not established Pi readiness or any Pi model-issued operation.
- No private service endpoint, port, credential, account identity, or local home path is recorded here.
