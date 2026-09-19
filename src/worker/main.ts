import { join } from 'node:path';

import { createEnvironmentWorkerEngines, hostEngineFacts } from './engine-selection.ts';
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
const workspaceRoot = process.env.SPROUT_WORKSPACE_ROOT ?? join(process.cwd(), '.sprout-workspaces');

/**
 * Which engines this environment hosts is an environment fact, so it is selected
 * by the engine-selection Module rather than here. The Worker's entry point only
 * turns the selected configuration into adapters and decides what to do when the
 * host has none.
 */
const engines = createEnvironmentWorkerEngines(hostEngineFacts());

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
    workspaceRoot,
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
        workspaceRoot,
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

  // A daemon started detached (Windows WMI, no console) has no stdout to read,
  // so the readiness address is also persisted where its provisioning channel
  // can find it. Best-effort: local discovery does not depend on it.
  const readyFile = process.env.SPROUT_READY_FILE;
  if (readyFile !== undefined && readyFile !== '') {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(readyFile, JSON.stringify(endpoint.ready));
  }
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
