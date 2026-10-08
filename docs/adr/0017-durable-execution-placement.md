---
Status: superseded in part by ADR-0018
---

# Execution placement is durable for Runs and begun Tasks

ADR-0016 selects one immutable execution mode per Sprout process, but process configuration alone cannot explain where previously admitted work ran after a restart or a later mode change. We decided to persist each admitted Agent run's execution mode and actual engine host/profile, and to capture the same placement when a Task begins; every nested run retains that Task placement. Legacy records are interpreted as Environment-hosted with an unknown historical profile, without consulting the current process mode.

A begun Task may continue only when its recorded mode matches the current process. The guard runs before another Agent activation, Task reopen, or recovery that would resume execution. A mismatch keeps the Task's Environment, workspace, and lease bound to their recorded facts; interrupted runs still reconcile to terminal history, and explicit cleanup, discard, and Human Force Release remain available. When Host-run Pi calls a selected Project MCP tool inside a Task, the tool uses this existing Task-held Environment lease. MCP creates no second lease; an uncertain server or tool outcome opens Environment recovery against the Task lease.

Native session keys are scoped to Agent, engine, execution mode, actual engine host and profile, work area, and the authorized Conversation, Routing batch, or Task scope. This prevents a key from crossing a startup mode, host boundary, work area, or authorization boundary. Environment-hosted remains available for Task and standalone work. Ticket #240 also admits supported one-round Host-run Pi Message conversations without a work Environment or lease; Task execution still requires Environment-hosted mode. The Host-run Engine host identity names the opaque host-local Pi profile/session namespace, while its profile records non-secret platform and isolation facts. Public Run views expose placement without disclosing that local namespace.

**Consequences**

- Run and begun-Task records survive restart with their selected placement, independently of the mode used by a later Sprout process.
- Historical rows are never relabeled based on current configuration; their Environment-hosted placement and unknown profile express the limits of the available evidence.
- Task workspace and lease ownership continue to follow the begun Task across restart and mode mismatch. Recovery may settle interrupted work without launching a replacement run.
- Session key identity includes an authorized Conversation, Routing batch, or Task scope. Work without one does not receive a stored native key.

**Rejected alternatives**

- Inferring a Task's placement from the current process would silently move unfinished work after restart.
- Reusing session keys by Agent, engine, Environment, and working directory alone would let separate conversations or Tasks inherit one another's native state.
- Treating a mode mismatch as a reason to release or reselect the Task Environment would discard the placement and lease facts that protect unfinished work.

**Related decisions**: ADR-0004 (engine session key scope), ADR-0005 (Task-held Environment lease), ADR-0006 (Human authority over Task lifecycle), ADR-0016 (immutable execution mode at startup).
