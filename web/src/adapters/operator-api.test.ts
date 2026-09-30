import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserTransport } from '../transport/browser-transport.ts';
import { createOperatorBrowserAdapter } from './operator-api.ts';

test('operator browser adapter uses protected typed read routes and inherits transport state', async () => {
  const paths: string[] = [];
  const transport = createBrowserTransport({ fetch: async (path) => {
    paths.push(String(path));
    return new Response(JSON.stringify({ format: 1 }), { status: 200 });
  } });
  const adapter = createOperatorBrowserAdapter(transport);
  await adapter.settings();
  const diagnostic = await adapter.exportDiagnostics();
  assert.equal(diagnostic.format, 1);
  assert.deepEqual(paths, ['/api/operator/settings', '/api/operator/diagnostics']);
  assert.deepEqual(adapter.state(), transport.state());
});
