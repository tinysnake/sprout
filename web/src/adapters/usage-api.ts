import type { UsageActivityFilter, UsageAggregateFilter } from '../../../src/usage/store.ts';
import type { ActivityDetailView } from '../../../src/usage/service.ts';
import type { UsageActivity, UsageAggregate } from '../../../src/usage/model.ts';
import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';

/** Typed browser port for the coverage-aware Usage query surface (#106). */
export interface UsageBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listActivities(filter?: UsageActivityFilter): Promise<readonly UsageActivity[]>;
  getAggregate(filter?: UsageAggregateFilter): Promise<UsageAggregate>;
  getActivity(activityId: string): Promise<ActivityDetailView>;
  getRunUsage(runId: string): Promise<ActivityDetailView>;
  getRoutingAttemptUsage(attemptId: string): Promise<ActivityDetailView>;
  getTaskUsage(taskId: string, filter?: Omit<UsageAggregateFilter, 'taskId'>): Promise<UsageAggregate>;
  getProjectUsage(projectId: string, filter?: Omit<UsageAggregateFilter, 'projectId'>): Promise<UsageAggregate>;
  getAgentUsage(agentId: string, filter?: Omit<UsageAggregateFilter, 'agentId'>): Promise<UsageAggregate>;
  getModelUsage(model: string, filter?: Omit<UsageAggregateFilter, 'model'>): Promise<UsageAggregate>;
}

function queryString(filter: object | undefined): string {
  if (filter === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query.length === 0 ? '' : `?${query}`;
}

export function createUsageBrowserAdapter(transport: BrowserTransport): UsageBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listActivities(filter) {
      const response = await transport.request<{ readonly activities: readonly UsageActivity[] }>(
        `/api/usage/activities${queryString(filter)}`,
      );
      return response.activities;
    },
    getAggregate: (filter) => transport.request<UsageAggregate>(`/api/usage/aggregate${queryString(filter)}`),
    getActivity: (activityId) => transport.request<ActivityDetailView>(
      `/api/usage/activities/${encodeURIComponent(activityId)}`,
    ),
    getRunUsage: (runId) => transport.request<ActivityDetailView>(
      `/api/usage/runs/${encodeURIComponent(runId)}`,
    ),
    getRoutingAttemptUsage: (attemptId) => transport.request<ActivityDetailView>(
      `/api/usage/attempts/${encodeURIComponent(attemptId)}`,
    ),
    getTaskUsage: (taskId, filter) => transport.request<UsageAggregate>(
      `/api/usage/tasks/${encodeURIComponent(taskId)}${queryString(filter)}`,
    ),
    getProjectUsage: (projectId, filter) => transport.request<UsageAggregate>(
      `/api/usage/projects/${encodeURIComponent(projectId)}${queryString(filter)}`,
    ),
    getAgentUsage: (agentId, filter) => transport.request<UsageAggregate>(
      `/api/usage/agents/${encodeURIComponent(agentId)}${queryString(filter)}`,
    ),
    getModelUsage: (model, filter) => transport.request<UsageAggregate>(
      `/api/usage/models/${encodeURIComponent(model)}${queryString(filter)}`,
    ),
  };
}
