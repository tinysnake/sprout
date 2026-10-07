import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, hostConfiguration, enrollEligibleInstance } from './runtime-test-harness.ts';
import { CURRENT_SCHEMA_VERSION } from './store/schema.ts';
import type { WebDiagnostic, OperatorSettings } from './operations/contract.ts';

test('production operator API requires a session and preserves diagnostic journal across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-api-'));
  const configuration = hostConfiguration({ databasePath: join(directory, 'state.db'), environmentSource: 'enrollment', executionMode: 'host-run', operatorCredential: 'synthetic-operator-credential' });
  let runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project' });
  try {
    await enrollEligibleInstance(runtime, 'synthetic-environment', join(directory, 'worker-key.pem'));
    let priorEvents = 0;
    for (let iteration = 0; iteration < 2; iteration++) {
      const address = runtime.api.server.address();
      const { port } = address !== null && typeof address === 'object' ? address : await runtime.api.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${port}`;
      const anonymous = await fetch(`${base}/api/operator/diagnostics`);
      assert.equal(anonymous.status, 401);
      const login = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'synthetic-operator-credential' }) });
      assert.equal(login.status, 201);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const response = await fetch(`${base}/api/operator/diagnostics`, { headers: { cookie } });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const diagnostics = await response.json() as WebDiagnostic;
      assert.equal(diagnostics.schema, CURRENT_SCHEMA_VERSION);
      assert.equal(diagnostics.scope, 'web');
      assert.equal(diagnostics.environments[0]!.connection, iteration === 0 ? 'online' : 'offline');
      assert.equal(diagnostics.environments[0]!.worker, iteration === 0 ? 'connected' : 'not-connected');
      assert.ok(diagnostics.events.some(e => e.kind === 'enrollment' && e.state === 'approved'));
      assert.ok(diagnostics.events.some(e => e.kind === 'connection' && e.state === 'online'));
      assert.equal(diagnostics.events.filter(e => e.kind === 'startup').length, iteration + 1);
      assert.ok(diagnostics.events.length > priorEvents);
      priorEvents = diagnostics.events.length;
      const settings = await (await fetch(`${base}/api/operator/settings`, { headers: { cookie } })).json() as OperatorSettings;
      assert.equal(settings.session.authenticated, true);
      assert.equal(settings.executionMode, 'host-run');
      assert.equal(runtime.executionStrategy.mode, 'host-run');
      assert.deepEqual(settings.responsibilities.web, ['sessions', 'enrollment', 'recovery', 'diagnostics']);
      assert.deepEqual(await runtime.orchestrator.list(), [], 'configuration and readiness reads do not admit model work');
      assert.equal(JSON.stringify(diagnostics).includes('synthetic-operator-credential'), false);
      await runtime.close();
      if (iteration === 0) runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project' });
    }
  } finally { await runtime.close().catch(() => undefined); rmSync(directory, { recursive: true, force: true }); }
});
