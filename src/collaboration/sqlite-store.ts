import { DatabaseSync } from 'node:sqlite';

import type {
  Message,
  MessageChannel,
  MessageAuthor,
  WakeObservation,
  WakePlan,
  WakeReason,
  WakeRequest,
  WakeStatus,
} from './model.ts';
import {
  type AdmitWakeResult,
  type CollaborationStore,
  type PostMessageResult,
  wakeFromDecision,
} from './store.ts';
import {
  assertSchemaCompatibility,
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  setSchemaVersion,
} from '../store/schema.ts';

/**
 * SQLite-backed collaboration storage (ticket #26, ADR-0002).
 *
 * The only module that knows the collaboration SQL. It is mounted on Sprout's
 * primary `SqliteStore` so collaboration rows share the one database the run
 * lifecycle, leases, and projects already use. It enforces both idempotency
 * identities with primary keys rather than caller checks:
 *
 * - `collaboration_messages.delivery_key` is unique, so a repeated delivery
 *   produces one Message (and its `INSERT OR IGNORE` reports that nothing was
 *   added).
 * - `collaboration_wake_requests.idempotency_key` is unique, and
 *   `admitWake` performs the state transition and the status guard in one
 *   synchronous statement, so two admiters cannot both win the same wake.
 *
 * Wake requests are written **in the same transaction as the Message**, which is
 * what makes persistence-before-wake a property of the store rather than a
 * convention the coordinator is trusted to follow.
 */

export class SqliteCollaborationStore implements CollaborationStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      assertSchemaCompatibility(this.#db, undefined, options.filename);
    }
    this.#init();
    if (this.#ownsDb && getSchemaVersion(this.#db) === 0) {
      setSchemaVersion(this.#db, CURRENT_SCHEMA_VERSION);
    }
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        body TEXT NOT NULL,
        recipients TEXT NOT NULL,
        delivery_key TEXT NOT NULL UNIQUE,
        in_reply_to TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaboration_wake_requests (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        run_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaboration_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async postMessage(input: {
    readonly message: Message;
    readonly plan: WakePlan;
    readonly now: number;
  }): Promise<PostMessageResult> {
    // One transaction: the Message and every wake request it implies become
    // durable together, so no observer can ever see a Message with no wake
    // request to recover from.
    this.#db.exec('BEGIN');
    try {
      const inserted = this.#db
        .prepare(
          `INSERT OR IGNORE INTO collaboration_messages
             (id, project_id, channel, author_id, author_kind, body, recipients, delivery_key, in_reply_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.message.id,
          input.message.projectId,
          input.message.channel,
          input.message.author.id,
          input.message.author.kind,
          input.message.body,
          JSON.stringify(input.message.recipients),
          input.message.deliveryKey,
          input.message.inReplyTo ?? null,
          input.message.createdAt,
        );

      if (inserted.changes === 0) {
        // The delivery key already existed: this is a retry. Return the stored
        // Message and its existing wake requests unchanged.
        this.#db.exec('COMMIT');
        const existing = (await this.getMessageByDeliveryKey(input.message.deliveryKey))!;
        return {
          message: existing,
          wakes: (await this.listWakeRequests()).filter((w) => w.messageId === existing.id),
          duplicate: true,
        };
      }

      for (const decision of input.plan.decisions) {
        const wake = wakeFromDecision({
          id: `wake-${input.message.id}-${decision.agentId}`,
          messageId: input.message.id,
          projectId: input.message.projectId,
          agentId: decision.agentId,
          reason: decision.reason,
          now: input.now,
        });
        this.#insertWake(wake);
      }
      for (const observation of input.plan.observations) {
        this.#insertObservation(input.message.id, observation, input.now);
      }
      this.#db.exec('COMMIT');
      return {
        message: input.message,
        wakes: (await this.listWakeRequests()).filter((w) => w.messageId === input.message.id),
        duplicate: false,
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #insertWake(wake: WakeRequest): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO collaboration_wake_requests
           (id, message_id, project_id, agent_id, reason, status, idempotency_key, run_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wake.id,
        wake.messageId,
        wake.projectId,
        wake.agentId,
        wake.reason,
        wake.status,
        wake.idempotencyKey,
        wake.runId ?? null,
        wake.detail ?? null,
        wake.createdAt,
      );
  }

  #insertObservation(messageId: string, observation: WakeObservation, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO collaboration_observations
           (message_id, agent_id, status, reason, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, observation.agentId, observation.status, observation.reason, observation.detail, now);
  }

  async getMessage(messageId: string): Promise<Message | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM collaboration_messages WHERE id = ?')
      .get(messageId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  async getMessageByDeliveryKey(deliveryKey: string): Promise<Message | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM collaboration_messages WHERE delivery_key = ?')
      .get(deliveryKey) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  async listMessages(): Promise<readonly Message[]> {
    const rows = this.#db
      .prepare('SELECT * FROM collaboration_messages ORDER BY created_at ASC')
      .all() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  async getWakeRequest(idempotencyKey: string): Promise<WakeRequest | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM collaboration_wake_requests WHERE idempotency_key = ?')
      .get(idempotencyKey) as WakeRow | undefined;
    return row ? toWake(row) : undefined;
  }

  async listWakeRequests(): Promise<readonly WakeRequest[]> {
    const rows = this.#db
      .prepare('SELECT * FROM collaboration_wake_requests ORDER BY created_at ASC')
      .all() as unknown as WakeRow[];
    return rows.map(toWake);
  }

  /**
   * Compare-and-set one wake request to `admitted`.
   *
   * The guard lives in the `WHERE status = 'pending'` clause, so the database —
   * not the caller — decides which of two concurrent admiters wins. A wake that
   * is already `admitted` returns `admitted: false` with the run that holds it.
   */
  async admitWake(input: {
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly now: number;
  }): Promise<AdmitWakeResult> {
    const updated = this.#db
      .prepare(
        `UPDATE collaboration_wake_requests
            SET status = 'admitted', run_id = ?
          WHERE idempotency_key = ? AND status = 'pending'`,
      )
      .run(input.runId, input.idempotencyKey);
    const wake = await this.getWakeRequest(input.idempotencyKey);
    if (!wake) throw new Error(`unknown wake request: ${input.idempotencyKey}`);
    return { admitted: updated.changes > 0, wake };
  }

  async recordObservation(input: {
    readonly messageId: string;
    readonly observation: WakeObservation;
    readonly now: number;
  }): Promise<void> {
    this.#insertObservation(input.messageId, input.observation, input.now);
  }

  async listObservations(messageId: string): Promise<readonly WakeObservation[]> {
    return this.observations(messageId);
  }

  /** Observations recorded for one Message, for observability and tests. */
  observations(messageId: string): readonly WakeObservation[] {
    const rows = this.#db
      .prepare('SELECT * FROM collaboration_observations WHERE message_id = ? ORDER BY id ASC')
      .all(messageId) as unknown as ObservationRow[];
    return rows.map((row) => ({
      agentId: row.agent_id,
      status: row.status as WakeObservation['status'],
      reason: row.reason as WakeObservation['reason'],
      detail: row.detail,
    }));
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

interface MessageRow {
  readonly id: string;
  readonly project_id: string;
  readonly channel: string;
  readonly author_id: string;
  readonly author_kind: string;
  readonly body: string;
  readonly recipients: string;
  readonly delivery_key: string;
  readonly in_reply_to: string | null;
  readonly created_at: number;
}

interface WakeRow {
  readonly id: string;
  readonly message_id: string;
  readonly project_id: string;
  readonly agent_id: string;
  readonly reason: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly run_id: string | null;
  readonly detail: string | null;
  readonly created_at: number;
}

interface ObservationRow {
  readonly agent_id: string;
  readonly status: string;
  readonly reason: string;
  readonly detail: string;
}

function toMessage(row: MessageRow): Message {
  const author: MessageAuthor = { id: row.author_id, kind: row.author_kind as MessageAuthor['kind'] };
  return {
    id: row.id,
    projectId: row.project_id,
    channel: row.channel as MessageChannel,
    author,
    body: row.body,
    recipients: JSON.parse(row.recipients) as string[],
    deliveryKey: row.delivery_key,
    ...(row.in_reply_to !== null ? { inReplyTo: row.in_reply_to } : {}),
    createdAt: row.created_at,
  };
}

function toWake(row: WakeRow): WakeRequest {
  return {
    id: row.id,
    messageId: row.message_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    reason: row.reason as WakeReason,
    status: row.status as WakeStatus,
    idempotencyKey: row.idempotency_key,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    createdAt: row.created_at,
  };
}
