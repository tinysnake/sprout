import type { ApiRequestContext, ApiRouter } from './router.ts';
import { ProjectAuthorityError } from '../project/authority-model.ts';
import type { ProjectService } from '../project/authority-service.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import { toProjectAuthorityView, toProjectView } from './views.ts';

/**
 * The Project, template-snapshot, and membership authority router (#92).
 *
 * A domain-owned route set composed through the #85 additive seam. Every route
 * delegates to the Project service, so the validation, versioning, and
 * archive/restore safety rules have exactly one implementation and the
 * transport keeps none.
 *
 * Authority: these routes sit behind the #84 operator browser boundary, so
 * every command below is Human authority by construction — an Agent cannot
 * create a Project, join one, or invite another Agent (ADR-0008).
 *
 * Privacy: no route accepts or returns a credential, provider or account
 * identity, hostname, address, absolute path, or raw command. Every free-text
 * field passes the Project module's write boundary before it becomes durable,
 * and the read projection re-applies the boundary so a legacy document cannot
 * leak through the API.
 */

export interface ProjectRouterOptions {
  readonly projects: ProjectService;
  /**
   * The M1 composer registry, when the runtime composed one. Its configured
   * Projects are merged into `GET /api/projects` so the authority route never
   * shadows a legacy Project the composer can still address (F1, #85 route
   * compatibility). Authority records win for a shared id: one stable
   * identity, never two.
   */
  readonly legacyProjects?: ProjectRegistry;
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

/** Parse the optional rules array of a request body, refusing a non-array. */
function parseRules(value: unknown): readonly string[] | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return 'invalid';
  return value as readonly string[];
}

/** Parse the optional responsibilities array of a request body. */
function parseResponsibilities(value: unknown): readonly string[] | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return 'invalid';
  return value as readonly string[];
}

/** Read the status filter, accepting only the canonical lifecycle values. */
function statusFilter(value: string | undefined): 'active' | 'archived' | undefined {
  if (value === 'active' || value === 'archived') return value;
  return undefined;
}

function projectFailure(context: ApiRequestContext, error: unknown): boolean {
  if (error instanceof ProjectAuthorityError) {
    // Lifecycle conflicts are 409 under the existing Environment/Task router
    // contract: active work, archived read-only, duplicate membership, and
    // already-archived are states of the resource, not bad requests (F4).
    // Only unknown targets and malformed input keep 404/400.
    const status = error.code === 'unknown-project' || error.code === 'unknown-agent'
      ? 404
      : error.code === 'already-archived' ||
          error.code === 'not-archived' ||
          error.code === 'archived-project-is-read-only' ||
          error.code === 'active-work-depends-on-project' ||
          error.code === 'duplicate-membership' ||
          error.code === 'membership-not-active' ||
          error.code === 'human-membership-required'
        ? 409
        : 400;
    return json(context, status, { error: error.message, code: error.code });
  }
  context.response.writeHead(500, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify({ error: 'the request could not be completed' }));
  return true;
}

export function createProjectRouter(options: ProjectRouterOptions): ApiRouter {
  const { projects, legacyProjects } = options;

  /**
   * The merged composer-compatible listing: legacy configured Projects plus
   * authority records, authority winning a shared id. Every entry carries the
   * preserved `{ id, goal, memberIds }` composer fields.
   */
  async function composerCompatibleList(): Promise<readonly unknown[]> {
    const listed = await projects.list();
    const authorityIds = new Set(listed.map((project) => project.id));
    const legacy = (legacyProjects?.list() ?? [])
      .filter((project) => !authorityIds.has(project.id))
      .map(toProjectView);
    return [
      ...legacy,
      ...listed.filter((project) => project.status === 'active').map(toProjectAuthorityView),
    ];
  }

  return {
    name: 'project-authority',
    async handle(context: ApiRequestContext): Promise<boolean> {
      const { method, pathname, segments } = context;

      // POST /api/projects — create one durable Project from the built-in
      // template snapshot, with the Human membership and any selected Agent
      // memberships in the same atomic submission.
      if (method === 'POST' && pathname === '/api/projects') {
        const body = await context.readBody();
        const displayName = stringField(body, 'displayName');
        if (displayName === undefined) {
          return json(context, 400, { error: 'displayName is required' });
        }
        const rules = parseRules(body['rules']);
        if (rules === 'invalid') {
          return json(context, 400, { error: 'rules must be an array of strings' });
        }
        const routingIntervalMs = body['routingIntervalMs'];
        const agentMemberships = parseAgentMemberships(body['agentMemberships']);
        if (agentMemberships === 'invalid') {
          return json(context, 400, { error: 'agentMemberships must be an array of agent memberships' });
        }
        const id = stringField(body, 'id');
        const goal = stringField(body, 'goal');
        const wakePolicy = stringField(body, 'wakePolicy');
        const reason = stringField(body, 'reason');
        try {
          const project = await projects.create({
            ...(id !== undefined ? { id } : {}),
            displayName,
            ...(goal !== undefined ? { goal } : {}),
            ...(rules !== undefined ? { rules } : {}),
            ...(wakePolicy !== undefined ? { wakePolicy } : {}),
            ...(typeof routingIntervalMs === 'number' ? { routingIntervalMs } : {}),
            ...(agentMemberships !== undefined ? { agentMemberships } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 201, { project: toProjectAuthorityView(project) });
        } catch (error) {
          return projectFailure(context, error);
        }
      }

      // GET /api/projects — preserve the #85 composer/routing list. Archived
      // authority records never appear here, including through a status query;
      // management clients use `/api/projects/authorities` for lifecycle
      // history. Configured legacy Projects remain merged without shadowing.
      if (method === 'GET' && pathname === '/api/projects') {
        const status = statusFilter(context.searchParams.get('status') ?? undefined);
        const listed = status === 'archived' ? [] : await composerCompatibleList();
        return json(context, 200, { projects: listed });
      }

      // GET /api/projects/authorities — the durable authority records only,
      // when both the composer route and this router are mounted.
      if (method === 'GET' && pathname === '/api/projects/authorities') {
        const status = statusFilter(context.searchParams.get('status') ?? undefined);
        const listed = (await projects.list())
          .filter((project) => status === undefined || project.status === status)
          .map(toProjectAuthorityView);
        return json(context, 200, { projects: listed });
      }

      // GET /api/projects/:id — inspect one Project authority record.
      if (
        method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'projects'
      ) {
        const project = await projects.get(segments[2] ?? '');
        if (project === undefined) return json(context, 404, { error: 'unknown project' });
        return json(context, 200, { project: toProjectAuthorityView(project) });
      }

      // POST /api/projects/:id/content — append one content version.
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'projects' &&
        segments[3] === 'content'
      ) {
        const body = await context.readBody();
        const rules = parseRules(body['rules']);
        if (rules === 'invalid') {
          return json(context, 400, { error: 'rules must be an array of strings' });
        }
        const goalField = body['goal'];
        const routingIntervalMs = body['routingIntervalMs'];
        const reason = stringField(body, 'reason');
        const wakePolicy = stringField(body, 'wakePolicy');
        try {
          const project = await projects.updateContent(segments[2] ?? '', {
            // `goal: null` is an explicit clear; an omitted field keeps the
            // current goal; a string replaces it.
            ...(goalField === null
              ? { goal: '' }
              : typeof goalField === 'string'
                ? { goal: goalField }
                : {}),
            ...(rules !== undefined ? { rules } : {}),
            ...(wakePolicy !== undefined ? { wakePolicy } : {}),
            ...(typeof routingIntervalMs === 'number' ? { routingIntervalMs } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { project: toProjectAuthorityView(project) });
        } catch (error) {
          return projectFailure(context, error);
        }
      }

      // POST /api/projects/:id/memberships — add one Agent membership.
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'projects' &&
        segments[3] === 'memberships'
      ) {
        const body = await context.readBody();
        const agentId = stringField(body, 'agentId');
        if (agentId === undefined) {
          return json(context, 400, { error: 'agentId is required' });
        }
        const responsibilities = parseResponsibilities(body['responsibilities']);
        if (responsibilities === 'invalid') {
          return json(context, 400, { error: 'responsibilities must be an array of strings' });
        }
        const collaborationInstructions = stringField(body, 'collaborationInstructions');
        const reason = stringField(body, 'reason');
        try {
          const project = await projects.addMembership(segments[2] ?? '', {
            agentId,
            ...(responsibilities !== undefined ? { responsibilities } : {}),
            ...(collaborationInstructions !== undefined ? { collaborationInstructions } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { project: toProjectAuthorityView(project) });
        } catch (error) {
          return projectFailure(context, error);
        }
      }

      // POST /api/projects/:id/memberships/:memberId/end — end one membership
      // non-destructively (ADR-0008).
      if (
        method === 'POST' &&
        segments.length === 6 &&
        segments[0] === 'api' &&
        segments[1] === 'projects' &&
        segments[3] === 'memberships' &&
        segments[5] === 'end'
      ) {
        const body = await context.readBody();
        const reason = stringField(body, 'reason');
        try {
          const project = await projects.endMembership(segments[2] ?? '', segments[4] ?? '', {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { project: toProjectAuthorityView(project) });
        } catch (error) {
          return projectFailure(context, error);
        }
      }

      // POST /api/projects/:id/archive — non-destructive archive (ADR-0008).
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'projects' &&
        segments[3] === 'archive'
      ) {
        const body = await context.readBody();
        const reason = stringField(body, 'reason');
        try {
          const project = await projects.archive(segments[2] ?? '', {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { project: toProjectAuthorityView(project) });
        } catch (error) {
          return projectFailure(context, error);
        }
      }

      // POST /api/projects/:id/restore — restore an archived Project.
      if (
        method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'projects' &&
        segments[3] === 'restore'
      ) {
        try {
          const project = await projects.restore(segments[2] ?? '');
          return json(context, 200, { project: toProjectAuthorityView(project) });
        } catch (error) {
          return projectFailure(context, error);
        }
      }

      return false;
    },
  };
}

function parseAgentMemberships(
  value: unknown,
):
  | readonly { readonly agentId: string; readonly responsibilities?: readonly string[]; readonly collaborationInstructions?: string }[]
  | 'invalid'
  | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return 'invalid';
  const memberships: {
    readonly agentId: string;
    readonly responsibilities?: readonly string[];
    readonly collaborationInstructions?: string;
  }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const record = entry as Record<string, unknown>;
    const agentId = record['agentId'];
    if (typeof agentId !== 'string') return 'invalid';
    const responsibilities = parseResponsibilities(record['responsibilities']);
    if (responsibilities === 'invalid') return 'invalid';
    const collaborationInstructions = record['collaborationInstructions'];
    if (collaborationInstructions !== undefined && typeof collaborationInstructions !== 'string') {
      return 'invalid';
    }
    memberships.push({
      agentId,
      ...(responsibilities !== undefined ? { responsibilities } : {}),
      ...(collaborationInstructions !== undefined
        ? { collaborationInstructions }
        : {}),
    });
  }
  return memberships;
}
