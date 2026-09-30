import type { ApiRequestContext, ApiRouter } from './router.ts';
import type { TaskProposalService } from '../task/proposal-service.ts';
import { TaskProposalError, type TaskProposalInput, type TaskProposalContent, type ReviseTaskProposal, type ProposalDecision } from '../task/proposal-model.ts';

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}
/** Composed behind operator authentication + CSRF. Body actors are never authority. */
export function createTaskProposalRouter(options: { proposals: TaskProposalService }): ApiRouter {
  const { proposals } = options;
  return {
    name: 'task-proposals',
    async handle(context) {
      const { method, segments } = context;
      const projectRoute = segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'task-proposals';
      const proposalRoute = segments[0] === 'api' && segments[1] === 'task-proposals';
      const collection = projectRoute && segments.length === 4;
      const validation = projectRoute && segments.length === 5 && segments[4] === 'validate';
      const detail = proposalRoute && segments.length === 3;
      const version = proposalRoute && segments.length === 5 && segments[3] === 'versions';
      const action = proposalRoute && segments.length === 4 && ['content', 'withdraw', 'reject'].includes(segments[3] ?? '');
      if (!(method === 'GET' && (collection || detail || version)) && !(method === 'POST' && (collection || validation || action))) return false;
      try {
        const id = segments[2] ?? '';
        if (method === 'GET') {
          if (collection) return json(context, 200, { proposals: await proposals.list(id) });
          if (version) return json(context, 200, { contentVersion: await proposals.contentVersion(id, Number(segments[4])) });
          return json(context, 200, { proposal: await proposals.get(id) });
        }
        // No input identity can stand in for the authenticated Human.
        const projectId = projectRoute ? id : (await proposals.get(id)).projectId;
        const actor = await proposals.humanAuthority(projectId);
        const body = await context.readBody();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TaskProposalError('invalid-content');
        if (collection) return json(context, 201, { proposal: await proposals.propose(id, actor, body as unknown as TaskProposalInput) });
        if (validation) return json(context, 200, { content: await proposals.validate(id, actor, body as unknown as TaskProposalContent) });
        const decision = body as unknown as ProposalDecision;
        const proposal = segments[3] === 'content'
          ? await proposals.revise(id, actor, body as unknown as ReviseTaskProposal)
          : segments[3] === 'withdraw' ? await proposals.withdraw(id, actor, decision) : await proposals.reject(id, actor, decision);
        return json(context, 200, { proposal });
      } catch (error) {
        if (error instanceof TaskProposalError) {
          const status = error.code.startsWith('unknown-') ? 404 : error.code === 'invalid-content' ? 400
            : ['membership-required', 'authority-required'].includes(error.code) ? 403 : 409;
          return json(context, status, { code: error.code, error: error.message });
        }
        return json(context, 500, { error: 'the request could not be completed' });
      }
    },
  };
}
