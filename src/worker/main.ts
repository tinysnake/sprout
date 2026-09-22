import { parseWorkerConfiguration } from '../host-config.ts';
import { createEnvironmentWorkerEngines, hostEngineFacts } from './engine-selection.ts';
import { EnvironmentWorker } from './server.ts';
import { WORKER_PROTOCOL_VERSION, type WorkerReadinessFacts } from './protocol.ts';
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
 * Configuration is host facts, not product decisions, so it is read once from
 * the environment by the host-configuration Module; this entry point consumes
 * the typed result and keeps only the Worker's own boundary: which carrier
 * applies, which engine adapters exist, and which startup errors a missing fact
 * produces.
 */

const configuration = parseWorkerConfiguration(process.env, { workingDirectory: process.cwd() });
const {
  environmentInstanceId,
  workerHost: host,
  workerPort: port,
  workerTransport: transportMode,
  workspaceRoot,
  readyFile: configuredReadyFile,
  enrollment: enrollmentTarget,
} = configuration;
/**
 * Which engines this environment hosts is an environment fact, so it is selected
 * by the engine-selection Module rather than here. The Worker's entry point only
 * turns the selected configuration into adapters and decides what to do when the
 * host has none.
 */
const engines = createEnvironmentWorkerEngines(hostEngineFacts(configuration));

if (engines.size === 0) {
  process.stderr.write('sprout worker: no engine CLI found on this host; nothing to host\n');
  process.exit(2);
}

const log = (line: string) => process.stderr.write(`[sprout-worker] ${line}\n`);

/**
 * The neutral readiness facts this Worker can honestly report (ADR-0009, #87).
 *
 * A selected adapter means its CLI was located on this host, so `installed` is
 * true. Login and model availability are engine-owned host state the Worker
 * cannot verify without an invasive probe, so they stay `unknown` rather than
 * being assumed; the Web shows them independently of installation.
 */
function workerReadiness(): WorkerReadinessFacts {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engines: [...engines.keys()].map((engine) => ({
      engine,
      installed: true,
      readiness: 'unknown',
      modelAvailability: 'unknown',
      models: [],
    })),
  };
}

/**
 * One `EnvironmentWorker` per connection.
 *
 * Engine processes are shared at the process level through `engines`, so a
 * reconnection does not pay a cold start, while session state stays scoped to
 * the connection that owns it.
 */
/**
 * The enrollment-backed outbound path (#115, ADR-0012).
 *
 * When a pending enrollment was created in Web, this host Worker dials the
 * Sprout instance, claims the enrollment with its one-use secret, and proves its
 * host-local key. The accepted channel then carries the same neutral JSON-RPC
 * server below. This is preferred over any configured carrier when enabled.
 */
if (enrollmentTarget !== undefined) {
  const { connectWorkerEnrollment } = await import('./enrollment-connector.ts');
  const connection = await connectWorkerEnrollment({
    target: enrollmentTarget,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engineFacts: [...engines.keys()].map((engine) => ({
      engine,
      installed: true,
      authenticated: false,
      models: [],
    })),
    log,
  });
  log(
    `connected outbound to ${enrollmentTarget.host} as enrollment ${connection.enrollmentId} ` +
      `(epoch ${connection.epoch}), engines: ${[...engines.keys()].join(', ')}`,
  );
  const worker = new EnvironmentWorker({
    environmentInstanceId,
    engines,
    input: connection.stream,
    output: connection.stream,
    onLog: log,
    workspaceRoot,
    readiness: workerReadiness,
  });
  connection.stream.on('close', () => {
    void worker.shutdown().then(() => process.exit(0));
  });
} else if (transportMode === 'stdio') {
  // The carrier owns the channel: this process's stdio *is* the transport, so
  // there is no address to publish and nothing to listen on.
  const worker = new EnvironmentWorker({
    environmentInstanceId,
    engines,
    input: process.stdin,
    output: process.stdout,
    onLog: log,
    workspaceRoot,
    readiness: workerReadiness,
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
        readiness: workerReadiness,
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
  const readyFile = configuredReadyFile;
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
