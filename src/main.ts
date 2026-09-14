import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import { EnvironmentPool } from './environment/pool.ts';
import { DockerRuntime, containerEnvironmentDefinition } from './environment/container.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import { SqliteStore } from './run/sqlite-store.ts';
import { createRunApi } from './web/api.ts';
import { EndpointCarrier, type WorkerConnection } from './worker/carrier.ts';
import { ContainerCarrier, containerWorkerEntry } from './worker/container-carrier.ts';
import { SshTunnelCarrier, readWindowsReadyFile } from './worker/windows-carrier.ts';
import { WorkerSupervisor } from './worker/supervisor.ts';

/**
 * The M1 runtime entry point.
 *
 * This is the only module that names a concrete adapter, and since ADR-0003 that
 * adapter is a **worker**, not an engine: engines are spawned and supervised
 * inside the environment by its worker, and the core only orchestrates. The core
 * therefore contains no engine process management at all.
 *
 * An environment is chosen here rather than by branching inside the core, and the
 * only thing that differs between a local machine and a container is the
 * **carrier** (ADR-0003): the protocol and its semantics are identical either way.
 *
 * Configuration is read from the environment with local defaults, because these
 * are host facts rather than product decisions.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const databasePath = process.env.SPROUT_DATABASE ?? join(projectRoot, 'sprout.db');
const workingDirectory = process.env.SPROUT_WORKDIR ?? projectRoot;
const port = Number(process.env.SPROUT_PORT ?? 5174);
const instanceId = process.env.SPROUT_ENV_INSTANCE ?? 'local-macos';
const engineId = process.env.SPROUT_ENGINE ?? 'codex';
/** `local` (a machine Sprout runs on), `container`, or `windows` (remote daemon). */
const environmentKind = process.env.SPROUT_ENV_KIND ?? 'local';
/** For a container environment: the instance's container name. */
const containerName = process.env.SPROUT_CONTAINER_NAME ?? instanceId;
/** For a Windows environment: the SSH target of the host running the daemon. */
const windowsTarget = process.env.SPROUT_WINDOWS_TARGET;
/** For a Windows environment: where the readiness file lives on that host. */
const windowsReadyFile = process.env.SPROUT_WINDOWS_READY_FILE ?? 'C:/sprout-daemon/worker-ready.json';

/**
 * Where the worker's code lives inside the environment.
 *
 * A container mounts the repository, so it runs the same worker source as the
 * core; that keeps a stale image a mount problem rather than a silent protocol
 * mismatch.
 */
const containerMountRoot = process.env.SPROUT_CONTAINER_MOUNT ?? '/sprout';

/** The host proxy, translated to the name a container uses for the host. */
function containerProxy(): Record<string, string> {
  const raw = process.env.SPROUT_DOCKER_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!raw) return {};
  const translated = raw.replace(/127\.0\.0\.1|localhost/g, 'host.docker.internal');
  return { HTTPS_PROXY: translated, HTTP_PROXY: translated, NO_PROXY: 'localhost,127.0.0.1' };
}

/** Starts a worker for the configured environment. Called again after a death. */
async function startEnvironmentWorker(): Promise<WorkerConnection> {
  if (environmentKind === 'container') {
    const runtime = new DockerRuntime();
    const availability = await runtime.available();
    if (!availability.available) {
      throw new Error(`container environment unavailable: ${availability.detail}`);
    }
    return new ContainerCarrier({
      runtime,
      containerName,
      workerEntryPath: containerWorkerEntry(containerMountRoot),
      environmentInstanceId: instanceId,
      workingDirectory: containerMountRoot,
      environment: {
        CODEX_HOME: process.env.SPROUT_CONTAINER_CODEX_HOME ?? '/codexhome',
        ...containerProxy(),
      },
      label: `container:${containerName}`,
      onLog: (line) => process.stderr.write(`[container-worker] ${line}\n`),
    }).start();
  }

  if (environmentKind === 'windows') {
    if (windowsTarget === undefined || windowsTarget === '') {
      throw new Error('SPROUT_WINDOWS_TARGET is required for SPROUT_ENV_KIND=windows (e.g. user@host)');
    }
    // Read the daemon's address from the provisioning channel.
    const ready = await readWindowsReadyFile({ target: windowsTarget, remotePath: windowsReadyFile });
    return new SshTunnelCarrier({
      target: windowsTarget,
      daemonPort: ready.port,
      // Collisions across concurrent cores on this machine are an operator
      // concern at M1 size; the port is stable so reconnects are predictable.
      localPort: Number(process.env.SPROUT_WINDOWS_TUNNEL_PORT ?? 12741),
      label: `windows:${windowsTarget}`,
      onLog: (line) => process.stderr.write(`[windows-worker] ${line}\n`),
    }).start();
  }

  return EndpointCarrier.start({
    command: process.execPath,
    args: [join(here, 'worker', 'main.ts')],
    env: { ...process.env, SPROUT_ENV_INSTANCE: instanceId },
    label: 'sprout-worker',
  });
}

/**
 * The supervisor keeps the environment's worker alive across its death, so one
 * worker crash does not permanently poison the environment. It is lazy: a worker
 * is started when a run needs it, not at core startup.
 */
const supervisor = new WorkerSupervisor({
  connect: () => startEnvironmentWorker(),
  onLog: (line) => process.stderr.write(`[env-worker] ${line}\n`),
});

// Fail fast on a misconfigured engine rather than discovering it per run.
const initialEngines = await supervisor.adapters();
if (!initialEngines.has(engineId)) {
  process.stderr.write(
    `Sprout: the environment worker does not host engine "${engineId}". ` +
      `It hosts: ${[...initialEngines.keys()].join(', ') || '(none)'}\n`,
  );
  await supervisor.close();
  process.exit(2);
}

/**
 * The environment definition.
 *
 * Only the platform and the capabilities' names differ. Both kinds declare
 * `requiresLease` the same way, which is why the lease registry needs no
 * platform-specific rule and exclusivity works identically for a container.
 */
const definition: EnvironmentDefinition =
  environmentKind === 'container'
    ? containerEnvironmentDefinition({ id: 'container-linux', image: containerName })
    : environmentKind === 'windows'
      ? {
          id: 'windows-workstation',
          platform: 'windows',
          capabilities: [
            { name: 'agent-run', requiresLease: true },
            { name: 'read-only-investigation', requiresLease: false },
          ],
        }
      : {
          id: 'macos-workstation',
          platform: 'macos',
          capabilities: [
            { name: 'agent-run', requiresLease: true },
            { name: 'read-only-investigation', requiresLease: false },
          ],
        };

const environmentDefinitions: readonly EnvironmentDefinition[] = [definition];
const environmentInstances: readonly EnvironmentInstance[] = [
  { id: instanceId, definitionId: definition.id },
];

/** A run's working directory is a fact about the environment, not about Sprout. */
const windowsRunWorkdir = process.env.SPROUT_WINDOWS_WORKDIR ?? 'C:/sprout-work';
const runWorkingDirectory =
  environmentKind === 'container' ? containerMountRoot
  : environmentKind === 'windows' ? windowsRunWorkdir
  : workingDirectory;

const agents: readonly AgentDefinition[] = [
  {
    id: 'scout',
    name: 'Scout',
    engine: engineId,
    environmentInstanceId: instanceId,
    capability: 'agent-run',
    workingDirectory: runWorkingDirectory,
    instructions:
      'You are Scout, a careful engineering assistant working inside the Sprout project. ' +
      'Answer the request directly and report what you observed.',
  },
];

const registry = new AgentRegistry(agents);
const store = new SqliteStore({ filename: databasePath });
const pool = new EnvironmentPool({
  definitions: environmentDefinitions,
  instances: environmentInstances,
  store: store.leases,
});
const orchestrator = new RunOrchestrator({
  // Resolved per run, so a worker that died is replaced before the next run
  // instead of failing it against a dead channel (ADR-0003).
  engines: () => supervisor.adapters(),
  agents: registry,
  pool,
  store: store.runs,
  leaseTtlMs: Number(process.env.SPROUT_LEASE_TTL_MS ?? 900_000),
});

const staticRoot = join(projectRoot, 'web', 'dist');
const api = createRunApi({
  orchestrator,
  agents: registry,
  staticRoot,
  readFile: async (path) => {
    if (!existsSync(path)) return undefined;
    return readFile(path);
  },
});

const { port: boundPort } = await api.listen(port);

/** Reconcile runs left mid-flight by a previous process before serving. */
const orphaned = await orchestrator.reconcileOrphanedRuns();

process.stdout.write(
  `Sprout listening on http://127.0.0.1:${boundPort}\n` +
    `  agent:      ${agents.map((agent) => agent.id).join(', ')}\n` +
    `  engine:     ${[...initialEngines.keys()].join(', ')} (via environment worker)\n` +
    `  environment: ${instanceId} (${definition.platform}` +
    `${environmentKind === 'container' ? `, container ${containerName}` : `, cwd ${workingDirectory}`})\n` +
    `  database:   ${databasePath}\n`,
);

if (orphaned.length > 0) {
  process.stdout.write(
    `  recovered:  ${orphaned.length} run(s) marked failed after restart: ` +
      `${orphaned.map((run) => run.id).join(', ')}\n`,
  );
}

const recovering = pool.leases().filter((l) => l.state === 'recovering');
if (recovering.length > 0) {
  process.stdout.write(
    `  recovering: ${recovering.length} lease(s) held in recovery: ` +
      `${recovering.map((l) => `${l.id} (${l.instanceId})`).join(', ')}\n`,
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(async () => {
      // The supervisor owns the worker channel. A *container* is not destroyed
      // here: `rm` is the only irrecoverable action (#4), so its lifecycle is an
      // explicit operator decision rather than a shutdown side effect.
      await supervisor.close();
      store.close();
      process.exit(0);
    });
  });
}
