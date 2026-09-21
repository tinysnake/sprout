import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteStore } from '../store/db.ts';
import { getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../store/schema.ts';
import { ProjectService } from './authority-service.ts';
import { SqliteProjectAuthorityStore } from './sqlite-authority-store.ts';

/**
 * Persistence and restart behaviour for Project authority records (#92, #83).
 *
 * The authority record is written through the unified SQLite handle, so its
 * content versions, template attribution, membership history, and
 * archive/restore facts survive a process restart the same way runs, leases,
 * Tasks, and Agent identities do — and a v7 database forward-migrates to v8
 * with a safety copy, without touching the v7 rows.
 */

test('a Project authority record survives being written to disk and read back after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-project-authority-'));
  try {
    const dbPath = join(dir, 'sprout.db');
    const writer = new SqliteStore({ filename: dbPath });
    const projects = new ProjectService({ store: writer.projectAuthorities, clock: () => 1_000 });
    const created = await projects.create({
      id: 'project-restart',
      displayName: 'Restart proof',
      goal: 'Survive the process',
      rules: ['Keep versions'],
      wakePolicy: 'wake-model-assisted',
      routingIntervalMs: 45_000,
      agentMemberships: [
        { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: 'Concise.' },
      ],
    });
    await projects.updateContent('project-restart', { goal: 'Revised after review', reason: 'review' });
    await projects.endMembership('project-restart', 'agent-scout', { reason: 'ended for the test' });
    await projects.archive('project-restart', { reason: 'test archive' });
    writer.close();

    // A second handle is a new process reading the same file.
    const reopened = new SqliteStore({ filename: dbPath });
    assert.equal(reopened.schemaVersion, CURRENT_SCHEMA_VERSION);
    const stored = await reopened.projectAuthorities.get('project-restart');
    assert.ok(stored);
    // Template attribution survives verbatim.
    assert.equal(stored.template.templateId, created.template.templateId);
    assert.equal(stored.template.templateVersion, 1);
    // Content versions and their reasons survive in order. Creation, the
    // content edit, and the membership end each appended one version; the
    // archive changed only the status facts.
    assert.equal(stored.content.versions.length, 3);
    assert.equal(stored.content.versions[0]?.goal, 'Survive the process');
    assert.equal(stored.content.versions[1]?.goal, 'Revised after review');
    assert.equal(stored.content.versions[1]?.reason, 'review');
    assert.equal(stored.content.versions[1]?.wakePolicy, 'wake-model-assisted');
    // Membership history, including the end facts, survives.
    const membership = stored.content.versions[2]?.memberships.find((m) => m.memberId === 'agent-scout');
    assert.equal(membership?.endedReason, 'ended for the test');
    assert.ok(membership?.endedAt);
    // Archive facts survive.
    assert.equal(stored.status, 'archived');
    assert.equal(stored.archivedReason, 'test archive');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a v7 database forward-migrates to v8 with a safety copy and keeps its project rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-project-migration-'));
  try {
    const dbPath = join(dir, 'sprout.db');
    // Seed a v7-shaped database: the v7 agents table with one row plus the
    // v1-era projects table with data, stamped at version 7.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA user_version = 7;
      CREATE TABLE projects (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      INSERT INTO projects VALUES ('legacy', '{"id":"legacy"}');
      CREATE TABLE agents (id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO agents VALUES ('a1', '{"id":"a1"}', 1);
    `);
    seed.close();

    const store = new SqliteStore({ filename: dbPath });
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(getSchemaVersion(store.db), CURRENT_SCHEMA_VERSION);
    // Pre-existing rows are untouched by the additive migration.
    const legacy = store.db.prepare('SELECT document FROM projects WHERE id = ?').get('legacy') as {
      document: string;
    };
    assert.equal(JSON.parse(legacy.document).id, 'legacy');
    // The new authority table exists and serves records.
    const projects = new ProjectService({ store: store.projectAuthorities, clock: () => 5_000 });
    const created = await projects.create({ id: 'project-new', displayName: 'New after migration' });
    assert.equal(created.content.currentVersion, 1);
    store.close();

    // The safety copy was created before migration and remains at v7.
    const copyPath = `${dbPath}.safety-copy`;
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    assert.equal(getSchemaVersion(copy), 7);
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the standalone project authority store refuses a newer schema like every other adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-project-authority-refusal-'));
  try {
    const dbPath = join(dir, 'future.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA user_version = 99; CREATE TABLE future (id TEXT);');
    seed.close();
    assert.throws(
      () => new SqliteProjectAuthorityStore({ filename: dbPath }),
      (error: unknown) => error instanceof Error && error.name === 'SchemaTooNewError',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
