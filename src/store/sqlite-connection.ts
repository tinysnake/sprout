import type { DatabaseSync } from 'node:sqlite';

/** Apply the product's bounded, concurrent-writer SQLite connection policy. */
export function configureProductSqliteConnection(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
}
