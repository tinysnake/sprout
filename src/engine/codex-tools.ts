import { createHash, randomUUID } from 'node:crypto';
import type {
  RemoteProjectMcpTools,
  RemoteWorkspaceOperationResult,
  RemoteWorkspaceTools,
} from './port.ts';

export interface CodexDynamicToolSpec {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface CodexDynamicToolResult {
  readonly contentItems: readonly { readonly type: 'inputText'; readonly text: string }[];
  readonly success: boolean;
}

interface BoundTool {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly displayName: string;
  readonly invoke: (arguments_: Record<string, unknown>) => Promise<CodexDynamicToolResult>;
}

const workspaceToolNames = ['read', 'search', 'edit', 'patch', 'command'] as const;
type WorkspaceToolName = typeof workspaceToolNames[number];

/** Build a run-scoped Codex catalog whose callbacks retain the pinned Worker origin. */
export function createCodexDynamicToolBridge(input: {
  readonly remoteWorkspace?: RemoteWorkspaceTools;
  readonly remoteProjectMcp?: RemoteProjectMcpTools;
}): {
  readonly specs: readonly CodexDynamicToolSpec[];
  call(toolName: string, arguments_: unknown): Promise<CodexDynamicToolResult>;
} {
  const tools = new Map<string, BoundTool>();
  const workspace = input.remoteWorkspace;
  const operations = new Set(workspace?.operations ?? []);
  const mcp = input.remoteProjectMcp;

  if (workspace !== undefined) {
    for (const operation of workspaceToolNames) {
      if (!operations.has(operation) || !workspaceMethodAvailable(workspace, operation)) continue;
      const name = `sprout_workspace_${operation}`;
      tools.set(name, workspaceTool(workspace, operation));
    }
  }

  for (const declaration of mcp?.tools ?? []) {
    const name = `sprout_project_mcp_${createHash('sha256').update(declaration.name).digest('hex').slice(0, 16)}`;
    tools.set(name, {
      description: declaration.description,
      inputSchema: declaration.inputSchema,
      displayName: 'project-mcp',
      invoke: async arguments_ => {
        if (mcp?.bindingFence !== undefined && !mcp.bindingFence.isCurrent()) return refusedToolResult();
        try {
          const result = await mcp!.call(declaration.name, arguments_);
          return { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: result.status === 'completed' };
        } catch {
          return refusedToolResult();
        }
      },
    });
  }

  const specs = [...tools].map(([name, tool]) => ({
    type: 'function' as const,
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  return {
    specs,
    async call(toolName, arguments_) {
      const tool = tools.get(toolName);
      if (tool === undefined || !isRecord(arguments_)) return refusedToolResult();
      if (workspace?.bindingFence !== undefined && !workspace.bindingFence.isCurrent()) return refusedToolResult();
      try {
        return await tool.invoke(arguments_);
      } catch {
        return refusedToolResult();
      }
    },
  };
}

function workspaceMethodAvailable(workspace: RemoteWorkspaceTools, operation: WorkspaceToolName): boolean {
  switch (operation) {
    case 'read': return typeof workspace.read === 'function';
    case 'search': return typeof workspace.search === 'function';
    case 'edit': return typeof workspace.edit === 'function';
    case 'patch': return typeof workspace.patch === 'function';
    case 'command': return typeof workspace.command === 'function';
  }
}

function workspaceTool(workspace: RemoteWorkspaceTools, operation: WorkspaceToolName): BoundTool {
  const schemas: Record<WorkspaceToolName, Readonly<Record<string, unknown>>> = {
    read: objectSchema({ path: { type: 'string' } }, ['path']),
    search: objectSchema({ query: { type: 'string' }, path: { type: 'string' } }, ['query']),
    edit: objectSchema({ path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, ['path', 'oldText', 'newText']),
    patch: objectSchema({
      path: { type: 'string' },
      hunks: { type: 'array', items: objectSchema({ before: { type: 'string' }, after: { type: 'string' } }, ['before', 'after']) },
    }, ['path', 'hunks']),
    command: objectSchema({
      executable: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1 },
    }, ['executable', 'args']),
  };
  const descriptions: Record<WorkspaceToolName, string> = {
    read: 'Read a file from the selected remote Project workspace.',
    search: 'Search files in the selected remote Project workspace.',
    edit: 'Replace exact text in a file in the selected remote Project workspace.',
    patch: 'Apply bounded text patches in the selected remote Project workspace.',
    command: 'Run an allowlisted command in the selected remote Project workspace.',
  };
  return {
    description: descriptions[operation],
    inputSchema: schemas[operation],
    displayName: `workspace.${operation}`,
    invoke: async arguments_ => {
      if (!validArguments(operation, arguments_)) return refusedToolResult();
      let result: RemoteWorkspaceOperationResult;
      const operationId = randomUUID();
      switch (operation) {
        case 'read':
          result = await workspace.read(arguments_.path as string, operationId);
          break;
        case 'search':
          result = await workspace.search(arguments_.query as string,
            typeof arguments_.path === 'string' ? arguments_.path : undefined, operationId);
          break;
        case 'edit':
          if (workspace.edit === undefined) return refusedToolResult();
          result = await workspace.edit(arguments_.path as string, arguments_.oldText as string, arguments_.newText as string, operationId);
          break;
        case 'patch':
          if (workspace.patch === undefined) return refusedToolResult();
          result = await workspace.patch(arguments_.path as string,
            arguments_.hunks as readonly { readonly before: string; readonly after: string }[], operationId);
          break;
        case 'command':
          if (workspace.command === undefined) return refusedToolResult();
          result = await workspace.command(arguments_.executable as string, arguments_.args as string[], {
            ...(typeof arguments_.cwd === 'string' ? { cwd: arguments_.cwd } : {}),
            ...(typeof arguments_.timeoutMs === 'number' ? { timeoutMs: arguments_.timeoutMs } : {}),
          }, operationId);
          break;
      }
      return { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: result.status === 'completed' };
    },
  };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function validArguments(operation: WorkspaceToolName, value: Record<string, unknown>): boolean {
  const allowed: Record<WorkspaceToolName, readonly string[]> = {
    read: ['path'], search: ['query', 'path'], edit: ['path', 'oldText', 'newText'],
    patch: ['path', 'hunks'], command: ['executable', 'args', 'cwd', 'timeoutMs'],
  };
  if (Object.keys(value).some(key => !allowed[operation].includes(key))) return false;
  const string = (key: string) => typeof value[key] === 'string';
  switch (operation) {
    case 'read': return string('path');
    case 'search': return string('query') && (value.path === undefined || string('path'));
    case 'edit': return string('path') && string('oldText') && string('newText');
    case 'patch': return string('path') && Array.isArray(value.hunks) && value.hunks.every(hunk => isRecord(hunk) &&
      Object.keys(hunk).every(key => key === 'before' || key === 'after') && typeof hunk.before === 'string' && typeof hunk.after === 'string');
    case 'command': return string('executable') && Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string') &&
      (value.cwd === undefined || string('cwd')) && (value.timeoutMs === undefined || Number.isSafeInteger(value.timeoutMs));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refusedToolResult(): CodexDynamicToolResult {
  return { contentItems: [{ type: 'inputText', text: 'The selected remote capability is no longer available.' }], success: false };
}
