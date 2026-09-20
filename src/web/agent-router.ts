import type { ApiRequestContext, ApiRouter } from './router.ts';
import {
  AgentIdentityError,
  type AgentService,
} from '../agent/service.ts';
import type { Agent } from '../agent/model.ts';
import { toAgentView, toRunWorkOptionAttribution } from './views.ts';

/**
 * The portable Agent identity router (#90).
 *
 * A domain-owned route set composed through the #85 additive seam. Every route
 * delegates to the Agent service, so the validation, configuration-versioning,
 * and archive/restore safety rules have exactly one implementation and the
 * transport keeps none.
 *
 * Privacy: no route accepts or returns a credential, hostname, address,
 * absolute path, or engine secret. Every free-text field and structured
 * identifier passes the Agent module's write boundary before it becomes
 * durable, and the read projection re-applies the boundary so a legacy document
 * cannot leak through the API.
 */

export interface AgentRouterOptions {
  readonly agents: AgentService;
  /**
   * The per-run work-option attribution reader (#90).
   *
   * Optional so the identity contract stays usable on its own; the runtime
   * supplies it from the run store so a client can ask which engine, work
   * model, effort, and configuration version one run actually used.
   */
  readonly runAttribution?: (runId: string) => Promise<
    | {
        readonly runId: string;
        readonly agentId: string;
        readonly environmentInstanceId: string;
        readonly attribution: ReturnType<typeof toRunWorkOptionAttribution>;
      }
    | undefined
  >;
  /**
   * The Environment-facts compatibility projection for one Agent (#90).
   *
   * Optional so the identity contract stays usable on its own. Supplied by the
   * runtime from the enrollment/readiness stores; absent means the route
   * reports an explicit `not configured` rather than inventing facts.
   */
  readonly compatibility?: (
    agent: Agent,
  ) => Promise<unknown>;
}

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parse the ordered work options of a request body, refusing a non-array. */
function parseWorkOptions(
  value: unknown,
): { readonly id?: string; readonly engine: string; readonly workModel: string; readonly effort: string }[] | 'invalid' {
  if (!Array.isArray(value) || value.length === 0) return 'invalid';
  const options: { readonly id?: string; readonly engine: string; readonly workModel: string; readonly effort: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const record = entry as Record<string, unknown>;
    const engine = record['engine'];
    const workModel = record['workModel'];
    const effort = record['effort'];
    if (typeof engine !== 'string' || typeof workModel !== 'string' || typeof effort !== 'string') {
      return 'invalid';
    }
    const id = record['id'];
    if (id !== undefined && typeof id !== 'string') return 'invalid';
    options.push({
      engine,
      workModel,
      effort,
      ...(typeof id === 'string' ? { id } : {}),
    });
  }
  return options;
}

function agentFailure(context: ApiRequestContext, error: unknown): boolean {
  if (error instanceof AgentIdentityError) {
    const status = error.code === 'unknown-agent' ? 404 : 400;
    return json(context, status, { error: error.message, code: error.code });
  }
  context.response.writeHead(500, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify({ error: 'the request could not be completed' }));
  return true;
}

/** Read the status filter, accepting only the canonical lifecycle values. */
function statusFilter(value: string | undefined): 'active' | 'archived' | undefined {
  if (value === 'active' || value === 'archived') return value;
  return undefined;
}

function agentMatchesStatus(agent: Agent, status: 'active' | 'archived' | undefined): boolean {
  return status === undefined || agent.status === status;
}

export function createAgentRouter(options: AgentRouterOptions): ApiRouter {
  const { agents, runAttribution, compatibility } = options;
  return {
    name: 'agent-identity',
    async handle(context: ApiRequestContext): Promise<boolean> {
      const { method, pathname, segments } = context;

      // POST /api/agents — create one portable Agent.
      if (method === 'POST' && pathname === '/api/agents') {
        const body = await context.readBody();
        const displayName = stringField(body, 'displayName');
        const instructions = stringField(body, 'instructions');
        const workOptions = parseWorkOptions(body['workOptions']);
        if (displayName === undefined || workOptions === 'invalid') {
          return json(context, 400, {
            error: 'displayName and a non-empty workOptions array are required',
          });
        }
        const id = stringField(body, 'id');
        try {
          const agent = await agents.create({
            ...(id !== undefined ? { id } : {}),
            displayName,
            ...(instructions !== undefined ? { instructions } : {}),
            workOptions,
          });
          return json(context, 201, { agent: toAgentView(agent) });
        } catch (error) {
          return agentFailure(context, error);
        }
      }

      // GET /api/agents — list durable Agents, optionally by lifecycle status.
      // The preserved M1 route returned `{ id, name, engine }` from the seed
      // registry; this additive route keeps those fields on every row and adds
      // the durable identities, so the existing composer keeps working.
      if (method === 'GET' && pathname === '/api/agents') {
        const status = statusFilter(context.searchParams.get('status') ?? undefined);
        const listed = (await agents.list())
          .filter((agent) => agentMatchesStatus(agent, status))
          .map(toAgentView);
        return json(context, 200, { agents: listed });
      }

      // GET /api/agents/:id — inspect one Agent.
      if (
        method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'agents'
      ) {
        const agent = await agents.get(segments[2] ?? '');
        if (agent === undefined) return json(context, 404, { error: 'unknown agent' });
        return json(context, 200, { agent: toAgentView(agent) });
      }

      // POST /api/agents/:id/configuration — append one configuration version.
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'agents' &&
        segments[3] === 'configuration'
      ) {
        const body = await context.readBody();
        const workOptions = parseWorkOptions(body['workOptions']);
        if (workOptions === 'invalid') {
          return json(context, 400, {
            error: 'a non-empty workOptions array is required',
          });
        }
        const displayName = stringField(body, 'displayName');
        const instructions = body['instructions'] === null ? null : stringField(body, 'instructions');
        const reason = stringField(body, 'reason');
        try {
          const agent = await agents.reconfigure(segments[2] ?? '', {
            workOptions,
            ...(displayName !== undefined ? { displayName } : {}),
            // `instructions: null` clears the standing instructions explicitly;
            // an omitted field keeps the current ones.
            ...(instructions === null ? { instructions: undefined } : instructions !== undefined ? { instructions } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { agent: toAgentView(agent) });
        } catch (error) {
          return agentFailure(context, error);
        }
      }

      // POST /api/agents/:id/archive — non-destructive archive (ADR-0008).
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'agents' &&
        segments[3] === 'archive'
      ) {
        try {
          const agent = await agents.archive(segments[2] ?? '');
          return json(context, 200, { agent: toAgentView(agent) });
        } catch (error) {
          return agentFailure(context, error);
        }
      }

      // POST /api/agents/:id/restore — restore an archived Agent.
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'agents' &&
        segments[3] === 'restore'
      ) {
        try {
          const agent = await agents.restore(segments[2] ?? '');
          return json(context, 200, { agent: toAgentView(agent) });
        } catch (error) {
          return agentFailure(context, error);
        }
      }

      // GET /api/agents/:id/compatibility — the current Environment-facts
      // projection for this Agent's ordered options.
      if (
        method === 'GET' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'agents' &&
        segments[3] === 'compatibility'
      ) {
        const agent = await agents.get(segments[2] ?? '');
        if (agent === undefined) return json(context, 404, { error: 'unknown agent' });
        if (compatibility === undefined) {
          return json(context, 503, { error: 'compatibility facts are not configured' });
        }
        return json(context, 200, await compatibility(agent));
      }

      // GET /api/runs/:id/work-option — one run's durable admission facts (#90).
      if (
        method === 'GET' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'runs' &&
        segments[3] === 'work-option' &&
        runAttribution !== undefined
      ) {
        const record = await runAttribution(segments[2] ?? '');
        if (record === undefined) return json(context, 404, { error: 'unknown run' });
        return json(context, 200, record);
      }

      return false;
    },
  };
}
