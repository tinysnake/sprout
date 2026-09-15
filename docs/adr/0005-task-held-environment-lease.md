# A Task retains one environment lease from begin to end

A durable Task (`CONTEXT.md`) advances through several sequential `AgentRun`s. M1
implemented the case where each individual run acquires and releases a lease
around itself, which is correct for one-round Message work but wrong for a Task:
between two runs, and while the Task is `blocked` or awaiting human validation,
the environment would become acquirable by someone else, and the next Task run
could land on a different instance with a different working state. `docs/goal.md`
rule 2 — "environment allocation is correct, and unfinished work is not silently
lost" — and the high-resource-editor scenario both require the opposite.

We decided that **a Task acquires one environment lease at Task begin and holds
it until Task end**. Agent runs nested inside the Task reuse that lease; they
neither match, acquire, nor release an environment of their own. The environment
is selected once, at begin, and does not change for the life of the Task.

## Why the holding unit is the Task, not the run

The two lifecycles are nested but distinct, and keeping them distinct is the
whole point:

- **Outer lifecycle: Task begin → Task end.** Task begin selects one environment
  instance, acquires its Task lease, and has that environment's worker create the
  Task context directory. Task end has the worker recycle that directory and then
  releases the lease. Everything between those two explicit acts is unfinished
  Task work.
- **Inner lifecycle: agent run begin → agent run end.** A run starts, streams,
  and settles `completed`, `failed`, `interrupted`, or `stopped` inside the Task's
  reservation. Its settlement is reported to the Task as a curated summary (#28),
  never as a lease event.

`in-progress`, `blocked`, and idle-between-runs are all states of the *same*
unfinished Task, so all of them retain the lease. "Awaiting human validation" is
not a release point either: the human is expected to continue the same Task in
the same working state, and releasing the environment would let another Task take
it and force a rebuild of exactly the state the validation depends on. This is a
deliberate choice of environment safety and preserved state over utilization — a
scarce editor environment may sit idle while its Task waits, and that is
acceptable, because losing the environment's state is not.

A one-round agent run that is *not* part of a Task keeps the existing run-held
lease. The two lease shapes coexist: the lease records whether a Task or a run is
its holder, and only an unfinished Task is permitted to hold it across run
boundaries.

## Why timeout and interruption cannot silently reassign

A Task lease is long-lived relative to the current TTL-based run lease, and it
crosses periods — idle, blocked, human validation — in which no process is
actively doing anything. A timeout-driven release would therefore fire during
exactly the periods the Task most needs to keep the environment.

We decided that **neither lease timeout nor holder or worker loss ever makes an
unfinished Task's environment reassignable on its own**. Losing the holder, the
Sprout core, or the environment worker moves the Task lease into the recovery
state already established by O4 (#16), where it continues to block acquisition.
Recovery is resolved explicitly, and only then does the instance become
acquirable again. ADR-0006 later narrows the M2 authority boundary: only a Human
may resume or discard an unfinished Task in recovery; neither the Agent Task
lead nor the system may resolve it. Task end is likewise explicit and must be
able to complete recoverably, so a crash between recycling context and releasing
the lease is repaired on restart rather than left as a half-released environment.

An automatic expiry that silently freed the environment would be the failure
`docs/goal.md` names directly: uncommitted work handed to another worker because
a lease expired or an agent was interrupted. The Task-held lease therefore
prioritizes "never lose work" over "never waste capacity"; the recovery state,
rather than expiry, is what prevents a dead holder from blocking an instance
forever.

## Why only Task-scoped data is recycled

An environment instance can hold data of two different lifetimes, and conflating
them is what makes cleanup dangerous:

- The **Project workspace** is the project's persistent working area in that
  environment instance: the repository, project rules, IDE state, build results,
  and caches. It belongs to the project and environment, not to any one Task, and
  successive Tasks reuse it.
- The **Task context directory** is Sprout-owned scratch space created at Task
  begin for that Task alone.

Task end recycles the Task context directory and nothing else. The Project
workspace, repository, IDE state, and caches persist across Tasks and across
agent runs, because rebuilding them is expensive and because a Task's results may
deliberately live in them. Deleting the Project workspace at Task end would
destroy the very state the Task produced, and deleting it at *begin* would
destroy a prior Task's preserved work; therefore begin only creates the Task's
own directory, and end only removes it.

Filesystem preparation and recycling execute **inside the target environment's
worker** (ADR-0003). The core never reaches into an environment's filesystem
directly; it asks the worker to prepare or recycle the Task context through the
uniform worker protocol, and that protocol carries the ownership manifest that
makes the operation idempotent and deletion-safe.

## Message and Task stay distinct

This decision does not merge the two collaboration lifecycles. A `Message` is one
piece of conversation, completed by a single agent run; a `Task` is durable
multi-run work (`CONTEXT.md`, `docs/goal.md`). A Message never holds a lease
beyond its one round, and a Task never becomes a Message. The two only meet at an
`AgentRun`: a one-round Message wake produces a run with a run-held lease, while
a Task advance produces a run nested inside the Task's lease.

## Reference

Paperclip was consulted at `d351e08deee1b49d3467a950d1a3f01131943441` (the commit #28 already pinned). Its `doc/execution-semantics.md` separates assignment, execution, and blocker lifecycles for an issue tree whose leaves have stopped, and its `doc/plans/workspace-strategy-and-git-worktrees.md` and `doc/plans/workspace-technical-implementation.md` separate a durable **project workspace** from a per-issue **execution workspace** derived from it. Sprout adopts that workspace split as the basis for the Project workspace versus Task context directory distinction above, and Paperclip's principle that a stopped tree is a recoverable state rather than a release of ownership. No code was copied (none of Paperclip's issue-tree, worktree, or runtime-service machinery matches Sprout's Task/lease/worker seams), and Paperclip has no environment-lease model at all, so the Task-held lease itself remains Sprout-original.

## Rejected alternatives

- **Keep a run-held lease and re-acquire each Task advance.** Simplest, but it
  releases the environment between every pair of runs and during every blocked or
  validation gap, so a high-resource environment is not actually reserved for the
  Task and the working state may be taken or lost.
- **Let the lease expire and rely on recovery.** Expiry would make an idle
  Task's environment acquirable exactly when the Task intends to resume in it;
  routing through recovery on every idle gap adds no safety the retained
  reservation does not already give.
- **Hold the environment but reset its workspace at each Task.** It preserves
  exclusivity while discarding the repository, IDE state, and caches that the
  next Task, and the current Task's own later runs, depend on.
- **Broaden Task scope to move a Task across environments.** A different
  environment means a different workspace and native session (#19, ADR-0004);
  moving one Task between environments is deferred and is not needed for the
  macOS/Pi/Codex validation slice.

## Consequences

- The Task-owned lease introduces a second owner shape beside the run-owned
  lease. The lease must record which it is, and acquisition/conflict reporting
  must say whether an unfinished Task or a run holds the environment.
- Environment selection happens once at Task begin and is fixed; a project
  membership change or a newly available instance does not rematch an unfinished
  Task.
- `lease-recovery` now has two recoverable holders. Recovery resolution must be
  reachable from the Task's own controls, not only from a run, and must be
  idempotent across restarts.
- Task begin/end ordering and crash recovery are lifecycle concerns that must be
  owned by one module and kept out of Task, Run, Lease, and Worker callers; the
  prototype in the current map (#31) settles that interface before production
  implementation (#32, #33).
- O6 is **not** fully Evidenced by this decision. It reconciles the vocabulary and
  records the architectural trade-off; the retained-lease, worker-context, and
  two-round live validation work remains open.
