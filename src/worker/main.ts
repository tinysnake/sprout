import { parseWorkerConfiguration } from '../host-config.ts';
import { createEnvironmentWorkerEngines, describeEnvironmentWorkerEngines, hostEngineFacts } from './engine-selection.ts';
import { probeEnvironmentReadiness } from './readiness.ts';
import { EnvironmentWorker } from './server.ts';
import { WORKER_PROTOCOL_VERSION, type WorkerReadinessFacts } from './protocol.ts';
import { serveWorkerEndpoint, WORKER_READY_PREFIX } from './carrier.ts';
import { WORKER_DIAGNOSTICS, type WorkerDiagnostic } from './diagnostics.ts';

/**
 * The environment worker's entry point (ADR-0003).
 *
 * Startup diagnostics cross one product-owned allowlist. The endpoint discovery
 * frame on stdout remains machine protocol data for configured carriers; it is
 * not copied into host logs or human-readable diagnostics.
 */
async function runWorker(): Promise<void> {
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
  const engineFacts = hostEngineFacts(configuration);
  const engineConfigurations = describeEnvironmentWorkerEngines(engineFacts);
  const engines = createEnvironmentWorkerEngines(engineFacts);

  if (engines.size === 0) {
    process.stderr.write(`sprout worker: ${WORKER_DIAGNOSTICS.noEngine}\n`);
    process.exitCode = 2;
    return;
  }

  const log = (category: WorkerDiagnostic): void => {
    process.stderr.write(`[sprout-worker] ${category}\n`);
  };

  // Startup readiness is measured by the host Worker before it exposes its
  // first `worker/info`. The browser can later request another probe, but it
  // cannot submit or manufacture any of these facts.
  const startupProbe = await probeEnvironmentReadiness(engineConfigurations);
  let workerReadiness: WorkerReadinessFacts = startupProbe.readiness;
  const runProbe = async () => {
    const result = await probeEnvironmentReadiness(engineConfigurations);
    workerReadiness = result.readiness;
    return result;
  };

  if (enrollmentTarget !== undefined) {
    const { connectWorkerEnrollment } = await import('./enrollment-connector.ts');
    let connection;
    try {
      connection = await connectWorkerEnrollment({
        target: enrollmentTarget,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engineFacts: [...engines.keys()].map((engine) => ({
          engine,
          installed: true,
          authenticated: false,
          models: [],
        })),
        // Connector text is intentionally not forwarded. Identity state has
        // one product category regardless of filesystem detail.
        log: () => log(WORKER_DIAGNOSTICS.identityReady),
      });
    } catch {
      log(WORKER_DIAGNOSTICS.outboundFailed);
      process.exitCode = 1;
      return;
    }
    log(WORKER_DIAGNOSTICS.outboundConnected);
    const worker = new EnvironmentWorker({
      environmentInstanceId,
      engines,
      input: connection.stream,
      output: connection.stream,
      onLog: log,
      workspaceRoot,
      readiness: () => workerReadiness,
      readinessProbe: () => runProbe(),
    });
    connection.stream.on('close', () => {
      void worker.shutdown().then(() => process.exit(0));
    });
    return;
  }

  if (transportMode === 'stdio') {
    const worker = new EnvironmentWorker({
      environmentInstanceId,
      engines,
      input: process.stdin,
      output: process.stdout,
      onLog: log,
      workspaceRoot,
      readiness: () => workerReadiness,
      readinessProbe: () => runProbe(),
    });
    process.stdin.on('error', () => undefined);
    process.stdin.on('close', () => {
      void worker.shutdown();
    });
    log(WORKER_DIAGNOSTICS.transportReady);
    return;
  }

  const endpoint = await serveWorkerEndpoint({
    host,
    port,
    serve: (socket) => {
      const worker = new EnvironmentWorker({
        environmentInstanceId,
        engines,
        input: socket,
        output: socket,
        onLog: log,
        workspaceRoot,
        readiness: () => workerReadiness,
        readinessProbe: () => runProbe(),
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        void worker.shutdown();
      });
    },
  });

  // This line is the configured carrier's private discovery protocol, not a
  // diagnostic. Human-readable logs below never repeat the address.
  process.stdout.write(
    `${WORKER_READY_PREFIX}${JSON.stringify({ host: endpoint.ready.host, port: endpoint.ready.port })}\n`,
  );

  if (configuredReadyFile !== undefined && configuredReadyFile !== '') {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(configuredReadyFile, JSON.stringify(endpoint.ready));
  }
  log(WORKER_DIAGNOSTICS.transportReady);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void endpoint.close().then(() => process.exit(0));
    });
  }
}

try {
  await runWorker();
} catch {
  // Never let Node render an uncaught error containing an endpoint, host path,
  // network fact, provider message, or engine stderr.
  process.stderr.write(`sprout worker: ${WORKER_DIAGNOSTICS.startupFailed}\n`);
  process.exitCode = 1;
}
