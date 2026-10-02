import type { DatabaseSync } from 'node:sqlite';

const WAL_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;
const SQLITE_BUSY = 5;

export class SqliteWalStartupError extends Error {
  constructor(options: { cause: unknown }) {
    super('Could not enable SQLite WAL mode after bounded retries; database startup aborted.', options);
    this.name = 'SqliteWalStartupError';
  }
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'errcode' in error && (error as { errcode?: unknown }).errcode === SQLITE_BUSY;
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Apply the product's bounded, concurrent-writer SQLite connection policy. */
export function configureProductSqliteConnection(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000;');

  let retry = 0;
  for (;;) {
    try {
      const result = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
      const mode = result?.journal_mode?.toLowerCase();
      // SQLite cannot put an in-memory database in WAL mode.
      if (mode !== 'wal' && mode !== 'memory') {
        throw new Error('SQLite did not enable WAL mode.');
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const delay = WAL_RETRY_DELAYS_MS[retry];
      if (delay === undefined) throw new SqliteWalStartupError({ cause: error });
      pause(delay);
      retry += 1;
    }
  }
}
