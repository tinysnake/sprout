import { execFileSync } from 'node:child_process';

import type { EngineAdapter } from '../engine/port.ts';
import { CodexEngineAdapter } from '../engine/codex.ts';
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
  engines.set(
    'codex',
    new CodexEngineAdapter({ binaryPath: codexBinary, args: ['--strict-config'] }),
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
