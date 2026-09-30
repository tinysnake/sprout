import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';

/**
 * Typed browser port for wake-model-assisted routing evidence (#97).
 *
 * A thin, typed wrapper over the additive read-only routes
 * `/api/projects/:id/routing-batches`, `/api/routing-batches/:id`,
 * `/api/messages/:id/routing`, and `/api/project-events/:id/routing`. It
 * mirrors `src/web/views.ts` exactly: it never constructs a fact, never queues
 * a command, and — matching ADR-0007's "no routing controls in the MVP" —
 * offers no command at all, only inspection.
 *
 * Privacy: every field below is portable routing evidence — window times and
 * cursor, frozen batch identity and manifest, attempt identity/timing/failure
 * kind, per-input outcomes with model rationale, and WakeRequest status. No
 * credential, host identity, address, absolute path, engine session, tool
 * output, or raw reasoning field exists in these shapes, and the adapter never
 * accepts one as input.
 */

export interface RoutingWindowView {
  readonly id: string;
  readonly projectId: string;
  readonly openedAt: number;
  readonly deadlineAt: number;
  readonly intervalMs: number;
  readonly status: string;
  readonly cursor?: string;
  readonly inputCount: number;
  readonly closedAt?: number;
}

export interface RoutingBatchSummaryView {
  readonly id: string;
  readonly projectId: string;
  readonly windowId: string;
  readonly splitIndex: number;
  readonly splitCount: number;
  readonly cutoffAt: number;
  readonly status: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly settledAt?: number;
}

export interface RoutingBatchInputView {
  readonly inputId: string;
  readonly position: number;
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly excerptChars: number;
  readonly contentChars: number;
}

export interface RoutingAttemptView {
  readonly id: string;
  readonly batchId: string;
  readonly attemptNumber: number;
  readonly modelId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly status: string;
  readonly errorKind?: string;
  readonly errorDetail?: string;
}

export interface RoutingOutcomeView {
  readonly inputId: string;
  readonly status: string;
  readonly assignments: readonly { readonly agentId: string; readonly rationale: string }[];
  /** Model judgement, not fact — never presented as a durable fact. */
  readonly rationale?: string;
  readonly detail?: string;
  readonly settledAt: number;
}

export interface RoutingWakeView {
  readonly agentId: string;
  readonly reason: string;
  readonly status: string;
  readonly runId?: string;
  readonly batchId?: string;
}

/** The frozen manifest: what the model saw, and the exclusions it was built under. */
export interface RoutingContextManifestView {
  readonly projectId: string;
  readonly windowId: string;
  readonly cutoffAt: number;
  readonly policy: string;
  readonly bounds: {
    readonly inputContentChars: number;
    readonly contextMessageChars: number;
    readonly recentContextMessages: number;
    readonly totalContextChars: number;
  };
  readonly inputs: readonly {
    readonly inputId: string;
    readonly kind: string;
    readonly authorId: string;
    readonly createdAt: number;
    readonly scopeId: string;
    readonly candidates: readonly string[];
    readonly excerptChars: number;
    readonly contentChars: number;
    readonly truncated: boolean;
  }[];
  readonly candidates: readonly {
    readonly agentId: string;
    readonly responsibilities: readonly string[];
    readonly collaborationInstructions: string;
  }[];
  /** Curated open Task facts: state, lead, blocker — never Environment facts. */
  readonly tasks: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
    readonly leadAgentId?: string;
    readonly blockerReason?: string;
    readonly createdAt: number;
  }[];
  readonly recentContextIds: readonly string[];
  readonly ancestorContextIds: readonly string[];
  readonly exclusions: readonly string[];
  readonly contextChars: number;
}

export interface RoutingBatchDetailView {
  readonly batch: {
    readonly id: string;
    readonly projectId: string;
    readonly windowId: string;
    readonly splitIndex: number;
    readonly splitCount: number;
    readonly cutoffAt: number;
    readonly status: string;
    readonly error?: string;
    readonly createdAt: number;
    readonly settledAt?: number;
    readonly bounds: RoutingContextManifestView['bounds'];
    readonly manifest: RoutingContextManifestView;
    readonly contextChars: number;
  };
  readonly window?: RoutingWindowView;
  readonly inputs: readonly RoutingBatchInputView[];
  readonly attempts: readonly RoutingAttemptView[];
  readonly outcomes: readonly RoutingOutcomeView[];
  readonly wakes: readonly RoutingWakeView[];
  readonly replies: readonly { readonly idempotencyKey: string; readonly messageId: string }[];
}

export interface WakeObservationView {
  readonly agentId: string;
  readonly status: string;
  readonly reason: string;
  readonly detail: string;
}

/** The causal routing chain of one Message or Project event. */
export interface RoutingEvidenceView {
  readonly input:
    | { readonly kind: 'message'; readonly message: Record<string, unknown> }
    | { readonly kind: 'event'; readonly event: Record<string, unknown> };
  readonly window?: RoutingWindowView;
  readonly batches: readonly RoutingBatchDetailView[];
  readonly deterministicWakes: readonly RoutingWakeView[];
  readonly observations: readonly WakeObservationView[];
}

export interface RoutingBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  /** The durable windows and frozen batches of one Project (summarized). */
  listRoutingBatches(projectId: string): Promise<{
    readonly windows: readonly RoutingWindowView[];
    readonly batches: readonly RoutingBatchSummaryView[];
  }>;
  /** The complete causal evidence for one frozen batch. */
  getRoutingBatch(batchId: string): Promise<RoutingBatchDetailView>;
  /** The causal routing chain of one Message. */
  messageRouting(messageId: string): Promise<RoutingEvidenceView>;
  /** The causal routing chain of one Project event. */
  eventRouting(eventId: string): Promise<RoutingEvidenceView>;
}

export function createRoutingBrowserAdapter(transport: BrowserTransport): RoutingBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listRoutingBatches(projectId) {
      return transport.request<{
        readonly windows: readonly RoutingWindowView[];
        readonly batches: readonly RoutingBatchSummaryView[];
      }>(`/api/projects/${encodeURIComponent(projectId)}/routing-batches`);
    },
    async getRoutingBatch(batchId) {
      const response = await transport.request<{ readonly routingBatch: RoutingBatchDetailView }>(
        `/api/routing-batches/${encodeURIComponent(batchId)}`,
      );
      return response.routingBatch;
    },
    async messageRouting(messageId) {
      const response = await transport.request<{ readonly routing: RoutingEvidenceView }>(
        `/api/messages/${encodeURIComponent(messageId)}/routing`,
      );
      return response.routing;
    },
    async eventRouting(eventId) {
      const response = await transport.request<{ readonly routing: RoutingEvidenceView }>(
        `/api/project-events/${encodeURIComponent(eventId)}/routing`,
      );
      return response.routing;
    },
  };
}
