import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RemoteProjectMcpTools, RemoteWorkspaceTools } from './port.ts';
import type { McpServer } from '@botiverse/oar';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a.trim(), 'utf8');
  const bufB = Buffer.from(b.trim(), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  call(arguments_: Record<string, unknown>): Promise<{ readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly isError?: boolean }>;
}

export interface OarMcpBridgeHandle {
  readonly mcpServer: McpServer;
  close(): Promise<void>;
}

export async function createOarMcpBridge(input: {
  readonly remoteWorkspace?: RemoteWorkspaceTools;
  readonly remoteProjectMcp?: RemoteProjectMcpTools;
}): Promise<OarMcpBridgeHandle | undefined> {
  const { remoteWorkspace, remoteProjectMcp } = input;
  if (remoteWorkspace === undefined && remoteProjectMcp === undefined) {
    return undefined;
  }

  const tools = new Map<string, ToolDeclaration>();

  if (remoteWorkspace !== undefined) {
    const operations = new Set(remoteWorkspace.operations ?? ['read', 'search', 'edit', 'patch', 'command']);

    if (operations.has('read') && typeof remoteWorkspace.read === 'function') {
      tools.set('read', {
        name: 'read',
        description: 'Read a file from the selected remote Project workspace.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative path of the file to read' } },
          required: ['path'],
        },
        async call(args) {
          if (remoteWorkspace.bindingFence && !remoteWorkspace.bindingFence.isCurrent()) {
            return { content: [{ type: 'text', text: 'The selected remote capability is no longer available.' }], isError: true };
          }
          const path = typeof args.path === 'string' ? args.path : '';
          const res = await remoteWorkspace.read(path, randomUUID());
          return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: res.status !== 'completed' };
        },
      });
    }

    if (operations.has('search') && typeof remoteWorkspace.search === 'function') {
      tools.set('search', {
        name: 'search',
        description: 'Search files in the selected remote Project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            path: { type: 'string', description: 'Directory to search in' },
          },
          required: ['query'],
        },
        async call(args) {
          if (remoteWorkspace.bindingFence && !remoteWorkspace.bindingFence.isCurrent()) {
            return { content: [{ type: 'text', text: 'The selected remote capability is no longer available.' }], isError: true };
          }
          const query = typeof args.query === 'string' ? args.query : '';
          const path = typeof args.path === 'string' ? args.path : undefined;
          const res = await remoteWorkspace.search(query, path, randomUUID());
          return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: res.status !== 'completed' };
        },
      });
    }

    if (operations.has('edit') && typeof remoteWorkspace.edit === 'function') {
      tools.set('edit', {
        name: 'edit',
        description: 'Replace exact text in a file in the selected remote Project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
          required: ['path', 'oldText', 'newText'],
        },
        async call(args) {
          if (remoteWorkspace.bindingFence && !remoteWorkspace.bindingFence.isCurrent()) {
            return { content: [{ type: 'text', text: 'The selected remote capability is no longer available.' }], isError: true };
          }
          const path = typeof args.path === 'string' ? args.path : '';
          const oldText = typeof args.oldText === 'string' ? args.oldText : '';
          const newText = typeof args.newText === 'string' ? args.newText : '';
          const res = await remoteWorkspace.edit!(path, oldText, newText, randomUUID());
          return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: res.status !== 'completed' };
        },
      });
    }

    if (operations.has('patch') && typeof remoteWorkspace.patch === 'function') {
      tools.set('patch', {
        name: 'patch',
        description: 'Apply unified hunks to a file in the selected remote Project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            hunks: {
              type: 'array',
              items: {
                type: 'object',
                properties: { before: { type: 'string' }, after: { type: 'string' } },
                required: ['before', 'after'],
              },
            },
          },
          required: ['path', 'hunks'],
        },
        async call(args) {
          if (remoteWorkspace.bindingFence && !remoteWorkspace.bindingFence.isCurrent()) {
            return { content: [{ type: 'text', text: 'The selected remote capability is no longer available.' }], isError: true };
          }
          const path = typeof args.path === 'string' ? args.path : '';
          const hunks = Array.isArray(args.hunks) ? args.hunks as { before: string; after: string }[] : [];
          const res = await remoteWorkspace.patch!(path, hunks, randomUUID());
          return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: res.status !== 'completed' };
        },
      });
    }

    if (operations.has('command') && typeof remoteWorkspace.command === 'function') {
      tools.set('command', {
        name: 'command',
        description: 'Run an allowlisted command in the selected remote Project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            executable: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 1 },
          },
          required: ['executable', 'args'],
        },
        async call(args) {
          if (remoteWorkspace.bindingFence && !remoteWorkspace.bindingFence.isCurrent()) {
            return { content: [{ type: 'text', text: 'The selected remote capability is no longer available.' }], isError: true };
          }
          const executable = typeof args.executable === 'string' ? args.executable : '';
          const cmdArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === 'string') : [];
          const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
          const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
          const res = await remoteWorkspace.command!(
            executable,
            cmdArgs,
            {
              ...(cwd !== undefined ? { cwd } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            randomUUID(),
          );
          return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: res.status !== 'completed' };
        },
      });
    }
  }

  if (remoteProjectMcp !== undefined) {
    for (const tool of remoteProjectMcp.tools) {
      tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        async call(args) {
          if (remoteProjectMcp.bindingFence && !remoteProjectMcp.bindingFence.isCurrent()) {
            return { content: [{ type: 'text', text: 'The selected remote capability is no longer available.' }], isError: true };
          }
          try {
            const res = await remoteProjectMcp.call(tool.name, args);
            return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: res.status !== 'completed' };
          } catch {
            return { content: [{ type: 'text', text: 'The selected remote capability failed.' }], isError: true };
          }
        },
      });
    }
  }

  const authToken = randomBytes(24).toString('hex');
  const expectedAuthHeader = `Bearer ${authToken}`;

  const server = createServer((req, res) => {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string' || !safeCompare(authHeader, expectedAuthHeader)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' } }));
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST, DELETE' });
      res.end('Method Not Allowed');
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST, DELETE' });
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', async () => {
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify(payload));
      };

      const id = request.id;
      const method = typeof request.method === 'string' ? request.method : '';

      if (method === 'initialize') {
        sendJson(200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'sprout_workspace', version: '1.0.0' },
          },
        });
        return;
      }

      if (method === 'notifications/initialized' || id === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'tools/list') {
        const declarations = [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        sendJson(200, {
          jsonrpc: '2.0',
          id,
          result: { tools: declarations },
        });
        return;
      }

      if (method === 'tools/call') {
        const params = typeof request.params === 'object' && request.params !== null ? request.params as Record<string, unknown> : {};
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments as Record<string, unknown> : {};
        const tool = tools.get(toolName);
        if (tool === undefined) {
          sendJson(200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Tool ${toolName} not found` }],
              isError: true,
            },
          });
          return;
        }

        try {
          const outcome = await tool.call(toolArgs);
          sendJson(200, {
            jsonrpc: '2.0',
            id,
            result: outcome,
          });
        } catch (error) {
          sendJson(200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: error instanceof Error ? error.message : 'Unknown tool error' }],
              isError: true,
            },
          });
        }
        return;
      }

      // Default fallback for any other method
      sendJson(200, { jsonrpc: '2.0', id, result: {} });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const mcpServer: McpServer = {
    name: 'sprout_workspace',
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: {
      authorization: expectedAuthHeader,
    },
  };

  return {
    mcpServer,
    async close() {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (remoteProjectMcp?.close) {
        await remoteProjectMcp.close();
      }
    },
  };
}
