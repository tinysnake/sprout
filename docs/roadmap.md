# Sprout Outcome Map

This roadmap bridges the durable product direction in `docs/goal.md` and the current short-term development map in GitHub Issues. It records the current medium-term goal and the outcomes needed to prove it, not a fixed implementation plan.

Future outcomes may be split, merged, reordered, or removed when evidence changes the plan. Evidence for completed outcomes remains linked as construction history.

## Status vocabulary

- **Unproven**: the outcome has no sufficient evidence.
- **In progress**: an active development map advances the outcome.
- **Evidenced**: every outcome check has linked acceptance evidence.

## Current medium-term goal

### M1 — Local single-user MVP

**Status**: In progress

Prove that one technical lead can use Sprout locally to coordinate multiple coding Agents across heterogeneous development environments without binding Agent identity or context to a device.

**Scope**:

1. One local human uses Sprout through a Web client.
2. Codex, Pi, `agy`, and `opencode` are the first Agent implementations (four engines, so the run interface is proven by more than a two-adapter seam).
3. Container, macOS, and Windows are the first environment targets.
4. Agent identity, configuration, and context remain independent of a specific environment.
5. A project can define its goal, members, responsibilities, rules, and available environments before work starts.
6. Direct messages, project-channel messages, and basic wake-model behaviour are supported.
7. An Agent can investigate through permitted read-only access and obtain a lease for mutating or capacity-intensive work.
8. An explicitly selected task environment takes priority, with system matching as fallback.
9. Messages, tasks, run results, and shared context are persisted.
10. The human can observe and stop Agent runs and manage environment leases.
11. Sprout, Agent, or lease interruption preserves recoverable state and protects uncommitted work.

**Success checks**:

- All four engines participate as independent Agents in the same project.
- Agents can be allocated across container, macOS, and Windows environments according to work needs.
- Multiple Agents collaborate without conflicting over exclusive environments.
- Restarting Sprout restores project messages, tasks, and observable work state.
- The human can understand what each Agent is doing and stop or correct it.
- A real game-development project completes the full scenario with an exclusive high-resource editor environment; a toy repository alone is insufficient evidence.

**Constraints**:

- The product runs locally and exposes a cross-platform Web client.
- Core modules remain independently testable and verifiable.
- Framework, language, and database choices are made when implementation evidence requires them and recorded as ADRs when appropriate.
- The M1 engine set is Codex, Pi, `agy`, and `opencode`. `zcode` support is deferred until after M1: it requires an ACP bridge on top of the engine, which is extra wiring rather than a first-class engine CLI.

**Non-goals for M1**:

- Cloud multi-tenant SaaS.
- Multiple human users and complex team authorization.
- Advanced message routing, subscriptions, and topic matching.
- A complete workflow or project-management system.
- New model, Agent runtime, container, VM, or remote-execution infrastructure.
- Remote desktop or a complete embedded IDE.
- Production deployment governance.
- General office-work collaboration.
- An optimal context-compression strategy.

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

**Status**: In progress
**Depends on**: O4, O5

All four engines can participate in one project, coordinate through direct and project-channel messages, and perform multi-run work without conflicting over environments.

**Active development map**: [#24](https://github.com/tinysnake/sprout/issues/24) starts with the collaboration write-path and wake-contract prototype in #25; production Message, channel, and Task tickets remain intentionally unplanned until that evidence resolves the current transport and delivery fog.

**Outcome checks**:

- Direct messages and basic project-channel wake behaviour work as defined by the MVP.
- One-round work and durable tasks can both be represented.
- Multiple Agents coordinate around the same project while environment leases remain correct.
- A human can observe, stop, and correct their runs.

### O7 — Real game-development MVP validation

**Status**: Unproven  
**Depends on**: O2, O4, O5, O6

The complete M1 MVP succeeds on its real game-development acceptance scenario.

**Outcome checks**:

- Multiple project members running different engines work across container, macOS, and Windows environments.
- A high-resource editor environment remains exclusive while other useful work proceeds elsewhere.
- Context continues across environments, resource conflicts are prevented, and interrupted work recovers.
- The human operator can understand and control the complete workflow from the Web client.
- Every M1 success check above links to acceptance evidence.

## Frontier after O1, O2, O4, and O5

O1 is **Evidenced**: all four engines (Codex, Pi, `agy`, `opencode`) run live behind the uniform run seam inside environment workers.

O2 is **Evidenced**: macOS, container, and Windows report capabilities and execute through the shared worker and lease model; fixed and cloneable instances are represented without platform rules leaking to callers; and durable recovery prevents interrupted capacity from unsafe reassignment (#4, #5, #10, #13, #16).

O4 is **Evidenced**: runs and leases persist to SQLite, restart reconciliation marks orphaned mid-flight runs failed with events intact, and active leases enter `recovering` state to protect capacity from immediate reassignment (#16).

O5 is **Evidenced**: durable project membership resolves an Agent's environment without binding its identity to one; native session keys continue only in their full environment slot; and deterministic project contracts plus privacy-preserving hand-off carry the relevant context across environments ([#18](https://github.com/tinysnake/sprout/issues/18), [#20](https://github.com/tinysnake/sprout/issues/20), [#21](https://github.com/tinysnake/sprout/issues/21)).

The active frontier is **O6 — Multi-agent collaboration**, advanced by development map [#24](https://github.com/tinysnake/sprout/issues/24). No O6 implementation or acceptance evidence is asserted yet.

`docs/roadmap.md` records outcome state and evidence; it does not define the development workflow.

After O7 is evidenced, mark M1 **Evidenced**, return to `docs/goal.md`, and replace the current medium-term goal and supporting outcome graph rather than extending M1 mechanically.
