# Each environment runs a Sprout worker that supervises its engine processes

Sprout's first slice proved the environment seam for **access and leasing**, but not for **execution**: `MacOsEnvironment` probes the host, while a run's working directory reaches Codex through the agent's configuration — because on a fixed local macOS host, Sprout and the environment happen to be the same machine. That coincidental fact stops being true as soon as a container environment exists, because then something must decide where the `codex` process actually runs.

We decided that **each environment runs a Sprout worker, and engines are spawned and supervised inside that environment by its worker.** The core coordinates with workers over one protocol; it does not know how to start a process on any particular platform.

**Every environment is a network environment.** The worker is an addressable endpoint speaking one uniform protocol, and there is no "local environment" special case: a local macOS machine is treated as an environment on the network exactly like any other. Only the *carrier* differs — a TCP endpoint on loopback for a local machine, the container runtime's exec channel for a container — while protocol and semantics are identical either way. The carrier difference exists to avoid exposing container ports, and the authentication and version negotiation that would come with them, before M1 works.

**A worker is long-lived, one per environment instance**, and is reused across runs, so runs after the first skip process start and engine cold start. This is the same reasoning that put Codex behind a supervised `app-server` (ADR-0001). Engine sessions are still created per run.

The rejected alternative was a **single core-side supervisor that reaches into each environment** (`docker exec` for containers). That is less work now, but it concentrates per-platform execution knowledge in the core and makes the core the thing that must be ported to every future environment, which `docs/goal.md` rules out: "New agent implementations and environment types can be integrated through stable seams without requiring the core collaboration logic to be rewritten."

**Considered options**: (A) a core-side supervisor reaching into each environment; (B) a worker inside each environment — **chosen**; (C) defer the execution model and ship engine breadth only, rejected because a container cannot be implemented without it. This was the repository owner's decision, taken against the agent's recommendation of (A).

**Consequences**

- The engine adapters under `src/engine/` become **the worker's implementation**, not the core's. The already-accepted slice is refactored so the local macOS path crosses the worker interface too, rather than keeping a special in-process path: two execution paths would mean the container work tests a different path from the one M1's acceptance scenario mostly uses.
- **The worker is not the agent.** Agent identity, configuration, and memory stay Sprout-owned and portable (`CONTEXT.md`); a worker is *where* a run executes, not *what* an agent is. Leases stay with the core, because they govern access to an environment rather than execution inside it.
- **Worker death becomes a recovery case**, one level above the engine-daemon death ADR-0001 already created. Both belong to O4.
- **Engine protocols are not uniform, and the worker does not make them so.** Codex speaks JSON-RPC (`app-server`); Pi has an RPC mode; `agy` reads line-delimited JSON messages; `opencode` is one-shot with an attachable HTTP server. Only the core-to-worker protocol is uniform; inside the worker each adapter still speaks its own engine's protocol.
