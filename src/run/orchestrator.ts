import type { AgentDefinition, AgentRegistry } from '../agent/registry.ts';
import { createExecutionStrategy, executionModeAdmissionRefusal, type ExecutionStrategy } from '../execution-mode.ts';
import { effectiveWorkOptions, type AgentWorkOption } from '../agent/model.ts';
import {
  evaluateAdmissibleWorkOption,
  type AgentWorkOptionEngineFact,
  type AdmissibleOptionDecision,
} from '../agent/admission.ts';
import type { ReadinessRequirementScope } from '../environment/readiness.ts';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import type { BindingGenerationFence } from '../environment/binding-generation-fence.ts';
import type { AgentRunEvent, EngineAdapter, EngineSession, EngineTurnResult } from '../engine/port.ts';
import { EngineResumeRefusedError, RemoteProjectMcpStartupError } from '../engine/port.ts';
import { HostPiEngineAdapter } from '../engine/pi-host.ts';
import { HostCodexEngineAdapter } from '../engine/codex-host.ts';
import type { HostClaudeEngineAdapter } from '../engine/claude-host.ts';
import { hostRunEffortSupported } from '../engine/host-profile.ts';
import type { HostRunEngineAdapter } from '../engine/host-profile.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import { assembleProjectContract, renderProjectContract } from '../project/contract.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { EnvironmentPreference } from '../environment/model.ts';
import { resolveEnvironmentInstance, workspaceFor } from '../project/resolve.ts';
import { sanitizeWorkspacePath } from '../project/access.ts';
import { buildHandOffContext, renderHandOffPrompt, shouldAttachHandOff } from './hand-off.ts';
import { BindingGenerationRegistry } from './binding-generation.ts';
import { currentRunWorkspaceBinding, renderCurrentWorkspaceSnapshot } from './binding-context.ts';
import type { AgentRun, AgentRunStatus, RunFailureClass, RunObserver, RunWorkspaceBinding } from './model.ts';
import type { RunReplaySnapshot, RunStore } from './store.ts';
import type { SessionKeyIdentity, SessionKeyStore } from './session-key-store.ts';
import type { TaskContextProvider, TaskRunObserver } from './task-link.ts';
import {
  engineHostProfileForPlatform,
  environmentEngineHost,
  executionModeMismatchReason,
  isEngineHostedPlacement,
  type ExecutionPlacement,
  type SessionKeyScope,
} from '../execution-placement.ts';

/** Three total attempts; two retries use 200/400 ms exponential delays plus up to 100 ms jitter (800 ms total maximum). */
const ENGINE_RETRY_MAX_ATTEMPTS = 3;

async function defaultEngineRetryBackoff(failedAttempt: number): Promise<void> {
  const exponential = Math.min(200 * 2 ** Math.max(0, failedAttempt - 1), 400);
  const jitter = Math.floor(Math.random() * 101);
  await new Promise<void>((resolve) => setTimeout(resolve, exponential + jitter));
}

/**
 * Run orchestration: the one place where agent identity, environment leases, and
 * engine sessions meet.
 *
 * The interface is small on purpose — `submit`, `stop`, `get`, `waitFor`,
 * `subscribe` — and everything that makes a run hard (lease acquisition, refusal
 * on conflict, event streaming, terminal-state mapping, persistence) sits behind
 * it. Callers and tests cross this same seam.
 */

export interface RunOrchestratorOptions {
  /**
   * Where engine adapters come from, keyed by environment instance.
   *
   * A plain map is the single-instance case: it satisfies this for tests and for
   * callers with one fixed worker. A function keyed by instance id is what makes
   * execution follow the resolved and leased instance instead of a global pool,
   * which is the F1 fix (#18): the adapter that runs a run must belong to the
   * same environment instance the run leases and records.
   *
   * A function (rather than a value) also lets an environment worker be restarted
   * after it dies instead of failing every later run against a dead connection
   * (ADR-0003).
   */
  readonly engines:
    | ReadonlyMap<string, EngineAdapter>
    | ((environmentInstanceId: string) => Promise<ReadonlyMap<string, EngineAdapter>>);
  /** Separate local Engine profiles for runs that do not acquire an Environment lease. */
  readonly hostPi?: HostPiEngineAdapter;
  readonly hostCodex?: HostCodexEngineAdapter;
  readonly hostClaude?: HostClaudeEngineAdapter;
  readonly agents: AgentRegistry;
  /** Current Agent configuration authority; when supplied it also owns lifecycle refusal. */
  readonly resolveAgent?: (agentId: string) => Promise<AgentDefinition | undefined>;
  /**
   * Where an agent's project memberships come from. Optional so existing callers
   * and tests that never resolve an environment need not supply one; a run by an
   * agent with no project fails with an explicit message rather than a guess.
   */
  readonly projects?: ProjectRegistry;
  readonly pool: EnvironmentPool;
  readonly store: RunStore;
  /**
   * Durable engine session keys, so a later run in the same environment and
   * working directory continues the prior conversation instead of repeating it.
   *
   * Optional: a map of empty stores (and tests that do not exercise
   * continuation) leaves every run on its fresh-session path.
   */
  readonly sessionKeys?: SessionKeyStore;
  /**
   * Every persisted run, used to build a cross-environment hand-off.
   *
   * Defaults to the run store, so production reads the same durable history the
   * run is recorded in. Exposed so a test can supply an explicit history without
   * seeding a store.
   */
  readonly runs?: () => Promise<readonly AgentRun[]>;
  /**
   * How a run that advances a durable Task is assembled and observed (#28).
   *
   * When present, a submission naming a `taskId` is a Task run: its prompt is the
   * Task's assembled context, its environment resolution honours the Task's
   * `environmentPreference` first, and its settlement is reported back so the
   * Task's state and run summaries stay current. Absent means this orchestrator
   * serves one-round runs only; a `taskId` submission then fails explicitly
   * rather than silently running without Task context.
   */
  readonly tasks?: TaskContextProvider;
  /**
   * Told when a Task-linked run settles, so the Task can advance its state.
   *
   * Optional; without it a Task run still assembles and links, but the Task's own
   * status is only advanced by the caller. Exposed as a function so the run seam
   * stays ignorant of the Task service's shape.
   */
  readonly onTaskRunSettled?: TaskRunObserver;
  readonly taskGroupPosts?: (run: AgentRun, assertActive: () => void) => NonNullable<import('../engine/port.ts').StartSessionRequest['postTaskGroupMessage']>;
  readonly leaseTtlMs?: number;
  /** Wait before a bounded engine retry; injectable for deterministic tests. */
  readonly retryBackoff?: (failedAttempt: number) => Promise<void>;
  /** Injected so tests get deterministic ids; production uses unique ids. */
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
  /**
   * The observed engine facts (#87) for one environment instance, when this
   * build wires Environment readiness.
   *
   * Supplied by the runtime from the enrollment/readiness store. Optional so
   * existing callers and the preserved M1 graphs — which never derived
   * compatibility from facts — stay unchanged; absent means admission takes
   * the Agent's first option as before, without fabricating an observation.
   */
  readonly engineFacts?: (
    environmentInstanceId: string,
  ) => Promise<readonly AgentWorkOptionEngineFact[]>;
  /** Enforce unknown-as-blocking for a production Worker graph. */
  readonly strictAdmission?: boolean;
  /**
   * The current core-owned engine/model requirement resolver (#128, #129).
   */
  readonly requirements?: () => Promise<ReadinessRequirementScope | undefined>;
  /** One immutable process strategy shared with Task and Runtime admission. */
  readonly executionStrategy?: ExecutionStrategy;
  readonly executionPlacementForEnvironment?: (environmentInstanceId: string) => ExecutionPlacement;
  /** Core-owned Host-run workspace operation attachment; never a model target selector. */
  readonly remoteWorkspace?: (projectId: string, agentId: string, runId: string,
    containingLease?: import('../operations/environment-operations.ts').WorkspaceContainingLease,
    options?: { readonly environmentInstanceId?: string; readonly bindingFence?: BindingGenerationFence }) => Promise<import('../engine/port.ts').RemoteWorkspaceTools | undefined>;
  /** Project authority determines whether the selected MCP configuration is active. */
  readonly projectMcpSelected?: (projectId: string) => Promise<boolean>;
  /** Attaches MCP tools after the orchestrator has acquired their containing run lease. */
  readonly remoteProjectMcp?: (projectId: string, agentId: string, scope: {
    readonly environmentInstanceId: string; readonly leaseId: string; readonly runId: string;
    readonly holderKind: 'run' | 'task'; readonly holderId: string; readonly taskId?: string;
    readonly leaseCapability: 'project-mcp' | 'agent-run'; readonly bindingFence?: BindingGenerationFence;
  }) => Promise<import('../engine/port.ts').RemoteProjectMcpTools>;
  /**
   * The durable Project workspace binding for one (Project, Environment), when
   * the build wires Project access (#93, ADR-0008).
   *
   * Read once at admission and recorded on the run, so a later workspace change
   * or restart cannot rewrite which binding historical work used. Absent means
   * the build has no access records and workspace facts come only from the
   * registry projection, as before.
   */
  readonly workspaceBinding?: (
    projectId: string,
    environmentInstanceId: string,
  ) => Promise<RunWorkspaceBinding | undefined>;
}

export interface SubmitRunRequest {
  /** A lifecycle-reserved id for a Task nested run. */
  readonly runId?: string;
  readonly agentId: string;
  readonly prompt: string;
  /**
   * Resolve strictly within this Project when supplied.
   *
   * TaskService always supplies its Task's `projectId`. One-round callers may
   * omit it to retain the established "first granted project" behaviour.
   */
  readonly projectId?: string;
  /**
   * The durable Task this run advances (#28).
   *
   * When set, the run is a Task run: its prompt is assembled from the Task's
   * goal, constraints, and prior run summaries, and this run is linked into the
   * Task's run sequence. Absent means a one-round run.
   */
  readonly taskId?: string;
  /** Server-authorized scope that owns native continuation. */
  readonly sessionKeyScope?: SessionKeyScope;
  /**
   * An explicit environment selection, taking priority over project matching.
   *
   * For a Task run this is normally the Task's own `environmentPreference`,
   * supplied by the advancement service; a direct caller may pass one too.
   */
  readonly environmentPreference?: EnvironmentPreference;
  /** Explicit Work Environment for this standalone activation, independent of Engine host placement. */
  readonly workEnvironmentInstanceId?: string;
  /** Fixed Task binding, supplied only by TaskEnvironmentLifecycle. */
  readonly environmentInstanceId?: string;
  readonly environmentLeaseId?: string;
  /**
   * The original run this submission re-admits as its one bounded reconnect
   * retry (#181). Recorded on the new run's durable record, so "already
   * retried" is a fact on the run itself and a retry run can never become
   * eligible for another retry.
   */
  readonly retryOfRunId?: string;
  /** Portable Worker workspace reference supplied by the Task lifecycle. */
  readonly projectWorkspaceId?: string;
  /** Worker-root-relative registered repository location for this Project. */
  readonly projectWorkspacePath?: string;
  /** Worker-produced relative-file bootstrap for this Task Agent run. */
  readonly taskBootstrapInstructions?: string;
}

/**
 * The outcome of one attempt to run a session.
 *
 * A failure carries `resumeRefused`: true only when the engine explicitly told
 * us it would not resume the supplied key and did no work. That is the one
 * failure the caller may retry from a fresh session. Everything else — an
 * initialization failure, a missing binary, an authentication failure, a turn
 * that failed after emitting events — is reported as a plain failure so the
 * stored key is neither discarded nor reused unsafely.
 */
type SessionAttempt =
  | {
      readonly ok: true;
      readonly run: AgentRun;
      readonly result: EngineTurnResult;
      readonly engineSessionKey: string | undefined;
    }
  | {
      readonly ok: false;
      readonly run: AgentRun;
      readonly message: string;
      /** Preserve structured turn outcome evidence through settlement. */
      readonly result?: Extract<EngineTurnResult, { status: 'failed' }>;
      /** Number of events this failed attempt emitted before its error. */
      readonly progressEventCount: number;
      /** True only when the engine refused the supplied key and did no work. */
      readonly resumeRefused: boolean;
    };

export class RunOrchestrator {
  readonly #taskGroupPosts: RunOrchestratorOptions['taskGroupPosts'];
  readonly #engines: RunOrchestratorOptions['engines'];
  readonly #hostEngines: ReadonlyMap<string, HostRunEngineAdapter>;
  readonly #agents: AgentRegistry;
  readonly #resolveAgent: (agentId: string) => Promise<AgentDefinition | undefined>;
  readonly #projects: ProjectRegistry | undefined;
  readonly #pool: EnvironmentPool;
  readonly #store: RunStore;
  readonly #sessionKeys: SessionKeyStore | undefined;
  /** Reads the durable run history a hand-off is derived from. */
  readonly #runHistory: () => Promise<readonly AgentRun[]>;
  /** Assembles and links durable Task runs; absent for a one-round-only build. */
  readonly #tasks: TaskContextProvider | undefined;
  /** Told when a Task-linked run settles, so the Task can advance its state. */
  readonly #onTaskRunSettled: TaskRunObserver | undefined;
  readonly #leaseTtlMs: number;
  readonly #retryBackoff: (failedAttempt: number) => Promise<void>;
  readonly #clock: { now(): number };
  readonly #engineFacts:
    | ((environmentInstanceId: string) => Promise<readonly AgentWorkOptionEngineFact[]>)
    | undefined;
  readonly #strictAdmission: boolean;
  /** Reads the durable binding a run is admitted under (#93); optional. */
  readonly #workspaceBinding:
    | ((
        projectId: string,
        environmentInstanceId: string,
      ) => Promise<RunWorkspaceBinding | undefined>)
    | undefined;
  readonly #requirements: (() => Promise<ReadinessRequirementScope | undefined>) | undefined;
  readonly #executionStrategy: ExecutionStrategy;
  readonly #executionPlacementForEnvironment: (environmentInstanceId: string) => ExecutionPlacement;
  readonly #remoteWorkspace: RunOrchestratorOptions['remoteWorkspace'];
  readonly #projectMcpSelected: RunOrchestratorOptions['projectMcpSelected'];
  readonly #remoteProjectMcp: RunOrchestratorOptions['remoteProjectMcp'];
  readonly #bindingGenerations = new BindingGenerationRegistry();

  readonly #runs = new Map<string, AgentRun>();
  readonly #sessions = new Map<string, EngineSession>();
  readonly #stopRequests = new Set<string>();
  readonly #stopOutcomes = new Map<string, 'stopped' | 'interrupted'>();
  readonly #stopInterruptSent = new Set<string>();
  readonly #settled = new Map<string, Promise<AgentRun>>();
  readonly #observers = new Set<RunObserver>();
  readonly #ids: IdFactory;

  constructor(options: RunOrchestratorOptions) {
    this.#taskGroupPosts = options.taskGroupPosts;
    this.#engines = options.engines;
    const hostEngines: [string, HostRunEngineAdapter][] = [];
    if (options.hostPi !== undefined) hostEngines.push(['pi', options.hostPi]);
    if (options.hostCodex !== undefined) hostEngines.push(['codex', options.hostCodex]);
    if (options.hostClaude !== undefined) hostEngines.push(['claude', options.hostClaude]);
    this.#hostEngines = new Map(hostEngines);
    this.#agents = options.agents;
    this.#resolveAgent = options.resolveAgent ?? (async (id) => this.#agents.get(id));
    this.#projects = options.projects;
    this.#pool = options.pool;
    this.#store = options.store;
    this.#sessionKeys = options.sessionKeys;
    this.#runHistory = options.runs ?? (() => options.store.list());
    this.#tasks = options.tasks;
    this.#onTaskRunSettled = options.onTaskRunSettled;
    this.#leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.#retryBackoff = options.retryBackoff ?? defaultEngineRetryBackoff;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#engineFacts = options.engineFacts;
    // Wiring the fact provider opts into strict unknown-as-blocking admission;
    // an explicit false remains available only for legacy non-production
    // graphs that intentionally preserve pre-readiness behavior.
    this.#strictAdmission = options.strictAdmission ?? options.engineFacts !== undefined;
    this.#workspaceBinding = options.workspaceBinding;
    this.#requirements = options.requirements;
    this.#executionStrategy = options.executionStrategy ?? createExecutionStrategy('environment-hosted');
    this.#remoteWorkspace = options.remoteWorkspace;
    this.#projectMcpSelected = options.projectMcpSelected;
    this.#remoteProjectMcp = options.remoteProjectMcp;
    this.#executionPlacementForEnvironment = options.executionPlacementForEnvironment ?? ((environmentInstanceId) => {
      const platform = this.#pool.definition(environmentInstanceId)?.platform ?? 'unknown';
      return {
        mode: this.#executionStrategy.mode,
        engineHost: environmentEngineHost(environmentInstanceId, engineHostProfileForPlatform(platform)),
      };
    });
  }

  get processExecutionMode(): ExecutionStrategy['mode'] {
    return this.#executionStrategy.mode;
  }

  /**
   * Accept a run and return as soon as it is recorded.
   *
   * Returning an id rather than the finished run is what lets the Web client
   * observe progress: the run is inspectable and subscribable immediately, and
   * `waitFor` is available for callers that need the terminal state.
   */
  async submit(request: SubmitRunRequest): Promise<{ id: string }> {
    const run: AgentRun = {
      id: request.runId ?? this.#ids.run(),
      agentId: request.agentId,
      prompt: request.prompt,
      environmentInstanceId: '',
      ...(this.#executionStrategy.mode === 'host-run' ? { executionMode: 'host-run' as const } : {}),
      status: 'queued',
      events: [],
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.sessionKeyScope !== undefined ? { sessionKeyScope: request.sessionKeyScope } : {}),
      ...(request.workEnvironmentInstanceId !== undefined ? {
        requestedWorkEnvironmentInstanceId: sanitizeIdentifier(request.workEnvironmentInstanceId, {
          fallback: 'unknown-environment', kind: 'generic',
        }),
      } : {}),
      executionPlacement: { mode: this.#executionStrategy.mode },
      // The caller's Project scope is recorded from the first line of the
      // run's life, so a pre-admission failure (`no available environment`)
      // still names the Project whose Environments were absent — the durable
      // fact both the bounded reconnect retry reads (#181) and the run-failure
      // system event attributes its timeline entry to (#180). On success the
      // resolved Project below reasserts the same id.
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      ...(request.retryOfRunId !== undefined ? { retryOfRunId: request.retryOfRunId } : {}),
      createdAt: this.#clock.now(),
    };

    let taskExecutionPlacement: ExecutionPlacement | undefined;
    if (request.taskId !== undefined && this.#tasks?.executionPlacement !== undefined) {
      try {
        taskExecutionPlacement = await this.#tasks.executionPlacement({ taskId: request.taskId });
      } catch (error) {
        await this.settleTaskRun(await this.#finish(run, 'failed', {
          status: 'failed', message: error instanceof Error ? error.message : String(error),
        }, 'admission'));
        return { id: run.id };
      }
      const mismatch = executionModeMismatchReason(taskExecutionPlacement, this.#executionStrategy.mode);
      if (mismatch !== undefined) {
        await this.settleTaskRun(await this.#finish(run, 'failed', { status: 'failed', message: mismatch }, 'admission'));
        return { id: run.id };
      }
    }

    const refusal = executionModeAdmissionRefusal(this.#executionStrategy);
    if (refusal !== undefined) {
      await this.settleTaskRun(await this.#finish(run, 'failed', {
        status: 'failed',
        message: refusal,
      }, 'admission'));
      return { id: run.id };
    }

    if (request.taskId !== undefined && request.workEnvironmentInstanceId !== undefined) {
      await this.settleTaskRun(await this.#finish(run, 'failed', {
        status: 'failed', message: 'Task-bound activations cannot change their Work Environment binding',
      }, 'admission'));
      return { id: run.id };
    }
    if (request.workEnvironmentInstanceId !== undefined && request.environmentPreference !== undefined) {
      await this.settleTaskRun(await this.#finish(run, 'failed', {
        status: 'failed', message: 'choose one Work Environment selection for this activation',
      }, 'admission'));
      return { id: run.id };
    }

    const agent = await this.#resolveAgent(request.agentId);
    if (!agent) {
      await this.settleTaskRun(
        await this.#finish(run, 'failed', {
          status: 'failed',
          message: `unknown agent: ${request.agentId}`,
        }, 'admission'),
      );
      return { id: run.id };
    }

    // A Task run's prompt is assembled from the Task's goal, constraints, and
    // prior run summaries (#28). A submission that names a Task this process
    // cannot assemble context for is refused explicitly, never run context-free.
    let prompt = request.prompt;
    if (request.taskId !== undefined) {
      if (this.#tasks === undefined) {
        await this.settleTaskRun(
          await this.#finish(run, 'failed', {
            status: 'failed',
            message: `task runs are not configured on this orchestrator: ${request.taskId}`,
          }, 'admission'),
        );
        return { id: run.id };
      }
      try {
        prompt = await this.#tasks.prompt({ taskId: request.taskId, prompt: request.prompt });
      } catch (error) {
        await this.settleTaskRun(
          await this.#finish(run, 'failed', {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return { id: run.id };
      }
    }
    const taskRun: AgentRun = { ...run, prompt };

    if (this.#executionStrategy.mode === 'host-run') {
      return this.#submitHostRun(taskRun, agent, request);
    }

    // Task runs are created exclusively by TaskEnvironmentLifecycle. A partial
    // binding used to fall through to the normal one-round lease path, inventing
    // a second lifecycle for a Task; reject it before resolving or acquiring.
    if (request.taskId !== undefined && (request.environmentInstanceId === undefined || request.environmentLeaseId === undefined)) {
      await this.settleTaskRun(await this.#finish(taskRun, 'failed', {
        status: 'failed',
        message: `task run ${request.taskId} requires lifecycle lease and environment bindings`,
      }, 'admission'));
      return { id: taskRun.id };
    }

    // Do not permit a Task caller to fall back to the agent's other projects.
    // TaskService always provides this field from the durable Task; rejecting a
    // malformed direct call is safer than silently executing its Task elsewhere.
    if (request.taskId !== undefined && request.projectId === undefined) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: `task run ${request.taskId} is missing its project scope`,
        }, 'admission'),
      );
      return { id: taskRun.id };
    }

    // Resolve the environment before recording the run, so the persisted run
    // names the instance it actually used rather than an agent's fixed device.
    // An explicit environment preference — normally the Task's own — is honoured
    // first, with project matching as the fallback (M1 scope item 8).
    const agentProjects = this.#projects?.forAgent(agent.id) ?? [];
    const scopedProjects =
      request.projectId === undefined
        ? agentProjects
        : agentProjects.filter((project) => project.id === request.projectId);
    if (request.projectId !== undefined && scopedProjects.length === 0) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: `agent ${agent.id} is not a member of project ${request.projectId}`,
        }, 'admission'),
      );
      return { id: taskRun.id };
    }
    const resolution = request.taskId !== undefined && request.environmentInstanceId !== undefined
      ? { ok: true as const, instanceId: request.environmentInstanceId, projectId: request.projectId!, preferred: true }
      : resolveEnvironmentInstance(
      {
        projects: scopedProjects,
        capability: agent.capability,
        ...(request.workEnvironmentInstanceId !== undefined
          ? { environmentPreference: { kind: 'instance' as const, id: request.workEnvironmentInstanceId } }
          : request.environmentPreference !== undefined
            ? { environmentPreference: request.environmentPreference }
            : {}),
      },
      this.#pool,
    );
    if (!resolution.ok) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: this.#resolutionFailure(agent, resolution.reason),
        }, 'environment'),
      );
      return { id: taskRun.id };
    }
    if (request.workEnvironmentInstanceId !== undefined && resolution.instanceId !== request.workEnvironmentInstanceId) {
      await this.settleTaskRun(await this.#finish(taskRun, 'failed', {
        status: 'failed', message: 'the requested Work Environment is not authorized for this Project capability',
      }, 'admission'));
      return { id: taskRun.id };
    }

    // Run admission picks the first work option that is compatible with the
    // resolved Environment's current facts (ADR-0008). The choice happens
    // entirely *before* an engine accepts the work, and it is recorded on the
    // durable run so the engine, work model, effort, and configuration version
    // the run actually used remain historically attributable. Once an engine
    // accepts the run, this choice is never revisited: a later failure is
    // reported as-is and never replayed through a lower-priority option.
    const admittedOption = await this.#admitWorkOption(agent, resolution.instanceId);
    if (!admittedOption.ok) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: admittedOption.message,
        }, 'admission'),
      );
      return { id: taskRun.id };
    }

    // Capture the durable workspace binding facts once, before any engine
    // accepts the work (ADR-0008): after a later workspace change or a restart,
    // the run's history still names the binding it actually used. The binding
    // is a historical fact like the work option and is never re-derived below.
    const rawWorkspaceBinding =
      resolution.projectId !== undefined && this.#workspaceBinding !== undefined
        ? await this.#workspaceBinding(resolution.projectId, resolution.instanceId)
        : undefined;
    // A binding port may be reading legacy durable data. Never let an unsafe
    // location become run history or a Worker request: discard malformed facts
    // before this run is persisted, then use only the independently validated
    // legacy projection fallback below.
    const workspaceBinding = sanitizeRunWorkspaceBinding(rawWorkspaceBinding);

    const recorded: AgentRun = {
      ...taskRun,
      environmentInstanceId: resolution.instanceId,
      projectId: resolution.projectId,
      executionPlacement: taskExecutionPlacement ?? this.#executionPlacementForEnvironment(resolution.instanceId),
      workOption: admittedOption.option,
      configurationVersion: admittedOption.configurationVersion,
      ...(workspaceBinding !== undefined ? { workspaceBinding } : {}),
      ...(request.environmentLeaseId !== undefined ? { leaseId: request.environmentLeaseId } : {}),
    };
    this.#runs.set(recorded.id, recorded);
    await this.#store.save(recorded);

    // Link the run into the Task's sequence before it executes, so even a run
    // that fails to start is part of the Task's durable history. A link failure
    // is a run failure: a Task run that is not linked would be invisible to
    // later advancement and accumulate no summary.
    if (recorded.taskId !== undefined && this.#tasks !== undefined) {
      try {
        await this.#tasks.link({
          taskId: recorded.taskId,
          runId: recorded.id,
          agentId: recorded.agentId,
        });
      } catch (error) {
        await this.settleTaskRun(
          await this.#finish(recorded, 'failed', {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return { id: recorded.id };
      }
    }

    // The run's own durable binding is the authoritative workspace fact: it was
    // captured from the access record at admission and never re-read, so a
    // workspace change or restart after admission cannot change what this run
    // presents to the Worker. The registry projection is only the fallback for
    // callers with no access records, and its location passes the same
    // relative-path validator the domain records with, so a corrupt projection
    // cannot cross the internal boundary as an absolute host path (ADR-0009).
    const resolvedProject = this.#projects?.get(resolution.projectId);
    const registeredWorkspace = resolvedProject === undefined
      ? undefined
      : workspaceFor(resolvedProject, resolution.instanceId);
    const binding = recorded.workspaceBinding;
    const registeredPath = registeredWorkspace?.path;
    const safeRequestedPath = sanitizeWorkspacePath(request.projectWorkspacePath);
    const safeProjectionPath =
      binding === undefined && registeredPath !== undefined
        ? sanitizeWorkspacePath(registeredPath)
        : undefined;
    const workspace = {
      ...(binding?.workspaceId !== undefined
        ? { projectWorkspaceId: binding.workspaceId }
        : request.projectWorkspaceId !== undefined
          ? { projectWorkspaceId: request.projectWorkspaceId }
          : registeredWorkspace !== undefined
            ? { projectWorkspaceId: resolution.projectId }
            : {}),
      ...(binding?.workspaceId !== undefined
        ? { projectWorkspaceKind: binding.kind }
        : {}),
      ...(binding?.path !== undefined
        ? { projectWorkspacePath: binding.path }
        : binding?.workspaceId === undefined && safeRequestedPath !== undefined
          ? { projectWorkspacePath: safeRequestedPath }
          : safeProjectionPath !== undefined
            ? { projectWorkspacePath: safeProjectionPath }
            : {}),
      ...(request.taskBootstrapInstructions !== undefined ? { taskBootstrapInstructions: request.taskBootstrapInstructions } : {}),
    };
    const settled = this.#execute(recorded, agent, workspace).then((run) => this.settleTaskRun(run));
    this.#settled.set(recorded.id, settled);
    return { id: recorded.id };
  }

  async #submitHostRun(
    initial: AgentRun,
    agent: AgentDefinition,
    request: SubmitRunRequest,
  ): Promise<{ id: string }> {
    let attemptedWorkEnvironmentInstanceId = request.workEnvironmentInstanceId;
    const refuse = async (message: string): Promise<{ id: string }> => {
      const unavailable = await this.#advance(initial, {
        workspaceBindingStatus: 'unavailable',
        ...(attemptedWorkEnvironmentInstanceId !== undefined ? {
          requestedWorkEnvironmentInstanceId: sanitizeIdentifier(attemptedWorkEnvironmentInstanceId, {
            fallback: 'unknown-environment', kind: 'generic',
          }),
        } : {}),
      });
      await this.settleTaskRun(await this.#finish(unavailable, 'failed', { status: 'failed', message }, 'admission'));
      return { id: initial.id };
    };
    const taskBound = request.taskId !== undefined;
    if (taskBound) {
      if (request.workEnvironmentInstanceId !== undefined) return refuse('Task-bound activations cannot switch Work Environments');
      if (request.environmentInstanceId === undefined || request.environmentLeaseId === undefined || request.projectId === undefined) {
        return refuse(`task run ${request.taskId} requires lifecycle lease, Environment, and Project bindings`);
      }
    } else if (request.environmentInstanceId !== undefined || request.environmentLeaseId !== undefined ||
        request.environmentPreference !== undefined || request.projectWorkspaceId !== undefined ||
        request.projectWorkspacePath !== undefined || request.taskBootstrapInstructions !== undefined) {
      return refuse('Host-run accepts one-round Message conversations or Task runs with lifecycle-owned Environment bindings');
    }
    const projects = this.#projects?.forAgent(agent.id) ?? [];
    const selectedProject = request.projectId === undefined
      ? projects[0]
      : projects.find(project => project.id === request.projectId);
    if (selectedProject === undefined) {
      return refuse(request.projectId === undefined
        ? `agent ${agent.id} has no Project authority for a Host-run conversation`
        : `agent ${agent.id} is not a member of project ${request.projectId}`);
    }
    const options = effectiveWorkOptions(agent);
    let selectedOption: { readonly option: AgentWorkOption; readonly host: HostRunEngineAdapter } | undefined;
    for (const candidate of options) {
      const candidateHost = this.#hostEngines.get(candidate.engine);
      if (candidateHost === undefined || candidate.workModel !== candidateHost.authorizedModel) continue;
      const readiness = await candidateHost.readiness(true);
      if (readiness.status !== 'ready') {
        const reason = readiness.authentication === 'not-ready'
          ? 'authentication is not ready'
          : readiness.modelAvailability === 'unavailable'
            ? 'the exact authorized model is unavailable'
            : readiness.adapterControls === 'unavailable'
              ? 'required isolated Engine controls are unavailable'
              : readiness.installation !== 'ready'
                ? 'the pinned Engine runtime is unavailable'
                : 'readiness is unknown';
        return refuse(`Host-run ${candidateHost.id} admission failed for this Engine profile: ${reason}`);
      }
      if (hostRunEffortSupported(candidateHost, candidate.effort || 'medium')) {
        selectedOption = { option: candidate, host: candidateHost };
        break;
      }
    }
    if (selectedOption === undefined) return refuse(`agent ${agent.id} has no work option authorized by a configured Host Engine profile`);
    const { option, host } = selectedOption;
    const previousActivations = (await this.#runHistory())
      .filter((prior) => prior.agentId === agent.id && prior.projectId === selectedProject.id &&
        prior.taskId === undefined && sameActivationScope(prior.sessionKeyScope, initial.sessionKeyScope))
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const retainedWorkEnvironmentInstanceId = previousActivations.find((prior) =>
      prior.workspaceBinding?.environmentInstanceId !== undefined,
    )?.workspaceBinding?.environmentInstanceId;
    const selectedWorkEnvironmentInstanceId = taskBound
      ? undefined
      : request.workEnvironmentInstanceId ?? retainedWorkEnvironmentInstanceId;
    attemptedWorkEnvironmentInstanceId = selectedWorkEnvironmentInstanceId;
    const retainedBinding = selectedWorkEnvironmentInstanceId !== undefined && selectedProject.id !== undefined
      ? await this.#workspaceBinding?.(selectedProject.id, selectedWorkEnvironmentInstanceId)
      : undefined;
    let mcpEnvironmentInstanceId: string | undefined = taskBound ? request.environmentInstanceId : undefined;
    let mcpLeaseId: string | undefined = taskBound ? request.environmentLeaseId : undefined;
    let workspaceLeaseId: string | undefined = taskBound ? request.environmentLeaseId : undefined;
    let stopAdmissionKeepalive: (() => void) | undefined;
    if (taskBound) {
      const taskLease = mcpLeaseId === undefined ? undefined : this.#pool.getLease(mcpLeaseId);
      if (!taskLease || taskLease.state !== 'active' || taskLease.instanceId !== mcpEnvironmentInstanceId ||
          taskLease.capability !== 'agent-run' || taskLease.holderKind !== 'task' || taskLease.holderId !== request.taskId || taskLease.taskId !== request.taskId) {
        return refuse('Task Environment lease is not active for this Task');
      }
    }
    const mcpSelected = this.#projectMcpSelected !== undefined && await this.#projectMcpSelected(selectedProject.id);
    if (mcpSelected) {
      if (!this.#remoteProjectMcp) return refuse('Project MCP is selected but no Worker MCP bridge is configured');
      const resolution = resolveEnvironmentInstance({ projects: [selectedProject], capability: 'project-mcp',
        ...(taskBound
          ? { environmentPreference: { kind: 'instance', id: mcpEnvironmentInstanceId! } }
          : selectedWorkEnvironmentInstanceId !== undefined
            ? { environmentPreference: { kind: 'instance', id: selectedWorkEnvironmentInstanceId } }
            : {}) }, this.#pool);
      if (!resolution.ok || (taskBound && resolution.instanceId !== mcpEnvironmentInstanceId) ||
          (!taskBound && selectedWorkEnvironmentInstanceId !== undefined && resolution.instanceId !== selectedWorkEnvironmentInstanceId)) {
        return refuse(taskBound
          ? 'Project MCP is not authorized for the Task Environment'
          : selectedWorkEnvironmentInstanceId !== undefined
            ? 'the selected Work Environment is not authorized for Project MCP'
            : 'Project MCP is selected but no authorized leased Environment is available');
      }
      mcpEnvironmentInstanceId = resolution.instanceId;
      if (!taskBound && selectedWorkEnvironmentInstanceId === undefined) {
        const acquired = await this.#pool.acquireLeaseRevalidated({
          instanceId: resolution.instanceId, capability: 'project-mcp', holderId: initial.id, runId: initial.id, ttlMs: this.#leaseTtlMs,
        });
        if (!acquired.ok) return refuse(`Project MCP Environment lease is unavailable (${acquired.reason})`);
        mcpLeaseId = acquired.lease.id;
        stopAdmissionKeepalive = this.#pool.keepLeaseUntilCleanup(mcpLeaseId, this.#leaseTtlMs);
        workspaceLeaseId = mcpLeaseId;
      }
    }
    if (!taskBound && selectedWorkEnvironmentInstanceId !== undefined) {
      const resolution = resolveEnvironmentInstance({ projects: [selectedProject], capability: 'agent-run',
        environmentPreference: { kind: 'instance', id: selectedWorkEnvironmentInstanceId } }, this.#pool);
      if (!resolution.ok || resolution.instanceId !== selectedWorkEnvironmentInstanceId) {
        stopAdmissionKeepalive?.();
        return refuse('the selected Work Environment is not authorized for Agent-run operations');
      }
      const acquired = await this.#pool.acquireLeaseRevalidated({
        instanceId: resolution.instanceId, capability: 'agent-run', holderId: initial.id, runId: initial.id, ttlMs: this.#leaseTtlMs,
      });
      if (!acquired.ok) {
        stopAdmissionKeepalive?.();
        return refuse(`Work Environment Agent-run lease is unavailable (${acquired.reason})`);
      }
      workspaceLeaseId = acquired.lease.id;
      if (mcpSelected) {
        mcpLeaseId = workspaceLeaseId;
        mcpEnvironmentInstanceId = resolution.instanceId;
      }
      stopAdmissionKeepalive?.();
      stopAdmissionKeepalive = this.#pool.keepLeaseUntilCleanup(workspaceLeaseId, this.#leaseTtlMs);
    }
    const runEnvironmentInstanceId = mcpEnvironmentInstanceId ??
      (taskBound ? request.environmentInstanceId : selectedWorkEnvironmentInstanceId);
    const primaryLeaseId = workspaceLeaseId ?? mcpLeaseId;
    const recorded: AgentRun = {
      ...initial,
      projectId: selectedProject.id,
      ...(runEnvironmentInstanceId !== undefined ? { environmentInstanceId: runEnvironmentInstanceId } : {}),
      ...(selectedWorkEnvironmentInstanceId !== undefined ? {
        requestedWorkEnvironmentInstanceId: sanitizeIdentifier(selectedWorkEnvironmentInstanceId, {
          fallback: 'unknown-environment', kind: 'generic',
        }),
      } : {}),
      ...(retainedBinding !== undefined ? { workspaceBinding: retainedBinding } : {}),
      ...(primaryLeaseId !== undefined ? { leaseId: primaryLeaseId } : {}),
      executionMode: 'host-run',
      engineHostProfileId: host.profileId,
      executionPlacement: {
        mode: 'host-run',
        engineHost: {
          kind: 'sprout',
          // The opaque profile identifies this host-local engine session store.
          id: host.profileId,
          profile: engineHostProfileForPlatform(
            process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unknown',
          ),
        },
      },
      workOption: option,
      configurationVersion: agent.configurationVersion ?? 1,
    };
    this.#runs.set(recorded.id, recorded);
    try {
      await this.#store.save(recorded);
    } catch (error) {
      if (primaryLeaseId !== undefined && !taskBound) this.#pool.releaseLease(primaryLeaseId);
      stopAdmissionKeepalive?.();
      throw error;
    }
    const execute = () => this.#executeHostRun(recorded, agent, host, option, mcpSelected,
      selectedWorkEnvironmentInstanceId, workspaceLeaseId, mcpLeaseId, stopAdmissionKeepalive);
    const settled = (recorded.taskId === undefined
      ? this.#bindingGenerations.withLock(bindingGenerationScope(recorded), execute)
      : execute()).then((run) => this.settleTaskRun(run)).finally(() => stopAdmissionKeepalive?.());
    this.#settled.set(recorded.id, settled);
    return { id: recorded.id };
  }

  async #executeHostRun(
    initial: AgentRun,
    agent: AgentDefinition,
    host: HostRunEngineAdapter,
    option: AgentWorkOption,
    useProjectMcp: boolean,
    requestedWorkEnvironmentInstanceId: string | undefined,
    workspaceLeaseId: string | undefined,
    mcpLeaseId: string | undefined,
    stopAdmissionKeepalive: (() => void) | undefined,
  ): Promise<AgentRun> {
    if (this.#stopRequests.has(initial.id)) {
      if (initial.leaseId !== undefined && initial.taskId === undefined) this.#pool.releaseLease(initial.leaseId);
      return this.#finish(initial, 'interrupted', { status: 'interrupted' });
    }
    const previousActivationWasBound = initial.workspaceBinding !== undefined;
    let prepared = await this.#advance(initial, { status: 'running', workspaceBindingStatus: 'staging' });
    let remoteProjectMcp: import('../engine/port.ts').RemoteProjectMcpTools | undefined;
    let mcpMayHaveStarted = false;
    let remoteWorkspace: import('../engine/port.ts').RemoteWorkspaceTools | undefined;
    let remoteSettlementUnknown = false;
    let containingLeaseCanRelease = false;
    const bindingScope = bindingGenerationScope(initial);
    const bindingFence = initial.taskId === undefined ? this.#bindingGenerations.stage(bindingScope) : undefined;
    let catalogPublished = false;
    let outcome = prepared;
    try {
      if (useProjectMcp && mcpLeaseId !== undefined && initial.environmentInstanceId) {
        if (!this.#remoteProjectMcp) throw new Error('Project MCP Worker bridge is unavailable');
        const lease = this.#pool.getLease(mcpLeaseId);
        if (!lease) throw new Error('Project MCP lease is unavailable');
        remoteProjectMcp = await this.#remoteProjectMcp(initial.projectId ?? '', agent.id, {
          environmentInstanceId: lease.instanceId, leaseId: lease.id, runId: initial.id,
          holderKind: lease.holderKind ?? 'run', holderId: lease.holderId,
          ...(lease.taskId !== undefined ? { taskId: lease.taskId } : {}),
          leaseCapability: lease.capability === 'agent-run' ? 'agent-run' : 'project-mcp',
          ...(bindingFence !== undefined ? { bindingFence } : {}),
        });
        mcpMayHaveStarted = true;
      }
      const workspaceTarget = initial.taskId !== undefined
        ? initial.environmentInstanceId
        : requestedWorkEnvironmentInstanceId ?? (useProjectMcp ? initial.environmentInstanceId : undefined);
      if (workspaceTarget !== undefined && workspaceLeaseId !== undefined) {
        remoteWorkspace = await this.#remoteWorkspace?.(initial.projectId ?? '', agent.id, initial.id,
          (() => {
            const lease = this.#pool.getLease(workspaceLeaseId);
            if (!lease) throw new Error('Containing lease is unavailable');
            return {
              environmentInstanceId: lease.instanceId, leaseId: lease.id, runId: initial.id,
              holderKind: lease.holderKind ?? 'run', holderId: lease.holderId,
              ...(lease.taskId !== undefined ? { taskId: lease.taskId } : {}),
              leaseCapability: lease.capability === 'agent-run' ? 'agent-run' as const : 'project-mcp' as const,
              ...(bindingFence !== undefined ? { bindingFence } : {}),
              canRelease: () => containingLeaseCanRelease,
            };
          })(),
          {
            environmentInstanceId: workspaceTarget,
            ...(bindingFence !== undefined ? { bindingFence } : {}),
          });
      }
      if (remoteWorkspace !== undefined) {
        // Workspace attachment has started the same renewal policy; hand off without a gap.
        stopAdmissionKeepalive?.();
      }
      if ((requestedWorkEnvironmentInstanceId !== undefined || previousActivationWasBound) &&
          remoteWorkspace === undefined && remoteProjectMcp === undefined) {
        throw new Error(requestedWorkEnvironmentInstanceId !== undefined
          ? 'the requested Work Environment could not be attached'
          : 'the current Work Environment binding could not be reattached');
      }
      const binding = currentRunWorkspaceBinding({
        ...(remoteWorkspace !== undefined ? { remoteWorkspace } : {}),
        ...(remoteProjectMcp !== undefined ? { remoteProjectMcp } : {}),
        ...(bindingFence !== undefined ? { catalogGeneration: bindingFence.generation } : {}),
      });
      const hasBinding = binding !== undefined;
      const operations = binding?.operations ?? [];
      const mcpNames = binding?.projectMcpTools ?? [];
      const notice = hasBinding
        ? `Remote workspace catalog staged for Environment ${binding.environmentInstanceId} (binding generation ${binding.generation ?? 'unknown'}). Operations: ${operations.length ? operations.join(', ') : 'none'}; Project MCP tools: ${mcpNames.length ? mcpNames.join(', ') : 'none'}.`
        : 'No remote Project workspace is attached to this activation; host-local work tools are disabled.';
      prepared = await this.#advance(prepared, {
        ...(binding?.environmentInstanceId !== undefined ? { environmentInstanceId: binding.environmentInstanceId } : {}),
        ...(binding !== undefined ? { workspaceBinding: binding } : {}),
        workspaceBindingStatus: 'staging',
        events: [...prepared.events, { type: 'notice', text: notice }],
      });
      const assembled = await this.#assembleInput(prepared, agent, prepared.id);
      const currentSnapshot = renderCurrentWorkspaceSnapshot(
        binding, hasBinding ? 'active' : 'detached', assembled.handOff?.bindingChange,
      );
      // Host-run Engines receive Task facts in assembled.prompt. The Worker bootstrap
      // points at .sprout Task files, which remote Project tools intentionally do
      // not expose and the host-profile working directory cannot read.
      const instructions = appendBootstrap(assembled.instructions, currentSnapshot);
      if (assembled.handOff !== undefined) prepared = await this.#advance(prepared, { handOff: assembled.handOff });
      const prompt = assembled.prompt;
      const workingDirectory = `host-profile:${host.id}:${host.profileId}:agent:${agent.id}`;
      const placement = initial.executionPlacement;
      const scope = initial.sessionKeyScope;
      const sessionWorkingDirectory = sessionWorkingDirectoryForBinding(
        initial.projectId, workingDirectory, binding,
      );
      const identity: SessionKeyIdentity | undefined = placement !== undefined &&
        isEngineHostedPlacement(placement) && scope !== undefined
        ? {
            agentId: agent.id,
            engine: host.id,
            environmentInstanceId: '',
            executionPlacement: placement,
            scope,
            workingDirectory: sessionWorkingDirectory,
          }
        : undefined;
      const stored = this.#sessionKeys && identity !== undefined
        ? await this.#sessionKeys.get(identity)
        : undefined;
      const publishCatalog = async (): Promise<void> => {
        if (catalogPublished) return;
        bindingFence?.publish();
        catalogPublished = true;
        prepared = await this.#advance(prepared, { workspaceBindingStatus: hasBinding ? 'active' : 'detached' });
      };
      let attempt = await this.#runSession(
        host, agent, option, prompt, prepared, stored?.key, instructions,
        workingDirectory, undefined, undefined, undefined, remoteWorkspace, remoteProjectMcp, publishCatalog,
      );
      if (stored !== undefined && !attempt.ok && attempt.resumeRefused) {
        if (this.#sessionKeys && identity !== undefined) await this.#sessionKeys.delete(identity);
        attempt = await this.#runSession(
          host, agent, option, prompt, prepared, undefined, instructions,
          workingDirectory, undefined, undefined, undefined, remoteWorkspace, remoteProjectMcp, publishCatalog,
        );
      }
      if (!attempt.ok) {
        remoteSettlementUnknown = true;
        prepared = await this.#advance(attempt.run, {
          workspaceBindingStatus: catalogPublished ? 'recovering' : 'unavailable',
        });
        outcome = await this.#finish(prepared, 'failed', attempt.result ?? {
          status: 'failed', message: attempt.message,
        });
      } else {
        if (this.#sessionKeys && identity !== undefined && attempt.result.status === 'completed' && attempt.engineSessionKey) {
          await this.#sessionKeys.save({ ...identity, key: attempt.engineSessionKey, updatedAt: this.#clock.now() });
        }
        if (attempt.result.status === 'interrupted') {
          remoteSettlementUnknown = true;
          prepared = await this.#advance(attempt.run, { workspaceBindingStatus: 'recovering' });
        } else {
          prepared = await this.#advance(attempt.run, {
            workspaceBindingStatus: catalogPublished ? (hasBinding ? 'active' : 'detached') : 'unavailable',
          });
        }
        outcome = await this.#settleWithResult(prepared, attempt.result);
      }
    } catch (error) {
      remoteSettlementUnknown = true;
      const message = error instanceof RemoteProjectMcpStartupError
        ? this.#projectMcpStartupFailureMessage(error.reason)
        : 'Host-run Engine execution failed';
      const recoveryLeaseId = prepared.leaseId ?? initial.leaseId;
      const recovering = recoveryLeaseId !== undefined && this.#pool.getLease(recoveryLeaseId)?.state === 'recovering';
      prepared = await this.#advance(prepared, {
        workspaceBindingStatus: recovering ? 'recovering' : 'unavailable',
      });
      outcome = await this.#finish(prepared, 'failed', { status: 'failed', message });
    } finally {
      bindingFence?.revoke();
      if (initial.leaseId !== undefined) {
        if (remoteSettlementUnknown) this.#pool.markRecovering(initial.leaseId);
        let stopCertain = !mcpMayHaveStarted;
        if (remoteProjectMcp !== undefined) {
          try { stopCertain = (await remoteProjectMcp.close()) === 'stopped'; }
          catch { stopCertain = false; }
        }
        if (!stopCertain) this.#pool.markRecovering(initial.leaseId);
        containingLeaseCanRelease = stopCertain && initial.taskId === undefined && this.#pool.getLease(initial.leaseId)?.state === 'active';
      }
      try { await remoteWorkspace?.settle?.(remoteSettlementUnknown ? 'unknown' : 'settled'); } catch {
        remoteSettlementUnknown = true;
        if (initial.leaseId !== undefined) this.#pool.markRecovering(initial.leaseId);
      }
      if (initial.leaseId !== undefined && initial.taskId === undefined && !remoteSettlementUnknown &&
          this.#pool.getLease(initial.leaseId)?.state === 'active') this.#pool.releaseLease(initial.leaseId);
      if (remoteWorkspace === undefined && initial.leaseId !== undefined && containingLeaseCanRelease &&
          this.#pool.getLease(initial.leaseId)?.state === 'active') this.#pool.releaseLease(initial.leaseId);
      const recoveryLeaseId = prepared.leaseId ?? initial.leaseId;
      const recoveryRequired = recoveryLeaseId !== undefined &&
        this.#pool.getLease(recoveryLeaseId)?.state === 'recovering';
      if (recoveryRequired && outcome.workspaceBindingStatus !== 'recovering') {
        outcome = await this.#advance(outcome, { workspaceBindingStatus: 'recovering' });
      }
    }
    return this.#runs.get(initial.id) ?? outcome;
  }

  /**
   * Report a settled Task run back so the Task can record a summary and advance.
   *
   * A bookkeeping failure must never change the run's own terminal state, so it is
   * isolated here and reported rather than allowed to reject the run's settled
   * promise. A one-round run is returned untouched.
   */
  async settleTaskRun(run: AgentRun): Promise<AgentRun> {
    if (run.taskId === undefined || this.#onTaskRunSettled === undefined) return run;
    try {
      await this.#onTaskRunSettled({ taskId: run.taskId, run });
    } catch (error) {
      process.stderr.write(
        `[task] failed to advance task ${run.taskId} after run ${run.id}: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return run;
  }

  #resolutionFailure(agent: AgentDefinition, reason: 'no-project' | 'no-available-environment'): string {
    return reason === 'no-project'
      ? `no project grants agent ${agent.id} access to an environment for capability: ${agent.capability}`
      : `no available environment for capability: ${agent.capability}`;
  }

  #projectMcpStartupFailureMessage(reason: RemoteProjectMcpStartupError['reason']): string {
    switch (reason) {
      case 'missing-dependency': return 'Project MCP could not start because a configured server dependency is missing on the Worker. Install the server dependency on the assigned Environment and retry.';
      case 'invalid-configuration': return 'Project MCP could not start because the selected .mcp.json configuration is invalid. Correct it in the bound Project workspace and retry.';
      case 'unsupported-configuration': return 'Project MCP could not start because the selected configuration or server features are unsupported. Use a supported stdio or HTTP server that exposes tools and retry.';
      case 'remote-unavailable': return 'Project MCP could not reach or authorize the selected remote server from the Environment Worker. Check the remote endpoint and its configured authorization, then retry.';
      case 'no-tools': return 'Project MCP started, but the server exposed no supported tools. Configure a server with an MCP tools capability and retry.';
      case 'worker-refused': return 'The Environment Worker refused Project MCP startup. Check its connection, approval, and capability permission, then retry.';
    }
  }

  /**
   * Pick the Agent's first work option compatible with one Environment's
   * current facts, before any engine accepts the work (ADR-0008).
   *
   * Compatibility is derived from the Environment's observed engine facts
   * (#87), never from a stored state or a probe of a live process. An option
   * the Environment cannot yet observe is not admissible here — `unknown` is
   * honest, and admitting onto an unverified engine would fabricate readiness.
   * An Agent whose every option is incompatible therefore fails admission with
   * an explicit reason; the Agent itself stays valid and visibly unavailable
   * through the compatibility projection.
   *
   * When the engine facts for the instance are genuinely absent (a build with
   * no enrollment/readiness wiring, or the single-instance M1 graphs), the
   * projection receives no facts and every option reports `unknown`; this
   * orchestrator then admits the first option unchanged, preserving the
   * behaviour of callers that never opted into Environment facts. A build that
   * supplies facts gets the full ordered evaluation.
   */
  async #admitWorkOption(
    agent: AgentDefinition,
    environmentInstanceId: string,
  ): Promise<
    | { readonly ok: true; readonly option: AgentWorkOption; readonly configurationVersion: number }
    | { readonly ok: false; readonly message: string; readonly reason?: string }
  > {
    const options = effectiveWorkOptions(agent);
    const observed = this.#engineFacts
      ? await this.#engineFacts(environmentInstanceId)
      : undefined;
    const reqs = this.#requirements ? await this.#requirements() : undefined;
    // Once the Environment fact seam is wired, absence is unknown—not an
    // invitation to guess. This is the strict #114/#118 admission boundary:
    // every required engine/model fact must be established before the first
    // option is accepted. The only legacy escape hatch is an explicitly
    // non-strict graph (or an orchestrator constructed without `engineFacts`).
    const firstOption = options[0];
    const decision: AdmissibleOptionDecision =
      observed === undefined || (observed.length === 0 && !this.#strictAdmission)
        ? firstOption !== undefined
          ? { ok: true, option: firstOption }
          : { ok: false, reason: 'no configured work option' }
        : evaluateAdmissibleWorkOption(options, observed, reqs);
    if (!decision.ok || decision.option === undefined) {
      const reasonDetail = decision.reason ? ` (${decision.reason})` : '';
      return {
        ok: false,
        message:
          `no compatible work option for agent ${agent.id} on environment instance ${environmentInstanceId}: ` +
          options.map((option) => option.engine).join(', ') +
          reasonDetail,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
    }
    return { ok: true, option: decision.option, configurationVersion: agent.configurationVersion ?? 1 };
  }

  /**
   * Evaluate whether an Agent's ordered work options are admissible on an
   * environment instance without submitting a run (#129).
   */
  async evaluateOptionAdmission(
    agentId: string,
    environmentInstanceId: string,
  ): Promise<AdmissibleOptionDecision> {
    const agent = await this.#resolveAgent(agentId);
    if (agent === undefined) {
      return { ok: false, reason: `unknown agent ${agentId}` };
    }
    const options = effectiveWorkOptions(agent);
    if (this.#executionStrategy.mode === 'host-run') {
      let selected: { readonly option: AgentWorkOption; readonly host: HostRunEngineAdapter } | undefined;
      for (const option of options) {
        const host = this.#hostEngines.get(option.engine);
        if (host === undefined || option.workModel !== host.authorizedModel) continue;
        const readiness = await host.readiness();
        if (readiness.status !== 'ready' || readiness.installation !== 'ready'
          || readiness.authentication !== 'ready' || readiness.modelAvailability !== 'available'
          || readiness.adapterControls !== 'ready') {
          return { ok: false, reason: `Sprout-host ${host.id} model, authentication, installation, or adapter controls are not confirmed ready` };
        }
        if (hostRunEffortSupported(host, option.effort || 'medium')) {
          selected = { option, host };
          break;
        }
      }
      if (selected === undefined) return { ok: false, reason: 'no configured work option is authorized by a Sprout-host Engine profile' };
      return { ok: true, option: selected.option };
    }
    const observed = this.#engineFacts
      ? await this.#engineFacts(environmentInstanceId)
      : undefined;
    const reqs = this.#requirements ? await this.#requirements() : undefined;
    if (observed === undefined || (observed.length === 0 && !this.#strictAdmission)) {
      return options[0] !== undefined ? { ok: true, option: options[0] } : { ok: false, reason: 'no configured work option' };
    }
    return evaluateAdmissibleWorkOption(options, observed, reqs);
  }

  /** The current observable state of a run. */
  get(runId: string): AgentRun | undefined {
    return this.#runs.get(runId);
  }

  /** Every run this process currently knows about, in submission order. */
  known(): readonly AgentRun[] {
    return [...this.#runs.values()];
  }

  /**
   * Every run, including ones persisted by a previous process.
   *
   * The in-memory state wins for runs this process is already tracking, so a
   * recovered run never shadows live progress.
   */
  async list(): Promise<readonly AgentRun[]> {
    for (const stored of await this.#store.list()) {
      if (!this.#runs.has(stored.id)) this.#runs.set(stored.id, stored);
    }
    return [...this.#runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Latest durable run snapshots in their store-assigned forward replay order. */
  async replaySnapshots(): Promise<readonly RunReplaySnapshot[]> {
    return this.#store.replaySnapshots();
  }

  /**
   * Mark runs left mid-flight by a previous process as failed and transition
   * their active leases into recovery.
   *
   * A run recorded as `running` belongs to a process that no longer exists: its
   * engine session died with it, so nothing will ever settle it. Its capacity
   * lease transitions to `recovering` (O4) so the environment is protected from
   * unsafe reassignment until uncommitted work is captured or discarded.
   */
  async reconcileOrphanedRuns(): Promise<readonly AgentRun[]> {
    await this.#pool.load();
    const recovered: AgentRun[] = [];
    for (const stored of await this.#store.list()) {
      if (this.#runs.has(stored.id)) continue;
      const orphaned = stored.status === 'running' || stored.status === 'queued';
      const next: AgentRun = orphaned
        ? {
            ...stored,
            status: 'failed',
            failure: 'interrupted by a Sprout restart before this run finished',
            failureClass: 'restart',
            result: {
              status: 'failed',
              message: 'interrupted by a Sprout restart before this run finished',
            },
            completedAt: this.#clock.now(),
          }
        : stored;
      this.#runs.set(next.id, next);
      if (orphaned) {
        if (stored.leaseId) {
          this.#pool.markRecovering(stored.leaseId);
        }
        await this.#store.save(next);
        recovered.push(await this.settleTaskRun(next));
      } else if (next.taskId !== undefined) {
        // A terminal run can be durable before its Task observer receives the
        // settlement callback. Re-deliver every terminal Task run on restart:
        // TaskService's link and summary writes are idempotent, so this both
        // repairs a missing summary and leaves an already-settled run unchanged.
        await this.settleTaskRun(next);
      }
    }
    return recovered;
  }

  /** The active lease on an environment instance, for observability. */
  activeLease(instanceId: string): ReturnType<EnvironmentPool['activeLease']> {
    return this.#pool.activeLease(instanceId);
  }

  /** Every lease known to the pool, for observability. */
  leases(): ReturnType<EnvironmentPool['leases']> {
    return this.#pool.leases();
  }

  /** Release a lease (e.g. to resolve recovery), making the environment available again. */
  releaseLease(leaseId: string): ReturnType<EnvironmentPool['releaseLease']> {
    if (this.#pool.getLease(leaseId)?.holderKind === 'task') return undefined;
    return this.#pool.releaseLease(leaseId);
  }

  /** Recover a run recorded by a previous process. */
  async load(runId: string): Promise<AgentRun | undefined> {
    const existing = this.#runs.get(runId);
    if (existing) return existing;
    const persisted = await this.#store.get(runId);
    if (persisted) this.#runs.set(persisted.id, persisted);
    return persisted;
  }

  /** Project acknowledged Worker evidence without replaying or rewriting the run outcome. */
  async recordRecoveryEvidence(runId: string, evidence: {
    readonly status: 'completed' | 'failed' | 'interrupted' | 'stopped';
    readonly eventCount: number;
    readonly events: readonly { readonly turnId: string; readonly sequence: number; readonly event: AgentRunEvent }[];
  }): Promise<boolean> {
    const run = await this.load(runId);
    if (run === undefined || run.status === 'running' || run.status === 'queued') return false;
    if (run.recoverySettlement !== undefined && (run.recoverySettlement.status !== evidence.status ||
        run.recoverySettlement.eventCount !== evidence.eventCount)) throw new Error('conflicting recovered settlement');
    const known = new Set((run.recoveredEvents ?? []).map((entry) => `${entry.turnId}\u0000${entry.sequence}`));
    const added = evidence.events.filter((entry) => !known.has(`${entry.turnId}\u0000${entry.sequence}`));
    if (added.length === 0 && run.recoverySettlement !== undefined) return true;
    const next = await this.#advance(run, { recoverySettlement: { status: evidence.status, eventCount: evidence.eventCount },
      recoveredEvents: [...(run.recoveredEvents ?? []), ...added] });
    this.#settled.set(runId, Promise.resolve(next));
    return true;
  }

  /** Observe status and progress changes for every run. */
  subscribe(observer: RunObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  /** Await a run's terminal state. */
  async waitFor(runId: string): Promise<AgentRun> {
    const settled = this.#settled.get(runId);
    if (settled) return settled;
    const recovered = await this.load(runId);
    if (recovered) return recovered;
    throw new Error(`unknown run: ${runId}`);
  }

  /**
   * Stop a running run.
   *
   * Stopping is only meaningful for a live run; a settled run is returned as-is
   * so the Web client never has to guess what "stop" meant for it.
   */
  async stop(runId: string): Promise<AgentRun> {
    return this.#requestStop(runId, 'stopped');
  }

  /** Interrupt a one-round Chat run; its run lease is released before this resolves. */
  async interrupt(runId: string): Promise<AgentRun> {
    return this.#requestStop(runId, 'interrupted');
  }

  async #requestStop(runId: string, outcome: 'stopped' | 'interrupted'): Promise<AgentRun> {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (outcome === 'interrupted' && (run.taskId !== undefined ||
        (run.leaseId !== undefined && this.#pool.getLease(run.leaseId)?.holderKind === 'task'))) {
      throw new Error('Task runs are controlled from Tasks');
    }
    if (run.status !== 'running' && run.status !== 'queued') return run;

    this.#stopRequests.add(runId);
    this.#stopOutcomes.set(runId, outcome);
    const session = this.#sessions.get(runId);
    if (session) {
      // Ask the engine to stop, then close the session. `close` is what
      // guarantees the run settles, so a wedged or already-dead engine cannot
      // leave the user's stop command waiting.
      await this.#interruptRequestedSession(runId, session);
      await session.close();
      this.#sessions.delete(runId);
    }

    // A queued run or a run between admission and session registration observes
    // the durable stop request when its execution reaches the engine boundary.
    return (await this.waitFor(runId)) ?? run;
  }

  async #execute(
    initial: AgentRun,
    agent: AgentDefinition,
    workspace: { readonly projectWorkspaceId?: string; readonly projectWorkspaceKind?: 'default' | 'relative'; readonly projectWorkspacePath?: string; readonly taskBootstrapInstructions?: string } = {},
  ): Promise<AgentRun> {
    if (this.#stopRequests.has(initial.id)) {
      return this.#finish(initial, 'interrupted', { status: 'interrupted' });
    }
    // The run executes under the option it was admitted with (#90): the
    // engine, work model, and effort recorded before any engine accepted the
    // work. This is deliberately not re-derived here — re-deriving could move
    // the run to another option after acceptance, which ADR-0008 forbids.
    const option = initial.workOption ?? effectiveWorkOptions(agent)[0]!;
    // Adapters are resolved *for the instance this run resolved and will lease*,
    // never from a global pool: a run that leases container-1 must execute on
    // container-1's worker, or the run record would name a machine it never used.
    let engines: ReadonlyMap<string, EngineAdapter>;
    try {
      engines =
        typeof this.#engines === 'function'
          ? await this.#engines(initial.environmentInstanceId)
          : this.#engines;
    } catch (error) {
      // A worker that cannot be started is a run failure with a reason, not a
      // rejected promise the caller has to interpret.
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const adapter = engines.get(option.engine);
    if (!adapter) {
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message: `no engine adapter registered for: ${option.engine}`,
      });
    }
    const nestedTaskLease = initial.taskId !== undefined && initial.leaseId !== undefined;
    if (nestedTaskLease) {
      const lease = this.#pool.getLease(initial.leaseId!);
      if (!lease || lease.state !== 'active' || lease.holderKind !== 'task' || lease.taskId !== initial.taskId || lease.instanceId !== initial.environmentInstanceId) {
        return this.#finish(initial, 'failed', { status: 'failed', message: `task lease is not active for run ${initial.id}` }, 'admission');
      }
    }
    let acquired: ReturnType<EnvironmentPool['acquireLease']> | undefined;
    try {
      acquired = nestedTaskLease ? undefined : await this.#pool.acquireLeaseRevalidated({
        instanceId: initial.environmentInstanceId,
        capability: agent.capability,
        holderId: agent.id,
        runId: initial.id,
        ttlMs: this.#leaseTtlMs,
      });
    } catch {
      // Failed durable holder reconciliation is still an Environment admission
      // failure. Never leave a queued run or expose storage/Worker diagnostics.
      return this.#finish(initial, 'failed', {
        status: 'failed', message: 'environment recovery could not be recorded',
      }, 'environment');
    }
    if (acquired !== undefined && !acquired.ok) {
      const instanceId = initial.environmentInstanceId;
      const busyMessage =
        acquired.state === 'recovering'
          ? `environment busy: ${instanceId} is in recovery (held by ${acquired.heldBy ?? 'another run'})`
          : `environment busy: ${instanceId} is leased by ${acquired.heldBy ?? 'another run'}`;
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message:
          acquired.reason === 'conflict'
            ? busyMessage
            : `environment unavailable: ${acquired.reason}`,
      }, 'environment');
    }

    const running = await this.#advance(initial, { status: 'running', ...(acquired !== undefined && acquired.ok ? { leaseId: acquired.lease.id } : {}) });
    let prepared = running;

    try {
      // Assemble what this run is presented with, before the session starts: the
      // project contract (standing instructions, on every run) and, when the run
      // moved to a different environment instance than the agent's previous run, a
      // fact-form hand-off. Both are deterministic functions of persisted facts.
      // Keep all setup inside the lease guard so a rejected assembly is persisted
      // as a terminal failure and cannot leave the acquired lease active.
      // A bound Project workspace is the run's continuation slot. The workspace
      // identity here must include the Worker-root-relative location: ADR-0004
      // scopes a native session to its working directory, and ADR-0008 requires a
      // workspace change to start a new native session slot rather than continue
      // the session that belonged to the old directory. A Worker-managed default
      // carries no location, so the Project identity alone is its slot.
      const workingDirectory = workspace.projectWorkspaceId === undefined
        ? resolveWorkingDirectory(this.#pool, initial.environmentInstanceId, agent)
        : workspace.projectWorkspacePath === undefined
          ? `project-workspace:${workspace.projectWorkspaceId}`
          : `project-workspace:${workspace.projectWorkspaceId}:${workspace.projectWorkspacePath}`;
      const assembled = await this.#assembleInput(initial, agent, running.id);
      // Do not persist and notify an unchanged observable run state. Replay
      // cursors use durable write positions as forward boundaries, so a no-op
      // state must not move an already-issued boundary past another run.
      if (assembled.handOff !== undefined) {
        prepared = await this.#advance(running, { handOff: assembled.handOff });
      }

      // The continuation slot includes Agent, engine, immutable placement and
      // host profile, work Environment, actual working directory, and the
      // authorized Conversation, Routing batch, or Task scope. Without an
      // authorized scope the run receives no stored key. Resolve it inside the
      // lease guard: an absent instance directory and agent fallback is an explicit failed run, not a
      // rejected promise that leaks a lease.
      const placement = initial.executionPlacement;
      const scope: SessionKeyScope | undefined = initial.taskId !== undefined
        ? { kind: 'task', id: initial.taskId }
        : initial.sessionKeyScope;
      const identity: SessionKeyIdentity | undefined = placement !== undefined &&
        isEngineHostedPlacement(placement) && scope !== undefined
        ? {
            agentId: agent.id,
            engine: option.engine,
            environmentInstanceId: initial.environmentInstanceId,
            executionPlacement: placement,
            scope,
            workingDirectory,
          }
        : undefined;
      const stored = this.#sessionKeys && identity !== undefined
        ? await this.#sessionKeys.get(identity)
        : undefined;
      let attempt = await this.#runSession(
        adapter,
        agent,
        option,
        assembled.prompt,
        prepared,
        stored?.key,
        appendBootstrap(assembled.instructions, workspace.taskBootstrapInstructions),
        workingDirectory,
        workspace.projectWorkspaceId,
        workspace.projectWorkspaceKind,
        workspace.projectWorkspacePath,
      );

      // A stored key the engine refuses must not fail the run. Pi and `agy`
      // soft-fall-back themselves (#19), but Codex and `opencode` hard-fail on a
      // stale key, so the orchestrator degrades for them: forget the refused key
      // and retry once from a fresh session. The `resumeRefused` gate is the
      // important part — it is set only when the engine *explicitly* refused the
      // supplied key and did no work. An initialization failure, a missing
      // binary, an authentication failure, or a valid resume whose first turn
      // fails before emitting events is a plain failure: retrying it fresh would
      // hide a real engine problem and would discard a key that may still be
      // good, so it is reported instead.
      if (stored !== undefined && !attempt.ok && attempt.resumeRefused) {
        if (this.#sessionKeys && identity !== undefined) await this.#sessionKeys.delete(identity);
        attempt = await this.#runSession(
          adapter,
          agent,
          option,
          assembled.prompt,
          prepared,
          undefined,
          appendBootstrap(assembled.instructions, workspace.taskBootstrapInstructions),
          workingDirectory,
          workspace.projectWorkspaceId,
          workspace.projectWorkspaceKind,
          workspace.projectWorkspacePath,
        );
      }

      // Retry only a classified upstream failure that produced no run events.
      // Repeating after visible tool or assistant progress could duplicate work.
      let retryableFailure: Extract<EngineTurnResult, { status: 'failed' }> | undefined;
      let attemptNumber = 1;
      while (!attempt.ok && attempt.result?.retryable === true && attempt.progressEventCount === 0 &&
          attemptNumber < ENGINE_RETRY_MAX_ATTEMPTS && !this.#stopRequests.has(running.id)) {
        retryableFailure ??= attempt.result;
        const nextAttempt = attemptNumber + 1;
        const notice: AgentRunEvent = {
          type: 'notice',
          text: `Engine request failed temporarily; retrying (attempt ${nextAttempt} of ${ENGINE_RETRY_MAX_ATTEMPTS}).`,
        };
        prepared = await this.#advance(attempt.run, { events: [...attempt.run.events, notice] });
        await this.#retryBackoff(attemptNumber);
        if (this.#stopRequests.has(running.id)) {
          return this.#finish(prepared, 'stopped', { status: 'interrupted' });
        }
        attempt = await this.#runSession(
          adapter,
          agent,
          option,
          assembled.prompt,
          prepared,
          stored?.key,
          appendBootstrap(assembled.instructions, workspace.taskBootstrapInstructions),
          workingDirectory,
          workspace.projectWorkspaceId,
          workspace.projectWorkspaceKind,
          workspace.projectWorkspacePath,
        );
        attemptNumber = nextAttempt;
      }

      if (!attempt.ok) {
        const exhausted = retryableFailure !== undefined && attempt.result?.retryable === true &&
          attempt.progressEventCount === 0 && attemptNumber === ENGINE_RETRY_MAX_ATTEMPTS;
        let result: Extract<EngineTurnResult, { status: 'failed' }> | undefined;
        if (attempt.result !== undefined) {
          const { retryable: retryMarker, ...boundedResult } = attempt.result;
          void retryMarker;
          // The retry marker is internal attempt metadata, not durable run output.
          result = exhausted
            ? { ...boundedResult, message: retryableFailure!.message }
            : boundedResult;
        }
        return this.#finish(attempt.run, 'failed', result ?? {
          status: 'failed',
          message: attempt.message,
        });
      }

      // Persist the key the run actually used, not the one it was handed. A
      // run that degraded to a fresh session stores the fresh key, so the next
      // run continues *that* session rather than re-offering the refused one.
      if (this.#sessionKeys && identity !== undefined && attempt.result.status === 'completed') {
        const key = attempt.engineSessionKey;
        if (key !== undefined && key !== '') {
          await this.#sessionKeys.save({ ...identity, key, updatedAt: this.#clock.now() });
        }
      }
      return await this.#settleWithResult(attempt.run, attempt.result);
    } catch (error) {
      return this.#finish(prepared, 'failed', {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (acquired !== undefined && acquired.ok) this.#pool.releaseLease(acquired.lease.id);
    }
  }

  /**
   * One attempt at a run's engine session.
   *
   * Owns the session's lifetime and event streaming, but not the lease or the
   * run's terminal state: the caller decides whether to retry a resume-key
   * refusal before settling the run. `resumeRefused` exists so that decision is
   * based on the engine's own classification of the failure, not on parsing
   * engine messages or on the bare fact that no event was emitted. It is true
   * for a refused session start and for an engine that reports a refused resume
   * through its turn result; a session that starts and then fails for any other
   * reason is not a refusal.
   */
  async #runSession(
    adapter: EngineAdapter,
    agent: AgentDefinition,
    option: AgentWorkOption,
    prompt: string,
    running: AgentRun,
    resumeKey: string | undefined,
    instructions: string | undefined,
    workingDirectory: string,
    projectWorkspaceId: string | undefined,
    projectWorkspaceKind: 'default' | 'relative' | undefined,
    projectWorkspacePath: string | undefined,
    remoteWorkspace?: import('../engine/port.ts').RemoteWorkspaceTools,
    remoteProjectMcp?: import('../engine/port.ts').RemoteProjectMcpTools,
    beforePrompt?: () => void | Promise<void>,
  ): Promise<SessionAttempt> {
    let session: EngineSession;
    try {
      session = await adapter.startSession({
        agentId: agent.id,
        runId: running.id,
        ...(remoteWorkspace !== undefined ? { remoteWorkspace } : {}),
        ...(remoteProjectMcp !== undefined ? { remoteProjectMcp } : {}),
        ...(this.#taskGroupPosts !== undefined && running.projectId !== undefined && running.taskId !== undefined ? {
          postTaskGroupMessage: async (input: import('../engine/port.ts').AgentTaskGroupMessageInput) => {
            const assertActive = () => {
              if (this.#runs.get(running.id)?.status !== 'running' || this.#stopRequests.has(running.id)) throw new Error('Agent message capability is no longer active');
            };
            assertActive();
            return this.#taskGroupPosts!(running, assertActive)(input);
          },
        } : {}),
        workingDirectory,
        ...(option.workModel !== '' ? { model: option.workModel } : {}),
        ...(option.effort !== '' ? { effort: option.effort } : {}),
        // The assembled project contract is re-sent on every run, because it is
        // the standing agreement the agent works under and must not depend on a
        // prior session having carried it (O5).
        ...(instructions !== undefined ? { instructions } : {}),
        ...(projectWorkspaceId !== undefined ? { projectWorkspaceId } : {}),
        ...(projectWorkspaceKind !== undefined ? { projectWorkspaceKind } : {}),
        ...(projectWorkspacePath !== undefined ? { projectWorkspacePath } : {}),
        ...(resumeKey !== undefined ? { resumeSessionKey: resumeKey } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        run: running,
        message: error instanceof Error ? error.message : String(error),
        progressEventCount: 0,
        // Only the engine's explicit refusal of the supplied key is retryable.
        // Any other start failure is a real failure and must not discard a key.
        resumeRefused: resumeKey !== undefined && error instanceof EngineResumeRefusedError,
      };
    }

    this.#sessions.set(running.id, session);
    let current = running;
    try {
      await beforePrompt?.();
      current = this.#runs.get(running.id) ?? current;
      const turn = session.run(prompt);
      if (this.#stopRequests.has(running.id)) await this.#interruptRequestedSession(running.id, session);
      // The events iterator throws when a turn fails, so the *authoritative*
      // outcome is read from `completion` afterwards. Reading it there is what
      // lets a turn-level refusal (opencode exits 1 on a stale `--session`) be
      // told apart from any other turn failure.
      let streamError: unknown;
      try {
        for await (const event of turn.events) {
          current = await this.#advance(current, {
            events: [...current.events, event],
          });
        }
      } catch (error) {
        streamError = error;
      }
      const result = await turn.completion;
      if (result.status === 'failed') {
        // A turn-level failure is an attempt failure, not a completed run. It is
        // retryable only when the engine classified it as a refused resume;
        // every other failure (provider error, bad authentication, a crash) is
        // reported as-is so the stored key survives untouched.
        return {
          ok: false,
          run: current,
          message: result.message,
          result,
          progressEventCount: current.events.length - running.events.length,
          resumeRefused: result.resumeRefused === true,
        };
      }
      if (streamError !== undefined) {
        // The stream failed without the turn reporting failure. That is not a
        // refusal, and it must not be retried fresh.
        return {
          ok: false,
          run: current,
          message: streamError instanceof Error ? streamError.message : String(streamError),
          progressEventCount: current.events.length - running.events.length,
          resumeRefused: false,
        };
      }
      return { ok: true, run: current, result, engineSessionKey: session.engineSessionKey };
    } catch (error) {
      return {
        ok: false,
        run: current,
        message: error instanceof Error ? error.message : String(error),
        progressEventCount: current.events.length - running.events.length,
        // A thrown error is never a resume refusal: the engine had a working
        // session and failed while doing the work (or reading its result).
        resumeRefused: false,
      };
    } finally {
      this.#sessions.delete(running.id);
      await session.close();
    }
  }

  /**
   * Assemble what one run is presented with: the project contract and, on an
   * environment change, a fact-form hand-off.
   *
   * Both halves are deterministic and read only persisted facts. The contract is
   * assembled from the project the run resolved into, plus the agent's own
   * configuration. The hand-off is derived from the agent's own prior runs and is
   * attached only when this run's environment instance differs from the previous
   * run's. When the instance matches, the run is the continued-session case
   * (ADR-0004), so no hand-off is added and the prompt is the user's alone.
   */
  async #assembleInput(
    run: AgentRun,
    agent: AgentDefinition,
    currentRunId: string,
  ): Promise<{ prompt: string; instructions: string | undefined; handOff: AgentRun['handOff'] }> {
    const project = run.projectId !== undefined ? this.#projects?.get(run.projectId) : undefined;
    const contract =
      project !== undefined
        ? renderProjectContract(
            assembleProjectContract({
              project,
              agentId: agent.id,
              ...(agent.instructions !== undefined
                ? { agentInstructions: agent.instructions }
                : {}),
            }),
          )
        : // No project means the run could not have resolved an environment, so
          // this is unreachable in practice; falling back to the agent's own
          // instructions keeps the agent's standing configuration intact.
          agent.instructions;

    const handOff = buildHandOffContext(await this.#runHistory(), {
      agentId: agent.id,
      currentRunId,
      currentCreatedAt: run.createdAt,
      ...(run.projectId !== undefined ? { projectId: run.projectId } : {}),
      currentEnvironmentInstanceId: run.workspaceBinding?.environmentInstanceId ?? run.environmentInstanceId,
      currentExecutionMode: run.executionMode ?? 'environment-hosted',
      ...(run.engineHostProfileId !== undefined ? { currentEngineHostProfileId: run.engineHostProfileId } : {}),
      ...(run.workspaceBinding !== undefined ? { currentWorkspaceBinding: run.workspaceBinding } : {}),
    });
    // ADR-0004: a session key is scoped to one (agent, engine, instance,
    // directory), so a stored key only exists for the same environment instance.
    // An environment change therefore means the run is on its fresh-session path,
    // and a hand-off is exactly what closes the resulting gap.
    const attach =
      handOff !== undefined &&
      shouldAttachHandOff({
        previousEnvironmentInstanceId: handOff.previousEnvironmentInstanceId,
        currentEnvironmentInstanceId: run.environmentInstanceId,
        previousExecutionMode: handOff.previousExecutionMode ?? 'environment-hosted',
        currentExecutionMode: run.executionMode ?? 'environment-hosted',
        ...(handOff.previousEngineHostProfileId !== undefined ? { previousEngineHostProfileId: handOff.previousEngineHostProfileId } : {}),
        ...(run.engineHostProfileId !== undefined ? { currentEngineHostProfileId: run.engineHostProfileId } : {}),
        ...(handOff.previousWorkspaceBinding !== undefined ? { previousWorkspaceBinding: handOff.previousWorkspaceBinding } : {}),
        ...(run.workspaceBinding !== undefined ? { currentWorkspaceBinding: run.workspaceBinding } : {}),
      });

    return {
      prompt: attach ? renderHandOffPrompt(handOff, run.prompt) : run.prompt,
      instructions: contract,
      handOff: attach ? handOff : undefined,
    };
  }

  async #settleWithResult(run: AgentRun, result: EngineTurnResult): Promise<AgentRun> {
    switch (result.status) {
      case 'completed':
        return this.#finish(run, 'completed', result);
      case 'interrupted':
        return this.#finish(run, 'interrupted', result);
      case 'failed':
        return this.#finish(run, 'failed', result);
    }
  }

  async #interruptRequestedSession(runId: string, session: EngineSession): Promise<void> {
    if (this.#stopInterruptSent.has(runId)) return;
    this.#stopInterruptSent.add(runId);
    await session.interrupt();
  }

  async #finish(
    run: AgentRun,
    status: AgentRunStatus,
    result: EngineTurnResult,
    failureClass: RunFailureClass = 'execution',
  ): Promise<AgentRun> {
    const stopWins = this.#stopRequests.has(run.id) && status !== 'completed';
    const finalStatus = stopWins ? this.#stopOutcomes.get(run.id) ?? 'stopped' : status;
    const finalResult: EngineTurnResult = stopWins ? { status: 'interrupted' } : result;
    const settled = await this.#advance(run, {
      status: finalStatus,
      result: finalResult,
      ...(stopWins && finalStatus === 'interrupted' ? { interruptionReason: 'human-stop' as const } : {}),
      ...(finalResult.tokenUsage !== undefined ? { tokenUsage: finalResult.tokenUsage } : {}),
      ...(finalResult.detailedTokens !== undefined ? { detailedTokens: finalResult.detailedTokens } : {}),
      completedAt: this.#clock.now(),
      ...(finalResult.status === 'failed' ? { failure: finalResult.message, failureClass } : {}),
    });
    this.#stopRequests.delete(run.id);
    this.#stopOutcomes.delete(run.id);
    this.#stopInterruptSent.delete(run.id);
    return settled;
  }

  /** Record a new run state, persist it, and notify observers in that order. */
  async #advance(run: AgentRun, patch: Partial<AgentRun>): Promise<AgentRun> {
    // A late in-flight run write may race machine recovery projection after a
    // channel loss. Never erase durable, idempotently keyed Worker evidence by
    // advancing an older snapshot captured before that projection.
    const observed = this.#runs.get(run.id);
    const next: AgentRun = { ...run, ...patch,
      ...(patch.recoverySettlement === undefined && observed?.recoverySettlement !== undefined
        ? { recoverySettlement: observed.recoverySettlement } : {}),
      ...(patch.recoveredEvents === undefined && observed?.recoveredEvents !== undefined
        ? { recoveredEvents: observed.recoveredEvents } : {}),
    };
    this.#runs.set(next.id, next);
    const replaySequence = await this.#store.save(next);
    for (const observer of this.#observers) observer(next, replaySequence);
    return next;
  }
}

function sameActivationScope(
  left: SessionKeyScope | undefined,
  right: SessionKeyScope | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.kind === right.kind && left.id === right.id;
}

function bindingGenerationScope(run: AgentRun): string {
  return JSON.stringify([
    run.agentId,
    run.projectId ?? '',
    run.sessionKeyScope?.kind ?? 'standalone',
    run.sessionKeyScope?.id ?? '',
  ]);
}

/** Session keys are partitioned by Project and the exact workspace grant. */
function sessionWorkingDirectoryForBinding(
  projectId: string | undefined,
  workingDirectory: string,
  binding: RunWorkspaceBinding | undefined,
): string {
  return JSON.stringify([
    projectId ?? '',
    workingDirectory,
    binding?.environmentInstanceId ?? '',
    binding?.bindingId ?? '',
    binding?.generation ?? 0,
    binding?.catalogIdentity ?? '',
  ]);
}

/**
 * The directory a run executes in, inside the instance it actually uses.
 *
 * A path is a fact about the environment (ADR-0003): the same agent needs
 * `/sprout` inside a container and a host path on macOS. The resolved instance is
 * therefore authoritative, and the agent's value is only a fallback for an
 * environment that cannot state its own directory (F1 suggestion, #18).
 */
function resolveWorkingDirectory(
  pool: Pick<EnvironmentPool, 'instance'>,
  instanceId: string,
  agent: AgentDefinition,
): string {
  const fromInstance = pool.instance(instanceId)?.workingDirectory;
  if (fromInstance !== undefined) return fromInstance;
  if (agent.workingDirectory !== undefined) return agent.workingDirectory;
  throw new Error(
    `no working directory for environment instance ${instanceId} and agent ${agent.id}`,
  );
}

/** Task bootstrap is deterministic Worker-owned-file guidance, not prompt text. */
function appendBootstrap(instructions: string | undefined, bootstrap: string | undefined): string | undefined {
  if (bootstrap === undefined || bootstrap === '') return instructions;
  return instructions === undefined || instructions === ''
    ? bootstrap
    : `${instructions}\n\n${bootstrap}`;
}

/**
 * Normalize a binding received from an authority-facing port before it becomes
 * an AgentRun fact or a Worker request. Durable records can predate the path
 * invariant, so an unsafe relative location invalidates the whole binding
 * rather than being silently reinterpreted as a Worker default.
 */
function sanitizeRunWorkspaceBinding(
  binding: RunWorkspaceBinding | undefined,
): RunWorkspaceBinding | undefined {
  if (binding === undefined) return undefined;
  const operations = (binding.operations ?? []).filter((operation) =>
    ['read', 'search', 'edit', 'patch', 'command'].includes(operation));
  const projectMcpTools = (binding.projectMcpTools ?? []).filter((name) =>
    /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name));
  const common = {
    ...(binding.environmentInstanceId !== undefined
      ? { environmentInstanceId: sanitizeIdentifier(binding.environmentInstanceId, { fallback: 'unknown-environment', kind: 'generic' }) }
      : {}),
    ...(binding.bindingId !== undefined
      ? { bindingId: sanitizeIdentifier(binding.bindingId, { fallback: 'unknown-binding', kind: 'generic' }) }
      : {}),
    ...(Number.isSafeInteger(binding.generation) && binding.generation! > 0 ? { generation: binding.generation } : {}),
    ...(Number.isSafeInteger(binding.catalogGeneration) && binding.catalogGeneration! > 0 ? { catalogGeneration: binding.catalogGeneration } : {}),
    ...(typeof binding.catalogIdentity === 'string' && /^[A-Fa-f0-9]{64}$/.test(binding.catalogIdentity)
      ? { catalogIdentity: binding.catalogIdentity.toLowerCase() } : {}),
    ...(binding.workspaceId !== undefined
      ? { workspaceId: sanitizeIdentifier(binding.workspaceId, { fallback: 'unknown-workspace', kind: 'digest' }) }
      : {}),
    ...(operations.length > 0 ? { operations: [...new Set(operations)] } : {}),
    ...(projectMcpTools.length > 0 ? { projectMcpTools: [...new Set(projectMcpTools)] } : {}),
  };
  if (binding.kind === 'relative') {
    const path = sanitizeWorkspacePath(binding.path);
    if (path === undefined) return undefined;
    return { ...common, kind: 'relative', path };
  }
  if (binding.kind === 'default' && binding.path === undefined) return { ...common, kind: 'default' };
  return undefined;
}
