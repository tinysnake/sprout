import type {
  AgentCompatibilitySummary,
  AgentFilter,
  AgentInstance,
  AgentManagementService,
  AgentRunAttributionRow,
  AgentWorkOptionInput,
  AgentWorkOptionRow,
  CreateAgentInput,
  ReconfigureAgentInput,
} from '../types.js';

/**
 * The deterministic test authority for the Manage Agents page (#91).
 *
 * It exists only for tests: deterministic DOM tests inject it explicitly, and
 * no production route or bootstrap ever imports this file (the same rule the
 * Environment fixture follows). The rows below cover every state the page can
 * present — ready, attention, unavailable (missing and model-unavailable),
 * archived, and the not-yet-observed case — so the state matrix is reachable
 * without a live backend.
 *
 * The fixture keeps no authority over production behaviour: it implements the
 * same port the production bridge does, and it mirrors the backend's rules
 * (minimum one option, archived is read-only, append-only versions, the
 * active-work archive guard) so tests exercise the real page logic.
 */

let clock = 1_700_000_000_000;

function nextId(prefix: string): string {
  clock += 1;
  return `${prefix}-${clock.toString(36)}`;
}

function option(
  id: string,
  engine: string,
  workModel: string,
  effort: string,
  compatibility: AgentWorkOptionRow['compatibility'] = 'available',
  compatibilityReason = `Engine "${engine}" is ready with the option's work model.`,
): AgentWorkOptionRow {
  return { id, engine, workModel, effort, compatibility, compatibilityReason };
}

function compatibilitySummary(
  available: boolean,
  firstAvailableOptionId?: string,
  unavailableReason?: string
): AgentCompatibilitySummary {
  return {
    environmentAvailable: available,
    ...(firstAvailableOptionId !== undefined ? { firstAvailableOptionId } : {}),
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
}

function compose(
  partial: Omit<AgentInstance, 'trafficLight' | 'trafficLightReason'> & {
    trafficLight?: AgentInstance['trafficLight'];
    trafficLightReason?: string;
  }
): AgentInstance {
  // The fixture reuses the page's own pure status evaluation, so the fixture
  // rows and the production rows render through exactly the same language.
  // (Import is inline to keep the module graph acyclic for the test runner.)
  return withStatus(partial);
}

// Imported lazily at module scope: a plain value import of a pure function is
// safe here because status.ts imports types only.
import { evaluateAgentStatus } from '../status.ts';

function withStatus(
  partial: Omit<AgentInstance, 'trafficLight' | 'trafficLightReason'> & {
    trafficLight?: AgentInstance['trafficLight'];
    trafficLightReason?: string;
  }
): AgentInstance {
  const evaluated = evaluateAgentStatus({
    status: partial.status,
    workOptions: partial.workOptions,
    ...(partial.compatibility !== undefined ? { compatibility: partial.compatibility } : {}),
  });
  return {
    ...partial,
    trafficLight: partial.trafficLight ?? evaluated.trafficLight,
    trafficLightReason: partial.trafficLightReason ?? evaluated.reason,
  };
}

export function createInitialAgentFixtures(): AgentInstance[] {
  const readyOptions = [
    option('opt-pi-glm', 'pi', 'glm-5', 'high'),
    option('opt-codex-gpt', 'codex', 'gpt-5.2-codex', 'medium'),
  ];
  const degradedOptions = [
    option(
      'opt-codex-login',
      'codex',
      'gpt-5.2-codex',
      'high',
      'login-required',
      'Engine "codex" requires a login on this Environment.'
    ),
    option('opt-pi-fallback', 'pi', 'glm-5', 'medium'),
  ];
  const unavailableOptions = [
    option(
      'opt-agy-missing',
      'agy',
      'antigravity-deep-code',
      'high',
      'missing',
      'Engine "agy" is not installed on this Environment.'
    ),
  ];
  const modelMissingOptions = [
    option(
      'opt-pi-gone-model',
      'pi',
      'very-old-model',
      'medium',
      'model-unavailable',
      'Work model "very-old-model" is not available for "pi" on this Environment.'
    ),
  ];
  const archivedOptions = [
    option('opt-archived', 'codex', 'gpt-5.2-codex', 'low', 'unknown', 'Archived; facts retained verbatim.'),
  ];

  return [
    compose({
      id: 'programmer',
      displayName: 'Programmer',
      status: 'active',
      instructions: 'Always verify tests before claiming completion. Preserve strict privacy boundaries.',
      currentVersion: 3,
      versions: [
        {
          version: 1,
          at: clock - 400_000,
          reason: 'Agent created with its initial ordered work options.',
          options: [option('opt-codex-gpt', 'codex', 'gpt-5.2-codex', 'medium')],
        },
        {
          version: 2,
          at: clock - 200_000,
          reason: 'Added a pi fallback option.',
          options: readyOptions,
        },
        {
          version: 3,
          at: clock - 100_000,
          reason: 'Switched the primary option to pi.',
          options: readyOptions,
        },
      ],
      workOptions: readyOptions,
      compatibility: compatibilitySummary(true, 'opt-pi-glm'),
      createdAt: clock - 400_000,
      updatedAt: clock - 100_000,
    }),
    compose({
      id: 'architect',
      displayName: 'Architect',
      status: 'active',
      instructions: 'Ensure all changes reference the domain glossary and protect module seams.',
      currentVersion: 2,
      versions: [
        {
          version: 1,
          at: clock - 300_000,
          reason: 'Agent created with its initial ordered work options.',
          options: [option('opt-codex-login', 'codex', 'gpt-5.2-codex', 'high')],
        },
        {
          version: 2,
          at: clock - 90_000,
          reason: 'Added a pi fallback option.',
          options: degradedOptions,
        },
      ],
      workOptions: degradedOptions,
      // Primary is login-required but a fallback is available: attention.
      compatibility: compatibilitySummary(true, 'opt-pi-fallback'),
      createdAt: clock - 300_000,
      updatedAt: clock - 90_000,
    }),
    compose({
      id: 'sentinel',
      displayName: 'Sentinel',
      status: 'active',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          at: clock - 50_000,
          reason: 'Agent created with its initial ordered work options.',
          options: unavailableOptions,
        },
      ],
      workOptions: unavailableOptions,
      compatibility: compatibilitySummary(
        false,
        undefined,
        'Engine "agy" is not installed on this Environment.'
      ),
      createdAt: clock - 50_000,
      updatedAt: clock - 50_000,
    }),
    compose({
      id: 'legacy-model',
      displayName: 'Legacy Model Runner',
      status: 'active',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          at: clock - 40_000,
          reason: 'Agent created with its initial ordered work options.',
          options: modelMissingOptions,
        },
      ],
      workOptions: modelMissingOptions,
      compatibility: compatibilitySummary(
        false,
        undefined,
        'Work model "very-old-model" is not available for "pi" on this Environment.'
      ),
      createdAt: clock - 40_000,
      updatedAt: clock - 40_000,
    }),
    compose({
      id: 'unobserved',
      displayName: 'Unobserved Runner',
      status: 'active',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          at: clock - 30_000,
          reason: 'Agent created with its initial ordered work options.',
          options: [option('opt-pi-unobserved', 'pi', 'glm-5', 'medium', 'unknown', 'Engine "pi" has not been observed on this Environment.')],
        },
      ],
      workOptions: [option('opt-pi-unobserved', 'pi', 'glm-5', 'medium', 'unknown', 'Engine "pi" has not been observed on this Environment.')],
      // No compatibility facts reachable: the attention/not-observed state.
      createdAt: clock - 30_000,
      updatedAt: clock - 30_000,
    }),
    compose({
      id: 'legacy-coder',
      displayName: 'Legacy Code Migrator',
      status: 'archived',
      instructions: 'Archived persona; does not accept new task work.',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          at: clock - 500_000,
          reason: 'Agent created with its initial ordered work options.',
          options: archivedOptions,
        },
      ],
      workOptions: archivedOptions,
      compatibility: compatibilitySummary(false, undefined, 'Archived Agents are barred from new work.'),
      createdAt: clock - 500_000,
      updatedAt: clock - 200_000,
    }),
  ];
}

export function createInitialAttributionFixtures(): AgentRunAttributionRow[] {
  return [
    {
      runId: 'run-206',
      agentId: 'programmer',
      status: 'completed',
      createdAt: clock - 90_000,
      engine: 'pi',
      workModel: 'glm-5',
      effort: 'high',
      configurationVersion: 3,
    },
    {
      runId: 'run-205',
      agentId: 'programmer',
      status: 'completed',
      createdAt: clock - 200_000,
      engine: 'codex',
      workModel: 'gpt-5.2-codex',
      effort: 'medium',
      configurationVersion: 2,
    },
    {
      runId: 'run-204',
      agentId: 'architect',
      status: 'failed',
      createdAt: clock - 210_000,
      engine: 'codex',
      workModel: 'gpt-5.2-codex',
      effort: 'high',
      configurationVersion: 1,
    },
    {
      runId: 'run-203',
      agentId: 'legacy-coder',
      status: 'completed',
      createdAt: clock - 480_000,
      engine: 'codex',
      workModel: 'gpt-5.2-codex',
      effort: 'low',
      configurationVersion: 1,
    },
  ];
}

export class FixtureAgentService implements AgentManagementService {
  readonly #agents: AgentInstance[];
  readonly #attributions: AgentRunAttributionRow[];

  constructor(
    initialData?: AgentInstance[],
    attributions?: AgentRunAttributionRow[]
  ) {
    this.#agents = initialData ?? createInitialAgentFixtures();
    this.#attributions = attributions ?? createInitialAttributionFixtures();
  }

  async listAgents(): Promise<readonly AgentInstance[]> {
    return JSON.parse(JSON.stringify(this.#agents)) as AgentInstance[];
  }

  async getAgent(id: string): Promise<AgentInstance | undefined> {
    const found = this.#agents.find((agent) => agent.id === id);
    return found ? (JSON.parse(JSON.stringify(found)) as AgentInstance) : undefined;
  }

  async createAgent(input: CreateAgentInput): Promise<void> {
    if (input.displayName.trim() === '') {
      throw new Error('an Agent requires a non-empty display name');
    }
    if (input.workOptions.length === 0) {
      throw new Error('an Agent requires at least one ordered work option');
    }
    const now = clock;
    const options = input.workOptions.map((workOption) => ({
      id: nextId('opt'),
      engine: workOption.engine,
      workModel: workOption.workModel,
      effort: workOption.effort,
      compatibility: 'unknown' as const,
      compatibilityReason: 'This option has not been evaluated against the current Environment facts yet.',
    }));
    this.#agents.push(
      withStatus({
        id: nextId('agent'),
        displayName: input.displayName.trim(),
        status: 'active',
        ...(input.instructions !== undefined && input.instructions.trim() !== ''
          ? { instructions: input.instructions.trim() }
          : {}),
        currentVersion: 1,
        versions: [
          {
            version: 1,
            at: now,
            reason: 'Agent created with its initial ordered work options.',
            options,
          },
        ],
        workOptions: options,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async reconfigureAgent(id: string, input: ReconfigureAgentInput): Promise<void> {
    const index = this.#agents.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error(`unknown agent: ${id}`);
    const agent = this.#agents[index]!;
    if (agent.status === 'archived') {
      throw new Error(`agent ${id} is archived and read-only; restore it first`);
    }
    if (input.workOptions.length === 0) {
      throw new Error('an Agent requires at least one ordered work option');
    }
    const options: AgentWorkOptionRow[] = input.workOptions.map((workOption) => {
      const preserved = agent.workOptions.find((existing) => existing.id === workOption.id);
      return {
        id: workOption.id ?? preserved?.id ?? nextId('opt'),
        engine: workOption.engine,
        workModel: workOption.workModel,
        effort: workOption.effort,
        compatibility: preserved?.compatibility ?? 'unknown',
        compatibilityReason:
          preserved?.compatibilityReason ??
          'This option has not been evaluated against the current Environment facts yet.',
      };
    });
    const version = agent.currentVersion + 1;
    const displayName = input.displayName?.trim() || agent.displayName;
    let instructions = agent.instructions;
    if (input.instructions !== undefined) {
      instructions =
        input.instructions === null || input.instructions.trim() === ''
          ? undefined
          : input.instructions.trim();
    }
    const next: AgentInstance = {
      ...agent,
      displayName,
      currentVersion: version,
      workOptions: options,
      ...(instructions !== undefined ? { instructions } : {}),
      versions: [
        ...agent.versions,
        {
          version,
          at: clock,
          reason: input.reason?.trim() || 'The Agent configuration was recorded.',
          options,
          ...(instructions !== undefined ? { instructions } : {}),
        },
      ],
      updatedAt: clock,
    };
    this.#agents[index] = reevaluate(next);
  }
  async archiveAgent(id: string): Promise<void> {
    const index = this.#agents.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error(`unknown agent: ${id}`);
    const agent = this.#agents[index]!;
    if (agent.status === 'archived') {
      throw new Error(`agent ${id} is already archived`);
    }
    // The active-work safety guard (ADR-0008). The fixture's archive guard
    // rides on an injected set so tests can drive both outcomes.
    if (this.#activeWorkAgents.has(id)) {
      throw new Error(
        `agent ${id} has an active run; settle or stop it before archiving`,
      );
    }
    this.#agents[index] = reevaluate({
      ...agent,
      status: 'archived',
      updatedAt: clock,
    });
  }

  async restoreAgent(id: string): Promise<void> {
    const index = this.#agents.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error(`unknown agent: ${id}`);
    const agent = this.#agents[index]!;
    if (agent.status !== 'archived') {
      throw new Error(`agent ${id} is not archived`);
    }
    this.#agents[index] = reevaluate({
      ...agent,
      status: 'active',
      updatedAt: clock,
    });
  }

  async listRunAttributions(): Promise<readonly AgentRunAttributionRow[]> {
    return JSON.parse(JSON.stringify(this.#attributions)) as AgentRunAttributionRow[];
  }

  readonly #activeWorkAgents = new Set<string>(['architect']);

  /** Drive the archive guard in tests: `markActiveWork('programmer', true)`. */
  markActiveWork(agentId: string, active: boolean): void {
    if (active) this.#activeWorkAgents.add(agentId);
    else this.#activeWorkAgents.delete(agentId);
  }
}

/** Re-run the page's own status evaluation after a mutation. */
function reevaluate(agent: AgentInstance): AgentInstance {
  const evaluated = evaluateAgentStatus({
    status: agent.status,
    workOptions: agent.workOptions,
    ...(agent.compatibility !== undefined ? { compatibility: agent.compatibility } : {}),
  });
  return {
    ...agent,
    trafficLight: evaluated.trafficLight,
    trafficLightReason: evaluated.reason,
  };
}

/** Re-export the input shapes so tests can build payloads without casts. */
export type { AgentWorkOptionInput, AgentFilter };
