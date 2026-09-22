/**
 * The Web wire contract and view projections.
 *
 * This Module is the single ownership boundary between the domain and the Web
 * transport. It defines the client-facing wire types (`RunView`, `TaskView`, …)
 * and the pure projections that produce them from domain records. The transport
 * (`api.ts`) imports these; it never re-declares a wire shape and never reaches
 * into a domain record to build a response body field by field.
 *
 * Two rules keep the boundary honest:
 *
 * - Projections are pure functions over domain records. They hold no `node:http`
 *   dependency, open no connection, and read no environment fact, so a later M2
 *   router or a browser adapter can consume the same contract.
 * - Privacy is enforced here, at the projection boundary (M2 testing decision
 *   32): a view exposes only what the client needs, so lease ids, engine
 *   internals, adapter details, and raw run events have no path into a payload.
 *
 * Adding a field is an additive wire-contract change owned by this Module.
 * Changing an existing field's presence or meaning is a product decision, not a
 * cleanup.
 */

import type { Message, WakeRequest } from '../collaboration/model.ts';
import type { AgentRun, TokenUsage } from '../run/model.ts';
import type { Agent } from '../agent/model.ts';
import type { Task, TaskRunLink, TaskWithRuns } from '../task/model.ts';
import { normalizeEnrollment, type EnvironmentEnrollment } from '../environment/enrollment.ts';
import type { EnvironmentRecoveryRecord, ForceReleaseRecord } from '../environment/recovery.ts';
import {
  sanitizeIdentifier,
  sanitizeOperatorText,
  sanitizeProtocolVersion,
  DEFAULT_COMPATIBILITY_DETAIL,
  DEFAULT_DECISION_REASON,
  DEFAULT_FORCE_RELEASE_REASON,
  DEFAULT_PROBE_SUMMARY,
  DEFAULT_READINESS_SUMMARY,
  DEFAULT_RECOVERY_REASON,
} from '../environment/privacy.ts';
import type { EnvironmentReadiness, EnvironmentReadinessSummary } from '../environment/readiness.ts';
import type { ProjectAuthority } from '../project/authority-model.ts';
import {
  sanitizeWorkspacePath,
  type ProjectEnvironmentAccess,
  type WorkspaceBinding,
} from '../project/access.ts';

/** Bound and redact one free-text Project field for the wire. */
function sanitizeProjectText(value: string): string {
  const text = sanitizeOperatorText(value, { fallback: '', maxLength: 4_000 });
  return text === '' ? '' : text;
}

/**
 * The client-facing shape of a run.
 *
 * Status, progress, and the terminal result only: lease ids, engine internals,
 * and adapter details stay inside the server, so the Web client cannot come to
 * depend on them.
 */
export interface RunView {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly status: string;
  readonly events: readonly { readonly type: string; readonly [key: string]: unknown }[];
  /**
   * The durable Task this run advances, when it is a Task run (#28).
   *
   * Absent for a one-round run. Exposing the link lets a client place a run in
   * its Task without giving the client any Task domain logic.
   */
  readonly taskId?: string;
  /**
   * Whether a cross-environment hand-off was attached to this run's input.
   *
   * A boolean rather than the text: the fact is useful to the client (so it can
   * see that context was re-presented after a move), while the summary itself and
   * the environment identity stay server-side like the other run internals.
   */
  readonly handOffAttached: boolean;
  /**
   * The work option this run was admitted under (#90), when the durable record
   * carries one: the engine, work model, effort, and Agent configuration
   * version the run actually used. Absent on a pre-#90 run, which is reported
   * as unspecified rather than invented.
   */
  readonly workOption?: RunWorkOptionAttributionView;
  /**
   * The Project workspace binding this run was admitted under (#93), when the
   * durable record carries one: the opaque workspace identity and, for a
   * relative binding, the Worker-root-relative location. Absent on a pre-#93
   * run or a run with no Project access, reported as unspecified.
   */
  readonly workspaceBinding?: RunWorkspaceBindingAttributionView;
  readonly failure?: string;
  readonly result?: unknown;
  readonly tokenUsage?: TokenUsage;
  readonly createdAt: number;
  readonly completedAt?: number;
}

/** Cumulative, observable consumption across the returned durable history. */
export interface RunHistoryTotals {
  /** Sum of terminal run elapsed time; active runs are not estimated. */
  readonly durationMs: number;
  readonly tokenUsage: TokenUsage;
  readonly completedRunCount: number;
  /** Runs whose provider supplied usage, so an absent metric is never hidden. */
  readonly runsWithTokenUsage: number;
}

export function summarizeRunHistory(runs: readonly RunView[]): RunHistoryTotals {
  let durationMs = 0;
  let completedRunCount = 0;
  let runsWithTokenUsage = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const run of runs) {
    if (run.completedAt !== undefined) {
      completedRunCount += 1;
      durationMs += Math.max(0, run.completedAt - run.createdAt);
    }
    if (run.tokenUsage !== undefined) {
      runsWithTokenUsage += 1;
      promptTokens += run.tokenUsage.promptTokens;
      completionTokens += run.tokenUsage.completionTokens;
      totalTokens += run.tokenUsage.totalTokens;
    }
  }
  return {
    durationMs,
    tokenUsage: { promptTokens, completionTokens, totalTokens },
    completedRunCount,
    runsWithTokenUsage,
  };
}

export function toRunView(run: AgentRun): RunView {
  const workspaceBinding = toRunWorkspaceBindingAttribution(run);
  return {
    id: run.id,
    agentId: run.agentId,
    prompt: run.prompt,
    status: run.status,
    events: run.events,
    ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
    handOffAttached: run.handOff !== undefined,
    ...(toRunWorkOptionAttribution(run) !== undefined ? { workOption: toRunWorkOptionAttribution(run)! } : {}),
    ...(workspaceBinding !== undefined ? { workspaceBinding } : {}),
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(run.tokenUsage !== undefined ? { tokenUsage: run.tokenUsage } : {}),
    createdAt: run.createdAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
  };
}

/**
 * The client-facing shape of one Message.
 *
 * The conversation unit only: author, body, reply link, and ordering. A reply's
 * body is already the run's final assistant text, so tool calls, tool output, and
 * raw reasoning have no path into this view — they were never stored as a
 * Message in the first place.
 */
export interface MessageView {
  readonly id: string;
  readonly projectId: string;
  readonly channel: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

export function toMessageView(message: Message): MessageView {
  return {
    id: message.id,
    projectId: message.projectId,
    channel: message.channel,
    authorId: message.author.id,
    authorKind: message.author.kind,
    body: message.body,
    recipients: message.recipients,
    ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
    createdAt: message.createdAt,
  };
}

/**
 * The client-facing shape of one wake request (#27).
 *
 * Every field the operator needs to answer "did this Message start a run, and
 * why?": the target Agent, the deterministic or modelled reason, the durable
 * status, and the linked run when one was admitted. Run internals stay out, so
 * the client still cannot depend on leases or engines.
 */
export interface WakeView {
  readonly agentId: string;
  readonly reason: string;
  readonly status: string;
  readonly runId?: string;
}

export function toWakeView(wake: WakeRequest): WakeView {
  return {
    agentId: wake.agentId,
    reason: wake.reason,
    status: wake.status,
    ...(wake.runId !== undefined ? { runId: wake.runId } : {}),
  };
}

/**
 * The client-facing shape of one project the composer may address (#27).
 *
 * The member ids are what the composer offers as `@agent` mentions and direct
 * recipients; nothing else about the project (environment access, rules) is
 * needed to write a Message.
 */
export interface ProjectView {
  readonly id: string;
  readonly goal: string;
  readonly memberIds: readonly string[];
}

export function toProjectView(project: {
  readonly id: string;
  readonly goal: string;
  readonly memberships: readonly { readonly agentId: string }[];
}): ProjectView {
  return {
    id: project.id,
    goal: project.goal,
    memberIds: project.memberships.map((membership) => membership.agentId),
  };
}

/**
 * The client-facing shape of one durable Task (#28).
 *
 * The whole Task record is safe to expose: it holds no lease, engine, or worker
 * detail. `environmentPreference` is included so a human can see which environment
 * was requested, and the run links (below) show what the Task actually did.
 */
export interface TaskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly status: string;
  readonly assignedAgentId?: string;
  readonly environmentPreference?: { readonly kind: string; readonly id: string };
  readonly blockerReason?: string;
  readonly environmentInstanceId?: string;
  readonly environmentLeaseId?: string;
  readonly environmentLifecycleState?: string;
  /** A safe, operator-facing projection of the Worker-owned Task context. */
  readonly taskContextState: string;
  readonly recoveryState?: string;
  readonly activeRunId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export function toTaskView(task: Task): TaskView {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    goal: task.goal,
    constraints: task.constraints,
    status: task.status,
    ...(task.assignedAgentId !== undefined ? { assignedAgentId: task.assignedAgentId } : {}),
    ...(task.environmentPreference !== undefined
      ? { environmentPreference: task.environmentPreference }
      : {}),
    ...(task.blockerReason !== undefined ? { blockerReason: task.blockerReason } : {}),
    ...(task.environmentInstanceId !== undefined ? { environmentInstanceId: task.environmentInstanceId } : {}),
    ...(task.environmentLeaseId !== undefined ? { environmentLeaseId: task.environmentLeaseId } : {}),
    ...(task.environmentLifecycleState !== undefined ? { environmentLifecycleState: task.environmentLifecycleState } : {}),
    taskContextState: toTaskContextState(task),
    ...(task.recoveryState !== undefined ? { recoveryState: task.recoveryState } : {}),
    ...(task.activeRunId !== undefined ? { activeRunId: task.activeRunId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
  };
}

/**
 * The Worker owns the filesystem facts; this is only the lifecycle projection
 * a human needs to decide whether cleanup is pending, retryable, or complete.
 */
export function toTaskContextState(task: Task): string {
  switch (task.environmentLifecycleState) {
    case undefined: return 'not-created';
    case 'beginning': return 'preparing';
    case 'idle':
    case 'running':
    case 'blocked':
    case 'awaiting-validation': return 'ready';
    case 'ending': return 'cleanup-in-progress';
    case 'recovery': return task.recoveryState === 'ending' ? 'cleanup-needs-recovery' : 'recovery-retained';
    case 'ended':
    case 'discarded': return 'recycled';
    default: return 'unknown';
  }
}

/** One Task plus its ordered run links, for `GET /api/tasks/:id`. */
export interface TaskWithRunsView {
  readonly task: TaskView;
  readonly runs: readonly TaskRunLinkView[];
}

/** One linked run. `summary` is absent until the run settles. */
export interface TaskRunLinkView {
  readonly runId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly linkedAt: number;
  readonly summary?: {
    readonly status: string;
    readonly summary: string;
    readonly recordedAt: number;
  };
}

export function toTaskWithRunsView(found: TaskWithRuns): TaskWithRunsView {
  return { task: toTaskView(found.task), runs: found.runs.map(toTaskRunLinkView) };
}

export function toTaskRunLinkView(link: TaskRunLink): TaskRunLinkView {
  return {
    runId: link.runId,
    agentId: link.agentId,
    sequence: link.sequence,
    linkedAt: link.linkedAt,
    ...(link.summary !== undefined
      ? {
          summary: {
            status: link.summary.status,
            summary: link.summary.summary,
            recordedAt: link.summary.recordedAt,
          },
        }
      : {}),
  };
}

/**
 * The client-facing shape of one Environment enrollment (#87).
 *
 * Only portable facts: the opaque Worker identity digest, platform, declared
 * protocol version, and neutral engine facts. No private key, engine credential,
 * hostname, address, topology, or absolute path has a field in this projection.
 */
export interface EnrollmentView {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly displayName: string;
  readonly status: string;
  readonly platform: string;
  readonly identityDigest: string;
  readonly protocolVersion?: string;
  readonly capabilityPermissions: Readonly<Record<string, boolean>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decisions: readonly EnrollmentDecisionView[];
}

export interface EnrollmentDecisionView {
  readonly kind: string;
  readonly actor: string;
  readonly at: number;
  readonly reason: string;
}

export function toEnrollmentView(enrollment: EnvironmentEnrollment): EnrollmentView {
  // The view is the last boundary before the wire. Normalizing here as well as
  // in the store read means a caller that hands a projection a raw durable
  // document (a repair tool, a test, a future adapter) still cannot leak an
  // unsanitized display name or decision reason to a browser.
  const safe = normalizeEnrollment(enrollment);
  return {
    id: safe.id,
    environmentInstanceId: safe.environmentInstanceId,
    displayName: safe.displayName,
    status: safe.status,
    platform: safe.worker.platform,
    identityDigest: safe.worker.identityDigest,
    ...(safe.worker.protocolVersion !== undefined
      ? { protocolVersion: safe.worker.protocolVersion }
      : {}),
    capabilityPermissions: safe.capabilityPermissions,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
    decisions: safe.decisions.map((decision) => ({
      kind: decision.kind,
      actor: decision.actor,
      at: decision.at,
      reason: sanitizeOperatorText(decision.reason, { fallback: DEFAULT_DECISION_REASON }),
    })),
  };
}

/** The client-facing shape of one Environment's independent readiness facts. */
export interface EnvironmentReadinessView {
  readonly environmentInstanceId: string;
  readonly summary: { readonly level: string; readonly reason: string };
  readonly enrollmentStatus: string;
  readonly connection: {
    readonly state: string;
    readonly lastConfirmedAt?: number;
  };
  readonly compatibility: {
    readonly state: string;
    readonly workerProtocolVersion?: string;
    readonly detail?: string;
  };
  readonly capabilities: readonly { readonly name: string; readonly permission: string; readonly required: boolean }[];
  readonly engines: readonly {
    readonly engine: string;
    readonly version?: string;
    readonly installed: boolean;
    readonly readiness: string;
    readonly required: boolean;
    readonly models: { readonly state: string; readonly models: readonly string[] };
    readonly authenticated?: boolean;
    readonly authMode?: string;
    readonly authType?: string;
    readonly modelIdPresent?: boolean;
    readonly probedAt?: number;
    readonly probeExitCode?: number;
    readonly source?: string;
  }[];
  readonly probe?: {
    readonly at: number;
    readonly latencyMs: number;
    readonly protocolOk: boolean;
    readonly enginesOk: boolean;
    readonly summary: string;
    readonly source?: 'worker';
    readonly version?: string;
  };
  readonly workSafety: { readonly state: string };
}

/** Safe browser projection of one Worker probe; internal authority ids stay core-side. */
export interface ProbeResultView {
  readonly at: number;
  readonly latencyMs: number;
  readonly protocolOk: boolean;
  readonly enginesOk: boolean;
  readonly summary: string;
  readonly source?: 'worker';
  readonly version?: string;
}

export function toProbeResultView(probe: EnvironmentReadiness['probe']): ProbeResultView | undefined {
  if (probe === undefined) return undefined;
  return {
    at: probe.at,
    latencyMs: probe.latencyMs,
    protocolOk: probe.protocolOk,
    enginesOk: probe.enginesOk,
    summary: sanitizeOperatorText(probe.summary, { fallback: DEFAULT_PROBE_SUMMARY }),
    ...(probe.source !== undefined ? { source: probe.source } : {}),
    ...(probe.version !== undefined
      ? { version: /^(?:\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:, \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)*$/.test(probe.version) ? probe.version : 'unknown-version' }
      : {}),
  };
}

export function toEnvironmentReadinessView(input: {
  readonly environmentInstanceId: string;
  readonly readiness: EnvironmentReadiness;
  readonly summary: EnvironmentReadinessSummary;
}): EnvironmentReadinessView {
  const { readiness, summary } = input;
  // The view is the last boundary before the wire. The service sanitizes the
  // stored facts, but a caller that hands this projection a raw readiness
  // document (a repair tool, a test, a future adapter) still must not leak a
  // legacy hostname, path, address, credential, or protocol string. Engine and
  // capability names are structured enums; models keep their vendor characters;
  // free text passes the operator boundary; an invalid protocol version is
  // dropped rather than echoed. The summary reason is free text too — it can be
  // the compatibility detail, and a legacy document can hold anything — so it
  // passes the same boundary instead of being copied verbatim.
  const protocolVersion = sanitizeProtocolVersion(readiness.compatibility.workerProtocolVersion);
  return {
    environmentInstanceId: input.environmentInstanceId,
    summary: {
      level: summary.level,
      reason: sanitizeOperatorText(summary.reason, { fallback: DEFAULT_READINESS_SUMMARY }),
    },
    enrollmentStatus: readiness.enrollmentStatus,
    connection: {
      state: readiness.connection.state,
      ...(readiness.connection.lastConfirmedAt !== undefined
        ? { lastConfirmedAt: readiness.connection.lastConfirmedAt }
        : {}),
    },
    compatibility: {
      state: readiness.compatibility.state,
      ...(protocolVersion !== undefined ? { workerProtocolVersion: protocolVersion } : {}),
      ...(readiness.compatibility.detail !== undefined
        ? { detail: sanitizeOperatorText(readiness.compatibility.detail, { fallback: DEFAULT_COMPATIBILITY_DETAIL }) }
        : {}),
    },
    capabilities: readiness.capabilities.map((capability) => ({
      name: sanitizeIdentifier(capability.name, { fallback: 'unknown-capability', kind: 'capability' }),
      permission: capability.permission,
      required: capability.required,
    })),
    engines: readiness.engines.map((engine) => ({
      engine: sanitizeIdentifier(engine.engine, { fallback: 'unknown-engine', kind: 'engine' }),
      ...(engine.version !== undefined
        ? { version: /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(engine.version) ? engine.version : 'unknown-version' }
        : {}),
      installed: engine.installed,
      readiness: engine.readiness,
      required: engine.required,
      models: {
        state: engine.models.state,
        models: engine.models.models.map((model) =>
          sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }),
        ),
      },
      ...(engine.authenticated !== undefined ? { authenticated: engine.authenticated } : {}),
      ...(engine.authMode !== undefined ? { authMode: sanitizeIdentifier(engine.authMode, { fallback: 'unknown', kind: 'generic' }) } : {}),
      ...(engine.authType !== undefined ? { authType: sanitizeIdentifier(engine.authType, { fallback: 'unknown', kind: 'generic' }) } : {}),
      ...(engine.modelIdPresent !== undefined ? { modelIdPresent: engine.modelIdPresent } : {}),
      ...(engine.probedAt !== undefined ? { probedAt: engine.probedAt } : {}),
      ...(engine.probeExitCode !== undefined ? { probeExitCode: engine.probeExitCode } : {}),
      ...(engine.source !== undefined ? { source: sanitizeIdentifier(engine.source, { fallback: 'unknown', kind: 'generic' }) } : {}),
    })),
    ...(readiness.probe !== undefined
      ? {
          probe: {
            at: readiness.probe.at,
            latencyMs: readiness.probe.latencyMs,
            protocolOk: readiness.probe.protocolOk,
            enginesOk: readiness.probe.enginesOk,
            summary: sanitizeOperatorText(readiness.probe.summary, { fallback: DEFAULT_PROBE_SUMMARY }),
            ...(readiness.probe.source !== undefined ? { source: readiness.probe.source } : {}),
            ...(readiness.probe.version !== undefined
              ? { version: /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(readiness.probe.version) ? readiness.probe.version : 'unknown-version' }
              : {}),
          },
        }
      : {}),
    workSafety: { state: readiness.workSafety.state },
  };
}

/**
 * The client-facing shape of one Environment recovery record (#88).
 *
 * Only neutral evidence facts, the derived unresolved facts, and sanitized
 * decision reasons: no private key, engine credential, hostname, address,
 * topology, or absolute path has a field in this projection. The unresolved facts
 * are product-owned text, so the Force Release manifest cannot drift from the
 * state it explains.
 */
export interface EnvironmentRecoveryView {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly cause: string;
  readonly phase: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly reconnectObservedAt?: number;
  readonly evidence?: {
    readonly retainedEventCount: number;
    readonly turnSettlementObserved: boolean;
    readonly engineSessionStopped: boolean;
    readonly taskContextRecycled: boolean;
  };
  readonly unresolvedFacts: readonly string[];
  /** Whether the ordinary decision requires synchronized evidence first. */
  readonly evidenceSynchronized: boolean;
  readonly decisions: readonly {
    readonly kind: string;
    readonly actor: string;
    readonly at: number;
    readonly reason: string;
  }[];
}

export function toEnvironmentRecoveryView(record: EnvironmentRecoveryRecord): EnvironmentRecoveryView {
  return {
    id: record.id,
    environmentInstanceId: record.environmentInstanceId,
    leaseId: record.leaseId,
    holderKind: record.holderKind,
    ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
    cause: record.cause,
    phase: record.phase,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.reconnectObservedAt !== undefined
      ? { reconnectObservedAt: record.reconnectObservedAt }
      : {}),
    ...(record.evidence !== undefined
      ? {
          evidence: {
            retainedEventCount: record.evidence.retainedEventCount,
            turnSettlementObserved: record.evidence.turnSettlementObserved,
            engineSessionStopped: record.evidence.engineSessionStopped,
            taskContextRecycled: record.evidence.taskContextRecycled,
          },
        }
      : {}),
    unresolvedFacts: record.unresolvedFacts.map((fact) =>
      sanitizeOperatorText(fact, { fallback: DEFAULT_RECOVERY_REASON }),
    ),
    evidenceSynchronized: record.evidence !== undefined,
    decisions: record.decisions.map((decision) => ({
      kind: decision.kind,
      actor: decision.actor,
      at: decision.at,
      reason: sanitizeOperatorText(decision.reason, { fallback: DEFAULT_RECOVERY_REASON }),
    })),
  };
}

/**
 * The client-facing shape of one permanent Force Release outcome (#88).
 *
 * ADR-0009 makes the override durable history, so the actor, time, reason,
 * unresolved facts, affected Environment, lease, Task, and runs are all exposed
 * for inspection; the unrecycled-context and workspace-preservation facts are
 * explicit rather than implied. The reason is free text and passes the operator
 * privacy boundary here as the last wire boundary.
 */
export interface ForceReleaseView {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly actor: string;
  readonly at: number;
  readonly reason: string;
  readonly risksAcknowledged: boolean;
  readonly unresolvedFacts: readonly string[];
  readonly affectedRunIds: readonly string[];
  readonly projectWorkspacePreserved: boolean;
  readonly unrecycledTaskContext: boolean;
}

export function toForceReleaseView(record: ForceReleaseRecord): ForceReleaseView {
  return {
    id: record.id,
    environmentInstanceId: record.environmentInstanceId,
    leaseId: record.leaseId,
    holderKind: record.holderKind,
    ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
    actor: record.actor,
    at: record.at,
    reason: sanitizeOperatorText(record.reason, { fallback: DEFAULT_FORCE_RELEASE_REASON }),
    risksAcknowledged: record.risksAcknowledged === true,
    unresolvedFacts: record.unresolvedFacts.map((fact) =>
      sanitizeOperatorText(fact, { fallback: DEFAULT_RECOVERY_REASON }),
    ),
    affectedRunIds: [...record.affectedRunIds],
    projectWorkspacePreserved: true,
    unrecycledTaskContext: record.unrecycledTaskContext === true,
  };
}

/**
 * The client-facing shape of a portable Agent (#90, ADR-0008).
 *
 * Portable state only: stable identity, display name, status, standing
 * instructions, ordered work options, and the append-only configuration
 * history. No host path, engine credential, hostname, address, or run
 * transcript can appear here — the wire projection re-applies the privacy
 * boundary on read so a legacy or hand-written durable document cannot leak.
 */
export interface AgentWorkOptionView {
  readonly id: string;
  readonly engine: string;
  readonly workModel: string;
  readonly effort: string;
}

export interface AgentConfigurationVersionView {
  readonly version: number;
  readonly at: number;
  readonly reason: string;
  readonly options: readonly AgentWorkOptionView[];
  readonly instructions?: string;
}

export interface AgentView {
  /** Preserved M1 field: the stable identity the client addresses runs by. */
  readonly id: string;
  /** Preserved M1 field, kept in sync with the current display name. */
  readonly name: string;
  readonly displayName: string;
  readonly status: string;
  readonly configuration: {
    readonly currentVersion: number;
    readonly versions: readonly AgentConfigurationVersionView[];
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function toAgentView(agent: Agent): AgentView {
  const displayName = sanitizeOperatorText(agent.displayName, { fallback: 'Agent', maxLength: 120 });
  return {
    id: sanitizeIdentifier(agent.id, { fallback: 'unknown-agent', kind: 'generic' }),
    // The M1 composer renders `name`; the M2 identity carries `displayName`.
    // One value, two names, so the preserved client keeps working unchanged.
    name: displayName,
    displayName,
    status: agent.status === 'archived' ? 'archived' : 'active',
    configuration: {
      currentVersion: agent.configuration.currentVersion,
      versions: agent.configuration.versions.map((version) => ({
        version: version.version,
        at: version.at,
        reason: sanitizeOperatorText(version.reason, {
          fallback: 'The Agent configuration was recorded; its detail was withheld as sensitive.',
        }),
        options: version.options.map((option) => ({
          id: sanitizeIdentifier(option.id, { fallback: `option-${option.engine}`, kind: 'generic' }),
          engine: sanitizeIdentifier(option.engine, { fallback: 'unknown-engine', kind: 'engine' }),
          workModel: sanitizeIdentifier(option.workModel, { fallback: 'unknown-model', kind: 'model' }),
          effort: sanitizeIdentifier(option.effort, { fallback: 'unknown-effort', kind: 'model' }),
        })),
        ...(version.instructions !== undefined
          ? {
              instructions: sanitizeOperatorText(version.instructions, {
                fallback: 'The standing instructions were withheld as sensitive.',
                maxLength: 4_000,
              }),
            }
          : {}),
      })),
    },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

/**
 * The client-facing run attribution (#90): which work option and Agent
 * configuration version one run actually used. Projected from the durable run
 * record, never re-derived from the Agent's current configuration.
 */
export interface RunWorkOptionAttributionView {
  readonly engine: string;
  readonly workModel?: string;
  readonly effort?: string;
  readonly configurationVersion: number;
}

export function toRunWorkOptionAttribution(run: AgentRun): RunWorkOptionAttributionView | undefined {
  if (run.workOption === undefined) return undefined;
  return {
    engine: sanitizeIdentifier(run.workOption.engine, { fallback: 'unknown-engine', kind: 'engine' }),
    ...(run.workOption.workModel !== '' ? { workModel: run.workOption.workModel } : {}),
    ...(run.workOption.effort !== '' ? { effort: run.workOption.effort } : {}),
    configurationVersion: run.configurationVersion ?? 1,
  };
}

/**
 * The client-facing run workspace attribution (#93): the durable binding one
 * run was admitted under. The opaque workspace identity and, for a relative
 * binding, the Worker-root-relative location — never an absolute host path.
 * Projected from the durable run record, never re-derived from the access
 * record's current binding, so history stays historical.
 */
export interface RunWorkspaceBindingAttributionView {
  readonly bindingId?: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly path?: string;
}

function toRunWorkspaceBindingAttribution(run: AgentRun): RunWorkspaceBindingAttributionView | undefined {
  const binding = run.workspaceBinding;
  if (binding === undefined) return undefined;
  const path = binding.path !== undefined ? sanitizeWorkspacePath(binding.path) : undefined;
  return {
    ...(binding.bindingId !== undefined
      ? { bindingId: sanitizeIdentifier(binding.bindingId, { fallback: 'unknown-binding', kind: 'generic' }) }
      : {}),
    workspaceId: sanitizeIdentifier(binding.workspaceId ?? '', { fallback: 'unknown-workspace', kind: 'digest' }),
    kind: binding.kind === 'relative' ? 'relative' : 'default',
    ...(path !== undefined ? { path } : {}),
  };
}

/**
 * The client-facing shape of one durable Project authority record (#92).
 *
 * Portable state only: stable identity, display name, status, template
 * attribution, the append-only content versions (goal, rules, wake policy,
 * routing interval, memberships with responsibilities and collaboration
 * instructions), and the archive/restore facts. No credential, provider or
 * account identity, hostname, address, absolute path, or raw command can
 * appear here — the wire projection re-applies the privacy boundary on read so
 * a legacy or hand-written durable document cannot leak.
 */
export interface ProjectMembershipView {
  readonly memberId: string;
  readonly memberKind: string;
  readonly responsibilities: readonly string[];
  readonly collaborationInstructions: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly endedReason?: string;
}

export interface ProjectContentVersionView {
  readonly version: number;
  readonly at: number;
  readonly reason: string;
  readonly goal: string;
  readonly rules: readonly string[];
  readonly wakePolicy: string;
  readonly routingIntervalMs: number;
  readonly memberships: readonly ProjectMembershipView[];
}

export interface ProjectAuthorityView {
  /** Preserved composer field: the stable identity the client addresses. */
  readonly id: string;
  /** Preserved composer field, kept in sync with the current goal. */
  readonly goal: string;
  /** Preserved composer field: current Agent member ids for @mentions. */
  readonly memberIds: readonly string[];
  readonly displayName: string;
  readonly status: string;
  readonly template: {
    readonly templateId: string;
    readonly templateVersion: number;
    readonly templateName: string;
    readonly collaborationGuidance: string;
    readonly completionGuidance: string;
    readonly goalGuidance: string;
    readonly suggestedRules: readonly string[];
    readonly roleSlots: readonly {
      readonly name: string;
      readonly suggestedResponsibilities: readonly string[];
      readonly suggestedCollaborationInstructions: string;
    }[];
    readonly wakePolicy: string;
    readonly routingIntervalMs: number;
  };
  readonly content: {
    readonly currentVersion: number;
    readonly versions: readonly ProjectContentVersionView[];
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt?: number;
  readonly archivedReason?: string;
  readonly restoredAt?: number;
}

export function toProjectAuthorityView(project: ProjectAuthority): ProjectAuthorityView {
  const current = project.content.versions[project.content.versions.length - 1];
  const displayName = sanitizeOperatorText(project.displayName, { fallback: 'Project', maxLength: 120 });
  return {
    id: sanitizeIdentifier(project.id, { fallback: 'unknown-project', kind: 'generic' }),
    // The M1 composer renders `goal` and `memberIds`; the M2 authority record
    // carries them inside its versioned content. The preserved fields project
    // the current version so the existing client keeps working unchanged.
    goal: current === undefined ? '' : sanitizeProjectText(current.goal),
    memberIds: current === undefined
      ? []
      : current.memberships
          .filter((membership) => membership.memberKind === 'agent' && membership.endedAt === undefined)
          .map((membership) => sanitizeIdentifier(membership.memberId, { fallback: 'unknown-member', kind: 'generic' })),
    displayName,
    status: project.status === 'archived' ? 'archived' : 'active',
    template: {
      templateId: sanitizeIdentifier(project.template.templateId, {
        fallback: 'unknown-template',
        kind: 'generic',
      }),
      templateVersion: project.template.templateVersion,
      templateName: sanitizeOperatorText(project.template.templateName, {
        fallback: 'Project template',
        maxLength: 120,
      }),
      collaborationGuidance: sanitizeProjectText(project.template.collaborationGuidance),
      completionGuidance: sanitizeProjectText(project.template.completionGuidance),
      goalGuidance: sanitizeProjectText(project.template.goalGuidance),
      suggestedRules: project.template.suggestedRules.map((rule) => sanitizeProjectText(rule)),
      roleSlots: project.template.roleSlots.map((slot) => ({
        name: sanitizeOperatorText(slot.name, { fallback: 'Role', maxLength: 120 }),
        suggestedResponsibilities: slot.suggestedResponsibilities.map((entry) => sanitizeProjectText(entry)),
        suggestedCollaborationInstructions: sanitizeProjectText(slot.suggestedCollaborationInstructions),
      })),
      wakePolicy: project.template.wakePolicy === 'wake-model-assisted' ? 'wake-model-assisted' : 'explicit-only',
      routingIntervalMs: project.template.routingIntervalMs,
    },
    content: {
      currentVersion: project.content.currentVersion,
      versions: project.content.versions.map((version) => ({
        version: version.version,
        at: version.at,
        reason: sanitizeOperatorText(version.reason, {
          fallback: 'The Project content was recorded; its detail was withheld as sensitive.',
          maxLength: 320,
        }),
        goal: sanitizeProjectText(version.goal),
        rules: version.rules.map((rule) => sanitizeProjectText(rule)),
        wakePolicy: version.wakePolicy === 'wake-model-assisted' ? 'wake-model-assisted' : 'explicit-only',
        routingIntervalMs: version.routingIntervalMs,
        memberships: version.memberships.map((membership) => ({
          memberId: sanitizeIdentifier(membership.memberId, { fallback: 'unknown-member', kind: 'generic' }),
          memberKind: membership.memberKind === 'human' ? 'human' : 'agent',
          responsibilities: membership.responsibilities.map((entry) => sanitizeProjectText(entry)),
          collaborationInstructions: sanitizeProjectText(membership.collaborationInstructions),
          startedAt: membership.startedAt,
          ...(membership.endedAt !== undefined ? { endedAt: membership.endedAt } : {}),
          ...(membership.endedReason !== undefined
            ? {
                endedReason: sanitizeOperatorText(membership.endedReason, {
                  fallback: 'The membership end reason was withheld as sensitive.',
                  maxLength: 320,
                }),
              }
            : {}),
        })),
      })),
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(project.archivedAt !== undefined ? { archivedAt: project.archivedAt } : {}),
    ...(project.archivedReason !== undefined
      ? {
          archivedReason: sanitizeOperatorText(project.archivedReason, {
            fallback: 'The archive reason was withheld as sensitive.',
            maxLength: 320,
          }),
        }
      : {}),
    ...(project.restoredAt !== undefined ? { restoredAt: project.restoredAt } : {}),
  };
}

/**
 * The client-facing shape of one Project Environment access and its workspace
 * bindings (#93, ADR-0008).
 *
 * Portable state only: the Environment instance id, lifecycle status, and the
 * append-only workspace binding history. A binding exposes the Worker's opaque
 * workspace identity and, for a relative selection, the Worker-root-relative
 * location — never an absolute host path. The absolute location of a workspace,
 * old or new, has no field here.
 */
export interface WorkspaceBindingView {
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly kind: string;
  /** Worker-root-relative location, when the workspace named one. */
  readonly path?: string;
  readonly boundAt: number;
  readonly unboundAt?: number;
  readonly unboundReason?: string;
}

export interface ProjectEnvironmentAccessView {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly status: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly endedAt?: number;
  readonly endedReason?: string;
  /** The one current binding, present only while access is active. */
  readonly current?: WorkspaceBindingView;
  /** Every binding, oldest first, including the current one. */
  readonly history: readonly WorkspaceBindingView[];
}

function toWorkspaceBindingView(binding: WorkspaceBinding): WorkspaceBindingView {
  // Defence in depth for the privacy invariant: the domain already refuses an
  // absolute location, but the wire must never carry one even if a record were
  // corrupted. A path that is not a safe Worker-root-relative location is
  // dropped entirely rather than exposed.
  const path = binding.path !== undefined ? sanitizeWorkspacePath(binding.path) : undefined;
  return {
    bindingId: sanitizeIdentifier(binding.bindingId, { fallback: 'unknown-binding', kind: 'generic' }),
    workspaceId: sanitizeIdentifier(binding.workspaceId, { fallback: 'unknown-workspace', kind: 'digest' }),
    kind: binding.kind === 'relative' ? 'relative' : 'default',
    ...(path !== undefined
      ? { path: sanitizeOperatorText(path, { fallback: '', maxLength: 1_024 }) }
      : {}),
    boundAt: binding.boundAt,
    ...(binding.unboundAt !== undefined ? { unboundAt: binding.unboundAt } : {}),
    ...(binding.unboundReason !== undefined
      ? {
          unboundReason: sanitizeOperatorText(binding.unboundReason, {
            fallback: 'The workspace change reason was withheld as sensitive.',
            maxLength: 320,
          }),
        }
      : {}),
  };
}

export function toProjectEnvironmentAccessView(
  access: ProjectEnvironmentAccess,
): ProjectEnvironmentAccessView {
  return {
    projectId: sanitizeIdentifier(access.projectId, { fallback: 'unknown-project', kind: 'generic' }),
    environmentInstanceId: sanitizeIdentifier(access.environmentInstanceId, {
      fallback: 'unknown-environment',
      kind: 'generic',
    }),
    status: access.status === 'ended' ? 'ended' : 'active',
    startedAt: access.startedAt,
    updatedAt: access.updatedAt,
    ...(access.endedAt !== undefined ? { endedAt: access.endedAt } : {}),
    ...(access.endedReason !== undefined
      ? {
          endedReason: sanitizeOperatorText(access.endedReason, {
            fallback: 'The access end reason was withheld as sensitive.',
            maxLength: 320,
          }),
        }
      : {}),
    ...(access.current !== undefined ? { current: toWorkspaceBindingView(access.current) } : {}),
    history: access.history.map(toWorkspaceBindingView),
  };
}
