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

## Acceptance matrix

The seven original criteria are tracked in the final work record on #252. This evidence file will be updated after each bounded engine scenario and before proceeding to the next one.

| Engine | No-Environment conversation | Remote read/edit/test | stdio/HTTP/editor tools | Stale binding | Context restoration | Interruption/recovery | Task lifecycle | Host read/write denial, no fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pi | Blocked before model turn | Not run | Not run | Not run | Not run | Not run | Not run | Not evidenced in this attempt |
| Codex | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Claude Code | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

## Prior scope evidence and known limits

- Ticket #248's accepted amendment explicitly leaves the Codex model-facing host-authority exclusion prerequisite unresolved. It does not claim broader host isolation or unblock production Host-run adoption.
- Ticket #249's accepted amendment records an earlier Codex full run and a minimal read probe that completed with zero model-issued Sprout tool calls. That is not conformance evidence. The current run must be observed independently.
- Ticket #251 and `docs/research/claude-host-run-conformance.md` contain the prior Claude model-issued fixture result. This ticket will report only scenarios run in this verification attempt as new live evidence.

## Unsupported paths and boundaries

- The existing Pi isolation probe is pinned to Pi `1.0.4`; the installed Pi CLI `1.1.0` is outside that probe's accepted version.
- This session has not established Pi readiness or any Pi model-issued operation.
- No private service endpoint, port, credential, account identity, or local home path is recorded here.
