import type { ProjectMcpToolDeclaration } from './port.ts';

export interface PiProjectMcpTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(id: string, args: Readonly<Record<string, unknown>>): Promise<{
    readonly content: readonly { readonly type: 'text'; readonly text: string }[];
    readonly details: unknown;
    readonly isError: boolean;
  }>;
}

/** Build typed Pi tools while capturing each fixed core-owned origin in a closure. */
export function buildProjectMcpTools(
  declarations: readonly ProjectMcpToolDeclaration[],
  remoteCall: (operation: 'mcp', args: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }) => Promise<unknown>,
): readonly PiProjectMcpTool[] {
  if (declarations.length > 128) throw new Error('Project MCP tool catalog exceeds its bound');
  const names = new Set<string>();
  return declarations.map((tool) => {
    if (!tool || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool.name) || names.has(tool.name) ||
        typeof tool.description !== 'string' || !isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
      throw new Error('Project MCP tool declaration is invalid');
    }
    names.add(tool.name);
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: async (_id: string, args: Readonly<Record<string, unknown>>) => {
        const result = await remoteCall('mcp', { name: tool.name, arguments: args });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
          isError: !isRecord(result) || result.status !== 'completed',
        };
      },
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
