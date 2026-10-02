# Task proposals and content versions

`TaskProposalService` is the public backend capability for #99. It owns proposal
validation, authorship, authority, content history, and withdrawal/rejection.
Production composes it in `src/runtime.ts` over `SqliteTaskProposalStore` and the
same read-only Project facts used by conversation authority and the Project's
read-only Agent identity authority. Archived Agents cannot propose, revise, or
withdraw even while their historical Project membership remains recorded. The operator API
mounts `createTaskProposalRouter`; the typed Web port is
`createTaskProposalBrowserAdapter`.

## Contract

- `propose(projectId, actor, content + origin?)` records one Human- or
  Agent-created proposal. `actor` is a trusted internal caller identity, not
  browser input. It must match an active Project membership in both identity
  and kind. A Working-group origin records both `workingGroupId` and
  `sourceMessageId`; the service verifies that the durable Message belongs to
  that Working group and Project and that its author participated in the group
  when it was sent. Direct creation stores `origin: null` explicitly. This
  provenance does not grant authority or affect validation.
- `validate(projectId, actor, content)` checks membership, Project writability,
  and bounded content, returning sanitized content. It writes nothing.
- `get(id)` and `list(projectId)` preserve history, including rejected/withdrawn
  proposals and proposals in archived Projects.
- `revise(id, actor, content + reason + expectedRevision)` appends one full
  content version. The current proposer or current Human may revise an open
  proposal. Reasons are required for all revisions, including Human overrides.
- `withdraw(id, actor, decision)` is proposer-only. `reject(id, actor, decision)`
  is Human-only. Each closes the proposal and appends actor, reason, time and
  the content version decided upon. Neither deletes history or reopens work.
- `contentVersion(id, version)` returns an isolated historical content snapshot.
  Later edits and caller mutations cannot change it. Admission must hold that
  exact version, not reread the current-version pointer during the run.

Content contains `title`, non-empty `goal`, `constraints`, and
`validationCriteria`. Both arrays are required and may explicitly be empty.
Text and reasons pass the shared privacy boundary before persistence. Limits:
200 title characters, 16,000 goal characters, 100 entries per array, 4,000
characters per entry, and 2,000 reason characters. Empty/all-withheld content
is refused rather than replaced with invented goals or reasons.

A proposal records `id`, `projectId`, `proposer`, `status`, `revision`,
`currentContentVersion`, full attributed `versions`, append-only `lifecycle`,
and timestamps. `revision` increments on every accepted mutation; it is distinct
from content version, which increments only on revision. A stale command refuses
rather than overwriting another accepted change. SQLite read/mutate/conditional
write is synchronous and fenced by both revision and prior document; memory
storage has the same snapshot-isolation and failure contract. The shared schema
advances from v21 to v22 for proposals and from v22 to v23 for nullable
Working-group/source-Message provenance columns, using the existing transactional
migration/safety-copy protocol. Historical rows read as `origin: null`. Fresh
databases initialize the table through the domain adapter.

## HTTP and Web

All routes use existing operator authentication and command CSRF protection.
The server resolves the acting Human from Project membership; caller-supplied
actor/proposer fields cannot impersonate an Agent or grant authority.

| Method | Route | Response |
| --- | --- | --- |
| GET | `/api/projects/:id/task-proposals` | `{ proposals }` |
| POST | `/api/projects/:id/task-proposals` | `{ proposal }` (201) |
| POST | `/api/projects/:id/task-proposals/validate` | `{ content }` |
| GET | `/api/task-proposals/:id` | `{ proposal }` |
| GET | `/api/task-proposals/:id/versions/:version` | `{ contentVersion }` |
| POST | `/api/task-proposals/:id/content` | `{ proposal }` |
| POST | `/api/task-proposals/:id/withdraw` | `{ proposal }` |
| POST | `/api/task-proposals/:id/reject` | `{ proposal }` |
| POST | `/api/task-proposals/:id/begin` | `{ expectedRevision, environmentInstanceId, lead, reason? }` → `{ task, duplicate, initialRunId? }` |
| POST | `/api/tasks/:id/advances` | `{ targetAgentId, reason, prompt? }` → `{ task, runId, advance }` |

Creation accepts content and optional `origin`; validation accepts content
only. Revision accepts full replacement content, `reason`, and positive integer
`expectedRevision`; decisions accept the latter two fields. Begin may omit its
optional `reason`; when supplied, it is recorded, and when absent no approval or
initial-run reason is fabricated. Revision, withdrawal, rejection, and explicit
Task advances retain their required reasons. Domain failures
carry stable `code`: unknown targets are 404,
invalid content is 400, authority/membership refusal is 403, and stale/lifecycle
conflicts are 409. Unexpected failures expose no raw diagnostics.

For proposal begin, a recovering Task-held Environment lease returns HTTP 409
with `code: environment-recovering`; other lease reservation refusals return 409
with `code: environment-unavailable`. Both refusals leave the proposal proposed.

The browser adapter shares portable types with the backend, encodes path ids,
and uses the existing transport for sessions, CSRF and connection state. It never
queues or automatically replays a command after disconnect.

## Execution boundary and next consumer

Proposal validation, creation and revision remain lease-free: they cannot start
work, wake a lead, acquire a lease, or prepare Task context. Proposal ids are not
legacy Task ids and cannot be passed to legacy Task begin or advance.

#100 owns Human approve-and-begin. The protected runtime exposes one
`POST /api/task-proposals/:id/begin` command. It resolves the Human from the
operator session, fences the expected proposal revision, validates the selected
lead and Environment, and then consumes that revision in the same SQLite
transaction that inserts the Task begin intent and Task-held lease. The Task
stores the immutable approved content snapshot, content version, lead,
Environment binding, and approval actor plus any supplied reason. A
pre-acquisition refusal leaves the proposal proposed; once the transaction
commits, Worker-context failure
moves that same Task and lease into recovery on the selected Environment. There
is no separately durable approved-but-unbegun state.

The Task lead may use `POST /api/tasks/:id/advances` to select a currently
eligible Project Agent. Each subsequent admitted run link records its actor,
reason, target, and bound content version in the same compare-and-set that
enforces one active run. Human leads receive no automatic run. Agent leads
receive one initial, separately recorded run after context preparation succeeds.
The Human approval command supplies the initial run's actor and optional reason.
If omitted, the begin event and initial run link record no reason rather than a
placeholder. If that submission fails after begin commits, the response and
every idempotent retry report `initialRunFailed: true`; the failed attempt's link
is not presented as an admitted `initialRunId`.

The authenticated runtime refuses direct legacy Task creation, begin, and
advance routes; the old Task transport remains only for unauthenticated M1 test
compositions. The Task control boundary below owns Human interventions and
versioned content changes; subsequent runs bind the latest version. The complete
Tasks page remains #102.

## Task control boundary (#101)

Task leases remain exclusive while blocked or awaiting validation (ADR-0005).
Before competing Message/run acquisition or a new Task reservation, the runtime
revalidates an overdue Task lease through the Task lifecycle. It moves the same
holder and lease into retained recovery, records the `lease-overdue` cause, and
opens the existing Human recovery controls. Expiry never recycles a workspace,
releases a lease, or completes a Task. Human Resume refreshes the deadline and
restores the prior held state without replay. Discard follows ordinary cleanup;
Force Release remains the risk-acknowledged emergency action in recovery
(ADR-0009). This check is demand-driven at competing acquisition, not a periodic
heartbeat or a release-on-block policy.

Environment-class run-failure notices disclose only bounded, sanitized
product-owned lease-conflict reasons. They direct the Human to Environments
recovery or to Tasks → select the holding Task → enter a reason → Discard Task.
Arbitrary engine diagnostics remain withheld. The active Task lease panel also
links directly to the holding Task's Human controls; Force Release stays gated
on recovery rather than becoming ordinary active-work preemption.

Once begun, the protected Task controls remain independent of proposal approval:

- `POST /api/tasks/:id/content` accepts `{ expectedContentVersion, content,
  reason }`, where content contains title, goal, constraints, validation criteria,
  and lead. Only the Human may revise it. Stale versions are refused; revisions
  preserve prior content in curated history and never replace the Environment,
  replay an active run, or rewrite its version or a pending claim. A replacement
  Agent lead must remain eligible on the bound Environment.

- `POST /api/tasks/:id/pause` immediately holds admission; an active run may
  settle naturally. If repeated state conflicts prevent the Pause from being
  recorded, queued admissions remain gated while the request is retry-required.
  The Human may retry `/pause` to record the hold or use
  `POST /api/tasks/:id/cancel-pause` with `{ reason }` to explicitly cancel it.
  `POST /api/tasks/:id/interrupt` is available only while a recorded pause
  request still has an active run and settles that run as `stopped`.
  `POST /api/tasks/:id/resume` clears the Human pause without automatically
  admitting another run.
- `POST /api/tasks/:id/subordinate-stop` accepts `{ runId, reason }`. The
  authenticated Human must be the current Human Task lead, and the stored run
  attribution must name that same lead as its initiator. The browser cannot
  supply an actor; Agent Task leads continue to use the internal control
  service for this capability.
- `POST /api/tasks/:id/blockers` accepts only `reason`, `requiredAction`,
  `responsible`, and `nextAdvancer`. Responsibility is a current Human/Agent,
  an external condition, or a recovery mechanism. The blocker holds the Task
  lease and prevents advancement until a Human clears it.
- `POST /api/tasks/:id/completion-claims` accepts only `outcomeSummary`,
  `validationEvidence`, `durableChanges`, `limitations`, and
  `recommendedDisposition`. It rejects unknown keys (including reasoning or
  transcript fields), empty required evidence, and non-factual nested values.
  Claims automatically record the latest admitted run's content version (or the
  current version when there has been no run). A claim is not completion; the
  Task retains its lease while awaiting Human validation.
- `POST /api/tasks/:id/validation` accepts `{ claimId, decision: "accept" |
  "correct", reason }`. Acceptance begins safe cleanup toward completion;
  correction returns to deliberate work without releasing the lease.
- `POST /api/tasks/:id/end` only retries an already accepted completion intent.
  `POST /api/tasks/:id/discard` records cancellation intent and uses the same
  cleanup-then-release sequence. `POST /api/tasks/:id/recovery` is Human-only;
  retries of an accepted completion preserve that completed intent. Force
  Release remains the Environment recovery service's explicit emergency path;
  its permanent Task disposition exposes `cleanup-unproved-force-release`, not
  a false claim that context was recycled.

All routes derive the Human from the authenticated operator boundary and reject
caller-supplied actors. Agent Task leads receive only internal bounded
advancement, subordinate stop, blocker, and completion-claim capabilities.
Task, nested-run, pause/validation, and Environment lease state remain distinct;
terminal `done` or `cancelled` is not recorded until normal context cleanup and
lease release have committed together. A lost cleanup acknowledgement can be
retried: the Worker freshly proves context absence under the authenticated
Project sentinel without touching Project work. Failed/interrupted runs expose
a system-attributed routable blocker requiring Human inspection. Idle recovery
restores the prior pause, blocker, or validation gap without replaying work.

## Project Tasks browser behavior

Saving a proposal opens that proposal's detail and selects the proposed filter.
The Human can inspect the saved content immediately, including on a phone where
only one pane is visible. The status filter is a labeled dropdown without a
surrounding tab-strip panel. Propose Task uses the existing production ChatDialog
overlay pattern: it contains focus, closes on Escape and backdrop interaction,
restores focus to its trigger, and keeps controls touch-sized.

The page uses Chat's full-height, bounded split-container pattern: list and
detail scroll internally, so switching between short and long Tasks does not
resize the outer content container. Its minimum content height matches Chat.

Approve & Begin offers the Human and compatible active Project Agents as leads,
as required by ADR-0006. Agent choices depend on the selected Environment.
Selection uses approved enrollment, clear work safety, online Worker, confirmed
protocol, granted Agent-run capability, and observed per-Agent compatibility.
A red readiness summary remains blocked. A yellow summary alone does not block
selection: it may concern an unrelated engine or probe while the selected Agent
has a compatible work option. Unknown compatibility stays unknown and blocks
selection with explicit guidance. These browser facts are observations; the
server still rechecks Project access, membership, active Agent authority,
work-option eligibility, and lease acquisition when begin is requested.

Regression coverage in `web/src/modules/tasks/tasks.dom.test.ts` protects
creation from a filter that hides proposals, dropdown filtering and the bounded
pane contract, selection of another Agent lead with a yellow summary, and
explicit unavailable/unknown resource guidance. The shared typed-conflict case
also covers a server refusal to reserve an Environment. Visual geometry still
requires browser review; DOM assertions cover the layout contract.

## Risk-to-test map

- Creation overlay, saved proposal direct-open, and approval-without-reason UI:
  `web/src/modules/tasks/tasks.dom.test.ts` and
  `web/src/adapters/task-proposal-api.test.ts`.
- Omitted approval reason at the protected route, admission service, initial Agent
  run, and SQLite restart: `src/web/task-admission-router.test.ts` and
  `src/task/admission.test.ts`.
- Pre-acquisition refusal and post-acquisition Worker failure:
  `src/task/admission.test.ts`.
- Atomic proposal revision consumption with Task+lease persistence, SQLite rollback, and restart: the SQLite admission contract in `src/task/admission.test.ts`.
- Lead authority, Environment compatibility, one-active-run fence, initial-run policy, and attributed advance history: Task admission contract tests plus `web/src/adapters/task-admission-contract.test.ts`.

## Risk-to-test map

- Shared model and authority loss/spoofing: `src/task/proposal.test.ts`.
- Stale edits, caller aliasing, rollback and adapter parity:
  `src/task/proposal-contract.test.ts` and proposal service tests.
- Durable attribution and restart, including Working-group/source-Message provenance: proposal service SQLite reopen test and v22-to-v23 migration test.
- Migration and old facts: `src/task/proposal-migration.test.ts` plus schema tests.
- Authentication, CSRF, real runtime composition, Human override, browser wire
  compatibility, invalid bodies and absence of execution side effects:
  `web/src/adapters/task-proposal-contract.test.ts`.
- Encoded identities and disconnected command non-replay:
  `web/src/adapters/task-proposal-api.test.ts`.
- Pause/Interrupt, retained lease, unexpected restart, exhausted Pause CAS and
  Human resolution, and Task-lead escalation: `src/task/control-service.test.ts`,
  `src/task/environment-lifecycle.test.ts`, and `src/run/orchestrator.test.ts`.
- Claim/blocker shape, Human validation/correction, end/recovery disposition,
  Force Release integration, and hostile HTTP actor fields:
  `src/task/control-service.test.ts`, `src/web/task-control-router.test.ts`,
  and the authenticated runtime HTTP journey in `src/web/task-controls-contract.test.ts`.
- Content/claim version binding, concurrent Pause/settlement, bounded diagnostic
  summaries, and lower-layer authority: `src/task/control-service.test.ts`.
- Lost cleanup acknowledgement, fresh sentinel proof, and Project preservation:
  `src/worker/workspace.test.ts`.

Reference inheritance: the work-status/ownership/live-execution separation
already adopted from Paperclip by ADR-0006 is retained. Sprout's proposal authority
and lease-free validation follow its own Task semantics; no reference code is
copied.
