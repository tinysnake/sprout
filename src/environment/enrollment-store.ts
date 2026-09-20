import type { EnvironmentEnrollment } from './enrollment.ts';

/**
 * Durable storage for Environment enrollment decisions (#87).
 *
 * A seam, not a SQLite detail (ADR-0002): the enrollment service reads and writes
 * through this interface, so the same rules run over the in-memory adapter in
 * tests and the SQLite adapter in production. The record is stored as one JSON
 * document keyed by id, the same way Projects are, because its decisions and
 * capability permissions belong to the enrollment as a whole.
 */
export interface EnrollmentStore {
  save(enrollment: EnvironmentEnrollment): Promise<void>;
  get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined>;
  list(): Promise<readonly EnvironmentEnrollment[]>;
}

export class InMemoryEnrollmentStore implements EnrollmentStore {
  readonly #enrollments = new Map<string, EnvironmentEnrollment>();

  async save(enrollment: EnvironmentEnrollment): Promise<void> {
    this.#enrollments.set(enrollment.id, enrollment);
  }

  async get(enrollmentId: string): Promise<EnvironmentEnrollment | undefined> {
    return this.#enrollments.get(enrollmentId);
  }

  async list(): Promise<readonly EnvironmentEnrollment[]> {
    return [...this.#enrollments.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
