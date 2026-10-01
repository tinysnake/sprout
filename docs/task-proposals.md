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
| POST | `/api/task-proposals/:id/begin` | `{ expectedRevision, environmentInstanceId, lead, reason }` → `{ task, duplicate, initialRunId? }` |
| POST | `/api/tasks/:id/advances` | `{ targetAgentId, reason, prompt? }` → `{ task, runId, advance }` |

Creation accepts content and optional `origin`; validation accepts content
only. Revision accepts full replacement content, `reason`, and positive integer
`expectedRevision`; decisions accept the latter two fields. Domain failures
carry stable `code`: unknown targets are 404,
invalid content is 400, authority/membership refusal is 403, and stale/lifecycle
conflicts are 409. Unexpected failures expose no raw diagnostics.

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
Environment binding, and approval actor/reason. A pre-acquisition refusal leaves
the proposal proposed; once the transaction commits, Worker-context failure
moves that same Task and lease into recovery on the selected Environment. There
is no separately durable approved-but-unbegun state.

The Task lead may use `POST /api/tasks/:id/advances` to select a currently
eligible Project Agent. Each admitted run link records its actor, reason, target,
and bound content version in the same compare-and-set that enforces one active
run. Human leads receive no automatic run. Agent leads receive one initial,
separately recorded run after context preparation succeeds. The Human approval
command supplies the initial run's actor and reason.

The authenticated runtime refuses direct legacy Task creation, begin, and
advance routes; the old Task transport remains only for unauthenticated M1 test
compositions. #101 owns later Task controls and Task content changes, including
new content versions and admission of subsequent runs against the latest
version. The complete Tasks page remains #102.

## Task control boundary (#101)

Once begun, the protected Task controls remain independent of proposal approval:

- `POST /api/tasks/:id/pause` immediately holds admission; an active run may
  settle naturally. `POST /api/tasks/:id/interrupt` is available only while a
  pause request still has an active run and settles that run as `stopped`.
  `POST /api/tasks/:id/resume` clears the Human pause without automatically
  admitting another run.
- `POST /api/tasks/:id/blockers` accepts only `reason`, `requiredAction`,
  `responsible`, and `nextAdvancer`. Responsibility is a current Human/Agent,
  an external condition, or a recovery mechanism. The blocker holds the Task
  lease and prevents advancement until a Human clears it.
- `POST /api/tasks/:id/completion-claims` accepts only `outcomeSummary`,
  `validationEvidence`, `durableChanges`, `limitations`, and
  `recommendedDisposition`. It rejects unknown keys (including reasoning or
  transcript fields), empty required evidence, and non-factual nested values.
  A claim is not completion; the Task retains its lease while awaiting Human
  validation.
- `POST /api/tasks/:id/validation` accepts `{ claimId, decision: "accept" |
  "correct", reason }`. Acceptance begins safe cleanup toward completion;
  correction returns to deliberate work without releasing the lease.
- `POST /api/tasks/:id/end` only retries an already accepted completion intent.
  `POST /api/tasks/:id/discard` records cancellation intent and uses the same
  cleanup-then-release sequence. `POST /api/tasks/:id/recovery` is Human-only;
  retries of an accepted completion preserve that completed intent. Force
  Release remains the Environment recovery service's explicit emergency path.

All routes derive the Human from the authenticated operator boundary and reject
caller-supplied actors. Agent Task leads receive only internal bounded
advancement, subordinate stop, blocker, and completion-claim capabilities.
Task, nested-run, pause/validation, and Environment lease state remain distinct;
terminal `done` or `cancelled` is not recorded until normal context cleanup and
lease release have committed together.

## Risk-to-test map

- Pre-acquisition refusal and post-acquisition Worker failure: `src/task/admission.test.ts`.
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
- Pause/Interrupt, retained lease, unexpected restart, and Task-lead escalation:
  `src/task/control-service.test.ts`, `src/task/environment-lifecycle.test.ts`,
  and `src/run/orchestrator.test.ts`.
- Claim/blocker shape, Human validation/correction, end/recovery disposition,
  Force Release integration, and hostile HTTP actor fields:
  `src/task/control-service.test.ts` and `src/web/task-control-router.test.ts`.

Reference inheritance: the work-status/ownership/live-execution separation
already adopted from Paperclip by ADR-0006 is retained. Sprout's proposal authority
and lease-free validation follow its own Task semantics; no reference code is
copied.
