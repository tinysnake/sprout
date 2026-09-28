import type { DatabaseSync } from 'node:sqlite';

import type { ProjectEnvironmentAccess } from './access.ts';
import { accessIsConsistent } from './access.ts';
import type { ProjectAuthority } from './authority-model.ts';
import type { TransactionCoordinator } from '../store/transaction.ts';

/** The durable boundary for first creation of one Project aggregate. */
export interface ProjectCreationStore {
  /** Insert identity and every initial access, or leave all records unchanged. */
  create(project: ProjectAuthority, accesses: readonly ProjectEnvironmentAccess[]): Promise<void>;
}

export class ProjectCreationConflictError extends Error {
  readonly kind: 'project-exists' | 'access-exists';

  constructor(kind: ProjectCreationConflictError['kind']) {
    super(kind === 'project-exists'
      ? 'A Project with this identity already exists.'
      : 'An Environment access record already exists for this Project.');
    this.name = 'ProjectCreationConflictError';
    this.kind = kind;
  }
}

/**
 * SQLite aggregate insert over the same handle as the individual Project and
 * access stores. Workspace preparation happens before this synchronous SQL
 * transaction; neither domain's durable record can become visible alone.
 */
export class SqliteProjectCreationStore implements ProjectCreationStore {
  readonly #db: DatabaseSync;
  readonly #transactions: TransactionCoordinator;

  constructor(options: { readonly db: DatabaseSync; readonly transactions: TransactionCoordinator }) {
    this.#db = options.db;
    this.#transactions = options.transactions;
  }

  async create(project: ProjectAuthority, accesses: readonly ProjectEnvironmentAccess[]): Promise<void> {
    const seenEnvironments = new Set<string>();
    for (const access of accesses) {
      if (access.projectId !== project.id || !accessIsConsistent(access) || seenEnvironments.has(access.environmentInstanceId)) {
        throw new Error('Project creation contains an invalid or duplicate Environment access.');
      }
      seenEnvironments.add(access.environmentInstanceId);
    }

    this.#transactions.immediate(() => {
      const existingProject = this.#db.prepare('SELECT 1 FROM project_authorities WHERE id = ?').get(project.id);
      if (existingProject !== undefined) throw new ProjectCreationConflictError('project-exists');
      const existingAccess = this.#db.prepare(
        'SELECT 1 FROM project_environment_access WHERE project_id = ? AND environment_instance_id = ?',
      );
      for (const access of accesses) {
        if (existingAccess.get(project.id, access.environmentInstanceId) !== undefined) {
          throw new ProjectCreationConflictError('access-exists');
        }
      }

      this.#db.prepare(
        'INSERT INTO project_authorities (id, document, updated_at) VALUES (?, ?, ?)',
      ).run(project.id, JSON.stringify(project), project.updatedAt);
      const insertAccess = this.#db.prepare(
        `INSERT INTO project_environment_access
           (project_id, environment_instance_id, document, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const access of accesses) {
        insertAccess.run(
          project.id,
          access.environmentInstanceId,
          JSON.stringify(access),
          access.updatedAt,
        );
      }
    });
  }
}
