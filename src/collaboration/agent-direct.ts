import type { AgentDirectMessageInput, AgentDirectMessageResult } from '../engine/port.ts';
import type { ConversationScopeService } from '../conversation/service.ts';
import type { CollaborationCoordinator } from './coordinator.ts';

/** Core-only capability factory: identity comes from the admitted Run. */
export function createAgentDirectMessageSender(options: {
  readonly run: { readonly agentId: string; readonly projectId?: string };
  readonly runs: Pick<import('../run/orchestrator.ts').RunOrchestrator, 'load'>;
  readonly scopes: ConversationScopeService;
  readonly collaboration: CollaborationCoordinator;
}): (input: AgentDirectMessageInput) => Promise<AgentDirectMessageResult> {
  return async input => {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['recipientId', 'body', 'deliveryKey', 'awaitReply'].includes(key))) {
      throw new Error('unsupported direct-message fields; author is resolved by Core');
    }
    if (typeof input.recipientId !== 'string' || !input.recipientId.trim() || typeof input.body !== 'string' || !input.body.trim() || typeof input.deliveryKey !== 'string' || !input.deliveryKey.trim() || (input.awaitReply !== undefined && typeof input.awaitReply !== 'boolean')) {
      throw new Error('recipientId, body and deliveryKey are required');
    }
    const { agentId, projectId } = options.run;
    if (!projectId) throw new Error('direct messages require a Project-bound run');
    const members = await options.scopes.projectMembers(projectId);
    if (!members?.some(m => m.memberId === agentId && m.memberKind === 'agent' && m.endedAt === undefined)) throw new Error('sender is not a current Project Agent');
    const scope = await options.scopes.openDirect({ projectId, participants: [agentId, input.recipientId] });
    const delivered = await options.collaboration.deliver({
      scopeId: scope.id, author: { id: agentId, kind: 'agent' }, body: input.body,
      recipients: [input.recipientId], deliveryKey: `agent-direct:${JSON.stringify([projectId, agentId, input.deliveryKey])}`,
      awaitReply: input.awaitReply ?? false,
    });
    const runs = await Promise.all(delivered.wakes.flatMap(w => w.runId ? [options.runs.load(w.runId)] : []));
    return {
      runs: runs.flatMap(run => run ? [{ id: run.id, status: run.status, ...(run.failure !== undefined ? { failure: run.failure } : {}) }] : []),
      messageId: delivered.message.id, scopeId: delivered.message.scopeId,
      authorId: delivered.message.author.id, duplicate: delivered.duplicate,
      admittedRunIds: delivered.admittedRunIds,
      wakes: delivered.wakes.map(w => ({ agentId: w.agentId, reason: w.reason, status: w.status, ...(w.detail !== undefined ? { detail: w.detail } : {}) })),
    };
  };
}
