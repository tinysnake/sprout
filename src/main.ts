import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import { EnvironmentPool } from './environment/pool.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import { SqliteRunStore } from './run/sqlite-store.ts';
import { createRunApi } from './web/api.ts';
import { EndpointCarrier, type WorkerConnection } from './worker/carrier.ts';
import { WorkerSupervisor } from './worker/supervisor.ts';

/**
 * The M1 runtime entry point.
 *
 * This is the only module that names a concrete adapter, and since ADR-0003 that
 * adapter is a **worker**, not an engine: engines are spawned and supervised
 * inside the environment by its worker, and the core only orchestrates. The core
 * therefore contains no engine process management at all.
 *
 * Configuration is read from the environment with local defaults rather than
 * being hard-coded, because these are host facts, not product decisions.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const databasePath = process.env.SPROUT_DATABASE ?? join(projectRoot, 'sprout.db');
const workingDirectory = process.env.SPROUT_WORKDIR ?? projectRoot;
const port = Number(process.env.SPROUT_PORT ?? 5174);
const instanceId = process.env.SPROUT_ENV_INSTANCE ?? 'local-macos';
/** The engine the agent should use; it must be one the worker hosts. */
const engineId = process.env.SPROUT_ENGINE ?? 'codex';

/**
 * Starts the environment's worker.
 *
 * A local macOS machine is reached over a real loopback endpoint exactly like any
 * other environment (ADR-0003): a worker is not a special case, only its carrier
 * differs. A container would be started here through its runtime's exec channel
 * instead.
 */
async function startEnvironmentWorker(): Promise<WorkerConnection> {
  const workerEntry = join(here, 'worker', 'main.ts');
  return EndpointCarrier.start({
    command: process.execPath,
    args: [workerEntry],
    env: {
      ...process.env,
      SPROUT_ENV_INSTANCE: instanceId,
    },
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

const environmentDefinitions: readonly EnvironmentDefinition[] = [
  {
    id: 'macos-workstation',
    platform: 'macos',
    capabilities: [
      { name: 'agent-run', requiresLease: true },
      { name: 'read-only-investigation', requiresLease: false },
    ],
  },
];

const environmentInstances: readonly EnvironmentInstance[] = [
  { id: instanceId, definitionId: 'macos-workstation' },
];

const agents: readonly AgentDefinition[] = [
  {
    id: 'scout',
    name: 'Scout',
    engine: engineId,
    environmentInstanceId: instanceId,
    capability: 'agent-run',
    workingDirectory,
    instructions:
      'You are Scout, a careful engineering assistant working inside the Sprout project. ' +
      'Answer the request directly and report what you observed.',
  },
];

const registry = new AgentRegistry(agents);
const store = new SqliteRunStore({ filename: databasePath });
const orchestrator = new RunOrchestrator({
  // Resolved per run, so a worker that died is replaced before the next run
  // instead of failing it against a dead channel (ADR-0003).
  engines: () => supervisor.adapters(),
  agents: registry,
  pool: new EnvironmentPool({
    definitions: environmentDefinitions,
    instances: environmentInstances,
  }),
  store,
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
    `  environment: ${instanceId} (macos, cwd ${workingDirectory})\n` +
    `  database:   ${databasePath}\n`,
);

if (orphaned.length > 0) {
  process.stdout.write(
    `  recovered:  ${orphaned.length} run(s) marked failed after restart: ` +
      `${orphaned.map((run) => run.id).join(', ')}\n`,
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(async () => {
      await supervisor.close();
      store.close();
      process.exit(0);
    });
  });
}
