import type { InjectionKey } from 'vue';

/**
 * The page-facing Agent composition (#91, ADR-0008).
 *
 * These types are the Manage Agents page's own vocabulary. They are composed by
 * the typed service port from production facts only: the durable Agent identity
 * (#90) plus the Environment-facts compatibility projection and the durable run
 * attributions the same facts produce. No fixture shape ever reaches this file.
 *
 * Privacy: every field is portable state — stable identity, display name,
 * status, standing instructions, ordered work options, version history, and
 * engine/model/effort attribution. No host path, credential, hostname, address,
 * or private memory content can appear here, because the backend's write and
 * read boundaries already refuse them and the page never widens that boundary.
 */

export type AgentLifecycleStatus = 'active' | 'archived';
export type AgentTrafficLight = 'green' | 'yellow' | 'red' | 'neutral';
export type AgentFilter = 'all' | 'active' | 'attention' | 'unavailable' | 'archived';

/**
 * The per-option compatibility verdict (#90's projection, presentation-mapped).
 * The text label is the product's status language; it is never colour-only.
 */
export type OptionCompatibilityState =
  | 'available'
  | 'login-required'
  | 'missing'
  | 'unknown'
  | 'model-unavailable';

export interface AgentWorkOptionRow {
  readonly id: string;
  readonly engine: string;
  readonly workModel: string;
  readonly effort: string;
  /** This option's verdict against the Environment's current observed facts. */
  readonly compatibility: OptionCompatibilityState;
  /** The decisive textual reason from the projection; shown with the badge. */
  readonly compatibilityReason: string;
}

export interface AgentConfigurationVersionRow {
  readonly version: number;
  readonly at: number;
  readonly reason: string;
  readonly instructions?: string;
  readonly options: readonly AgentWorkOptionRow[];
}

export interface AgentCompatibilitySummary {
  readonly environmentAvailable: boolean;
  /** The option run admission would take right now, when any is available. */
  readonly firstAvailableOptionId?: string;
  /** The projection's decisive reason the Agent is unavailable, when it is. */
  readonly unavailableReason?: string;
}

/** One composed Agent row: durable identity plus current-facts projections. */
export interface AgentInstance {
  readonly id: string;
  readonly displayName: string;
  readonly status: AgentLifecycleStatus;
  readonly instructions?: string;
  readonly currentVersion: number;
  readonly versions: readonly AgentConfigurationVersionRow[];
  readonly workOptions: readonly AgentWorkOptionRow[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The Environment-facts projection for this Agent, when facts are reachable. */
  readonly compatibility?: AgentCompatibilitySummary;
  /** The deterministic status language; derived once, rendered everywhere. */
  readonly trafficLight: AgentTrafficLight;
  readonly trafficLightReason: string;
}

/** One run's durable admission facts (#90), as the attribution foldable shows. */
export interface AgentRunAttributionRow {
  readonly runId: string;
  readonly agentId: string;
  readonly status: string;
  readonly createdAt: number;
  readonly engine?: string;
  readonly workModel?: string;
  readonly effort?: string;
  readonly configurationVersion?: number;
}

/** One ordered work option as the editor submits it. */
export interface AgentWorkOptionInput {
  readonly id?: string;
  readonly engine: string;
  readonly workModel: string;
  readonly effort: string;
}

export interface CreateAgentInput {
  readonly displayName: string;
  readonly instructions?: string;
  readonly workOptions: readonly AgentWorkOptionInput[];
}

export interface ReconfigureAgentInput {
  readonly workOptions: readonly AgentWorkOptionInput[];
  readonly displayName?: string;
  /** `null` clears the standing instructions; omitted keeps the current ones. */
  readonly instructions?: string | null;
  readonly reason?: string;
}

/**
 * The authoritative remote-state port for Manage Agents (#91, ADR-0011).
 *
 * It separates backend facts from UI state: the page owns presentation and
 * interaction only, while identity, versioning, archive safety, and
 * compatibility stay backend-owned.
 */
export interface AgentManagementService {
  listAgents(): Promise<readonly AgentInstance[]>;
  getAgent(id: string): Promise<AgentInstance | undefined>;
  createAgent(input: CreateAgentInput): Promise<void>;
  /**
   * Append one configuration version. Earlier versions are never rewritten, so
   * every past run keeps the option list and version it was admitted under.
   */
  reconfigureAgent(id: string, input: ReconfigureAgentInput): Promise<void>;
  /**
   * Non-destructive archive (ADR-0008). Refused while active work depends on
   * the Agent; nothing is ever hard-deleted.
   */
  archiveAgent(id: string): Promise<void>;
  /** Restore an archived Agent; always safe because nothing was deleted. */
  restoreAgent(id: string): Promise<void>;
  /** Durable run attributions, newest first, for the provenance foldable. */
  listRunAttributions(): Promise<readonly AgentRunAttributionRow[]>;
}

/**
 * The typed adapter the Agents route requires.
 *
 * A production route never constructs its own authority: the bootstrap wires a
 * real adapter here and deterministic tests inject a fixture explicitly. When
 * nothing is provided the route fails closed with an explicit unavailable
 * state rather than falling back to fixture facts.
 */
export const AGENT_SERVICE: InjectionKey<AgentManagementService> = Symbol(
  'sprout.agents.service'
);
