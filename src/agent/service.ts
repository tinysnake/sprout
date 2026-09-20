import {
  AgentIdentityError,
  createAgentConfiguration,
  currentConfiguration,
  sanitizeAgentId,
  sanitizeDisplayName,
  sanitizeInstructions,
  sanitizeWorkOption,
  type Agent,
  type AgentConfiguration,
  type AgentStatus,
} from './model.ts';
import type { AgentStore } from './store.ts';
import { sanitizeOperatorText } from '../environment/privacy.ts';

/**
 * The caller-facing Agent identity capability (#90, ADR-0008).
 *
 * This Module owns the one lifecycle rule set for portable Agents: create,
 * reconfigure, archive, and restore. It deliberately owns no run, no lease, and
 * no Task:
 *
 * - the active-work facts an archive checks arrive through a narrow read-only
 *   port, so the run and Task domains remain the one owners of work state; and
 * - every configuration edit appends a new durable version, so a past run's
 *   configuration version always resolves to the options it was admitted under.
 *
 * Archive/restore is non-destructive (ADR-0008): an archived Agent is read-only
 * and bars new work, retains its identity, instructions, configuration history,
 * and every past run's attribution, and can be restored at any time. There is no
 * hard delete.
 */

/**
 * The narrow read-only surface this Module needs to prove no active work
 * depends on an Agent.
 */
export interface AgentWorkSafetyPort {
  /** Whether the Agent currently has a run that is queued or running. */
  hasActiveRun(agentId: string): Promise<boolean> | boolean;
  /**
   * Whether the Agent is the assigned lead of a Task that has not reached a
   * terminal status, or holds a Task's lease through the run seam.
   */
  hasOpenTaskAssignment(agentId: string): Promise<boolean> | boolean;
}

export interface AgentServiceOptions {
  readonly store: AgentStore;
  readonly workSafety?: AgentWorkSafetyPort;
  readonly clock?: () => number;
  /** Stable id generator, injectable so tests control identity. */
  readonly createId?: () => string;
}

export interface CreateAgentInput {
  /** The stable identity slug. Omitted ids are generated. */
  readonly id?: string;
  readonly displayName: string;
  readonly instructions?: string;
  readonly workOptions: readonly {
    readonly id?: string;
    readonly engine: string;
    readonly workModel: string;
    readonly effort: string;
  }[];
}

export interface ReconfigureAgentInput {
  readonly displayName?: string;
  readonly instructions?: string | undefined;
  readonly workOptions: readonly {
    readonly id?: string;
    readonly engine: string;
    readonly workModel: string;
    readonly effort: string;
  }[];
  /** The sanitized operator reason recorded on the new version. */
  readonly reason?: string;
}

export class AgentService {
  readonly #store: AgentStore;
  readonly #workSafety: AgentWorkSafetyPort | undefined;
  readonly #clock: () => number;
  readonly #createId: () => string;

  constructor(options: AgentServiceOptions) {
    this.#store = options.store;
    this.#workSafety = options.workSafety;
    this.#clock = options.clock ?? Date.now;
    this.#createId = options.createId ?? (() => `agent-${Math.random().toString(36).slice(2, 10)}`);
  }

  /** Create one portable Agent with its initial configuration version. */
  async create(input: CreateAgentInput): Promise<Agent> {
    const now = this.#clock();
    const id = input.id !== undefined ? sanitizeAgentId(input.id) : this.#createId();
    if (id === undefined) {
      throw new AgentIdentityError('invalid-identity', 'an Agent requires a valid stable identity');
    }
    if (await this.#store.get(id) !== undefined) {
      throw new AgentIdentityError('invalid-identity', `an Agent with identity ${id} already exists`);
    }
    const created = createAgentConfiguration({
      displayName: input.displayName,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      workOptions: input.workOptions,
      at: now,
    });
    const agent: Agent = {
      id,
      displayName: created.displayName,
      status: 'active',
      configuration: created.configuration,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(agent);
    return agent;
  }

  /** Every durable Agent, including archived ones (archived is a status). */
  async list(): Promise<readonly Agent[]> {
    return this.#store.list();
  }

  async get(agentId: string): Promise<Agent | undefined> {
    return this.#store.get(agentId);
  }

  /**
   * Append one configuration version.
   *
   * The edit affects only later runs: earlier run facts and engine sessions are
   * preserved, and the previous versions are never rewritten. An archived Agent
   * is read-only.
   */
  async reconfigure(agentId: string, input: ReconfigureAgentInput): Promise<Agent> {
    const agent = await this.#require(agentId);
    if (agent.status === 'archived') {
      throw new AgentIdentityError(
        'archived-agent-is-read-only',
        `agent ${agentId} is archived and read-only; restore it first`,
      );
    }
    if (input.workOptions.length === 0) {
      throw new AgentIdentityError('no-work-option', 'an Agent requires at least one ordered work option');
    }
    const now = this.#clock();
    const current = currentConfiguration(agent);
    const displayName = input.displayName !== undefined
      ? sanitizeDisplayName(input.displayName)
      : agent.displayName;
    const instructions =
      input.instructions === undefined ? current.instructions : sanitizeInstructions(input.instructions);
    const options = input.workOptions.map((option) => sanitizeWorkOption(option));
    const version: AgentConfiguration = {
      currentVersion: agent.configuration.currentVersion + 1,
      versions: [
        ...agent.configuration.versions,
        {
          version: agent.configuration.currentVersion + 1,
          at: now,
          reason: sanitizeOperatorReason(input.reason),
          options,
          ...(instructions !== undefined ? { instructions } : {}),
        },
      ],
    };
    const next: Agent = {
      ...agent,
      displayName,
      configuration: version,
      updatedAt: now,
    };
    await this.#store.save(next);
    return next;
  }

  /**
   * Archive one Agent (ADR-0008, non-destructive).
   *
   * Refused while the Agent has an active run or an open Task assignment: the
   * ADR-0008 safety guard. Identity, instructions, configuration history, and
   * past run attribution are all retained; new memberships, messages, and runs
   * are barred by the caller checking `status`.
   */
  async archive(agentId: string): Promise<Agent> {
    const agent = await this.#require(agentId);
    if (agent.status === 'archived') {
      throw new AgentIdentityError('already-archived', `agent ${agentId} is already archived`);
    }
    if (this.#workSafety !== undefined) {
      if (await this.#workSafety.hasActiveRun(agentId)) {
        throw new AgentIdentityError(
          'active-work-depends-on-agent',
          `agent ${agentId} has an active run; settle or stop it before archiving`,
        );
      }
      if (await this.#workSafety.hasOpenTaskAssignment(agentId)) {
        throw new AgentIdentityError(
          'active-work-depends-on-agent',
          `agent ${agentId} leads an unfinished Task; end or reassign it before archiving`,
        );
      }
    }
    return this.#setStatus(agent, 'archived');
  }

  /**
   * Restore one archived Agent.
   *
   * Restore is always safe: nothing was deleted, so restoring only re-enables
   * new work. Compatibility is re-derived from current Environment facts by the
   * callers of this Module's read paths, never stored here.
   */
  async restore(agentId: string): Promise<Agent> {
    const agent = await this.#require(agentId);
    if (agent.status !== 'archived') {
      throw new AgentIdentityError('not-archived', `agent ${agentId} is not archived`);
    }
    return this.#setStatus(agent, 'active');
  }

  async #require(agentId: string): Promise<Agent> {
    const agent = await this.#store.get(agentId);
    if (agent === undefined) {
      throw new AgentIdentityError('unknown-agent', `unknown agent: ${agentId}`);
    }
    return agent;
  }

  async #setStatus(agent: Agent, status: AgentStatus): Promise<Agent> {
    const next: Agent = { ...agent, status, updatedAt: this.#clock() };
    await this.#store.save(next);
    return next;
  }
}

/** The fallback for a reconfiguration reason that sanitized to nothing. */
const DEFAULT_RECONFIGURE_REASON = 'The Agent configuration was edited; its prior versions are preserved.';

function sanitizeOperatorReason(value: string | undefined): string {
  return sanitizeOperatorText(value, { fallback: DEFAULT_RECONFIGURE_REASON, maxLength: 320 });
}

export { AgentIdentityError } from './model.ts';
