import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';

/**
 * Typed browser port for portable Agent identities and ordered work options (#90).
 *
 * A thin, typed wrapper over the `/api/agents` routes, mirroring the
 * Environment adapter's rules: it never constructs its own authority and never
 * queues a command — a failed request rejects immediately through the shared
 * transport. The wire shapes mirror `src/web/views.ts` so the browser adapter
 * and the server projection cannot drift into two different contracts.
 *
 * Privacy: every field below is portable state — stable identity, display
 * name, status, standing instructions, and ordered work options. No host path,
 * credential, hostname, address, or run transcript can appear in these shapes,
 * and the adapter never accepts one as input.
 */

export interface AgentWorkOptionView {
  readonly id: string;
  readonly engine: string;
  readonly workModel: string;
  readonly effort: string;
}

export interface AgentConfigurationVersionView {
  readonly version: number;
  readonly at: number;
  readonly reason: string;
  readonly options: readonly AgentWorkOptionView[];
  readonly instructions?: string;
}

export interface AgentView {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly configuration: {
    readonly currentVersion: number;
    readonly versions: readonly AgentConfigurationVersionView[];
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentWorkOptionInput {
  readonly engine: string;
  readonly workModel: string;
  readonly effort: string;
  readonly id?: string;
}

/** One option's compatibility against one Environment's current facts (#90). */
export interface AgentOptionCompatibilityView {
  readonly option: AgentWorkOptionView;
  readonly state: string;
  readonly reason: string;
}

export interface AgentCompatibilityView {
  readonly agentId: string;
  readonly environmentInstanceId: string;
  readonly available: boolean;
  readonly firstAvailable?: AgentWorkOptionView;
  readonly unavailableReason?: string;
  readonly options: readonly AgentOptionCompatibilityView[];
}

/** One run's durable admission facts (#90). */
export interface RunWorkOptionAttributionRecord {
  readonly runId: string;
  readonly agentId: string;
  readonly environmentInstanceId: string;
  readonly attribution:
    | {
        readonly engine: string;
        readonly workModel?: string;
        readonly effort?: string;
        readonly configurationVersion: number;
      }
    | undefined;
}

export interface AgentBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listAgents(status?: 'active' | 'archived'): Promise<readonly AgentView[]>;
  getAgent(id: string): Promise<AgentView>;
  createAgent(input: {
    readonly id?: string;
    readonly displayName: string;
    readonly instructions?: string;
    readonly workOptions: readonly AgentWorkOptionInput[];
  }): Promise<AgentView>;
  /** Append one configuration version; earlier versions are never rewritten. */
  reconfigureAgent(id: string, input: {
    readonly workOptions: readonly AgentWorkOptionInput[];
    readonly displayName?: string;
    readonly instructions?: string | null;
    readonly reason?: string;
  }): Promise<AgentView>;
  /** Non-destructive archive (ADR-0008): refused while active work depends on the Agent. */
  archiveAgent(id: string): Promise<AgentView>;
  restoreAgent(id: string): Promise<AgentView>;
  /** The current Environment-facts compatibility projection for one Agent. */
  compatibility(id: string): Promise<AgentCompatibilityView>;
  /** One run's durable engine/work-model/effort/config-version attribution. */
  runWorkOption(runId: string): Promise<RunWorkOptionAttributionRecord>;
}

function jsonCommand(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function createAgentBrowserAdapter(transport: BrowserTransport): AgentBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listAgents(status) {
      const suffix = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
      const response = await transport.request<{ readonly agents: readonly AgentView[] }>(
        `/api/agents${suffix}`,
      );
      return response.agents;
    },
    async getAgent(id) {
      const response = await transport.request<{ readonly agent: AgentView }>(
        `/api/agents/${encodeURIComponent(id)}`,
      );
      return response.agent;
    },
    async createAgent(input) {
      const response = await transport.request<{ readonly agent: AgentView }>(
        '/api/agents',
        jsonCommand(input),
      );
      return response.agent;
    },
    async reconfigureAgent(id, input) {
      const response = await transport.request<{ readonly agent: AgentView }>(
        `/api/agents/${encodeURIComponent(id)}/configuration`,
        jsonCommand(input),
      );
      return response.agent;
    },
    async archiveAgent(id) {
      const response = await transport.request<{ readonly agent: AgentView }>(
        `/api/agents/${encodeURIComponent(id)}/archive`,
        jsonCommand({}),
      );
      return response.agent;
    },
    async restoreAgent(id) {
      const response = await transport.request<{ readonly agent: AgentView }>(
        `/api/agents/${encodeURIComponent(id)}/restore`,
        jsonCommand({}),
      );
      return response.agent;
    },
    async compatibility(id) {
      return transport.request<AgentCompatibilityView>(
        `/api/agents/${encodeURIComponent(id)}/compatibility`,
      );
    },
    async runWorkOption(runId) {
      return transport.request<RunWorkOptionAttributionRecord>(
        `/api/runs/${encodeURIComponent(runId)}/work-option`,
      );
    },
  };
}
