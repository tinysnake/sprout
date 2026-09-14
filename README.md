# Sprout

A local multi-agent collaboration and environment-scheduling platform. Long-term
direction is in [`docs/goal.md`](docs/goal.md); the current medium-term goal and
its outcome map are in [`docs/roadmap.md`](docs/roadmap.md).

## What currently exists

The first end-to-end slice (issue #10) plus the environment-worker seam (issue #12):

- One request from a local Web client travels through Sprout to a real Codex agent.
- The agent's **engine runs inside a separate worker process** for the environment,
  not inside the Sprout core (ADR-0003). The worker is a long-lived network
  endpoint, reused across runs, and restarted automatically if it dies.
- A capacity-intensive environment instance is protected by a lease, so two runs
  cannot share it.
- An agent names no environment device: a run's environment instance is resolved
  from the project the agent is a member of, and the run records which instance it
  actually used.
- Progress streams to the client; a run can be stopped and its terminal result or
  failure inspected.

Container environments are implemented alongside macOS; Windows, the other three
engines, and durable lease recovery are not.

## Requirements

- Node.js 23 or newer (24+ recommended). Node runs the TypeScript sources
  directly, so there is no build step for the server.
- A `codex` CLI on `PATH`, version 0.138.0 or newer. Codex is launched through
  `app-server` (see [`docs/adr/0001`](docs/adr/0001-codex-runs-through-app-server.md)).

## Run it

```bash
npm install          # Vite, for the Web client
npm run web:build    # build the client into web/dist
npm start            # start the Sprout runtime
```

Sprout starts an environment worker and reaches it over the worker protocol; the
core itself spawns no engine process (ADR-0003). Engine CLIs must be installed
where the worker runs, which for the local macOS environment is this host.

Then open <http://127.0.0.1:5174>.

For client development with hot reload, run `npm start` in one terminal and
`npm run web:dev` in another; the dev server proxies `/api` to the runtime.

Environment overrides: `SPROUT_PORT`, `SPROUT_DATABASE`, `SPROUT_WORKDIR`,
`SPROUT_ENV_INSTANCE`, `SPROUT_LEASE_TTL_MS`, `SPROUT_CODEX_BIN`.

## Test

```bash
npm test                # automated tests (no engine, network, or Docker needed)
npm run typecheck       # server and client type checking
npm run smoke           # live check: real Codex in a worker on the macOS host
npm run image:build     # build the container environment image
npm run smoke:container # live check: real Codex inside a real container
```

See [`environments/container/README.md`](environments/container/README.md) for the
container environment: how the image is built, how an instance is created, and
the platform facts that are easy to get wrong.

`npm test` uses controlled adapters at the engine and environment seams, so it
needs neither Codex nor Docker. `npm run smoke` is the opposite: it exercises the
real seams and prints the observed evidence.

## Layout

```
src/
  agent/        agent identity and configuration, independent of any environment
  environment/  environment model and the lease registry
  engine/       the run seam, JSON-RPC transport, Codex adapter
  project/      projects and project membership, and environment resolution for a run
  run/          run orchestration, run storage (SQLite and in-memory)
  worker/       the environment worker: protocol, server, carrier, supervisor
  web/          the HTTP + SSE surface for the client
  main.ts       the core: orchestrates runs, spawns no engine itself
  worker/main.ts the worker entry point that runs inside an environment
web/            the Vite Web client
scripts/        live smoke check
docs/           goal, roadmap, ADRs, and the development loop
```

Design rules that the code depends on:

- The domain vocabulary lives in [`CONTEXT.md`](CONTEXT.md); use it exactly.
- Engine and environment specifics stay behind their seams. The core never
  learns about JSON-RPC, argv, or Docker, and it spawns no engine process.
- **Every environment is a network environment** (ADR-0003). A worker is an
  addressable endpoint speaking one uniform protocol; only the carrier differs
  between a local machine and a container. There is no in-process fast path.
- Engine protocols are *not* uniform and the worker does not make them so. Only
  the core-to-worker protocol is uniform.
- Streaming granularity is a declared per-adapter capability, not an assumption.
- The engine's own output is not the system of record: the run's recorded events
  are. An interrupted run is re-runnable, never silently lost.
