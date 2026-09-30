import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { createHash } from 'node:crypto';

import { WebSocketServer } from 'ws';
import { createWebSocketStream } from 'ws';

import type { RunOrchestrator } from '../run/orchestrator.ts';
import type { AgentRegistry } from '../agent/registry.ts';
import type { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import { MessageDeliveryError } from '../collaboration/coordinator.ts';
import type { MessageAuthor } from '../collaboration/model.ts';
import { ProjectEventError } from '../collaboration/events.ts';
import { ConversationScopeError } from '../conversation/model.ts';
import type { ConversationScopeService } from '../conversation/service.ts';
import { redactSensitiveText } from '../environment/privacy.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { TaskService } from '../task/service.ts';
import type { TaskStatus } from '../task/model.ts';
import { TaskRecoveryRefusal } from '../task/environment-lifecycle.ts';
import type { OperatorSessionService, AuthenticatedBrowserSession } from '../auth/service.ts';
import { composeApiRouters, type ApiRouter } from './router.ts';
import type { WorkerGateway } from '../worker/gateway.ts';
import {
  summarizeRunHistory,
  toMessageView,
  toProjectEventView,
  toProjectView,
  toRoutingBatchDetailView,
  toRoutingEvidenceView,
  toRoutingWindowView,
  toRunView,
  toTaskView,
  toTaskWithRunsView,
  toWakeView,
} from './views.ts';

/**
 * `views.ts` owns the wire contract. Re-exported here so the M1 transport's
 * existing importers keep working; new callers (M2 routers, browser adapters)
 * import from `views.ts` directly.
 */
export * from './views.ts';

/** The single machine-authenticated Worker upgrade path (ADR-0012). */
export const WORKER_CONNECT_PATH = '/api/worker/connect';

/**
 * The Web seam for M1.
 *
 * Deliberately plain: the HTTP framework, UI library, and progress transport are
 * deferred decisions (ADR-0002), so this module uses `node:http` and
 * server-sent events and keeps no domain logic. Every route delegates to the
 * orchestrator or the collaboration coordinator, which is why the client needs
 * no knowledge of leases, engines, wakes, or the wake contract.
 */

export interface RunApiOptions {
  readonly orchestrator: RunOrchestrator;
  /** The agents a user can address; exposed read-only for the client. */
  readonly agents: AgentRegistry;
  /**
   * The collaboration plane, when this build serves a project channel (#26).
   *
   * Optional so a build with no collaboration configured (and the run-only tests)
   * stays unchanged. When present, the message routes below are enabled; the
   * routes keep no wake logic of their own, delegating every decision to the
   * coordinator so the wake contract has exactly one implementation.
   */
  readonly collaboration?: CollaborationCoordinator;
  /**
   * The conversation-scope authority Message delivery governs against (#95,
   * #96).
   *
   * Required beside `collaboration`: a Message is posted to exactly one scope,
   * and the routes resolve the scope, the acting author's admission state, and
   * the Project's Human membership from this service rather than trusting
   * request JSON. Without it the message routes are not served.
   */
  readonly conversationScopes?: ConversationScopeService;
  /**
   * The projects the client may address (#27).
   *
   * Optional like `collaboration`: a run-only build serves no project list, and
   * the message composer has nothing to address without a project channel.
   */
  readonly projects?: ProjectRegistry;
  /**
   * Durable multi-run Tasks (#28).
   *
   * Optional so a build with no Task plane (and the run-only tests) stays
   * unchanged. When present, the `/api/tasks` routes are enabled; they keep no
   * domain logic, delegating creation, advancement, and state transitions to the
   * service so the Task lifecycle has exactly one implementation.
   */
  readonly tasks?: TaskService;
  /**
   * M2's one-Operator browser boundary. Omitted only for the preserved M1
   * transport seam and its direct contract tests; runtime composition supplies
   * it and then every API read/write is session-authenticated.
   */
  readonly auth?: OperatorSessionService;
  /** Static files (the Vite build) to serve alongside the API. */
  readonly staticRoot?: string;
  readonly readFile?: (path: string) => Promise<Buffer | undefined>;
  /** Interval for SSE heartbeat events. Exposed so tests need not wait. */
  readonly keepAliveMs?: number;
  /** Additive M2 domain routers, run after transport authorization. */
  readonly routers?: readonly ApiRouter[];
  /**
   * The enrollment-backed outbound Worker gateway (#115). When present, the
   * transport accepts the machine-authenticated WS/WSS upgrade at
   * `/api/worker/connect`; it is deliberately independent of the Human browser
   * session and CSRF boundary.
   */
  readonly workerGateway?: WorkerGateway;
}

export interface RunApi {
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ readonly port: number }>;
  close(): Promise<void>;
}

export function createRunApi(options: RunApiOptions): RunApi {
  const { orchestrator, agents, collaboration, conversationScopes, projects, tasks, auth } = options;
  /** Open event streams, so `close` can end them instead of hanging. */
  const streams = new Set<ServerResponse>();
  const additiveRouters = composeApiRouters(options.routers ?? []);
  const eventLog = new SseEventLog();
  // One subscription fans out through the cursor log. This avoids one
  // orchestrator subscription per browser and gives reconnects a stable replay
  // boundary without changing the durable Run/event contract.
  const unsubscribeRunEvents = orchestrator.subscribe((run, replaySequence) =>
    eventLog.publish(toRunView(run), replaySequence),
  );
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: responseError(error, auth !== undefined),
      });
    });
  });

  // The machine-authentication boundary (#115). A Worker initiates this upgrade
  // off-loopback only over WSS; loopback may use WS. It is handled before the
  // browser `request` path and never reads a cookie, CSRF token, or Human actor.
  if (options.workerGateway !== undefined) {
    const gateway = options.workerGateway;
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== WORKER_CONNECT_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const encrypted = (request.socket as TLSSocket).encrypted === true;
        const remoteAddress = request.socket.remoteAddress ?? undefined;
        void (async () => {
          const stream = createWebSocketStream(ws);
          const outcome = await gateway.handle(stream, {
            secure: encrypted,
            remoteAddress,
          });
          // After acceptance the stream *is* the Worker JSON-RPC channel. The
          // gateway notifies its accept listeners (the enrollment worker port),
          // which owns the core-side handle from here.
          if (!outcome.accepted) ws.close();
        })();
      });
    });
    server.on('close', () => {
      wss.close();
      gateway.close();
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let segments: string[];
    try {
      // Split before decoding so an encoded slash remains inside one path id.
      // Decode exactly once at the dispatcher, not independently in each route.
      segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
    } catch {
      sendJson(response, 400, { error: 'invalid URL path encoding' });
      return;
    }
    // A request stream is one-shot. Routers and preserved routes share this
    // memoized reader so an exploratory router cannot consume another route's
    // command payload.
    const readBody = memoizedJsonReader(request);
    let browserSession: AuthenticatedBrowserSession | undefined;

    // The machine-authentication boundary (#115) runs *before* the Human browser
    // boundary and never reads a cookie, CSRF token, or Human actor. A Worker
    // proves identity with its host-local key and a one-use claim, not with a
    // browser session.
    if (
      options.workerGateway !== undefined &&
      (await options.workerGateway.handleHttpRequest({
        method: request.method,
        pathname: url.pathname,
        segments,
        readBody,
        json: (status, body) => sendJson(response, status, body),
      }))
    ) {
      return;
    }

    // Credential exchange is the only anonymous API operation. The credential
    // is sent in a POST body (never a URL) and succeeds by setting an HTTP-only
    // browser cookie; the response exposes only the separate CSRF value.
    if (auth && request.method === 'POST' && url.pathname === '/api/auth/session') {
      if (!(await auth.isConfigured())) {
        sendJson(response, 503, { error: 'operator access is unavailable; initialize it on the host' });
        return;
      }
      const body = await readBody();
      const credential = typeof body.credential === 'string' ? body.credential : '';
      const signedIn = await auth.signIn(credential);
      if (!signedIn) {
        sendJson(response, 401, { error: 'authentication failed' });
        return;
      }
      response.setHeader('set-cookie', sessionCookie(signedIn.bearerToken, signedIn.expiresAt, isTransportSecure(request)));
      sendJson(response, 201, { csrfToken: signedIn.csrfToken });
      return;
    }

    if (auth && url.pathname.startsWith('/api/')) {
      const authentication = await auth.authenticate(readCookie(request, 'sprout_session'));
      if (!authentication.authenticated) {
        sendJson(response, 401, { error: 'authentication required' });
        return;
      }
      browserSession = authentication.session;
      // A successful request renews the rolling idle cookie only up to the
      // persisted absolute lifetime. The server independently enforces both.
      response.setHeader('set-cookie', sessionCookie(readCookie(request, 'sprout_session')!, browserSession.expiresAt, isTransportSecure(request)));
      if (!isSafeMethod(request.method) && !(await auth.verifyRequestForgery(browserSession.id, headerValue(request, 'x-sprout-csrf')))) {
        sendJson(response, 403, { error: 'request-forgery protection failed' });
        return;
      }
    }

    if (auth && request.method === 'GET' && url.pathname === '/api/auth/sessions') {
      const csrfToken = await auth.refreshRequestForgeryToken(browserSession!.id);
      if (!csrfToken) {
        sendJson(response, 401, { error: 'authentication required' });
        return;
      }
      sendJson(response, 200, { sessions: await auth.listSessions(browserSession!.id), csrfToken });
      return;
    }

    if (auth && request.method === 'DELETE' && url.pathname === '/api/auth/session') {
      await auth.revokeCurrentSession(browserSession!.id);
      response.setHeader('set-cookie', expiredSessionCookie(isTransportSecure(request)));
      sendJson(response, 200, { signedOut: true });
      return;
    }

    if (auth && request.method === 'POST' && url.pathname === '/api/auth/sessions/revoke-others') {
      sendJson(response, 200, { revoked: await auth.revokeOtherSessions(browserSession!.id) });
      return;
    }

    if (
      auth &&
      request.method === 'POST' &&
      segments.length === 5 &&
      segments[0] === 'api' &&
      segments[1] === 'auth' &&
      segments[2] === 'sessions' &&
      segments[4] === 'revoke'
    ) {
      const id = segments[3] ?? '';
      const revoked = await auth.revokeSession(id);
      if (!revoked) {
        sendJson(response, 404, { error: 'session is unavailable' });
        return;
      }
      if (id === browserSession!.id) response.setHeader('set-cookie', expiredSessionCookie(isTransportSecure(request)));
      sendJson(response, 200, { revoked: true });
      return;
    }

    if (
      await additiveRouters.handle({
        method: request.method,
        response,
        pathname: url.pathname,
        searchParams: url.searchParams,
        segments,
        ...(browserSession !== undefined ? { operatorSessionId: browserSession.id } : {}),
        readBody,
      })
    ) {
      return;
    }

    // POST /api/messages — deliver one Message to one conversation scope and
    // wake whoever the deterministic wake contract addresses (#96). The scope
    // is the single source of the Message's Project, channel, and admission
    // state; the routes keep no routing logic of their own.
    if (
      request.method === 'POST' &&
      url.pathname === '/api/messages' &&
      collaboration &&
      conversationScopes
    ) {
      const body = await readBody();
      const scopeId = typeof body.scopeId === 'string' ? body.scopeId : '';
      const text = typeof body.body === 'string' ? body.body : '';
      const deliveryKey = typeof body.deliveryKey === 'string' ? body.deliveryKey : '';
      const awaitReply = body.awaitReply !== false;
      if (scopeId === '' || text === '' || deliveryKey === '') {
        sendJson(response, 400, { error: 'scopeId, body, and deliveryKey are required' });
        return;
      }
      // An authenticated browser is the only source of Human authority. In the
      // protected runtime an Agent/Worker cannot select an authority kind or a
      // different Human id through request JSON.
      if (auth && (body.authorKind === 'agent' || body.authorKind === 'worker')) {
        sendJson(response, 403, { error: 'browser commands are Human-only' });
        return;
      }
      const scope = await conversationScopes.getScope(scopeId);
      if (scope === undefined) {
        sendJson(response, 404, { error: `unknown conversation scope: ${scopeId}` });
        return;
      }
      const recipients = body.recipients;
      if (
        recipients !== undefined &&
        (!Array.isArray(recipients) || !recipients.every((value) => typeof value === 'string'))
      ) {
        sendJson(response, 400, { error: 'recipients must be an array of member ids' });
        return;
      }
      if (scope.kind !== 'direct' && Array.isArray(recipients) && recipients.length > 0) {
        sendJson(response, 400, { error: 'only direct messages can name recipients' });
        return;
      }
      let author: MessageAuthor;
      if (auth) {
        // The acting author is the Project's Human membership resolved from the
        // authority, never a client-supplied identity.
        try {
          const actor = await conversationScopes.humanAuthority(scope.projectId);
          author = { id: actor.memberId, kind: actor.kind };
        } catch (error) {
          sendDomainFailure(response, error);
          return;
        }
      } else {
        const authorId = typeof body.authorId === 'string' ? body.authorId : '';
        if (authorId === '') {
          sendJson(response, 400, { error: 'authorId is required' });
          return;
        }
        author = { id: authorId, kind: body.authorKind === 'agent' ? 'agent' : 'human' };
      }
      let delivered: Awaited<ReturnType<CollaborationCoordinator['deliver']>>;
      try {
        delivered = await collaboration.deliver({
          scopeId,
          author,
          body: text,
          ...(Array.isArray(recipients) ? { recipients: recipients as readonly string[] } : {}),
          deliveryKey,
          awaitReply,
        });
      } catch (error) {
        sendDomainFailure(response, error);
        return;
      }
      sendJson(response, delivered.duplicate ? 200 : 202, {
        message: toMessageView(delivered.message),
        duplicate: delivered.duplicate,
        wakes: delivered.wakes.map(toWakeView),
        admittedRunIds: delivered.admittedRunIds,
      });
      return;
    }

    // GET /api/messages — the durable conversation, newest last; optionally
    // restricted to one conversation scope with ?scopeId=.
    if (request.method === 'GET' && url.pathname === '/api/messages' && collaboration) {
      const scopeId = url.searchParams.get('scopeId');
      const messages = await collaboration.listMessages(
        scopeId !== null && scopeId !== '' ? { scopeId } : undefined,
      );
      sendJson(response, 200, {
        messages: messages.map(toMessageView),
      });
      return;
    }

    // GET /api/messages/:id/observations — why a Message woke nobody (if it did not).
    if (
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'messages' &&
      segments[3] === 'observations' &&
      collaboration
    ) {
      const messageId = segments[2] ?? '';
      const message = await collaboration.listMessages().then((messages) =>
        messages.find((candidate) => candidate.id === messageId),
      );
      if (!message) {
        sendJson(response, 404, { error: `unknown message: ${messageId}` });
        return;
      }
      sendJson(response, 200, {
        observations: await collaboration.listObservations(messageId),
        wakes: (await collaboration.listWakeRequests())
          .filter((wake) => wake.inputId === messageId)
          .map(toWakeView),
      });
      return;
    }

    // GET /api/projects/:id/events — durable Project events with their declared
    // routing dispositions (#96, ADR-0007). Events are system-produced, so
    // publication stays an in-process Module contract; this route is read-only
    // evidence.
    if (
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments[3] === 'events' &&
      collaboration
    ) {
      const events = await collaboration.listEvents(segments[2] ?? '');
      sendJson(response, 200, { events: events.map(toProjectEventView) });
      return;
    }

    // GET /api/project-events/:id/observations — the routing evidence for one
    // Project event: its wake requests and durable non-wake outcomes.
    if (
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'project-events' &&
      segments[3] === 'observations' &&
      collaboration
    ) {
      const eventId = segments[2] ?? '';
      const event = (await collaboration.listEvents()).find(
        (candidate) => candidate.id === eventId,
      );
      if (!event) {
        sendJson(response, 404, { error: `unknown project event: ${eventId}` });
        return;
      }
      sendJson(response, 200, {
        event: toProjectEventView(event),
        observations: await collaboration.listObservations(event.id),
        wakes: (await collaboration.listWakeRequests())
          .filter((wake) => wake.inputId === event.id)
          .map(toWakeView),
      });
      return;
    }

    // GET /api/projects/:id/routing-batches — the durable assisted-routing
    // evidence for one Project: collection windows and frozen batches (#97,
    // ADR-0007). Read-only; the MVP exposes no routing controls.
    if (
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments[3] === 'routing-batches' &&
      collaboration
    ) {
      const projectId = segments[2] ?? '';
      const [windows, batches] = await Promise.all([
        collaboration.listRoutingWindows(projectId),
        collaboration.listRoutingBatches(projectId),
      ]);
      sendJson(response, 200, {
        windows: windows.map(toRoutingWindowView),
        batches: batches.map((batch) => ({
          id: batch.id,
          projectId: batch.projectId,
          windowId: batch.windowId,
          splitIndex: batch.splitIndex,
          splitCount: batch.splitCount,
          cutoffAt: batch.cutoffAt,
          status: batch.status,
          ...(batch.error !== undefined ? { error: batch.error } : {}),
          createdAt: batch.createdAt,
          ...(batch.settledAt !== undefined ? { settledAt: batch.settledAt } : {}),
        })),
      });
      return;
    }

    // GET /api/routing-batches/:id — the complete causal evidence for one
    // frozen batch: window, inputs (with truncation markers), attempts,
    // per-input outcomes, WakeRequests, and projected replies.
    if (
      request.method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'routing-batches' &&
      collaboration
    ) {
      const evidence = await collaboration.getRoutingBatchEvidence(segments[2] ?? '');
      if (evidence === undefined) {
        sendJson(response, 404, { error: `unknown routing batch: ${segments[2] ?? ''}` });
        return;
      }
      sendJson(response, 200, { routingBatch: toRoutingBatchDetailView(evidence) });
      return;
    }

    // GET /api/messages/:id/routing — the causal routing chain of one Message:
    // collection window, batches with attempts and outcomes, deterministic
    // wakes, and durable non-wake observations.
    if (
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'messages' &&
      segments[3] === 'routing' &&
      collaboration
    ) {
      const evidence = await collaboration.routingEvidenceForInput(segments[2] ?? '');
      if (evidence === undefined) {
        sendJson(response, 404, { error: `unknown message: ${segments[2] ?? ''}` });
        return;
      }
      sendJson(response, 200, { routing: toRoutingEvidenceView(evidence) });
      return;
    }

    // GET /api/project-events/:id/routing — the same causal chain for one
    // Project event (`wake-eligible` inputs route through batches).
    if (
      request.method === 'GET' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'project-events' &&
      segments[3] === 'routing' &&
      collaboration
    ) {
      const evidence = await collaboration.routingEvidenceForInput(segments[2] ?? '');
      if (evidence === undefined) {
        sendJson(response, 404, { error: `unknown project event: ${segments[2] ?? ''}` });
        return;
      }
      sendJson(response, 200, { routing: toRoutingEvidenceView(evidence) });
      return;
    }

    // GET /api/projects — the projects and members the client may address (#27).
    if (request.method === 'GET' && url.pathname === '/api/projects' && projects) {
      sendJson(response, 200, { projects: projects.list().map(toProjectView) });
      return;
    }

    // POST /api/tasks — create a durable multi-run Task (#28).
    if (request.method === 'POST' && url.pathname === '/api/tasks' && tasks) {
      const body = await readBody();
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      const title = typeof body.title === 'string' ? body.title : '';
      const goal = typeof body.goal === 'string' ? body.goal : '';
      if (projectId === '' || title === '' || goal === '') {
        sendJson(response, 400, { error: 'projectId, title, and goal are required' });
        return;
      }
      const constraints = parseStringArray(body.constraints);
      if (body.constraints !== undefined && constraints === undefined) {
        sendJson(response, 400, { error: 'constraints must be an array of strings' });
        return;
      }
      const status = parseTaskStatus(body.status);
      if (status === 'invalid') {
        sendJson(response, 400, { error: `unknown task status: ${String(body.status)}` });
        return;
      }
      const preference = parseEnvironmentPreference(body.environmentPreference);
      if (preference === 'invalid') {
        sendJson(response, 400, {
          error: 'environmentPreference must be { kind: "definition" | "instance", id }',
        });
        return;
      }
      const task = await tasks.create({
        projectId,
        title,
        goal,
        ...(constraints !== undefined ? { constraints } : {}),
        ...(typeof body.assignedAgentId === 'string' ? { assignedAgentId: body.assignedAgentId } : {}),
        ...(preference !== undefined && preference !== null
          ? { environmentPreference: preference }
          : {}),
        ...(status !== undefined ? { status } : {}),
      });
      sendJson(response, 201, { task: toTaskView(task) });
      return;
    }

    // GET /api/tasks — list Tasks, filterable by project or status.
    if (request.method === 'GET' && url.pathname === '/api/tasks' && tasks) {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const status = parseTaskStatus(url.searchParams.get('status'));
      if (status === 'invalid') {
        sendJson(response, 400, { error: `unknown task status: ${url.searchParams.get('status')}` });
        return;
      }
      const list = await tasks.list({
        ...(projectId !== undefined ? { projectId } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      sendJson(response, 200, { tasks: list.map(toTaskView) });
      return;
    }

    // POST /api/tasks/:id/runs — advance a Task with one new linked run.
    if (
      request.method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'tasks' &&
      segments[3] === 'runs' &&
      tasks
    ) {
      const taskId = segments[2] ?? '';
      if ((await tasks.get(taskId)) === undefined) {
        sendJson(response, 404, { error: `unknown task: ${taskId}` });
        return;
      }
      const body = await readBody();
      const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
      const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
      try {
        const advanced = await tasks.advance(taskId, {
          ...(agentId !== undefined ? { agentId } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
        });
        sendJson(response, 202, {
          task: toTaskView(advanced.task),
          runId: advanced.runId,
        });
      } catch (error) {
        // The Task exists, so a refusal here is a lifecycle conflict (terminal or
        // unassigned), not a missing resource.
        sendJson(response, 409, {
          error: responseError(error, auth !== undefined),
        });
      }
      return;
    }

    // POST /api/tasks/:id/begin — select and retain a Task-held environment.
    if (request.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'tasks' && segments[3] === 'begin' && tasks) {
      const taskId = segments[2] ?? '';
      if ((await tasks.get(taskId)) === undefined) { sendJson(response, 404, { error: `unknown task: ${taskId}` }); return; }
      const body = await readBody();
      const selection = parseEnvironmentPreference(body.selection);
      if (selection === 'invalid' || selection === null) { sendJson(response, 400, { error: 'selection must be { kind: "definition" | "instance", id }' }); return; }
      try {
        sendJson(response, 200, { task: toTaskView(await tasks.begin(taskId, {
          ...(typeof body.agentId === 'string' ? { agentId: body.agentId } : {}),
          ...(selection !== undefined ? { selection } : {}),
        })) });
      } catch (error) { sendJson(response, 409, { error: responseError(error, auth !== undefined) }); }
      return;
    }

    // POST /api/tasks/:id/end — cleanup then release the retained lease.
    if (request.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'tasks' && segments[3] === 'end' && tasks) {
      const taskId = segments[2] ?? '';
      if ((await tasks.get(taskId)) === undefined) { sendJson(response, 404, { error: `unknown task: ${taskId}` }); return; }
      try { sendJson(response, 200, { task: toTaskView(await tasks.end(taskId)) }); }
      catch (error) { sendJson(response, 409, { error: responseError(error, auth !== undefined) }); }
      return;
    }

    // POST /api/tasks/:id/recovery — only the Task owner can resume or discard.
    if (request.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'tasks' && segments[3] === 'recovery' && tasks) {
      const taskId = segments[2] ?? '';
      if ((await tasks.get(taskId)) === undefined) { sendJson(response, 404, { error: `unknown task: ${taskId}` }); return; }
      const body = await readBody();
      if (body.action !== 'resume' && body.action !== 'discard') { sendJson(response, 400, { error: 'action must be resume or discard' }); return; }
      try { sendJson(response, 200, { task: toTaskView(await tasks.recover(taskId, body.action)) }); }
      catch (error) {
        // #171: a recovery refusal is product-owned text and domain ids, so an
        // authenticated session sees the actionable reason rather than the
        // generic protected failure. Every other error keeps the privacy mask.
        if (error instanceof TaskRecoveryRefusal) {
          sendJson(response, 409, { error: error.message, code: error.code });
          return;
        }
        sendJson(response, 409, { error: responseError(error, auth !== undefined) });
      }
      return;
    }

    // POST /api/tasks/:id/validation — retain the binding while a human checks work.
    if (request.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'tasks' && segments[3] === 'validation' && tasks) {
      const taskId = segments[2] ?? '';
      if ((await tasks.get(taskId)) === undefined) { sendJson(response, 404, { error: `unknown task: ${taskId}` }); return; }
      try { sendJson(response, 200, { task: toTaskView(await tasks.awaitHumanValidation(taskId)) }); }
      catch (error) { sendJson(response, 409, { error: responseError(error, auth !== undefined) }); }
      return;
    }

    // GET /api/tasks/:id — one Task with its ordered run links.
    if (
      request.method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'tasks' &&
      tasks
    ) {
      const taskId = segments[2] ?? '';
      const found = await tasks.getWithRuns(taskId);
      if (!found) {
        sendJson(response, 404, { error: `unknown task: ${taskId}` });
        return;
      }
      sendJson(response, 200, toTaskWithRunsView(found));
      return;
    }

    // PATCH /api/tasks/:id — update status, constraints, blocker reason, etc.
    if (
      request.method === 'PATCH' &&
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'tasks' &&
      tasks
    ) {
      const taskId = segments[2] ?? '';
      if ((await tasks.get(taskId)) === undefined) {
        sendJson(response, 404, { error: `unknown task: ${taskId}` });
        return;
      }
      const body = await readBody();
      const status = parseTaskStatus(body.status);
      if (status === 'invalid') {
        sendJson(response, 400, { error: `unknown task status: ${String(body.status)}` });
        return;
      }
      const constraints = parseStringArray(body.constraints);
      if (constraints === undefined && body.constraints !== undefined) {
        sendJson(response, 400, { error: 'constraints must be an array of strings' });
        return;
      }
      const preference = parseEnvironmentPreference(body.environmentPreference);
      if (preference === 'invalid') {
        sendJson(response, 400, {
          error: 'environmentPreference must be { kind: "definition" | "instance", id } or null',
        });
        return;
      }
      try {
      const updated = await tasks.update(taskId, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.goal === 'string' ? { goal: body.goal } : {}),
        ...(constraints !== undefined ? { constraints } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(body.assignedAgentId === null
          ? { assignedAgentId: null }
          : typeof body.assignedAgentId === 'string'
            ? { assignedAgentId: body.assignedAgentId }
            : {}),
        ...(preference === null
          ? { environmentPreference: null }
          : preference !== undefined
            ? { environmentPreference: preference }
            : {}),
        ...(body.blockerReason === null
          ? { blockerReason: null }
          : typeof body.blockerReason === 'string'
            ? { blockerReason: body.blockerReason }
            : {}),
      });
      sendJson(response, 200, { task: toTaskView(updated) });
      } catch (error) {
        sendJson(response, 409, { error: responseError(error, auth !== undefined) });
      }
      return;
    }

    // POST /api/runs — submit a request to an agent.
    if (request.method === 'POST' && url.pathname === '/api/runs') {
      const body = await readBody();
      const agentId = typeof body.agentId === 'string' ? body.agentId : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (agentId === '' || prompt === '') {
        sendJson(response, 400, { error: 'agentId and prompt are required' });
        return;
      }
      const { id } = await orchestrator.submit({ agentId, prompt });
      sendJson(response, 202, { id });
      return;
    }

    // POST /api/runs/:id/stop — stop a running run.
    if (
      request.method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'runs' &&
      segments[3] === 'stop'
    ) {
      const run = await orchestrator.stop(segments[2] ?? '');
      sendJson(response, 200, toRunView(run));
      return;
    }

    // POST /api/runs/:id/release-lease — explicitly resolve a one-round run
    // lease left in recovery after the previous Sprout process died. A caller
    // must inspect the recovered run before doing this; the endpoint does not
    // silently turn a failed run into a successful one.
    if (
      request.method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'runs' &&
      segments[3] === 'release-lease'
    ) {
      const run = await orchestrator.load(segments[2] ?? '');
      if (!run) {
        sendJson(response, 404, { error: 'unknown run' });
        return;
      }
      const lease = run.leaseId === undefined
        ? undefined
        : orchestrator.leases().find((candidate) => candidate.id === run.leaseId);
      if (lease?.state !== 'recovering' || !orchestrator.releaseLease(lease.id)) {
        sendJson(response, 409, { error: 'run lease is not recovering' });
        return;
      }
      sendJson(response, 200, { run: toRunView(run), released: true });
      return;
    }

    // Chat-only minimal status projection: never serialize prompt or run events.
    if (request.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'runs' && segments[3] === 'status') {
      const run = orchestrator.get(segments[2] ?? '') ?? (await orchestrator.load(segments[2] ?? ''));
      if (!run) { sendJson(response, 404, { error: 'unknown run' }); return; }
      sendJson(response, 200, { id: run.id, status: run.status });
      return;
    }

    // GET /api/runs/:id — inspect one run.
    if (
      request.method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'runs'
    ) {
      const run = orchestrator.get(segments[2] ?? '') ?? (await orchestrator.load(segments[2] ?? ''));
      if (!run) {
        sendJson(response, 404, { error: `unknown run: ${segments[2]}` });
        return;
      }
      sendJson(response, 200, toRunView(run));
      return;
    }

    // GET /api/agents — the agents a user can submit work to.
    if (request.method === 'GET' && url.pathname === '/api/agents') {
      sendJson(response, 200, {
        agents: agents.list().map((agent) => ({
          id: agent.id,
          name: agent.name,
          engine: agent.engine,
        })),
      });
      return;
    }

    // GET /api/runs — list runs.
    if (request.method === 'GET' && url.pathname === '/api/runs') {
      const runs = (await orchestrator.list()).map(toRunView);
      sendJson(response, 200, { runs, totals: summarizeRunHistory(runs) });
      return;
    }

    // GET /api/leases — list leases for observability.
    if (request.method === 'GET' && url.pathname === '/api/leases') {
      sendJson(response, 200, { leases: orchestrator.leases() });
      return;
    }

    // POST /api/leases/:id/release — release a lease (resolving recovery).
    if (
      request.method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'leases' &&
      segments[3] === 'release'
    ) {
      const released = orchestrator.releaseLease(segments[2] ?? '');
      if (!released) {
        sendJson(response, 404, { error: `unknown or inactive lease: ${segments[2]}` });
        return;
      }
      sendJson(response, 200, released);
      return;
    }

    // GET /api/events — every run's progress, pushed as it changes.
    if (request.method === 'GET' && url.pathname === '/api/events') {
      await openEventStream(request, response);
      return;
    }

    if (options.staticRoot !== undefined && request.method === 'GET') {
      const served = await serveStatic(url.pathname, options.staticRoot, options.readFile);
      if (served) {
        response.writeHead(200, { 'content-type': served.contentType });
        response.end(served.body);
        return;
      }
    }

    sendJson(response, 404, { error: 'not found' });
  }

  async function openEventStream(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Flush immediately: with no runs to report yet, the first write would
    // otherwise be the keep-alive, and the client would not even see headers
    // until then.
    response.flushHeaders();
    streams.add(response);

    // Hydrate before interpreting the cursor. The cursor identifies a durable
    // projection, not this API process, so it remains meaningful after a
    // restart and can retain its replay boundary.
    // HTTP history remains newest-first. SSE uses the store's monotonic write
    // positions instead: observer arrival and restart hydration therefore share
    // one forward order even when timestamps tie or ids sort against arrival.
    for (const snapshot of await orchestrator.replaySnapshots()) {
      eventLog.publish(toRunView(snapshot.run), snapshot.sequence);
    }
    const cursor = parseEventCursor(headerValue(request, 'last-event-id'));
    const send = (record: SseRecord) => {
      if (response.writableEnded) return;
      writeEvent(response, record.event, record.data, record.cursor);
    };
    // Replay before attaching a listener. Both operations are synchronous, so
    // there is no missed interval between the cursor snapshot and subscription.
    for (const record of eventLog.after(cursor)) send(record);
    const unsubscribe = eventLog.subscribe(send);

    const keepAlive = setInterval(() => {
      if (response.writableEnded) return;
      response.write(': ping\n\nevent: heartbeat\ndata: \n\n');
    }, options.keepAliveMs ?? 15_000);
    // An unref'd timer cannot keep the process alive on its own.
    keepAlive.unref?.();

    const stop = () => {
      clearInterval(keepAlive);
      unsubscribe();
      streams.delete(response);
    };
    request.on('close', stop);
    response.on('close', stop);
  }

  return {
    server,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ port: typeof address === 'object' && address ? address.port : port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        // End every open event stream first: `server.close` waits for existing
        // connections, and an SSE stream never ends by itself.
        for (const stream of streams) stream.end();
        streams.clear();
        unsubscribeRunEvents();
        server.closeAllConnections?.();
        // A transport that never listened (construction refused, or the caller
        // closed before opening the surface) has nothing to stop.
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** `undefined` when absent, `null` when the request asked to clear it. */
function parseEnvironmentPreference(
  value: unknown,
): { readonly kind: 'definition' | 'instance'; readonly id: string } | null | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return 'invalid';
  const candidate = value as { readonly kind?: unknown; readonly id?: unknown };
  if ((candidate.kind !== 'definition' && candidate.kind !== 'instance') || typeof candidate.id !== 'string') {
    return 'invalid';
  }
  return { kind: candidate.kind, id: candidate.id };
}

/** Every Task status, for request validation. */
const TASK_STATUS_VALUES: readonly TaskStatus[] = [
  'todo',
  'in-progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

/** `undefined` when absent, a status when valid, `'invalid'` when not. */
function parseTaskStatus(value: unknown): TaskStatus | 'invalid' | undefined {
  if (value === undefined || value === null) return undefined;
  return TASK_STATUS_VALUES.includes(value as TaskStatus) ? (value as TaskStatus) : 'invalid';
}

/** `undefined` when absent, the array when all strings, `undefined` when invalid. */
function parseStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as readonly string[];
}

function writeEvent(response: ServerResponse, event: string, data: unknown, cursor?: string): void {
  response.write(`${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface SseRecord {
  readonly cursor: string;
  readonly event: 'run';
  readonly data: ReturnType<typeof toRunView>;
  readonly replaySequence: number;
}

/**
 * A transport replay log over immutable Web projections.
 *
 * Run events remain durable in the Run store; this log does not create another
 * domain event source. It assigns each distinct durable snapshot a stable,
 * opaque cursor. A restart rebuilds its baseline from the durable Run store,
 * preserving a cursor whose snapshot remains in that baseline.
 */
class SseEventLog {
  readonly #records: SseRecord[] = [];
  readonly #fingerprints = new Set<string>();
  readonly #listeners = new Set<(record: SseRecord) => void>();

  publish(data: ReturnType<typeof toRunView>, replaySequence: number): void {
    const fingerprint = JSON.stringify(data);
    if (this.#fingerprints.has(fingerprint)) return;
    this.#fingerprints.add(fingerprint);
    const record: SseRecord = {
      cursor: durableEventCursor(fingerprint, replaySequence),
      event: 'run',
      data,
      replaySequence,
    };
    this.#records.push(record);
    for (const listener of this.#listeners) listener(record);
  }

  after(cursor: string | undefined): readonly SseRecord[] {
    if (cursor === undefined) {
      return this.#records.toSorted((left, right) => left.replaySequence - right.replaySequence);
    }
    const boundary = this.#records.find((record) => record.cursor === cursor);
    // An unknown but well-formed cursor is outside this replay log. Rehydrate
    // from its safe boundary rather than treating it as a future position and
    // suppressing every current or later durable snapshot.
    return boundary === undefined
      ? this.#records.toSorted((left, right) => left.replaySequence - right.replaySequence)
      : this.#records
          .filter((record) => record.replaySequence > boundary.replaySequence)
          .toSorted((left, right) => left.replaySequence - right.replaySequence);
  }

  subscribe(listener: (record: SseRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

}

function durableEventCursor(fingerprint: string, replaySequence: number): string {
  return `v2:${replaySequence}:${createHash('sha256').update(fingerprint).digest('hex')}`;
}

function parseEventCursor(value: string | undefined): string | undefined {
  return value !== undefined && /^(?:v1:[a-f0-9]{64}|v2:[1-9][0-9]*:[a-f0-9]{64})$/.test(value)
    ? value
    : undefined;
}

function memoizedJsonReader(request: IncomingMessage): () => Promise<Record<string, unknown>> {
  let body: Promise<Record<string, unknown>> | undefined;
  return () => {
    body ??= readJson(request);
    return body;
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Shape the Message/Project-event domain failures onto the HTTP contract:
 * unknown targets are 404, malformed publication is 400, an author outside
 * the scope is 403, and a scope that is read-only for the author is 409. The
 * typed code travels verbatim; the message passes the privacy boundary as
 * defence in depth, so no diagnostic raised along the delivery path can carry
 * a credential, host, or path onto the wire.
 */
function sendDomainFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof MessageDeliveryError) {
    const status =
      error.reason === 'not-a-member' || error.reason === 'not-a-participant' ? 403 : 409;
    sendJson(response, status, {
      error: redactSensitiveText(error.message),
      code: error.code,
      reason: error.reason,
    });
    return;
  }
  if (error instanceof ConversationScopeError) {
    const status =
      error.code === 'unknown-scope' || error.code === 'unknown-project'
        ? 404
        : error.code === 'human-membership-required' || error.code === 'not-a-project-member'
          ? 403
          : 400;
    sendJson(response, status, { error: redactSensitiveText(error.message), code: error.code });
    return;
  }
  if (error instanceof ProjectEventError) {
    const status = error.code === 'unknown-project' ? 404 : 400;
    sendJson(response, status, { error: redactSensitiveText(error.message), code: error.code });
    return;
  }
  throw error;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** API reads have no state-changing effect; every other method needs CSRF proof. */
function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Protected-browser responses never serialize a domain/host exception. */
function responseError(error: unknown, protectedApi: boolean): string {
  if (protectedApi) return 'request could not be completed';
  return error instanceof Error ? error.message : String(error);
}

/**
 * `Secure` is mandatory on a TLS socket. Loopback HTTP deliberately omits it:
 * browsers otherwise refuse the cookie entirely, while HttpOnly + SameSite
 * Strict still protect the supported host-local HTTP mode.
 */
function sessionCookie(token: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1_000));
  return `sprout_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
}

function expiredSessionCookie(secure: boolean): string {
  return `sprout_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

function isTransportSecure(request: IncomingMessage): boolean {
  return (request.socket as TLSSocket).encrypted === true;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const ASSET_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs',
  '.css',
  '.html', '.htm',
  '.json',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.map',
  '.wasm',
  '.txt', '.xml',
]);

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = filePath.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function hasAssetExtension(pathname: string): boolean {
  const lastSlash = pathname.lastIndexOf('/');
  const segment = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return false;
  const ext = segment.slice(dot).toLowerCase();
  return ASSET_EXTENSIONS.has(ext) || /^\.[a-z0-9]{1,8}$/i.test(ext);
}

function isAppPath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

function containsTraversal(path: string): boolean {
  if (path.includes('..') || path.includes('\\')) return true;
  try {
    const decoded = decodeURIComponent(path);
    if (decoded.includes('..') || decoded.includes('\\')) return true;
  } catch {
    return true;
  }
  return false;
}

async function safeRead(
  readFile: (path: string) => Promise<Buffer | undefined>,
  filePath: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function serveStatic(
  pathname: string,
  root: string,
  readFile: ((path: string) => Promise<Buffer | undefined>) | undefined,
): Promise<{ body: Buffer; contentType: string } | undefined> {
  if (!readFile) return undefined;
  if (containsTraversal(pathname)) return undefined;

  const rawRelative = pathname.replace(/^\/+/, '');
  if (containsTraversal(rawRelative)) return undefined;

  // 1. Directory path with trailing slash (e.g. `/`, `/app/`, `/prototype/`): resolve to `${dir}index.html`.
  if (pathname.endsWith('/')) {
    const normalized = rawRelative.replace(/\/+$/, '');
    const indexPath = normalized === '' ? 'index.html' : `${normalized}/index.html`;
    const body = await safeRead(readFile, joinPath(root, indexPath));
    if (body) {
      return { body, contentType: contentTypeFor(indexPath) };
    }
    // If a directory index was not found, check if it is under the app mount for SPA fallback.
    // E.g. `/app/manage/environments/` (with trailing slash).
    if (isAppPath(pathname) && !hasAssetExtension(pathname)) {
      const appIndexBody = await safeRead(readFile, joinPath(root, 'app/index.html'));
      if (appIndexBody) {
        return { body: appIndexBody, contentType: CONTENT_TYPES['.html'] ?? 'text/html; charset=utf-8' };
      }
    }
    return undefined;
  }

  // 2. Exact file path: try reading directly.
  const body = await safeRead(readFile, joinPath(root, rawRelative));
  if (body) {
    return { body, contentType: contentTypeFor(rawRelative) };
  }

  // 3. Directory path without trailing slash (e.g. `/app`, `/prototype`): try `${relative}/index.html`.
  const dirIndexBody = await safeRead(readFile, joinPath(root, `${rawRelative}/index.html`));
  if (dirIndexBody) {
    return { body: dirIndexBody, contentType: CONTENT_TYPES['.html'] ?? 'text/html; charset=utf-8' };
  }

  // 4. SPA fallback: paths under the app mount without a matching file and without an asset extension
  // resolve to the app index so history-mode routes work on refresh and direct entry.
  // Missing asset extensions (.js/.css/etc.) stay 404 (return undefined).
  if (isAppPath(pathname) && !hasAssetExtension(pathname)) {
    const appIndexBody = await safeRead(readFile, joinPath(root, 'app/index.html'));
    if (appIndexBody) {
      return { body: appIndexBody, contentType: CONTENT_TYPES['.html'] ?? 'text/html; charset=utf-8' };
    }
  }

  return undefined;
}

function joinPath(root: string, relative: string): string {
  const cleanRoot = root.replace(/\/+$/, '');
  const cleanRel = relative.replace(/^\/+/, '');
  return `${cleanRoot}/${cleanRel}`;
}
