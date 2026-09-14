import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { RunOrchestrator } from '../run/orchestrator.ts';
import type { AgentRegistry } from '../agent/registry.ts';
import type { AgentRun } from '../run/model.ts';

/**
 * The Web seam for M1.
 *
 * Deliberately plain: the HTTP framework, UI library, and progress transport are
 * deferred decisions (ADR-0002), so this module uses `node:http` and
 * server-sent events and keeps no domain logic. Every route delegates to the
 * orchestrator, which is why the client needs no knowledge of leases or engines.
 */

export interface RunApiOptions {
  readonly orchestrator: RunOrchestrator;
  /** The agents a user can address; exposed read-only for the client. */
  readonly agents: AgentRegistry;
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
  const { orchestrator, agents } = options;
  /** Open event streams, so `close` can end them instead of hanging. */
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter((part) => part !== '');

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
      sendJson(response, 200, toView(run));
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
      sendJson(response, 200, toView(run));
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
      sendJson(response, 200, { runs: (await orchestrator.list()).map(toView) });
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
      writeEvent(response, 'run', toView(run));
    });

    void listRuns().then((runs) => {
      for (const run of runs) writeEvent(response, 'run', toView(run));
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
  readonly failure?: string;
  readonly result?: unknown;
  readonly createdAt: number;
  readonly completedAt?: number;
}

function toView(run: AgentRun): RunView {
  return {
    id: run.id,
    agentId: run.agentId,
    prompt: run.prompt,
    status: run.status,
    events: run.events,
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    createdAt: run.createdAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
  };
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
