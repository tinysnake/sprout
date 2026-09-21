import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import type { AgentStore } from './agent/store.ts';
import { AgentService } from './agent/service.ts';
import type { Agent } from './agent/model.ts';
import { currentOptions } from './agent/model.ts';
import { projectAgentCompatibility } from './agent/compatibility.ts';
import {
  CollaborationCoordinator,
  type CollaborationCoordinatorOptions,
} from './collaboration/coordinator.ts';
import type { CollaborationStore } from './collaboration/store.ts';
import type { EngineAdapter } from './engine/port.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import { EnvironmentPool, type LeaseStore } from './environment/pool.ts';
import type { EnrollmentStore } from './environment/enrollment-store.ts';
import type { EnvironmentReadinessStore } from './environment/readiness-store.ts';
import type { RecoveryStore } from './environment/recovery-store.ts';
import {
  EnvironmentRecoveryService,
} from './environment/recovery-service.ts';
import {
  EnvironmentEnrollmentService,
  type EnvironmentEnrollmentServiceOptions,
} from './environment/enrollment-service.ts';
import type { HostConfiguration } from './host-config.ts';
import type { Project } from './project/model.ts';
import { ProjectRegistry } from './project/registry.ts';
import { BridgedProjectRegistry } from './project/bridged-registry.ts';
import type { ProjectStore } from './project/store.ts';
import type { ProjectAuthorityStore } from './project/authority-store.ts';
import {
  ProjectService,
  type ProjectAgentAuthorityPort,
  type ProjectWorkSafetyPort,
} from './project/authority-service.ts';
import type { AgentRun } from './run/model.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import type { SessionKeyStore } from './run/session-key-store.ts';
import { SqliteStore } from './store/db.ts';
import type { OperatorSessionStore } from './auth/store.ts';
import { OperatorSessionService } from './auth/service.ts';
import type { RunStore } from './run/store.ts';
import {
  TaskEnvironmentLifecycle,
  type TaskContextWorker,
} from './task/environment-lifecycle.ts';
import { TaskService } from './task/service.ts';
import { isTerminalTaskStatus } from './task/model.ts';
import type { TaskStore } from './task/store.ts';
import type { WorkerInfo } from './worker/protocol.ts';
import { createRunApi, type RunApi } from './web/api.ts';
import { createEnvironmentRouter } from './web/environment-router.ts';
import { createAgentRouter } from './web/agent-router.ts';
import { createProjectRouter } from './web/project-router.ts';
import { toRunWorkOptionAttribution } from './web/views.ts';
import { EnvironmentArchiveService } from './environment/archive.ts';
import {
  createEnvironmentWorkerFactory,
  localWorkerEnvironment,
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
  /** The durable one-Operator identity and browser-session boundary. */
  readonly operatorSessions: OperatorSessionStore;
  /** The durable Environment enrollment authority decisions (#87). */
  readonly enrollments: EnrollmentStore;
  /** The durable observed Environment readiness facts (#87). */
  readonly environmentReadiness: EnvironmentReadinessStore;
  /** The durable Environment recovery records and Force Release outcomes (#88). */
  readonly recovery: RecoveryStore;
  /** The durable portable Agent identities (#90). */
  readonly agentIdentities: AgentStore;
  /** The durable Project, template, and membership authority records (#92). */
  readonly projectAuthorities: ProjectAuthorityStore;
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
  /**
   * The neutral Worker facts one environment instance reported on `worker/info`,
   * when it is connected (optional: readiness is an additive observation #87).
   */
  info?(environmentInstanceId: string): Promise<WorkerInfo | undefined>;
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
  /** The Environment enrollment and readiness capability (#87). */
  readonly enrollments: EnvironmentEnrollmentService;
  /** The Environment reconciliation and recovery capability (#88). */
  readonly recovery: EnvironmentRecoveryService;
  /** The portable Agent identity capability (#90). */
  readonly agentService: AgentService;
  /** The Project, template, and membership authority capability (#92). */
  readonly projectService: ProjectService;
  /** The engines the configured environment hosts, validated at construction. */
  readonly engines: ReadonlyMap<string, EngineAdapter>;
  /**
   * Reconcile leftover durable state after a restart, in the one order that is
   * observable: runs first, then Task environment lifecycle, then collaboration.
   * Idempotent, so a clean restart changes nothing.
   */
  reconcile(): Promise<SproutReconciliation>;
  /**
   * Record the live Worker's reported readiness onto one approved enrollment (#87).
   *
   * The facts come from the Worker's own `worker/info` declaration; this maps
   * them onto the durable observed facts without inventing an installation,
   * login, or model state the Worker did not state. When no Worker is connected
   * the observation is skipped: absence of a Worker is not evidence of unreadiness.
   */
  observeWorkerReadiness(enrollmentId: string): Promise<void>;
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
      // Never hand the core environment to a Worker: it can contain the
      // operator credential, browser/session secrets, or unrelated authority.
      hostEnvironment: localWorkerEnvironment(options.hostEnvironment ?? process.env),
      logWorkerLine:
        options.logWorkerLine ??
        ((source, line) => process.stderr.write(`[${source}-worker] ${line}\n`)),
      onWorkerLog: options.onWorkerLog ?? ((line) => process.stderr.write(`[env-worker] ${line}\n`)),
    });

  let stores: RuntimeStores | undefined;
  try {
    // Fail fast on a misconfigured engine rather than discovering it per run. The
    // port is closed before the error propagates so a refused build leaves nothing
    // running; durable state has not been opened yet.
    const engines = await environment.adapters(instanceId);
    if (!engines.has(engineId)) {
      throw new MissingEnvironmentEngineError({
        engineId,
        hostedEngineIds: [...engines.keys()],
      });
    }

    const { definition, instance } = selectEnvironmentWorker(environmentWorkerConfiguration);

    stores = options.stores ?? new SqliteStore({ filename: databasePath });
    const durableStores: RuntimeStores = stores;
    // A narrowed, non-optional alias: after this point a failed store open has
    // already thrown, so the graph below never sees `undefined`.
    const openedStores = stores;
    const operatorSessions = new OperatorSessionService({ store: stores.operatorSessions });
    // Host-local initialization and recovery happen before the HTTP surface is
    // constructed. A missing credential leaves the surface fail-closed rather
    // than creating a default Human authority.
    await operatorSessions.initializeOrRecover(configuration.operatorCredential);

    const agents = new AgentRegistry(runtimeConfiguration.agents ?? defaultAgents(engineId));
    // The durable portable Agent identities (#90). The configured runtime
    // definitions stay the M1 seed registry; the Agent service composes over
    // the same durable handle every other M2 domain uses.
    const agentService = new AgentService({ store: stores.agentIdentities });
    // The bridge between the M2 Project authority and the M1 collaboration
    // machinery (#92, F1): authority Projects are projected into the registry
    // the wake contract and orchestrator read, so one Project identity routes
    // on its Project channel from the moment it exists.
    const projects = new BridgedProjectRegistry([
      runtimeConfiguration.project ?? defaultProject({ projectId, instanceId }),
    ]);
    // The default Project above is host-derived configuration, like the
    // environment definitions. Additional Projects hydrate from the durable
    // store, which is the same store the runs and leases use (ADR-0002);
    // in-memory entries win.
    await projects.load(stores.projects);
    // Authority Projects mirror into the same registry so active Project
    // channels are routable. Host composition is not a durable Project
    // Environment grant, so the bridge never injects this instance as access.
    await projects.loadAuthorities(stores.projectAuthorities);
    // The durable Project, template-snapshot, and membership authority (#92).
    // It composes over the same durable handle every other M2 domain uses, and
    // its active-work safety facts are read-only projections of the same run
    // and Task state the orchestrator and Task service own.
    const projectWorkSafety: ProjectWorkSafetyPort = {
      hasActiveRun: async (projectId) => {
        const runs = await orchestrator.list();
        return runs.some(
          (run) => run.projectId === projectId && (run.status === 'queued' || run.status === 'running'),
        );
      },
      hasUnfinishedTask: async (projectId) => {
        const projectTasks = await openedStores.tasks.list({ projectId });
        return projectTasks.some((task) => !isTerminalTaskStatus(task.status));
      },
      // A lease — active or recovering, run-held or Task-held — whose run or
      // Task belongs to this Project means recovery still owns the Environment
      // even when the rows look finished (F3): a restart leaves a failed
      // orphaned run behind a `recovering` lease.
      hasHeldOrRecoveringLease: async (projectId) => {
        const leases = pool.leases().filter((lease) => lease.state === 'active' || lease.state === 'recovering');
        for (const lease of leases) {
          if (lease.taskId !== undefined) {
            const task = await openedStores.tasks.get(lease.taskId);
            // A live lease with no durable owner cannot be proven unrelated to
            // this Project. Fail closed for every archive/restore attempt.
            if (task === undefined) return true;
            if (task?.projectId === projectId) return true;
            continue;
          }
          if (lease.runId === undefined) return true;
          const run = await openedStores.runs.get(lease.runId);
          if (run === undefined) return true;
          if (run?.projectId === projectId) return true;
        }
        // Recovery itself remains authoritative even if a damaged or partial
        // state no longer has a visible live lease. Resolve the durable owner;
        // an absent owner row is again unknown, never evidence of safety.
        const recoveryRecords = (await openedStores.recovery.list()).filter(
          (record) => record.phase !== 'resolved',
        );
        for (const record of recoveryRecords) {
          if (record.taskId !== undefined) {
            const task = await openedStores.tasks.get(record.taskId);
            if (task === undefined) return true;
            if (task.projectId === projectId) return true;
            continue;
          }
          if (record.runId === undefined) return true;
          const run = await openedStores.runs.get(record.runId);
          if (run === undefined) return true;
          if (run.projectId === projectId) return true;
        }
        return false;
      },
      // Task-end and recovery state live in the Task's environment lifecycle,
      // separate from Task progress: `ending` is a Task end in progress and
      // `recovery` is an open recovery (F3, ADR-0008).
      hasTaskInRecoveryOrEnding: async (projectId) => {
        const projectTasks = await openedStores.tasks.list({ projectId });
        return projectTasks.some(
          (task) =>
            task.environmentLifecycleState === 'recovery' ||
            task.environmentLifecycleState === 'ending' ||
            task.recoveryState !== undefined,
        );
      },
      memberHasActiveRun: async (projectId, memberId) => {
        const runs = await orchestrator.list();
        return runs.some(
          (run) =>
            run.projectId === projectId &&
            run.agentId === memberId &&
            (run.status === 'queued' || run.status === 'running'),
        );
      },
      memberHasUnfinishedTask: async (projectId, memberId) => {
        const projectTasks = await openedStores.tasks.list({ projectId });
        return projectTasks.some(
          (task) => !isTerminalTaskStatus(task.status) && task.assignedAgentId === memberId,
        );
      },
    };
    // Membership must name a real portable Agent authority (#90, F5). The M1
    // seed registry stays authoritative for its definition-era Agents; the
    // durable authority covers every Agent created since #90.
    const projectAgentAuthority: ProjectAgentAuthorityPort = {
      agentIsActive: async (agentId) => {
        const durable = await agentService.get(agentId);
        // A durable lifecycle record wins over a same-id seed definition: an
        // archived Agent must not become eligible through the legacy registry.
        return durable !== undefined ? durable.status === 'active' : agents.get(agentId) !== undefined;
      },
    };
    const projectService = new ProjectService({
      store: stores.projectAuthorities,
      workSafety: projectWorkSafety,
      agentAuthority: projectAgentAuthority,
      // The bridge prepares before persistence and publishes only afterwards;
      // archive commits as removal from every M1 route and wake lookup.
      bridge: projects,
    });
    const pool = new EnvironmentPool({
      definitions: [definition],
      instances: [instance],
      store: stores.leases,
    });

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

    /**
     * The Environment reconciliation and recovery capability (#88).
     *
     * Declared before the Task lifecycle so the lifecycle can report every entry
     * into recovery through this one domain Module, and the recovery service can
     * perform ordinary Task resume/discard and emergency Force Release through the
     * Task service's holder actions once that service exists. Both directions are
     * lazy closures, so neither Module imports the other.
     */
    let recovery: EnvironmentRecoveryService;

    const orchestrator = new RunOrchestrator({
      // Resolved per run *for the resolved instance*, so a worker that died is
      // replaced before the next run instead of failing it against a dead channel
      // (ADR-0003), and so execution follows the leased instance (F1, #18).
      engines: (requestedInstanceId) => environment.adapters(requestedInstanceId),
      agents,
      // Observed engine facts (#87) per instance, so run admission can take the
      // Agent's first compatible work option before any engine accepts the
      // work (#90, ADR-0008). The facts are the readiness store's durable
      // observations for the enrollment of that instance; an unobserved
      // instance admits the Agent's first option unchanged.
      engineFacts: async (requestedInstanceId) => {
        const readiness = await durableStores.environmentReadiness.getReadiness(requestedInstanceId);
        return (readiness?.engines ?? []).map((engine) => ({
          engine: engine.engine,
          installed: engine.installed,
          readiness: engine.readiness,
          models: engine.models,
        }));
      },
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
      // Every Task entry into recovery opens the durable recovery record that
      // protects its lease (#88). The callback only records; the lifecycle keeps
      // ownership of the Task state it just made durable.
      onRecovery: async ({ leaseId, hadActiveRun }) => {
        await recovery.open({
          leaseId,
          cause: 'worker-channel-lost',
          hadActiveRun,
        });
      },
      // ADR-0009 makes Force Release a narrow, explicit exception to ADR-0005's
      // release rule. The pool deliberately refuses a Task-held lease, so the
      // override needs this capability the Environment domain explicitly grants.
      forceReleaseLease: (leaseId) => pool.releaseTaskLease(leaseId) !== undefined,
    });
    tasks = new TaskService({ store: stores.tasks, runs: orchestrator, lifecycle: taskLifecycle });

    recovery = new EnvironmentRecoveryService({
      store: stores.recovery,
      leases: pool,
      // The holder decisions reuse the existing lifecycle ordering rather than
      // re-implementing Task context cleanup or lease release here.
      holders: {
        resumeTask: async (taskId) => {
          await taskLifecycle.recover(taskId, 'resume');
        },
        discardTask: async (taskId) => {
          await taskLifecycle.recover(taskId, 'discard');
        },
        forceReleaseTask: (input) => taskLifecycle.forceRelease(input.taskId, input),
      },
      taskRuns: async (taskId) =>
        (await durableStores.tasks.listRuns(taskId)).map((link) => link.runId),
    });

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
    // Environment enrollment and readiness (#87). It reads the durable enrollment
    // and observed-readiness stores and projects work safety from the same lease
    // registry the run and Task domains use, so the facts never diverge.
    const enrollmentOptions: EnvironmentEnrollmentServiceOptions = {
      enrollments: stores.enrollments,
      readiness: stores.environmentReadiness,
      leases: () => pool.leases(),
      // Recovery records are authoritative over the lease projection, so the
      // summary can distinguish `reconciling` from `recovery` and a reconnect
      // alone is never reported as safe-to-reassign (#88, ADR-0009).
      recoveryRecords: () => recovery.listForEnvironment(instanceId),
      // The one engine this build's configured Agents actually run on is the one
      // engine its configured use requires. Nothing here names a second engine,
      // so an Environment that hosts only this engine is complete rather than a
      // fabricated dual-engine failure (ADR-0008).
      requiredEngines: [engineId],
    };
    const enrollments = new EnvironmentEnrollmentService(enrollmentOptions);
    // Non-destructive archive/restore (#89, ADR-0008). It reads the same lease
    // registry and open recovery records, so an Environment with dependent work
    // can never be archived, and its decisions are ordinary durable enrollment
    // decisions in the same append-only history.
    const archive = new EnvironmentArchiveService({
      enrollments: stores.enrollments,
      leases: pool,
      recovery,
    });
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
      auth: operatorSessions,
      staticRoot,
      readFile: options.readFile ?? defaultReadFile,
      // The Environment enrollment/readiness domain is composed through the #85
      // additive seam, so no central dispatcher grows for it. The recovery routes
      // (#88) are composed through the same seam and delegate every safety rule
      // to the recovery service.
      routers: [
        createEnvironmentRouter({ enrollments, recovery, archive }),
        // Durable Project, template-snapshot, and membership authority (#92),
        // composed through the same #85 additive seam. Only the authenticated
        // Human reaches these routes, so create/edit/membership/archive are
        // Human authority by construction (ADR-0008).
        createProjectRouter({ projects: projectService, legacyProjects: projects }),
        // Portable Agent identities and ordered work options (#90). The
        // compatibility projection reads the same durable observed readiness
        // facts the readiness summary does, so the browser and admission can
        // never disagree about what the Environments support.
        createAgentRouter({
          agents: agentService,
          compatibility: async (agent: Agent) => {
            const readiness = await durableStores.environmentReadiness.getReadiness(instance.id);
            const projection = projectAgentCompatibility({
              workOptions: currentOptions(agent),
              availableEngines: readiness?.engines ?? [],
            });
            return {
              agentId: agent.id,
              environmentInstanceId: instance.id,
              available: projection.available,
              ...(projection.firstAvailable !== undefined ? { firstAvailable: projection.firstAvailable } : {}),
              ...(projection.unavailableReason !== undefined ? { unavailableReason: projection.unavailableReason } : {}),
              options: projection.options,
            };
          },
          runAttribution: async (runId: string) => {
            const run = await orchestrator.load(runId);
            if (run === undefined) return undefined;
            return {
              runId: run.id,
              agentId: run.agentId,
              environmentInstanceId: run.environmentInstanceId,
              attribution: toRunWorkOptionAttribution(run),
            };
          },
        }),
      ],
    });

    /** The last reconciliation result, so `startupReport` reports what ran. */
    let lastReconciliation: SproutReconciliation | undefined;

    const activeStores = stores;

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
      stores: activeStores,
      enrollments,
      recovery,
      agentService,
      projectService,
      engines,

      /** Reconcile runs, then Task lifecycle, then recovery records, then
       * collaboration; runs first so no reply can ever be fabricated for an
       * orphaned run. A process restart is never proof that interrupted work is
       * safe, so a leftover protected lease keeps a `recovery` record (#88). */
      async reconcile(): Promise<SproutReconciliation> {
        const recoveredRuns = await orchestrator.reconcileOrphanedRuns();
        await tasks.reconcileEnvironmentLifecycle();
        await recovery.reconcileAfterRestart();
        const reconciled = await collaboration.reconcile();
        const result: SproutReconciliation = {
          recoveredRuns,
          admittedRunIds: reconciled.admittedRunIds,
          projectedMessageIds: reconciled.projectedMessageIds,
        };
        lastReconciliation = result;
        return result;
      },

      /** Observe the live Worker's reported readiness onto one approved
       * enrollment; the mapping stays honest by recording only what the Worker
       * actually declared on `worker/info`. */
      async observeWorkerReadiness(enrollmentId: string): Promise<void> {
        if (environment.info === undefined) return;
        const enrollment = await enrollments.get(enrollmentId);
        if (enrollment === undefined || enrollment.status !== 'approved') return;
        const info = await environment.info(enrollment.environmentInstanceId);
        if (info === undefined || info.readiness === undefined) return;
        await enrollments.observeWorkerReadiness(enrollmentId, info.readiness);
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
        activeStores.close();
      },
    };
  } catch (error) {
    if (stores) {
      try {
        stores.close();
      } catch {
        // ignore store close error
      }
    }
    try {
      await environment.close();
    } catch {
      // ignore environment close error
    }
    throw error;
  }
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
