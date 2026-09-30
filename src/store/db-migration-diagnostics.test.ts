import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './db.ts';
import { DEFAULT_MIGRATIONS } from './schema.ts';

const MIGRATION_TRIGGER = 'fail_migration_journal';

test('a failed migration journal write cannot leave a committed schema without its migrated fact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-migration-journal-'));
  const filename = join(directory, 'state.db');
  let injectJournalFailure = true;
  const migrations = DEFAULT_MIGRATIONS.map(step => step.fromVersion === 21
    ? { ...step, migrate(db: DatabaseSync) {
      step.migrate(db);
      if (injectJournalFailure) db.exec(`CREATE TRIGGER ${MIGRATION_TRIGGER}
        BEFORE INSERT ON operational_events WHEN NEW.kind = 'migration'
        BEGIN SELECT RAISE(ABORT, 'simulated migration journal failure'); END;`);
    } }
    : step);
  const options = { filename, createSafetyCopy: () => undefined, migrations };

  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec('CREATE TABLE legacy_data (value TEXT); PRAGMA user_version = 21;');
    legacy.close();

    // Fault at the former commit→journal gap. The old implementation commits
    // v22, then this trigger rejects its out-of-transaction journal insert.
    assert.throws(() => new SqliteStore(options));

    const afterFailedOpen = new DatabaseSync(filename);
    const versionAfterFailure = (afterFailedOpen.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    afterFailedOpen.exec(`DROP TRIGGER IF EXISTS ${MIGRATION_TRIGGER}`);
    afterFailedOpen.close();

    injectJournalFailure = false;
    const reopened = new SqliteStore(options);
    const migrationStates = (await reopened.operations.events())
      .filter(event => event.kind === 'migration')
      .map(event => event.state);
    reopened.close();

    assert.deepEqual(migrationStates, ['migrated'], 'restart must retain the transition from schema v21, not relabel it unchanged');
    assert.equal(versionAfterFailure, 21, 'a failed journal write must roll back the schema migration with it');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
