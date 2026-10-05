import type { EnvironmentPool } from '../environment/pool.ts';
import type { AgentTaskGroupMessageInput, AgentTaskGroupMessageResult } from '../engine/port.ts';
import type { ConversationScopeService } from '../conversation/service.ts';
import { taskGroupScopeId } from '../conversation/model.ts';
import type { TaskStore } from '../task/store.ts';
import type { RunOrchestrator } from '../run/orchestrator.ts';
import { MessageDeliveryError, type CollaborationCoordinator } from './coordinator.ts';

/** A refusal from the session-bound Task-group post capability. */
export class AgentTaskGroupPostError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;

  constructor(status: number, code: string, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (reason !== undefined) this.reason = reason;
    this.name = 'AgentTaskGroupPostError';
  }
}

const MESSAGE_KINDS = new Set(['handoff', 'assignment', 'question', 'status']);

/** Core-only capability: Task, Project, Agent, group, and run identity come from the admitted run. */
export function createAgentTaskGroupMessageSender(options: {
  readonly run: {
    readonly id: string;
    readonly agentId: string;
    readonly projectId?: string;
    readonly taskId?: string;
    readonly leaseId?: string;
    readonly environmentInstanceId: string;
  };
  readonly runs: Pick<RunOrchestrator, 'load'>;
  readonly tasks: Pick<TaskStore, 'get'>;
  readonly pool: Pick<EnvironmentPool, 'getLease'>;
  readonly scopes: ConversationScopeService;
  readonly collaboration: CollaborationCoordinator;
  /** Synchronous Stop/revocation fence, checked immediately before persistence. */
  readonly assertActive?: () => void;
}): (input: AgentTaskGroupMessageInput) => Promise<AgentTaskGroupMessageResult> {
  return async (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new AgentTaskGroupPostError(400, 'invalid-post', 'a Task-group post must be a JSON object');
    }
    if (typeof input.body !== 'string') {
      throw new AgentTaskGroupPostError(400, 'invalid-post', 'body must be a string');
    }
    if (typeof input.deliveryKey !== 'string' || input.deliveryKey.trim() === '') {
      throw new AgentTaskGroupPostError(400, 'invalid-post', 'deliveryKey is required');
    }
    if (input.kind !== undefined && !MESSAGE_KINDS.has(input.kind)) {
      throw new AgentTaskGroupPostError(400, 'invalid-kind', 'kind must be handoff, assignment, question, or status');
    }
    if (input.awaitReply !== undefined && typeof input.awaitReply !== 'boolean') {
      throw new AgentTaskGroupPostError(400, 'invalid-post', 'awaitReply must be a boolean');
    }

    const { id: runId, agentId, projectId, taskId } = options.run;
    if (projectId === undefined || taskId === undefined) {
      throw new AgentTaskGroupPostError(403, 'task-run-required', 'Task-group posts require a Project-bound Task run');
    }
    const assertActive = () => {
      try {
        options.assertActive?.();
      } catch {
        throw new AgentTaskGroupPostError(403, 'run-not-active', 'the Task-group post capability is no longer active');
      }
    };
    assertActive();

    const scope = await options.scopes.getScope(taskGroupScopeId(taskId));
    if (scope === undefined || scope.kind !== 'task-group' || scope.taskId !== taskId || scope.projectId !== projectId) {
      throw new AgentTaskGroupPostError(409, 'task-group-unavailable', 'the current Task group is unavailable');
    }
    assertActive();

    const assertPersistenceAuthority = async () => {
      const currentRun = await options.runs.load(runId);
      const task = await options.tasks.get(taskId);
      if (
        currentRun === undefined || currentRun.status !== 'running' || currentRun.id !== runId ||
        currentRun.agentId !== agentId || currentRun.projectId !== projectId || currentRun.taskId !== taskId ||
        currentRun.leaseId === undefined || currentRun.environmentInstanceId !== options.run.environmentInstanceId ||
        task === undefined || task.projectId !== projectId || task.status !== 'in-progress' ||
        task.environmentLifecycleState !== 'running' || task.activeRunId !== runId ||
        task.environmentLeaseId !== currentRun.leaseId || task.environmentInstanceId !== currentRun.environmentInstanceId
      ) {
        throw new AgentTaskGroupPostError(403, 'task-run-not-current', 'the Task run is no longer current');
      }
      const lease = options.pool.getLease(task.environmentLeaseId);
      if (
        !lease || lease.state !== 'active' || lease.holderKind !== 'task' ||
        lease.taskId !== taskId || lease.holderId !== taskId || lease.instanceId !== task.environmentInstanceId
      ) {
        throw new AgentTaskGroupPostError(403, 'task-lease-not-active', 'the Task environment lease is no longer active');
      }
    };

    let delivered: Awaited<ReturnType<CollaborationCoordinator['deliver']>>;
    try {
      delivered = await options.collaboration.deliver({
        assertActive,
        assertPersistenceAuthority,
        scopeId: scope.id,
        author: { id: agentId, kind: 'agent' },
        body: input.body,
        taskGroupKind: input.kind ?? 'status',
        taskGroupRunId: runId,
        deliveryKey: `agent-task-group:${JSON.stringify([projectId, taskId, agentId, input.deliveryKey])}`,
        awaitReply: input.awaitReply ?? false,
      });
    } catch (error) {
      if (error instanceof MessageDeliveryError) {
        const status = error.reason === 'not-a-member' || error.reason === 'not-a-participant' ? 403 : 409;
        throw new AgentTaskGroupPostError(status, error.code, error.message, error.reason);
      }
      throw error;
    }
    const runResults = await Promise.all(delivered.wakes.flatMap((wake) =>
      wake.runId ? [options.runs.load(wake.runId)] : [],
    ));
    return {
      messageId: delivered.message.id,
      scopeId: delivered.message.scopeId,
      authorId: delivered.message.author.id,
      ...(delivered.message.envelope !== undefined ? { envelope: delivered.message.envelope } : {}),
      duplicate: delivered.duplicate,
      admittedRunIds: delivered.admittedRunIds,
      runs: runResults.flatMap((run) => run ? [{
        id: run.id,
        status: run.status,
        ...(run.failure !== undefined ? { failure: run.failure } : {}),
      }] : []),
      wakes: delivered.wakes.map((wake) => ({
        agentId: wake.agentId,
        reason: wake.reason,
        status: wake.status,
        ...(wake.detail !== undefined ? { detail: wake.detail } : {}),
      })),
    };
  };
}

