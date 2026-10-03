import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { redactSensitiveText } from '../environment/privacy.ts';
import type { AgentDirectMessageInput, AgentDirectMessageResult } from '../engine/port.ts';

/** Host-local, session-scoped capability; never a browser or Human credential. */
export async function createAgentMessageBridge(send: (input: AgentDirectMessageInput) => Promise<AgentDirectMessageResult>) {
  const token = randomBytes(32).toString('hex');
  let active = true;
  const server = createServer((request, response) => {
    void (async () => {
      if (!active || request.method !== 'POST' || request.url !== '/direct-message' || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end(); return;
      }
      let body = '';
      try {
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 64 * 1024) throw new Error('message too large');
        }
        const result = await send(JSON.parse(body) as AgentDirectMessageInput);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: redactSensitiveText(error instanceof Error ? error.message : 'Agent direct-message delivery refused') }));
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  const base = Number(process.env.DEV_PIPELINE_PORT_BASE ?? 0);
  let port = 0;
  for (let attempt = 0; attempt < (base ? 10 : 1); attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        server.listen(base ? base + attempt : 0, '127.0.0.1');
      });
      port = (server.address() as { port: number }).port;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === (base ? 9 : 0)) throw error;
    }
  }
  return {
    environment: { SPROUT_AGENT_MESSAGE_TOKEN: token, SPROUT_AGENT_MESSAGE_URL: `http://127.0.0.1:${port}/direct-message` },
    instructions: `\nSprout direct-message command (explicit sends only; automatic final replies never wake Agents):\nUse a shell tool to POST JSON {"recipientId":"<member-id>","body":"<message>","deliveryKey":"<stable-key>","awaitReply":false} with curl --fail-with-body --silent --show-error --max-time 60 -H "Authorization: Bearer $SPROUT_AGENT_MESSAGE_TOKEN" -H 'Content-Type: application/json' --data-binary @<json-file> "$SPROUT_AGENT_MESSAGE_URL" . These variables are supplied only in the session process environment; never print, persist, or echo their values. Identity and Project are resolved by Core. Do not supply author fields. Inspect wakes, runs and admittedRunIds: stored delivery does not imply successful admission. Reuse deliveryKey when retrying the same send. Do not copy this session credential into messages or files.\n`,
    async close() {
      active = false;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
