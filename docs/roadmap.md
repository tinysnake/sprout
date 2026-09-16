# Sprout Outcome Map

This roadmap bridges the durable product direction in `docs/goal.md` and the current short-term development map in GitHub Issues. It records the current medium-term goal and the outcomes needed to prove it, not a fixed implementation plan.

Future outcomes may be split, merged, reordered, or removed when evidence changes the plan. Evidence for completed outcomes remains linked as construction history.

## Status vocabulary

- **Unproven**: the outcome has no sufficient evidence.
- **In progress**: an active development map advances the outcome.
- **Evidenced**: every outcome check has linked acceptance evidence.

## Current medium-term goal

### M2 — Local operator MVP

**Status**: In progress

Turn Sprout's evidenced coordination foundation into a self-hosted product that one technical lead can operate routinely from either mobile or desktop Web clients without editing runtime configuration for day-to-day work.

**Scope**:

1. One local technical lead operates a self-hosted Sprout instance.
2. Codex and Pi are the required work engines; the already implemented `agy` and `opencode` adapters do not require long-running product acceptance during M2.
3. macOS and Windows are the required operator environments.
4. Projects, reusable Agents, Environment instances, memberships, Working groups, templates, and workspaces can be managed through the Web product rather than hand-written runtime JSON.
5. A Task remains bound to one Environment instance from Task begin through Task end.
6. Humans and Agents may propose Tasks, but only a Human may authorize Task begin and acquisition of the Task lease.
7. Projects can choose between explicit-only and wake-model-assisted routing for their Project and Working group channels.
8. Routine Project communication, Task control, Agent-run observation, Environment management, and recovery are available with mobile and desktop capability parity.
9. Token usage, duration, and monetary cost are recorded and presented truthfully at useful scopes.
10. Sprout, lightweight-game, and Unity development provide ongoing dogfooding evidence without any one scenario becoming a mechanical release gate.

**Success checks**:

- Each supporting outcome below has linked, objective acceptance evidence.
- A technical lead can complete the settled operator journeys from both mobile and desktop without editing runtime JSON during routine operation.
- Human authorization remains the boundary for starting lease-holding Tasks, while approved Tasks can use bounded Agent collaboration.
- macOS and Windows Environment state, compatibility, interruption, and safe recovery remain understandable and controllable.
- Usage views distinguish authoritative provider or harness facts from estimates and unavailable data, including monetary cost.
- After sustained dogfooding, the product owner explicitly accepts that Sprout is ready for routine local development coordination. This Human judgement complements rather than replaces objective acceptance for each capability.

**Constraints**:

- Agent identity remains independent of Project and Environment.
- The product remains self-hosted and exposes one Web experience with full mobile and desktop capability parity.
- Engine credentials remain on the Environment where their harness runs; Sprout does not become a central credential store.
- An active Task never moves between Environment instances.
- Core modules remain independently testable and verifiable.
- Individual capabilities use observable acceptance checks even though overall MVP readiness is a Human product decision.
- Open product details are settled through [Map: define the Sprout Local Operator MVP](https://github.com/tinysnake/sprout/issues/44), not guessed in this outcome map.

**Non-goals for M2**:

- Cloud multi-tenant SaaS.
- Multiple human users and complex team authorization.
- A complete workflow or project-management system.
- Moving one active Task between Environment instances.
- Requiring long-running `agy` or `opencode` participation for release.
- Making container operation, high-resource editor scheduling, or cross-Environment parallel work an M2 release gate.
- Remote desktop or an embedded IDE.
- Production deployment governance.
- Backup, restore, and product-upgrade workflows beyond preserving durable state across an ordinary restart.
- A single prescribed Sprout, lightweight-game, or Unity scenario as an objective release gate.

## M2 supporting outcomes

These outcomes deliberately remain at product-result level while Map #44 resolves the decision fog. They may be split, merged, or reordered before implementation maps begin.

### M2-O1 — Product-managed collaboration setup

**Status**: Unproven
**Depends on**: M1

A technical lead can establish reusable Agents, connected Environments, and Projects with explicit contracts, Project and Working group communication scopes, and at least one Project template through the product rather than hand-written runtime configuration.

**Outcome checks**:

- Agent, Environment, Project, membership, Working group, template, and workspace responsibilities remain distinct and understandable.
- Routine create, inspect, change, and retirement journeys are available through Web while preserving historical identity.
- Host-local engine authentication and workspace facts do not leak into portable Agent or Project identity.

### M2-O2 — Human-authorized Agent work

**Status**: Unproven
**Depends on**: M2-O1

Humans and Agents can propose durable work, Human authorization controls Task begin, and approved Tasks support bounded multi-Agent progress without surrendering Human control of scarce Environments.

**Outcome checks**:

- Human-created and Agent-proposed work are both representable and observable before Task begin.
- Only a Human can authorize Task begin and its Task lease.
- A Task remains bound to its selected Environment until Task end.
- The settled pause, stop, validation, correction, completion, end, and recovery journeys are observable and safe.

### M2-O3 — Intentional and explainable communication routing

**Status**: Unproven
**Depends on**: M2-O1

Project-scoped direct messages, Project channels, Working group channels, and optional wake-model routing let members collaborate without unexplained silence or uncontrolled Agent wakes.

**Outcome checks**:

- Each Project has an explicit wake policy.
- Addressing, routing, suppression, failure, and retry outcomes are durable and understandable to the Human operator.
- Routing shares no private raw reasoning and prevents accidental wake loops.

### M2-O4 — Self-hosted macOS and Windows operation

**Status**: Unproven
**Depends on**: M2-O1

A technical lead can establish and maintain a local Sprout instance with macOS and Windows Environment Workers, understand their health and compatibility, and recover safely from interruption.

**Outcome checks**:

- The required host-local installation and engine-login steps are explicit, while routine management occurs through Web.
- Environment identity, connectivity, capability permission, engine availability, and version compatibility are observable.
- Ordinary restart, disconnect, diagnostics, and work-recovery outcomes preserve durable state and protect unfinished work.

### M2-O5 — Truthful usage and monetary-cost observability

**Status**: Unproven
**Depends on**: M1

The operator can understand token usage, duration, and monetary cost across Agent runs and the larger work they contribute to without estimates being presented as billed facts.

**Outcome checks**:

- Codex and Pi telemetry semantics are measured and documented.
- Missing, delayed, cached, resumed, failed, reported, and estimated values remain distinguishable.
- The settled run, Task, Project, Agent, model, and time-range views are available on mobile and desktop.

### M2-O6 — Mobile-first operator control

**Status**: Unproven
**Depends on**: M2-O1, M2-O2, M2-O3, M2-O4, M2-O5

One coherent Web product lets the technical lead perform every routine management, collaboration, observation, intervention, and recovery journey from either mobile or desktop.

**Outcome checks**:

- Mobile is a complete operating surface rather than a read-only status view.
- State distinctions and actions remain usable on narrow touch screens and desktop displays.
- An owner-reviewed interactive prototype provides primary evidence before the production information architecture is fixed.

### M2-O7 — Dogfooded local operator MVP

**Status**: Unproven
**Depends on**: M2-O2, M2-O3, M2-O4, M2-O5, M2-O6

The completed product capabilities hold up in routine Sprout, lightweight-game, and Unity development until the product owner judges the Local Operator MVP ready for continued use.

**Outcome checks**:

- Every preceding M2 outcome links to objective acceptance evidence.
- Dogfooding findings are fixed, explicitly deferred, or accepted as known limits rather than silently ignored.
- The product owner records explicit Human acceptance of overall MVP readiness.

## Current M2 frontier

[Map: define the Sprout Local Operator MVP](https://github.com/tinysnake/sprout/issues/44) is the active development map. It resolves product and operational decisions across the M2 outcomes before `/to-spec` collapses them into a buildable specification. No production implementation map should guess the decisions still open there.

## Completed medium-term goal

### M1 — Local coordination foundation

**Status**: Evidenced

M1 proved the core seams needed for product development: heterogeneous engines run behind one interface inside Environment Workers; environments are leased and recoverable; project context, Messages, Tasks, and run results are durable; and real Codex/Pi collaboration can produce and review a playable game.

M1 was originally named “Local single-user MVP.” Evidence from its final slice showed that it completed the coordination foundation rather than the operator-ready product. Reclassification preserves the construction evidence below without claiming that four-engine, three-platform, high-resource-editor collaboration ran as one combined scenario.

## M1 supporting outcomes

### O1 — Controllable agent runs

**Status**: Evidenced
**Depends on**: None

Codex, Pi, `agy`, and `opencode` are all controlled through one Sprout-facing run model rather than being embedded as machine-specific agents. Codex uses the `app-server` transport (ADR-0001).

**Implementation evidence**: all four engines are implemented behind `src/engine/port.ts` (#10, #15, and the `agy`/`opencode` records in #14), and they run **inside the environment worker**, so the core spawns no engine process (ADR-0003). Codex (#10), Pi (#15), `agy` (#14), and `opencode` (#14) are all verified end to end live through real workers, including tool progress, stop, terminal states, and declared streaming granularities.

**The run seam needed no change for any of the four lifecycles.** Codex is a long-lived supervised daemon, Pi is one process per turn resumed by a caller-chosen session id, `agy` is one process per turn resumed by an engine-assigned conversation id, and `opencode` is one process per turn resumed by an engine-assigned session id. That a single interface covers all four is the strongest evidence O1 has.

**Outcome checks**:

- Each engine can receive assembled input, start, report observable results, and stop.
  - **Streaming granularity is a declared per-adapter capability, and non-streaming delivery is acceptable** (see the streaming policy below). Adapters declare what they actually provide rather than the core assuming a uniform guarantee.
- **Streaming policy**: an adapter that streams poorly or not at all uses non-streaming delivery. What matters for observability is that tool calls and progress remain visible; the final message text may arrive as one unit. Measured per engine:

| Engine | Mode for M1 | Streaming | Session key |
| --- | --- | --- | --- |
| Codex | `app-server` (ADR-0001) | incremental per item, incl. tool calls | `thread/resume` (engine-assigned) |
| Pi | `--mode json` | incremental | caller-chosen `--session-id` (Sprout-chosen) |
| `agy` | `--output-format stream-json` | incremental `text_delta` | `--conversation <engine-assigned id>` |
| `opencode` | `run --format json` | **non-streaming** — one `text` event per turn | `--session <engine-assigned id>` |
- Their provider-specific behaviour is hidden behind the same conceptual run interface.
  - Implemented: four adapters behind `src/engine/port.ts`, each declaring its own streaming granularity and none leaking engine concepts upward. Genuinely shared: start, stop, result, resume-by-key. Genuinely different: streaming guarantee, session storage location, and lifecycle — Codex `app-server` needs a supervised daemon while Pi, `agy`, and `opencode` are one process per turn. **How a session key is obtained now differs by engine:** Sprout *chooses* it for Pi and *captures* it for `agy` and `opencode`, and each is verified by test.
- Agent identity and project configuration are not owned by either CLI installation.
  - **Evidenced by O5.** Sprout owns the Agent definition, project membership, durable session-key records, and contract assembly; no CLI installation owns those facts. Standing-instruction channels remain engine-specific: Codex and Pi receive them out of band, headless `agy` receives them through Sprout's env-gated global-config hook, and `opencode` uses working-directory instructions or an engine-config-registered fallback. O5 records the channel limits and acceptance evidence below.

### O2 — Schedulable environment pool

**Status**: Evidenced
**Depends on**: None

Container, macOS, and Windows environments can be treated as a shared capability pool with safe access and lease semantics.

**Acceptance evidence**: #4 settled the capability, lease, capacity, provisioning, and recovery model. The three target platforms are implemented and live-verified through environment workers (#5, #10, #13), and #16 accepted durable lease recovery that prevents interrupted capacity from being reassigned until recovery is explicitly resolved.

**Implementation evidence**: macOS is implemented end to end with a lease that is acquired before a run becomes active, refuses conflicting runs, and is released on completion or stop (#10). `src/environment/pool.ts` enforces exclusivity because the runtime does not. Since #12 every environment runs a long-lived worker that supervises engines, and the core spawns no engine process itself (ADR-0003); a local macOS machine is reached as a network endpoint like any other environment. Since #13 **container** environments are implemented too: a real container instance hosts a worker that executes real Codex runs over the runtime exec channel, with Sprout's lease registry — not Docker — enforcing exclusivity. Since #5 **Windows** is implemented and live-verified: a remote physical Windows host runs a Sprout worker daemon via an SSH-tunneled carrier with scheduled-task boot autostart, successfully running real Codex and Pi turns end to end.

**Outcome checks**:

- Each target environment can report availability and relevant capabilities.
  - Container, macOS, and Windows implemented and checked (#5, #10, #13).
- An Agent can perform permitted read-only investigation without a lease. — evidenced
- Capacity-intensive or mutating work requires a lease, and conflicting use is prevented.
  - Implemented for macOS (#10) and container (#13). Docker does **not** enforce mutual exclusion, so the lease registry does; verified live by refusing a second concurrent container run.
- Fixed and cloneable environments can both be represented without leaking platform rules to callers. — evidenced: macOS is fixed (#10), a container is cloneable (#13), and the lease registry needs no platform-specific rule for either
- Interrupted dirty work can be identified and kept from unsafe reassignment.
  - Evidenced by #4 and #16: container `stop`/`start` preserves work, `commit`/`export` captures it, and `rm -f` is the only irrecoverable action. On every instance kind, an interrupted active lease is restored as `recovering` and blocks reassignment until the operator explicitly preserves or discards the work and resolves recovery. Automatic fixed-host snapshotting is not required by this check; it may be added later when a real workflow requires it.

### O3 — First end-to-end run

**Status**: Evidenced  
**Depends on**: O1, O2

One human request can travel through Sprout to one Agent and one environment, with its progress returned through a minimal Web interface.

**Acceptance evidence**: Web request → Codex `app-server` → fixed macOS environment under a capacity lease → streamed progress → stop → terminal result (#10, work record and acceptance comments). Check 2 reads "obtains environment access when required", and one Agent on one environment satisfies the outcome, so all four checks below are met for real rather than with fakes.

**Note**: O3 being evidenced does not make O1 or O2 evidenced. Those cover four engines and three platforms, and this slice exercised one of each.

**Outcome checks**:

- A local user can submit a request from the Web client.
- Sprout starts the selected Agent, obtains environment access when required, and streams observable progress.
- The user can stop the run and inspect its final result or failure.
- The slice crosses the real Agent and environment seams rather than using only fakes.

### O4 — Durable and recoverable work

**Status**: Evidenced  
**Depends on**: O3

Messages, runs, tasks, leases, and work results survive process interruption without silently losing or reassigning unfinished work.

**Implementation evidence**: SQLite-backed persistence behind `RunStore` and `LeaseStore` (ADR-0002, `src/run/sqlite-store.ts`) provides restart-safe durability for runs and environment leases (#16). When a core process is terminated mid-flight (exercised by real SIGKILL process-kill and restart tests in `src/run/recovery.test.ts`), restarting Sprout restores all historical runs and events intact, reconciles orphaned mid-flight runs into explicit `failed` states with interruption details, transitions active capacity leases into the `recovering` state, and enforces mutual exclusion against reassignment until recovery is resolved. The Web client and HTTP API expose restored runs and lease recovery states.

**Outcome checks**:

- Restarting Sprout restores the observable project and run state.
  - Evidenced (#16): `SqliteStore` restores runs, their progress events, and environment lease states across process restarts. The Web client and API inspect restored runs via `/api/runs` and leases via `/api/leases`.
- Agent or environment interruption produces an explicit recoverable or failed state.
  - Evidenced (#16): Mid-flight runs interrupted by process restart are reconciled into an explicit `failed` state (`interrupted by a Sprout restart before this run finished`) with all emitted events intact, verified across real process restarts.
- A lease containing uncommitted work enters recovery instead of immediate reassignment.
  - Evidenced (#16): Leases are durable in SQLite (`environment_leases` table). When a run holding an active lease dies, the lease enters `recovering` state. Attempting to lease the same instance/capability conflicts and surfaces the recovery state to callers; capacity cannot be reassigned until recovery is resolved via `releaseLease` / `resolveRecovery`.

### O5 — Portable project context

**Status**: Evidenced
**Depends on**: O3

Project contracts and Agent context remain coherent when the same Agent works across runs and environments.

**Acceptance evidence**: [#18](https://github.com/tinysnake/sprout/issues/18) accepted durable `Project`/`ProjectMembership`, project-based environment resolution, instance-selected workers, and persisted run project/instance facts. [#19](https://github.com/tinysnake/sprout/issues/19) established the version-scoped native session-key semantics. [#20](https://github.com/tinysnake/sprout/issues/20) accepted durable same-environment continuation and refusal safety, including the post-merge correction. [#21](https://github.com/tinysnake/sprout/issues/21) accepted deterministic contract delivery and cross-environment hand-off. Final integration review at `61d01c6` passed `npm test` (264/264), `npm run typecheck`, and `git diff --check`.

**Outcome checks**:

- A durable project defines its goal, participants, responsibilities, rules, and available environments before work starts. — evidenced by #18's in-memory and SQLite round-trips.
- Agent identity is independent of a fixed environment: project membership resolves the environment, then selects the matching environment worker and lease; the run persists the project and instance actually used. — evidenced by #18.
- In one environment and working directory, native continuation uses a durable key scoped to `(agent, engine, environment instance, working directory)`. Keys survive SQLite restart; a tuple change starts fresh; only an explicit key refusal retries once fresh, while unrelated failures preserve the key and fail visibly. — evidenced by #19, #20, and ADR-0004.
- On an environment change, every run receives the assembled project contract through its supported engine channel and a deterministic, bounded hand-off assembled from persisted prior results; same-environment continuation adds no duplicate hand-off. — evidenced by #21.
- Hand-off output is fact-form only: it excludes verbatim events, transcripts, and private raw reasoning. — evidenced by #21.
- Contract assembly, channel selection, hand-off ordering/bounds, privacy, persistence, continuation, refusal, and platform handling are deterministic and unit-tested. — evidenced by #18, #20, and #21.

**Current engine-channel semantics and accepted limits**: Headless `agy` receives the contract through a Sprout-installed global-config hook that is inert unless Sprout supplies its environment-gated payload. The installer selects a POSIX `.sh` artifact or Windows `.cmd` artifact from the environment platform; unsupported platforms report delivery as unavailable. The hook ABI is confirmed only for the measured `agy` 1.2.2 version, and #21 unit-tests and documents the Windows command/artifact but does not claim live Windows execution. `opencode` reads its normal working-directory instruction files; when a user-owned `AGENTS.md` requires `SPROUT-PROJECT-CONTRACT.md`, Sprout registers that path through `opencode` configuration. A bare fallback file is not claimed to be discovered automatically.

**Follow-ups / fog**: Re-probe the version-specific `agy` hook ABI and execute its Windows `.cmd` path on a real Windows environment. Decide the global-hook installation/teardown policy and the scope/size policy for `opencode` configuration instructions. Multi-instance carrier selection remains outside this outcome; #18 provides the instance-keyed worker seam and refuses unsupported routing rather than silently choosing another carrier.

### O6 — Multi-agent collaboration

**Status**: Evidenced
**Depends on**: O4, O5

All four engines can participate in one project, coordinate through direct and project-channel messages, and perform multi-run work without conflicting over environments.

**Map #24 status**: the deliberately narrowed macOS/Pi/Codex collaboration scenario is functionally evidenced by accepted tickets #25–#35, the closing privacy exception was remediated and reviewed clean (#36), and the integration was merged into `master` via PR #37 (`ef300f8`), formally closing Map #24. The broader four-engine, three-platform, and high-resource editor breadth is folded into the final end-to-end validation under O7.

The evidenced slice is one Task owning one macOS Environment lease from explicit Task begin through explicit Task end. Independent Pi- and Codex-backed Agents work sequentially inside that retained Environment, reuse its persistent Project workspace, and receive bounded durable Task facts in a temporary Task context. Their runs are nested activities: completion, stop, failure, interruption, and idle gaps never release the Task lease; recovery continues to protect the Environment from reassignment.

**Accepted evidence**:

- **[#25 acceptance](https://github.com/tinysnake/sprout/issues/25#issuecomment-5663181541)** settled automatic final-result projection and the deterministic, fail-open wake contract in a disposable prototype; [`docs/research/collaboration-write-path.md`](research/collaboration-write-path.md) records the recommendation.
- **[#26 acceptance](https://github.com/tinysnake/sprout/issues/26#issuecomment-5663519806)** accepted primary-SQLite `Message` and `WakeRequest` persistence, projected replies, private-event exclusion, reconciliation, and the collaboration HTTP seam.
- **[#27 acceptance](https://github.com/tinysnake/sprout/issues/27#issuecomment-5663873102)** accepted project-channel and wake-observation Web controls, including run inspection and stopping.
- **[#28 acceptance](https://github.com/tinysnake/sprout/issues/28#issuecomment-5665840097)** accepted the distinct durable Task lifecycle: sequential linked runs, bounded summaries, Project scoping, one active run, and environment preference.
- **[#29 acceptance](https://github.com/tinysnake/sprout/issues/29#issuecomment-5667736134)** settled the Task-held-lease vocabulary and [ADR-0005](adr/0005-task-held-environment-lease.md): a Task holds the lease from begin to end; nested runs do not acquire or release it; the Project workspace persists while only Task context is recycled.
- **[#30 acceptance](https://github.com/tinysnake/sprout/issues/30#issuecomment-5667934707)** closed the multi-Project collaboration correctness gap by binding every Message-triggered run to its causal Project.
- **[#31 acceptance](https://github.com/tinysnake/sprout/issues/31#issuecomment-5668339622)** selected and exercised the `TaskEnvironmentLifecycle` ownership seam for begin, advance, settlement, end, and recovery.
- **[#32 acceptance](https://github.com/tinysnake/sprout/issues/32#issuecomment-5668959397)** implemented the durable Task-held lease, nested-run admission, retained recovery, explicit lifecycle routes, and SQLite crash/restart matrix.
- **[#33 acceptance](https://github.com/tinysnake/sprout/issues/33#issuecomment-5669367158)** implemented Worker-owned persistent Project workspaces and manifest-authenticated temporary Task context, including safe recycle and Worker-failure recovery.
- **[#34 acceptance](https://github.com/tinysnake/sprout/issues/34#issuecomment-5669818493)** accepted Web Task begin/end, selected next Agent, retained-lease/context state, run stop/correction, recovery, cleanup feedback, and production-path DOM coverage.
- **[#35 acceptance](https://github.com/tinysnake/sprout/issues/35#issuecomment-5670561136)** accepted the two real macOS rounds through the production API, Environment Worker, SQLite state, and Pi/Codex adapters; the sanitized observations are in [`docs/evidence/live-macos-pi-codex-task.md`](evidence/live-macos-pi-codex-task.md).

#25–#28 prove the collaboration plane and durable Task entity; #29–#35 complete the narrowed Task-held-lease scenario. They do not prove O6's broader four-engine, three-platform, or cross-environment wording.

**Domain decision recorded**: [ADR-0005](adr/0005-task-held-environment-lease.md) reconciles the vocabulary and architecture around a Task-held Environment lease: one Task retains exclusive use of one Environment from begin through end (including idle, blocked, and human-validation periods), timeout or interruption may never silently make it reassignable, only Task-scoped temporary data is recycled while the Project workspace, repository, IDE state, and caches persist, and the outer Task begin→end lifecycle is distinguished from each nested Agent-run lifecycle.

**Outcome checks**:

- Direct messages and basic project-channel wake behaviour work as defined by the MVP.
  - Evidenced by #25–#27 for the write path, wake contract, durability, restart reconciliation, and Web observability. Configuring a real low-cost wake model and deciding fan-out behaviour under lease contention remain future work.
- One-round work and durable tasks can both be represented.
  - Evidenced by #26 (Message-completed one-round run) and #28/#32 (durable multi-run Task with a retained Task lease); they remain distinct lifecycles.
- Multiple Agents coordinate around the same project while environment leases remain correct.
  - Evidenced for the narrowed scenario by #30–#35: sequential Pi/Codex Agents reuse one Task, macOS Environment, Task lease, Project workspace, and temporary Task context; #35 records Pi → Codex → Pi and Codex → Pi → Codex.
- A human can observe, stop, and correct their runs.
  - Evidenced by #27 and #34: the human can inspect and stop runs, begin/end a Task, select the next Agent, view retained lease/context state, and resolve Task recovery.

**Map #24 exit-criterion → durable evidence**:

1. Durable, observable direct and Project-channel Messages — [#25](https://github.com/tinysnake/sprout/issues/25#issuecomment-5663181541), [#26](https://github.com/tinysnake/sprout/issues/26#issuecomment-5663519806), and [#27](https://github.com/tinysnake/sprout/issues/27#issuecomment-5663873102).
2. Separate one-round Message and multi-run Task lifecycles — [#26](https://github.com/tinysnake/sprout/issues/26#issuecomment-5663519806), [#28](https://github.com/tinysnake/sprout/issues/28#issuecomment-5665840097), and [ADR-0005](adr/0005-task-held-environment-lease.md).
3. Explicit, recoverable Task begin/end and a lease retained through idle, blocked, nested-run, and validation states — [#32](https://github.com/tinysnake/sprout/issues/32#issuecomment-5668959397) supplies the environment-neutral lifecycle evidence; [#35](https://github.com/tinysnake/sprout/issues/35#issuecomment-5670561136) supplies the macOS live-binding evidence.
4. Distinct Pi/Codex Agent runs reuse one Task, Environment, lease, Project workspace, and bounded context without private-session or raw-reasoning sharing — [#33](https://github.com/tinysnake/sprout/issues/33#issuecomment-5669367158) and [#35](https://github.com/tinysnake/sprout/issues/35#issuecomment-5670561136).
5. Completion, stop, failure, interruption, and restart retain the unfinished Task reservation — [#32](https://github.com/tinysnake/sprout/issues/32#issuecomment-5668959397) and [#35](https://github.com/tinysnake/sprout/issues/35#issuecomment-5670561136).
6. Worker-owned creation and safe recycle of temporary Task context while Project/repository/IDE/cache state persists — [#33](https://github.com/tinysnake/sprout/issues/33#issuecomment-5669367158) and [#35](https://github.com/tinysnake/sprout/issues/35#issuecomment-5670561136).
7. Web distinction between Task-active/Agent-idle and Agent-running, with begin, Agent selection, stop/correction, recovery, and explicit end — [#34](https://github.com/tinysnake/sprout/issues/34#issuecomment-5669818493).
8. The two required live macOS rounds through real Workers and adapters — [#35](https://github.com/tinysnake/sprout/issues/35#issuecomment-5670561136) and the sanitized [live record](evidence/live-macos-pi-codex-task.md).
9. This narrowed slice and its deferred breadth are recorded here. The #36 closing privacy audit's exception (six commits with non-generic personal author/committer metadata in the earlier integration range) was remediated by rewriting those commits to the repository's generic agent identity with identical trees and messages; the integration range now audits clean.

**Deferred breadth, not an M1 completion requirement**: `agy`/`opencode` collaboration and container/Windows collaboration were not exercised in this Task scenario. O1 independently proves all four adapters, O2 independently proves all three environment targets, and O5 independently proves cross-environment context hand-off. An active Task moving between Environment instances is intentionally unsupported: a Task retains one selected Environment from Task begin through Task end.

### O7 — Real game-development foundation validation

**Status**: Evidenced
**Depends on**: O2, O4, O5, O6

The M1 coordination foundation supports a real, reviewable multi-Agent game-development flow rather than only synthetic tests.

**Acceptance evidence**: [Map: O7 local game development MVP slice](https://github.com/tinysnake/sprout/issues/38) and its accepted tickets #39–#42 were merged through PR #43 (`84c2406`). The sanitized [Minesweeper collaboration record](evidence/o7-minesweeper-collaboration.md) captures the durable conversation, 14 completed Agent turns, Planner-led hand-offs, Human pause/resume, correction after independent review, re-review, final publication, duration, provider-token usage, and real browser interaction. A clean checkout can materialize and verify the playable Three.js game.

**Outcome checks**:

- Four Project members with distinct Planner, Designer, Programmer, and Reviewer responsibilities collaborate through real Codex and Pi Agent runs.
- The Human pauses and resumes orchestration without replaying the completed work.
- Independent review can require correction, after which the Programmer corrects the work and the Reviewer re-reviews it before final completion.
- A real browser verifies reveal, flag, and mine-counter behaviour in the produced game.
- The durable audit preserves Message causality, Agent attribution, duration, and token usage without synthetic Agent reports or private raw reasoning.

**Accepted boundary**: O7 does not claim one combined four-engine, three-platform, high-resource-editor scenario. Those independent seams were already evidenced where needed for the foundation; long-running `agy`/`opencode` use, high-resource editor scheduling, and cross-Environment parallel work are not release gates for the next Local Operator MVP. Task migration across Environment instances is outside the product model.

## M1 completion summary

O1 is **Evidenced**: all four engines (Codex, Pi, `agy`, `opencode`) run live behind the uniform run seam inside environment workers.

O2 is **Evidenced**: macOS, container, and Windows report capabilities and execute through the shared worker and lease model; fixed and cloneable instances are represented without platform rules leaking to callers; and durable recovery prevents interrupted capacity from unsafe reassignment (#4, #5, #10, #13, #16).

O4 is **Evidenced**: runs and leases persist to SQLite, restart reconciliation marks orphaned mid-flight runs failed with events intact, and active leases enter `recovering` state to protect capacity from immediate reassignment (#16).

O5 is **Evidenced**: durable project membership resolves an Agent's environment without binding its identity to one; native session keys continue only in their full environment slot; and deterministic project contracts plus privacy-preserving hand-off carry the relevant context across environments ([#18](https://github.com/tinysnake/sprout/issues/18), [#20](https://github.com/tinysnake/sprout/issues/20), [#21](https://github.com/tinysnake/sprout/issues/21)).

O6 is **Evidenced**: Message and Task lifecycles are distinct, Task-held environment leases retain capacity through idle/stop/failure/recovery states, Project workspaces persist across Tasks while temporary Task contexts recycle safely, Web controls govern the collaboration flow, and live Pi/Codex multi-round collaboration is verified on macOS (#24–#36).

O7 is **Evidenced**: the accepted Minesweeper map demonstrates a complete, durable, Human-interruptible, reviewed, and browser-verified game-development collaboration through real Codex and Pi runs (#38–#43).

`docs/roadmap.md` records outcome state and evidence; it does not define the development workflow.

M1 is therefore **Evidenced** as the Local coordination foundation. Product work now advances M2 through the active Local Operator MVP decision map rather than extending M1 mechanically.
