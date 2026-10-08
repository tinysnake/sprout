import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SqliteStore } from './db.ts';
import { workingDirectoryId } from '../run/session-key-store.ts';

const legacyProfile = { platform: 'unknown', boundary: 'unknown' } as const;

test('schema migration records legacy runs, begun Tasks, and continuation slots as Environment-hosted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-placement-migration-'));
  const filename = join(directory, 'sprout.db');
  try {
    const initial = new SqliteStore({ filename });
    await initial.tasks.create({
      id: 'task-migration',
      projectId: 'project-migration',
      title: 'Legacy begun Task',
      goal: 'Keep its binding.',
      constraints: [],
      status: 'in-progress',
      environmentInstanceId: 'env-migration',
      environmentLeaseId: 'lease-migration',
      environmentLifecycleState: 'idle',
      createdAt: 10,
      updatedAt: 11,
    });
    initial.leases.save({
      id: 'lease-migration',
      instanceId: 'env-migration',
      capability: 'agent-run',
      holderId: 'task-migration',
      holderKind: 'task',
      taskId: 'task-migration',
      acquiredAt: 10,
      expiresAt: 60_010,
      state: 'active',
    });
    await initial.runs.save({
      id: 'run-migration',
      agentId: 'agent-migration',
      prompt: 'continue the Task',
      environmentInstanceId: 'env-migration',
      projectId: 'project-migration',
      taskId: 'task-migration',
      status: 'interrupted',
      events: [],
      workspaceBinding: { bindingId: 'binding-migration', workspaceId: 'workspace-migration', kind: 'relative', path: 'repos/sample' },
      createdAt: 12,
      completedAt: 13,
    });
    initial.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA user_version = 30;
      UPDATE agent_runs SET execution_placement = NULL;
      UPDATE tasks SET execution_placement = NULL;
      DROP TABLE agent_session_keys;
      CREATE TABLE agent_session_keys (
        slot TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL,
        working_directory_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const directoryId = workingDirectoryId('/work/project');
    legacy.prepare('INSERT INTO agent_session_keys VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      JSON.stringify(['agent-migration', 'pi', 'env-migration', directoryId]),
      'agent-migration', 'pi', 'env-migration', directoryId, 'legacy-session', 14,
    );
    legacy.close();

    const reopened = new SqliteStore({ filename });
    const run = await reopened.runs.get('run-migration');
    const task = await reopened.tasks.get('task-migration');
    const key = (await reopened.sessionKeys.list())[0];
    const legacySlotKey = await reopened.sessionKeys.get({
      agentId: 'agent-migration',
      engine: 'pi',
      environmentInstanceId: 'env-migration',
      executionPlacement: {
        mode: 'environment-hosted',
        engineHost: { kind: 'environment', id: 'env-migration', profile: legacyProfile },
      },
      scope: { kind: 'conversation', id: 'legacy-unscoped' },
      workingDirectory: '/work/project',
    });
    assert.deepEqual(run?.executionPlacement, {
      mode: 'environment-hosted',
      engineHost: { kind: 'environment', id: 'env-migration', profile: legacyProfile },
    });
    assert.deepEqual(run?.workspaceBinding, {
      bindingId: 'binding-migration', workspaceId: 'workspace-migration', kind: 'relative', path: 'repos/sample',
    });
    assert.equal(run?.status, 'interrupted');
    assert.deepEqual(task?.executionPlacement, {
      mode: 'environment-hosted',
      engineHost: { kind: 'environment', id: 'env-migration', profile: legacyProfile },
    });
    assert.equal(task?.environmentInstanceId, 'env-migration');
    assert.equal(task?.environmentLeaseId, 'lease-migration');
    assert.equal(reopened.leases.get('lease-migration')?.state, 'active');
    assert.deepEqual(key?.executionPlacement, {
      mode: 'environment-hosted',
      engineHost: { kind: 'environment', id: 'env-migration', profile: legacyProfile },
    });
    assert.deepEqual(key?.scope, { kind: 'conversation', id: 'legacy-unscoped' });
    assert.equal(key?.key, 'legacy-session');
    assert.equal(legacySlotKey?.key, 'legacy-session', 'the migrated slot uses its new durable identity');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
