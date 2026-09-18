# Research report: implemented M1 capabilities mapped to the settled M2 backend obligations

**Status**: Research finding for ticket #73 (part of map #70). Fact report only; it
does not design or implement the missing production capability.
**Fixed base**: `ea0c660cff96d2845aab492305085a9e2739a348`
**Inputs**: #44 decisions, ADR-0006 through ADR-0011, `CONTEXT.md`, the retained
#61–#68 prototype artifacts, `docs/roadmap.md`, and the actual M1 source, tests,
HTTP/SSE routes, and Environment Worker protocol.
**Use**: direct `/to-spec` input. The matrix is organised so a spec author can
take one row (obligation) and see what already exists, what must be preserved,
and what does not exist yet.

This report deliberately does **not** treat `web/src/prototype/state.ts` as
evidence of capability. Section 5 records, per prototype behaviour, the backend
authority it simulates and the M1 source that does *not* exist for it.

---

## 1. Method and evidence rules

1. Read the settled decisions first: `docs/adr/0006`–`0011`, `CONTEXT.md`,
   `docs/roadmap.md` (`M2-O1`…`M2-O7`), and the retained prototype artifacts
   `docs/prototype-*.md`.
2. Walked the production graph from `src/main.ts` and read each domain module,
   its store interface, the HTTP surface (`src/web/api.ts`), the Worker protocol
   (`src/worker/protocol.ts`, `src/worker/server.ts`, `src/worker/workspace.ts`),
   and the current Web client (`web/src/main.ts`, `web/index.html`,
   `web/src/style.css`).
3. Confirmed every "implemented" claim against a named test file.
4. Read `web/src/prototype/state.ts` and `web/src/prototype/types.ts` only to
   identify *simulated* authority, never as implementation evidence.
5. Consulted the three standing references at pinned revisions and recorded
   adopted/rejected lessons (section 7).

Classification vocabulary used in section 4 (ticket acceptance wording):

- **Implemented / reusable** — production M1 behaviour exists and the M2
  obligation is a consumer of it, not a rewrite.
- **Implemented / needs cleanup** — behaviour is correct and must be preserved,
  but composition, placement, or ownership obstructs the M2 path and is a
  planned behaviour-preserving cleanup target (see
  `docs/research/m1-foundation-cleanup.md`, ticket #71).
- **Partial** — some durable fact or operation exists, but a material part of the
  settled obligation (field, state, authority check, route, or view) does not.
- **Missing** — no durable fact, store, route, protocol method, or client
  surface exists for the obligation.
- **Outside M2** — the obligation is explicitly excluded by the M2 non-goals in
  `docs/roadmap.md` or the operative ADR.

Evidence notation: `path:line` for a claim, plus the test file that asserts it.
"Route" means a branch in `src/web/api.ts`.

---

## 2. Verification recorded for this Ticket (sanitized)

Run in the Ticket worktree on Node `v26.7.0`, npm `11.19.0`, after `npm ci`
(55 packages; the worktree had no `node_modules`).

| Check | Command | Result |
| --- | --- | --- |
| Full test suite | `npm test` | `tests 523 / pass 523 / fail 0`, 0 cancelled, skipped, or todo |
| Typecheck | `npm run typecheck` | Pass (`tsc --noEmit` for core and Web) |
| Web build | `npm run web:build` | Pass; `dist/index.html` 4.92 kB, `main` JS 18.13 kB, `prototype` JS 561.84 kB (pre-existing >500 kB chunk warning for the retained prototype bundle) |
| Whitespace/diff | `git diff --check` | Clean |

`npm ci` emitted only the standard "install scripts not yet covered by
allowScripts" notice for `esbuild` and `fsevents`. No host path, hostname,
account, or network fact was recorded.

---

## 3. The implemented M1 surface (what production actually has today)

### 3.1 Domain modules

| Module | Interface (deep-module surface) | Notable line evidence |
| --- | --- | --- |
| `src/project/model.ts` | `Project` = `id`, `goal`, `rules`, `availableEnvironmentInstanceIds`, optional `workspaces`, `memberships` | `model.ts:35` |
| `src/project/registry.ts` | `get`, `list`, `forAgent`, `add`, `load(ProjectStore)` | `registry.ts:11` |
| `src/project/resolve.ts` | `resolveEnvironmentInstance`, `matchesPreference`, `workspaceFor` | `resolve.ts:67`, `resolve.ts:103` |
| `src/project/contract.ts` | `assembleProjectContract`, `renderProjectContract` | `contract.ts:54`, `contract.ts:77` |
| `src/agent/registry.ts` | `AgentDefinition` = `id`, `name`, `engine`, `capability`, optional `model`, `effort`, `workingDirectory`, `instructions` | `registry.ts:13` |
| `src/environment/model.ts` | `EnvironmentDefinition`, `EnvironmentCapability{name,requiresLease}`, `EnvironmentInstance`, `EnvironmentPreference` | `model.ts:11` |
| `src/environment/pool.ts` | `acquireLease`, `reserveTaskLease`, `adoptLease`, `extendLease`, `releaseLease`, `markRecovering`, `resolveRecovery`, `releaseTaskLease`, `resumeTaskLease`, `activeLease`, `leases` | `pool.ts:20`, `pool.ts:178`–`303` |
| `src/run/orchestrator.ts` | `submit`, `stop`, `get`, `list`, `load`, `waitFor`, `subscribe`, `leases`, `releaseLease`, `reconcileOrphanedRuns` | `orchestrator.ts:200`, `orchestrator.ts:422` |
| `src/run/model.ts` | `AgentRun` = `id`, `agentId`, `prompt`, `environmentInstanceId`, optional `projectId`, `taskId`, `handOff`, `leaseId`, `result`, `tokenUsage` | `model.ts:16` |
| `src/run/session-key-store.ts` | identity tuple `(agent, engine, environment instance, working directory)` | ADR-0004 |
| `src/run/hand-off.ts` | `buildHandOffContext`, `renderHandOffPrompt`, `shouldAttachHandOff` | O5 evidence |
| `src/task/model.ts` | `Task` = `id`, `projectId`, `title`, `goal`, `constraints`, `status`, optional `assignedAgentId`, `environmentPreference`, `blockerReason`, `environmentInstanceId`, `environmentLeaseId`, `environmentLifecycleState`, `recoveryState`, `activeRunId` | `model.ts:71` |
| `src/task/service.ts` | `create`, `update`, `advance`, `begin`, `end`, `awaitHumanValidation`, `recover`, `link`, `onRunSettled`, `prompt` | `service.ts:96` |
| `src/task/environment-lifecycle.ts` | `begin`, `advanceRun`, `settleRun`, `end`, `recover`, `reconcile` | `environment-lifecycle.ts:101`, `:273` |
| `src/collaboration/model.ts` | `Message`, `WakeRequest`, `WakeObservation`, `WakeReason`, `WakeStatus` | `model.ts:65`, `model.ts:78` |
| `src/collaboration/wake.ts` | `planWake`, `parseMentions` | `wake.ts:85` |
| `src/collaboration/coordinator.ts` | `deliver`, `reconcile`, `listMessages`, `listWakeRequests`, `listObservations` | `coordinator.ts:184`, `coordinator.ts:377` |
| `src/worker/workspace.ts` | `prepare`, `recycle`, `projectWorkingDirectory` (Worker-owned filesystem boundary) | `workspace.ts:17`, `:24`, `:57` |
| `src/engine/port.ts` | `EngineAdapter.startSession`, `EngineSession.{run,interrupt,close,engineSessionKey,contractDelivery}`; `TokenUsage{promptTokens,completionTokens,totalTokens}` | `port.ts:113` |

### 3.2 Persistence (one SQLite database, nine tables; ADR-0002)

| Table | SQLite adapter | Purpose |
| --- | --- | --- |
| `agent_runs` | `src/run/sqlite-store.ts:70` | durable `AgentRun` including `token_usage` |
| `environment_leases` | `src/run/sqlite-store.ts:192` | `active`/`recovering`/`expired`/`released`, `holder_kind` run vs task |
| `projects` | `src/run/sqlite-store.ts:291` | whole `Project` as a JSON document |
| `agent_session_keys` | `src/run/sqlite-store.ts:352` | continuation key per identity slot |
| `collaboration_messages` | `src/collaboration/sqlite-store.ts:57` | unique `delivery_key` |
| `collaboration_wake_requests` | `src/collaboration/sqlite-store.ts:69` | unique `idempotency_key` = `messageId:agentId` |
| `collaboration_observations` | `src/collaboration/sqlite-store.ts:81` | suppressed/failed non-wake outcomes |
| `tasks` | `src/task/sqlite-store.ts:47` | durable Task |
| `task_run_links` | `src/task/sqlite-store.ts:66` | ordered run links, one index `task_run_links_by_task` |

Schema evolution today is additive `ALTER TABLE` guarded by
`#addColumnIfMissing` (`src/run/sqlite-store.ts:97`, `:210`,
`src/task/sqlite-store.ts:89`). There is **no** schema-version row, no
`PRAGMA user_version`, no forward-migration protocol, and no pre-migration
safety copy.

### 3.3 HTTP and SSE surface (`src/web/api.ts`, 952 lines, 22 route branches)

| Method + path | Line | Notes |
| --- | --- | --- |
| `POST /api/messages` | 82 | deliver Message, plan wake, admit runs |
| `GET /api/messages` | 134 | durable conversation |
| `GET /api/messages/:id/observations` | 143 | non-wake outcomes + wakes |
| `GET /api/projects` | 168 | **only** `{id, goal, memberIds}` |
| `POST /api/tasks` | 174 | create; caller may pass `status` directly |
| `GET /api/tasks` | 216 | list/filter |
| `POST /api/tasks/:id/runs` | 233 | advance one nested run |
| `POST /api/tasks/:id/begin` | 268 | acquire Task lease |
| `POST /api/tasks/:id/end` | 284 | recycle then release |
| `POST /api/tasks/:id/recovery` | 293 | `resume` / `discard` |
| `POST /api/tasks/:id/validation` | 304 | enter awaiting-validation |
| `GET /api/tasks/:id` | 314 | Task + ordered run links |
| `PATCH /api/tasks/:id` | 332 | status, goal, constraints, assignment, blocker |
| `POST /api/runs` | 391 | one-round run |
| `POST /api/runs/:id/stop` | 406 | stop |
| `POST /api/runs/:id/release-lease` | 422 | resolve one-round run recovery |
| `GET /api/runs/:id` | 446 | inspect |
| `GET /api/agents` | 461 | `{id, name, engine}` only |
| `GET /api/runs` | 473 | list + `totals` |
| `GET /api/leases` | 480 | lease observability |
| `POST /api/leases/:id/release` | 487 | release a run-held lease |
| `GET /api/events` | 503 | SSE `event: run` replay + stream |

Optional-plane gating: message routes need `collaboration`, `/api/projects`
needs `projects`, Task routes need `tasks`; absent planes fall through to 404.
There is **no** authentication, no cookie/session, no CSRF, and no
non-`GET`/`POST`/`PATCH` verb. The client posts as the hard-coded
`WEB_AUTHOR_ID = 'operator'` (`web/src/main.ts:132`).

### 3.4 Environment Worker protocol (`src/worker/protocol.ts`)

- Methods: `worker/info`, `session/start`, `session/run`, `session/interrupt`,
  `session/close`, `context/prepare`, `context/recycle`.
- Notifications: `turn/event`, `turn/settled`.
- Error code `-32610` `resumeRefused`.
- Carriers: `EndpointCarrier` (loopback TCP), `ContainerCarrier` (runtime exec
  channel, no published port), `SshTunnelCarrier` (SSH local forward to a
  Windows daemon's loopback address).
- `WorkerInfo` carries `pid`, `environmentInstanceId`, engine descriptions
  (`streaming`, `supportsInterrupt`, `standingInstructions`). It carries **no**
  protocol version, enrollment identity, capability permission, auth, or health
  fact.
- On channel loss, `WorkerClient` fails the in-flight turn with
  `environment worker channel closed: <reason>` (`src/worker/client.ts:258`); the
  Worker itself closes every engine session on transport close
  (`src/worker/server.ts`, `shutdown`).

### 3.5 Run admission order (the behaviour that must survive any cleanup)

`submit` → resolve environment → persist run → link Task → assemble contract and
hand-off → acquire (or validate a nested Task) lease → session start (resume key
from the slot) → stream events → settle → release a one-round lease in `finally`.
(`src/run/orchestrator.ts:200`, `:422`; `src/task/environment-lifecycle.ts:101`.)

### 3.6 Current Web client

`web/index.html` is one scrolling page: Project Channel composer + stream, Tasks
form/list, run form, leases list, run-history totals, run cards, and a
`new EventSource('/api/events')` subscription (`web/src/main.ts:343`).
`web/src/style.css` is 503 lines with **zero** `@media` rules — it is not a
responsive or mobile surface. The retained prototype (`web/prototype/index.html`,
`web/src/prototype/*`) is served by the same Vite build and is the accepted
structural baseline (ADR-0011), not production code.

---

## 4. Capability matrix

### 4.1 Project

Obligations: ADR-0008 "Ownership and collaboration boundaries", "Built-in
template and Project creation", "Editing, history, archive, and revocation".
Roadmap M2-O1.

| # | Settled obligation | Class | M1 evidence | What is absent, and which decision requires it |
| --- | --- | --- | --- | --- |
| P1 | A Project is a durable collaboration boundary with goal, rules, environment access, workspaces, memberships | **Implemented / needs cleanup** | `src/project/model.ts:35`; persisted as a JSON document in `projects` (`src/run/sqlite-store.ts:291`); round-trip asserted in `src/run/sqlite-store.test.ts` and `src/project/project.test.ts` | Placement of the SQLite adapter in `run/sqlite-store.ts` is the recorded cleanup target (C3 in #71); no behaviour change |
| P2 | Stable identity, non-empty display name, Project channel as an invariant | **Partial** | Identity and goal exist; there is no display-name field distinct from goal, and "Project channel" is only the `channel: 'project'` value on a Message, not a durable Project-owned object (`src/collaboration/model.ts:22`) | ADR-0008 requires a Project-owned Project channel whose participants are all members |
| P3 | A Project remains complete with no Agent, no Environment, no membership beyond the Human | **Partial** | A Project with empty `memberships`/`availableEnvironmentInstanceIds` is representable (`src/runtime-config.ts` parses both) | There is no Human membership concept: memberships are Agent-only (`src/project/model.ts:14`), so "the local Human's Project membership" cannot be recorded |
| P4 | Human-only add/end Agent membership, with optional responsibilities and collaboration instructions | **Partial** | `ProjectMembership{agentId,responsibilities,collaborationInstructions}` (`src/project/model.ts:13`) exists and is consumed by the contract | No durable membership mutation path: `ProjectStore` exposes `save`/`get`/`list` (`src/project/store.ts:10`), but `save` has **no production caller** — `grep` finds no `projects.save` outside tests, and `ProjectRegistry` only reads. No membership end/history, no Human authority check |
| P5 | One immutable built-in "General collaboration" Project template with goal guidance, suggested rules, role slots, collaboration guidance, completion guidance | **Missing** | No template module, type, table, or route; `grep` for `template` in `src` returns nothing | ADR-0008 requires the template and its copy-on-create snapshot with source version |
| P6 | Atomic Project creation (Project + Human/Agent memberships + channel + workspace bindings + template snapshot) in one Web action | **Missing** | None; `POST /api/projects` does not exist. The default Project is constructed in `src/main.ts:225` from `SPROUT_PROJECT`/`SPROUT_RUNTIME_CONFIG` | ADR-0008 "Outside first-run onboarding… One submission atomically creates…" |
| P7 | First-run onboarding journey (pending enrollment → host bootstrap → approve → Agent → first Project) | **Missing** | None | ADR-0008 "First-run journey"; roadmap M2-O1 |
| P8 | Non-destructive archive/restore of a Project with active-work impact checks and read-only channels | **Missing** | None | ADR-0008 "Editing, history, archive, and revocation" |
| P9 | Every effective edit records actor, time, and changed version; history is product data | **Missing** | `Task.updatedAt`/`createdAt` exist; no audit or version record for Project, membership, Agent, or Environment edits | ADR-0008 "Version and relationship history is product data" |
| P10 | Project workspace binding is per (Project, Environment instance), relative path only | **Implemented / reusable** | `ProjectWorkspace{environmentInstanceId,path}` (`src/project/model.ts:29`); `ProjectRegistry` + `resolve.workspaceFor`; Worker resolves it under its root (`src/worker/workspace.ts:104`); `SPROUT_RUNTIME_CONFIG` rejects absolute/traversal paths (`src/runtime-config.ts`) | — |
| P11 | Changing a workspace only when no active run / unfinished Task / recovery, Worker validates before binding changes | **Partial** | `src/worker/workspace.ts#workspace` validates a registered relative path before use; the Task lifecycle refuses advance while a run is active | No route or operation to change a binding, and no cross-domain "is any work active?" guard |

### 4.2 Membership and collaboration scopes

Obligations: ADR-0008 "Ownership and collaboration boundaries", "Project and
Working group communication".

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| M1 | Project membership references a global Agent without copying identity | **Implemented / reusable** | `ProjectMembership.agentId` referencing `AgentRegistry`; `ProjectRegistry.forAgent` (`src/project/registry.ts:32`); `runtime-config.ts` refuses a membership naming an unknown Agent | — |
| M2 | Membership lifecycle: end prevents new communication/runs, preserves attribution; a dependent unfinished Task exposes a blocker and is not silently re-assigned | **Missing** | `AgentRun`/`Message`/`TaskRunLink` keep historical `agentId` text, so attribution survives incidentally | ADR-0008 requires the end operation, its guard against active work, and the Task blocker path |
| M3 | A Human may not be an Agent (`CONTEXT.md`: Human retains authority) | **Missing** | Human authorship exists only as `authorKind: 'human'` on a Message (`src/collaboration/model.ts:33`) and as the hard-coded `WEB_AUTHOR_ID` | The Human is not an addressable Project member anywhere |

### 4.3 Working group

Obligations: ADR-0008 "Project and Working group communication". Prototype
artifact `docs/prototype-project-multiview.md` §1, `docs/prototype-chat-routing.md`
§1.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| W1 | Working group with stable identity, display name, optional goal/rules, subset of current Project members, creator, channel, durable membership history | **Missing** | `grep -ri "workinggroup\|working group"` in `src` returns 0 matches | ADR-0008 |
| W2 | Atomic creation of group + channel; creation sends no message, wakes no Agent, creates no Task, acquires no lease | **Missing** | None | ADR-0008 |
| W3 | Disband makes the channel read-only without deleting configuration or messages; restore restores it | **Missing** | None | ADR-0008 |
| W4 | Ending a Project membership also ends current Working group participation without erasing history | **Missing** | None | ADR-0008 |
| W5 | A one-round run from a Working group message receives the Project contract **plus** that group's current goal and rules | **Missing** | `assembleProjectContract` has no Working group input (`src/project/contract.ts:54`) | ADR-0008; `MessageChannel` has only `'direct' \| 'project'` (`src/collaboration/model.ts:22`) |
| W6 | Task proposal created from a group records group + source message provenance; approve-and-begin records the group context version | **Missing** | `Task` has no provenance fields (`src/task/model.ts:71`) | ADR-0008; ADR-0006 |
| W7 | Disbanding the source group neither ends nor blocks the Task | **Missing** | None | ADR-0008 |

### 4.4 Message and routing

Obligations: ADR-0007 (all sections). Roadmap M2-O3. Prototype artifact
`docs/prototype-chat-routing.md`.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| R1 | Durable Message persisted before any wake; idempotent by `deliveryKey` | **Implemented / reusable** | `postMessage` writes Message + wakes in one transaction (`src/collaboration/sqlite-store.ts:93`); `src/collaboration/sqlite-store.test.ts` "a message and its wake requests become durable together"; "a repeated delivery key inserts nothing" |
| R2 | Per-recipient durable WakeRequest with idempotency `(messageId, agentId)`, compare-and-set admission, at most one run per (wake, agent) | **Implemented / reusable** | `WakeRequest` (`src/collaboration/model.ts:95`); `admitWake` CAS (`src/collaboration/store.ts:54`); tests `only one of two admissions wins the same wake` |
| R3 | Explicit reply projection: only a completed run's final assistant text becomes an Agent-authored Message; non-routing | **Implemented / reusable** | `#projectReply` (`src/collaboration/coordinator.ts:321`); tests "a completed run projects exactly one reply", "a failed run produces no reply", "an interrupted run produces no reply" |
| R4 | Restart reconciliation of pending wakes and un-projected replies, idempotent | **Implemented / reusable** | `reconcile` (`src/collaboration/coordinator.ts:377`); `src/collaboration/reconcile.test.ts` over a real reopened SQLite file |
| R5 | Privacy: no run events, tool output, or raw reasoning enters conversation | **Implemented / reusable** | `Message` carries no event field; `toMessageView` projects body only (`src/web/api.ts` `MessageView`); `src/web/api.test.ts` "the client view exposes progress but no engine internals" |
| R6 | Deterministic addressing: direct recipients, whole-token `@id` mentions, `@all`, author never woken, unknown target is a durable failure that never reaches the model | **Implemented / reusable** | `planWake` (`src/collaboration/wake.ts:85`); 13 assertions in `src/collaboration/wake.test.ts` |
| R7 | Three communication scopes: Project-scoped direct message, Project channel, Working group channel | **Partial** | Direct and Project channel exist; `MessageChannel = 'direct' \| 'project'` | Working group channel absent (W1); ADR-0008/0007 |
| R8 | **Per-Project wake policy** `explicit-only` (default for new, template-less, and migrated Projects) vs `wake-model-assisted` | **Missing** | `grep` for `wakePolicy` in `src` returns 0. M1 has no policy: every unaddressed Project-channel Message consults (or fails open past) the model (`src/collaboration/wake.ts:199`) | ADR-0007 "Project wake policies"; prototype `docs/prototype-chat-routing.md` §2 |
| R9 | Project event as a first-class fact with a declared routing disposition (`addressed`, `wake-eligible`, `informational`, `human-action-required`, `non-routing`) | **Missing** | `grep` for `disposition\|projectEvent` in `src` returns 0 | ADR-0007 "Eligible inputs and routing dispositions" |
| R10 | Fixed collection window (default 30 s, per Project and per template), durable cursor/deadline/membership, later inputs join without reset | **Missing** | Every unaddressed Message is evaluated immediately (`wake.ts:200`). No window state, table, or scheduler | ADR-0007 "Collection windows and routing batches" |
| R11 | Durable Routing batch: frozen inputs, chronological split when oversized, deterministic marked truncation | **Missing** | None | ADR-0007 |
| R12 | One wake-model call per frozen batch; may select zero or more current Agents with a rationale; cannot select non-members or rewrite deterministic recipients; every input has an explicit selected/suppressed result or the attempt is invalid | **Missing** | `WakeModel.decide` only returns `{engage: boolean}` for the whole room (`src/collaboration/model.ts:152`); it cannot pick recipients and does not validate completeness | ADR-0007 "Wake-model authority and run fan-out" |
| R13 | One selected Agent receives at most one WakeRequest and one run per batch; the run receives its inputs chronologically | **Missing** | Today's cardinality is one run per Message per Agent | ADR-0007 |
| R14 | Bounded routing context with the six-item frozen manifest (inputs, project goal/rules, candidates + responsibilities, bounded recent channel context, curated public Task state, policy/bounds/truncation) and the exclusion list | **Missing** | None. Today's prompt is `renderWakePrompt` (verbatim Message) (`src/collaboration/coordinator.ts:433`) | ADR-0007 "Bounded routing context" |
| R15 | Failure/retry: one automatic retry on the same frozen snapshot, then **fail closed** with durable visible routing failure per affected input | **Partial, inverted** | M1 has a durable failure observation, but the contract **fails open** to one wake per other member (`wake.ts:265`, `failOpen`) with reason `wake-model-fail-open` | ADR-0007 "Failure, suppression, admission, and retry" explicitly replaces fail-open |
| R16 | Deliberate suppression (valid result selecting no Agent) is durable, visible, not retried | **Implemented / reusable** | `WakeStatus 'suppressed'` + `WakeObservation`; `src/web/api.test.ts` "a wake-model suppression is visible through the observations route" | Becomes per-input under R11–R12 |
| R17 | Admission: WakeRequest durable before admission; contention leaves it pending/waiting without expiry or retargeting; membership loss produces a visible failure | **Partial** | Wake is durable before `submit`, and the status vocabulary has `pending`/`admitted`/`failed`; `WakeRequest.detail` carries a reason | No `waiting` state for capacity contention; no admission retry when the condition clears; no automatic re-attempt after a membership/permission change |
| R18 | Once a durable run exists, never start another automatically for the same wake | **Implemented / reusable** | `admitWake` CAS; test "admission is idempotent even if a wake is admitted twice directly" | — |
| R19 | Human-inspectable routing evidence: policy in force, deterministic recipients/reasons, batch/window/cutoff/split, model identity, attempt number/timing, candidates, per-input outcomes, rationale labelled as model judgement, frozen manifest and truncation markers, timeouts/exceptions, WakeRequest outcome, linked runs and projected replies | **Partial** | Message, WakeRequest (`reason`, `status`, `runId`, `detail`) and Observation (`status`, `reason`, `detail`) are durable and exposed (`GET /api/messages`, `/api/messages/:id/observations`) | Batch, window, attempt, model identity/timing, manifest, per-input outcome, and rationale do not exist. Required by ADR-0007 "Human-inspectable routing evidence" and roadmap M2-O3 |
| R20 | No routing-specific Human controls in the MVP (no Route now / Retry / override / pending-wake cancel) | **Implemented / reusable** (by absence) | No such route exists | — |
| R21 | Wake policy change affects only later inputs, never rewrites history | **Missing** | No policy to change | ADR-0007 |
| R22 | Deterministically addressed Messages keep the per-Message, per-recipient path and are not coalesced | **Implemented / reusable** | `planWake` addresses directly and bypasses the model (`wake.ts:117`–`166`) | Must be preserved through R10–R13 |

### 4.5 Task authority and lifecycle

Obligations: ADR-0006 (all sections), ADR-0005. Roadmap M2-O2. Prototype
artifact `docs/prototype-project-multiview.md` §3.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| T1 | Task is durable multi-run work, distinct from Message and Agent run | **Implemented / reusable** | `src/task/model.ts:71`; `src/run/task-link.ts` is the only run↔Task surface; tests `src/task/service.test.ts` |
| T2 | Task proposal: created by a Human or a Project Agent, revisable/withdrawable by proposer, rejectable by a Human with a visible reason | **Missing** | No proposal state, proposer, or expiry. `POST /api/tasks` creates directly in `todo` and accepts an arbitrary initial `status` (`src/web/api.ts:174`) | ADR-0006 "Proposal, approval, and begin" |
| T3 | A proposal performs only non-resource validation and cannot start a run, wake a lead, acquire a lease, prepare context, or probe an instance | **Missing** | There is no non-resource validation phase at all | ADR-0006 |
| T4 | One explicit Human approve-and-begin; no durable approved-but-unbegun state; failure before lease leaves the Task proposed, failure after preserves approval + binding + blocking lease in recovery, never falls back to another instance | **Partial** | `POST /api/tasks/:id/begin` acquires a Task lease atomically with the beginning intent (`saveBeginningWithLease`, `src/task/sqlite-store.ts`), refuses a fallback instance, and recovers on failure (`src/task/environment-lifecycle.ts:101`, tests "crashed child begin/end boundaries…", "worker channel loss enters owner recovery") | There is no approval fact, no Human authority check (any caller can begin), and no "proposed" outcome; `POST /api/tasks` + `begin` are two unauthenticated calls |
| T5 | Successful begin records `Task active · No active Agent run · Lease held`, then a separately observable first Task-lead run when the lead is an Agent | **Partial** | Begin yields `environmentLifecycleState: 'idle'` with the lease held; a first run is a separate `POST /api/tasks/:id/runs` | No Task lead identity exists, so no automatic first lead run |
| T6 | Approved boundary: goal, constraints, validation criteria, Task lead, current Project permissions, selected Environment instance; only one nested run at a time | **Partial** | Goal, constraints, instance binding, and single-active-run enforcement exist (`advanceRun` refuses when `environmentLifecycleState === 'running'`; CAS on `activeRunId`) | No Task lead, no validation criteria, no Project-permission snapshot |
| T7 | Task lead autonomy: initiate sequential runs, select an eligible Project Agent, stop a run it initiated, state a blocker, submit a completion claim; each advance records initiator, target Agent, reason, and content version | **Partial** | Sequential runs exist (`advanceRun`); a single assigned agent exists (`assignedAgentId`); a run can be stopped through `POST /api/runs/:id/stop`; `blockerReason` exists | No lead role, no initiator/reason audit, no content version, and stop is not authority-scoped (any caller may stop any run) |
| T8 | Versioned Human changes: each change creates an auditable content version; a run keeps the version it received; the next run receives the latest; changing content does not start/stop/invalidate a run | **Missing** | `PATCH /api/tasks/:id` mutates the single current Task row; there is no version record and no per-run version capture | ADR-0006 "Versioned Human changes" |
| T9 | Bound Environment instance is not editable; continuing elsewhere requires Task end plus a new proposal | **Implemented / reusable** | `environmentInstanceId` is set only at begin and `advanceRun` requires an active lease whose task/instance match (`src/task/environment-lifecycle.ts:161`) | — |
| T10 | Two-stage pause: first Pause is an admission hold letting the current run settle; then Interrupt requests an intentional Agent run stop | **Missing** | `grep -i pause` in `src` returns 0. There is no admission hold; `TaskStatus` has no paused value | ADR-0006 "Pause and Agent run stop" |
| T11 | An intentional Agent run stop settles as `stopped` and keeps the Task lease; unexpected loss settles as `interrupted` and enters recovery; the actor/source is durable | **Partial** | Unexpected interruption is implemented (`AgentRunStatus 'interrupted'`, `#toRecovery`) and the lease is retained; a deliberate `/api/runs/:id/stop` settles the run as `interrupted` at the run layer and leaves the Task in `running` | No `stopped` run outcome exists (`AgentRunStatus` = queued/running/completed/failed/interrupted, `src/run/model.ts:6`), no actor, and no Task-side projection of a deliberate stop |
| T12 | A blocker must record reason, required next action, responsible actor or external condition, and who advances when it clears; blocked Tasks keep the lease | **Partial** | `Task.blockerReason` (free text) is set on a failed/interrupted run and the lease is retained; `PATCH` can set/clear it | Only a prose reason exists; required-next-action, responsible actor, and advancing actor are absent. `CONTEXT.md` explicitly rejects a prose-only blocker |
| T13 | Completion claim: fact-form outcome summary, validation evidence, durable changes, known limitations/risks, proposed disposition; excludes private reasoning and transcripts; awaits Human validation with the lease held | **Partial** | `POST /api/tasks/:id/validation` enters `awaiting-validation` while the lease is held (`environment-lifecycle.test.ts` "worker channel loss enters owner recovery and validation retains the Task lease"); the last run's bounded summary is recorded as `TaskRunSummary` | No claim object, no evidence fields, no disposition, and entering validation is not tied to a lead's claim |
| T14 | Human validation: accept the claim or record a correction; correction returns to deliberate advancement on the same instance and lease; acceptance starts Task end; completed only after context recycle and release | **Partial** | `end` recycles then releases atomically (`saveTerminalWithLease`); recovery preserves the intended disposition; `PATCH status` is refused once a lifecycle exists | No validation/correction decision, no claim to accept, and no correction path |
| T15 | Task discard: abandon a begun Task, authorise normal Task end toward cancellation, preserve the Project workspace | **Implemented / reusable** | `POST /api/tasks/:id/recovery` `action: 'discard'` → `#recycleThenRelease(task,'discarded')`; Worker recycle refuses foreign files and proves the Project sentinel (`src/worker/workspace.ts:57`) | Human authority is not checked (same as T4) |
| T16 | Task end recycles only the Task context directory; the Project workspace, repository, IDE state, and caches persist | **Implemented / reusable** | `WorkerWorkspace.recycle` removes only `.sprout/tasks/<task>`; tests `src/worker/workspace.test.ts` | — |
| T17 | Recovery: only a Human chooses Resume or Discard; recovery during begin retries preparation; after a nested-run interruption it returns to blocked/paused, never an automatic rerun; recovery during end can only finish that end | **Implemented / reusable** | `recover(taskId, 'resume'|'discard')` implements exactly those branches (`src/task/environment-lifecycle.ts:234`); `src/task/environment-lifecycle.test.ts` covers begin/end/run interruption across real SQLite restarts | Human authority is not checked |
| T18 | Force Release: Human-only emergency override available only for a lease already in recovery; records actor, time, reason, unresolved facts, affected Environment/lease/Task/runs; performs emergency Task end, records `cancelled` with permanent `forced release` disposition; never deletes the Project workspace | **Missing** | 0 matches for `forceRelease` / `force release` in `src` | ADR-0009 "Human-only emergency Force Release"; ADR-0006 recovery section |
| T19 | No automatic terminal Task `failed`; failures leave unfinished work blocked or recovering | **Partial** | `TaskStatus` includes `failed` and `PATCH` can set it; the lifecycle path uses `blocked`/`recovery` | The generic Task status vocabulary still permits an automatic-looking `failed`; ADR-0006 says there is no automatic terminal `failed` outcome |
| T20 | Three lifecycles presented separately: Task (proposed…withdrawn), Agent run (queued…interrupted), Task lease (none…released) | **Partial** | Task states map to `environmentLifecycleState` + `TaskStatus`; run states match the ADR exactly (`src/run/model.ts:6`); lease states are `active/recovering/expired/released` | Task vocabulary has no `proposed`, `Task pause requested`, `paused`, `awaiting validation`, `rejected`, `withdrawn`; lease vocabulary has no `none/acquiring/held/releasing` (it uses `active/expired`) |
| T21 | Every proposal, revision, authority decision, run request/settlement, pause, stop, resume, blocker, claim, validation, correction, end, and recovery records actor, time, reason/input, content version, and identifiers | **Missing** | `createdAt`/`updatedAt`/`completedAt` and `TaskRunLink.linkedAt` exist; `TaskRunSummary.recordedAt` exists | No actor, reason, or versioned audit record anywhere |
| T22 | One active Task lease per Environment instance; a recovering lease blocks reassignment until explicitly resolved | **Implemented / reusable** | `EnvironmentPool.#lease` returns a recovery/active lease and conflicts acquisition (`src/environment/pool.ts:344`); `src/environment/pool.test.ts`, `src/run/recovery.test.ts` (real SIGKILL restart) | — |

### 4.6 Environment enrollment, health, and recovery

Obligations: ADR-0009 (all sections), ADR-0003, ADR-0004; #47 enrollment
research; roadmap M2-O4. Prototype artifact
`docs/prototype-environments-recovery.md`.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| E1 | Enrollment: Human-approved binding of one Environment instance, one Sprout instance, and a Worker identity whose private key stays on the host; independent of connectivity, compatibility, engine readiness, and Project access | **Missing** | Environments are compile-time/host-config objects (`src/main.ts:165`–`196`); `runtime-config.ts` parses only Agents and one Project. No enrollment record, identity, key, or approval exists | ADR-0008 "Environment enrollment"; ADR-0009; #47 |
| E2 | Web creates a short-lived pending enrollment; host bootstrap proves key possession; the Web presents identity, platform, protocol, requested capability permissions, and neutral engine facts; one Human approval action; duplicate/revoked Workers need explicit reset | **Missing** | The three carriers start workers from host config only; no pending-enrollment route or state | ADR-0008; #47 |
| E3 | Adding an Environment to a Project is the Human grant of access; in the same action accept the Worker default workspace or select a repository beneath the Worker root; Worker validates before the binding is recorded atomically | **Partial** | `Project.availableEnvironmentInstanceIds` + optional `workspaces` express access and a relative path; the Worker resolves/validates it (`src/worker/workspace.ts:104`) | There is no operation to add an Environment, no Worker-validated selection response, and no atomic record-then-bind |
| E4 | Absolute host paths and engine credentials never enter portable identity | **Implemented / reusable** | `ProjectWorkspace.path` is Worker-root-relative and validated; `AgentDefinition` carries no path or credential; no environment variable carrying a credential is read by the core | — |
| E5 | Six independent Environment health facts: enrollment, connection (`never connected/online/reconnecting/offline` + last confirmed time/age), compatibility (`unknown/compatible/incompatible`), each capability's permission, each engine's readiness (`ready/login-required/missing/unknown`), work safety (`clear/reconciling/recovery`) | **Missing (mostly)** | `WorkerInfo` carries `pid`, `environmentInstanceId`, and engine descriptions; `GET /api/leases` exposes work safety for run-held leases and `Task.environmentLifecycleState`/`recoveryState` for Task-held leases | Enrollment, connection, compatibility, capability permission, and engine readiness facts do not exist. Required by ADR-0009 "Environment health is a summary plus independent facts" and roadmap M2-O4 |
| E6 | One prominent traffic-light summary with a mandatory text reason; colour never carries the distinction alone | **Missing** | No health aggregation and no Environment view in the production Web client | ADR-0009; prototype `docs/prototype-environments-recovery.md` §2 |
| E7 | Protocol version negotiation; an incompatible Worker keeps enrollment but blocks new work with host-local update guidance; Sprout never guesses across an unsupported range | **Missing** | `WorkerInfo` has no protocol version and the handshake performs no negotiation | ADR-0009 "Disconnect, reconnect, and version mismatch" |
| E8 | Authenticated reconnect for the same Worker identity that re-checks revocation, compatibility, permission, and readiness; automatic, no second Human approval | **Partial** | `WorkerSupervisor` lazily restarts a dead worker and replaces it before the next run (ADR-0003), and `EnvironmentWorkerRegistry` refuses an instance mismatch | There is no Worker identity to re-authenticate and no revocation, compatibility, or permission re-check |
| E9 | Revocation prevents new commands and future authentication; restoring requires fresh enrollment | **Missing** | None | ADR-0009 |
| E10 | On channel loss during a run the Worker stops accepting commands, attempts to interrupt the engine turn, and retains events/settlement evidence for reconciliation; Sprout shows an unsettled outcome, protects the lease, admits no replacement work, never auto-replays | **Partial** | On transport close the Worker closes every live session (`src/worker/server.ts` `shutdown`); `WorkerClient` fails the in-flight turn with `environment worker channel closed` (`src/worker/client.ts:258`); `TaskEnvironmentLifecycle.isWorkerLoss` maps that text into retained-lease recovery (`src/task/environment-lifecycle.ts:354`) | The interruption is a string-matching heuristic on the failure message rather than a protocol fact; there is no retained-evidence sync, no reconciliation exchange on reconnect, and no per-lease "unsettled outcome" record |
| E11 | Normal release evidence: same authenticated Worker synced its retained events, proved the old engine session stopped (or completed a local fence/reset), the interrupted run has a visible explainable terminal outcome with nothing pending, and the Human made the lease-holder decision | **Partial** | A run-held lease can be released explicitly through `POST /api/runs/:id/release-lease` after a restart, and a Task-held lease only through Task recovery; tests `src/run/recovery.test.ts`, `src/web/api.test.ts` "a recovered run lease can be explicitly released through its run control" | No Worker evidence sync, no engine-stopped proof, and no recorded decision; the release route accepts any caller |
| E12 | Force Release is Human-only, only for a lease already in recovery, records the acknowledged risks and unresolved facts, releases the run-held lease with an incomplete-events warning, or performs an emergency Task end to `cancelled` with a permanent forced-release disposition; the Environment becomes assignable again | **Missing** | None | ADR-0009; ADR-0006 |
| E13 | One operator identity, browser sessions, loopback or operator-managed private network, no public exposure, credentials initialised/recovered on the host with no default, session list and per-session / revoke-all-other revocation | **Missing** | No auth middleware, cookie, or session. `src/web/api.ts` serves every route to any caller; `web/src/main.ts:132` hard-codes the operator id | ADR-0009 "One operator and one private Web boundary" |
| E14 | Host-local setup vs routine Web operation boundary (install/update, OS user, engine login, Worker key/overlay/firewall, startup registration, identity reset, offline diagnostics stay host-local; everything else Web) | **Partial** | All host facts are `SPROUT_*` environment variables read in `src/main.ts`, `src/worker/main.ts`, and the carriers | Runtime JSON/environment editing *is* the only configuration path today; no Web operation exists for any of the routine list |
| E15 | No Web restart, drain, maintenance mode, or scheduled restart | **Implemented / reusable** (by absence) | No such route exists | — |
| E16 | Ordinary same-version restart preserves all durable product state; recovery never depends on a backup | **Implemented / reusable** | SQLite persistence plus `reconcileOrphanedRuns` and `tasks.reconcileEnvironmentLifecycle`; `src/run/recovery.test.ts` uses real process kill/restart | — |
| E17 | Schema safety: each released build declares supported schema versions, can migrate forward from the immediately preceding released schema, refuses too-new or too-old stores with host-local guidance; each migration is transactional and tested; a consistent pre-migration safety copy is created before changing a non-empty store, and failure prevents startup serving partial state | **Missing** | Only additive `#addColumnIfMissing` calls; no version, no refusal, no safety copy, no transactional migration protocol | ADR-0009 "Restart durability, schema migration, and backup boundary" |
| E18 | Sanitized diagnostics: Web health + export of versions, startup/migration outcomes, connection/compatibility/capability/readiness facts, Task/run/lease outcomes, recovery causes, times, correlation ids; a host-local diagnostic command when Web is unavailable; startup/migration/enrollment/connection/interruption/reconciliation/recovery/release are compact durable operational events; repeated heartbeats are not permanent history; exports never contain credentials, tokens, hostnames, addresses, absolute paths, Message/prompt content, reasoning, commands, tool output, or raw stderr | **Missing** | Logs go to `process.stderr` (`src/main.ts`, `src/worker/server.ts` `onLog`); no operational-event record, no export route, no redaction boundary, no host-local diagnostic command | ADR-0009 "Sanitized operational diagnostics" |
| E19 | Public-Internet deployment, multi-Human identity/SSO, HA/failover, managed DNS/certs/proxies, scheduled backup/restore/DR, centralized observability, unattended system-level Worker | **Outside M2** | — | `docs/roadmap.md` M2 non-goals; ADR-0009 "Production deployment governance is later work" |

### 4.7 Agent identity and work options

Obligations: ADR-0008 "Portable Agent configuration", "Editing, history, archive,
and revocation". Roadmap M2-O1. Prototype artifact
`docs/prototype-agent-identity.md`.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| A1 | Agent is a portable identity independent of Project and Environment, with a stable id and non-empty display name | **Implemented / needs cleanup** | `AgentDefinition` (`src/agent/registry.ts:13`); `AgentRegistry` is constructed once in `src/main.ts:240` (`new AgentRegistry(agents)`) from `SPROUT_RUNTIME_CONFIG`; no test imports `src/main.ts` | Identity exists but the registry has no mutation path (`AgentRegistry` exposes only `get`/`list`; construction is the only write) and no durable store: Agents are re-read from runtime JSON on every start |
| A2 | Agent requires **at least one ordered Agent work option**, each an `{engine, work model, effort}` triple; the list may span Codex and Pi | **Missing** | `AgentDefinition` has a single `engine`, `model?`, `effort?` (`src/agent/registry.ts:17`–`22`); no ordered list, no per-option identity | ADR-0008 "Portable Agent configuration" |
| A3 | At run admission Sprout picks the first option whose engine is permitted and authenticated and whose model is available on the selected Environment instance; it may advance only **before** an engine accepts the run, and never replays automatically after acceptance | **Implemented / needs cleanup (single-option form)** | `RunOrchestrator.#execute` resolves one adapter, and its only retry is the ADR-0004 `resumeRefused` fresh-session retry (`src/run/orchestrator.ts:636`), which explicitly is not a model fallback | The ordered-option selection loop does not exist. The *no-silent-replay* discipline does, and must be preserved |
| A4 | Every run records the actual Agent configuration version, engine, work model, and effort it used | **Partial** | `AgentRun` records `agentId` and `environmentInstanceId`; the engine used is derivable only from the Agent record, and `TaskRunLink` records `agentId` | No configuration version, no per-run engine/model/effort capture (required for ADR-0010 Attribution and the Agent view) |
| A5 | Reorder/add/remove options affects later runs only, preserves earlier run facts and sessions, and can never leave an Agent with no option | **Missing** | No mutation operation | ADR-0008 |
| A6 | Non-destructive Agent archive/restore: refused during an active run or while the Agent is the lead of an unfinished Task; archive prevents new membership, Messages, and runs while preserving private memory, memberships, sessions, and attribution; restore does not recreate ended memberships | **Missing** | `grep` for archive in `src` returns nothing | ADR-0008 "Editing, history, archive, and revocation" |
| A7 | Membership-specific responsibilities and collaboration instructions are optional and do not leak into global identity | **Implemented / reusable** | `ProjectMembership` (`src/project/model.ts:13`) consumed by `assembleProjectContract`; `renderProjectContract` prints them separately from `agentInstructions` | — |

### 4.8 Usage observations and cost

Obligations: ADR-0010 (all sections), roadmap M2-O5, and the version-pinned
telemetry research `docs/research/codex-pi-usage-cost-telemetry.md`.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| U1 | Usage activity: an Agent run is the primary activity; a routing attempt is also an activity that belongs to its Project and never to an Agent or Task | **Partial** | `AgentRun` is the activity carrier. Routing attempts are not modelled as activities; a wake-model call does not even exist yet (R12) | ADR-0010 "Usage activities and attribution" |
| U2 | Detailed durable run token facts: total input, uncached input when unambiguous, cached-input reads, cache-write input, output, reasoning-output detail, engine/provider total; each `complete`/`partial`/`unavailable`; failed/stopped/interrupted runs retain earlier trustworthy usage; absence is not zero | **Partial, shallow** | `TokenUsage{promptTokens,completionTokens,totalTokens}` (`src/engine/port.ts:113`), persisted in `agent_runs.token_usage` (`src/run/sqlite-store.ts:70`) and asserted by `src/run/sqlite-store.test.ts` "token usage survives a SQLite restart" and `src/web/api.test.ts` "run detail and history expose token usage" | Only three undifferentiated fields; no cache, reasoning, or coverage status. ADR-0010 explicitly calls the three-field seam insufficient |
| U3 | Codex uses the per-turn `last` usage correlated by turn identity, never the resumed thread's cumulative total | **Implemented / reusable** | `readCodexTokenUsage` reads `tokenUsage.last`, keyed by `turnId` (`src/engine/codex.ts:398`–`424`) | The reasoning-output mapping must be fixed per ADR-0010 consequences |
| U4 | Pi counts each final usage-bearing provider call once, never cumulative streaming updates | **Implemented / reusable** | `pendingMessageUsage` is folded into the run total only when the assistant message ends (`src/engine/pi-protocol.ts:27`, `:231`) | — |
| U5 | Sprout wall duration is authoritative and separate from engine-native duration and from Task calendar elapsed time; Task view names the sum of run wall durations separately from calendar elapsed | **Partial** | `AgentRun.createdAt`/`completedAt` exist; `summarizeRunHistory` sums terminal run elapsed time (`src/web/api.ts`) | No stored duration fact, no engine-native duration, no Task calendar elapsed, no Task aggregate |
| U6 | Attributable billed cost is a distinct fact and is `unavailable` for the measured Codex and Pi per-run interfaces | **Missing** | None | ADR-0010 "Billed cost and API-equivalent estimates are different facts" |
| U7 | API-equivalent estimate with status `pending`/`available`/`unavailable` and, when available, a provenance of `provider_estimated`/`harness_calculated`/`locally_estimated` | **Missing** | No cost field anywhere; Pi's emitted `usage.cost` is not read (grep `cost` in `src/engine/pi-protocol.ts` returns nothing) | ADR-0010; `docs/research/codex-pi-usage-cost-telemetry.md` |
| U8 | Billing basis `metered_api`/`subscription_included`/`unknown`, orthogonal to provenance; a subscription run's billed cost stays unavailable and is never zero | **Missing** | None | ADR-0010 |
| U9 | Integer USD micros normalization; provider quota units (e.g. Codex credits) are neither stored nor converted nor combined | **Missing** | None | ADR-0010 |
| U10 | Append-only observation history: delayed facts append to the activity by identity; corrections append source, reason, time, and the superseded fact; the current view selects the effective observation while retaining every prior value and selection transition; `pending` → `unavailable` with a durable reason, or later → `available` | **Missing** | `token_usage` is a single mutable column overwritten on every `save` | ADR-0010 "Delayed observations and corrections are append-only" |
| U11 | No Human editor for token values, monetary estimates, or billed cost in M2 | **Implemented / reusable** (by absence) | No such route exists | — |
| U12 | Six required views (Agent run, Task, Project, Agent, Model, Time range) with the settled scopes, drill-down, coverage, provenance subtotals, and mixed-provenance labelling | **Missing** | `GET /api/runs` returns a flat run list plus `summarizeRunHistory` totals; no Task/Project/Agent/Model/time-range aggregate and no coverage semantics | ADR-0010 "Required views"; roadmap M2-O5 |
| U13 | Aggregation semantics: settled activity belongs to its terminal-settlement range; in-progress activities are provisional and separate; delayed corrections update the original range and mark it updated; no proration across a boundary; half-open ranges with an explicit display time zone; aggregates sum available observations, never substitute zero, and expose activity count plus coverage | **Missing** | `summarizeRunHistory` sums all returned runs including non-terminal durations of zero and reports only `completedRunCount`/`runsWithTokenUsage` | ADR-0010 "Time-range and aggregation semantics" |
| U14 | Budgets, spending targets, threshold alerts, run-admission limits, automatic stops, billing import, and operator financial adjustments | **Outside M2** | — | `docs/roadmap.md`; ADR-0010 "Observability, not spending control" and "Product-surface boundary" |

### 4.9 Operator settings and self-hosted operation

Obligations: ADR-0009; prototype artifact `docs/prototype-settings-operator.md`
(the accepted three-category structure Access & Security / Instance & System /
Data & Diagnostics).

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| O1 | Instance/protocol/schema version facts and supported range, with a compatibility verdict and reason | **Missing** | None | ADR-0009; `docs/prototype-settings-operator.md` §2 |
| O2 | Migration state, safety-copy state, startup-blocked flag, and host guidance | **Missing** | None (see E17) | ADR-0009 |
| O3 | Durable-data location guidance, component list, and the "migration guard is not a backup" boundary | **Missing** | `SPROUT_DATABASE` names one file; no guidance surface | ADR-0009 |
| O4 | Diagnostics state, included/excluded fact lists, and host-local fallback | **Missing** | None (see E18) | ADR-0009 |
| O5 | General Settings: theme, density, phone/desktop viewport mode, navigation/return-context behaviour | **Outside M2 backend** | These are prototype presentation state (`web/src/prototype/types.ts` `ThemeMode`, `DensityMode`, `ViewportMode`) | These are Web-foundation concerns owned by ADR-0011 and ticket #72, not backend obligations |
| O6 | Environment recovery and Force Release live in Manage / Environments, not Settings | **Missing** | No Environment surface exists; Force Release absent (E12) | `docs/prototype-settings-operator.md` §1, §5 |
| O7 | No Web restart/maintenance/drain control; no backup/restore orchestration; no multi-Human authorisation | **Implemented / reusable** (by absence) | None exists | ADR-0009 |

### 4.10 Mobile/desktop presentation obligations

Obligations: ADR-0009 "The Web experience has mobile and desktop capability
parity", ADR-0011, roadmap M2-O6, and the #61–#68 structural baseline. The
preserve/rewrite/remove contract is ticket #72's artifact
(`docs/research/production-web-structural-baseline.md`); this section records only
**backend facts the presentation depends on**, because those are what the M2
backend gap determines.

| # | Settled obligation | Class | M1 evidence | Absent / required by |
| --- | --- | --- | --- | --- |
| N1 | One Web product with full mobile and desktop capability parity; mobile is a complete operating surface, not a read-only view | **Missing** | `web/src/style.css` (503 lines) contains **zero** `@media` queries; `web/index.html` is a single unscaled page; the responsive shell exists only in the retained prototype | ADR-0011; roadmap M2-O6 |
| N2 | Preserve the accepted structural baseline (Shell, Feed, Project, Task, Chat, Environments, Agents, Usage, Settings) through production Module interfaces | **Missing (backend-dependent rows)** | Production serves only the M1 page plus the prototype bundle; the Feed, Chat scopes, Environments, Agents, Settings, and Usage surfaces have no production route or view | ADR-0011; ticket #72's matrix; each missing row above is the backend prerequisite |
| N3 | A browser that cannot reach the instance may show last observed state as stale, but no offline command queue and no control action until reconnect | **Partial** | `EventSource` reconnects by browser default; there is no stale indicator and no client-side command queue | ADR-0009 |
| N4 | Every monetary value remains inspectably labelled as billed / provider-estimated / harness-calculated / locally estimated / pending / unavailable; a known subtotal never hides unknown activities | **Missing** | Nothing to label (U6–U8) | ADR-0010 "Product-surface boundary" |
| N5 | Status is never colour-only in any surface | **Partial** | The M1 client uses text statuses; no traffic light exists yet | ADR-0009; prototype baseline §5 |

---

## 5. Where the browser prototype simulates backend authority

`web/src/prototype/state.ts` is a 6,795-line fixture `StateManager` with 103
public methods. The rows below pair a representative prototype method with the
backend authority it pretends to hold and the M1 production source that does not
exist. **No production capability may be inferred from any of these.**

| Prototype method (state.ts) | Authority simulated | Production reality |
| --- | --- | --- |
| `approveEnvironmentEnrollment` (6349), `unenrollEnvironment` (6373), `archiveEnvironment` (6389), `restoreEnvironment` (6405) | Environment enrollment lifecycle with Human approval | No enrollment fact exists (E1, E2) |
| `simulateRegisterNewPendingHost` (6521) | Host bootstrap creating a pending identity | No bootstrap channel exists (E2) |
| `triggerReadinessProbe` (6432), `toggleCapabilityPermission` (6415) | Worker readiness probe and capability permission | No readiness or permission fact exists (E5) |
| `triggerSimulatedWorkerDisconnect` (4822), `triggerSimulatedWorkerReconnect` (6457), `reconcileEnvironmentEvidence` (6474) | Reconnect with retained reconciliation evidence | Only a lazy worker restart and a failure-string heuristic exist (E8, E10) |
| `emergencyForceRelease` (4950) | Human-only Force Release with risk acknowledgement | Nothing exists (E12) |
| `createTaskProposal` (6061), `rejectTaskProposal` (6153) | Proposal lifecycle and rejection | `POST /api/tasks` creates directly; no proposal (T2) |
| `approveAndBeginProposal` (4313) | Human approve-and-begin authority | `begin` performs no authority check (T4) |
| `pauseTask` (4374), `interruptActiveRun` (4465), `resumeTask` (4503) | Two-stage pause then Interrupt | No pause exists; `stop` is unconditional (T10, T11) |
| `simulateLeadAutonomousRun` (6165), `submitTaskCompletionClaim` (6234) | Task-lead autonomy and completion claim | No lead or claim object exists (T7, T13) |
| `updateTaskContentVersion` (4536) | Versioned Task content with per-run version capture | `PATCH` mutates one row (T8) |
| `validateTaskCompletion` (4656), `resolveBlocker` (4607), `discardTask` (4782) | Validation, routable blocker resolution, discard | No validation decision; blocker is free text; discard exists (T12–T15) |
| `resumeOrdinaryRecovery` (4904) | Human resume from recovery | Exists and is the one prototype lifecycle with real backend parity (T17) |
| `setProjectWakePolicy` (5419) | Per-Project wake policy | No policy exists (R8) |
| `sendMessage` (5211) routing branch | Six-step routing pipeline with dispositions, deterministic fan-out, batch creation, fail-closed | Production is per-Message immediate wake with fail-open (R8–R15) |
| `createWorkingGroup` (5430), `disbandWorkingGroup` (5476), `restoreWorkingGroup` (5492) | Working group lifecycle and channel | Nothing exists (W1–W3) |
| `createProject` (5553), `updateProjectContract` (5656), `archiveProject` (5676), `restoreProject` (5716) | Project CRUD, template snapshot, archive | No create/archive operation (P5–P8) |
| `addProjectMembership` (5786), `editProjectMembership` (5833), `endProjectMembership` (5854), `restoreProjectMembership` (5915) | Membership lifecycle with Human authority | Membership is a read-only array in a config file (P4, M2) |
| `bindEnvironmentToProject` (5966), `switchProjectWorkspacePath` (6005), `unbindEnvironmentFromProject` (6037) | Environment–Project binding and workspace switching | Binding is static config (E3, P11) |
| `createAgent` (3654), `addAgentWorkOption` (3739), `removeAgentWorkOption` (3774), `reorderAgentWorkOptions` (3808), `archiveAgent` (3837) | Agent identity, ordered work options, archive | Agents come from runtime JSON; no mutation, no option list (A2, A5, A6) |
| `evaluateAdmissionFallback` (3897), `evaluateTaskAdmission` (4030) | Ordered-option fallback and admission evaluation | Single hard-coded option (A2, A3) |
| `revokeBrowserSession` (3156), `rotateOperatorCredential` (3172), `revokeOtherBrowserSessions` (3148) | Operator session and credential management | No authentication at all (E13) |
| `exportSanitizedDiagnostics` (3192) | Redacted diagnostics export | None exists (E18) |
| `markDurableDataLocationCopied` (3198) | Migration safety-copy state | None exists (E17) |
| Usage fixtures in `initialUsageActivities` and the six usage views (`docs/prototype-usage-costs.md`) | Detailed token dimensions, provenance, billed-vs-estimate, coverage, append-only history | Only three mutable token fields exist (U2, U6–U13) |

Prototype state that is *presentation only* and carries no backend obligation is
listed in `docs/research/production-web-structural-baseline.md` §3 (remove
column): prototype harness controls, review drawers, variant switchers, scenario
jumpers, fixture selectors, and Ticket/ADR copy.

---

## 6. Classification rollup

Counting the **117** obligations identified above (rows P1–P11, M1–M3, W1–W7,
R1–R22, T1–T22, E1–E19, A1–A7, U1–U14, O1–O7, N1–N5):

| Class | Count | Row ids |
| --- | --- | --- |
| Implemented / reusable | 26 | M1, P10, R1–R6, R16, R18, R20, R22, T1, T9, T15, T16, T17, T22, E4, E15, E16, A7, U3, U4, U11, O7 |
| Implemented / needs cleanup | 3 | P1, A1, A3 |
| Partial | 29 | P2, P3, P4, P11, R7, R15, R17, R19, T4, T5, T6, T7, T11, T12, T13, T14, T19, T20, E3, E8, E10, E11, E14, A4, U1, U2, U5, N3, N5 |
| Missing | 56 | P5–P9, M2, M3, W1–W7, R8–R14, R21, T2, T3, T8, T10, T18, T21, E1, E2, E5, E6, E7, E9, E12, E13, E17, E18, A2, A5, A6, U6–U10, U12, U13, O1–O4, O6, N1, N2, N4 |
| Outside M2 | 3 | E19, U14, O5 |

3 + 29 + 56 + 26 + 3 = 117. The matrix labels four rows with a qualifier —
`Partial, inverted` for R15, `Partial, shallow` for U2, and `Outside M2 backend`
for O5 — and each is counted here under its base class.

Two structural facts dominate the gap:

1. **The durable write-path discipline is complete and reusable; the product
   authority and observation layers above it are not.** Persistence-before-wake,
   idempotent admission, reply projection, privacy-preserving summaries,
   exclusive lease recovery, and contract/hand-off assembly are all evidenced.
   Nearly every missing row is either (a) a new durable *authority* fact
   (proposal, approval, claim, blocker, content version, enrollment, capability
   permission) or (b) a new durable *observation* fact (routing batch/attempt,
   Environment health, usage observation/correction, operational event).
2. **M1 configuration is still the M2 product interface.** Environment
   definitions, instances, Agents, and the default Project are constructed in
   `src/main.ts` from `SPROUT_*` environment variables and `SPROUT_RUNTIME_CONFIG`
   JSON. There is no write route for any of them, and `ProjectStore.save` has no
   production caller. Most M2-O1 work is therefore "give these existing types
   durable stores, mutation operations, and Human authority", not "invent a
   model".

## 7. Reference repository check (pinned)

Policy: `docs/references.md` (reference-first; record the revision; Sprout
terminology and seams win; no code was copied in this Ticket, so no attribution
header is required).

### 7.1 Paperclip — `352153b5edf02ff4262210c7bd5bfa94bcf37c7c` (MIT)

Observed:

- `doc/spec/agent-runs.md` §9.2 defines `agent_wakeup_requests` with
  `source (timer|assignment|on_demand|automation)`, `trigger_detail`,
  `status (queued|claimed|coalesced|skipped|completed|failed|cancelled)`,
  `coalesced_count`, `requested_by_actor_type/id`, `idempotency_key`, and
  `run_id`.
- `doc/architecture/paperclip-runner.md` specifies a short-lived one-use
  bootstrap ticket exchanged for a connection lease; fail-closed rejection of
  unknown protocol/schema versions; a durable outbox with cumulative server ACK
  and bounded replay; idempotent command IDs; and revocation of runner authority
  on cancellation, timeout, supersession, or environment-lease loss.

**Adopted lessons** (design only):

1. A wake request needs an explicit durable **status vocabulary that includes a
   coalesced/batched state plus a count**, and a **source/trigger** field. This
   independently corroborates ADR-0007's Routing batch and per-input outcome.
2. A durable **idempotency key plus a linked run id** on the wake record is a
   mature shape; M1 already has both and should keep them when the batch identity
   is added.
3. **Fail-closed protocol negotiation with bounded, versioned compatibility**, and
   a **short-lived one-use bootstrap exchanged for a lease**, is the mature answer
   for E2/E7/E8/E9. M1's carriers have no negotiation at all.
4. **Revoking authority on environment-lease loss** matches ADR-0009's
   "protects the lease, admits no replacement work".

**Rejected lessons**:

- Its issue-tree, checkout, heartbeat, and Postgres-centred schema; Sprout has no
  equivalent and ADR-0006 already rejected the heartbeat/checkout shape.
- A separate out-of-process runner package and WebSocket-only transport: ADR-0003
  and ADR-0008 keep carriers as an implementation choice.
- Cloud company/tenant scoping: M2 is single-operator.

### 7.2 Cumora — `ae18eff5d351f9a666984a2a03f13428d8f714fc` (MIT)

Observed:

- `docs/BYOA.md` "Data model": a `computers` registry with `available_engines`,
  `status (online|offline|busy)`, `last_seen_at`, `credential_hash`, `revoked_at`,
  `daemon_version`, and `daemon_supervised`; auth via a device pairing flow.
- `docs/BYOA.md` "The wake → turn lifecycle": a **small-brain triage gate** that
  gets a hard server verdict when no model call is needed, otherwise runs a cheap
  model; on rate-limit/timeout it **fails closed** with escalating backoff. The
  wake stream is Redis→SSE with a durable inbox plus a 20 s poll as an
  SSE-independent safety net.
- Triage spend is reported to a **separate** endpoint from work-model per-hop
  usage, which lands in one universal `llm_calls` ledger.
- `docs/COORDINATION.md` documents per-computer concurrency caps for both the
  work model and the triage model, and the failure mode of capping only one.

**Adopted lessons**:

1. **Deterministic pre-check before any model call** and a **hard verdict path**
   corroborate ADR-0007's deterministic addressing bypass and its
   "no eligible input means no model call".
2. **Separate accounting for the low-cost routing model** is exactly ADR-0010's
   requirement that routing attempts stay distinct from work-model usage; the
   separate report endpoint is a mature shape for it.
3. **Fail-closed on routing-model failure with bounded backoff** matches ADR-0007
   and is the direct counter-example to M1's fail-open (R15).
4. A **durable inbox plus an independent poll** as a safety net for a
   push transport is relevant to ADR-0009's "a browser that cannot reach the
   instance may show stale state" and to restart reconciliation.

**Rejected lessons**:

- Persistent device-token semantics. #47 and ADR-0008 require a short-lived,
  one-use enrollment transaction with explicit reset, so Cumora's token lifecycle
  must not be copied as product policy.
- Redis/SSE scheduler and managed-cloud deployment shape.
- Its messaging-centric IA.

### 7.3 AionUi — `6744099b279b991c17e31c243f0920477bd31cb6` (Apache-2.0)

Observed:

- `docs/guides/hub-testing.md` defines a layered adapter test strategy: a
  minimal **fake ACP JSON-RPC CLI fixture**
  (`tests/fixtures/fake-acp-cli/` supporting `initialize`, `session/new`,
  `session/prompt`, `session/cancel`) drives an install/integration chain with no
  real backend; real backend CLIs are smoke-tested only when an explicit
  environment flag (e.g. `ACP_SMOKE_REAL=1`) is set, and are never run in CI.
- It also carries an `AcpDetector` that reports detected backends and a hot-reload
  path after installing a CLI.

**Adopted lessons**:

1. A **fixture engine CLI plus an env-gated real-engine smoke test** is the
   mature split. Sprout already has the analogue (`src/engine/scripted.ts` for
   deterministic turns and `scripts/live-*.ts` for real engines); the lesson is to
   keep the fixture as the conformance seam when new adapters or Worker protocol
   capabilities are added in M2.
2. Reporting **detected vs runnable engines** as separate facts corroborates
   ADR-0009's "installation, authentication, compatibility, connectivity, and work
   safety" separation and ADR-0008's readiness facts.
3. A hot-reload/detection refresh after a host install is the shape an M2
   "Engine readiness" surface needs.

**Rejected lessons**:

- Its Arco Design component system and Electron shell: already rejected by
  ADR-0011 (externally owned visual language; Sprout is one Web experience).
- Its Hub/extension installation model; Sprout's Environment enrollment is
  Human-approved, not a package hub.

No reference code was copied.

---

## 8. What must not be lost (behaviour-preservation pins for `/to-spec`)

These are implemented behaviours the M2 work consumes. They are listed because
the prototype hides several of them on demand and ADR-0007/0009 forbid turning a
UI simplification into backend scope reduction.

1. Message and wake persistence-before-admission in one transaction
   (`src/collaboration/sqlite-store.ts:93`).
2. `(messageId, agentId)` compare-and-set admission and reply idempotency keys
   (`src/collaboration/store.ts:54`; `coordinator.ts` `replyDeliveryKey`).
3. Non-routing projected replies: only a completed run's final text, never
   events, tool output, or reasoning (R3, R5).
4. Fail-open is an M1 *proof* behaviour, not the M2 contract: ADR-0007 replaces
   it with fail-closed. The durable visibility of the failure outcome must be
   preserved while the direction is inverted.
5. Task-held lease: non-expiring, released only through end/recovery/discard,
   never by a nested run settling (`src/environment/pool.ts:282`–`303`).
6. Worker-owned Task context with the ownership marker, Project sentinel check,
   and foreign-file refusal (`src/worker/workspace.ts:57`–`85`).
7. ADR-0004 session-key identity tuple and the "never assume resumption
   succeeded" rule, including the single fresh retry gated on
   `resumeRefused` only.
8. Contract assembly and hand-off determinism, including the privacy rule that a
   hand-off carries bounded fact-form summaries only.
9. Root-free privacy: no host path, credential, hostname, or private network fact
   in any portable record or API payload.
10. The 22 existing HTTP routes and their status classes, the SSE contract, and
    the Worker protocol method/notification/error-code set. #71 lists these as a
    contract; M2 adds routes rather than changing them.

---

## 9. Follow-ups for the specification (facts, not design)

Ordered so each item's prerequisite is settled.

1. **Decide the specification's obligation list from the ADRs, not from M1.** The
   missing rows above are required by settled decisions; several (Working groups,
   Force Release, routing batches, enrollment, operator identity, usage
   observation history, schema migration) have no M1 counterpart at all and must
   be specified, not assumed.
2. **Treat the durable-authority facts as a first-class specification group.**
   Proposal, approval, Task content version, blocker, completion claim,
   validation decision, membership lifecycle, enrollment, capability permission,
   and operational event are all "record an authority fact and its actor/time/
   reason" problems with no M1 implementation.
3. **Treat the observation facts as a second group.** Routing batch/attempt,
   per-input routing outcome, usage observation/correction, Environment health
   dimensions, and the traffic-light projection share the same shape.
4. **Reuse the M1 write-path seams where the matrix says Implemented.** The
   coordinator's persist-then-admit order, the lease state machine, the Task
   lifecycle's transactional begin/end, the Worker workspace boundary, and the
   engine port need extension points, not replacement.
5. **Carry #71's cleanup classifications into the spec only as far as they
   remove obstruction.** P1/A1/A3 and the Web/worker composition are the only
   "Implemented / needs cleanup" rows, and none requires a behaviour change.
6. **Decide the storage and migration story before any new durable fact is
   specified.** Today there is no schema version, no refusal, and no safety copy
   (E17); adding ~20 new durable facts without that boundary contradicts
   ADR-0009.
7. **Decide the single-operator authentication boundary before any Human
   authority check is specified.** Every "Human only" row (T4, T15, T17, T18,
   E12, E13) is currently unenforceable, because the API has no caller identity.
8. **Keep the reference lessons recorded here.** In particular: Paperclip's
   protocol negotiation and lease-bound authority for E7–E9; Cumora's
   deterministic pre-check, separate routing-model accounting, and fail-closed
   backoff for R8–R15 and U1; AionUi's fixture-plus-env-gated-smoke split for
   future adapter/Worker work.

## New fog exposed by this Ticket

- **Human identity on the wire is unspecified.** ADR-0009 settles one operator
  identity and browser sessions, but no decision states how a request carries
  that identity into a domain authority check, nor how an Agent-authored Message
  or Task action is distinguished from a Human one at the API boundary
  (`CONTEXT.md` distinguishes them; the wire does not).
- **Project-event producers are unspecified.** ADR-0007 requires every
  system-produced Project event to declare a routing disposition, but no
  decision names which M2 subsystems produce Project events, nor how a producer
  declares one.
- **The routing-model telemetry contract is open.** ADR-0010 records that
  wake-model telemetry was not measured by #45 and is follow-up research; until
  it exists, the routing side of every usage view is a coverage gap by
  construction.
- **Where Human notification lives is outside the settled decisions.**
  ADR-0007 explicitly excludes Human notification semantics from deterministic
  addressing; the Feed/attention surface (prototype #62) presents
  human-action-required items, so a spec author cannot connect the two without a
  new decision.
