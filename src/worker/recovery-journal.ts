/** Host-local, at-least-once recovery outbox. Never stores prompts or credentials. */
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentRunEvent, EngineTurnResult } from '../engine/port.ts';
import { defaultPrivateFileSecurityDependencies, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, privateFileRestriction, writePrivateFile, type PrivateFileSecurityDependencies } from './host-files.ts';

export interface JournalTurn {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly events: readonly { readonly sequence: number; readonly event: AgentRunEvent }[];
  readonly settlement?: EngineTurnResult;
  readonly acknowledged: number;
  readonly settlementAcknowledged: boolean;
}
export interface JournalSnapshot {
  readonly epoch: number;
  readonly turns: readonly JournalTurn[];
  readonly engineStopped: boolean;
  readonly taskContexts: Readonly<Record<string, 'prepared' | 'recycled'>>;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TURNS = 128;

/**
 * A crash-released, cross-process exclusive lock around reading AND replacing
 * the JSON journal. An atomic rename alone cannot protect a read-then-write
 * epoch check. SQLite's BEGIN IMMEDIATE serializes competing Worker processes;
 * its empty lock database holds no journal payload or identity data.
 */
function withJournalLock<T>(path: string, work: () => T): T {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const lockPath = `${path}.lock.sqlite`;
  const lock = new DatabaseSync(lockPath);
  try {
    chmodSync(lockPath, PRIVATE_FILE_MODE);
    lock.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    lock.exec('CREATE TABLE IF NOT EXISTS journal_lock (id INTEGER PRIMARY KEY)');
    lock.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      lock.exec('COMMIT');
      return result;
    } catch (error) {
      try { lock.exec('ROLLBACK'); } catch { /* retain the original failure */ }
      throw error;
    }
  } finally {
    lock.close();
  }
}

function readJournal(path: string, security: PrivateFileSecurityDependencies): JournalSnapshot | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || privateFileRestriction(path, true, security) !== 'restricted' || stat.size > MAX_BYTES) {
      throw new Error('invalid recovery journal');
    }
    const previous = JSON.parse(readFileSync(path, 'utf8')) as JournalSnapshot;
    if (!Array.isArray(previous.turns) || !Number.isSafeInteger(previous.epoch) ||
        typeof previous.engineStopped !== 'boolean' || !previous.taskContexts) {
      throw new Error('invalid recovery journal');
    }
    return previous;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('recovery journal cannot be opened');
  }
}

/** A corrupt, overlarge or inaccessible journal is an error, never an empty outbox. */
export class WorkerRecoveryJournal {
  readonly #path: string;
  readonly #security: PrivateFileSecurityDependencies;
  readonly #inheritedUnfenced: boolean;
  #state: JournalSnapshot;

  constructor(path: string, epoch: number, security: PrivateFileSecurityDependencies = defaultPrivateFileSecurityDependencies) {
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('invalid recovery journal epoch');
    this.#path = path;
    this.#security = security;
    const previous = withJournalLock(path, () => {
      const prior = readJournal(path, security);
      const state: JournalSnapshot = { epoch, turns: prior?.turns ?? [],
        engineStopped: prior?.engineStopped ?? true, taskContexts: prior?.taskContexts ?? {} };
      this.#writeLocked(state, security);
      return prior;
    });
    // A process death cannot prove its child was fenced. Do not clear this bit
    // merely because a new Worker established an authenticated connection.
    this.#inheritedUnfenced = previous?.engineStopped === false;
    this.#state = { epoch, turns: previous?.turns ?? [], engineStopped: previous?.engineStopped ?? true,
      taskContexts: previous?.taskContexts ?? {} };
  }

  snapshot(): JournalSnapshot { return structuredClone(this.#state); }

  #save(state: JournalSnapshot): void {
    withJournalLock(this.#path, () => this.#writeLocked(state, this.#security));
    this.#state = state;
  }

  /** Called only while holding the same exclusive lock as journal construction. */
  #writeLocked(state: JournalSnapshot, security: PrivateFileSecurityDependencies): void {
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > MAX_BYTES || state.turns.length > MAX_TURNS) {
      throw new Error('recovery journal capacity exceeded; refusing unrecorded work');
    }
    // A superseded Worker may still be unwinding an engine or context action
    // after its channel closes. Never allow it to replace a newer epoch's
    // journal or launder its stale facts into a subsequent reconnect.
    const disk = readJournal(this.#path, security);
    if (disk !== undefined && disk.epoch > state.epoch) throw new Error('stale recovery journal epoch');
    writePrivateFile(this.#path, bytes, security);
  }

  engineStarted(): void { this.#save({ ...this.#state, engineStopped: false }); }
  engineStopped(): void {
    // Closing a NEW session cannot prove that an orphan from the killed
    // predecessor stopped. Only an explicit future host-local fence may clear
    // that inherited uncertainty; normal reconnect never invents one.
    if (!this.#inheritedUnfenced) this.#save({ ...this.#state, engineStopped: true });
  }
  context(taskId: string, state: 'prepared' | 'recycled'): void {
    this.#save({ ...this.#state, taskContexts: { ...this.#state.taskContexts, [taskId]: state } });
  }
  acknowledgeContext(epoch: number, taskId: string, state: 'prepared' | 'recycled'): void {
    if (epoch !== this.#state.epoch) throw new Error('stale recovery epoch');
    if (this.#state.taskContexts[taskId] !== state) throw new Error('invalid context acknowledgement');
    const taskContexts = { ...this.#state.taskContexts };
    delete taskContexts[taskId];
    this.#save({ ...this.#state, taskContexts });
  }
  begin(sessionId: string, turnId: string, runId?: string): void {
    this.#save({ ...this.#state, turns: [...this.#state.turns,
      { sessionId, turnId, ...(runId !== undefined ? { runId } : {}), events: [], acknowledged: 0, settlementAcknowledged: false }] });
  }
  event(turnId: string, event: AgentRunEvent): void {
    this.#update(turnId, (turn) => ({ ...turn, events: [...turn.events,
      { sequence: (turn.events.at(-1)?.sequence ?? turn.acknowledged) + 1, event }] }));
  }
  settled(turnId: string, settlement: EngineTurnResult): void {
    this.#update(turnId, (turn) => ({ ...turn, settlement }));
  }
  /** Ack only a contiguous prefix; no absent event or missing settlement is inferred. */
  acknowledge(epoch: number, turnId: string, sequence: number, settlement: boolean): void {
    if (epoch !== this.#state.epoch) throw new Error('stale recovery epoch');
    this.#update(turnId, (turn) => {
      const last = turn.events.at(-1)?.sequence ?? turn.acknowledged;
      if (!Number.isSafeInteger(sequence) || sequence < turn.acknowledged || sequence > last ||
          (settlement && (turn.settlement === undefined || sequence !== last))) throw new Error('invalid journal acknowledgement');
      return { ...turn, acknowledged: sequence, settlementAcknowledged: settlement || turn.settlementAcknowledged,
        events: turn.events.filter((entry) => entry.sequence > sequence) };
    });
    // The settlement and its last event must BOTH be durably acknowledged.
    this.#save({ ...this.#state, turns: this.#state.turns.filter((turn) =>
      !(turn.turnId === turnId && turn.settlementAcknowledged && turn.events.length === 0)) });
  }
  #update(turnId: string, change: (turn: JournalTurn) => JournalTurn): void {
    if (!this.#state.turns.some((turn) => turn.turnId === turnId)) throw new Error('unknown journal turn');
    this.#save({ ...this.#state, turns: this.#state.turns.map((turn) => turn.turnId === turnId ? change(turn) : turn) });
  }
}
