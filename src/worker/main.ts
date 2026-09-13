import { execFileSync } from 'node:child_process';

import type { EngineAdapter } from '../engine/port.ts';
import { CodexEngineAdapter } from '../engine/codex.ts';
import { PiEngineAdapter } from '../engine/pi.ts';
import { AgyEngineAdapter } from '../engine/agy.ts';
import { EnvironmentWorker } from './server.ts';
import { serveWorkerEndpoint, WORKER_READY_PREFIX } from './carrier.ts';

/**
 * The environment worker's entry point.
 *
 * This process is what runs *inside* an environment (ADR-0003). It is started by
 * a carrier — directly for a local machine, through the container runtime for a
 * container — and it publishes its address so the core can reach it. It is
 * deliberately long-lived: the core connects once and reuses it across runs, so
 * runs after the first skip worker start and engine cold start.
 *
 * Configuration is host facts, not product decisions, so it comes from the
 * environment: which instance this worker serves, which engines it hosts, and
 * where the engines live on this machine.
 */

const environmentInstanceId = process.env.SPROUT_ENV_INSTANCE ?? 'local-macos';
const host = process.env.SPROUT_WORKER_HOST ?? '127.0.0.1';
const port = Number(process.env.SPROUT_WORKER_PORT ?? 0);
/**
 * How this worker is reached.
 *
 * `stdio` when the carrier already holds a connected pipe — a container reached
 * through the runtime's exec channel — and `endpoint` when the worker must
 * publish an address for the core to dial, which is the local machine's case.
 * ADR-0003: the protocol is identical either way and only the carrier differs.
 */
const transportMode = process.env.SPROUT_WORKER_TRANSPORT ?? 'endpoint';

/** Codex must be launched through its real path; a PATH symlink fails sandboxed. */
function resolveCodexBinary(): string | undefined {
  if (process.env.SPROUT_CODEX_BIN !== undefined) return process.env.SPROUT_CODEX_BIN;
  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim();
    return found === '' ? undefined : found;
  } catch {
    return undefined;
  }
}

const engines = new Map<string, EngineAdapter>();
const codexBinary = resolveCodexBinary();
if (codexBinary !== undefined) {
  /**
   * The environment's platform decides the engine's sandbox posture.
   *
   * On a shared host, Codex must stay bounded, because other agents and the
   * owner's own work are on the same machine. Inside a container the container is
   * the boundary, and Codex's own sandbox is both redundant and non-functional:
   * an unprivileged container cannot create the user namespace `bwrap` needs, so
   * every turn fails. This is a fact about the environment, so it is decided here
   * where the environment is known, not in the core.
   */
  const sandbox = process.env.SPROUT_ENV_PLATFORM === 'container' ? 'danger-full-access' : 'read-only';
  engines.set(
    'codex',
    new CodexEngineAdapter({
      binaryPath: codexBinary,
      args: ['--strict-config'],
      sandbox,
    }),
  );
}

/** Pi is resolved the same way, since a worker may host either engine. */
function resolveBinary(command: string): string | undefined {
  const override = process.env[`SPROUT_${command.toUpperCase()}_BIN`];
  if (override !== undefined) return override;
  try {
    const found = execFileSync('/bin/sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim();
    return found === '' ? undefined : found;
  } catch {
    return undefined;
  }
}

const piBinary = resolveBinary('pi');
if (piBinary !== undefined) {
  engines.set(
    'pi',
    new PiEngineAdapter({
      binaryPath: piBinary,
      // Sessions live under Sprout's control rather than the user's default, so
      // one agent's conversation does not depend on a machine-local store.
      ...(process.env.SPROUT_PI_SESSION_DIR !== undefined
        ? { sessionDirectory: process.env.SPROUT_PI_SESSION_DIR }
        : {}),
    }),
  );
}

/**
 * Headless `agy` cannot prompt for tool permission, so tools are auto-denied and
 * the run produces nothing. An environment that is itself the isolation boundary
 * therefore has to allow them; a shared host keeps them denied until an explicit
 * decision is made about it.
 */
const agyBinary = resolveBinary('agy');
if (agyBinary !== undefined) {
  engines.set(
    'agy',
    new AgyEngineAdapter({
      binaryPath: agyBinary,
      skipPermissions: process.env.SPROUT_ENV_PLATFORM === 'container',
    }),
  );
}

if (engines.size === 0) {
  process.stderr.write('sprout worker: no engine CLI found on this host; nothing to host\n');
  process.exit(2);
}

const log = (line: string) => process.stderr.write(`[sprout-worker] ${line}\n`);

/**
 * One `EnvironmentWorker` per connection.
 *
 * Engine processes are shared at the process level through `engines`, so a
 * reconnection does not pay a cold start, while session state stays scoped to
 * the connection that owns it.
 */
if (transportMode === 'stdio') {
  // The carrier owns the channel: this process's stdio *is* the transport, so
  // there is no address to publish and nothing to listen on.
  const worker = new EnvironmentWorker({
    environmentInstanceId,
    engines,
    input: process.stdin,
    output: process.stdout,
    onLog: log,
  });
  process.stdin.on('error', () => undefined);
  process.stdin.on('close', () => {
    void worker.shutdown();
  });
  log(`serving over stdio as ${environmentInstanceId}, engines: ${[...engines.keys()].join(', ')}`);
} else {
  const endpoint = await serveWorkerEndpoint({
    host,
    port,
    serve: (socket) => {
      // A socket is bidirectional and satisfies both halves of the transport.
      const worker = new EnvironmentWorker({
        environmentInstanceId,
        engines,
        input: socket,
        output: socket,
        onLog: log,
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        void worker.shutdown();
      });
    },
  });

  // The core discovers the address from this line, which is why a real port is
  // published even for a local machine: a worker is a network endpoint, not a
  // special case (ADR-0003).
  process.stdout.write(
    `${WORKER_READY_PREFIX}${JSON.stringify({ host: endpoint.ready.host, port: endpoint.ready.port })}\n`,
  );
  log(
    `listening on ${endpoint.ready.host}:${endpoint.ready.port} ` +
      `as ${environmentInstanceId}, engines: ${[...engines.keys()].join(', ')}`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void endpoint.close().then(() => process.exit(0));
    });
  }
}
