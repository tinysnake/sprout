# M1 foundation cleanup: behaviour-preserving seams

**Status**: Research recommendation for ticket #71 (part of map #70)
**Scope**: M1 composition root, Web transport, and store/service ownership
**Fixed base**: `ea0c660cff96d2845aab492305085a9e2739a348`
**Prototype/implementation code**: inspected only; nothing is refactored by this ticket.

This document inventories the production Module graph rooted at `src/main.ts`,
classifies its seams by dependency kind, states the observable
behaviour-preservation contract, names the Modules that must not be touched, and
recommends the smallest ordered cleanup sequence that gives concrete M2-path
leverage. It deliberately does not implement the cleanup.

M1 is implemented and evidenced (M1 status: Evidenced on `docs/roadmap.md`). No
product behaviour, schema, HTTP interface, Worker protocol, or lifecycle change is
proposed. No candidate is justified by line count alone; each names the M2
outcome it unblocks.

## 1. Method

- Walked the production dependency graph from `src/main.ts` with imports only
  (test files excluded), then read each Module body and its tests.
- Classified each seam with the dependency kinds of the deep-Module vocabulary:
  in-process, local-substitutable (SQLite), remote-but-owned (Worker process and
  network), and true external (engine CLIs).
- Used the deletion test on each candidate: if deleting it would only remove
  indirection, it is a pass-through; if complexity reappears across callers, it
  earns its keep.
- Ran the current baseline checks before drawing conclusions (section 2).
- Consulted the standing references at pinned revisions (section 9).

## 2. Baseline evidence (recorded before any change)

Environment: Node `v26.7.0`, npm `11.19.0`, Vite `7.3.6`, TypeScript `5.9.3`.
Worktree was clean and dependencies were absent, so `npm ci` ran first (55
packages).

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | 55 packages added, no errors |
| Typecheck | `npm run typecheck` | Pass (`tsc --noEmit` for core and Web) |
| Full tests | `npm test` | `tests 523 / pass 523 / fail 0`, 0 cancelled/skipped/todo |
| Web build | `npm run web:build` | Pass; `dist/index.html` 4.92 kB, main JS 18.13 kB, prototype JS 561.84 kB |
| Whitespace/diff | `git diff --check` | Clean |
| Web API contract | `node --test src/web/api.test.ts src/web/api-tasks.test.ts` | `tests 37 / pass 37 / fail 0` |
| Orchestrator, Worker, recovery, lifecycle, collaboration | `node --test src/worker/worker.test.ts src/worker/carrier.test.ts src/worker/supervisor.test.ts src/run/orchestrator.test.ts src/run/recovery.test.ts src/run/session-continuation.test.ts src/task/environment-lifecycle.test.ts src/collaboration/integration.test.ts` | `tests 90 / pass 90 / fail 0` |
| Engine adapters + Worker | `node --test src/engine/*.test.ts src/worker/*.test.ts` | `tests 164 / pass 164 / fail 0` |
| Stores | `node --test src/run/sqlite-store.test.ts src/task/store.test.ts src/collaboration/sqlite-store.test.ts src/run/session-key-store.test.ts` | `tests 46 / pass 46 / fail 0` |

The Web build emits a `chunks are larger than 500 kB` warning for the retained
prototype bundle; it is pre-existing and unrelated to M1 core.

Scale for orientation (production lines, tests excluded): `src` totals 13,432
lines across 56 files with 51 test files; `web/src` production code is 18,951
lines, of which `web/src/prototype/` is 17,784 and the retained plain-DOM client
is 1,167 (`main.ts` 1,062, `task-controls.ts` 93, `recipient-refresh.ts` 12).

## 3. Production Module graph rooted at `src/main.ts`

`src/main.ts` (401 lines) is a flat top-level script. Its imports name every
production subsystem in one place:

```
src/main.ts
├── runtime-config.ts            (SPROUT_RUNTIME_CONFIG → RuntimeConfiguration)
├── agent/registry.ts            (AgentRegistry, AgentDefinition)
├── environment/model.ts         (EnvironmentDefinition, EnvironmentInstance)
├── environment/pool.ts          (EnvironmentPool, LeaseStore)
├── environment/container.ts     (DockerRuntime, containerEnvironmentDefinition)
├── project/model.ts             (Project)
├── project/registry.ts          (ProjectRegistry, loads ProjectStore)
├── run/orchestrator.ts          (RunOrchestrator)
├── run/sqlite-store.ts          (SqliteStore, and 4 other Sqlite* stores)
├── collaboration/coordinator.ts (CollaborationCoordinator)
├── task/service.ts              (TaskService)
├── task/environment-lifecycle.ts(TaskEnvironmentLifecycle)
├── web/api.ts                   (createRunApi)
└── worker/
    ├── carrier.ts               (EndpointCarrier, WorkerConnection)
    ├── container-carrier.ts     (ContainerCarrier)
    ├── windows-carrier.ts       (SshTunnelCarrier, readWindowsReadyFile)
    └── supervisor.ts            (EnvironmentWorkerRegistry)
```

The graph beneath those entry points is layered and acyclic in the important
direction: `engine/port.ts` sits at the bottom; `worker/protocol.ts` re-expresses
that port over JSON-RPC; `worker/{client,server,carrier,supervisor}.ts` carry it;
`run/orchestrator.ts` consumes the port and the lease registry; `task/` and
`collaboration/` sit on top of the run seam; `web/api.ts` sits on top of all
three; `src/main.ts` composes them.

Two dependency facts matter for every candidate below:

- **The run seam is one-way.** `run/task-link.ts` is the only surface between the
  run layer and the Task domain: `TaskContextProvider` (two methods) and
  `TaskRunObserver` (one function type). The collaborate coordinator likewise
  depends on `RunOrchestrator` through the narrow `RunAdmitter` shape. Neither
  domain imports the other's model.
- **`src/main.ts` is the only Module that names a concrete adapter**, as its own
  header states. `startEnvironmentWorker` is the single place that branches on
  `SPROUT_ENV_KIND` and instantiates `ContainerCarrier`, `SshTunnelCarrier`, or
  `EndpointCarrier`.

### 3.1 `src/main.ts` responsibilities (mixed)

Reading the file linearly shows five unrelated kinds of work in one Module:

| Concern | Location | Kind |
| --- | --- | --- |
| Host fact reading from `process.env` | lines 40–68, 194, 283, 286, 299 | In-process, pure parsing |
| Carrier selection and Worker start | `startEnvironmentWorker`, lines 75–140 | Remote-but-owned; 3 adapters |
| Environment/Agent/Project defaults | lines 158–238 | In-process data |
| Object graph construction | lines 240–343 | Composition |
| Startup reconciliation and operator log | lines 345–388 | Orchestration across three subsystems |
| Shutdown signals | lines 390–401 | Process lifecycle |

Evidence that this Module is untested as a unit: no test file imports
`src/main.ts`; `npm test` globs `src/**/*.test.ts` and `web/src/**/*.test.ts`, and
the live scripts only *spawn* it as a process
(`scripts/live-macos-pi-codex-task.ts` and
`scripts/live-o7-minesweeper-collaboration.ts` spawn `src/main.ts`;
`scripts/live-smoke.ts` spawns `src/worker/main.ts` and re-wires the graph
in-process instead). The composition therefore has no seam a test can cross
except a live process.

### 3.2 `src/web/api.ts` responsibilities (mixed)

`createRunApi` is a genuinely deep Module at its external seam: a small
`RunApiOptions`/`RunApi` interface hides 952 lines and 22 `request.method` route
branches plus the static fallback, and 37 tests cross exactly that interface over
real HTTP. Inside, however, four unrelated concerns share the file:

| Concern | Location |
| --- | --- |
| HTTP dispatch: one 444-line `handle` with 22 route branches | lines 76–519 |
| SSE transport | `openEventStream` (526) + `writeEvent` (904) |
| Request validation and parsing | `parseEnvironmentPreference` (868), `parseTaskStatus`, `parseStringArray`, `readJson` |
| Domain-to-wire projection | `toView`, `toMessageView`, `toWakeView`, `toProjectView`, `toTaskView`, `toTaskContextState`, `toTaskWithRunsView`, `toTaskRunLinkView` (587–866) |
| Static asset serving | `serveStatic` (936), `CONTENT_TYPES` (928), `joinPath` (950) |

The projection functions and their exported view types (`RunView`,
`RunHistoryTotals`, `MessageView`, `WakeView`, `ProjectView`, `TaskView`,
`TaskWithRunsView`, `TaskRunLinkView`) are pure and have no `node:http`
dependency.

### 3.3 Store ownership

`src/run/sqlite-store.ts` (502 lines) is the persistence composition, not just run
storage. It defines `SqliteRunStore`, `SqliteLeaseStore`, `SqliteProjectStore`,
`SqliteSessionKeyStore`, and the unified `SqliteStore`, and it imports
`SqliteCollaborationStore` and `SqliteTaskStore`. So four of the nine tables have
their SQL in the file named for one domain, while `task/` and `collaboration/`
already keep their SQLite adapters beside their domain:

| Table | SQLite adapter today | Natural owner |
| --- | --- | --- |
| `agent_runs` | `run/sqlite-store.ts` | `run/` |
| `environment_leases` | `run/sqlite-store.ts` | `environment/` |
| `projects` | `run/sqlite-store.ts` | `project/` |
| `agent_session_keys` | `run/sqlite-store.ts` | `run/` |
| `collaboration_messages`, `collaboration_wake_requests`, `collaboration_observations` | `collaboration/sqlite-store.ts` | `collaboration/` (already) |
| `tasks`, `task_run_links` | `task/sqlite-store.ts` | `task/` (already) |

The store interfaces themselves (`RunStore`, `LeaseStore`, `ProjectStore`,
`SessionKeyStore`, `TaskStore`, `CollaborationStore`) are already clean seams with
in-memory adapters used by tests. The ownership problem is file placement, not
abstraction.

### 3.4 Web client

`web/src/main.ts` (1,062 lines) is the plain-DOM M1 client. Per ADR-0011 it is
**not** an implementation baseline; the production Web foundation replaces it with
Vue 3.5, Vite, Vue Router, bounded Pinia, Tailwind 4, and Reka UI. It also
re-declares, by hand, the eight wire interfaces that `src/web/api.ts` exports
(`RunView`, `RunHistoryTotals`, `MessageView`, `WakeView`, `ProjectView`,
`TaskView`, `TaskRunLinkView`, `TaskWithRunsView`). The two declarations have no
structural link, so they can drift silently: the API can rename or add a field and
the client keeps compiling.

## 4. Module classification

### 4.1 Deep Modules (small interface, large implementation) — keep the shape

| Module | Interface | Depth evidence |
| --- | --- | --- |
| `engine/port.ts` + 4 adapters | `EngineAdapter.startSession`, `EngineSession.{run,interrupt,close}` | Four very different engine lifecycles behind one port (O1) |
| `worker/protocol.ts` | 7 methods, 2 notifications | Neutral engine port over JSON-RPC; no engine names |
| `worker/{carrier,container-carrier,windows-carrier}` | `WorkerConnection` (info, adapters, contexts, alive, close) | Three transports, one protocol |
| `worker/supervisor.ts` | `adapters()`, `contexts()`, `close()` | Lazy start-and-replace per instance, instance-mismatch assertion |
| `environment/pool.ts` | acquire/reserve/release/markRecovering/… | Full lease state machine over an async store |
| `run/orchestrator.ts` | `submit`, `stop`, `get`, `list`, `waitFor`, `subscribe`, `reconcileOrphanedRuns`, … | Leases, sessions, hand-off, contract assembly, resume-retry, persistence, observers |
| `task/environment-lifecycle.ts` | `begin`, `advanceRun`, `settleRun`, `end`, `recover` | Durable begin/end transactions, Worker context seam, recovery ordering |
| `task/service.ts` | create/update/advance/… + `TaskContextProvider` | Task rules and multi-run progression |
| `collaboration/coordinator.ts` | `deliver`, `reconcile`, list* | Persistence-before-wake, idempotent admission, reply projection |
| `collaboration/wake.ts` | `planWake`, `parseMentions` | Deterministic routing + fail-open contract |
| `web/api.ts` (external seam) | `createRunApi` | 22 route branches behind one factory |
| `project/contract.ts` | `assembleProjectContract`, `renderProjectContract` | Deterministic contract rendering |
| `project/resolve.ts` | `resolveEnvironmentInstance` | Explicit preference then project matching |
| `runtime-config.ts` | `parseRuntimeConfiguration` | Strict validation of the one JSON config channel |

### 4.2 Shallow pass-throughs

- `project/registry.ts` (50 lines) and `agent/registry.ts` (57 lines) are thin
  maps, but they are not pass-throughs: the registry is where membership lookup
  lives and is the only link between an agent and a project. They earn their keep
  and should not be merged into `EnvironmentPool` or the orchestrator.
- `web/src/recipient-refresh.ts` (12 lines) is a genuine pass-through (one
  `addEventListener` wrapper around a caller-supplied callback). It only earns its
  keep because a DOM test targets it. It will be deleted with the plain-DOM
  client under ADR-0011; do not invest in it.
- `run/store.ts`, `project/store.ts`, `run/session-key-store.ts`,
  `collaboration/store.ts`, `task/store.ts` are interface + in-memory adapter
  pairs. The interfaces are load-bearing seams (they are what makes SQLite
  local-substitutable); the in-memory classes are test adapters, correctly small.

### 4.3 Mixed-responsibility Modules (the actual cleanup targets)

Only three Modules mix concerns that belong apart:

1. **`src/main.ts`** — config, defaults, carrier selection, graph construction,
   reconciliation, and signals in one untestable script (section 3.1).
2. **`src/web/api.ts`** — routing, validation, projection, SSE, and static files
   in one file (section 3.2).
3. **`src/run/sqlite-store.ts`** — four domains' SQL plus the unified handle
   (section 3.3).

Plus one duplication seam: the hand-copied wire types in `web/src/main.ts`
(section 3.4).

### 4.4 Shallow/dead exports found (evidence, not yet a ticket)

| Export | Callers | Reading |
| --- | --- | --- |
| `RunOrchestrator.known()` | none anywhere | Dead public method on a protected Module |
| `containerEnvironmentInstance()` | `src/worker/container.test.ts` only | `main.ts` builds the same shape inline at line 195 |
| `parseAgentMentions` (deprecated) | `src/collaboration/wake.test.ts` only | Superseded by `parseMentions` |
| `MacOsEnvironment` | `scripts/live-smoke.ts` only | Not dead: it is cited live evidence for the environment probe; keep |
| `EnvironmentPool.extendLease`, `resolveRecovery` | tests + `run/recovery.test.ts` | Test/contract surface tied to the lease state machine; do not churn |
| `RunOrchestrator.activeLease` | live scripts only | Observability for live evidence; keep |

None of these alone justifies a refactor; they are candidates only inside a ticket
that already touches the surrounding Module.

## 5. Observable behaviour-preservation contract

Any accepted cleanup must preserve every item below. Each is a check a follow-up
ticket can assert against the existing tests.

### 5.1 HTTP payloads and status

Routes, methods, and status classes (currently asserted by `src/web/api.test.ts`
and `src/web/api-tasks.test.ts`, 37 tests):

| Method + path | Success | Error classes |
| --- | --- | --- |
| `POST /api/messages` | 202 (200 when duplicate) | 400 |
| `GET /api/messages` | 200 | — |
| `GET /api/messages/:id/observations` | 200 | 404 |
| `GET /api/projects` | 200 | — |
| `POST /api/tasks` | 201 | 400 |
| `GET /api/tasks` | 200 | 400 |
| `GET /api/tasks/:id` | 200 | 404 |
| `PATCH /api/tasks/:id` | 200 | 400, 404, 409 |
| `POST /api/tasks/:id/runs` | 202 | 404, 409 |
| `POST /api/tasks/:id/begin` | 200 | 400, 404, 409 |
| `POST /api/tasks/:id/end` | 200 | 404, 409 |
| `POST /api/tasks/:id/recovery` | 200 | 400, 404, 409 |
| `POST /api/tasks/:id/validation` | 200 | 404, 409 |
| `POST /api/runs` | 202 | 400 |
| `POST /api/runs/:id/stop` | 200 | 500 via top-level catch only |
| `POST /api/runs/:id/release-lease` | 200 | 404, 409 |
| `GET /api/runs/:id` | 200 | 404 |
| `GET /api/runs` | 200 (`runs` + `totals`) | — |
| `GET /api/agents` | 200 | — |
| `GET /api/leases` | 200 | — |
| `POST /api/leases/:id/release` | 200 | 404 |
| `GET /api/events` | 200 SSE | — |
| static `GET` when `staticRoot` is set | 200 | falls through |
| unmatched | — | 404 `{ error: 'not found' }` |
| uncaught handler error | — | 500 `{ error }` |

Also load-bearing:

- **Optional-plane gating.** Message routes require `collaboration`, project list
  requires `projects`, Task routes require `tasks`. An absent plane yields 404,
  not 500. Two tests assert this.
- **Does not depend on optional planes:** run, agent, lease, event, and static
  routes work in a run-only build.
- **Payload shapes** are exactly the `*View` interfaces in `api.ts`, including
  `handOffAttached` as a boolean, absent-vs-present optional fields
  (`exactOptionalPropertyTypes` semantics), and `toTaskContextState`'s mapping
  (`not-created`, `preparing`, `ready`, `cleanup-in-progress`,
  `cleanup-needs-recovery`, `recovery-retained`, `recycled`, `unknown`).
- **Privacy at the edge:** a run view exposes status, events, terminal result,
  token usage and timestamps, but no lease id, engine internals, or adapter
  details; a Message view contains only the projected reply text, never raw run
  events or reasoning.

### 5.2 SSE behaviour

- `GET /api/events` responds 200 with `content-type: text/event-stream`,
  `cache-control: no-cache`, `connection: keep-alive`, and `flushHeaders()`.
- On connect it replays every run from `orchestrator.list()` in the store's order,
  then streams each new run as `event: run\ndata: <JSON toView(run)>\n\n`.
- Keep-alive is `: ping\n\n` every `keepAliveMs ?? 15_000` (`unref`'d).
- The subscription and timer are torn down on request or response close.
- `RunApi.close()` ends every open stream before `server.close()` and calls
  `closeAllConnections?.()`.

### 5.3 Persistence and restart semantics

- The schema is 9 tables with their current columns and the one index
  `task_run_links_by_task`. Cleanup may move the class, never the SQL, and the
  `#addColumnIfMissing` migrations must stay.
- Startup order is observable and must stay: `projects.load(store.projects)` →
  graph construction → `api.listen` → `orchestrator.reconcileOrphanedRuns()` →
  `tasks.reconcileEnvironmentLifecycle()` → `collaboration.reconcile()`. Runs are
  reconciled before collaboration so a reply is never fabricated for an orphaned
  run.
- `reconcileOrphanedRuns` marks `queued`/`running` runs from a previous process as
  `failed` and moves their lease to `recovering`; terminal Task runs are
  re-delivered idempotently.
- A clean restart changes nothing (`collaboration.reconcile` is idempotent).

### 5.4 Worker protocol

- Methods: `worker/info`, `session/start`, `session/run`, `session/interrupt`,
  `session/close`, `context/prepare`, `context/recycle`.
- Notifications: `turn/event`, `turn/settled`.
- Error code `-32610` (`resumeRefused`) and the `EngineResumeRefusedError`
  round-trip are contract.
- Line-framed JSON-RPC; the readiness line prefix `SPROUT_WORKER_READY `; the
  three carriers and their transports are unchanged.

### 5.5 Domain lifecycle outcomes

- Task statuses (`todo`, `in-progress`, `blocked`, `done`, `failed`, `cancelled`)
  and environment lifecycle states (`beginning`, `idle`, `running`, `blocked`,
  `awaiting-validation`, `ending`, `recovery`, `ended`, `discarded`) with their
  transitions, conflicts (409) and recovery paths.
- Lease states (`active`, `recovering`, `expired`, `released`) and holder kinds
  (`run`, `task`); a Task-held lease is not releasable through the run/lease
  release routes.
- Wake decisions (`broadcast`, `direct-recipient`, `agent-mention`, `wake-model`,
  `wake-model-fail-open`) and durable observations (`suppressed`, `failed`).
- Agent run terminal states and their failure text.

### 5.6 Privacy and live configuration

- Portable records contain no host paths, credentials, or private infrastructure
  facts; workspaces are stored as Worker-root-relative paths.
- Every current environment variable name and default is preserved:
  `SPROUT_DATABASE`, `SPROUT_WORKDIR`, `SPROUT_PORT`, `SPROUT_ENV_INSTANCE`,
  `SPROUT_ENGINE`, `SPROUT_RUNTIME_CONFIG`, `SPROUT_ENV_KIND`,
  `SPROUT_CONTAINER_NAME`, `SPROUT_CONTAINER_MOUNT`, `SPROUT_CONTAINER_CODEX_HOME`,
  `SPROUT_DOCKER_PROXY`/`HTTPS_PROXY`/`https_proxy`, `SPROUT_WINDOWS_TARGET`,
  `SPROUT_WINDOWS_READY_FILE`, `SPROUT_WINDOWS_TUNNEL_PORT`,
  `SPROUT_WINDOWS_WORKDIR`, `SPROUT_LEASE_TTL_MS`, `SPROUT_PROJECT`,
  `SPROUT_WORKSPACE_ROOT`, `SPROUT_WORKER_TRANSPORT`, `SPROUT_WORKER_HOST`,
  `SPROUT_WORKER_PORT`, `SPROUT_READY_FILE`, `SPROUT_ENV_PLATFORM`,
  `SPROUT_PI_SESSION_DIR`, `SPROUT_CODEX_BIN`, `SPROUT_<ENGINE>_BIN`.

### 5.7 Test-seam guarantee

Tests and callers must cross the same interface before and after. Concretely,
`src/web/api.test.ts` and `api-tasks.test.ts` must keep passing unchanged against
real HTTP, and `run/orchestrator.test.ts`, `task/*.test.ts`,
`collaboration/*.test.ts`, `worker/*.test.ts`, and `engine/*.test.ts` must keep
passing without edits that weaken their assertions.

## 6. Protected no-touch modules

These Modules are proven by M1 evidence and carry lifecycle, recovery, protocol,
or engine semantics that a cleanup must not perturb. Each is excluded regardless
of size.

| Protected Module | Why |
| --- | --- |
| `src/engine/port.ts` and all `src/engine/*` adapters, protocols, JSON-RPC, event queue | O1 evidence: four engine lifecycles behind one port; no evidenced defect |
| `src/worker/protocol.ts`, `client.ts`, `server.ts`, `workspace.ts` | The Worker protocol and the Worker-owned filesystem ownership boundary (ADR-0003); changing either is a protocol change |
| `src/worker/{carrier,container-carrier,windows-carrier}.ts` | Transport only; each is already a real adapter. Touch only to *move* the factory, never the transport |
| `src/worker/supervisor.ts` | Lazy start-and-replace and instance-mismatch guard; ADR-0003 recovery |
| `src/environment/pool.ts` lease semantics | ADR-0005/#4: exclusivity, recovery, Task vs run holder kinds |
| `src/run/orchestrator.ts` execution, lease, session-continuation, resume-retry, hand-off, settlement | The deep run Module; 23 tests; no evidenced defect |
| `src/task/service.ts`, `context.ts`, `model.ts`, `environment-lifecycle.ts` ordering | ADR-0006 and the #31/#32 prototype ordering |
| `src/collaboration/coordinator.ts`, `wake.ts`, `model.ts` | ADR-0007 persistence-before-wake and projection privacy |
| `src/project/contract.ts`, `resolve.ts` | O5 contract assembly and F1 environment resolution |
| All SQLite SQL, table/column names, migrations, and idempotency keys | ADR-0002; a persistence change is a schema change |
| Every existing test assertion | The tests are the behaviour-preservation harness |

## 7. Candidate seams, with dependency kind and M2 leverage

Each candidate names the M2 outcome it unblocks. No candidate is proposed for
line-count reduction.

### C1 — Extract Web view projection and wire types (`src/web/views.ts`)

- **What**: move the pure `to*View` functions and their exported `*View`
  interfaces out of `api.ts`; `api.ts` imports them.
- **Dependency kind**: in-process (pure functions over domain records).
- **Depth**: deep. A small surface (`toRunView`, `toTaskView`, …) hides
  absent-vs-present field rules, the Task-context-state mapping, and history
  aggregation (`summarizeRunHistory`).
- **M2 leverage**: M2-O5 needs the run/totals projection; M2-O2/O6 need the Task
  views; the Vue client needs one authoritative wire contract instead of the hand
  copy in `web/src/main.ts` (section 3.4). This is the seam the M2 Web foundation
  tickets (#72/#74) will consume.
- **Risk**: low. JSON serialization is byte-identical if the functions move
  unchanged; the HTTP tests guard it.
- **Test seam**: add direct projection tests next to the module; keep the HTTP
  tests as the behavioural guard.

### C2 — Extract host configuration from `src/main.ts` into a configuration Module

- **What**: one Module that reads every `SPROUT_*` variable once and returns a
  typed configuration object with today's defaults. `main.ts` then consumes the
  object. `runtime-config.ts` remains the parser for the JSON channel; the new
  Module owns the host facts around it.
- **Dependency kind**: in-process, pure (takes an env-like record).
- **Depth**: deep. One interface replaces scattered `process.env` reads and two
  duplicate `SPROUT_LEASE_TTL_MS` reads (lines 286 and 299).
- **M2 leverage**: M2-O1 (product-managed setup must replace hand-written runtime
  JSON and env), M2-O4 (self-hosted operation and health), and multi-instance
  builds. Config becomes testable without spawning a process.
- **Risk**: low, provided defaults and validation errors stay identical.
- **Test seam**: table-driven tests over `parseHostConfiguration(env)`.

### C3 — Extract the environment Worker factory (`src/worker/environment-worker.ts`)

- **What**: move `startEnvironmentWorker` and its carrier selection out of
  `main.ts` into a Module whose interface is `connect(instanceId)`; the three
  carriers and `readWindowsReadyFile` stay where they are.
- **Dependency kind**: remote-but-owned (spawns a process or opens a network
  channel).
- **Depth**: deep at a real seam — three existing adapters justify it.
- **M2 leverage**: M2-O4 (macOS/Windows health and compatibility), multi-instance
  builds, and the `EnvironmentWorkerRegistry` connect port which already exists.
- **Risk**: low-to-moderate; carrier selection and its error messages must be
  preserved verbatim.
- **Test seam**: the factory takes injectable carrier constructors so selection
  can be asserted without Docker or SSH.

### C4 — Rehome SQLite adapters by domain and rename the unified handle

- **What**: keep `SqliteRunStore` and `SqliteSessionKeyStore` in `run/`, move
  `SqliteProjectStore` to `project/` and `SqliteLeaseStore` to `environment/`,
  and keep the unified `SqliteStore` as a persistence composition (for example
  `src/store/db.ts` or a renamed `run/sqlite-store.ts` that owns only the handle).
- **Dependency kind**: local-substitutable (`node:sqlite`).
- **Depth**: unchanged per adapter; the win is locality, not depth.
- **M2 leverage**: M2-O1 and M2-O5 will add domain persistence; keeping each
  domain's SQL next to its store interface means a new table has one obvious
  home. It also removes the misleading file name that makes `run/` look like the
  persistence owner.
- **Risk**: moderate. The SQL text, column names, table names, migrations, and
  the shared `DatabaseSync` handle must not change. Move-only, verified by
  `run/sqlite-store.test.ts`, `task/store.test.ts`,
  `collaboration/sqlite-store.test.ts`, and the integration tests.
- **Test seam**: existing store tests are the guard; no new abstraction.

### C5 — Extract the object graph into a runtime factory (`createSproutRuntime`)

- **What**: a Module that takes the C2 configuration plus an optional connect
  factory (C3) and returns the wired graph (`api`, `orchestrator`, `tasks`,
  `collaboration`, `pool`, `store`, `environmentWorkers`) and a `close()`.
  `main.ts` becomes: read config → create runtime → `listen` → reconcile →
  install signals.
- **Dependency kind**: in-process composition over remote-but-owned and
  local-substitutable dependencies.
- **Depth**: deep. A small interface hides store creation, forward-reference
  wiring (`let tasks` / `taskLifecycle` around `onTaskRunSettled`), and the run
  seam contracts.
- **M2 leverage**: M2-O1 (product-managed setup re-wires the graph at runtime),
  M2-O4 (restart and health), and the multi-instance factory ADR-0003 anticipates.
  It also makes the composition reachable from a test for the first time.
- **Risk**: moderate; depends on C2 and C3 being extracted first.
- **Test seam**: construct a runtime over in-memory stores and the scripted
  adapter, then assert reconciliation and shutdown through the returned interface.

### C6 — Split `src/web/api.ts` into a transport Module and domain routers

- **What**: keep `createRunApi` as the factory/transport, and factor route groups
  (runs, tasks, messages, projects, leases, events) into small Modules that each
  delegate to their service and share the `sendJson`/`readJson` helpers. Extract
  `serveStatic`/`CONTENT_TYPES`/`joinPath` into a static-asset Module.
- **Dependency kind**: local-substitutable (`node:http`).
- **Depth**: mixed. The external seam is already deep; this is a locality change
  inside it, so it is the lowest-priority of the six.
- **M2 leverage**: M2-O1/O2/O5 will add routes (Agents, Environments, Projects,
  Usage, Settings). Domain routers give each new route group an obvious home and
  keep `api.ts` from growing to several thousand lines.
- **Risk**: moderate. Every status code, gating condition, and payload must be
  preserved; the 37 HTTP tests are the guard. Do not rename routes or fields.
- **Test seam**: keep the HTTP tests as-is; router Modules are exercised through
  `createRunApi`, not called directly.

### Explicitly rejected as cleanup

- **Refactoring `web/src/main.ts`'s rendering or state.** ADR-0011 replaces this
  implementation; the M2 Web foundation owns that churn. Do not extract renderers
  from it.
- **Introducing a repository/Unit-of-Work layer over the stores.** ADR-0002
  already isolates SQLite behind per-domain interfaces; adding another layer is
  indirection without a second adapter.
- **Merging the run, Task, and collaboration lifecycles.** Their separation is a
  deliberate seam (`run/task-link.ts`, `RunAdmitter`) and is required by
  ADR-0006/0007.
- **Any rename, schema change, or new capability.** Out of scope for behaviour
  preservation.
- **Deleting `MacOsEnvironment`, the live scripts, or the prototype bundle.**
  They are evidence or a retained baseline, not dead production code.
- **Universal card/primitive abstraction.** That decision belongs to map ticket
  #72, not to M1 cleanup.

## 8. Ordered, dependency-aware recommendation

Follow-up tickets should be created in this order. Each step is independently
mergeable and green on its own.

1. **C1 — Web view and wire-contract extraction.** No dependencies. Smallest,
   lowest-risk, and immediately useful to the M2 Web foundation.
2. **C2 — Host configuration Module.** No dependencies. Unblocks C5.
3. **C3 — Environment Worker factory.** No dependencies. Unblocks C5. Can run in
   parallel with C2.
4. **C4 — SQLite adapter rehoming.** No dependencies beyond C1–C3 being merged to
   avoid branch conflicts. Move-only, guarded by store tests.
5. **C5 — Runtime composition factory.** Depends on C2 and C3. This is where the
   composition test seam appears.
6. **C6 — Web transport/static split.** Depends on C1 (views already extracted).
   Lowest priority; sequence it with the first M2 route-adding ticket rather than
   ahead of real need.
7. **Optional micro-cleanup.** Remove `RunOrchestrator.known()` and the deprecated
   `parseAgentMentions` alias only inside a ticket that already edits those
   Modules; do not open a ticket for them alone.

The **smallest** sequence that still gives real M2 leverage is C1 + C2 + C3. C4 is
the smallest store-ownership fix. C5 depends on C2/C3 and is the point at which the
composition becomes testable. C6 is deferred to the first M2 route addition.

Every step must keep the section 5 contract and may not touch the section 6
protected Modules beyond the moves named.

## 9. Reference repositories consulted

Pinned revisions are the commits consulted at the time of this research. No code
was copied, so no attribution headers or NOTICE obligations arise.

| Repository | Revision | License |
| --- | --- | --- |
| `paperclipai/paperclip` | `352153b5edf02ff4262210c7bd5bfa94bcf37c7c` | MIT |
| `yetone/cumora` | `ae18eff5d351f9a666984a2a03f13428d8f714fc` | MIT |
| `iOfficeAI/AionUi` | `6744099b279b991c17e31c243f0920477bd31cb6` | Apache-2.0 |

### Paperclip

- `server/src/app.ts` composes the HTTP app in one `createApp(...)` factory and
  delegates to ~72 route Modules; the route Modules are wired by a `routes/index.ts`
  barrel.
- `server/src/services/live-events.ts` publishes events to an in-process
  `EventEmitter`; `server/src/realtime/live-events-ws.ts` is a *separate transport
  adapter* that upgrades a socket and subscribes to that source.
- **Adopted as design**: (a) an explicit `createApp`-style composition factory —
  this is the shape of C5; (b) the event source and the event transport are
  separate Modules — this is why C1 (projection) and C6 (SSE/static) can be
  separated from routing; (c) request validation at the transport edge, which
  `api.ts`'s `parse*` helpers already do.
- **Rejected**: its Express + Drizzle + WebSocket stack and its 72-file per-route
  explosion are far heavier than M1's size warrants; Sprout keeps `node:http` and
  splits only where M2 will add routes (C6, deferred). No code copied.

### Cumora

- `server/src/index.ts` is a flat `main()` that builds the Express app inline —
  structurally the same shape as Sprout's `src/main.ts`, and the reason C2/C5
  exist.
- `server/src/api/router.ts` is one large router, the same shape as `api.ts`.
- `server/src/realtime-outbox.ts` is a transactional outbox: durable mutations
  enqueue their invalidation in the same database transaction, and a bounded
  dispatcher performs network I/O only after commit.
- **Adopted as design**: the transactional/recover-after-commit discipline already
  present in Sprout as persistence-before-wake plus startup reconciliation; the
  documented requirement that `text/event-stream` must not be compressed/buffered,
  which matches Sprout's SSE and its Vite proxy setting. Cumora's own
  `index.ts` flat-boot shape is what Sprout should move away from via C2/C5.
- **Rejected**: a single monolithic boot script with dozens of background workers;
  Sprout needs a testable composition, and M1 does not need an outbox because the
  coordinator has no cross-process fan-out. No code copied.

### AionUi

- `.claude/skills/architecture` documents an explicit decision tree for where code
  belongs across an Electron multi-process app (renderer / main process / bridge /
  services / worker), with a reference per layer.
- `mobile/src/services/websocket.ts` is a transport client with an explicit
  `ConnectionState` union (`disconnected`, `connecting`, `connected`,
  `auth_failed`), a documented wire protocol, and heartbeat/backoff.
- **Adopted as design**: (a) an explicit, documented rule for where new code goes
  — the M2 specification should state Sprout's equivalent for `src/` and the Vue
  client; (b) an explicit transport state model — the M2 Web foundation should
  model its connection to `/api/events` the same way rather than implicitly.
- **Rejected**: the React + Arco Design visual language conflicts with Sprout's
  accepted structural and state language (ADR-0011); its Electron IPC bridge layout
  has no M1 equivalent. No code copied.

## 10. Follow-up ticket sketch (not created by this ticket)

- **T1 (from C1): Extract Web view and wire-contract Module.**
  Acceptance: `to*View` functions and view types live in a Module `api.ts` imports;
  all 37 HTTP tests and `npm test` pass unchanged; payloads byte-identical.
- **T2 (from C2): Extract host configuration.** Acceptance: every `SPROUT_*`
  variable is read once through one typed parser with identical defaults and error
  text; a table-driven test covers each variable.
- **T3 (from C3): Extract environment Worker factory.** Acceptance: carrier
  selection is a testable function; live-smoke and container tests still pass.
- **T4 (from C4): Rehome SQLite adapters by domain.** Acceptance: SQL, tables,
  columns, and migrations unchanged; store and integration tests pass; the unified
  handle owns `open`/`close` only.
- **T5 (from C5, blocked by T2 and T3): Runtime composition factory.**
  Acceptance: the graph is constructible in-process over in-memory stores and the
  scripted adapter; `main.ts` holds only config → runtime → listen → reconcile →
  signals; startup order and operator log unchanged.
- **T6 (from C6, deferred): Web transport/static split.** Create only alongside the
  first M2 ticket that adds routes.

None of these is added to the map by this research; the Orchestrator reconciles
the map after acceptance.
