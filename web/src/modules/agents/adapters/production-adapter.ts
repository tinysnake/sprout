/**
 * The production `AgentManagementService`: the typed bridge from the page's
 * port to the #90 wire adapter.
 *
 * It owns exactly one responsibility — mapping the durable Agent identities,
 * the Environment-facts compatibility projection, and the durable run
 * attributions onto the page's `AgentInstance` composition — and it
 * deliberately owns no domain rule and no fixture. The backend's validation,
 * append-only versioning, archive safety guard, and compatibility projection
 * each have exactly one implementation; this bridge re-derives none of them.
 *
 * When the wire reports nothing for an id, `getAgent` returns `undefined`
 * rather than inventing a row. When the compatibility projection is not
 * configured (`503`), the row degrades honestly to the not-yet-observed
 * state instead of a fabricated verdict.
 */

import type {
  AgentCompatibilityView,
  AgentBrowserAdapter,
  AgentView,
  RunWorkOptionAttributionRecord,
} from '../../../adapters/agent-api.js';
import type { RunView } from '../../../../../src/web/views.ts';
import type {
  AgentCompatibilitySummary,
  AgentConfigurationVersionRow,
  AgentInstance,
  AgentManagementService,
  AgentRunAttributionRow,
  AgentWorkOptionRow,
  CreateAgentInput,
  ReconfigureAgentInput,
} from '../types.js';
import { evaluateAgentStatus } from '../status.ts';

/** The deterministic per-option presentation mapping; the text stays backend-owned. */
function optionCompatibilityOf(state: string): AgentWorkOptionRow['compatibility'] {
  switch (state) {
    case 'available':
    case 'login-required':
    case 'missing':
    case 'model-unavailable':
      return state;
    default:
      return 'unknown';
  }
}

function optionRows(
  options: readonly { readonly id: string; readonly engine: string; readonly workModel: string; readonly effort: string }[],
  byOptionId: ReadonlyMap<string, { readonly state: string; readonly reason: string }> | undefined
): AgentWorkOptionRow[] {
  return options.map((option) => {
    const verdict = byOptionId?.get(option.id);
    return {
      id: option.id,
      engine: option.engine,
      workModel: option.workModel,
      effort: option.effort,
      compatibility: optionCompatibilityOf(verdict?.state ?? 'unknown'),
      compatibilityReason: verdict?.reason ?? 'This option has not been evaluated against the current Environment facts yet.',
    };
  });
}

/** Map one compatibility projection onto the page's per-option verdict map. */
function verdictsOf(projection: AgentCompatibilityView): Map<string, { readonly state: string; readonly reason: string }> {
  return new Map(
    projection.options.map((entry) => [entry.option.id, { state: entry.state, reason: entry.reason }]),
  );
}

function versionRows(
  agent: AgentView,
  byOptionId: ReadonlyMap<string, { readonly state: string; readonly reason: string }> | undefined
): AgentConfigurationVersionRow[] {
  return agent.configuration.versions.map((version) => ({
    version: version.version,
    at: version.at,
    reason: version.reason,
    ...(version.instructions !== undefined ? { instructions: version.instructions } : {}),
    options: optionRows(version.options, byOptionId),
  }));
}

function compatibilityOf(
  projection: AgentCompatibilityView | undefined
): AgentCompatibilitySummary | undefined {
  if (projection === undefined) return undefined;
  return {
    environmentAvailable: projection.available,
    ...(projection.firstAvailable !== undefined
      ? { firstAvailableOptionId: projection.firstAvailable.id }
      : {}),
    ...(projection.unavailableReason !== undefined
      ? { unavailableReason: projection.unavailableReason }
      : {}),
  };
}

function composeInstance(agent: AgentView, projection: AgentCompatibilityView | undefined): AgentInstance {
  const verdicts = projection === undefined ? undefined : verdictsOf(projection);
  const current = agent.configuration.versions[agent.configuration.versions.length - 1];
  const workOptions = optionRows(current?.options ?? [], verdicts);
  const instructions = current?.instructions;
  const status = agent.status === 'archived' ? 'archived' : 'active';
  const compatibility = compatibilityOf(projection);
  const evaluated = evaluateAgentStatus({
    status,
    workOptions,
    ...(compatibility !== undefined ? { compatibility } : {}),
  });
  return {
    id: agent.id,
    displayName: agent.displayName,
    status,
    ...(instructions !== undefined && instructions !== '' ? { instructions } : {}),
    currentVersion: agent.configuration.currentVersion,
    versions: versionRows(agent, verdicts),
    workOptions,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(compatibility !== undefined ? { compatibility } : {}),
    trafficLight: evaluated.trafficLight,
    trafficLightReason: evaluated.reason,
  };
}

export class ProductionAgentService implements AgentManagementService {
  readonly #adapter: AgentBrowserAdapter;
  readonly #runs: () => Promise<readonly RunView[]>;

  constructor(adapter: AgentBrowserAdapter, listRuns: () => Promise<readonly RunView[]>) {
    this.#adapter = adapter;
    this.#runs = listRuns;
  }

  async listAgents(): Promise<readonly AgentInstance[]> {
    const [agents, projections] = await Promise.all([
      this.#adapter.listAgents(),
      this.#compatibilityProjections(),
    ]);
    return agents.map((agent) => composeInstance(agent, projections.get(agent.id)));
  }

  async getAgent(id: string): Promise<AgentInstance | undefined> {
    let agent: AgentView;
    try {
      agent = await this.#adapter.getAgent(id);
    } catch {
      // An unknown id is not invented into a row; the page renders not-found.
      return undefined;
    }
    return composeInstance(agent, await this.#safeProjection(id));
  }

  async createAgent(input: CreateAgentInput): Promise<void> {
    await this.#adapter.createAgent({
      displayName: input.displayName,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      workOptions: input.workOptions,
    });
  }

  async reconfigureAgent(id: string, input: ReconfigureAgentInput): Promise<void> {
    await this.#adapter.reconfigureAgent(id, {
      workOptions: input.workOptions,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  async archiveAgent(id: string): Promise<void> {
    await this.#adapter.archiveAgent(id);
  }

  async restoreAgent(id: string): Promise<void> {
    await this.#adapter.restoreAgent(id);
  }

  async listRunAttributions(): Promise<readonly AgentRunAttributionRow[]> {
    // One page-level read of the durable run history; each run already carries
    // its admitted work option and configuration version (#90), so the
    // per-run attribution route is not needed for the foldable.
    const history = await this.#runs();
    const runs = 'runs' in history && Array.isArray((history as { runs?: readonly RunView[] }).runs)
      ? (history as { runs: readonly RunView[] }).runs
      : (history as readonly RunView[]);
    return runs
      .filter((run) => typeof run.agentId === 'string' && run.agentId !== '')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)
      .map((run) => ({
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
        createdAt: run.createdAt,
        ...(run.workOption?.engine !== undefined ? { engine: run.workOption.engine } : {}),
        ...(run.workOption?.workModel !== undefined ? { workModel: run.workOption.workModel } : {}),
        ...(run.workOption?.effort !== undefined ? { effort: run.workOption.effort } : {}),
        ...(run.workOption?.configurationVersion !== undefined
          ? { configurationVersion: run.workOption.configurationVersion }
          : {}),
      }));
  }

  /**
   * The compatibility projection for every listed Agent.
   *
   * Read together with the list so the master cards and the detail panel
   * agree by construction. An unreachable projection (for example the 503 a
   * runtime without readiness facts returns) degrades to `undefined`, which
   * the page renders as the explicit not-yet-observed state — never as a
   * fabricated verdict.
   */
  async #compatibilityProjections(): Promise<ReadonlyMap<string, AgentCompatibilityView>> {
    const projections = new Map<string, AgentCompatibilityView>();
    const agents = await this.#adapter.listAgents();
    await Promise.all(
      agents.map(async (agent) => {
        const projection = await this.#safeProjection(agent.id);
        if (projection !== undefined) projections.set(agent.id, projection);
      }),
    );
    return projections;
  }

  async #safeProjection(agentId: string): Promise<AgentCompatibilityView | undefined> {
    try {
      return await this.#adapter.compatibility(agentId);
    } catch {
      return undefined;
    }
  }
}

/** Keep the wire attribution record type importable for tests. */
export type { RunWorkOptionAttributionRecord };
