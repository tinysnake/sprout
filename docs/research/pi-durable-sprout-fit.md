# Pi Durable: relevance to Sprout

## Recommendation

Treat Pi Durable as a candidate runtime behind a new Worker-owned engine adapter, and as a reference for durable execution design. Do not replace Sprout's product state, Task authority, Environment leases, or recovery protocol with its internal task scheduler. An isolated feasibility prototype is useful; production adoption is not yet justified by this document.

The strongest opportunity is better execution evidence and a programmable agent runtime for long conversations, tools, and subordinate conversations. The strongest integration constraint is that Pi Durable resumes pending execution while Sprout deliberately requires interrupted work to remain stopped and reconciled.

This is a source-based assessment, not a runtime benchmark or an integration test. No runtime dependency or product decision is changed.

## Sources and baseline

Upstream was inspected at commit `eb326d265ae0b88489a6d10319307780df827cdf`. Its durable package declares version `1.0.4`, MIT licensing, and Node `>=22.19.0`. The package README explicitly says that it is experimental and its API changes without notice between releases. The article announces it alongside Pi 1.0, but that release milestone does not imply that Pi Durable is stable. [P1, P2, P4]

Sprout was inspected at commit `de1f6f9e801c907474a5658b6f0fb464e90b1f79`, with particular attention to the engine port, Pi adapter, Worker server, recovery journal, domain model, ADRs, and roadmap. The roadmap's M2-O4 already records live recovery evidence; this assessment does not assume Sprout lacks durable recovery merely because the README describes an older implementation slice. [S1–S7]

The Context7 documentation lookup failed with `fetch failed`. Findings were verified against the directly retrieved first-party article, README, package manifest, and normative specification instead.

## What Pi Durable actually provides

Pi Durable is a library for building agent applications. It shares model access through `pi-ai` with the terminal coding agent, but it does not replace the terminal coding agent or add transparent durability to every existing CLI engine. A Harness owns storage and runs conversations, model generations, tool calls, and application-defined durable tasks. Its documents use Chord. [P1, P2]

| Capability | Verified behavior | Boundary |
| --- | --- | --- |
| Persistent execution | Tasks checkpoint their state; reopening storage reconciles unfinished tasks, and enabling scheduling continues them. | Execution recovery is not proof of external side-effect completion. |
| Submission deduplication | Reusing a `requestId` in the same conversation returns the existing submission. | It does not make arbitrary shell commands or external operations exactly once. |
| Tool recovery | Tool intent is committed before execution. Only replay-safe calls rerun after interruption; omitted `replay` means `unsafe`. | An unsafe interrupted call may already have changed the external world. The model receives an interrupted result, rather than the runtime automatically repeating that call. |
| Conversation concurrency | One Harness supports concurrent conversations and forks from transcript entries. | It does not assign Sprout Project memberships or scarce Environment leases. |
| Observable progress | Views, watches, and experimental agent events derive from committed state; new viewers get a current snapshot. | Default partial/output commit intervals are 100 ms. Uncommitted progress can be lost, and watches are not a substitute for Sprout's acknowledged recovery outbox. |
| Long conversation context | Background compaction summarizes older entries, which remain stored. | A generation can still wait if its next request would exceed the context limit. |
| Application state | Typed JSON documents can change atomically with transcript entries and internal tasks. | Atomicity is within the Harness commit, not automatically across Sprout's separate database or external tools. |
| Tools and execution environments | Tools use an execution-environment interface. A Node implementation is included; remote implementations are possible. | An environment abstraction alone is not an access-control or sandbox guarantee. |
| Subordinate agents | An application can create task-owned conversations and make delegation restart-safe. | There is no built-in Sprout-style multi-agent collaboration or governance model. |

These behaviors are documented in the article, README, and normative specification. [P1–P3]

## Durability limits that matter

1. **Scheduling is explicit, but easy to activate inadvertently.** `Harness.open()` does not dispatch handlers. However, `resume()`, `submit()`, `compact()`, `abort()`, submission waits, task waits, and idle waits enable scheduling. Read-only inspection, statuses, views, and watches do not. Avoiding an explicit `resume()` call alone is insufficient to keep recovered work stopped. [P3, section around lines 619–650]
2. **External effects need their own idempotency or reconciliation.** An interruption between a shell command's effect and its final stored result remains uncertain. A replay policy controls runtime behavior; it does not roll back the command. The article's payment example supplies an external idempotency key and an application-defined refund handler. [P1, P2, P3]
3. **Stopping the foreground is not stopping all work.** Ordinary conversation abort leaves background tasks and their owned work running. The documented `{ background: true }` option includes background work. Cancellation of a wait only cancels that wait. The adapter must establish that all relevant execution and child processes have stopped. [P2]
4. **One process owns a storage instance.** Upstream supplies no cross-process locking. A Sprout deployment must preserve single ownership and fence superseded owners; a reconnecting Worker must not open the same store concurrently with its predecessor. [P2]
5. **Storage durability has a failure boundary.** The Node SQLite adapter uses WAL with `synchronous = NORMAL`: commits survive process crashes, but the latest commits may be lost on power or host failure. JSONL offers an `fsync: true` mode. Memory storage is not persistent. A database-independent recovery claim must not hide these differences. [P2]
6. **Experimental API and events require a pinned integration.** Upstream package version `1.0.4` does not remove the README's experimental warning. Production migration and compatibility guarantees would remain Sprout's responsibility. [P2, P4]

## Fit with Sprout's existing architecture

At the time of this research, Sprout's `PiEngineAdapter` started one CLI process per turn, consumed JSON events, and continued later runs through an engine session key. Ticket #236 has since retired that Environment Worker adapter in favor of the shared OAR adapter. The common engine port still deliberately hides provider protocols, and Host-run Pi remains on its separate `pi-host.ts` path. [S1, S2]

The Worker already journals run events and settlement evidence with sequence acknowledgements, guards recovery epochs, and retains uncertainty about an unfenced predecessor. On channel shutdown, the Worker closes the sessions it owns. These are product recovery and execution-ownership responsibilities that a Pi Durable store would complement rather than eliminate. [S3, S4]

A plausible integration seam is:

```text
Sprout Core / product database
  Project, Agent, Task, authority, leases, Agent-run admission, recovery outcomes
             |
      existing Worker protocol
             |
Environment Worker
  authenticated identity, ownership/fencing, recovery outbox, engine readiness
             |
  candidate Pi Durable EngineAdapter
             |
Pi Durable Harness / separate host-local execution storage
  conversations, generations, tools, checkpoints, transcript, engine usage
             |
Environment-owned tools and model credentials
```

This diagram proposes a boundary, not an implementation commitment. The Harness should initially stay on the Environment host, where Sprout already places engine execution and credentials. Running a centralized Harness with remote tools is technically possible upstream, but would require a separate decision about credential ownership and Sprout's established Worker seam. [P1, P2, S5]

There is no verified drop-in compatibility for existing Pi CLI session files, coding-agent extensions, local authentication stores, or readiness probes. Pi Durable uses its own registry and storage interfaces. Those compatibility questions must be measured before replacing the current adapter. [P2, S1]

## Where it would help

| Sprout need | Potential contribution | What remains Sprout-owned |
| --- | --- | --- |
| Explain an interrupted Agent run | Committed tool intent, progress, interrupted results, and internal task state provide richer evidence. | Cross-Worker evidence synchronization, old-process fencing, Human recovery, and run disposition. |
| Mobile/desktop observation and reconnect | Committed snapshots and deltas can supply an engine detail view without reconstructing everything from transient stdout. | Browser authentication, product projections, redaction, transport, and recovery acknowledgements. |
| Long-running work across many Agent runs | Persistent conversations and compaction can preserve engine context while limiting active context size. | Task content versions, blockers, pause/resume, validation, and the Task-held lease. |
| Programmable specialist agents | Named tools, hooks, model selection, and task-owned conversations offer a useful embedded runtime. | Project permissions, Agent identities, collaboration routing, and permission to initiate work. |
| Usage observability | `pi.usage` records model/tool totals and includes failed/aborted attempts and summarization usage. | Per-Agent-run attribution, completeness/provenance, and the distinction between API-equivalent estimates and actual billed cost. |
| Future orchestration design | Checkpoints, ownership trees, deduplicated submissions, and replay policies are useful reference patterns. | Sprout's engine-neutral execution contract; other engines do not acquire these guarantees automatically. |

These are integration opportunities, not demonstrated Sprout behavior. In particular, Pi Durable conversation totals do not automatically satisfy M2-O5's per-activity accounting contract. [P2, S6, S7]

## The main policy conflict

ADR-0009 requires a channel-loss interruption, retained evidence, protected leases, and no automatic Agent-run replay after reconnect. Task recovery Resume keeps the interrupted run as history and returns the Task to deliberate blocked work; it does not resume that run automatically. [S5]

Pi Durable deliberately retains unfinished tasks and later resumes them when scheduling starts. Its terms also differ: a Pi Durable task can be a model request or tool call; a Sprout Task is a Human-authorized multi-run unit holding an Environment lease. A Pi Durable completed task is therefore not evidence that a Sprout Task passed Human validation or may release its lease. [P2, P3, S6]

An integration must establish how recovered execution becomes terminal history without dispatching pending effects, how deliberate new Agent runs continue useful conversation context, and how stopping a run fences foreground and background work. Calls such as `abort()` can themselves enable scheduling, so this boundary needs a deterministic failure test, not just a comment or UI policy. [P3, S5]

Also preserve Sprout's Task content semantics: an active run receives a fixed content version, and the next run receives later changes. Pi Durable supports live reconfiguration and steering, which should not silently mutate the product contract of an admitted run. [P2, S6]

## Suggested bounded prototype

Use an isolated adapter experiment with pinned upstream dependencies and a fake model/provider. Keep production runtime selection and the existing CLI adapter unchanged during the experiment. Demonstrate:

1. A normal admitted Agent run emits engine-neutral progress and a terminal result, and a subsequent run continues the intended conversation.
2. Restarting or reconnecting does not execute pending tools, queued inputs, generations, or compactions before deliberate Sprout admission. Attaching a viewer remains read-only. Starting work for another conversation must not revive interrupted work.
3. A crash after an external write but before its result is committed does not blindly repeat the write; the interrupted run and uncertainty remain visible.
4. Channel loss and Human Interrupt terminate the execution tree, including background/subordinate conversations and spawned shell processes, while leaving the Task lease held.
5. A duplicated submission uses a stable request ID, and a separate deliberate Agent run receives a separate identity. Old interrupted runs remain history.
6. A superseded Worker cannot concurrently own the same Harness storage or overwrite newer recovery evidence.
7. Model usage, retries, aborted requests, and compaction can be attributed to the right Sprout activity without presenting estimates as billed cost.
8. A separate host-local live check establishes credential reuse and non-inference readiness behavior on the supported macOS and Windows versions.

The go/no-go criterion is whether these fit the existing EngineAdapter and Worker contracts without weakening ADR-0009 or moving product authority into engine-internal state. Under the current roadmap, this investigation should not delay the bounded Sprout-on-Sprout early-use checkpoint. [S1, S5, S7]

## References

### Upstream primary sources

- **P1 — Announcement:** <https://earendil.com/posts/pi-durable>
- **P2 — Package README:** <https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/packages/durable/README.md>
- **P3 — Normative specification:** <https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/packages/durable/docs/spec.md>
- **P4 — Package manifest:** <https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/packages/durable/package.json>

### Sprout baseline

- **S1 — Engine-neutral contract:** [src/engine/port.ts](../../src/engine/port.ts)
- **S2 — Historical Environment Pi CLI adapter:** retired by Ticket #236; the current shared Environment route is [src/engine/oar.ts](../../src/engine/oar.ts).
- **S3 — Worker recovery outbox:** [src/worker/recovery-journal.ts](../../src/worker/recovery-journal.ts)
- **S4 — Worker execution lifecycle:** [src/worker/server.ts](../../src/worker/server.ts)
- **S5 — Recovery and credential ownership:** [ADR-0009](../adr/0009-self-hosted-operation-and-recovery-promises.md)
- **S6 — Product vocabulary and authority:** [CONTEXT.md](../../CONTEXT.md), [ADR-0006](../adr/0006-task-authority-and-lifecycle-outcomes.md), and [ADR-0010](../adr/0010-usage-and-cost-observability.md)
- **S7 — Current outcomes and early-use checkpoint:** [docs/roadmap.md](../roadmap.md)
