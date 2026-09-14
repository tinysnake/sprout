import { randomUUID } from 'node:crypto';

/**
 * Identifiers for runs and leases.
 *
 * Run ids must be unique across restarts, not just within one process: runs are
 * persisted (ADR-0002), so a per-process counter would let a fresh process
 * reintroduce an id that already exists on disk and overwrite its evidence.
 * A time-ordered, process-unique id avoids that without coordination.
 */

export interface IdFactory {
  run(): string;
  lease(): string;
  /** Ids for durable collaboration Messages (prototype #25). */
  message(): string;
}

export function createIdFactory(): IdFactory {
  return {
    run: () => `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    lease: () => `lease-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    message: () => `msg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  };
}
