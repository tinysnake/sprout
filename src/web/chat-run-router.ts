import type { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import { ConversationScopeError } from '../conversation/model.ts';
import type { ConversationScopeService } from '../conversation/service.ts';
import type { AgentRun } from '../run/model.ts';
import type { RunOrchestrator } from '../run/orchestrator.ts';
import type { ApiRequestContext, ApiRouter } from './router.ts';

function json(context: ApiRequestContext, status: number, body: unknown) {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

function activeView(run: AgentRun): { readonly id: string; readonly agentId: string; readonly status: 'queued' | 'running' } | undefined {
  if (run.status !== 'queued' && run.status !== 'running') return undefined;
  return { id: run.id, agentId: run.agentId, status: run.status };
}

/** Authoritative status-only Chat projection and Human control for one-round runs. */
export function createChatRunRouter(options: {
  readonly collaboration: Pick<CollaborationCoordinator, 'activeChatRunsForScope' | 'chatRunForScope' | 'publishRunInterruption'>;
  readonly scopes: ConversationScopeService;
  readonly runs: Pick<RunOrchestrator, 'interrupt'>;
}): ApiRouter {
  const { collaboration, scopes, runs } = options;

  async function visibleScope(scopeId: string) {
    const scope = await scopes.getScope(scopeId);
    if (!scope) return undefined;
    const human = await scopes.humanAuthority(scope.projectId);
    if (scope.kind === 'direct' && !scope.participants.includes(human.memberId)) return undefined;
    return scope;
  }

  return {
    name: 'chat-run-control',
    async handle(context) {
      const s = context.segments;
      const list = context.method === 'GET' && s.length === 5 && s[0] === 'api' && s[1] === 'chat' &&
        s[2] === 'scopes' && s[4] === 'active-runs';
      const stop = context.method === 'POST' && s.length === 7 && s[0] === 'api' && s[1] === 'chat' &&
        s[2] === 'scopes' && s[4] === 'runs' && s[6] === 'stop';
      if (!list && !stop) return false;
      if (!context.operatorSessionId) return json(context, 401, { error: 'authentication required' });

      const scopeId = s[3]!;
      let scope;
      try { scope = await visibleScope(scopeId); }
      catch (error) {
        if (error instanceof ConversationScopeError) return json(context, 404, { error: 'Conversation not found' });
        return json(context, 503, { error: 'Chat run state is unavailable' });
      }
      if (!scope) return json(context, 404, { error: 'Conversation not found' });

      if (list) {
        try {
          const projected = await collaboration.activeChatRunsForScope(scopeId);
          const active = projected.map(activeView).filter((run): run is NonNullable<typeof run> => run !== undefined);
          return json(context, 200, { runs: active });
        } catch {
          return json(context, 503, { error: 'Chat run state is unavailable' });
        }
      }

      const runId = s[5]!;
      let run: AgentRun | undefined;
      try { run = await collaboration.chatRunForScope(scopeId, runId); }
      catch { return json(context, 503, { error: 'Chat run state is unavailable' }); }
      if (!run || run.projectId !== scope.projectId) return json(context, 404, { error: 'Chat run not found' });
      if (run.taskId !== undefined) return json(context, 409, { error: 'Task runs are controlled from Tasks' });
      if (run.status !== 'queued' && run.status !== 'running') {
        if (run.status === 'interrupted' && run.interruptionReason === 'human-stop') {
          try { await collaboration.publishRunInterruption(run); }
          catch { return json(context, 503, { error: 'Interruption event is pending reconciliation' }); }
        }
        return json(context, 200, { id: run.id, status: run.status });
      }

      try {
        const interrupted = await runs.interrupt(runId);
        if (interrupted.status === 'interrupted' && interrupted.interruptionReason === 'human-stop') {
          await collaboration.publishRunInterruption(interrupted);
        }
        return json(context, 200, { id: interrupted.id, status: interrupted.status });
      } catch {
        return json(context, 409, { error: 'Chat run could not be interrupted; inspect its current status' });
      }
    },
  };
}
