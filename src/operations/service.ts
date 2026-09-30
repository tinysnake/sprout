import { createHash } from 'node:crypto';
import { EVENT_STATES, type EventKind, type EventState, type OperationalEvent } from './contract.ts';
export interface OperationalStore {
  transition(subject: string, kind: EventKind, state: EventState, at: number): Promise<void>;
  events(): Promise<readonly OperationalEvent[]>;
}
export function diagnosticSubject(source: string): string { return createHash('sha256').update(source).digest('hex'); }
export class DiagnosticsService {
  private readonly store: OperationalStore;
  constructor(store: OperationalStore) { this.store = store; }
  async transition(source: string, kind: EventKind, state: EventState, at: number): Promise<void> {
    if (!Object.hasOwn(EVENT_STATES, kind) || !(EVENT_STATES[kind] as readonly string[]).includes(state) || !Number.isSafeInteger(at) || at < 0) throw new Error('invalid operational fact');
    await this.store.transition(diagnosticSubject(source), kind, state, at);
  }
  events(): Promise<readonly OperationalEvent[]> { return this.store.events(); }
}
export class MemoryOperationalStore implements OperationalStore {
  private readonly rows: OperationalEvent[] = [];
  private readonly current = new Map<string, EventState>();
  async transition(subject: string, kind: EventKind, state: EventState, at: number): Promise<void> {
    const key = `${subject}:${kind}`;
    if (this.current.get(key) === state) return;
    this.current.set(key, state);
    this.rows.push({ sequence: this.rows.length + 1, subject, kind, state, at });
  }
  async events(): Promise<readonly OperationalEvent[]> { return this.rows.map(e => ({ ...e })); }
}
