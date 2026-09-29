import type { ApiRequestContext, ApiRouter } from './router.ts';
import { ConversationScopeError, type ConversationActor } from '../conversation/model.ts';
import type { ConversationScopeService } from '../conversation/service.ts';
import { redactSensitiveText } from '../environment/privacy.ts';
import {
  toConversationScopeView,
  toScopeContextView,
  toScopeStateView,
} from './views.ts';

/**
 * The conversation scope and Working group router (#95).
 *
 * A domain-owned route set composed through the #85 additive seam. Every route
 * delegates to the conversation scope service, so Project-channel invariants,
 * direct-conversation identity, creator/Human management authority, disband
 * and restore, ended-membership behaviour, and the read-only admission state
 * have exactly one implementation and the transport keeps none.
 *
 * Authority: these routes sit behind the #84 operator browser boundary, so
 * every command resolves its actor through the Project's Human membership —
 * the authenticated Human manages any Working group by construction
 * (ADR-0008), and the service still validates each actor against the Project.
 *
 * Privacy: no route accepts or returns a credential, provider or account
 * identity, hostname, address, absolute path, or raw command. Free text passes
 * the scope module's write boundary before it becomes durable, and the read
 * projections re-apply the boundary so a legacy document cannot leak through
 * the API.
 */

export interface ConversationRouterOptions {
  readonly scopes: ConversationScopeService;
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

/** Parse an optional string array, refusing a non-array. */
function parseStringArray(value: unknown): readonly string[] | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return 'invalid';
  return value as readonly string[];
}

const INVALID_CODES = new Set([
  'invalid-identity',
  'invalid-display-name',
  'invalid-participants',
  'invalid-content',
]);

const NOT_FOUND_CODES = new Set([
  'unknown-project',
  'unknown-scope',
  'unknown-working-group',
]);

/**
 * Shape one scope error onto the established HTTP contract: unknown targets
 * are 404, malformed input is 400, an authority refusal is 403, and every
 * lifecycle or membership conflict is 409 (F4). The typed code is the stable
 * contract; the message passes the privacy boundary as defence in depth, so a
 * diagnostic raised anywhere along the service path can never carry a host
 * path, credential, or machine identity onto the wire (#87).
 */
function conversationFailure(context: ApiRequestContext, error: unknown): boolean {
  if (error instanceof ConversationScopeError) {
    const status = NOT_FOUND_CODES.has(error.code)
      ? 404
      : INVALID_CODES.has(error.code)
        ? 400
        : error.code === 'management-authority-required'
          ? 403
          : 409;
    return json(context, status, { error: redactSensitiveText(error.message), code: error.code });
  }
  context.response.writeHead(500, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify({ error: 'the request could not be completed' }));
  return true;
}

export function createConversationRouter(options: ConversationRouterOptions): ApiRouter {
  const { scopes } = options;

  /**
   * The acting member for one Project-scoped command: the local Human resolved
   * from the Project's membership, so a command behind the operator boundary
   * never trusts a client-supplied identity.
   */
  async function humanActor(projectId: string): Promise<ConversationActor> {
    return scopes.humanAuthority(projectId);
  }

  return {
    name: 'conversation-scopes',
    async handle(context: ApiRequestContext): Promise<boolean> {
      const { method, segments } = context;
      const isProjectRoute = segments[0] === 'api' && segments[1] === 'projects';
      const isWorkingGroupRoute = segments[0] === 'api' && segments[1] === 'working-groups';
      const isScopeRoute = segments[0] === 'api' && segments[1] === 'scopes';
      const projectId = segments[2] ?? '';

      // GET /api/projects/:id/scopes — every scope of one Project: the
      // invariant Project channel (ensured), direct conversations, and Working
      // groups, with participation ends materialized first.
      if (method === 'GET' && segments.length === 4 && isProjectRoute && segments[3] === 'scopes') {
        try {
          const listed = await scopes.listScopes(projectId);
          return json(context, 200, { scopes: listed.map(toConversationScopeView) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/projects/:id/scopes/direct — open (idempotently) one
      // Project-scoped direct conversation between two current members.
      if (method === 'POST' && segments.length === 5 && isProjectRoute && segments[3] === 'scopes' && segments[4] === 'direct') {
        const body = await context.readBody();
        const participants = parseStringArray(body['participants']);
        if (participants === 'invalid') {
          return json(context, 400, { error: 'participants must be an array of two member ids' });
        }
        try {
          const scope = await scopes.openDirect({ projectId, participants: participants ?? [] });
          return json(context, 201, { scope: toConversationScopeView(scope) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // GET /api/projects/:id/working-groups — every Working group of a Project.
      if (method === 'GET' && segments.length === 4 && isProjectRoute && segments[3] === 'working-groups') {
        try {
          const listed = await scopes.listWorkingGroups(projectId);
          return json(context, 200, { workingGroups: listed.map(toConversationScopeView) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/projects/:id/working-groups — create one Working group and
      // its channel in one atomic durable write, with the Human as creator.
      if (method === 'POST' && segments.length === 4 && isProjectRoute && segments[3] === 'working-groups') {
        const body = await context.readBody();
        const displayName = stringField(body, 'displayName');
        if (displayName === undefined) {
          return json(context, 400, { error: 'displayName is required' });
        }
        const memberIds = parseStringArray(body['memberIds']);
        if (memberIds === 'invalid') {
          return json(context, 400, { error: 'memberIds must be an array of member ids' });
        }
        const rules = parseStringArray(body['rules']);
        if (rules === 'invalid') {
          return json(context, 400, { error: 'rules must be an array of strings' });
        }
        const goal = stringField(body, 'goal');
        const reason = stringField(body, 'reason');
        try {
          const creator = await humanActor(projectId);
          const group = await scopes.createWorkingGroup({
            projectId,
            displayName,
            creator,
            ...(memberIds !== undefined ? { memberIds } : {}),
            ...(goal !== undefined ? { goal } : {}),
            ...(rules !== undefined ? { rules } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 201, { workingGroup: toConversationScopeView(group) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // GET /api/working-groups/:id — inspect one Working group record.
      if (method === 'GET' && segments.length === 3 && isWorkingGroupRoute) {
        try {
          const group = await scopes.getWorkingGroup(segments[2] ?? '');
          if (group === undefined) return json(context, 404, { error: 'unknown working group' });
          return json(context, 200, { workingGroup: toConversationScopeView(group) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/working-groups/:id/content — append one content version
      // (name, goal, or rules); earlier versions are never rewritten.
      if (method === 'POST' && segments.length === 4 && isWorkingGroupRoute && segments[3] === 'content') {
        const body = await context.readBody();
        const rules = parseStringArray(body['rules']);
        if (rules === 'invalid') {
          return json(context, 400, { error: 'rules must be an array of strings' });
        }
        const displayName = stringField(body, 'displayName');
        const goalField = body['goal'];
        const reason = stringField(body, 'reason');
        try {
          const group = await scopes.getWorkingGroup(segments[2] ?? '');
          if (group === undefined) return json(context, 404, { error: 'unknown working group' });
          const actor = await humanActor(group.projectId);
          const updated = await scopes.updateWorkingGroup(group.id, actor, {
            ...(displayName !== undefined ? { displayName } : {}),
            ...(goalField === null
              ? { goal: '' }
              : typeof goalField === 'string'
                ? { goal: goalField }
                : {}),
            ...(rules !== undefined ? { rules } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { workingGroup: toConversationScopeView(updated) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/working-groups/:id/members — add one current Project member.
      if (method === 'POST' && segments.length === 4 && isWorkingGroupRoute && segments[3] === 'members') {
        const body = await context.readBody();
        const memberId = stringField(body, 'memberId');
        if (memberId === undefined) {
          return json(context, 400, { error: 'memberId is required' });
        }
        const reason = stringField(body, 'reason');
        try {
          const group = await scopes.getWorkingGroup(segments[2] ?? '');
          if (group === undefined) return json(context, 404, { error: 'unknown working group' });
          const actor = await humanActor(group.projectId);
          const updated = await scopes.addWorkingGroupMember(group.id, actor, memberId, {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { workingGroup: toConversationScopeView(updated) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/working-groups/:id/members/:memberId/end — end one
      // participation non-destructively; history and attribution remain.
      if (
        method === 'POST' &&
        segments.length === 6 &&
        isWorkingGroupRoute &&
        segments[3] === 'members' &&
        segments[5] === 'end'
      ) {
        const body = await context.readBody();
        const reason = stringField(body, 'reason');
        try {
          const group = await scopes.getWorkingGroup(segments[2] ?? '');
          if (group === undefined) return json(context, 404, { error: 'unknown working group' });
          const actor = await humanActor(group.projectId);
          const updated = await scopes.endWorkingGroupMember(group.id, actor, segments[4] ?? '', {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { workingGroup: toConversationScopeView(updated) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/working-groups/:id/disband — the channel becomes read-only;
      // configuration, membership changes, and history are preserved.
      if (method === 'POST' && segments.length === 4 && isWorkingGroupRoute && segments[3] === 'disband') {
        const body = await context.readBody();
        const reason = stringField(body, 'reason');
        try {
          const group = await scopes.getWorkingGroup(segments[2] ?? '');
          if (group === undefined) return json(context, 404, { error: 'unknown working group' });
          const actor = await humanActor(group.projectId);
          const updated = await scopes.disbandWorkingGroup(group.id, actor, {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { workingGroup: toConversationScopeView(updated) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // POST /api/working-groups/:id/restore — restore one disbanded Working
      // group when its current members are still eligible. The transition
      // appends an attributed lifecycle event (actor, time, reason), like
      // disband, so every transition stays auditable.
      if (method === 'POST' && segments.length === 4 && isWorkingGroupRoute && segments[3] === 'restore') {
        const body = await context.readBody();
        const reason = stringField(body, 'reason');
        try {
          const group = await scopes.getWorkingGroup(segments[2] ?? '');
          if (group === undefined) return json(context, 404, { error: 'unknown working group' });
          const actor = await humanActor(group.projectId);
          const updated = await scopes.restoreWorkingGroup(group.id, actor, {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { workingGroup: toConversationScopeView(updated) });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      // GET /api/scopes/:id — one scope projected for the Human: the durable
      // record, its read-only admission state, and the governing Project and
      // Working group goal/rules versions (never merged).
      if (method === 'GET' && segments.length === 3 && isScopeRoute) {
        const scopeId = segments[2] ?? '';
        try {
          const scope = await scopes.getScope(scopeId);
          if (scope === undefined) return json(context, 404, { error: 'unknown scope' });
          const actor = await humanActor(scope.projectId);
          const inspection = await scopes.inspectScope(scopeId, actor);
          return json(context, 200, {
            scope: toConversationScopeView(inspection.scope),
            state: toScopeStateView(inspection.state),
            context: toScopeContextView(inspection.context),
          });
        } catch (error) {
          return conversationFailure(context, error);
        }
      }

      return false;
    },
  };
}
