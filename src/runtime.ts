import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import {
  CollaborationCoordinator,
  type CollaborationCoordinatorOptions,
} from './collaboration/coordinator.ts';
import type { CollaborationStore } from './collaboration/store.ts';
import type { EngineAdapter } from './engine/port.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import { EnvironmentPool, type LeaseStore } from './environment/pool.ts';
import type { HostConfiguration } from './host-config.ts';
import type { Project } from './project/model.ts';
import { ProjectRegistry } from './project/registry.ts';
import type { ProjectStore } from './project/store.ts';
import type { AgentRun } from './run/model.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import type { SessionKeyStore } from './run/session-key-store.ts';
import { SqliteStore } from './store/db.ts';
import type { RunStore } from './run/store.ts';
import {
  TaskEnvironmentLifecycle,
  type TaskContextWorker,
} from './task/environment-lifecycle.ts';
import { TaskService } from './task/service.ts';
import type { TaskStore } from './task/store.ts';
import { createRunApi, type RunApi } from './web/api.ts';
import {
  createEnvironmentWorkerFactory,
  selectEnvironmentWorker,
  type EnvironmentWorkerConfiguration,
  type WorkerLogSource,
} from './worker/environment-worker.ts';
import { EnvironmentWorkerRegistry } from './worker/supervisor.ts';

/**
 * The in-process composition of one Sprout runtime.
 *
 * This is the caller-facing seam the whole object graph is assembled behind.
 * Before this Module existed the graph was a flat top-level script in
 * `src/main.ts`: it read host facts, selected a carrier, built every store and
 * service, opened the Web surface, and installed signals in one place, so the
 * only way to cross the composition was to spawn a whole Sprout process. Now the
 * graph is built here, over **injectable** stores and an **injectable**
 * environment port, and `src/main.ts` is left holding only configuration,
 * construction, listening, reconciliation, and signal handling.
 *
 * Two facts stay exactly where they were:
 *
 * - The environment port is still a **worker**, not an engine (ADR-0003). The
 *   core names only the worker factory and its registry; engines are spawned and
 *   supervised inside the environment. A scripted engine source substitutes the
 *   same port in tests, which is what makes the graph constructible without a
 *   host entrypoint.
 * - The durable stores are still behind the per-domain seams (ADR-0002).
 *   Production opens the unified SQLite handle; a test supplies the in-memory
 *   adapters. The runtime names no concrete store.
 *
 * Nothing above this Module branches on an environment kind, and nothing here
 * changes a lifecycle, lease, protocol, or recovery semantic.
 */

/**
 * The Worker-owned Task context port, re-exported so a caller can substitute it
 * without importing the Task domain directly.
 */
export type { TaskContextWorker };

/**
 * The durable stores one runtime is composed over.
 *
 * Exactly the per-domain seams the graph crosses (`RunStore`, `LeaseStore`,
 * `ProjectStore`, `SessionKeyStore`, `CollaborationStore`, `TaskStore`). The
 * production default is the unified SQLite handle; a composition test supplies
 * the in-memory adapters, so the same graph is exercised either way.
 */
export interface RuntimeStores {
  readonly runs: RunStore;
  readonly leases: LeaseStore;
  readonly projects: ProjectStore;
  readonly sessionKeys: SessionKeyStore;
  readonly collaboration: CollaborationStore;
  readonly tasks: TaskStore;
  close(): void;
}

/**
 * The environment execution port the runtime crosses for one instance.
 *
 * `EnvironmentWorkerRegistry` satisfies this in production. A composition test
 * supplies scripted engine adapters and a stub Task-context client over the same
 * three methods, so "which engines run, and where" is a substitution rather than
 * a live process.
 */
export interface RuntimeEnvironment {
  /** The engines one environment instance currently hosts. */
  adapters(environmentInstanceId: string): Promise<ReadonlyMap<string, EngineAdapter>>;
  /** Worker-owned Task context operations for one environment instance. */
  contexts(environmentInstanceId: string): Promise<TaskContextWorker>;
  /** End the port and fail anything still in flight. */
  close(): Promise<void>;
}

/**
 * A configured engine is not hosted by the resolved environment.
 *
 * Thrown during construction, before any durable state is opened, so the entry
 * point can refuse a misconfigured engine with its existing message and exit
 * code instead of discovering the problem per run.
 */
export class MissingEnvironmentEngineError extends Error {
  readonly engineId: string;
  readonly hostedEngineIds: readonly string[];

  constructor(input: { readonly engineId: string; readonly hostedEngineIds: readonly string[] }) {
    super(
      `Sprout: the environment worker does not host engine "${input.engineId}". ` +
        `It hosts: ${input.hostedEngineIds.join(', ') || '(none)'}`,
    );
    this.name = 'MissingEnvironmentEngineError';
    this.engineId = input.engineId;
    this.hostedEngineIds = input.hostedEngineIds;
  }
}

/** What one restart reconciliation pass recovered, in the order it ran. */
export interface SproutReconciliation {
  /** Runs left mid-flight by a previous process, now marked failed. */
  readonly recoveredRuns: readonly AgentRun[];
  /** Pending wakes re-admitted by the collaboration pass, in wake order. */
  readonly admittedRunIds: readonly string[];
  /** Input Message ids whose reply the collaboration pass (re)projected. */
  readonly projectedMessageIds: readonly string[];
}

/** The wired runtime graph, plus the two lifecycle commands over it. */
export interface SproutRuntime {
  /** The Web transport, created but not yet listening. */
  readonly api: RunApi;
  readonly orchestrator: RunOrchestrator;
  readonly tasks: TaskService;
  readonly collaboration: CollaborationCoordinator;
  readonly pool: EnvironmentPool;
  readonly agents: AgentRegistry;
  readonly projects: ProjectRegistry;
  /** The environment definition selected for this build's configured kind. */
  readonly definition: EnvironmentDefinition;
  /** The one environment instance this build serves. */
  readonly instance: EnvironmentInstance;
  readonly stores: RuntimeStores;
  /** The engines the configured environment hosts, validated at construction. */
  readonly engines: ReadonlyMap<string, EngineAdapter>;
  /**
   * Reconcile leftover durable state after a restart, in the one order that is
   * observable: runs first, then Task environment lifecycle, then collaboration.
   * Idempotent, so a clean restart changes nothing.
   */
  reconcile(): Promise<SproutReconciliation>;
  /**
   * The operator-visible startup report, using the last `reconcile()` result.
   *
   * The format is contract: it is the exact multi-line block the entry point has
   * always written to stdout, including the conditional `recovered`, `collab`,
   * and `recovering` lines. Keeping it here means the entry point writes one
   * string and names no store, service, or environment fact.
   */
  startupReport(boundPort: number): string;
  /**
   * Shut the runtime down in the order the entry point used: end the Web surface
   * (which holds SSE streams open), close the environment port, then the store.
   */
  close(): Promise<void>;
}

/** Host facts the runtime cannot derive from typed configuration alone. */
export interface SproutRuntimeOptions {
  /** The typed host configuration (#79). */
  readonly configuration: HostConfiguration;
  /** The repository root, for the worker entry point and static assets. */
  readonly projectRoot: string;
  /**
   * Overrides the production environment-worker port.
   *
   * Tests supply scripted engine adapters here so the complete graph can be
   * assembled without starting a worker or an engine.
   */
  readonly environment?: RuntimeEnvironment;
  /**
   * Overrides the production SQLite stores.
   *
   * Tests supply the in-memory adapters here so the graph is exercised over
   * collaborators that need no filesystem.
   */
  readonly stores?: RuntimeStores;
  /** The local worker entry point; defaults below `projectRoot`. */
  readonly workerEntryPath?: string;
  readonly nodeExecutable?: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  /** Static files (the Vite build) to serve alongside the API. */
  readonly staticRoot?: string;
  readonly readFile?: (path: string) => Promise<Buffer | undefined>;
  /** Attributed carrier log lines, so diagnostics keep their source prefix. */
  readonly logWorkerLine?: (source: WorkerLogSource, line: string) => void;
  /** Environment-worker supervisor log lines, one per start or failure. */
  readonly onWorkerLog?: (line: string) => void;
  /** Non-wake outcomes for one Message, logged so a suppression is never silent. */
  readonly onObservation?: CollaborationCoordinatorOptions['onObservation'];
}

/**
 * Assemble the complete Sprout object graph.
 *
 * Construction order is the previously observable one: resolve and validate the
 * environment's engines, select the environment definition and instance, open
 * durable state, load Projects, and only then wire the run, Task, collaboration,
 * and Web layers. Engine validation deliberately precedes store creation so a
 * misconfigured engine is still refused before a database is touched.
 */
export async function createSproutRuntime(options: SproutRuntimeOptions): Promise<SproutRuntime> {
  const { configuration, projectRoot } = options;
  const {
    databasePath,
    workingDirectory,
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
  } = configuration;

  /**
   * The host facts carrier and platform selection both depend on.
   *
   * Reading them once here is what lets the environment-worker Module choose a
   * platform and a carrier from one stated description instead of re-reading the
   * host environment.
   */
  const environmentWorkerConfiguration: EnvironmentWorkerConfiguration = {
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

  const environment =
    options.environment ??
    createEnvironmentWorkerPort(environmentWorkerConfiguration, {
      workerEntryPath: options.workerEntryPath ?? join(projectRoot, 'src', 'worker', 'main.ts'),
      nodeExecutable: options.nodeExecutable ?? process.execPath,
      hostEnvironment: options.hostEnvironment ?? process.env,
      logWorkerLine:
        options.logWorkerLine ??
        ((source, line) => process.stderr.write(`[${source}-worker] ${line}\n`)),
      onWorkerLog: options.onWorkerLog ?? ((line) => process.stderr.write(`[env-worker] ${line}\n`)),
    });

  // Fail fast on a misconfigured engine rather than discovering it per run. The
  // port is closed before the error propagates so a refused build leaves nothing
  // running; durable state has not been opened yet.
  let engines: ReadonlyMap<string, EngineAdapter>;
  try {
    engines = await environment.adapters(instanceId);
  } catch (error) {
    await environment.close();
    throw error;
  }
  if (!engines.has(engineId)) {
    const failure = new MissingEnvironmentEngineError({
      engineId,
      hostedEngineIds: [...engines.keys()],
    });
    await environment.close();
    throw failure;
  }

  const { definition, instance } = selectEnvironmentWorker(environmentWorkerConfiguration);

  const stores = options.stores ?? new SqliteStore({ filename: databasePath });

  const agents = new AgentRegistry(runtimeConfiguration.agents ?? defaultAgents(engineId));
  const pool = new EnvironmentPool({
    definitions: [definition],
    instances: [instance],
    store: stores.leases,
  });
  const projects = new ProjectRegistry([
    runtimeConfiguration.project ?? defaultProject({ projectId, instanceId }),
  ]);
  // The default Project above is host-derived configuration, like the environment
  // definitions. Additional Projects hydrate from the durable store, which is the
  // same store the runs and leases use (ADR-0002); in-memory entries win.
  await projects.load(stores.projects);

  /**
   * The durable Task service (#28).
   *
   * It shares the orchestrator (to submit Task runs) and the primary store (so
   * Task rows and their run links survive a restart). The orchestrator is wired
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
    engines: (requestedInstanceId) => environment.adapters(requestedInstanceId),
    agents,
    projects,
    pool,
    store: stores.runs,
    // Durable engine session keys, so the same agent on the same environment and
    // working directory continues its prior conversation across runs (O5, #20).
    sessionKeys: stores.sessionKeys,
    tasks: {
      prompt: (input) => tasks.prompt(input),
      link: (input) => tasks.link(input),
    },
    onTaskRunSettled: (input) => tasks.onRunSettled(input),
    leaseTtlMs,
  });

  taskLifecycle = new TaskEnvironmentLifecycle({
    store: stores.tasks,
    pool,
    agents,
    projects,
    runs: orchestrator,
    worker: {
      prepare: async (input) =>
        (await environment.contexts(input.environmentInstanceId)).prepare(input),
      recycle: async (input) =>
        (await environment.contexts(input.environmentInstanceId)).recycle(input),
    },
    leaseTtlMs,
  });
  tasks = new TaskService({ store: stores.tasks, runs: orchestrator, lifecycle: taskLifecycle });

  /**
   * The collaboration coordinator: durable Messages, the M1 wake contract, and
   * automatic final-result projection (#26).
   *
   * It shares the process's one durable store and the run orchestrator, so a
   * reply is projected from the same run record the core persisted. No wake model
   * is configured at M1, which the contract handles explicitly: an unaddressed
   * project-channel Message fails open to one wake per other member (see
   * `src/collaboration/wake.ts`) rather than being silently dropped.
   */
  const collaboration = new CollaborationCoordinator({
    projects,
    store: stores.collaboration,
    runs: orchestrator,
    onObservation:
      options.onObservation ??
      (({ messageId, observation }) => {
        process.stderr.write(
          `[collaboration] ${observation.status} (${observation.agentId}) ` +
            `on message ${messageId}: ${observation.detail}\n`,
        );
      }),
  });

  const staticRoot = options.staticRoot ?? join(projectRoot, 'web', 'dist');
  const api = createRunApi({
    orchestrator,
    agents,
    // The project channel is served over the same core: delivery, wake dispatch,
    // and projected replies all go through the one coordinator above.
    collaboration,
    // Members the Web composer may address (#27); read-only from the registry.
    projects,
    // Durable multi-run Tasks (#28): create, list, inspect, and advance.
    tasks,
    staticRoot,
    readFile: options.readFile ?? defaultReadFile,
  });

  /** The last reconciliation result, so `startupReport` reports what ran. */
  let lastReconciliation: SproutReconciliation | undefined;

  return {
    api,
    orchestrator,
    tasks,
    collaboration,
    pool,
    agents,
    projects,
    definition,
    instance,
    stores,
    engines,

    /** Reconcile runs, then Task lifecycle, then collaboration; runs first so no
     * reply can ever be fabricated for an orphaned run. */
    async reconcile(): Promise<SproutReconciliation> {
      const recoveredRuns = await orchestrator.reconcileOrphanedRuns();
      await tasks.reconcileEnvironmentLifecycle();
      const reconciled = await collaboration.reconcile();
      const result: SproutReconciliation = {
        recoveredRuns,
        admittedRunIds: reconciled.admittedRunIds,
        projectedMessageIds: reconciled.projectedMessageIds,
      };
      lastReconciliation = result;
      return result;
    },

    startupReport(boundPort: number): string {
      return renderStartupReport({
        boundPort,
        agents,
        engines,
        instanceId,
        definition,
        environmentKind,
        containerName,
        workingDirectory,
        databasePath,
        reconciled: lastReconciliation,
        leases: pool.leases(),
      });
    },

    async close(): Promise<void> {
      // End every open event stream before anything else: `server.close` waits
      // for existing connections, and an SSE stream never ends by itself.
      await api.close();
      // The environment port owns its worker channels. A *container* is not
      // destroyed here: `rm` is the only irrecoverable action (#4), so its
      // lifecycle is an explicit operator decision rather than a side effect.
      await environment.close();
      stores.close();
    },
  };
}

/**
 * The operator-visible startup report, byte-for-byte the previous format.
 *
 * Every conditional line is preserved, including the exact `recovered`,
 * `collab`, and `recovering` wording and their ordering, so an operator (or a
 * live script that scrapes this block) sees no change from the entry point's
 * inline version.
 */
function renderStartupReport(input: {
  readonly boundPort: number;
  readonly agents: AgentRegistry;
  readonly engines: ReadonlyMap<string, EngineAdapter>;
  readonly instanceId: string;
  readonly definition: EnvironmentDefinition;
  readonly environmentKind: string;
  readonly containerName: string;
  readonly workingDirectory: string;
  readonly databasePath: string;
  readonly reconciled: SproutReconciliation | undefined;
  readonly leases: ReturnType<EnvironmentPool['leases']>;
}): string {
  let report =
    `Sprout listening on http://127.0.0.1:${input.boundPort}\n` +
    `  agent:      ${input.agents.list().map((agent) => agent.id).join(', ')}\n` +
    `  engine:     ${[...input.engines.keys()].join(', ')} (via environment worker)\n` +
    `  environment: ${input.instanceId} (${input.definition.platform}` +
    `${input.environmentKind === 'container' ? `, container ${input.containerName}` : `, cwd ${input.workingDirectory}`})\n` +
    `  database:   ${input.databasePath}\n`;

  const reconciled = input.reconciled;
  if (reconciled !== undefined && reconciled.recoveredRuns.length > 0) {
    report +=
      `  recovered:  ${reconciled.recoveredRuns.length} run(s) marked failed after restart: ` +
      `${reconciled.recoveredRuns.map((run) => run.id).join(', ')}\n`;
  }

  if (
    reconciled !== undefined &&
    (reconciled.admittedRunIds.length > 0 || reconciled.projectedMessageIds.length > 0)
  ) {
    report +=
      `  collab:     reconciled ${reconciled.admittedRunIds.length} pending wake(s), ` +
      `projected ${reconciled.projectedMessageIds.length} reply(ies)\n`;
  }

  const recovering = input.leases.filter((lease) => lease.state === 'recovering');
  if (recovering.length > 0) {
    report +=
      `  recovering: ${recovering.length} lease(s) held in recovery: ` +
      `${recovering.map((lease) => `${lease.id} (${lease.instanceId})`).join(', ')}\n`;
  }

  return report;
}

/**
 * Build the production environment port for this build's configured environment.
 *
 * Which carrier is used — a local endpoint, a container's exec channel, or an
 * SSH-tunnelled Windows daemon — is selected by the environment-worker Module,
 * not here. This function supplies only the host facts that selection needs, so
 * this Module stays the one place naming a concrete worker adapter.
 */
function createEnvironmentWorkerPort(
  configuration: EnvironmentWorkerConfiguration,
  dependencies: {
    readonly workerEntryPath: string;
    readonly nodeExecutable: string;
    readonly hostEnvironment: NodeJS.ProcessEnv;
    readonly logWorkerLine: (source: WorkerLogSource, line: string) => void;
    readonly onWorkerLog: (line: string) => void;
  },
): RuntimeEnvironment {
  const factory = createEnvironmentWorkerFactory(configuration, {
    workerEntryPath: dependencies.workerEntryPath,
    nodeExecutable: dependencies.nodeExecutable,
    hostEnvironment: dependencies.hostEnvironment,
    logWorkerLine: dependencies.logWorkerLine,
  });
  return new EnvironmentWorkerRegistry({
    connect: (requested) => factory.connect(requested),
    onLog: dependencies.onWorkerLog,
  });
}

/** Read a static asset, treating a missing file as "not served here". */
async function defaultReadFile(path: string): Promise<Buffer | undefined> {
  if (!existsSync(path)) return undefined;
  return readFile(path);
}

/**
 * The sample Agent, when the runtime configuration names none.
 *
 * An Agent names an engine kind and a capability, never an environment instance:
 * its run's environment is resolved from the Project it belongs to.
 */
function defaultAgents(engineId: string): readonly AgentDefinition[] {
  return [
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
}

/**
 * The default Project, when the runtime configuration names none.
 *
 * Its environment set is what a run's environment is resolved from, so adding an
 * instance here is what makes it usable — the agent no longer names a device.
 */
function defaultProject(input: { readonly projectId: string; readonly instanceId: string }): Project {
  return {
    id: input.projectId,
    goal: 'Build Sprout into a local multi-agent collaboration and environment scheduling platform.',
    rules: ['Report what you actually observed.', 'Do not claim work you did not verify.'],
    availableEnvironmentInstanceIds: [input.instanceId],
    memberships: [
      {
        agentId: 'scout',
        responsibilities: [
          'Answer direct requests from the project lead',
          'Investigate the repository',
        ],
        collaborationInstructions:
          'Collaborate through the project channel and keep results concise.',
      },
    ],
  };
}
