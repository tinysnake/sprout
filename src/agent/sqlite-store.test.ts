import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteAgentStore } from './sqlite-store.ts';
import { createAgentConfiguration, type Agent } from './model.ts';
import { SqliteStore } from '../store/db.ts';
import { SqliteRunStore } from '../run/sqlite-store.ts';
import { getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../store/schema.ts';

/**
 * Durable persistence for portable Agent identities (#90).
 *
 * The acceptance rule under test: an Agent's identity, display name, standing
 * instructions, ordered work options, and append-only configuration versions
 * survive a store close and reopen — as does a run's recorded work-option
 * attribution — and reopening an older-version database forward-migrates
 * without losing agents.
 */

function makeAgent(id: string, at: number): Agent {
  const created = createAgentConfiguration({
    displayName: 'Programmer',
    instructions: 'Check pure functions.',
    workOptions: [
      { id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' },
      { id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
    ],
    at,
  });
  return {
    id,
    displayName: created.displayName,
    status: 'active',
    configuration: created.configuration,
    createdAt: at,
    updatedAt: at,
  };
}

test('an Agent and its configuration history survive close and reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-agent-store-'));
  const path = join(directory, 'sprout.db');
  try {
    const store = new SqliteAgentStore({ filename: path });
    const agent = makeAgent('programmer', 1_000);
    await store.save(agent);

    // Append a second version, then archive.
    const archived: Agent = {
      ...agent,
      status: 'archived',
      configuration: {
        currentVersion: 2,
        versions: [
          ...agent.configuration.versions,
          {
            version: 2,
            at: 2_000,
            reason: 'switch primary engine',
            options: [{ id: 'opt-1', engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
            instructions: 'Check pure functions.',
          },
        ],
      },
      updatedAt: 2_000,
    };
    await store.save(archived);
    store.close();

    const reopened = new SqliteAgentStore({ filename: path });
    const loaded = await reopened.get('programmer');
    assert.ok(loaded, 'agent must survive reopen');
    assert.equal(loaded!.status, 'archived');
    assert.equal(loaded!.displayName, 'Programmer');
    assert.equal(loaded!.configuration.currentVersion, 2);
    assert.equal(loaded!.configuration.versions.length, 2);
    assert.equal(loaded!.configuration.versions[0]!.options[0]!.engine, 'codex');
    assert.equal(loaded!.configuration.versions[1]!.options[0]!.engine, 'pi');
    assert.equal(loaded!.configuration.versions[0]!.instructions, 'Check pure functions.');
    assert.equal((await reopened.list()).length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the composed handle mounts the agent store on the shared database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-agent-composed-'));
  const path = join(directory, 'sprout.db');
  try {
    const handle = new SqliteStore({ filename: path });
    assert.equal(handle.schemaVersion, CURRENT_SCHEMA_VERSION);
    await handle.agentIdentities.save(makeAgent('programmer', 1_000));
    const loaded = await handle.agentIdentities.get('programmer');
    assert.equal(loaded?.displayName, 'Programmer');
    handle.close();

    const reopened = new SqliteStore({ filename: path });
    assert.equal((await reopened.agentIdentities.get('programmer'))?.displayName, 'Programmer');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a v6 database forward-migrates to v7 and keeps its runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-agent-migration-'));
  const path = join(directory, 'sprout.db');
  try {
    // Build a current store, then force its version marker back to v6 (the
    // state a pre-#90 build left on disk). Its rows carry no agents and no
    // work-option attribution, and the forward migration must preserve them.
    const seed = new SqliteStore({ filename: path });
    const run = {
      id: 'run-1',
      agentId: 'agent-scout',
      prompt: 'hi',
      environmentInstanceId: 'mac-mini-1',
      status: 'completed' as const,
      events: [],
      result: { status: 'completed', text: 'done' } as const,
      createdAt: 1_000,
      completedAt: 1_500,
    };
    await seed.runs.save(run);
    seed.close();
    const raw = new (await import('node:sqlite')).DatabaseSync(path);
    raw.exec('PRAGMA user_version = 6');
    raw.close();

    const migrated = new SqliteStore({ filename: path });
    assert.equal(getSchemaVersion(migrated.db), CURRENT_SCHEMA_VERSION);
    const loaded = await migrated.runs.get('run-1');
    assert.equal(loaded?.result?.status === 'completed' ? loaded.result.text : undefined, 'done');
    // A pre-#90 run carries no work-option attribution, which the view layer
    // reports as unspecified rather than inventing one.
    assert.equal(loaded?.workOption, undefined);
    assert.equal(loaded?.configurationVersion, undefined);
    // The agents table exists and is empty.
    assert.equal((await migrated.agentIdentities.list()).length, 0);
    migrated.close();

    // A standalone run store over the migrated file agrees.
    const standalone = new SqliteRunStore({ filename: path });
    assert.equal((await standalone.get('run-1'))?.agentId, 'agent-scout');
    standalone.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
