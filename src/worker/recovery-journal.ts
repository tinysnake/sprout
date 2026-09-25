/** Host-local, at-least-once recovery outbox. Never stores prompts or credentials. */
import { lstatSync, readFileSync } from 'node:fs';
import type { AgentRunEvent, EngineTurnResult } from '../engine/port.ts';
import { PRIVATE_FILE_MODE, writePrivateFile } from './host-files.ts';

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

/** A corrupt, overlarge or inaccessible journal is an error, never an empty outbox. */
export class WorkerRecoveryJournal {
  readonly #path: string;
  readonly #inheritedUnfenced: boolean;
  #state: JournalSnapshot;

  constructor(path: string, epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('invalid recovery journal epoch');
    this.#path = path;
    let previous: JournalSnapshot | undefined;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE || stat.size > MAX_BYTES) {
        throw new Error('invalid recovery journal');
      }
      previous = JSON.parse(readFileSync(path, 'utf8')) as JournalSnapshot;
      if (!Array.isArray(previous.turns) || typeof previous.epoch !== 'number' ||
          typeof previous.engineStopped !== 'boolean' || !previous.taskContexts) throw new Error('invalid recovery journal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('recovery journal cannot be opened');
    }
    // A process death cannot prove its child was fenced. Do not clear this bit
    // merely because a new Worker established an authenticated connection.
    this.#inheritedUnfenced = previous?.engineStopped === false;
    this.#state = { epoch, turns: previous?.turns ?? [], engineStopped: previous?.engineStopped ?? true,
      taskContexts: previous?.taskContexts ?? {} };
    this.#save(this.#state);
  }

  snapshot(): JournalSnapshot { return structuredClone(this.#state); }

  #save(state: JournalSnapshot): void {
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > MAX_BYTES || state.turns.length > MAX_TURNS) {
      throw new Error('recovery journal capacity exceeded; refusing unrecorded work');
    }
    // A superseded Worker may still be unwinding an engine or context action
    // after its channel closes. Never allow it to replace a newer epoch's
    // journal or launder its stale facts into a subsequent reconnect.
    try {
      const disk = JSON.parse(readFileSync(this.#path, 'utf8')) as JournalSnapshot;
      if (!Number.isSafeInteger(disk.epoch) || disk.epoch > state.epoch) {
        throw new Error('stale recovery journal epoch');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writePrivateFile(this.#path, bytes);
    this.#state = state;
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
