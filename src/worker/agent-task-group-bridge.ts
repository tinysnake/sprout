import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { JsonRpcError } from '../engine/jsonrpc.ts';
import { redactSensitiveText } from '../environment/privacy.ts';
import { ConversationScopeError } from '../conversation/model.ts';
import { MessageDeliveryError } from '../collaboration/coordinator.ts';
import { AgentTaskGroupPostError } from '../collaboration/agent-task-group.ts';
import type { AgentTaskGroupMessageInput, AgentTaskGroupMessageResult } from '../engine/port.ts';

/** Host-local, session-scoped Task-group posting capability. */
export async function createAgentTaskGroupMessageBridge(
  post: (input: AgentTaskGroupMessageInput) => Promise<AgentTaskGroupMessageResult>,
) {
  const token = randomBytes(32).toString('hex');
  let active = true;
  const server = createServer((request, response) => {
    void (async () => {
      if (!active || request.method !== 'POST' || request.url !== '/task-group-post' || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end();
        return;
      }
      let body = '';
      try {
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 64 * 1024) {
            response.writeHead(413).end();
            return;
          }
        }
        const result = await post(JSON.parse(body) as AgentTaskGroupMessageInput);
        sendBridgeJson(response, 200, result);
      } catch (error) {
        const failure = bridgeFailure(error);
        sendBridgeJson(response, failure.status, failure.body);
      }
    })().catch(() => {
      if (!response.headersSent) sendBridgeJson(response, 500, { error: 'Task-group post failed', code: 'task-group-post-failed' });
      else response.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  const base = Number(process.env.DEV_PIPELINE_PORT_BASE ?? 0);
  let port = 0;
  for (let attempt = 0; attempt < (base ? 10 : 1); attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(base ? base + attempt : 0, '127.0.0.1');
      });
      port = (server.address() as { port: number }).port;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === (base ? 9 : 0)) throw error;
    }
  }
  return {
    environment: {
      SPROUT_TASK_GROUP_POST_TOKEN: token,
      SPROUT_TASK_GROUP_POST_URL: `http://127.0.0.1:${port}/task-group-post`,
    },
    instructions: `\nSprout Task-group post command (the Agent messaging path; explicit sends only):\nPOST JSON {"body":"<free-form message>","deliveryKey":"<stable-key>","kind":"handoff|assignment|question|status","awaitReply":false} to "$SPROUT_TASK_GROUP_POST_URL" with curl --fail-with-body --silent --show-error --max-time 60 -H "Authorization: Bearer $SPROUT_TASK_GROUP_POST_TOKEN" -H 'Content-Type: application/json' --data-binary @<json-file>. Omit kind for status. Body is free-form prose. Sprout resolves your identity and current Task group, stamps the Task/run/work-item references, and derives recipients from exact @mentions in the body. Do not send author, Project, Task, run, group, recipient, or envelope fields. These variables exist only in this session process environment; never print, persist, or echo their values. Reuse deliveryKey when retrying the same post. A stored post or admitted wake does not prove a run succeeded; inspect the returned wakes and runs.\n`,
    async close() {
      active = false;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendBridgeJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
  });
  response.end(payload);
}

function bridgeFailure(error: unknown): { readonly status: number; readonly body: Record<string, string> } {
  if (error instanceof AgentTaskGroupPostError) {
    return {
      status: error.status,
      body: {
        error: redactSensitiveText(error.message),
        code: error.code,
        ...(error.reason !== undefined ? { reason: error.reason } : {}),
      },
    };
  }
  if (error instanceof JsonRpcError && error.code >= 400 && error.code <= 599) {
    try {
      const separator = error.message.indexOf(': ');
      const detail = separator >= 0 ? error.message.slice(separator + 2) : error.message;
      const body = JSON.parse(detail) as Record<string, unknown>;
      if (typeof body.error === 'string' && typeof body.code === 'string') {
        return {
          status: error.code,
          body: {
            error: redactSensitiveText(body.error),
            code: body.code,
            ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
          },
        };
      }
    } catch { /* malformed Worker error details use the generic refusal below */ }
  }
  if (error instanceof MessageDeliveryError) {
    const status = error.reason === 'not-a-member' || error.reason === 'not-a-participant' ? 403 : 409;
    return {
      status,
      body: { error: redactSensitiveText(error.message), code: error.code, reason: error.reason },
    };
  }
  if (error instanceof ConversationScopeError) {
    const status = error.code === 'unknown-scope' || error.code === 'unknown-project' ? 404 : 409;
    return { status, body: { error: redactSensitiveText(error.message), code: error.code } };
  }
  return {
    status: 400,
    body: { error: redactSensitiveText(error instanceof Error ? error.message : 'Task-group post refused'), code: 'task-group-post-refused' },
  };
}
