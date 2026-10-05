import { DatabaseSync } from 'node:sqlite';

import type { ProjectEvent } from './events.ts';
import { validateAttentionResolution, type CollaborationAttentionResolution, type ResolveCollaborationAttention, type FailedWakeInput } from './attention.ts';
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
import type { FrozenRoutingBatchPlan } from './routing-context.ts';
import type {
  RoutingAssignment,
  RoutingAttempt,
  RoutingBatch,
  RoutingBatchInput,
  RoutingBounds,
  RoutingContextManifest,
  RoutingFailureKind,
  RoutingInputOutcome,
  RoutingInputStatus,
  RoutingWindow,
} from './routing.ts';
import {
  type AdmitWakeResult,
  type CollaborationStore,
  type MessagePage,
  type MessagePageQuery,
  type ProjectEventPage,
  type ProjectEventPageQuery,
  type PostMessageResult,
  type PublishEventResult,
  type RoutingWindowCollect,
  wakeFromDecision,
} from './store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite-backed collaboration storage (#26, #96, #97, ADR-0002).
 *
 * The only module that knows the collaboration SQL. It is mounted on Sprout's
 * primary `SqliteStore` so collaboration rows share the one database the run
 * lifecycle, leases, and projects already use. It enforces the idempotency
 * identities with primary keys rather than caller checks:
 *
 * - `collaboration_messages.delivery_key` and `project_events.delivery_key`
 *   are unique, so a repeated delivery produces one input (and its `INSERT OR
 *   IGNORE` reports that nothing was added).
 * - `collaboration_wake_requests.idempotency_key` is unique, and `admitWake`
 *   performs the state transition and the status guard in one synchronous
 *   statement, so two admiters cannot both win the same wake.
 *
 * Inputs and their wake requests are written **in the same transaction**, which
 * is what makes persistence-before-wake a property of the store rather than a
 * convention the coordinator is trusted to follow.
 *
 * Schema history: `scope_id` and the `input_id` rename (from `message_id`)
 * arrive with schema version 19; `project_events` is created by the same
 * migration and by `#init` for a fresh database; the routing windows, batch,
 * batch-input, attempt, outcome, and batch-wake `batch_id` columns arrive with
 * schema version 21 (#97 recovery boundary).
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
      try {
        migrateOrInitializeDatabase(this.#db, { filename: options.filename });
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
    this.#init();
  }

  async unreadCount(scopeId: string, humanId: string): Promise<number> {
    const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM collaboration_messages
      WHERE scope_id = ? AND author_id != ? AND rowid > COALESCE(
        (SELECT m.rowid FROM collaboration_read_markers r JOIN collaboration_messages m ON m.id = r.message_id WHERE r.scope_id = ? AND r.human_id = ?), 0)`)
      .get(scopeId, humanId, scopeId, humanId) as { count: number };
    return row.count;
  }

  async markReadThrough(scopeId: string, humanId: string, messageId: string): Promise<void> {
    const message = this.#db.prepare('SELECT rowid AS cursor, scope_id FROM collaboration_messages WHERE id = ?')
      .get(messageId) as { cursor: number; scope_id: string } | undefined;
    if (!message || message.scope_id !== scopeId) throw new Error('Message does not belong to this scope');
    this.#db.prepare(`INSERT INTO collaboration_read_markers (scope_id, human_id, message_id) VALUES (?, ?, ?)
      ON CONFLICT(scope_id, human_id) DO UPDATE SET message_id = excluded.message_id
      WHERE (SELECT rowid FROM collaboration_messages WHERE id = excluded.message_id) > COALESCE(
        (SELECT rowid FROM collaboration_messages WHERE id = collaboration_read_markers.message_id), 0)`)
      .run(scopeId, humanId, messageId);
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_read_markers (
        scope_id TEXT NOT NULL,
        human_id TEXT NOT NULL,
        message_id TEXT NOT NULL CHECK (length(message_id) > 0),
        PRIMARY KEY (scope_id, human_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_attention_resolutions (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        human_id TEXT NOT NULL,
        resolved_at INTEGER NOT NULL,
        source_version INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        body TEXT NOT NULL,
        recipients TEXT NOT NULL,
        delivery_key TEXT NOT NULL UNIQUE,
        in_reply_to TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collaboration_messages_scope_order
        ON collaboration_messages(scope_id, created_at, id);
      CREATE TABLE IF NOT EXISTS collaboration_wake_requests (
        id TEXT PRIMARY KEY,
        input_id TEXT NOT NULL,
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
        input_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        producer_id TEXT NOT NULL,
        producer_kind TEXT NOT NULL,
        disposition TEXT NOT NULL,
        responsible_agents TEXT NOT NULL,
        delivery_key TEXT NOT NULL UNIQUE,
        origin_scope_ids TEXT NOT NULL DEFAULT '[]',
        origin_message_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_events_project
        ON project_events(project_id);
      CREATE INDEX IF NOT EXISTS project_events_project_order
        ON project_events(project_id, created_at, id);
      CREATE TABLE IF NOT EXISTS collaboration_routing_windows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        cursor TEXT,
        input_count INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS collaboration_routing_windows_project
        ON collaboration_routing_windows(project_id, status);
      CREATE TABLE IF NOT EXISTS collaboration_window_inputs (
        window_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (window_id, input_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_routing_batches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        split_index INTEGER NOT NULL,
        split_count INTEGER NOT NULL,
        cutoff_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        bounds TEXT NOT NULL,
        manifest TEXT NOT NULL,
        context TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS collaboration_routing_batches_project
        ON collaboration_routing_batches(project_id);
      CREATE TABLE IF NOT EXISTS collaboration_routing_batch_inputs (
        batch_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        excerpt TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        excerpt_chars INTEGER NOT NULL,
        content_chars INTEGER NOT NULL,
        PRIMARY KEY (batch_id, input_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_routing_attempts (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_kind TEXT,
        error_detail TEXT,
        judgement TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS collaboration_routing_attempt_number
        ON collaboration_routing_attempts(batch_id, attempt_number);
      CREATE INDEX IF NOT EXISTS collaboration_routing_attempts_batch
        ON collaboration_routing_attempts(batch_id);
      CREATE TABLE IF NOT EXISTS collaboration_routing_outcomes (
        batch_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        status TEXT NOT NULL,
        assignments TEXT NOT NULL,
        rationale TEXT,
        detail TEXT,
        settled_at INTEGER NOT NULL,
        PRIMARY KEY (batch_id, input_id)
      );
      CREATE INDEX IF NOT EXISTS collaboration_routing_outcomes_input
        ON collaboration_routing_outcomes(input_id);
    `);
    // Batch wake identity (#97): a model-assisted wake names its frozen batch
    // beside the unchanged input/agent identity. A database created before the
    // column exists (schema 19) gains it here as well as through the schema
    // migration, so this store never reads a table without the column.
    const wakeColumns = this.#db
      .prepare('PRAGMA table_info(collaboration_wake_requests)')
      .all() as unknown as readonly { name: string }[];
    if (!wakeColumns.some((column) => column.name === 'batch_id')) {
      this.#db.exec('ALTER TABLE collaboration_wake_requests ADD COLUMN batch_id TEXT;');
    }
    const messageColumns = this.#db.prepare('PRAGMA table_info(collaboration_messages)').all() as unknown as readonly { name: string }[];
    if (!messageColumns.some(column => column.name === 'message_kind')) {
      this.#db.exec("ALTER TABLE collaboration_messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'status';");
    }
  }

  async postMessage(input: {
    readonly message: Message;
    readonly plan: WakePlan;
    readonly now: number;
    readonly collect?: RoutingWindowCollect;
  }): Promise<PostMessageResult> {
    // One transaction: the Message, every wake request it implies, and (for a
    // batch-eligible input under assisted routing) its routing-window membership
    // become durable together, so no observer can ever see a Message with no
    // wake request — or an eligible input with no window — to recover from.
    this.#db.exec('BEGIN');
    try {
      const inserted = this.#db
        .prepare(
          `INSERT OR IGNORE INTO collaboration_messages
             (id, project_id, scope_id, channel, author_id, author_kind, body, recipients, delivery_key, in_reply_to, created_at, message_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.message.id,
          input.message.projectId,
          input.message.scopeId,
          input.message.channel,
          input.message.author.id,
          input.message.author.kind,
          input.message.body,
          JSON.stringify(input.message.recipients),
          input.message.deliveryKey,
          input.message.inReplyTo ?? null,
          input.message.createdAt,
          input.message.kind ?? 'status',
        );

      if (inserted.changes === 0) {
        // The delivery key already existed: this is a retry. Return the stored
        // Message and its existing wake requests unchanged.
        this.#db.exec('COMMIT');
        const existing = (await this.getMessageByDeliveryKey(input.message.deliveryKey))!;
        return {
          message: existing,
          wakes: (await this.listWakeRequests()).filter((w) => w.inputId === existing.id),
          duplicate: true,
        };
      }

      this.#storePlanInTransaction(input.plan, input.message.projectId, input.now);
      const window =
        input.collect !== undefined
          ? this.#collectWindowInTransaction(
              input.message.projectId,
              input.message.id,
              input.now,
              input.collect.intervalMs,
            )
          : undefined;
      this.#db.exec('COMMIT');
      return {
        message: input.message,
        wakes: (await this.listWakeRequests()).filter((w) => w.inputId === input.message.id),
        duplicate: false,
        ...(window !== undefined ? { window } : {}),
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async publishEvent(input: {
    readonly event: ProjectEvent;
    readonly plan: WakePlan;
    readonly now: number;
    readonly collect?: RoutingWindowCollect;
  }): Promise<PublishEventResult> {
    this.#db.exec('BEGIN');
    try {
      const inserted = this.#db
        .prepare(
          `INSERT OR IGNORE INTO project_events
             (id, project_id, kind, summary, detail, producer_id, producer_kind, disposition, responsible_agents, delivery_key, origin_scope_ids, origin_message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.event.id,
          input.event.projectId,
          input.event.kind,
          input.event.summary,
          input.event.detail ?? null,
          input.event.producer.id,
          input.event.producer.kind,
          input.event.disposition,
          JSON.stringify(input.event.responsibleAgentIds),
          input.event.deliveryKey,
          JSON.stringify(input.event.originScopeIds ?? []),
          input.event.originMessageId ?? null,
          input.event.createdAt,
        );

      if (inserted.changes === 0) {
        this.#db.exec('COMMIT');
        const existing = (await this.getEventByDeliveryKey(input.event.deliveryKey))!;
        return {
          event: existing,
          wakes: (await this.listWakeRequests()).filter((w) => w.inputId === existing.id),
          duplicate: true,
        };
      }

      this.#storePlanInTransaction(input.plan, input.event.projectId, input.now);
      const window =
        input.collect !== undefined
          ? this.#collectWindowInTransaction(
              input.event.projectId,
              input.event.id,
              input.now,
              input.collect.intervalMs,
            )
          : undefined;
      this.#db.exec('COMMIT');
      return {
        event: input.event,
        wakes: (await this.listWakeRequests()).filter((w) => w.inputId === input.event.id),
        duplicate: false,
        ...(window !== undefined ? { window } : {}),
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Persist a wake plan's decisions and observations inside an open transaction. */
  #storePlanInTransaction(plan: WakePlan, projectId: string, now: number): void {
    for (const decision of plan.decisions) {
      this.#insertWake(
        wakeFromDecision({
          id: `wake-${plan.inputId}-${decision.agentId}`,
          inputId: plan.inputId,
          projectId,
          agentId: decision.agentId,
          reason: decision.reason,
          now,
        }),
      );
    }
    for (const observation of plan.observations) {
      this.#insertObservation(plan.inputId, observation, now);
    }
  }

  /**
   * Join (or open) the Project's fixed routing window inside an open
   * transaction (#97).
   *
   * The first eligible input inserts the open window with a deadline fixed at
   * `now + intervalMs`; later inputs append membership and move only the cursor
   * — never the deadline, so a busy channel cannot starve its own routing.
   */
  #collectWindowInTransaction(
    projectId: string,
    inputId: string,
    now: number,
    intervalMs: number,
  ): RoutingWindow {
    let row = this.#db
      .prepare("SELECT * FROM collaboration_routing_windows WHERE project_id = ? AND status = 'open'")
      .get(projectId) as WindowRow | undefined;
    if (row === undefined) {
      const id = `win-${projectId}-${now}-${Math.random().toString(36).slice(2, 8)}`;
      this.#db
        .prepare(
          `INSERT INTO collaboration_routing_windows
             (id, project_id, opened_at, deadline_at, interval_ms, status, cursor, input_count, closed_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, 1, NULL)`,
        )
        .run(id, projectId, now, now + intervalMs, intervalMs, inputId);
      this.#db
        .prepare('INSERT OR IGNORE INTO collaboration_window_inputs (window_id, input_id, joined_at) VALUES (?, ?, ?)')
        .run(id, inputId, now);
      row = this.#db.prepare('SELECT * FROM collaboration_routing_windows WHERE id = ?').get(id) as unknown as WindowRow;
      return toWindow(row);
    }
    const membership = this.#db
      .prepare('INSERT OR IGNORE INTO collaboration_window_inputs (window_id, input_id, joined_at) VALUES (?, ?, ?)')
      .run(row.id, inputId, now);
    if (membership.changes > 0) {
      this.#db
        .prepare('UPDATE collaboration_routing_windows SET cursor = ?, input_count = input_count + 1 WHERE id = ?')
        .run(inputId, row.id);
    }
    row = this.#db.prepare('SELECT * FROM collaboration_routing_windows WHERE id = ?').get(row.id) as unknown as WindowRow;
    return toWindow(row);
  }

  #insertWake(wake: WakeRequest): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO collaboration_wake_requests
           (id, input_id, project_id, agent_id, reason, status, idempotency_key, run_id, detail, created_at, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wake.id,
        wake.inputId,
        wake.projectId,
        wake.agentId,
        wake.reason,
        wake.status,
        wake.idempotencyKey,
        wake.runId ?? null,
        wake.detail ?? null,
        wake.createdAt,
        wake.batchId ?? null,
      );
  }

  #insertObservation(inputId: string, observation: WakeObservation, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO collaboration_observations
           (input_id, agent_id, status, reason, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(inputId, observation.agentId, observation.status, observation.reason, observation.detail, now);
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
      .prepare('SELECT * FROM collaboration_messages ORDER BY created_at ASC, id ASC')
      .all() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  async listMessagesPage(query: MessagePageQuery): Promise<MessagePage | undefined> {
    const cursor = query.before === undefined
      ? undefined
      : this.#db.prepare('SELECT id, scope_id AS scopeId, created_at AS createdAt FROM collaboration_messages WHERE id = ?')
          .get(query.before) as { readonly id: string; readonly scopeId: string; readonly createdAt: number } | undefined;
    if (query.before !== undefined && (!cursor || (query.scopeId !== undefined && cursor.scopeId !== query.scopeId))) return undefined;

    const conditions: string[] = [];
    const parameters: (string | number)[] = [];
    if (query.scopeId !== undefined) {
      conditions.push('scope_id = ?');
      parameters.push(query.scopeId);
    }
    if (cursor !== undefined) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#db.prepare(
      `SELECT * FROM collaboration_messages ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...parameters, query.limit + 1) as unknown as MessageRow[];
    const hasOlder = rows.length > query.limit;
    const messages = rows.slice(0, query.limit).map(toMessage).reverse();
    return { messages, hasOlder };
  }

  async resolveAttention(input: ResolveCollaborationAttention): Promise<void> {
    const resolution = await validateAttentionResolution(this, input);
    this.#db.prepare(
      `INSERT INTO collaboration_attention_resolutions
       (source_kind, source_id, project_id, human_id, resolved_at, source_version) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, source_id) DO UPDATE SET human_id = excluded.human_id,
         resolved_at = excluded.resolved_at, source_version = excluded.source_version
       WHERE excluded.source_kind = 'wake-input'
         AND excluded.source_version > collaboration_attention_resolutions.source_version`
    ).run(resolution.kind, resolution.sourceId, resolution.projectId, resolution.humanId, resolution.resolvedAt, resolution.sourceVersion);
  }

  async listAttentionResolutions(): Promise<readonly CollaborationAttentionResolution[]> {
    return this.#db.prepare(
      'SELECT project_id AS projectId, source_kind AS kind, source_id AS sourceId, human_id AS humanId, resolved_at AS resolvedAt, source_version AS sourceVersion FROM collaboration_attention_resolutions ORDER BY source_kind, source_id'
    ).all() as unknown as CollaborationAttentionResolution[];
  }

  async listWakeFailures(): Promise<readonly FailedWakeInput[]> {
    return this.#db.prepare(
      `SELECT o.input_id AS inputId, CASE WHEN m.id IS NOT NULL THEN 'message' ELSE 'event' END AS inputKind,
        COALESCE(m.project_id, e.project_id) AS projectId,
        COUNT(DISTINCT o.agent_id) AS failedTargetCount, COUNT(*) AS version, MAX(o.created_at) AS at
       FROM collaboration_observations o
       LEFT JOIN collaboration_messages m ON m.id = o.input_id
       LEFT JOIN project_events e ON e.id = o.input_id
       WHERE o.status = 'failed' AND COALESCE(m.project_id, e.project_id) IS NOT NULL
       GROUP BY o.input_id, COALESCE(m.project_id, e.project_id) ORDER BY o.input_id`
    ).all() as unknown as FailedWakeInput[];
  }

  async getEvent(eventId: string): Promise<ProjectEvent | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM project_events WHERE id = ?')
      .get(eventId) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  async getEventByDeliveryKey(deliveryKey: string): Promise<ProjectEvent | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM project_events WHERE delivery_key = ?')
      .get(deliveryKey) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  async listEvents(projectId?: string): Promise<readonly ProjectEvent[]> {
    const rows =
      projectId === undefined
        ? (this.#db
            .prepare('SELECT * FROM project_events ORDER BY created_at ASC')
            .all() as unknown as EventRow[])
        : (this.#db
            .prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY created_at ASC')
            .all(projectId) as unknown as EventRow[]);
    return rows.map(toEvent);
  }

  async listEventsPage(query: ProjectEventPageQuery): Promise<ProjectEventPage | undefined> {
    const cursor = query.before === undefined
      ? undefined
      : this.#db.prepare('SELECT id, project_id AS projectId, created_at AS createdAt FROM project_events WHERE id = ?')
          .get(query.before) as { readonly id: string; readonly projectId: string; readonly createdAt: number } | undefined;
    if (query.before !== undefined && (!cursor || cursor.projectId !== query.projectId)) return undefined;

    const parameters: (string | number)[] = [query.projectId];
    let cursorCondition = '';
    if (cursor !== undefined) {
      cursorCondition = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.#db.prepare(
      `SELECT * FROM project_events WHERE project_id = ?${cursorCondition} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...parameters, query.limit + 1) as unknown as EventRow[];
    const hasOlder = rows.length > query.limit;
    return { events: rows.slice(0, query.limit).map(toEvent).reverse(), hasOlder };
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
    readonly inputId: string;
    readonly observation: WakeObservation;
    readonly now: number;
  }): Promise<void> {
    this.#insertObservation(input.inputId, input.observation, input.now);
  }

  async listObservations(inputId: string): Promise<readonly WakeObservation[]> {
    return this.observations(inputId);
  }

  /** Observations recorded for one input, for observability and tests. */
  observations(inputId: string): readonly WakeObservation[] {
    const rows = this.#db
      .prepare('SELECT * FROM collaboration_observations WHERE input_id = ? ORDER BY id ASC')
      .all(inputId) as unknown as ObservationRow[];
    return rows.map((row) => ({
      agentId: row.agent_id,
      status: row.status as WakeObservation['status'],
      reason: row.reason as WakeObservation['reason'],
      detail: row.detail,
    }));
  }

  async listRoutingWindows(projectId?: string): Promise<readonly RoutingWindow[]> {
    const rows =
      projectId === undefined
        ? (this.#db
            .prepare('SELECT * FROM collaboration_routing_windows ORDER BY opened_at ASC')
            .all() as unknown as WindowRow[])
        : (this.#db
            .prepare('SELECT * FROM collaboration_routing_windows WHERE project_id = ? ORDER BY opened_at ASC')
            .all(projectId) as unknown as WindowRow[]);
    return rows.map(toWindow);
  }

  async freezeRoutingWindow(input: {
    readonly windowId: string;
    readonly now: number;
    readonly batches: readonly FrozenRoutingBatchPlan[];
  }): Promise<readonly RoutingBatch[]> {
    this.#db.exec('BEGIN');
    try {
      // The close is a compare-and-set: exactly one caller freezes a window.
      const closed = this.#db
        .prepare(
          "UPDATE collaboration_routing_windows SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'",
        )
        .run(input.now, input.windowId);
      if (closed.changes === 0) {
        this.#db.exec('ROLLBACK');
        return [];
      }
      const window = this.#db
        .prepare('SELECT * FROM collaboration_routing_windows WHERE id = ?')
        .get(input.windowId) as WindowRow | undefined;
      if (window === undefined) throw new Error(`unknown routing window: ${input.windowId}`);
      const frozen: RoutingBatch[] = [];
      for (const plan of input.batches) {
        this.#db
          .prepare(
            `INSERT INTO collaboration_routing_batches
               (id, project_id, window_id, split_index, split_count, cutoff_at, status, bounds, manifest, context, error, created_at, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, 'frozen', ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            plan.batchId,
            window.project_id,
            window.id,
            plan.splitIndex,
            plan.splitCount,
            plan.cutoffAt,
            JSON.stringify(plan.bounds),
            JSON.stringify(plan.manifest),
            plan.context,
            input.now,
          );
        for (const batchInput of plan.inputs) {
          this.#db
            .prepare(
              `INSERT INTO collaboration_routing_batch_inputs
                 (batch_id, input_id, position, excerpt, truncated, excerpt_chars, content_chars)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              plan.batchId,
              batchInput.inputId,
              batchInput.position,
              batchInput.excerpt,
              batchInput.truncated ? 1 : 0,
              batchInput.excerptChars,
              batchInput.contentChars,
            );
        }
        frozen.push({
          id: plan.batchId,
          projectId: window.project_id,
          windowId: window.id,
          splitIndex: plan.splitIndex,
          splitCount: plan.splitCount,
          cutoffAt: plan.cutoffAt,
          status: 'frozen',
          bounds: plan.bounds,
          manifest: plan.manifest,
          context: plan.context,
          createdAt: input.now,
        });
      }
      this.#db.exec('COMMIT');
      return frozen;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async listRoutingBatches(projectId?: string): Promise<readonly RoutingBatch[]> {
    const rows =
      projectId === undefined
        ? (this.#db
            .prepare('SELECT * FROM collaboration_routing_batches ORDER BY created_at ASC, split_index ASC')
            .all() as unknown as BatchRow[])
        : (this.#db
            .prepare(
              'SELECT * FROM collaboration_routing_batches WHERE project_id = ? ORDER BY created_at ASC, split_index ASC',
            )
            .all(projectId) as unknown as BatchRow[]);
    return rows.map(toBatch);
  }

  async listRoutingWindowInputs(windowId: string): Promise<readonly string[]> {
    const rows = this.#db
      .prepare(
        'SELECT input_id FROM collaboration_window_inputs WHERE window_id = ? ORDER BY joined_at ASC, rowid ASC',
      )
      .all(windowId) as unknown as { readonly input_id: string }[];
    return rows.map((row) => row.input_id);
  }

  async getRoutingBatch(batchId: string): Promise<RoutingBatch | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM collaboration_routing_batches WHERE id = ?')
      .get(batchId) as BatchRow | undefined;
    return row === undefined ? undefined : toBatch(row);
  }

  async listRoutingBatchInputs(batchId: string): Promise<readonly RoutingBatchInput[]> {
    const rows = this.#db
      .prepare(
        'SELECT * FROM collaboration_routing_batch_inputs WHERE batch_id = ? ORDER BY position ASC',
      )
      .all(batchId) as unknown as BatchInputRow[];
    return rows.map((row) => ({
      batchId: row.batch_id,
      inputId: row.input_id,
      position: row.position,
      excerpt: row.excerpt,
      truncated: row.truncated !== 0,
      excerptChars: row.excerpt_chars,
      contentChars: row.content_chars,
    }));
  }

  async recordRoutingAttempt(attempt: RoutingAttempt): Promise<void> {
    const updated = this.#db.prepare(
      `UPDATE collaboration_routing_attempts SET finished_at = ?, status = ?, error_kind = ?,
         error_detail = ?, judgement = ? WHERE id = ? AND batch_id = ? AND attempt_number = ? AND status = 'started'`,
    ).run(attempt.finishedAt, attempt.status, attempt.errorKind ?? null,
      attempt.errorDetail ?? null, attempt.judgement === undefined ? null : JSON.stringify(attempt.judgement),
      attempt.id, attempt.batchId, attempt.attemptNumber);
    if (updated.changes === 1) return;
    if (attempt.status !== 'started') throw new Error('routing attempt was not started');
    this.#db
      .prepare(
        `INSERT INTO collaboration_routing_attempts
           (id, batch_id, attempt_number, model_id, started_at, finished_at, status, error_kind, error_detail, judgement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.batchId,
        attempt.attemptNumber,
        attempt.modelId,
        attempt.startedAt,
        attempt.finishedAt,
        attempt.status,
        attempt.errorKind ?? null,
        attempt.errorDetail ?? null,
        null,
      );
  }

  async listRoutingAttempts(batchId: string): Promise<readonly RoutingAttempt[]> {
    const rows = this.#db
      .prepare(
        'SELECT * FROM collaboration_routing_attempts WHERE batch_id = ? ORDER BY attempt_number ASC',
      )
      .all(batchId) as unknown as AttemptRow[];
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      attemptNumber: row.attempt_number,
      modelId: row.model_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status as RoutingAttempt['status'],
      ...(row.error_kind !== null ? { errorKind: row.error_kind as RoutingFailureKind } : {}),
      ...(row.error_detail !== null ? { errorDetail: row.error_detail } : {}),
      ...(row.judgement !== null ? { judgement: JSON.parse(row.judgement) as NonNullable<RoutingAttempt['judgement']> } : {}),
    }));
  }

  async settleRoutingBatch(input: {
    readonly batchId: string;
    readonly status: Extract<RoutingBatch['status'], 'routed' | 'suppressed' | 'failed'>;
    readonly error?: string;
    readonly outcomes: readonly RoutingInputOutcome[];
    readonly wakes?: readonly WakeRequest[];
    readonly now: number;
  }): Promise<void> {
    this.#db.exec('BEGIN');
    try {
      // The settle is a compare-and-set: exactly one caller settles a batch, so
      // a second judge of the same frozen snapshot can never write a second
      // set of outcomes or a second WakeRequest (AC: at most one wake per
      // selected Agent per batch). A repeat settle is an idempotent no-op; an
      // unknown id is still a loud failure.
      const updated = this.#db
        .prepare(
          `UPDATE collaboration_routing_batches
              SET status = ?, error = ?, settled_at = ?
            WHERE id = ? AND status = 'frozen'`,
        )
        .run(input.status, input.error ?? null, input.now, input.batchId);
      if (updated.changes === 0) {
        const existing = this.#db
          .prepare('SELECT status FROM collaboration_routing_batches WHERE id = ?')
          .get(input.batchId) as { status: string } | undefined;
        if (existing === undefined) throw new Error(`unknown routing batch: ${input.batchId}`);
        this.#db.exec('ROLLBACK');
        return;
      }
      for (const outcome of input.outcomes) {
        this.#db
          .prepare(
            `INSERT INTO collaboration_routing_outcomes
               (batch_id, input_id, status, assignments, rationale, detail, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            outcome.batchId,
            outcome.inputId,
            outcome.status,
            JSON.stringify(outcome.assignments),
            outcome.rationale ?? null,
            outcome.detail ?? null,
            outcome.settledAt,
          );
      }
      // Persistence-before-wake for batches: outcomes and WakeRequests become
      // durable in the same transaction, before any run admission.
      for (const wake of input.wakes ?? []) {
        this.#insertWake(wake);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async listRoutingOutcomes(batchId: string): Promise<readonly RoutingInputOutcome[]> {
    const rows = this.#db
      .prepare(
        `SELECT o.* FROM collaboration_routing_outcomes o
           JOIN collaboration_routing_batch_inputs i
             ON i.batch_id = o.batch_id AND i.input_id = o.input_id
          WHERE o.batch_id = ?
          ORDER BY i.position ASC`,
      )
      .all(batchId) as unknown as OutcomeRow[];
    return rows.map(toOutcome);
  }

  async listRoutingOutcomesForInput(inputId: string): Promise<readonly RoutingInputOutcome[]> {
    const rows = this.#db
      .prepare(
        'SELECT * FROM collaboration_routing_outcomes WHERE input_id = ? ORDER BY settled_at ASC',
      )
      .all(inputId) as unknown as OutcomeRow[];
    return rows.map(toOutcome);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

interface MessageRow {
  readonly id: string;
  readonly project_id: string;
  readonly scope_id: string;
  readonly channel: string;
  readonly author_id: string;
  readonly author_kind: string;
  readonly body: string;
  readonly recipients: string;
  readonly delivery_key: string;
  readonly in_reply_to: string | null;
  readonly message_kind: Message['kind'];
  readonly created_at: number;
}

interface EventRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly producer_id: string;
  readonly producer_kind: string;
  readonly disposition: string;
  readonly responsible_agents: string;
  readonly delivery_key: string;
  readonly origin_scope_ids: string;
  readonly origin_message_id: string | null;
  readonly created_at: number;
}

interface WakeRow {
  readonly id: string;
  readonly input_id: string;
  readonly project_id: string;
  readonly agent_id: string;
  readonly reason: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly run_id: string | null;
  readonly detail: string | null;
  readonly created_at: number;
  readonly batch_id: string | null;
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
    scopeId: row.scope_id ?? '',
    channel: row.channel as MessageChannel,
    author,
    body: row.body,
    kind: row.message_kind ?? 'status',
    recipients: JSON.parse(row.recipients) as string[],
    deliveryKey: row.delivery_key,
    ...(row.in_reply_to !== null ? { inReplyTo: row.in_reply_to } : {}),
    createdAt: row.created_at,
  };
}

function toEvent(row: EventRow): ProjectEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    summary: row.summary,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    producer: {
      id: row.producer_id,
      kind: row.producer_kind as ProjectEvent['producer']['kind'],
    },
    disposition: row.disposition as ProjectEvent['disposition'],
    responsibleAgentIds: JSON.parse(row.responsible_agents) as string[],
    ...(row.origin_scope_ids !== '[]' ? { originScopeIds: JSON.parse(row.origin_scope_ids) as string[] } : {}),
    ...(row.origin_message_id !== null ? { originMessageId: row.origin_message_id } : {}),
    deliveryKey: row.delivery_key,
    createdAt: row.created_at,
  };
}

function toWake(row: WakeRow): WakeRequest {
  return {
    id: row.id,
    inputId: row.input_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    reason: row.reason as WakeReason,
    status: row.status as WakeStatus,
    idempotencyKey: row.idempotency_key,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.batch_id !== null ? { batchId: row.batch_id } : {}),
    createdAt: row.created_at,
  };
}

interface WindowRow {
  readonly id: string;
  readonly project_id: string;
  readonly opened_at: number;
  readonly deadline_at: number;
  readonly interval_ms: number;
  readonly status: string;
  readonly cursor: string | null;
  readonly input_count: number;
  readonly closed_at: number | null;
}

function toWindow(row: WindowRow): RoutingWindow {
  return {
    id: row.id,
    projectId: row.project_id,
    openedAt: row.opened_at,
    deadlineAt: row.deadline_at,
    intervalMs: row.interval_ms,
    status: row.status as RoutingWindow['status'],
    ...(row.cursor !== null ? { cursor: row.cursor } : {}),
    inputCount: row.input_count,
    ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
  };
}

interface BatchRow {
  readonly id: string;
  readonly project_id: string;
  readonly window_id: string;
  readonly split_index: number;
  readonly split_count: number;
  readonly cutoff_at: number;
  readonly status: string;
  readonly bounds: string;
  readonly manifest: string;
  readonly context: string;
  readonly error: string | null;
  readonly created_at: number;
  readonly settled_at: number | null;
}

function toBatch(row: BatchRow): RoutingBatch {
  return {
    id: row.id,
    projectId: row.project_id,
    windowId: row.window_id,
    splitIndex: row.split_index,
    splitCount: row.split_count,
    cutoffAt: row.cutoff_at,
    status: row.status as RoutingBatch['status'],
    bounds: JSON.parse(row.bounds) as RoutingBounds,
    manifest: JSON.parse(row.manifest) as RoutingContextManifest,
    context: row.context,
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  };
}

interface BatchInputRow {
  readonly batch_id: string;
  readonly input_id: string;
  readonly position: number;
  readonly excerpt: string;
  readonly truncated: number;
  readonly excerpt_chars: number;
  readonly content_chars: number;
}

interface AttemptRow {
  readonly id: string;
  readonly batch_id: string;
  readonly attempt_number: number;
  readonly model_id: string;
  readonly started_at: number;
  readonly finished_at: number;
  readonly status: string;
  readonly error_kind: string | null;
  readonly error_detail: string | null;
  readonly judgement: string | null;
}

interface OutcomeRow {
  readonly batch_id: string;
  readonly input_id: string;
  readonly status: string;
  readonly assignments: string;
  readonly rationale: string | null;
  readonly detail: string | null;
  readonly settled_at: number;
}

function toOutcome(row: OutcomeRow): RoutingInputOutcome {
  return {
    batchId: row.batch_id,
    inputId: row.input_id,
    status: row.status as RoutingInputStatus,
    assignments: JSON.parse(row.assignments) as readonly RoutingAssignment[],
    ...(row.rationale !== null ? { rationale: row.rationale } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    settledAt: row.settled_at,
  };
}
