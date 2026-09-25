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
  actually used. The worker that executes the run is the one serving that
  resolved instance, so the record always agrees with where the work ran.
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

## Enroll a macOS Environment host

The `sprout` executable (`bin/sprout`) owns the macOS Environment
Worker's bootstrap and signed-in-user lifecycle (ADR-0012):

```bash
# 1. In Sprout Web, create a pending enrollment and copy its one-use secret.
# 2. On the macOS host, claim it. The secret is read from stdin, never argv.
sprout worker enroll 127.0.0.1:5174 <enrollment-id>
# 3. After a Human approves the identity in Web:
sprout worker start            # foreground; establishes the E1 outbound connection
sprout worker install-service  # per-user LaunchAgent: start at sign-in, restart on crash
sprout worker status           # not-enrolled / stopped / connecting / connected / …
sprout worker reset --yes      # remove host-local identity and configuration
sprout worker uninstall-service
```

The Worker key pair is generated on the host and its private key is stored
owner-only under `~/.sprout/worker` (override the root with `SPROUT_WORKER_HOME`);
it is never sent to Sprout, printed, or written to the log. Engine logins stay
host-local. The LaunchAgent label is a pure digest of the environment instance
id (`dev.sprout.worker.<sha256-prefix>`), so no caller-chosen instance text
appears in service metadata. Exit statuses are documented in
`src/worker/cli/worker-cli.ts`: `0` success, `1` local/other failure, `2` usage,
`3` not enrolled, `4` refused, `5` awaiting Human approval, `6` service failure,
`7` already running. `status` validates the configuration and identity-key
permissions and preserves a recorded refusal (`revoked`/`incompatible`/
`pending-approval`) even after the Worker process exits. Live process evidence
that the host cannot inspect takes precedence over `not-enrolled` and `stopped`
and reports `local-configuration-failure`, matching the fail-closed start/reset
fence. The enrollment endpoint argument is strictly a host plus explicit port,
optionally prefixed by `ws://`, `wss://`, `http://`, or `https://`; URL userinfo,
paths, queries, and fragments are rejected rather than normalized into process
arguments. Explicit default ports (`http`/`ws` 80 and `https`/`wss` 443) are
accepted; the CLI preserves the supplied port before WHATWG URL normalization.
`reset` and
`uninstall-service` fail closed: they refuse while a foreground Worker holds the
lock, and they leave host-local state untouched when the LaunchAgent cannot be
proven unloaded. Runtime and lock ownership use an owner-only, per-start opaque
token plus the OS process-start identity (never command-line matching), so PID
reuse, another environment's Worker, and an in-progress reset cannot inherit or
release the Worker state. Pending ownership records are staged, flushed, and
atomically published; an interrupted staging record has no ownership authority,
while complete pending/owner records with unavailable evidence are never
reclaimed. Worker logs and JSON-RPC failures use product-owned categories rather
than endpoint, path, network, provider, or raw stderr text.

## O7 game workspace

The O7 Minesweeper collaboration configuration is in
[`config/o7-minesweeper-runtime.json`](config/o7-minesweeper-runtime.json). It
registers four Agents and a `minesweeper` repository workspace below the local
macOS Environment Worker's root. Initialize the ignored local repository with:

```bash
npm run setup:game-workspace
npm --prefix .sprout-game-workspaces/minesweeper install
npm --prefix .sprout-game-workspaces/minesweeper test
```

Run Sprout against the same Worker root and configuration using relative paths:

```bash
SPROUT_WORKSPACE_ROOT=.sprout-game-workspaces \
SPROUT_RUNTIME_CONFIG="$(cat config/o7-minesweeper-runtime.json)" \
npm start
```

The setup command creates a separate local git repository with the Three.js
canvas scaffold. It does not overwrite non-template files in an existing game
workspace.

## Test

```bash
npm test                # automated tests, failure-only report (no engine, network, or Docker needed)
npm run test:bench      # same tests, with per-test durations sorted slowest first
npm run test:full       # same run with every passing test named
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

`npm test` runs through `scripts/test-summary.ts`, which prints the pass/fail
counters and, only when something fails, that failure's reason and location. Use
`npm run test:full` when you need to see every passing test named; run it into a
file rather than reading the whole thing into context.
`npm test` and `npm run test:bench` stop the test runner and its workers after
180 seconds and exit with code 124; override with `SPROUT_TEST_TIMEOUT_MS` if
needed. Bench durations are per test (not file totals) and can be noisy under
parallel execution. `test:full` invokes Node directly and does not use this
suite deadline.
On timeout, `npm test` only prints the log location, not the test names. It
appends a JSON line (timestamp, test targets, and still-running candidates) to
`test-timeout.jsonl` in the current project directory for later triage. This
file is ignored by Git; project test paths inside it are relative (external
test fixtures are identified only by filename). Override the path with
`SPROUT_TEST_TIMEOUT_LOG`. Parallel tests are candidates, not proven root
causes; if a worker stalls before test execution, the record notes that no
active test was observed.
Timeout entries are a separate triage backlog; a timeout does not mean the
current change caused those candidate tests to hang. Review the log in a
dedicated test-maintenance pass rather than modifying unrelated tests during
the current task.

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
