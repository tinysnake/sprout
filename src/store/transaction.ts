import type { DatabaseSync } from 'node:sqlite';

/**
 * Shared transaction coordination for Sprout's one SQLite connection (#81).
 *
 * A domain adapter owns the SQL for its own tables; this seam owns the one
 * connection's transaction lifecycle instead. A cross-domain write — the Task
 * lifecycle committing a Task row together with its Task-held lease — asks the
 * coordinator to run one boundary, so both adapters' statements commit or roll
 * back as one durable state without either adapter re-implementing
 * `BEGIN`/`COMMIT`/`ROLLBACK` over the other domain's table.
 *
 * The statements are the ones M1 used; only their owner moved. Every existing
 * transaction boundary and crash outcome is therefore unchanged.
 */
export interface TransactionCoordinator {
  /**
   * Run `operation` inside one `BEGIN IMMEDIATE` … `COMMIT`, rolling back and
   * rethrowing when it throws.
   *
   * `BEGIN IMMEDIATE` is what makes a Task begin/end boundary writable at the
   * moment it starts, so a concurrent writer cannot interleave between the
   * conflict check and the commit.
   */
  immediate<T>(operation: () => T): T;
}

/** Bind a coordinator to exactly one open connection's lifecycle. */
export function createTransactionCoordinator(db: DatabaseSync): TransactionCoordinator {
  return {
    immediate<T>(operation: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
