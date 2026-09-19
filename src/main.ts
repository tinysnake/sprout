import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import { EnvironmentPool } from './environment/pool.ts';
import type { Project } from './project/model.ts';
import { ProjectRegistry } from './project/registry.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import { SqliteStore } from './store/db.ts';
import { CollaborationCoordinator } from './collaboration/coordinator.ts';
import { TaskService } from './task/service.ts';
import { TaskEnvironmentLifecycle } from './task/environment-lifecycle.ts';
import { createRunApi } from './web/api.ts';
import { type WorkerConnection } from './worker/carrier.ts';
import {
  createEnvironmentWorkerFactory,
  selectEnvironmentWorker,
} from './worker/environment-worker.ts';
import { EnvironmentWorkerRegistry } from './worker/supervisor.ts';
import { parseHostConfiguration } from './host-config.ts';

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
 * Configuration is host facts rather than product decisions, so it is read once
 * from the environment by the host-configuration Module; this entry point only
 * consumes the typed result.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const {
  databasePath,
  workingDirectory,
  port,
  environmentInstanceId: instanceId,
  engineId,
  runtimeConfiguration,
  environmentKind,
  containerName,
  windowsTarget,
  windowsReadyFile,
  containerMountRoot,
  containerCodexHome,
  containerProxy,
  windowsTunnelPort,
  windowsWorkDirectory: windowsRunWorkdir,
  projectId,
  leaseTtlMs,
} = parseHostConfiguration(process.env, { projectRoot });

/**
 * The host facts carrier and platform selection both depend on.
 *
 * Reading them once here is what lets the environment-worker Module choose a
 * platform and a carrier from one stated description instead of re-reading the
 * host environment.
 */
const environmentWorkerConfiguration = {
  environmentInstanceId: instanceId,
  environmentKind,
  containerName,
  containerMountRoot,
  containerCodexHome,
  containerProxy,
  windowsTarget,
  windowsReadyFile,
  windowsTunnelPort,
  localWorkingDirectory: workingDirectory,
  windowsWorkDirectory: windowsRunWorkdir,
};

/**
 * Reaches the worker for this build's configured environment. Called again after
 * a death.
 *
 * Which carrier is used — a local endpoint, a container's exec channel, or an
 * SSH-tunnelled Windows daemon — is selected by the environment-worker Module,
 * not here. This entry point supplies only the host facts that selection needs.
 */
const environmentWorkerFactory = createEnvironmentWorkerFactory(environmentWorkerConfiguration, {
  workerEntryPath: join(here, 'worker', 'main.ts'),
  nodeExecutable: process.execPath,
  hostEnvironment: process.env,
  logWorkerLine: (source, line) => process.stderr.write(`[${source}-worker] ${line}\n`),
});

async function startEnvironmentWorker(requestedInstanceId: string): Promise<WorkerConnection> {
  return environmentWorkerFactory.connect(requestedInstanceId);
}

/**
 * Engines come from the worker serving the run's resolved instance, not a
 * global map: the adapter that executes a run must belong to the instance the
 * run leases and records (F1, #18). It is also where ADR-0003's lazy,
 * replace-a-dead-worker behaviour now lives, per instance.
 */
const environmentWorkers = new EnvironmentWorkerRegistry({
  connect: (requested) => startEnvironmentWorker(requested),
  onLog: (line) => process.stderr.write(`[env-worker] ${line}\n`),
});

// Fail fast on a misconfigured engine rather than discovering it per run.
const initialEngines = await environmentWorkers.adapters(instanceId);
if (!initialEngines.has(engineId)) {
  process.stderr.write(
    `Sprout: the environment worker does not host engine "${engineId}". ` +
      `It hosts: ${[...initialEngines.keys()].join(', ') || '(none)'}\n`,
  );
  await environmentWorkers.close();
  process.exit(2);
}

/**
 * The environment definition and instance.
 *
 * Only the platform, the definition id, and the working directory differ; every
 * kind declares `requiresLease` the same way, which is why the lease registry
 * needs no platform-specific rule and exclusivity works identically for a
 * container. Selecting them is the environment-worker Module's job.
 */
const { definition, instance } = selectEnvironmentWorker(environmentWorkerConfiguration);

const environmentDefinitions: readonly EnvironmentDefinition[] = [definition];

/**
 * A run's working directory is a fact about the environment, not about Sprout.
 *
 * It therefore lives on the instance, so the same agent works unchanged on a host
 * and inside a container whose path differs (F1 suggestion, #18).
 */
const environmentInstances: readonly EnvironmentInstance[] = [instance];

const defaultAgents: readonly AgentDefinition[] = [
  {
    id: 'scout',
    name: 'Scout',
    engine: engineId,
    capability: 'agent-run',
    instructions:
      'You are Scout, a careful engineering assistant working inside the Sprout project. ' +
      'Answer the request directly and report what you observed.',
  },
];
const agents: readonly AgentDefinition[] = runtimeConfiguration.agents ?? defaultAgents;

/**
 * The default project.
 *
 * Its environment set is what a run's environment is resolved from, so adding an
 * instance here is what makes it usable — the agent no longer names a device.
 */
const sampleProject: Project = {
  id: projectId,
  goal: 'Build Sprout into a local multi-agent collaboration and environment scheduling platform.',
  rules: ['Report what you actually observed.', 'Do not claim work you did not verify.'],
  availableEnvironmentInstanceIds: [instanceId],
  memberships: [
    {
      agentId: 'scout',
      responsibilities: ['Answer direct requests from the project lead', 'Investigate the repository'],
      collaborationInstructions: 'Collaborate through the project channel and keep results concise.',
    },
  ],
};
const defaultProject: Project = runtimeConfiguration.project ?? sampleProject;

const registry = new AgentRegistry(agents);
const store = new SqliteStore({ filename: databasePath });
const pool = new EnvironmentPool({
  definitions: environmentDefinitions,
  instances: environmentInstances,
  store: store.leases,
});
const projects = new ProjectRegistry([defaultProject]);
// The default project above is host-derived configuration, like the environment
// definitions. Additional projects can hydrate from the durable store, which is
// the same store the runs and leases use (ADR-0002); in-memory entries win.
await projects.load(store.projects);

/**
 * The durable Task service (#28).
 *
 * It shares the orchestrator (to submit Task runs) and the primary SQLite store
 * (so Task rows and their run links survive a restart). The orchestrator is wired
 * to it through the two small run-seam contracts rather than importing the Task
 * service, so the Task and Message lifecycles stay independent.
 *
 * The service is declared first as a forward reference so the orchestrator's
 * `onTaskRunSettled` option can close over the same instance it is given below.
 */
let tasks: TaskService;
let taskLifecycle: TaskEnvironmentLifecycle;

const orchestrator = new RunOrchestrator({
  // Resolved per run *for the resolved instance*, so a worker that died is
  // replaced before the next run instead of failing it against a dead channel
  // (ADR-0003), and so execution follows the leased instance (F1, #18).
  engines: (instanceId) => environmentWorkers.adapters(instanceId),
  agents: registry,
  projects,
  pool,
  store: store.runs,
  // Durable engine session keys, so the same agent on the same environment and
  // working directory continues its prior conversation across runs (O5, #20).
  sessionKeys: store.sessionKeys,
  // Durable multi-run Tasks (#28): the run seam assembles a Task run's context
  // and reports its settlement back, without knowing the Task domain model.
  tasks: {
    prompt: (input) => tasks.prompt(input),
    link: (input) => tasks.link(input),
  },
  onTaskRunSettled: (input) => tasks.onRunSettled(input),
  leaseTtlMs,
});

taskLifecycle = new TaskEnvironmentLifecycle({
  store: store.tasks,
  pool,
  agents: registry,
  projects,
  runs: orchestrator,
  worker: {
    prepare: async (input) => (await environmentWorkers.contexts(input.environmentInstanceId)).prepare(input),
    recycle: async (input) => (await environmentWorkers.contexts(input.environmentInstanceId)).recycle(input),
  },
  leaseTtlMs,
});
tasks = new TaskService({ store: store.tasks, runs: orchestrator, lifecycle: taskLifecycle });

/**
 * The collaboration coordinator: durable Messages, the M1 wake contract, and
 * automatic final-result projection (#26).
 *
 * It shares the process's one SQLite database and the run orchestrator, so a
 * reply is projected from the same run record the core persisted. No wake model
 * is configured at M1, which the contract handles explicitly: an unaddressed
 * project-channel Message fails open to one wake per other member (see
 * `src/collaboration/wake.ts`) rather than being silently dropped.
 */
const collaboration = new CollaborationCoordinator({
  projects,
  store: store.collaboration,
  runs: orchestrator,
  onObservation: ({ messageId, observation }) => {
    process.stderr.write(
      `[collaboration] ${observation.status} (${observation.agentId}) ` +
        `on message ${messageId}: ${observation.detail}\n`,
    );
  },
});

const staticRoot = join(projectRoot, 'web', 'dist');
const api = createRunApi({
  orchestrator,
  agents: registry,
  // The project channel is served over the same core: delivery, wake dispatch,
  // and projected replies all go through the one coordinator above.
  collaboration,
  // Members the Web composer may address (#27); read-only from the registry.
  projects,
  // Durable multi-run Tasks (#28): create, list, inspect, and advance.
  tasks,
  staticRoot,
  readFile: async (path) => {
    if (!existsSync(path)) return undefined;
    return readFile(path);
  },
});

const { port: boundPort } = await api.listen(port);

/** Reconcile runs left mid-flight by a previous process before serving. */
const orphaned = await orchestrator.reconcileOrphanedRuns();
await tasks.reconcileEnvironmentLifecycle();

/**
 * Reconcile the collaboration write path after a restart (#26).
 *
 * Runs are reconciled first so an orphaned run is already settled as failed and
 * can never have a reply fabricated for it. This pass then re-admits pending
 * wakes and re-projects replies for completed runs whose projection was lost; it
 * is idempotent, so a clean restart changes nothing.
 */
const reconciled = await collaboration.reconcile();

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

if (reconciled.admittedRunIds.length > 0 || reconciled.projectedMessageIds.length > 0) {
  process.stdout.write(
    `  collab:     reconciled ${reconciled.admittedRunIds.length} pending wake(s), ` +
      `projected ${reconciled.projectedMessageIds.length} reply(ies)\n`,
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
      // The worker registry owns the channels. A *container* is not destroyed
      // here: `rm` is the only irrecoverable action (#4), so its lifecycle is an
      // explicit operator decision rather than a shutdown side effect.
      await environmentWorkers.close();
      store.close();
      process.exit(0);
    });
  });
}
