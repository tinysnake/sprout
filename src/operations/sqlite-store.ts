import type { DatabaseSync } from 'node:sqlite';
import { EVENT_STATES, type EventKind, type EventState, type OperationalEvent } from './contract.ts';
import type { OperationalStore } from './service.ts';
/** One SQL statement deduplicates state observations before insertion. */
export class SqliteOperationalStore implements OperationalStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS operational_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS operational_events_subject ON operational_events(subject, kind, sequence);`);
  }
  async transition(subject: string, kind: EventKind, state: EventState, at: number): Promise<void> {
    this.db.prepare(`INSERT INTO operational_events(subject, kind, state, at)
      SELECT ?, ?, ?, ? WHERE COALESCE((SELECT state FROM operational_events
      WHERE subject = ? AND kind = ? ORDER BY sequence DESC LIMIT 1), '') != ?`)
      .run(subject, kind, state, at, subject, kind, state);
  }
  async events(): Promise<readonly OperationalEvent[]> {
    // Fail closed for legacy/tampered documents: never forward unknown text.
    return this.db.prepare('SELECT sequence, subject, kind, state, at FROM operational_events ORDER BY sequence').all().flatMap(row => {
      const kind = row.kind as EventKind;
      if (!Object.hasOwn(EVENT_STATES, kind) || !(EVENT_STATES[kind] as readonly unknown[]).includes(row.state) || typeof row.subject !== 'string' || !/^[a-f0-9]{64}$/.test(row.subject) || !Number.isSafeInteger(row.at)) return [];
      return [{ sequence: Number(row.sequence), subject: row.subject, kind, state: row.state as EventState, at: Number(row.at) }];
    });
  }
}
