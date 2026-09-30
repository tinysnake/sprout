import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import type { AgentStore } from './agent/store.ts';
import { AgentService } from './agent/service.ts';
import type { Agent } from './agent/model.ts';
import { currentConfiguration, currentOptions } from './agent/model.ts';
import { projectAgentCompatibility } from './agent/compatibility.ts';
import {
  CollaborationCoordinator,
  type CollaborationCoordinatorOptions,
} from './collaboration/coordinator.ts';
import type { CollaborationStore } from './collaboration/store.ts';
import type { EngineAdapter } from './engine/port.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import {
  ADMISSION_CAPABILITY,
  EnvironmentCatalog,
  projectCatalogEntry,
  type EnvironmentCatalogEntry,
  type EnvironmentCatalogInput,
} from './environment/catalog.ts';
import { EnvironmentPool, type LeaseStore } from './environment/pool.ts';
import type { EnvironmentCatalogStore } from './environment/catalog-store.ts';
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
import type { EnvironmentSource, HostConfiguration } from './host-config.ts';
import type { Project } from './project/model.ts';
import { ProjectRegistry } from './project/registry.ts';
import { workspaceFor } from './project/resolve.ts';
import { BridgedProjectRegistry } from './project/bridged-registry.ts';
import type { ProjectStore } from './project/store.ts';
import type { ProjectAuthorityStore } from './project/authority-store.ts';
import { currentProjectContent } from './project/authority-model.ts';
import type { ProjectAccessStore } from './project/access-store.ts';
import type { ProjectCreationStore } from './project/creation-store.ts';
import { ProjectCreationService } from './project/creation-service.ts';
import { sanitizeWorkspacePath } from './project/access.ts';
import {
  ProjectService,
  type ProjectAgentAuthorityPort,
  type ProjectWorkSafetyPort,
} from './project/authority-service.ts';
import {
  ProjectAccessService,
  type ProjectBindingWorkSafetyPort,
  type ProjectEnvironmentAuthorityPort,
} from './project/access-service.ts';
import {
  ConversationScopeService,
  type ConversationProjectPort,
} from './conversation/service.ts';
import type { ConversationScopeStore } from './conversation/store.ts';
import type { AgentRun } from './run/model.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import {
  RunReconnectRetry,
  type RunReconnectRetryReconcileResult,
} from './run/reconnect-retry.ts';
import type { RunReconnectRetryStore } from './run/reconnect-retry-store.ts';
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
import type { WorkerInfo, WorkerReadinessProbeResult } from './worker/protocol.ts';
import type { ValidateWorkspaceParams, ValidateWorkspaceResult } from './worker/protocol.ts';
import { createRunApi, type RunApi } from './web/api.ts';
import { createEnvironmentRouter } from './web/environment-router.ts';
import { createAgentRouter } from './web/agent-router.ts';
import { createProjectRouter } from './web/project-router.ts';
import { createConversationRouter } from './web/conversation-router.ts';
import { createUsageRouter } from './web/usage-router.ts';
import { toRunWorkOptionAttribution } from './web/views.ts';
import { EnvironmentArchiveService } from './environment/archive.ts';
import {
  selectEnvironmentWorker,
  type EnvironmentWorkerConfiguration,
} from './worker/environment-worker.ts';
import { WorkerGateway } from './worker/gateway.ts';
import { effectiveWorkOptions } from './agent/model.ts';
import { readinessRequirements } from './environment/readiness.ts';
import { EnvironmentReadinessWorkflow } from './environment/readiness-workflow.ts';
import { EnrollmentWorkerPort } from './worker/enrollment-port.ts';
import type { UsageStore } from './usage/store.ts';
import { InMemoryUsageStore } from './usage/store.ts';
import { UsageService } from './usage/service.ts';
import { UsageAwareRoutingModelPort } from './usage/routing-adapter.ts';
import type { WorkerConnectionEpochStore } from './environment/worker-epoch-store.ts';
import { SUPPORTED_WORKER_PROTOCOL } from './environment/enrollment-service.ts';
import { workSafetyFromRecovery } from './environment/recovery.ts';

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
  /** The bounded reconnect-retry gate, trigger, and per-run rows (#181). */
  readonly runReconnectRetries: RunReconnectRetryStore;
  readonly leases: LeaseStore;
  readonly projects: ProjectStore;
  readonly sessionKeys: SessionKeyStore;
  readonly collaboration: CollaborationStore;
  readonly tasks: TaskStore;
  /** The durable one-Operator identity and browser-session boundary. */
  readonly operatorSessions: OperatorSessionStore;
  /** The durable Environment enrollment authority decisions (#87). */
  readonly enrollments: EnrollmentStore;
  /** The durable Environment catalog of enrolled instances (E2, #116). */
  readonly environmentCatalog: EnvironmentCatalogStore;
  /** The durable observed Environment readiness facts (#87). */
  readonly environmentReadiness: EnvironmentReadinessStore;
  /** Durable monotonic authority generations for authenticated Workers. */
  readonly workerConnectionEpochs: WorkerConnectionEpochStore;
  /** The durable Environment recovery records and Force Release outcomes (#88). */
  readonly recovery: RecoveryStore;
  /** The durable portable Agent identities (#90). */
  readonly agentIdentities: AgentStore;
  /** The durable Project, template, and membership authority records (#92). */
  readonly projectAuthorities: ProjectAuthorityStore;
  /** The durable Project Environment access and workspace bindings (#93). */
  readonly projectAccess: ProjectAccessStore;
  /** The durable conversation scopes and Working groups (#95). */
  readonly conversationScopes: ConversationScopeStore;
  /** The durable usage activities and append-only observations (#105). */
  readonly usage?: UsageStore;
  /** Atomic insert boundary for first Project + Environment/workspace setup. */
  readonly projectCreation?: ProjectCreationStore;
  close(): void;
}

/** Application-visible stores cannot reserve or commit Worker observations. */
export type RuntimeStoreViews = Omit<RuntimeStores, 'environmentReadiness'> & {
  readonly environmentReadiness: Pick<EnvironmentReadinessStore,
    'getReadiness' | 'getCurrentObservation' | 'listObservations' | 'listProbes' | 'getReceipt' | 'getObservation' | 'getAttempt'>;
};

/** Enrollment lifecycle and read commands, never the observation writer/issuer. */
export type EnrollmentLifecycle = Pick<EnvironmentEnrollmentService,
  'list' | 'get' | 'requestEnrollment' | 'claimEnrollment' | 'issueChallenge' |
  'connectWorker' | 'approve' | 'authorizeModels' | 'revoke' | 'reset' | 'cancelEnrollment' | 'regenerateClaimSecret' | 'setCapabilityPermission' |
  'getObservation' | 'getReceipt' | 'listProbes' | 'readiness'>;

/** Inspection of accepted Workers, not their observation authority issuer. */
export interface WorkerGatewayView {
  liveFor(instanceId: string): Pick<import('./worker/gateway.ts').WorkerGatewayAcceptance,
    'accepted' | 'enrollment' | 'epoch' | 'requiredModels'> | undefined;
  currentConnectionEpoch(enrollmentId: string): number | undefined;
  isCurrentConnection: WorkerGateway['isCurrentConnection'];
}

/**
 * The environment execution port the runtime crosses for one instance.
 *
 * In production `EnrollmentWorkerPort` satisfies this over the enrolled
 * Environment catalog (E2, ADR-0012): lookups never dial or start a Worker. A
 * composition test supplies scripted engine adapters and a stub Task-context
 * client over the same three methods, so "which engines run, and where" is a
 * substitution rather than a live process.
 */
export interface RuntimeEnvironment {
  /** The engines one environment instance currently hosts. */
  adapters(environmentInstanceId: string): Promise<ReadonlyMap<string, EngineAdapter>>;
  /** Worker-owned Task context operations for one environment instance. */
  contexts(environmentInstanceId: string): Promise<TaskContextWorker>;
  /**
   * Ask the Worker serving one instance to validate or prepare a Project
   * workspace selection (#93). The Worker is the filesystem authority: only it
   * turns a portable selection into a real workspace, and only it may create the
   * Worker-managed default.
   */
  validateWorkspace?(
    environmentInstanceId: string,
    input: ValidateWorkspaceParams,
  ): Promise<ValidateWorkspaceResult>;
  /**
   * The neutral Worker facts one environment instance reported on `worker/info`,
   * when it is connected (optional: readiness is an additive observation #87).
   */
  info?(environmentInstanceId: string): Promise<WorkerInfo | undefined>;
  /** Execute a non-inference probe on an already accepted Worker. */
  probeReadiness?(environmentInstanceId: string, attemptId?: string, requirements?: import('./environment/readiness.ts').ReadinessRequirementScope): Promise<WorkerReadinessProbeResult | undefined>;
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
  /** What the bounded reconnect-retry pass armed, triggered, queued, dispatched, and settled (#181). */
  readonly reconnectRetries: RunReconnectRetryReconcileResult;
  /** Run ids whose system failure event the collaboration pass published (#180). */
  readonly failureEventRunIds: readonly string[];
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
  /**
   * The dynamic, instance-keyed Environment catalog (E2, #116).
   *
   * Every enrolled Environment instance is an inspectable entry while it exists,
   * and only an eligible entry admits automatic Project/run work.
   */
  readonly environmentCatalog: EnvironmentCatalog;
  /** The environment definition of the configured M1 carrier, when composed. */
  readonly definition: EnvironmentDefinition | undefined;
  /** The configured M1 carrier instance, when composed; `undefined` under enrollment. */
  readonly instance: EnvironmentInstance | undefined;
  readonly stores: RuntimeStoreViews;
  /** The Environment enrollment and readiness capability (#87). */
  readonly enrollments: EnrollmentLifecycle;
  /** The Environment reconciliation and recovery capability (#88). */
  readonly recovery: EnvironmentRecoveryService;
  /** The portable Agent identity capability (#90). */
  readonly agentService: AgentService;
  /** The Project, template, and membership authority capability (#92). */
  readonly projectService: ProjectService;
  /** The Project Environment access and workspace capability (#93). */
  readonly projectAccess: ProjectAccessService;
  /** The conversation scope and Working group capability (#95). */
  readonly conversationScopes: ConversationScopeService;
  /** The truthful Usage and cost observation capability (#105). */
  readonly usage: UsageService;
  /**
   * How this Sprout instance reaches its production Worker (ADR-0012 / E2).
   * `configured` is the M1 carrier path retained only for an injected
   * test/development carrier; `enrollment` is the production catalog path.
   */
  readonly environmentSource: EnvironmentSource;
  /**
   * The enrollment-backed outbound Worker gateway and its connection epochs
   * (#115). Present so Web-created pending enrollments have a machine channel.
   */
  readonly workerGateway: WorkerGatewayView;
  /**
   * The runtime environment port over accepted enrollment-backed connections
   * (E1) and the accepted-connection registry the dynamic catalog projects from
   * (E2). It is the production run seam and never dials a Worker.
   */
  readonly enrollmentEnvironment: EnrollmentWorkerPort;
  /** The engines the configured environment hosts, validated at construction. */
  readonly engines: ReadonlyMap<string, EngineAdapter>;
  /**
   * Re-project the durable catalog and publish its eligible membership to the
   * pool (E2, #116). Exposed so a caller can refresh admission after a human
   * approval, revocation, archive, readiness observation, or recovery change
   * without restarting the process or editing runtime JSON.
   */
  refreshEnvironmentCatalog(): Promise<readonly EnvironmentCatalogEntry[]>;
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
  /** Static files (the Vite build) to serve alongside the API. */
  readonly staticRoot?: string;
  readonly readFile?: (path: string) => Promise<Buffer | undefined>;
  /** Environment-worker log lines, so accepted-connection diagnostics are visible. */
  readonly onWorkerLog?: (line: string) => void;
  /** Non-wake outcomes for one Message, logged so a suppression is never silent. */
  readonly onObservation?: CollaborationCoordinatorOptions['onObservation'];
  /** Trusted host-composed wake model, never supplied through Human HTTP. */
  readonly routingModel?: CollaborationCoordinatorOptions['routingModel'];
}

/** Explicit private composition injection, used only by adapter tests. */
export type SproutTestComposition = {
    stores: RuntimeStores;
    enrollments: EnvironmentEnrollmentService;
    workerGateway: WorkerGateway;
    readinessWorkflow: EnvironmentReadinessWorkflow;
};

export function createSproutRuntime(options: SproutRuntimeOptions): Promise<SproutRuntime> {
  return composeSproutRuntime(options);
}

/** An explicit adapter-test seam; not an option on the production constructor. */
export function createSproutRuntimeForTest(options: SproutRuntimeOptions,
  capture: (composition: SproutTestComposition) => void): Promise<SproutRuntime> {
  return composeSproutRuntime(options, capture);
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
async function composeSproutRuntime(options: SproutRuntimeOptions,
  capture?: (composition: SproutTestComposition) => void): Promise<SproutRuntime> {
  const { configuration, projectRoot } = options;
  const {
    databasePath,
    workingDirectory,
    environmentInstanceId: instanceId,
    engineId,
    runtimeConfiguration,
    environmentKind,
    environmentSource,
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

  /**
   * The injected test/development carrier, when the caller supplied one.
   *
   * Production no longer composes a configured Worker carrier at all (E2,
   * ADR-0012): enrolled Environment instances are the execution catalog, and an
   * injected `options.environment` remains only so tests and the container
   * development carrier can substitute the same port. The former
   * `SPROUT_ENV_KIND`-driven configured production path is removed rather than
   * retained as a fallback.
   */
  const environment = options.environment;

  /**
   * The production execution seam (ADR-0012).
   *
   * The run seam is the accepted enrollment-backed port, which is only available
   * after the gateway and stores are constructed. This delegate carries the
   * orchestrator, Task lifecycle, and Project-access wiring across that ordering
   * while never dialing or starting a Worker.
   */
  const switchableEnvironment =
    options.environment === undefined ? new EnrollmentEnvironmentDelegate() : undefined;
  const runtimeEnvironment: RuntimeEnvironment = options.environment ?? switchableEnvironment!;

  let stores: RuntimeStores | undefined;
  try {
    // Fail fast on a misconfigured engine rather than discovering it per run. The
    // port is closed before the error propagates so a refused build leaves nothing
    // running; durable state has not been opened yet. Under the enrollment source
    // (ADR-0012) no Worker is connected at construction, so there is no engine to
    // validate: the accepted connection carries its engines when it arrives.
    const engines =
      environment === undefined
        ? new Map<string, EngineAdapter>()
        : await environment.adapters(instanceId);
    if (environment !== undefined && !engines.has(engineId)) {
      throw new MissingEnvironmentEngineError({
        engineId,
        hostedEngineIds: [...engines.keys()],
      });
    }

    const { definition: configuredDefinition, instance: configuredInstance } =
      selectEnvironmentWorker(environmentWorkerConfiguration);
    // The configured definition/instance is only a fact of an injected
    // test/development carrier. Under the enrollment catalog the definition and
    // instance are projected per enrolled Environment instance and there is no
    // single static one (E2, ADR-0012).
    const configuredCarrierPresent = environment !== undefined;

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
    const currentRequirements = async () => {
      const durable = (await agentService.list()).filter((agent) => agent.status !== 'archived');
      const identities = new Set(durable.map((agent) => agent.id));
      const options = [
        ...agents.list().filter((agent) => !identities.has(agent.id)).flatMap((agent) =>
          effectiveWorkOptions(agent).map((option) => ({ ...option, id: agent.id }))),
        ...durable.flatMap((agent) => currentOptions(agent).map((option) => ({ ...option, id: agent.id }))),
      ];
      // A version bump can edit instructions or effort without changing the
      // model a Worker must measure. Applicability is the target set, not the
      // Agent document's unrelated revision.
      return readinessRequirements(options);
    };
    const currentOptionsByAgent = async () => {
      const durable = (await agentService.list()).filter((agent) => agent.status !== 'archived');
      const identities = new Set(durable.map((agent) => agent.id));
      const byAgent: Record<string, { engine: string; workModel: string }[]> = {};
      for (const agent of agents.list().filter((a) => !identities.has(a.id))) {
        byAgent[agent.id] = effectiveWorkOptions(agent).map((opt) => ({ engine: opt.engine, workModel: opt.workModel }));
      }
      for (const agent of durable) {
        byAgent[agent.id] = currentOptions(agent).map((opt) => ({ engine: opt.engine, workModel: opt.workModel }));
      }
      return byAgent;
    };
    // The bridge between the M2 Project authority and the M1 collaboration
    // machinery (#92, F1): authority Projects are projected into the registry
    // the wake contract and orchestrator read, so one Project identity routes
    // on its Project channel from the moment it exists.
    const projects = new BridgedProjectRegistry([
      runtimeConfiguration.project ??
        defaultProject({
          projectId,
          // The default Project only names the configured test/development
          // carrier instance. Under the enrollment catalog there is no static
          // instance, so the default Project starts with no granted Environment
          // and gains one through a Human access grant (#93), exactly as a
          // catalog instance must.
          instanceIds: configuredCarrierPresent ? [configuredInstance.id] : [],
        }),
    ]);
    // The default Project above is host-derived configuration, like the
    // environment definitions. Additional Projects hydrate from the durable
    // store, which is the same store the runs and leases use (ADR-0002);
    // in-memory entries win.
    await projects.load(stores.projects);
    // Authority Projects mirror into the same registry so active Project
    // channels are routable. Host composition is not a durable Project
    // Environment grant, so the bridge never injects this instance as access.
    await projects.loadAuthorities(stores.projectAuthorities, [], stores.projectAccess);
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
    /**
     * The Project facts the conversation scope Module validates against (#95).
     *
     * A narrow read-only projection of the same durable #92 authority record —
     * lifecycle, versioned goal/rules, and membership facts — so Project
     * lifecycle stays owned by one Module. A host-configured M1 Project with no
     * authority record projects as active content version `0` with its
     * configured members plus the local Human, mirroring the "one identity,
     * never two" merge the BridgedProjectRegistry applies elsewhere.
     */
    const conversationProjects: ConversationProjectPort = {
      async projectFacts(projectId) {
        const authority = await openedStores.projectAuthorities.get(projectId);
        if (authority !== undefined) {
          const content = currentProjectContent(authority);
          return {
            projectId: authority.id,
            status: authority.status,
            contentVersion: authority.content.currentVersion,
            goal: content.goal,
            rules: [...content.rules],
            wakePolicy: content.wakePolicy,
            routingIntervalMs: content.routingIntervalMs,
            members: content.memberships.map((membership) => ({
              memberId: membership.memberId,
              memberKind: membership.memberKind,
              responsibilities: [...membership.responsibilities],
              collaborationInstructions: membership.collaborationInstructions,
              ...(membership.endedAt !== undefined ? { endedAt: membership.endedAt } : {}),
              ...(membership.endedReason !== undefined
                ? { endedReason: membership.endedReason }
                : {}),
            })),
          };
        }
        const configured = projects.get(projectId);
        if (configured === undefined) return undefined;
        return {
          projectId: configured.id,
          status: 'active',
          contentVersion: 0,
          goal: configured.goal,
          rules: [...configured.rules],
          // A host-configured M1 Project carries no policy record: it projects
          // the ADR-0007 defaults, exactly like migration and the template.
          wakePolicy: 'explicit-only' as const,
          routingIntervalMs: 30_000,
          members: [
            // The local Human is a member of every Project (ADR-0008); the M1
            // projection carries no durable membership rows, so it attributes
            // the Human with the operator member id ProjectService defaults to.
            { memberId: 'operator', memberKind: 'human' as const },
            ...configured.memberships.map((membership) => ({
              memberId: membership.agentId,
              memberKind: 'agent' as const,
              responsibilities: [...membership.responsibilities],
              collaborationInstructions: membership.collaborationInstructions,
            })),
          ],
        };
      },
    };
    /**
     * The conversation scope and Working group capability (#95): the invariant
     * Project channel, Project-scoped direct conversations, and temporary
     * Working groups with durable membership history (ADR-0008). It holds no
     * Message, wake, run, Task, or lease port, so scope commands can never
     * wake an Agent or create work by themselves.
     */
    const conversationScopes = new ConversationScopeService({
      store: stores.conversationScopes,
      projects: conversationProjects,
    });
    // Hydrate the Project channel invariant for every Project that already
    // exists before this composition serves: durable authority records from
    // earlier runs and the host-configured projection each gain their one
    // Project channel, idempotently (ADR-0008: the channel is an invariant of
    // the Project, not template content).
    for (const authority of await openedStores.projectAuthorities.list()) {
      // Hydration settles the preparation immediately: the Project already
      // exists, so this is the ensure side, never an in-flight creation.
      (await conversationScopes.prepareProjectChannel(authority)).commit();
    }
    for (const configured of projects.list()) {
      await conversationScopes.ensureProjectChannel(configured.id);
    }
    const projectService = new ProjectService({
      store: stores.projectAuthorities,
      workSafety: projectWorkSafety,
      agentAuthority: projectAgentAuthority,
      // The bridge prepares before persistence and publishes only afterwards;
      // archive commits as removal from every M1 route and wake lookup. The
      // conversation scope bridge records the Project's one Project channel
      // during the same preparation, so a Project creation and its invariant
      // channel become durable together (#95, ADR-0008). If the Project fails
      // to persist, the prepared rollback removes the channel row this
      // preparation created — and only that row — so a failed creation leaves
      // no orphan scope record; a retried creation finds the channel
      // idempotently.
      bridge: {
        async prepare(project) {
          const channel = await conversationScopes.prepareProjectChannel(project);
          let publishRegistry: () => void;
          try {
            publishRegistry = (await projects.prepare(project)).commit;
          } catch (error) {
            try {
              await channel.rollback();
            } catch {
              // The preparation failure stays the reported error.
            }
            throw error;
          }
          return {
            commit: () => {
              publishRegistry();
              channel.commit();
            },
            rollback: () => channel.rollback(),
          };
        },
      },
    });
    /**
     * The Project Environment access and Project workspace capability (#93).
     *
     * The Worker is the filesystem authority: a grant or a workspace change
     * first asks the resolved Environment's Worker to validate or prepare the
     * selection, and only then does the durable access relationship change. The
     * binding bridge republishes the Project's M1 projection so a newly granted
     * environment is immediately resolvable by a run.
     */
    const projectAccessSafety: ProjectBindingWorkSafetyPort = {
      hasActiveWorkOnEnvironment: async (projectId, environmentInstanceId) => {
        const runs = await orchestrator.list();
        if (
          runs.some(
            (run) =>
              run.projectId === projectId &&
              run.environmentInstanceId === environmentInstanceId &&
              (run.status === 'queued' || run.status === 'running'),
          )
        ) {
          return true;
        }
        const projectTasks = await openedStores.tasks.list({ projectId });
        if (
          projectTasks.some(
            (task) =>
              !isTerminalTaskStatus(task.status) && task.environmentInstanceId === environmentInstanceId,
          )
        ) {
          return true;
        }
        // A held or recovering lease — run-held or Task-held — means the
        // Environment still owns work even when the rows look finished. An
        // absent owner row is unknown, never evidence of safety.
        const leases = pool
          .leases()
          .filter(
            (lease) =>
              lease.instanceId === environmentInstanceId &&
              (lease.state === 'active' || lease.state === 'recovering'),
          );
        for (const lease of leases) {
          if (lease.taskId !== undefined) {
            const task = await openedStores.tasks.get(lease.taskId);
            if (task === undefined) return true;
            if (task.projectId === projectId) return true;
            continue;
          }
          if (lease.runId === undefined) return true;
          const run = await openedStores.runs.get(lease.runId);
          if (run === undefined) return true;
          if (run.projectId === projectId) return true;
        }
        const recoveryRecords = (await openedStores.recovery.list()).filter(
          (record) => record.phase !== 'resolved' && record.environmentInstanceId === environmentInstanceId,
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
    };
    // Access names only an enrolled Environment instance that exists in the
    // durable catalog (E2, #116). A bare instance id is never a granted
    // authority, exactly like membership never names an invented Agent (F5,
    // #92). Accessibility is independent of current eligibility: an offline or
    // recovering instance can still be granted Project access, while only an
    // eligible one admits automatic resolution.
    const projectEnvironmentAuthority: ProjectEnvironmentAuthorityPort = {
      environmentIsAccessible: async (environmentInstanceId) => {
        const enrollments = await openedStores.enrollments.list();
        return enrollments.some(
          (enrollment) =>
            enrollment.environmentInstanceId === environmentInstanceId &&
            enrollment.status === 'approved',
        );
      },
    };
    const projectAccessService = new ProjectAccessService({
      store: stores.projectAccess,
      projects: projectService,
      worker: {
        validate: (input) =>
          runtimeEnvironment.validateWorkspace !== undefined
            ? runtimeEnvironment.validateWorkspace(input.environmentInstanceId, {
                projectId: input.projectId,
                environmentInstanceId: input.environmentInstanceId,
                kind: input.selection.kind,
                ...(input.selection.path !== undefined ? { path: input.selection.path } : {}),
              })
            : Promise.reject(
                new Error('this environment port cannot validate Project workspaces'),
              ),
      },
      environments: projectEnvironmentAuthority,
      workSafety: projectAccessSafety,
      bridge: projects,
    });
    const projectCreationService = stores.projectCreation === undefined
      ? undefined
      : new ProjectCreationService({
          projects: projectService,
          access: projectAccessService,
          store: stores.projectCreation,
        });
    const pool = new EnvironmentPool({
      definitions: configuredCarrierPresent ? [configuredDefinition] : [],
      instances: configuredCarrierPresent ? [configuredInstance] : [],
      store: stores.leases,
      // The catalog eligibility gate. Under the enrollment catalog this is the
      // dynamic membership; an injected configured carrier keeps M1 behaviour
      // with exactly its one static instance.
      ...(configuredCarrierPresent
        ? { eligibleInstanceIds: [configuredInstance.id] }
        : { eligibleInstanceIds: [] }),
    });
    // A durable authority, readiness, or recovery change schedules an
    // asynchronous catalog re-projection (E2). The scheduled function is replaced
    // once `refreshEnvironmentCatalog` exists below; the indirection lets the
    // enrollment, archive, and recovery services observe changes without
    // importing the catalog or making their durable write depend on it.
    let scheduleCatalogRefresh: () => void = () => undefined;
    const onEnrollmentMutation = (): void => scheduleCatalogRefresh();
    /**
     * The dynamic, instance-keyed Environment catalog (E2, #116).
     *
     * It is the single projection from durable enrollment authority plus observed
     * readiness facts to the instances that may admit automatic Project/run work.
     * Its eligible membership is pushed into the pool, so resolution, admission,
     * and leases all agree about which instance is usable. The catalog itself
     * starts empty and is filled by the refresh below, after the enrollment
     * service and gateway exist.
     */
    const environmentCatalog = new EnvironmentCatalog();

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
      engines: (requestedInstanceId) => runtimeEnvironment.adapters(requestedInstanceId),
      agents,
      resolveAgent: async (agentId) => {
        const durable = await agentService.get(agentId);
        if (durable === undefined) return agents.get(agentId);
        if (durable.status !== 'active') return undefined;
        const configuration = currentConfiguration(durable);
        const seed = agents.get(agentId);
        return {
          id: durable.id,
          name: durable.displayName,
          engine: configuration.options[0]!.engine,
          capability: seed?.capability ?? 'agent-run',
          workOptions: configuration.options,
          configurationVersion: configuration.version,
          ...(configuration.instructions !== undefined ? { instructions: configuration.instructions } : {}),
          ...(seed?.workingDirectory !== undefined ? { workingDirectory: seed.workingDirectory } : {}),
        };
      },
      // Observed engine facts (#87) per instance, so run admission can take the
      // Agent's first compatible work option before any engine accepts the
      // work (#90, ADR-0008). The facts are the readiness store's durable
      // observations for the enrollment of that instance; an unobserved
      // instance admits the Agent's first option unchanged.
      engineFacts: async (requestedInstanceId) => {
        const readiness = await durableStores.environmentReadiness.getReadiness(requestedInstanceId);
        return readiness?.engines ?? [];
      },
      requirements: currentRequirements,
      strictAdmission: environmentSource === 'enrollment',
      // The durable access record a run is admitted under (#93): the binding
      // facts are captured once, persisted with the run, and used for the
      // Worker start, so a workspace change or restart afterwards cannot
      // rewrite what historical work used or where it executed.
      workspaceBinding: async (projectId, instanceId) => {
        const access = await openedStores.projectAccess.get(projectId, instanceId);
        const binding = access?.current;
        if (access?.status !== 'active' || binding === undefined) return undefined;
        // Durable access documents may predate the workspace-path invariant.
        // Refuse an unsafe binding before it can become run history or cross the
        // Project/Worker boundary; never copy its raw location into either.
        if (binding.kind === 'relative') {
          const path = sanitizeWorkspacePath(binding.path);
          if (path === undefined) return undefined;
          return {
            ...(binding.bindingId !== undefined ? { bindingId: binding.bindingId } : {}),
            workspaceId: binding.workspaceId,
            kind: 'relative',
            path,
          };
        }
        if (binding.kind !== 'default' || binding.path !== undefined) return undefined;
        return {
          ...(binding.bindingId !== undefined ? { bindingId: binding.bindingId } : {}),
          workspaceId: binding.workspaceId,
          kind: 'default',
        };
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

    const usageStore = stores.usage ?? new InMemoryUsageStore();
    const usageService = new UsageService({
      store: usageStore,
    });
    orchestrator.subscribe((run) => {
      void usageService.recordRunActivity(run);
    });

    taskLifecycle = new TaskEnvironmentLifecycle({
      store: stores.tasks,
      pool,
      agents,
      projects,
      runs: orchestrator,
      worker: {
        prepare: async (input) =>
          (await runtimeEnvironment.contexts(input.environmentInstanceId)).prepare(input),
        recycle: async (input) =>
          (await runtimeEnvironment.contexts(input.environmentInstanceId)).recycle(input),
      },
      leaseTtlMs,
      // Every Task entry into recovery opens the durable recovery record that
      // protects its lease (#88). The callback only records; the lifecycle keeps
      // ownership of the Task state it just made durable.
      onRecovery: async ({ leaseId, hadActiveRun, runId }) => {
        await recovery.open({
          leaseId,
          cause: 'worker-channel-lost',
          hadActiveRun,
          ...(runId !== undefined ? { runId } : {}),
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
      workerIdentityForInstance: async (instanceId) => {
        const enrollment = (await enrollments.list()).find((candidate) =>
          candidate.environmentInstanceId === instanceId && candidate.status === 'approved' &&
          candidate.worker.identityDigest !== '');
        return enrollment === undefined ? undefined : {
          enrollmentId: enrollment.id, identityDigest: enrollment.worker.identityDigest,
        };
      },
      // The holder decisions reuse the existing lifecycle ordering rather than
      // re-implementing Task context cleanup or lease release here.
      holders: {
        clearIdleTask: (taskId) => taskLifecycle.clearIdleRecovery(taskId),
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
      activeRunForTask: async (taskId) => (await durableStores.tasks.get(taskId))?.activeRunId,
      // A recovery change (open, reconnect, evidence, resolve, Force Release) is
      // a work-safety fact for the catalog, so eligibility follows it.
      onMutation: onEnrollmentMutation,
    });

    /**
     * The collaboration coordinator: scope-governed Messages, Project events,
     * deterministic routing, collection windows, wake-model-assisted batches,
     * and automatic final-result projection (#26, #96, #97).
     *
     * It shares the process's one durable store and the run orchestrator, so a
     * reply is projected from the same run record the core persisted. Direct
     * recipients, exact mentions, exact broadcasts, and addressed Project
     * events resolve deterministically against the Project's member facts
     * through the conversation-scope service (ADR-0007). An eligible
     * unaddressed input collects into the Project's durable routing window;
     * each frozen batch is judged by the composed wake model when one exists
     * (configuring a real low-cost wake model remains future work) and fails
     * closed with visible per-input outcomes when none does. Task summaries
     * remain omitted until explicit per-input relevance can be established.
     */
    const usageRoutingModel = options.routingModel === undefined ? undefined
      : new UsageAwareRoutingModelPort({ inner: options.routingModel });
    const collaboration = new CollaborationCoordinator({
      scopes: conversationScopes,
      store: stores.collaboration,
      runs: orchestrator,
      ...(usageRoutingModel !== undefined ? { routingModel: usageRoutingModel } : {}),
      onRoutingAttempt: async (attempt, projectId) => {
        const telemetry = usageRoutingModel?.takeTelemetry(attempt.id);
        await usageService.recordRoutingAttemptActivity(attempt, {
          ...telemetry, batchId: attempt.batchId, projectId,
          // The lifecycle's start/settlement is authoritative, not native latency.
          durationMs: Math.max(0, attempt.finishedAt - attempt.startedAt),
        });
      },
      onObservation:
        options.onObservation ??
        (({ inputId, observation }) => {
          process.stderr.write(
            `[collaboration] ${observation.status} (${observation.agentId}) ` +
              `on input ${inputId}: ${observation.detail}\n`,
          );
        }),
    });

    const staticRoot = options.staticRoot ?? join(projectRoot, 'web', 'dist');
    const openedStoresForCatalog = stores;
    // Environment enrollment and readiness (#87). It reads the durable enrollment
    // and observed-readiness stores and projects work safety from the same lease
    // registry the run and Task domains use, so the facts never diverge.
    let invalidateWorkerAuthority: (enrollmentId: string) => void = () => undefined;
    let verifyWorkerObservationAuthority: import('./environment/readiness-authority.ts').ObservationAuthorityVerifier = () => undefined;
    let currentWorkerConnectionEpoch: (enrollmentId: string) => number | undefined = () => undefined;
    const enrollmentOptions: EnvironmentEnrollmentServiceOptions = {
      enrollments: stores.enrollments,
      readiness: stores.environmentReadiness,
      currentConnectionEpoch: (enrollmentId) => currentWorkerConnectionEpoch(enrollmentId),
      // Revoke/reset fences the accepted transport before its durable lifecycle
      // decision is published. The assignment is completed before any caller
      // can invoke a lifecycle mutation; the indirection keeps composition's
      // gateway/service construction order explicit.
      onAuthorityLost: (enrollmentId) => invalidateWorkerAuthority(enrollmentId),
      verifyObservationAuthority: (authority, scope) => verifyWorkerObservationAuthority(authority, scope),
      leases: () => pool.leases(),
      // Recovery records are authoritative over the lease projection, so the
      // summary can distinguish `reconciling` from `recovery` and a reconnect
      // alone is never reported as safe-to-reassign (#88, ADR-0009). The records
      // are filtered to the enrollment's own instance when a summary is built,
      // so many enrolled Environments can be summarised from one service (E2).
      recoveryRecords: async () => (await recovery.list()).filter((record) => record.phase !== 'resolved'),
      // The one engine this build's configured Agents actually run on is the one
      // engine its configured use requires. Nothing here names a second engine,
      // so an Environment that hosts only this engine is complete rather than a
      // fabricated dual-engine failure (ADR-0008).
      requiredEngines: [engineId],
      onMutation: onEnrollmentMutation,
      // A committed probe observation republishes the catalog eligibility
      // projection before the write reports success (#162), so a green instance
      // resolves for the next `begin` without waiting for a connection or
      // acceptance event. The hook runs only after the durable commit, and the
      // service swallows projection failures, so a committed observation can
      // never be failed by the catalog. The closure is invoked long after this
      // options object is constructed, once the refresh exists below.
      onObservationCommitted: () => refreshEnvironmentCatalog(),
      resolveRequirements: currentRequirements,
    };
    const enrollments = new EnvironmentEnrollmentService(enrollmentOptions);
    // One synchronous lifecycle authority is shared by the enrollment service,
    // the archive service, and the Worker gateway, so revoke/reset/archive is
    // ordered with epoch acceptance in a single run-to-completion step
    // (R118-EPOCH-001).
    const lifecycleAuthority = enrollments.lifecycleAuthority;
    // The catalog refresh and its pool publication are defined here, after the
    // enrollment service and epoch registry exist, and re-invoked whenever an
    // accepted connection appears or a channel is lost.
    // Refreshes read several independently durable sources. A slow older read
    // must never publish after a newer epoch/readiness observation: doing so
    // would turn a current fact back into a stale catalog projection.
    let catalogProjectionRevision = 0;
    const refreshEnvironmentCatalog = async (): Promise<readonly EnvironmentCatalogEntry[]> => {
      const revision = ++catalogProjectionRevision;
      const all = await openedStoresForCatalog.enrollments.list();
      const persisted = await openedStoresForCatalog.environmentCatalog.list();
      const persistedInstances = new Map(persisted.map((record) => [record.instanceId, record]));
      const now = Date.now();
      const inputs: EnvironmentCatalogInput[] = [];
      for (const enrollment of all) {
        if (enrollment.environmentInstanceId === '') continue;
        const observed = await openedStoresForCatalog.environmentReadiness.getReadiness(
          enrollment.environmentInstanceId,
        );
        const openRecovery = (
          await recovery.listForEnvironment(enrollment.environmentInstanceId)
        ).filter((record) => record.phase !== 'resolved');
        inputs.push({
          enrollment,
          observed,
          workSafety: workSafetyOfInstance(
            enrollment.environmentInstanceId,
            pool.leases(),
            openRecovery,
          ),
          currentEpoch: currentWorkerConnectionEpoch(enrollment.id),
          requiredEngines: [engineId],
          requirements: await currentRequirements(),
          optionsByAgent: await currentOptionsByAgent(),
          supportedProtocol: SUPPORTED_WORKER_PROTOCOL,
          now,
        });
        const entry = projectCatalogEntry(inputs[inputs.length - 1]!);
        const existing = persistedInstances.get(entry.instanceId);
        if (existing === undefined || existing.enrollmentId !== entry.enrollmentId) {
          // Persist the durable catalog record once per enrolled instance. The
          // record is pure identity, so an offline, revoked, or archived
          // instance survives SQLite reopen without a Worker ever connecting.
          await openedStoresForCatalog.environmentCatalog.save({
            instanceId: entry.instanceId,
            enrollmentId: entry.enrollmentId,
            definition: entry.definition,
            instance: entry.instance,
            updatedAt: now,
          });
        }
      }
      if (revision !== catalogProjectionRevision) return environmentCatalog.entries();
      environmentCatalog.update(inputs);
      publishCatalogMembership();
      return environmentCatalog.entries();
    };
    // Late-bound so every catalog publication — connection accept, channel
    // loss, readiness commit, authority change — hands the bounded reconnect
    // retry one observation without ordering the graph backwards (#181).
    let noteRunReconnectRetry: (acceptedInstanceId?: string) => Promise<void> = async () => undefined;
    const publishCatalogMembership = (acceptedInstanceId?: string): void => {
      if (configuredCarrierPresent) {
        // An injected test/development carrier keeps exactly its one static
        // instance and immediate eligibility; the enrollment catalog is not its
        // authority.
        pool.synchronize({
          definitions: [configuredDefinition],
          instances: [configuredInstance],
          eligibleInstanceIds: [configuredInstance.id],
        });
        void noteRunReconnectRetry(acceptedInstanceId).catch(() => {
          process.stderr.write(
            '[run-retry] environment state observation failed; durable retry state is unchanged\n',
          );
        });
        return;
      }
      pool.synchronize({
        definitions: environmentCatalog.entries().map((entry) => entry.definition),
        instances: environmentCatalog.entries().map((entry) => entry.instance),
        eligibleInstanceIds: environmentCatalog.eligibleInstanceIds(),
      });
      void noteRunReconnectRetry(acceptedInstanceId).catch(() => {
        process.stderr.write(
          '[run-retry] environment state observation failed; durable retry state is unchanged\n',
        );
      });
    };
    // Authority decisions now schedule a catalog re-projection, so approval,
    // revocation, reset, permission change, archive, and restore take effect
    // without a process restart or runtime JSON edit.
    scheduleCatalogRefresh = () => {
      void refreshEnvironmentCatalog().catch(() => undefined);
    };
    agents.onChange(scheduleCatalogRefresh);
    // Non-destructive archive/restore (#89, ADR-0008). It reads the same lease
    // registry and open recovery records, so an Environment with dependent work
    // can never be archived, and its decisions are ordinary durable enrollment
    // decisions in the same append-only history.
    const archive = new EnvironmentArchiveService({
      enrollments: stores.enrollments,
      leases: pool,
      recovery,
      lifecycleAuthority,
      onMutation: onEnrollmentMutation,
      onAuthorityLost: (enrollmentId) => invalidateWorkerAuthority(enrollmentId),
    });
    // The enrollment-backed outbound Worker gateway (#115, ADR-0012). A host
    // Worker claims its pending enrollment and initiates one authenticated
    // WS/WSS connection carrying the existing neutral Worker JSON-RPC under a
    // monotonic connection epoch. The gateway exclusively owns the mutable
    // registry; runtime projections consume only its read-only current-epoch
    // query, so composition cannot issue an accepted epoch itself.
    const resolveRequirements = currentRequirements;
    const workerGateway = new WorkerGateway({
      enrollments,
      epochStore: stores.workerConnectionEpochs,
      allowInsecurePlaintext: options.configuration.allowInsecureWorkerConnections,
      // Agent configuration is the core-owned declaration of the model a
      // future run will target. Codex is the sole engine with a safe local
      // catalog probe; do not feed a Pi-only target to Codex and claim a false
      // target absence. The Worker may only compare these locally and must not
      // infer account entitlement.
      requiredModels: async () => (await currentRequirements()).modelsByEngine?.codex ?? [],
    });
    invalidateWorkerAuthority = (enrollmentId) => workerGateway.invalidateEnrollment(enrollmentId);
    verifyWorkerObservationAuthority = (authority, scope) =>
      workerGateway.verifyObservationAuthority(authority, scope);
    currentWorkerConnectionEpoch = (enrollmentId) =>
      workerGateway.currentConnectionEpoch(enrollmentId);
    // The bounded reconnect retry for environment-disconnected run admissions
    // (#181): one durable gate/trigger/retry state machine over the run,
    // Project, pool, and gateway facts this graph already keeps. Every catalog
    // publication feeds it one observation through `noteRunReconnectRetry`
    // above; it never dials a Worker, never touches routing, and submits at
    // most one linked retry per failed run.
    const runReconnectRetry = new RunReconnectRetry({
      store: durableStores.runReconnectRetries,
      runs: orchestrator,
      projects: () =>
        projects.list().map((project) => ({
          projectId: project.id,
          instanceIds: project.availableEnvironmentInstanceIds,
        })),
      // Under an injected test/development carrier the one static instance
      // cannot disconnect; under the enrollment catalog only a live accepted
      // Worker connection counts (ADR-0012).
      isConnected: (instanceId) =>
        (configuredCarrierPresent && configuredInstance.id === instanceId) ||
        workerGateway.liveFor(instanceId) !== undefined,
      canAdmitWork: (instanceId) =>
        (configuredCarrierPresent && configuredInstance.id === instanceId) ||
        pool.requiresLease(instanceId, ADMISSION_CAPABILITY) !== undefined,
      onRetrySettled: (input) => collaboration.projectRetryReply(input),
    });
    noteRunReconnectRetry = (acceptedInstanceId) =>
      runReconnectRetry.noteEnvironmentState(acceptedInstanceId).then(() => undefined);
    const enrollmentEnvironment = new EnrollmentWorkerPort({
      gateway: workerGateway,
      ...(options.onWorkerLog !== undefined ? { onLog: options.onWorkerLog } : {}),
    });
    switchableEnvironment?.setTarget(enrollmentEnvironment);
    /**
     * The one application-level readiness workflow (#124).
     *
     * Runtime composes it rather than implementing a readiness business
     * workflow of its own. Startup, automatic target probing, empty-target
     * bootstrap, and Human-requested probes are trigger modes of this Module,
     * which owns collection, canonical validation/privacy reduction,
     * persistence coordination, and response authority checks.
     */
    const readinessWorkflow = new EnvironmentReadinessWorkflow({
      enrollments,
      workerGateway,
      environment: enrollmentEnvironment,
      refreshEnvironmentCatalog,
      resolveRequirements,
    });
    // A newly accepted connection is a *fact* on an already-existing enrollment,
    // never a reason to create or dial a Worker; a lost channel makes that fact
    // offline again. Neither path creates a catalog entry: only a durable
    // enrollment does. Each re-projects the catalog and republishes eligibility.
    const channelLosses = new Map<string, Promise<void>>();
    workerGateway.onAccept((acceptance) => {
      readinessWorkflow.reserveAccepted(acceptance);
      // Invalidate an in-flight source snapshot before publishing the accepted
      // epoch synchronously, then schedule the store-backed refresh that may
      // replace this projection. The bump above aborts any refresh already in
      // flight, so without a scheduled successor this event would republish
      // only the pre-bump snapshot and strand a concurrent probe-commit
      // republish until some later event (#162).
      catalogProjectionRevision += 1;
      environmentCatalog.setEpoch(acceptance.enrollment.id, acceptance.epoch.epoch);
      publishCatalogMembership(acceptance.enrollment.environmentInstanceId);
      void refreshEnvironmentCatalog().catch(() => undefined);
      // The Worker's own readiness is observed over the accepted inbound channel
      // (never by dialing one), so the catalog can reach eligibility once the
      // required facts are established. The short defer lets the Worker consume
      // `worker/listening`, dispose its enrollment-frame reader, and install the
      // neutral JSON-RPC server before the observation crosses the same socket.
      // Without it an RPC request can be discarded as an unexpected final
      // handshake frame.
      const timer = setTimeout(() => {
        void readinessWorkflow.observeAccepted(acceptance).catch(() => undefined);
      }, 10);
      timer.unref();

      // Recovery is a machine-channel workflow, not a Web action. Serialize
      // snapshots with live notifications; the SQLite receipt commits before
      // acknowledging the Worker outbox. Failed sync leaves the outbox intact.
      let synchronizing = Promise.resolve();
      const observedRecoveries = new Set<string>();
      const current = () => workerGateway.liveFor(acceptance.enrollment.environmentInstanceId)
        ?.epoch.connectionId === acceptance.epoch.connectionId;
      const synchronize = () => {
        synchronizing = synchronizing.then(async () => {
          await channelLosses.get(acceptance.enrollment.environmentInstanceId);
          if (!current() || acceptance.enrollment.capabilityPermissions['agent-run'] !== true ||
              durableStores.recovery.receiveWorkerTurn === undefined) return;
          const snapshot = await acceptance.transport.request<import('./worker/recovery-journal.ts').JournalSnapshot | null>(
            'recovery/snapshot');
          if (!current() || snapshot === null || snapshot.epoch !== acceptance.epoch.epoch) return;
          const records = (await recovery.listForEnvironment(acceptance.enrollment.environmentInstanceId))
            .filter((record) => record.phase !== 'resolved');
          // #171: a digest this enrollment durably invalidated by an identity
          // rotation can never return to prove anything, so it must not fence
          // its record out of the reconnect pass forever; the connecting
          // identity is the Human-approved successor on the same enrollment.
          // Any other identity mismatch still fences the whole pass before a
          // single piece of evidence moves.
          const rotatedIdentity = (record: import('./environment/recovery.ts').EnvironmentRecoveryRecord): boolean =>
            record.workerIdentityDigest !== undefined &&
            acceptance.enrollment.invalidatedIdentityDigests.includes(record.workerIdentityDigest);
          if (records.some((record) => (record.enrollmentId !== undefined && record.enrollmentId !== acceptance.enrollment.id) ||
              (record.workerIdentityDigest !== undefined &&
               record.workerIdentityDigest !== acceptance.enrollment.worker.identityDigest &&
               !rotatedIdentity(record)))) return;
          for (const turn of snapshot.turns) {
            if (!current()) return;
            const receipt = await durableStores.recovery.receiveWorkerTurn(acceptance.enrollment.id, turn);
            if (!current() || durableStores.recovery.acknowledgeWorkerTurn === undefined) return;
            // Commit high-water before acknowledging. Keep the payload until
            // the correlated run history is durably projected; a lost ack
            // response redelivers safely using the durable receipt.
            await durableStores.recovery.acknowledgeWorkerTurn(
              acceptance.enrollment.id, turn.turnId, receipt.sequence, receipt.settlement);
            if (!current()) return;
            await acceptance.transport.request('recovery/acknowledge', {
              epoch: snapshot.epoch, turnId: turn.turnId, sequence: receipt.sequence,
              settlement: receipt.settlement,
            });
          }
          for (const [taskId, state] of Object.entries(snapshot.taskContexts)) {
            if (!current() || durableStores.recovery.receiveWorkerContext === undefined) return;
            if (state !== 'prepared' && state !== 'recycled') return;
            await durableStores.recovery.receiveWorkerContext(acceptance.enrollment.id, taskId, state);
            if (!current()) return;
            await acceptance.transport.request('recovery/ack-context', { epoch: snapshot.epoch, taskId, state });
          }
          for (const record of records) {
            if (!current() || acceptance.enrollment.capabilityPermissions['agent-run'] !== true) return;
            const newlyObserved = !observedRecoveries.has(record.leaseId);
            if (newlyObserved) {
              await recovery.observeReconnect(record.leaseId, {
                enrollmentId: acceptance.enrollment.id,
                workerIdentityDigest: acceptance.enrollment.worker.identityDigest,
                environmentInstanceId: acceptance.enrollment.environmentInstanceId,
                identityVerified: true, protocolCompatible: true, permissionsAllowed: true,
                hadActiveRun: true,
                identityRotated: rotatedIdentity(record),
              });
              observedRecoveries.add(record.leaseId);
            }
            if (!current()) return;
            if (!newlyObserved && record.phase === 'recovery') continue;
            const receipt = record.runId !== undefined && durableStores.recovery.workerRunReceipt !== undefined
              ? await durableStores.recovery.workerRunReceipt(acceptance.enrollment.id, record.runId)
              : undefined;
            if (!current()) return;
            if (record.runId !== undefined && receipt?.terminal === true && !receipt.pending &&
                (receipt.settlementStatus === 'completed' || receipt.settlementStatus === 'failed' ||
                 receipt.settlementStatus === 'interrupted' || receipt.settlementStatus === 'stopped')) {
              if (durableStores.recovery.workerRunEvents === undefined) return;
              const events = await durableStores.recovery.workerRunEvents(acceptance.enrollment.id, record.runId);
              if (!current()) return;
              const projected = await orchestrator.recordRecoveryEvidence(record.runId, {
                status: receipt.settlementStatus, eventCount: receipt.eventCount, events,
              });
              if (!projected || !current()) return; // do not grant a decision before run history is durable
            }
            let contextPrepared = false;
            if (record.taskId !== undefined) {
              const task = await durableStores.tasks.get(record.taskId);
              const project = task === undefined ? undefined : projects.get(task.projectId);
              if (task !== undefined && project !== undefined) {
                const path = workspaceFor(project, record.environmentInstanceId)?.path;
                const inspected = await acceptance.transport.request<boolean>('context/inspect', {
                  projectId: task.projectId, taskId: record.taskId,
                  environmentInstanceId: record.environmentInstanceId, environmentLeaseId: record.leaseId,
                  ...(path !== undefined ? { projectWorkspacePath: path } : {}),
                });
                if (!current()) return;
                contextPrepared = inspected === true;
              }
            }
            const idle = record.interruptedRunActive === false && record.holderKind === 'task' && record.runId === undefined;
            const contextState = record.taskId !== undefined && durableStores.recovery.workerContext !== undefined
              ? await durableStores.recovery.workerContext(acceptance.enrollment.id, record.taskId) : undefined;
            if (!current()) return;
            await recovery.synchronizeEvidence(record.leaseId, {
              hadActiveRun: !idle,
              evidence: {
                retainedEventCount: receipt?.eventCount ?? 0,
                turnSettlementObserved: idle || (receipt?.terminal === true && !receipt.pending),
                ...(receipt?.terminal === true &&
                    (receipt.settlementStatus === 'completed' || receipt.settlementStatus === 'failed' ||
                     receipt.settlementStatus === 'interrupted' || receipt.settlementStatus === 'stopped')
                  ? { terminalStatus: receipt.settlementStatus } : {}),
                engineSessionStopped: snapshot.engineStopped,
                taskContextPrepared: contextPrepared && contextState !== 'recycled',
                taskContextRecycled: contextState === 'recycled',
              },
            });
          }
          await durableStores.recovery.compactUnboundWorkerTurns?.(acceptance.enrollment.id);
          if (durableStores.recovery.workerRunIds !== undefined &&
              durableStores.recovery.workerRunReceipt !== undefined &&
              durableStores.recovery.compactWorkerRun !== undefined) {
            for (const runId of await durableStores.recovery.workerRunIds(acceptance.enrollment.id)) {
              if (!current()) return;
              const receipt = await durableStores.recovery.workerRunReceipt(acceptance.enrollment.id, runId);
              if (receipt?.terminal !== true || receipt.pending) continue;
              const run = await orchestrator.load(runId);
              if (run === undefined || !current()) return;
              if (run.recoverySettlement !== undefined ||
                  (run.status !== 'running' && run.status !== 'queued' && run.events.length >= receipt.eventCount)) {
                await durableStores.recovery.compactWorkerRun(acceptance.enrollment.id, runId);
              }
            }
          }
        }).catch(() => {
          // Never leak event payload or host paths through operational logs.
          // No ack on failure: the next connection must redeliver the outbox.
          options.onWorkerLog?.('Worker recovery evidence incomplete; retained events remain unacknowledged.');
        });
      };
      const off = acceptance.transport.onNotification((notification) => {
        if (notification.method === 'turn/event' || notification.method === 'turn/settled' ||
            notification.method === 'recovery/changed') synchronize();
      });
      acceptance.onChannelClosed(off);
      const offRuns = orchestrator.subscribe((run) => {
        if (run.environmentInstanceId === acceptance.enrollment.environmentInstanceId &&
            run.status !== 'running' && run.status !== 'queued') synchronize();
      });
      acceptance.onChannelClosed(offRuns);
      const syncTimer = setTimeout(synchronize, 15);
      syncTimer.unref();
    });
    workerGateway.onConnectionClosed((closed) => {
      readinessWorkflow.releaseAccepted(closed.epoch.connectionId);
      // Disconnect detection is the admission fence. Clear this exact epoch and
      // republish synchronously before any store-backed refresh crosses an await,
      // so resolution cannot select an offline instance in the propagation
      // window. A delayed close for an older connection cannot evict a newer one.
      catalogProjectionRevision += 1;
      if (environmentCatalog.clearEpoch(closed.enrollmentId, closed.epoch.epoch)) {
        publishCatalogMembership();
        const lease = pool.activeLease(closed.environmentInstanceId);
        if (lease !== undefined) {
          // Synchronous admission fence before any async Task/store work.
          pool.markRecovering(lease.id);
          const loss = (async () => {
            const enrollment = await enrollments.get(closed.enrollmentId);
            const task = lease.taskId !== undefined ? await durableStores.tasks.get(lease.taskId) : undefined;
            const lostRunId = task?.activeRunId ?? lease.runId;
            await recovery.open({ leaseId: lease.id, cause: 'worker-channel-lost',
              hadActiveRun: task === undefined || task.activeRunId !== undefined,
              enrollmentId: closed.enrollmentId,
              ...(enrollment?.worker.identityDigest ? { workerIdentityDigest: enrollment.worker.identityDigest } : {}),
              ...(lostRunId !== undefined ? { runId: lostRunId } : {}) });
            if (lease.taskId !== undefined) {
              await taskLifecycle.workerChannelLost(lease.taskId);
            }
          })();
          void loss.catch(() => options.onWorkerLog?.('Worker channel loss protection is incomplete; admission remains fenced.'));
          channelLosses.set(closed.environmentInstanceId, loss);
        }
      }
      void refreshEnvironmentCatalog().catch(() => undefined);
    });
    await refreshEnvironmentCatalog();
    /**
     * The observed readiness of the first currently-eligible enrolled instance.
     *
     * Used only for the Agent-work compatibility projection. It never creates or
     * dials a Worker: it reads the durable observed facts for an instance the
     * catalog already admitted, and reports nothing when none is eligible.
     */
    const resolveCompatibilityTarget = async (
      requestedInstanceId?: string,
    ): Promise<{
      readonly instanceId: string | undefined;
      readonly readiness: Awaited<
        ReturnType<RuntimeStores['environmentReadiness']['getReadiness']>
      >;
    }> => {
      if (requestedInstanceId !== undefined) {
        return {
          instanceId: requestedInstanceId,
          readiness: await openedStoresForCatalog.environmentReadiness.getReadiness(requestedInstanceId),
        };
      }
      const eligible = environmentCatalog
        .entries()
        .filter((entry) => entry.eligible)
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
      if (eligible[0] !== undefined) {
        return {
          instanceId: eligible[0].instanceId,
          readiness: await openedStoresForCatalog.environmentReadiness.getReadiness(eligible[0].instanceId),
        };
      }
      const approved = environmentCatalog
        .entries()
        .filter((entry) => entry.enrollment.status === 'approved')
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
      if (approved[0] !== undefined) {
        return {
          instanceId: approved[0].instanceId,
          readiness: await openedStoresForCatalog.environmentReadiness.getReadiness(approved[0].instanceId),
        };
      }
      const anyEntry = [...environmentCatalog.entries()]
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
      if (anyEntry[0] !== undefined) {
        return {
          instanceId: anyEntry[0].instanceId,
          readiness: await openedStoresForCatalog.environmentReadiness.getReadiness(anyEntry[0].instanceId),
        };
      }
      return { instanceId: undefined, readiness: undefined };
    };
    const requestWorkerProbe = (enrollmentId: string) => readinessWorkflow.request(enrollmentId);

    const api = createRunApi({
      orchestrator,
      agents,
      // The project channel is served over the same core: delivery, wake dispatch,
      // and projected replies all go through the one coordinator above, governed
      // by the conversation-scope service below.
      collaboration,
      conversationScopes,
      // Members the Web composer may address (#27); read-only from the registry.
      projects,
      // Durable multi-run Tasks (#28): create, list, inspect, and advance.
      tasks,
      auth: operatorSessions,
      staticRoot,
      readFile: options.readFile ?? defaultReadFile,
      // The machine-authenticated Worker boundary (#115). It is deliberately
      // separate from the Human browser session and CSRF boundary: a Worker
      // proves its host-local key and one-use claim, never a browser cookie.
      workerGateway,
      // The Environment enrollment/readiness domain is composed through the #85
      // additive seam, so no central dispatcher grows for it. The recovery routes
      // (#88) are composed through the same seam and delegate every safety rule
      // to the recovery service.
      routers: [
        createEnvironmentRouter({ enrollments, recovery, archive, requestProbe: requestWorkerProbe }),
        // Durable Project, template-snapshot, and membership authority (#92),
        // composed through the same #85 additive seam. Only the authenticated
        // Human reaches these routes, so create/edit/membership/archive are
        // Human authority by construction (ADR-0008).
        createProjectRouter({
          projects: projectService,
          legacyProjects: projects,
          access: projectAccessService,
          ...(projectCreationService !== undefined ? { creation: projectCreationService } : {}),
        }),
        // Conversation scopes and Working groups (#95), composed through the
        // same additive seam. Every command delegates to the scope service, so
        // membership, creator/Human authority, and read-only rules have exactly
        // one implementation; the routes sit behind the operator browser
        // boundary, so their actor is the authenticated Human by construction.
        createConversationRouter({ scopes: conversationScopes }),
        createUsageRouter({ usage: usageService }),
        // Portable Agent identities and ordered work options (#90). The
        // compatibility projection reads the same durable observed readiness
        // facts the readiness summary does, so the browser and admission can
        // never disagree about what the Environments support.
        createAgentRouter({
          agents: agentService,
          onMutation: scheduleCatalogRefresh,
          compatibility: async (agent: Agent, requestedInstanceId?: string) => {
            // The compatibility projection reports the first eligible enrolled
            // instance's observed engines, falling back to enrolled instances
            // with observed facts when none is yet eligible (#129 AC1, AC2).
            const reqs = await currentRequirements();
            const target = configuredCarrierPresent
              ? { instanceId: configuredInstance.id, readiness: await openedStoresForCatalog.environmentReadiness.getReadiness(configuredInstance.id) }
              : await resolveCompatibilityTarget(requestedInstanceId);
            const projection = projectAgentCompatibility({
              workOptions: currentOptions(agent),
              availableEngines: target.readiness?.engines ?? [],
              requirements: reqs,
            });
            return {
              agentId: agent.id,
              ...(target.instanceId !== undefined ? { environmentInstanceId: target.instanceId } : {}),
              available: projection.available,
              ...(projection.firstAvailable !== undefined ? { firstAvailable: projection.firstAvailable } : {}),
              ...(projection.unavailableReason !== undefined ? { unavailableReason: projection.unavailableReason } : {}),
              options: projection.options,
              explanation: projection.explanation,
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

    capture?.({ stores, enrollments, workerGateway, readinessWorkflow });
    const activeStores = stores;
    const { environmentReadiness: readinessWriter, ...otherStores } = activeStores;
    const applicationStores: RuntimeStoreViews = { ...otherStores, environmentReadiness: {
      getReadiness: (...args) => readinessWriter.getReadiness(...args),
      getCurrentObservation: (...args) => readinessWriter.getCurrentObservation(...args),
      listObservations: (...args) => readinessWriter.listObservations(...args),
      listProbes: (...args) => readinessWriter.listProbes(...args),
      getReceipt: (...args) => readinessWriter.getReceipt(...args),
      getObservation: (...args) => readinessWriter.getObservation(...args),
      getAttempt: (...args) => readinessWriter.getAttempt(...args),
    } };
    const enrollmentLifecycle: EnrollmentLifecycle = {
      list: (...args) => enrollments.list(...args),
      get: (...args) => enrollments.get(...args),
      requestEnrollment: (...args) => enrollments.requestEnrollment(...args),
      claimEnrollment: (...args) => enrollments.claimEnrollment(...args),
      issueChallenge: (...args) => enrollments.issueChallenge(...args),
      connectWorker: (...args) => enrollments.connectWorker(...args),
      approve: (...args) => enrollments.approve(...args),
      authorizeModels: (...args) => enrollments.authorizeModels(...args),
      revoke: (...args) => enrollments.revoke(...args),
      reset: (...args) => enrollments.reset(...args),
      cancelEnrollment: (...args) => enrollments.cancelEnrollment(...args),
      regenerateClaimSecret: (...args) => enrollments.regenerateClaimSecret(...args),
      setCapabilityPermission: (...args) => enrollments.setCapabilityPermission(...args),
      getObservation: (...args) => enrollments.getObservation(...args),
      getReceipt: (...args) => enrollments.getReceipt(...args),
      listProbes: (...args) => enrollments.listProbes(...args),
      readiness: (...args) => enrollments.readiness(...args),
    };
    const gatewayView: WorkerGatewayView = {
      liveFor: (instanceId) => {
        const live = workerGateway.liveFor(instanceId);
        return live === undefined ? undefined : { accepted: true, enrollment: live.enrollment,
          epoch: live.epoch, requiredModels: live.requiredModels };
      },
      currentConnectionEpoch: (enrollmentId) => workerGateway.currentConnectionEpoch(enrollmentId),
      isCurrentConnection: (...args) => workerGateway.isCurrentConnection(...args),
    };

    return {
      api,
      orchestrator,
      tasks,
      collaboration,
      pool,
      agents,
      projects,
      environmentCatalog,
      definition: configuredCarrierPresent ? configuredDefinition : undefined,
      instance: configuredCarrierPresent ? configuredInstance : undefined,
      stores: applicationStores,
      enrollments: enrollmentLifecycle,
      recovery,
      agentService,
      projectService,
      projectAccess: projectAccessService,
      conversationScopes,
      usage: usageService,
      workerGateway: gatewayView,
      enrollmentEnvironment,
      environmentSource,
      engines,
      refreshEnvironmentCatalog,

      /** Reconcile runs, then Task lifecycle, then recovery records, then
       * collaboration; runs first so no reply can ever be fabricated for an
       * orphaned run. A process restart is never proof that interrupted work is
       * safe, so a leftover protected lease keeps a `recovery` record (#88). */
      async reconcile(): Promise<SproutReconciliation> {
        const recoveredRuns = await orchestrator.reconcileOrphanedRuns();
        await tasks.reconcileEnvironmentLifecycle();
        await recovery.reconcileAfterRestart();
        // Recovery may have moved a lease into (or out of) recovery, so the
        // catalog's work-safety projection is re-derived before serving.
        await refreshEnvironmentCatalog();
        // A process that died between the Project-channel prepare and the
        // Project save leaves a channel row with no Project behind it — the
        // rollback cannot run on termination. Restart reconciliation removes
        // exactly those abandoned preparations before anything is served;
        // every channel whose Project exists and every Working group record
        // (history is never deleted, ADR-0008) survives, and a preparation
        // still in flight in this process is never reaped (#95).
        await conversationScopes.removeOrphanProjectChannels();
        // Working group participation ends cascade from an ended Project
        // membership (#95); materializing them here means a process that died
        // between the end and its first scope read converges at startup. The
        // pass is idempotent, so a healthy restart changes nothing.
        await conversationScopes.syncAll();
        const reconciled = await collaboration.reconcile();
        // Runs last: the bounded reconnect retry rebuilds any interrupted
        // eligibility set, dispatches queued retries under their durable ids,
        // and settles finished ones — never a second retry for one run (#181).
        const reconnectRetries = await runReconnectRetry.reconcile();
        const result: SproutReconciliation = {
          recoveredRuns,
          admittedRunIds: reconciled.admittedRunIds,
          projectedMessageIds: reconciled.projectedMessageIds,
          reconnectRetries,
          failureEventRunIds: reconciled.failureEventRunIds,
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
          definition: configuredCarrierPresent ? configuredDefinition : undefined,
          environmentKind,
          containerName,
          workingDirectory,
          databasePath,
          reconciled: lastReconciliation,
          leases: pool.leases(),
          catalogEntries: environmentCatalog.entries(),
        });
      },

      async close(): Promise<void> {
        // End every open event stream before anything else: `server.close` waits
        // for existing connections, and an SSE stream never ends by itself.
        await api.close();
        // The enrollment-backed connections are owned by the gateway; the port
        // stops reaching them before they are torn down.
        await enrollmentEnvironment.close();
        workerGateway.close();
        await Promise.allSettled([...channelLosses.values()]);
        // The environment port owns its worker channels. A *container* is not
        // destroyed here: `rm` is the only irrecoverable action (#4), so its
        // lifecycle is an explicit operator decision rather than a side effect.
        if (environment !== undefined) await environment.close();
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
      if (environment !== undefined) await environment.close();
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
  readonly definition: EnvironmentDefinition | undefined;
  readonly environmentKind: string;
  readonly containerName: string;
  readonly workingDirectory: string;
  readonly databasePath: string;
  readonly reconciled: SproutReconciliation | undefined;
  readonly leases: ReturnType<EnvironmentPool['leases']>;
  readonly catalogEntries: readonly EnvironmentCatalogEntry[];
}): string {
  // Under the enrollment catalog there is no single configured instance. The
  // startup report names the catalog instead, so an operator can still see that
  // production started with zero Environments and which enrolled instances the
  // dynamic catalog knows. An injected test/development carrier keeps the exact
  // previous `environment:` line.
  const environmentLine =
    input.definition === undefined
      ? `  environment: enrollment catalog (${describeCatalog(input.catalogEntries)})\n`
      : `  environment: ${input.instanceId} (${input.definition.platform}` +
        `${input.environmentKind === 'container' ? `, container ${input.containerName}` : `, cwd ${input.workingDirectory}`})\n`;
  let report =
    `Sprout listening on http://127.0.0.1:${input.boundPort}\n` +
    `  agent:      ${input.agents.list().map((agent) => agent.id).join(', ')}\n` +
    `  engine:     ${[...input.engines.keys()].join(', ') || '(none)'} (via environment worker)\n` +
    environmentLine +
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

/** The operator-visible catalog summary: instances and how many are eligible. */
function describeCatalog(entries: readonly EnvironmentCatalogEntry[]): string {
  if (entries.length === 0) return 'no enrolled instances';
  const eligible = entries.filter((entry) => entry.eligible).length;
  return `${entries.length} enrolled, ${eligible} eligible`;
}

/**
 * Project the work-safety fact for one instance from the live lease registry and
 * the open recovery records for that instance.
 *
 * The recovery records are authoritative over the lease projection (as in the
 * enrollment service), so an instance whose evidence is still reconciling is not
 * mistaken for one that is safe to reassign (ADR-0009).
 */
function workSafetyOfInstance(
  instanceId: string,
  leases: readonly { readonly instanceId: string; readonly state: string }[],
  recoveryRecords: readonly { readonly environmentInstanceId: string; readonly phase: string }[],
): ReturnType<typeof workSafetyFromRecovery> {
  return workSafetyFromRecovery(
    recoveryRecords.map((record) => ({
      environmentInstanceId: record.environmentInstanceId,
      phase: record.phase as 'reconciling' | 'recovery' | 'resolved',
    })),
    leases,
    instanceId,
  );
}

/**
 * The environment port used under `SPROUT_ENV_SOURCE=enrollment` (ADR-0012).
 *
 * The runtime's run, Task, and Project-access wiring is built before the
 * enrollment gateway and its accepted-connection port exist. This delegate
 * carries those closures across that ordering and forwards to the
 * enrollment-backed port once it is constructed, so a run resolves the accepted
 * outbound Worker and the runtime never dials or starts a Worker.
 */
class EnrollmentEnvironmentDelegate implements RuntimeEnvironment {
  #target: RuntimeEnvironment | undefined;

  setTarget(environment: RuntimeEnvironment): void {
    this.#target = environment;
  }

  async adapters(environmentInstanceId: string): Promise<ReadonlyMap<string, EngineAdapter>> {
    return this.#require().adapters(environmentInstanceId);
  }

  async contexts(environmentInstanceId: string): Promise<TaskContextWorker> {
    return this.#require().contexts(environmentInstanceId);
  }

  validateWorkspace(
    environmentInstanceId: string,
    input: ValidateWorkspaceParams,
  ): Promise<ValidateWorkspaceResult> {
    const target = this.#require();
    if (target.validateWorkspace === undefined) {
      return Promise.reject(new Error('the enrollment environment cannot validate Project workspaces'));
    }
    return target.validateWorkspace(environmentInstanceId, input);
  }

  info(environmentInstanceId: string): Promise<WorkerInfo | undefined> {
    const target = this.#require();
    return target.info === undefined ? Promise.resolve(undefined) : target.info(environmentInstanceId);
  }

  probeReadiness(environmentInstanceId: string, attemptId?: string, requirements?: import('./environment/readiness.ts').ReadinessRequirementScope): Promise<WorkerReadinessProbeResult | undefined> {
    const target = this.#require();
    return target.probeReadiness === undefined
      ? Promise.resolve(undefined)
      : target.probeReadiness(environmentInstanceId, attemptId, requirements);
  }

  async close(): Promise<void> {
    await this.#target?.close();
  }

  #require(): RuntimeEnvironment {
    if (this.#target === undefined) {
      throw new Error('the enrollment-backed environment is not constructed yet');
    }
    return this.#target;
  }
}

/**
 * Read a static asset, treating a missing file as "not served here".
 */
export async function defaultReadFile(path: string): Promise<Buffer | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'ENOENT') return undefined;
    throw error;
  }
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
function defaultProject(input: {
  readonly projectId: string;
  readonly instanceIds: readonly string[];
}): Project {
  return {
    id: input.projectId,
    goal: 'Build Sprout into a local multi-agent collaboration and environment scheduling platform.',
    rules: ['Report what you actually observed.', 'Do not claim work you did not verify.'],
    availableEnvironmentInstanceIds: [...input.instanceIds],
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
