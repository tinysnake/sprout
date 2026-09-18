# Task authority and lifecycle outcomes

M2 allows Humans and Agents to propose durable work, but only a Human may
authorize a Task to acquire a scarce Environment instance. Once approved, a
Task must be able to make useful multi-Agent progress without asking the Human
to approve every nested run. It must also remain observable and correct when a
run stops, the Task waits for validation, the Human changes its content, or its
Environment instance needs recovery.

These concerns cannot be represented by one status. A Task, each nested agent
run, and the Task lease have related but independent lifecycles. Treating run
completion as Task completion would let an Agent approve its own work. Treating
run stop or inactivity as Task end would release the Environment instance while
work is unfinished, contradicting ADR-0005.

The product owner settled the decision in #49. **A Human authorizes the outer
Task lifecycle while a Task lead
may autonomously advance work inside the approved boundary**. This is an M2
product decision; it does not claim that the current M1 implementation already
provides every state or authority check below.

## Proposal, approval, and begin

Human-created and Agent-proposed work use the same authority boundary:

1. A Human or an Agent belonging to the Project creates a **Task proposal**.
   It may be revised or withdrawn by its proposer. A Human may revise any
   proposal or reject it with a visible reason.
   A Human may create a proposal and immediately request approve-and-begin as
   one Human interaction, while creation, approval, and begin remain
   separate durable facts under the same authority boundary.
2. A proposal performs only non-resource validation. It cannot start an agent
   run, wake its proposed Task lead, acquire a lease, prepare Task context, or
   probe an Environment instance through a lease-requiring capability.
3. A Human performs one explicit **approve-and-begin** action. Approval records
   the authority decision; Task begin selects one Environment instance, acquires
   its Task lease, and prepares Task context. There is no durable
   approved-but-unbegun state whose authority could become stale or be consumed
   later without the Human present.
4. Failure before a lease is durably acquired leaves the Task proposed. Failure
   after acquisition preserves the approval, Environment instance binding, and
   blocking lease in recovery. It never falls back to another Environment
   instance.
5. Successful begin first records
   `Task active · No active Agent run · Lease held`. If the Task lead is an
   Agent, Sprout then submits a separately observable first Task-lead run. A
   Human Task lead does not cause an automatic Agent run.

The approved boundary contains the Task goal, constraints, validation criteria,
Task lead, current Project permissions, and selected Environment instance. The
lead may choose any Project Agent that remains permitted and compatible with
that Environment instance. Project membership and permission changes require
Human authority. The Task may admit only one nested agent run at a time.

## Versioned Human changes

A Human may change Task content or replace its Task lead at any time, including
while a run is active. Each change creates an auditable Task content version. A
run continues with the version it received at admission; the next run receives
the latest version. A change alone does not start, stop, pause, or invalidate a
run or completion claim. The Human can use pause and Agent run stop when a
change must affect work immediately, and can judge a completion claim against
the version it used.

The selected Environment instance is not editable. Work that must continue on
another Environment instance requires Task end followed by a new proposal,
preserving the rule that one active Task remains bound to one Environment
instance.

## Task-lead autonomy

Within the current Task content, Project permissions, and fixed Environment
instance, an Agent Task lead may:

- initiate sequential agent runs without per-run Human approval;
- select an eligible Project Agent for the next run;
- stop a subordinate run it initiated;
- state a routable blocker and its required next action; and
- submit a Task completion claim for Human validation.

Every advance records its initiator, target Agent, reason, and Task content
version. There is no automatic infinite retry: failure, denied authority, or an
uncertain next step produces a blocker or a validation request. M2 does not add
a general workflow, scheduling, or budget engine merely to bound this autonomy.
One active run, explicit authority, complete audit, and Human pause and stop
controls are the bounds.

If the proposed Task lead becomes unavailable, loses Project membership, or
cannot work in the bound Environment instance, the Task becomes blocked
until a Human selects another lead; Sprout does not substitute one silently.

The authority boundary is explicit rather than inferred from status names:

| Transition or command | Permitted initiator |
| --- | --- |
| Create a proposal | A Human, or an Agent belonging to the Project |
| Revise or withdraw a proposal | Its proposer; a Human may revise any proposal |
| Reject a proposal | Human only |
| Approve and authorize Task begin | Human only |
| Revise Task content or replace the Task lead | Human only |
| Advance with an eligible Agent | Human or Task lead within the approved boundary |
| Stop an active nested run | Human, or the Task lead for a run it initiated |
| State a Task blocker | Human or Task lead |
| Make a Task completion claim | Task lead |
| Pause or resume a Task | Human only |
| Validate, correct, end, recover, discard, or Force Release a Task | Human only |

Sprout may carry out the consequences of an authorized command—acquiring a
lease, admitting a run, reconciling interruption, or cleaning Task context—but
those system transitions do not create new authority.

## Pause and Agent run stop

Task pause is a two-stage Human control:

1. The first pause immediately prevents admission of new runs but lets the
   current run settle naturally.
2. While that run remains active, the available Human action becomes
   **Interrupt**, which requests an intentional Agent run stop and immediate
   settlement.

After settlement the Task is paused and retains its Environment instance and
Task lease. Only a Human may resume it. An Agent uses a blocker or validation
request rather than manufacturing a Human pause.

A pause wins over automatic advancement but does not erase the current run's
facts. A result, blocker, or completion claim remains visible while the Task is
paused. The Human may validate a claim and proceed to Task end without first
resuming. Rejected validation and resolved blockers leave the Task paused until
the Human resumes it. A requested next run that had not begun when pause took
effect is retained as a suggested next action but is not automatically admitted
after resume.

An intentional Agent run stop settles the run as `stopped` and keeps the Task
lease active. An unexpected process loss, Environment worker disconnection, or
Sprout interruption settles it as `interrupted` and puts the Task and lease into
recovery. The actor or interruption source is part of the durable fact.

## Blockers, validation, correction, and end

A blocker is healthy only when it records the reason, required next action,
responsible Human, Agent, external condition, or recovery mechanism, and who
will advance the Task when that condition changes. A prose-only or ownerless
blocked state is not accepted. Blocked Tasks keep their Task lease.

A Task lead's completion claim contains a fact-form outcome summary, acceptance
or validation evidence, durable changes or artifacts, known limitations and
remaining risks, and a recommended disposition. It excludes private reasoning
and raw transcripts. The Task then awaits Human validation with its lease held.

The Human may accept the claim or record a correction. Correction returns the
Task to deliberate advancement on the same Environment instance and lease.
Acceptance records a completion intent and starts Task end. The Task becomes
completed only after its Task context is recycled and the lease is released. A
Human may instead choose Discard, which records cancellation intent and drives
the same safe Task end sequence. An active run must first settle or be stopped.
Failures by an Agent, Agent run, Environment worker, or Sprout never make an
unfinished Task terminal automatically.

## Recovery and inactivity

Only a Human may choose **Resume** or **Discard** in ordinary recovery. ADR-0009
later adds Human-only **Force Release** as an emergency exception when ordinary
proof or cleanup cannot complete:

- recovery during begin retries preparation and returns to active work with no
  active Agent run on the original Environment instance;
- recovery after a nested-run interruption preserves that run as an interrupted
  fact and returns to a deliberate blocked or paused outcome, never an automatic
  rerun;
- recovery during Task end preserves the intended completed or cancelled
  disposition and can only finish that end sequence; and
- Discard abandons further Task execution, records cancellation intent, and
  enters or retries Task end. It produces `cancelled` only after Task end
  recycles Task context and releases the lease, while preserving the Project
  workspace and its work. Retrying recovery for an already accepted completion
  instead preserves its `completed` intent.

Cleanup or release failure normally remains recovery and cannot be displayed as
completed or cancelled. ADR-0009 adds one explicit exception for an otherwise
stuck Local Operator MVP: a Human may use Force Release, acknowledge the
unresolved proof or cleanup, abandon the Task through an emergency Task end,
and leave a permanent forced-release disposition. Long idle, paused, blocked,
or validation periods may produce Human attention and reminders, but never
start a run, end the Task, or make its Environment instance reassignable
automatically.

## Operator-visible state

The product presents the three lifecycles separately and may combine them into
sentences such as `Task paused · No active Agent run · Lease held`:

| Lifecycle | Outcome vocabulary |
| --- | --- |
| Task | proposed, active, Task pause requested, paused, blocked, awaiting validation, ending, recovery, completed, cancelled, rejected, withdrawn |
| Agent run | queued, running, completed, failed, stopped, interrupted |
| Task lease | none, acquiring, held, recovering, releasing, released |

There is no automatic terminal Task `failed` outcome in this product model. A
failure leaves unfinished work blocked or recovering until a Human decides how
to proceed. Internal implementations may need finer states, but must not collapse
Task state, Agent-run state, and Environment-lease state into one label.

Every proposal, revision, authority decision, run request and settlement,
pause, stop, resume, blocker, completion claim, validation, correction, end, and
recovery action records its actor, time, reason or input, Task content version,
and relevant Task, Agent run, Environment instance, and lease identifiers. Audit
facts remain curated and never include an Agent's private raw reasoning.

## Reference

Paperclip was consulted at
`d351e08deee1b49d3467a950d1a3f01131943441`. Its
`doc/execution-semantics.md` separates work status, ownership, and live execution
and requires a blocked item to have a routable waiting path. Sprout adopts those
two product principles. It does not adopt Paperclip's issue tree, checkout, or
heartbeat model: Paperclip has no Task-held Environment lease and does not use
Sprout's Human approval boundary. No code was copied.

## Rejected alternatives

- **Let Agent proposals begin automatically.** This allows an Agent to acquire a
  scarce Environment instance without Human permission.
- **Require Human approval for every nested run.** This preserves control by
  removing the useful Task-lead autonomy the product is intended to provide.
- **Let a Task lead complete and end its own Task.** This conflates an Agent's
  completion claim with Human validation and lets the Agent release capacity
  whose unfinished state the Human has not inspected.
- **Stop the current run on the first pause action.** This makes a request to
  prevent further work unnecessarily destructive; the two-stage control allows
  a cooperative run to settle before the Human escalates.
- **Release leases after inactivity or run settlement.** This repeats the unsafe
  run-held lifecycle rejected by ADR-0005 and can hand unfinished work to another
  holder.
- **Use one status for Task, run, and lease.** This cannot distinguish an active
  Task with an idle Agent from active execution, or a failed run from a Task that
  safely retains its Environment instance.

## Consequences

- The future M2 specification needs distinct proposal, Task-content version,
  Task, run, lease, authority-event, completion-claim, and blocker facts.
- Task begin and the first Task-lead run form one operator journey but remain two
  durable events with a recoverable boundary between them.
- Pause is an admission hold, not lease release, and Agent run stop is an
  intentional outcome distinct from interruption recovery.
- Human changes are simple and immediate for future runs; each run and completion
  claim must identify the content version it used.
- UI layout and implementation mechanics remain for later prototype and
  specification work; this decision defines only observable outcomes and
  authority.
