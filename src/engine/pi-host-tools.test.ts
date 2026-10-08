import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProjectMcpTools } from './pi-host-tools.ts';

const declaration = {
  name: 'mcp_fixture_echo',
  description: 'Echo text from the fixed fixture server.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
} as const;

test('Host Pi registers typed MCP tools and captures their fixed core origin', async () => {
  const calls: unknown[] = [];
  const [tool] = buildProjectMcpTools([declaration], async (operation, args) => {
    calls.push({ operation, args });
    return { status: 'completed', text: 'fixture result' };
  });
  assert.ok(tool);
  assert.equal(tool.name, 'mcp_fixture_echo');
  assert.deepEqual(tool.parameters, declaration.inputSchema);
  const result = await tool.execute('pi-call-id', { text: 'hello' });
  assert.deepEqual(calls, [{ operation: 'mcp', args: { name: 'mcp_fixture_echo', arguments: { text: 'hello' } } }]);
  assert.deepEqual(result, {
    content: [{ type: 'text', text: '{"status":"completed","text":"fixture result"}' }],
    details: { status: 'completed', text: 'fixture result' },
    isError: false,
  });
});

test('Host Pi refuses duplicate or malformed MCP tool declarations', () => {
  assert.throws(() => buildProjectMcpTools([declaration, declaration], async () => ({})), /invalid/);
  assert.throws(() => buildProjectMcpTools([{ ...declaration, name: '../escape' }], async () => ({})), /invalid/);
  assert.throws(() => buildProjectMcpTools([{ ...declaration, inputSchema: { type: 'string' } }], async () => ({})), /invalid/);
});
