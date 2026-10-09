import { createHash } from 'node:crypto';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import { sanitizeWorkspacePath } from '../project/access.ts';
import type { RemoteProjectMcpTools, RemoteWorkspaceTools } from '../engine/port.ts';
import type { RunWorkspaceBinding } from './model.ts';

const WORKSPACE_OPERATIONS = new Set(['read', 'search', 'edit', 'patch', 'command']);

export function currentRunWorkspaceBinding(input: {
  readonly remoteWorkspace?: RemoteWorkspaceTools;
  readonly remoteProjectMcp?: RemoteProjectMcpTools;
  readonly catalogGeneration?: number;
}): RunWorkspaceBinding | undefined {
  const workspace = input.remoteWorkspace;
  const mcp = input.remoteProjectMcp;
  const binding = workspace?.binding ?? mcp?.binding;
  if (binding === undefined) return undefined;
  const operations = (workspace?.operations ?? []).filter((operation) => WORKSPACE_OPERATIONS.has(operation));
  const projectMcpTools = (mcp?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name));
  const generation = Number.isSafeInteger(binding.generation) && binding.generation! > 0
    ? binding.generation
    : undefined;
  const path = safeWorkspacePath(binding.path);
  const catalogIdentity = createHash('sha256').update(JSON.stringify({
    binding: [binding.environmentInstanceId, binding.bindingId, binding.generation, binding.workspaceId, binding.kind, binding.path ?? ''],
    operations: [...new Set(operations)].sort(),
    projectMcpTools: (mcp?.tools ?? []).map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  })).digest('hex');
  return {
    environmentInstanceId: sanitizeIdentifier(binding.environmentInstanceId, { fallback: 'unknown-environment', kind: 'generic' }),
    bindingId: sanitizeIdentifier(binding.bindingId, { fallback: 'unknown-binding', kind: 'generic' }),
    ...(generation !== undefined ? { generation } : {}),
    workspaceId: sanitizeIdentifier(binding.workspaceId, { fallback: 'unknown-workspace', kind: 'digest' }),
    catalogIdentity,
    kind: binding.kind === 'relative' ? 'relative' : 'default',
    ...(path !== undefined ? { path } : {}),
    ...(input.catalogGeneration !== undefined ? { catalogGeneration: input.catalogGeneration } : {}),
    ...(operations.length > 0 ? { operations: [...new Set(operations)] } : {}),
    ...(projectMcpTools.length > 0 ? { projectMcpTools: [...new Set(projectMcpTools)] } : {}),
  };
}

/** A per-request fact block. Full schemas remain in the Engine tool channel. */
export function renderCurrentWorkspaceSnapshot(
  binding: RunWorkspaceBinding | undefined,
  status: 'staging' | 'active' | 'detached' | 'unavailable' | 'recovering',
  bindingChange?: string,
): string {
  if (binding === undefined) {
    const detail = status === 'recovering'
      ? 'Remote workspace operations require Environment recovery.'
      : status === 'unavailable'
        ? 'The requested remote workspace could not be attached.'
        : 'No remote Project workspace is attached; host-local work tools are disabled.';
    return [
      '## Sprout current workspace and capability snapshot',
      `Status: ${status}`,
      ...(bindingChange !== undefined ? [`Binding change: ${bindingChange}`] : []),
      detail,
    ].join('\n');
  }
  const environment = sanitizeIdentifier(binding.environmentInstanceId ?? '', { fallback: 'unknown-environment', kind: 'generic' });
  const operations = (binding.operations ?? []).filter((operation) => WORKSPACE_OPERATIONS.has(operation));
  const mcpTools = (binding.projectMcpTools ?? []).slice(0, 128);
  return [
    '## Sprout current workspace and capability snapshot',
    `Status: ${status}`,
    ...(bindingChange !== undefined ? [`Binding change: ${bindingChange}`] : []),
    `Environment: ${environment}`,
    `Workspace binding generation: ${Number.isSafeInteger(binding.generation) ? binding.generation : 'unknown'}`,
    `Workspace identity: ${sanitizeIdentifier(binding.workspaceId ?? '', { fallback: 'unknown-workspace', kind: 'digest' })}`,
    `Remote workspace operations: ${operations.length ? operations.join(', ') : 'none'}`,
    `Project MCP tools: ${mcpTools.length ? mcpTools.join(', ') : 'none'}`,
    ...(binding.catalogGeneration !== undefined ? [`Published tool catalog generation: ${binding.catalogGeneration}`] : []),
  ].join('\n');
}

/** Keep a relative workspace location only in the durable run attribution. */
export function safeWorkspacePath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : sanitizeWorkspacePath(path);
}
