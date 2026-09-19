import { DatabaseSync } from 'node:sqlite';

import type {
  Task,
  TaskRunLink,
  TaskRunSummary,
  TaskStatus,
  TaskWithRuns,
} from './model.ts';
import type { TaskFilter, TaskStore } from './store.ts';
import type { EnvironmentLease, TaskLeaseBinding } from '../environment/pool.ts';
import { createTransactionCoordinator, type TransactionCoordinator } from '../store/transaction.ts';

/**
 * SQLite-backed Task storage (ticket #28, ADR-0002).
 *
 * This is the only module that knows the Task SQL. It is mounted on Sprout's
 * primary `SqliteStore` so Task rows share the one durable database the run
 * lifecycle, leases, projects, session keys, and collaboration rows already use.
 * A Task and its run links therefore commit against the same state a restart
 * reconciles, which is what lets a Task survive process restart with its status
 * and run history intact.
 *
 * `task_run_links` carries a `UNIQUE (task_id, run_id)` constraint, so linking a
 * run twice is refused by the database rather than by a caller remembering to
 * check first. The link's `sequence` is assigned from the current maximum for the
 * Task, inside the same transaction as the insert, so concurrent advancements
 * cannot both claim the same position.
 *
 * This adapter owns only `tasks` and `task_run_links` SQL. The Task-held lease
 * rows a begin/end boundary writes belong to the environment domain, so those
 * boundaries run the environment adapter's `TaskLeaseBinding` statements inside
 * one shared transaction (`src/store/transaction.ts`) rather than issuing
 * `environment_leases` SQL here.
 */

export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;
  readonly #leases: TaskLeaseBinding | undefined;
  readonly #transactions: TransactionCoordinator;

  constructor(options: { filename: string; leases?: TaskLeaseBinding } | { db: DatabaseSync; leases?: TaskLeaseBinding; transactions?: TransactionCoordinator }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
      this.#leases = options.leases;
      this.#transactions = options.transactions ?? createTransactionCoordinator(options.db);
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      this.#leases = options.leases;
      this.#transactions = createTransactionCoordinator(this.#db);
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        constraints TEXT NOT NULL,
        status TEXT NOT NULL,
        assigned_agent_id TEXT,
        environment_preference TEXT,
        blocker_reason TEXT,
        environment_instance_id TEXT,
        environment_lease_id TEXT,
        environment_lifecycle_state TEXT,
        recovery_state TEXT,
        active_run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_run_links (
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        linked_at INTEGER NOT NULL,
        summary_status TEXT,
        summary_text TEXT,
        summary_agent_id TEXT,
        summary_recorded_at INTEGER,
        PRIMARY KEY (task_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS task_run_links_by_task
        ON task_run_links (task_id, sequence);
    `);
    this.#addColumnIfMissing('tasks', 'environment_instance_id', 'TEXT');
    this.#addColumnIfMissing('tasks', 'environment_lease_id', 'TEXT');
    this.#addColumnIfMissing('tasks', 'environment_lifecycle_state', 'TEXT');
    this.#addColumnIfMissing('tasks', 'recovery_state', 'TEXT');
    this.#addColumnIfMissing('tasks', 'active_run_id', 'TEXT');
  }

  #addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly { name: string }[];
    if (!columns.some((existing) => existing.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  async create(task: Task): Promise<Task> {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO tasks
           (id, project_id, title, goal, constraints, status, assigned_agent_id,
            environment_preference, blocker_reason, environment_instance_id, environment_lease_id, environment_lifecycle_state, recovery_state, active_run_id, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.goal,
        JSON.stringify(task.constraints),
        task.status,
        task.assignedAgentId ?? null,
        task.environmentPreference ? JSON.stringify(task.environmentPreference) : null,
        task.blockerReason ?? null,
        task.environmentInstanceId ?? null,
        task.environmentLeaseId ?? null,
        task.environmentLifecycleState ?? null,
        task.recoveryState ?? null,
        task.activeRunId ?? null,
        task.createdAt,
        task.updatedAt,
        task.completedAt ?? null,
      );
    // A repeated create is a retry; the first durable Task wins, exactly like a
    // repeated Message delivery key.
    return (await this.get(task.id)) ?? task;
  }

  async get(taskId: string): Promise<Task | undefined> {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : undefined;
  }

  async list(filter: TaskFilter = {}): Promise<readonly Task[]> {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?');
      values.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC, id ASC`)
      .all(...values) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  async save(task: Task): Promise<void> {
    this.#saveTask(task);
  }

  async saveIfUnchanged(task: Task, expected: {
    readonly environmentLifecycleState: Task['environmentLifecycleState'];
    readonly activeRunId: Task['activeRunId'];
  }): Promise<boolean> {
    const changed = this.#db.prepare(
      `UPDATE tasks
          SET title = ?, goal = ?, constraints = ?, status = ?, assigned_agent_id = ?,
              environment_preference = ?, blocker_reason = ?, environment_instance_id = ?, environment_lease_id = ?, environment_lifecycle_state = ?, recovery_state = ?, active_run_id = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
          AND environment_lifecycle_state IS ?
          AND active_run_id IS ?`,
    ).run(...this.#taskValues(task), task.id, expected.environmentLifecycleState ?? null, expected.activeRunId ?? null);
    return changed.changes === 1;
  }

  async saveBeginningWithLease(task: Task, lease: EnvironmentLease): Promise<void> {
    const leases = this.#requireLeases();
    this.#transactions.immediate(() => {
      leases.insertTaskHeldLease(lease);
      this.#saveTask(task);
    });
  }

  async saveTerminalWithLease(task: Task, leaseId: string): Promise<void> {
    const leases = this.#requireLeases();
    this.#transactions.immediate(() => {
      leases.markTaskLeaseReleased(leaseId, task.id);
      this.#saveTask(task);
    });
  }

  #requireLeases(): TaskLeaseBinding {
    if (!this.#leases) {
      throw new Error('SqliteTaskStore has no Environment lease adapter; mount it on the shared handle with the environment domain');
    }
    return this.#leases;
  }

  #taskValues(task: Task): (string | number | null)[] {
    return [
      task.title, task.goal, JSON.stringify(task.constraints), task.status,
      task.assignedAgentId ?? null, task.environmentPreference ? JSON.stringify(task.environmentPreference) : null,
      task.blockerReason ?? null, task.environmentInstanceId ?? null, task.environmentLeaseId ?? null,
      task.environmentLifecycleState ?? null, task.recoveryState ?? null, task.activeRunId ?? null,
      task.updatedAt, task.completedAt ?? null,
    ];
  }

  #saveTask(task: Task): void {
    this.#db.prepare(
      `UPDATE tasks SET title = ?, goal = ?, constraints = ?, status = ?, assigned_agent_id = ?,
       environment_preference = ?, blocker_reason = ?, environment_instance_id = ?, environment_lease_id = ?, environment_lifecycle_state = ?, recovery_state = ?, active_run_id = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    ).run(...this.#taskValues(task), task.id);
  }

  async linkRun(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly now: number;
  }): Promise<TaskRunLink> {
    this.#db.exec('BEGIN');
    try {
      const existing = this.#db
        .prepare('SELECT * FROM task_run_links WHERE task_id = ? AND run_id = ?')
        .get(input.taskId, input.runId) as TaskRunRow | undefined;
      if (existing) {
        this.#db.exec('COMMIT');
        return toLink(existing);
      }
      const next = this.#db
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_run_links WHERE task_id = ?')
        .get(input.taskId) as { readonly sequence: number };
      const sequence = next.sequence + 1;
      this.#db
        .prepare(
          `INSERT INTO task_run_links (task_id, run_id, agent_id, sequence, linked_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.taskId, input.runId, input.agentId, sequence, input.now);
      this.#db.exec('COMMIT');
      return {
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        sequence,
        linkedAt: input.now,
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async listRuns(taskId: string): Promise<readonly TaskRunLink[]> {
    const rows = this.#db
      .prepare('SELECT * FROM task_run_links WHERE task_id = ? ORDER BY sequence ASC')
      .all(taskId) as unknown as TaskRunRow[];
    return rows.map(toLink);
  }

  async getWithRuns(taskId: string): Promise<TaskWithRuns | undefined> {
    const task = await this.get(taskId);
    if (!task) return undefined;
    return { task, runs: await this.listRuns(taskId) };
  }

  async recordRunSummary(summary: TaskRunSummary & { readonly taskId: string }): Promise<void> {
    const updated = this.#db
      .prepare(
        `UPDATE task_run_links
            SET summary_status = ?, summary_text = ?, summary_agent_id = ?, summary_recorded_at = ?
          WHERE task_id = ? AND run_id = ?`,
      )
      .run(
        summary.status,
        summary.summary,
        summary.agentId,
        summary.recordedAt,
        summary.taskId,
        summary.runId,
      );
    if (updated.changes === 0) {
      throw new Error(`run ${summary.runId} is not linked to task ${summary.taskId}`);
    }
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: string;
  readonly status: string;
  readonly assigned_agent_id: string | null;
  readonly environment_preference: string | null;
  readonly blocker_reason: string | null;
  readonly environment_instance_id: string | null;
  readonly environment_lease_id: string | null;
  readonly environment_lifecycle_state: string | null;
  readonly recovery_state: string | null;
  readonly active_run_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

interface TaskRunRow {
  readonly task_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly sequence: number;
  readonly linked_at: number;
  readonly summary_status: string | null;
  readonly summary_text: string | null;
  readonly summary_agent_id: string | null;
  readonly summary_recorded_at: number | null;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    constraints: JSON.parse(row.constraints) as string[],
    status: row.status as TaskStatus,
    ...(row.assigned_agent_id !== null ? { assignedAgentId: row.assigned_agent_id } : {}),
    ...(row.environment_preference !== null
      ? {
          environmentPreference: JSON.parse(
            row.environment_preference,
          ) as NonNullable<Task['environmentPreference']>,
        }
      : {}),
    ...(row.blocker_reason !== null ? { blockerReason: row.blocker_reason } : {}),
    ...(row.environment_instance_id !== null ? { environmentInstanceId: row.environment_instance_id } : {}),
    ...(row.environment_lease_id !== null ? { environmentLeaseId: row.environment_lease_id } : {}),
    ...(row.environment_lifecycle_state !== null ? { environmentLifecycleState: row.environment_lifecycle_state as NonNullable<Task['environmentLifecycleState']> } : {}),
    ...(row.recovery_state !== null ? { recoveryState: row.recovery_state as NonNullable<Task['recoveryState']> } : {}),
    ...(row.active_run_id !== null ? { activeRunId: row.active_run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function toLink(row: TaskRunRow): TaskRunLink {
  const summary: TaskRunSummary | undefined =
    row.summary_status !== null && row.summary_recorded_at !== null
      ? {
          runId: row.run_id,
          agentId: row.summary_agent_id ?? row.agent_id,
          status: row.summary_status as TaskRunSummary['status'],
          summary: row.summary_text ?? '',
          recordedAt: row.summary_recorded_at,
        }
      : undefined;
  return {
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    sequence: row.sequence,
    linkedAt: row.linked_at,
    ...(summary !== undefined ? { summary } : {}),
  };
}
