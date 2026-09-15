import type { AgentDefinition } from './agent/registry.ts';
import type { Project, ProjectMembership } from './project/model.ts';

/** Optional host configuration for deployments with more than the sample Agent. */
export interface RuntimeConfiguration {
  readonly agents?: readonly AgentDefinition[];
  readonly project?: Project;
}

/**
 * Parse the one optional JSON configuration channel used by the runtime entry
 * point.  Keeping this at the edge lets the production graph remain unaware of
 * environment variables while a real deployment can register independent
 * Agents without editing source.
 */
export function parseRuntimeConfiguration(value: string | undefined): RuntimeConfiguration {
  if (value === undefined || value === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error('SPROUT_RUNTIME_CONFIG must be valid JSON');
  }
  if (!isRecord(raw)) throw new Error('SPROUT_RUNTIME_CONFIG must be an object');
  const agents = raw.agents === undefined ? undefined : parseAgents(raw.agents);
  const project = raw.project === undefined ? undefined : parseProject(raw.project);
  if (agents !== undefined && project !== undefined) {
    const known = new Set(agents.map((agent) => agent.id));
    for (const membership of project.memberships) {
      if (!known.has(membership.agentId)) {
        throw new Error(`SPROUT_RUNTIME_CONFIG project member is not an Agent: ${membership.agentId}`);
      }
    }
  }
  return {
    ...(agents !== undefined ? { agents } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

function parseAgents(raw: unknown): readonly AgentDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('SPROUT_RUNTIME_CONFIG agents must be a non-empty array');
  const agents: AgentDefinition[] = raw.map((entry) => {
    if (!isRecord(entry)) throw new Error('SPROUT_RUNTIME_CONFIG agent must be an object');
    const id = required(entry, 'id', 'agent');
    const name = required(entry, 'name', 'agent');
    const engine = required(entry, 'engine', 'agent');
    const capability = required(entry, 'capability', 'agent');
    const workingDirectory = optional(entry, 'workingDirectory', 'agent');
    const instructions = optional(entry, 'instructions', 'agent');
    const model = optional(entry, 'model', 'agent');
    const effort = optional(entry, 'effort', 'agent');
    return {
      id, name, engine, capability,
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };
  });
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) throw new Error('SPROUT_RUNTIME_CONFIG agent ids must be unique');
  return agents;
}

function parseProject(raw: unknown): Project {
  if (!isRecord(raw)) throw new Error('SPROUT_RUNTIME_CONFIG project must be an object');
  const membershipsRaw = raw.memberships;
  if (!Array.isArray(membershipsRaw)) throw new Error('SPROUT_RUNTIME_CONFIG project memberships must be an array');
  const memberships: readonly ProjectMembership[] = membershipsRaw.map((entry) => {
    if (!isRecord(entry)) throw new Error('SPROUT_RUNTIME_CONFIG membership must be an object');
    return {
      agentId: required(entry, 'agentId', 'membership'),
      responsibilities: strings(entry.responsibilities, 'membership responsibilities'),
      collaborationInstructions: required(entry, 'collaborationInstructions', 'membership'),
    };
  });
  return {
    id: required(raw, 'id', 'project'),
    goal: required(raw, 'goal', 'project'),
    rules: strings(raw.rules, 'project rules'),
    availableEnvironmentInstanceIds: strings(raw.availableEnvironmentInstanceIds, 'project availableEnvironmentInstanceIds'),
    memberships,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function required(value: Record<string, unknown>, field: string, scope: string): string {
  const found = value[field];
  if (typeof found !== 'string' || found === '') throw new Error(`SPROUT_RUNTIME_CONFIG ${scope}.${field} must be a non-empty string`);
  return found;
}

function optional(value: Record<string, unknown>, field: string, scope: string): string | undefined {
  const found = value[field];
  if (found === undefined) return undefined;
  if (typeof found !== 'string') throw new Error(`SPROUT_RUNTIME_CONFIG ${scope}.${field} must be a string`);
  return found;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`SPROUT_RUNTIME_CONFIG ${field} must be an array of strings`);
  }
  return value;
}
