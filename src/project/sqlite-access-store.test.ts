import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteProjectAccessStore } from './sqlite-access-store.ts';
import { SqliteStore } from '../store/db.ts';
import { getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../store/schema.ts';
import { accessIsConsistent, type ProjectEnvironmentAccess } from './access.ts';

/**
 * Persistence and restart behaviour for Project Environment access (#93).
 *
 * The whole relationship, including its append-only workspace binding history,
 * is one document: a restart must return exactly the current binding and the
 * retained history, and the shared handle and a standalone adapter must agree.
 */

function sampleAccess(overrides: Partial<ProjectEnvironmentAccess> = {}): ProjectEnvironmentAccess {
  return {
    projectId: 'project-sprout',
    environmentInstanceId: 'mac-mini-1',
    status: 'active',
    startedAt: 1_000,
    updatedAt: 2_000,
    current: {
      bindingId: 'binding-2',
      workspaceId: 'b'.repeat(40),
      kind: 'relative',
      path: 'repos/second',
      boundAt: 2_000,
    },
    history: [
      {
        bindingId: 'binding-1',
        workspaceId: 'a'.repeat(40),
        kind: 'relative',
        path: 'repos/first',
        boundAt: 1_000,
        unboundAt: 2_000,
        unboundReason: 'moved',
      },
      {
        bindingId: 'binding-2',
        workspaceId: 'b'.repeat(40),
        kind: 'relative',
        path: 'repos/second',
        boundAt: 2_000,
      },
    ],
    ...overrides,
  };
}

test('a standalone access store round-trips the current binding and its history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-access-store-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteProjectAccessStore({ filename: path });
    const access = sampleAccess();
    await store.save(access);
    assert.deepEqual(await store.get('project-sprout', 'mac-mini-1'), access);
    assert.deepEqual(await store.listForProject('project-sprout'), [access]);
    assert.deepEqual(await store.list(), [access]);
    store.close();

    // Reopening the same file returns the record unchanged: a restart retains
    // both the current binding and the superseded one.
    const reopened = new SqliteProjectAccessStore({ filename: path });
    const restored = await reopened.get('project-sprout', 'mac-mini-1');
    assert.deepEqual(restored, access);
    assert.equal(accessIsConsistent(restored!), true);
    assert.equal(restored?.history.length, 2);
    assert.equal(restored?.history[0]?.unboundAt, 2_000);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the composed SQLite handle mounts the access table at the current schema version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-access-handle-'));
  const path = join(directory, 'sprout.db');
  try {
    const handle = new SqliteStore({ filename: path });
    assert.equal(handle.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(getSchemaVersion(handle.db), CURRENT_SCHEMA_VERSION);
    await handle.projectAccess.save(sampleAccess());
    const standalone = new SqliteProjectAccessStore({ filename: path });
    assert.deepEqual(await standalone.get('project-sprout', 'mac-mini-1'), sampleAccess());
    standalone.close();
    handle.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ending access is durable: the current binding is gone but history remains', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-access-ended-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteProjectAccessStore({ filename: path });
    // An ended record has no current binding at all: build it explicitly so the
    // accidental-undefined protection stays on (exactOptionalPropertyTypes).
    const ended: ProjectEnvironmentAccess = {
      projectId: 'project-sprout',
      environmentInstanceId: 'mac-mini-1',
      status: 'ended',
      startedAt: 1_000,
      updatedAt: 3_000,
      endedAt: 3_000,
      endedReason: 'retired',
      history: [
        {
          bindingId: 'binding-1',
          workspaceId: 'a'.repeat(40),
          kind: 'relative',
          path: 'repos/first',
          boundAt: 1_000,
          unboundAt: 3_000,
          unboundReason: 'retired',
        },
      ],
    };
    await store.save(ended);
    store.close();
    const reopened = new SqliteProjectAccessStore({ filename: path });
    const restored = await reopened.get('project-sprout', 'mac-mini-1');
    assert.equal(restored?.status, 'ended');
    assert.equal(restored?.current, undefined);
    assert.equal(restored?.endedReason, 'retired');
    assert.equal(restored?.history.length, 1);
    assert.equal(accessIsConsistent(restored!), true);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
