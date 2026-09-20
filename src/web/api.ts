import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

import type { RunOrchestrator } from '../run/orchestrator.ts';
import type { AgentRegistry } from '../agent/registry.ts';
import type { AgentRun } from '../run/model.ts';
import type { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { TaskService } from '../task/service.ts';
import type { TaskStatus } from '../task/model.ts';
import type { OperatorSessionService, AuthenticatedBrowserSession } from '../auth/service.ts';
import {
  summarizeRunHistory,
  toMessageView,
  toProjectView,
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
  /** Interval for SSE keep-alive comments. Exposed so tests need not wait. */
  readonly keepAliveMs?: number;
}

export interface RunApi {
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ readonly port: number }>;
  close(): Promise<void>;
}

export function createRunApi(options: RunApiOptions): RunApi {
  const { orchestrator, agents, collaboration, projects, tasks, auth } = options;
  /** Open event streams, so `close` can end them instead of hanging. */
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: responseError(error, auth !== undefined),
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter((part) => part !== '');
    let browserSession: AuthenticatedBrowserSession | undefined;

    // Credential exchange is the only anonymous API operation. The credential
    // is sent in a POST body (never a URL) and succeeds by setting an HTTP-only
    // browser cookie; the response exposes only the separate CSRF value.
    if (auth && request.method === 'POST' && url.pathname === '/api/auth/session') {
      if (!(await auth.isConfigured())) {
        sendJson(response, 503, { error: 'operator access is unavailable; initialize it on the host' });
        return;
      }
      const body = await readJson(request);
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
      sendJson(response, 200, { sessions: await auth.listSessions(browserSession!.id) });
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

    // POST /api/messages — deliver one Message to a project channel and wake
    // whoever the M1 wake contract addresses.
    if (request.method === 'POST' && url.pathname === '/api/messages' && collaboration) {
      const body = await readJson(request);
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      const channel = body.channel;
      const authorId = auth ? 'operator' : typeof body.authorId === 'string' ? body.authorId : '';
      const authorKind = auth ? 'human' : body.authorKind === 'agent' ? 'agent' : 'human';
      const text = typeof body.body === 'string' ? body.body : '';
      const deliveryKey = typeof body.deliveryKey === 'string' ? body.deliveryKey : '';
      const awaitReply = body.awaitReply !== false;
      if (
        projectId === '' ||
        authorId === '' ||
        text === '' ||
        deliveryKey === '' ||
        (channel !== 'direct' && channel !== 'project')
      ) {
        sendJson(response, 400, {
          error: 'projectId, channel, authorId, body, and deliveryKey are required',
        });
        return;
      }
      // An authenticated browser is the only source of Human authority. In the
      // protected runtime an Agent/Worker cannot select an authority kind or a
      // different Human id through request JSON.
      if (auth && (body.authorKind === 'agent' || body.authorKind === 'worker')) {
        sendJson(response, 403, { error: 'browser commands are Human-only' });
        return;
      }
      if (
        (body.recipients !== undefined &&
          (!Array.isArray(body.recipients) || !body.recipients.every((value) => typeof value === 'string'))) ||
        (channel === 'direct' && (!Array.isArray(body.recipients) || body.recipients.length === 0)) ||
        (channel === 'project' && Array.isArray(body.recipients) && body.recipients.length > 0)
      ) {
        sendJson(response, 400, {
          error: 'direct messages require string recipients; project messages cannot have recipients',
        });
        return;
      }
      const recipients = body.recipients as readonly string[] | undefined;
      const delivered = await collaboration.deliver({
        projectId,
        channel,
        author: { id: authorId, kind: authorKind },
        body: text,
        ...(recipients !== undefined ? { recipients } : {}),
        deliveryKey,
        awaitReply,
      });
      sendJson(response, delivered.duplicate ? 200 : 202, {
        message: toMessageView(delivered.message),
        duplicate: delivered.duplicate,
        wakes: delivered.wakes.map(toWakeView),
        admittedRunIds: delivered.admittedRunIds,
      });
      return;
    }

    // GET /api/messages — the durable conversation, newest last.
    if (request.method === 'GET' && url.pathname === '/api/messages' && collaboration) {
      sendJson(response, 200, {
        messages: (await collaboration.listMessages()).map(toMessageView),
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
          .filter((wake) => wake.messageId === messageId)
          .map(toWakeView),
      });
      return;
    }

    // GET /api/projects — the projects and members the client may address (#27).
    if (request.method === 'GET' && url.pathname === '/api/projects' && projects) {
      sendJson(response, 200, { projects: projects.list().map(toProjectView) });
      return;
    }

    // POST /api/tasks — create a durable multi-run Task (#28).
    if (request.method === 'POST' && url.pathname === '/api/tasks' && tasks) {
      const body = await readJson(request);
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
      const body = await readJson(request);
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
      const body = await readJson(request);
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
      const body = await readJson(request);
      if (body.action !== 'resume' && body.action !== 'discard') { sendJson(response, 400, { error: 'action must be resume or discard' }); return; }
      try { sendJson(response, 200, { task: toTaskView(await tasks.recover(taskId, body.action)) }); }
      catch (error) { sendJson(response, 409, { error: responseError(error, auth !== undefined) }); }
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
      const body = await readJson(request);
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
      const body = await readJson(request);
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
      openEventStream(request, response);
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

  async function listRuns(): Promise<readonly AgentRun[]> {
    // The orchestrator merges live state with persisted runs, so a restarted
    // process shows previous work instead of an empty history.
    return orchestrator.list();
  }

  function openEventStream(request: IncomingMessage, response: ServerResponse): void {
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

    const unsubscribe = orchestrator.subscribe((run) => {
      writeEvent(response, 'run', toRunView(run));
    });

    void listRuns().then((runs) => {
      for (const run of runs) writeEvent(response, 'run', toRunView(run));
    });

    const keepAlive = setInterval(() => response.write(': ping\n\n'), options.keepAliveMs ?? 15_000);
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
        server.closeAllConnections?.();
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

function writeEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

async function serveStatic(
  pathname: string,
  root: string,
  readFile: ((path: string) => Promise<Buffer | undefined>) | undefined,
): Promise<{ body: Buffer; contentType: string } | undefined> {
  if (!readFile) return undefined;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.includes('..')) return undefined;
  const body = await readFile(joinPath(root, relative));
  if (!body) return undefined;
  const extension = relative.slice(relative.lastIndexOf('.'));
  return { body, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' };
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/\/+$/, '')}/${relative}`;
}
