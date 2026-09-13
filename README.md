# Sprout

A local multi-agent collaboration and environment-scheduling platform. Long-term
direction is in [`docs/goal.md`](docs/goal.md); the current medium-term goal and
its outcome map are in [`docs/roadmap.md`](docs/roadmap.md).

## What currently exists

The first end-to-end slice (issue #10): one request from a local Web client
travels through Sprout to a real Codex agent running on a leased macOS
environment, with observable progress and a working stop command.

This is not the finished MVP. Containers, Windows, the other three engines, and
durable lease recovery are not implemented yet.

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

Then open <http://127.0.0.1:5174>.

For client development with hot reload, run `npm start` in one terminal and
`npm run web:dev` in another; the dev server proxies `/api` to the runtime.

Environment overrides: `SPROUT_PORT`, `SPROUT_DATABASE`, `SPROUT_WORKDIR`,
`SPROUT_ENV_INSTANCE`, `SPROUT_LEASE_TTL_MS`, `SPROUT_CODEX_BIN`.

## Test

```bash
npm test             # automated tests (no engine or network needed)
npm run typecheck    # server and client type checking
npm run smoke        # live check: real Codex on the real macOS host
```

`npm test` uses controlled adapters at the engine and environment seams, so it
needs neither Codex nor Docker. `npm run smoke` is the opposite: it exercises the
real seams and prints the observed evidence.

## Layout

```
src/
  agent/        agent identity and configuration
  environment/  environment model and the lease registry
  engine/       the run seam, JSON-RPC transport, Codex adapter
  run/          run orchestration, run storage (SQLite and in-memory)
  web/          the HTTP + SSE surface for the client
  main.ts       the only module that names concrete adapters
web/            the Vite Web client
scripts/        live smoke check
docs/           goal, roadmap, ADRs, and the development loop
```

Design rules that the code depends on:

- The domain vocabulary lives in [`CONTEXT.md`](CONTEXT.md); use it exactly.
- Engine and environment specifics stay behind their seams. The core never
  learns about JSON-RPC, argv, or Docker.
- Streaming granularity is a declared per-adapter capability, not an assumption.
- The engine's own output is not the system of record: the run's recorded events
  are. An interrupted run is re-runnable, never silently lost.
