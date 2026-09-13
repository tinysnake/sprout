# Each environment runs a Sprout worker that supervises its engine processes

Sprout's first slice proved the environment seam for **access and leasing**, but not for **execution**: `MacOsEnvironment` probes the host, while a run's working directory reaches Codex through the agent's configuration — because on a fixed local macOS host, Sprout and the environment happen to be the same machine. That coincidental fact stops being true the moment a container environment exists, because then something must decide where the `codex` process actually runs.

We decided that **each environment runs a Sprout-owned worker, and engines are spawned and supervised inside that environment by its worker.** The core coordinates with workers; it does not know how to start a process on any particular platform.

The rejected alternative was a **single core-side supervisor that reaches into each environment** through the environment adapter (`docker exec` for containers). That is less work now and keeps one orchestration path, but it concentrates per-platform execution knowledge in the core and makes the core the thing that must be ported to every future environment — which `docs/goal.md` rules out: "New agent implementations and environment types can be integrated through stable seams without requiring the core collaboration logic to be rewritten."

**Considered options**: (A) core-side supervisor reaching into each environment; (B) a Sprout worker inside each environment — **chosen**; (C) defer the execution model and ship engine breadth only, rejected because a container environment cannot be implemented without it. This was the repository owner's decision, taken against the agent's recommendation of (A).

**Consequences**

- The engine adapters under `src/engine/` become **the worker's implementation** rather than the core's. The core gains one seam — how it reaches a worker for an environment — and loses all knowledge of spawning engines.
- A **fixed local macOS environment is the degenerate case** where the worker is local. Whether that case also crosses the worker interface is a separate decision, because it determines whether the already-accepted slice is refactored.
- **Worker death becomes a recovery case.** ADR-0001 already made engine-daemon supervision an O4 concern; that now applies one level up as well.
- **The worker is not the agent.** Agent identity, configuration, and memory stay Sprout-owned and portable (`CONTEXT.md`); a worker is *where* a run executes, not *what* an agent is.
- **M1 reuses each environment's existing channel** — a local process, or the container runtime's exec stdio — rather than adding a listening service inside containers. A per-environment network service would be the "remote-execution infrastructure" M1 lists as a non-goal, and would introduce ports, authentication, and version negotiation before the MVP works.
