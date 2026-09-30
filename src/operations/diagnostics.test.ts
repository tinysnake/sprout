import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/db.ts';
import { DiagnosticsService } from './service.ts';
import { projectHostDiagnostic } from './contract.ts';

test('transition journal survives reopen, ignores heartbeat facts and excludes arbitrary input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostic-test-'));
  const filename = join(dir, 'state.db');
  try {
    let store = new SqliteStore({ filename });
    const service = new DiagnosticsService(store.operations);
    await service.transition('internal-source', 'connection', 'online', 1);
    await Promise.all(Array.from({ length: 10 }, () => service.transition('internal-source', 'connection', 'online', 2)));
    await service.transition('internal-source', 'connection', 'offline', 3);
    await assert.rejects(service.transition('internal-source', 'connection', 'private-text' as never, 4));
    store.db.prepare('INSERT INTO operational_events(subject, kind, state, at) VALUES (?, ?, ?, ?)').run('UNTRUSTED_PRIVATE_PAYLOAD', 'connection', 'online', 4);
    store.db.prepare('INSERT INTO operational_events(subject, kind, state, at) VALUES (?, ?, ?, ?)').run('a'.repeat(64), 'connection', 'UNTRUSTED_PRIVATE_PAYLOAD', 5);
    store.close();
    store = new SqliteStore({ filename });
    const events = (await new DiagnosticsService(store.operations).events()).filter(e => e.kind === 'connection');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.state), ['online', 'offline']);
    assert.equal(JSON.stringify(events).includes('internal-source'), false);
    assert.equal(JSON.stringify(events).includes('UNTRUSTED_PRIVATE_PAYLOAD'), false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host contract structurally excludes text and fails closed on unknown facts', () => {
  const result = projectHostDiagnostic({ service: 'running', data: 'accessible', worker: 'connected', reachability: 'reachable', engines: [{ engine: 'pi', readiness: 'ready', stderr: 'PRIVATE' }], credential: 'PRIVATE', hostname: 'PRIVATE', schema: 22 } as never);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.scope, 'host-local');
  assert.equal(projectHostDiagnostic({ service: 'PRIVATE' } as never).service, 'unknown');
});
