# Task-held lease lifecycle prototype

## Recommendation

Adopt a single core deep module named **`TaskEnvironmentLifecycle`**. Its public
commands are `begin(taskId, selection)`, `advanceRun(taskId, agentId, input)`,
`settleRun(runId, outcome)`, `end(taskId)`, and `recover(taskId, action)`. It
owns the durable Task-environment binding, Task-owned lease, active nested-run
guard, Worker context protocol calls, recovery state, and their ordering. Task,
Run, Lease, API, and Web callers invoke these commands; they do not compose
lease and Worker operations themselves.

The disposable executable is `scripts/prototype-task-held-lease.ts`, run with
`npm run prototype:task-held-lease`. It uses actual SQLite persistence and a
separate Environment worker process that alone performs the Project-workspace
and Task-context filesystem operations. The engine in that worker is fake by
design. No production module imports the prototype.

## Interfaces considered

1. **Distributed calls from TaskService and RunOrchestrator.** Let Task begin
   acquire through the existing pool, call a Worker, then let the orchestrator
   special-case nested runs. This leaves begin/end crash ordering and recovery
   split among callers, and makes it too easy for a run settlement to release a
   Task lease. Rejected.
2. **A Task facade that directly owns Worker and Lease clients.** This keeps a
   Task API short, but leaks Worker transport and lease persistence into the
   Task domain and makes one-round Message work an awkward exception. Rejected.
3. **`TaskEnvironmentLifecycle` orchestration module.** A narrow module owns
   the cross-domain transaction protocol while depending on small Task-store,
   lease-store, run-store, environment-selection, and Worker ports. Message
   runs remain on the existing run-held-lease path. Selected.

## Required invariants

- A non-terminal Task has exactly one selected environment and one Task-held
  lease; that lease blocks acquisition in `active` and `recovering` states.
- Nested runs must match that fixed Task binding. They never select an
  environment and never acquire, extend by expiry, release, or resolve its
  lease.
- There is at most one active nested run. Its terminal outcome changes Task
  progress only; it does not change the lease state.
- Idle, blocked, and awaiting-human-validation Tasks retain the lease.
- A timeout, core restart, Worker loss, or interrupted nested run transitions
  an unfinished Task lease to blocking recovery. No expiry path releases it.
- The Worker alone prepares and recycles the Task context. A manifest owned by
  the Task authorizes deletion; Project workspace data is outside that manifest
  and cannot be recycled by Task end.
- A Message run has a run-held lease and no Task context. Its terminal path
  releases that lease.

## Ordering and crash recovery

`begin` first commits Task binding, Task lease, and `beginning` intent in one
SQLite transaction. It then asks the Worker to idempotently prepare the
manifested context, and only afterwards commits `idle`. A crash before or after
preparation therefore has a durable owner; restart makes the lease recovering.
The same Task may explicitly resume recovery, which repeats preparation safely.

`advanceRun` records the active run before worker execution. On an interruption
the Task is recovered and the old run remains a visible failed/interrupted fact;
it is never restarted automatically. `settleRun` records the outcome and moves
the Task to `idle` or `blocked` without touching its Task lease.

`end` refuses an active nested run, commits `ending`, asks the Worker to recycle
the manifest-authorized context, then atomically records lease release and Task
terminal state. A crash after recycle but before release leaves `ending` and the
lease held. Restart exposes recovery; explicit discard retries idempotent
recycle and then releases. Thus no released environment can still be undergoing
destructive cleanup.

## Error modes

- Begin reports a conflict naming the blocking Task/run and whether its lease is
  active or recovering; it never queues or selects another environment.
- Worker prepare/recycle failures, lost Worker channels, and persistence errors
  leave the Task lease held and move/retain it in recovery for operator action.
- Advance and end reject a Task in an incompatible lifecycle state; end rejects
  while a nested run is active.
- Recovery offers explicit `resume` for beginning/interrupted work and explicit
  `discard` for Worker-recycled cleanup. Resuming an interrupted run requires a
  new deliberate advance; it never relaunches automatically.

## Evidence exercised

The prototype demonstrates three sequential fake-engine runs by Pi, Codex, and
Pi identities under one Task, environment, lease, and persistent Project
workspace. It checks that completed, stopped, and failed nested runs preserve
the lease; that another Task is refused during idle, blocked, validation,
timeout, restart, and end-recovery windows; and that Task end preserves a
Project sentinel while recycling only Task context. It injects core-process
crashes after Worker prepare and after Worker recycle. It also demonstrates a
terminal one-round Message run releasing a run-held lease.

## Reference note

Paperclip was previously consulted at the pinned revision recorded in
`docs/references.md` and ADR-0005. Its durable project workspace versus
per-work execution area supports the workspace/context split, but it has no
equivalent environment lease lifecycle. This prototype adopts no reference code.
