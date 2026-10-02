import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';

/**
 * Typed browser port for conversation scopes and Working groups (#95).
 *
 * A thin, typed wrapper over the additive `/api/projects/:id/scopes` and
 * `/api/working-groups` routes, mirroring the Project adapter's rules: it
 * never constructs its own authority and never queues a command — a failed
 * request rejects immediately through the shared transport. The wire shapes
 * mirror `src/web/views.ts` so the browser adapter and the server projection
 * cannot drift into two different contracts.
 *
 * Privacy: every field below is portable state — stable identity, kind,
 * participants, versioned goal/rules content, membership history, and the
 * attributed disband/restore lifecycle history. No
 * credential, provider or account identity, hostname, address, absolute path,
 * or raw command can appear in these shapes, and the adapter never accepts one
 * as input.
 */

export interface ConversationScopeBaseView {
  /** The stable scope identity; also the channel identity consumers address. */
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectChannelScopeView extends ConversationScopeBaseView {
  readonly kind: 'project';
}

export interface DirectConversationScopeView extends ConversationScopeBaseView {
  readonly kind: 'direct';
  /** The canonical participant pair; the same pair in two Projects differs. */
  readonly participants: readonly string[];
}

export interface WorkingGroupMembershipView {
  readonly memberId: string;
  readonly memberKind: string;
  readonly addedAt: number;
  readonly addedBy: string;
  readonly endedAt?: number;
  readonly endedBy?: string;
  readonly endedReason?: string;
}

export interface WorkingGroupContentVersionView {
  readonly version: number;
  readonly at: number;
  readonly actorMemberId: string;
  readonly reason: string;
  readonly displayName: string;
  readonly goal: string;
  readonly rules: readonly string[];
}

export interface WorkingGroupLifecycleView {
  readonly action: 'disband' | 'restore';
  readonly at: number;
  readonly actorMemberId: string;
  readonly reason: string;
}

export interface WorkingGroupScopeView extends ConversationScopeBaseView {
  readonly kind: 'working-group';
  readonly creatorId: string;
  readonly status: string;
  readonly content: {
    readonly currentVersion: number;
    readonly versions: readonly WorkingGroupContentVersionView[];
  };
  readonly memberships: readonly WorkingGroupMembershipView[];
  /** Append-only disband/restore history: actor, time, and reason per transition. */
  readonly lifecycle: readonly WorkingGroupLifecycleView[];
}

export type ConversationScopeView =
  | ProjectChannelScopeView
  | DirectConversationScopeView
  | WorkingGroupScopeView;

/** The read-only admission state of one scope for the acting member. */
export interface ScopeStateView {
  readonly scopeId: string;
  readonly writable: boolean;
  readonly reason?: string;
}

/**
 * The governing goal/rules facts for one scope, as two separate versioned
 * halves: the adapter never merges them, because Sprout does not interpret
 * conflicts between Project and Working group rules (ADR-0008).
 */
export interface ScopeContextView {
  readonly scopeId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly project: {
    readonly contentVersion: number;
    readonly goal: string;
    readonly rules: readonly string[];
  };
  readonly workingGroup?: {
    readonly displayName: string;
    readonly contentVersion: number;
    readonly goal: string;
    readonly rules: readonly string[];
  };
}

export interface ScopeInspectionView {
  readonly scope: ConversationScopeView;
  readonly state: ScopeStateView;
  readonly context: ScopeContextView;
}

export interface CreateWorkingGroupInput {
  readonly displayName: string;
  readonly memberIds?: readonly string[];
  readonly goal?: string;
  readonly rules?: readonly string[];
  readonly reason?: string;
}

export interface ConversationBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listUnread(): Promise<readonly import('../../../src/web/chat-read-router.ts').UnreadScopeCount[]>;
  markRead(scopeId: string, messageIds: readonly string[]): Promise<import('../../../src/web/chat-read-router.ts').UnreadScopeCount>;
  /** Every scope of one Project: the Project channel, direct conversations, Working groups. */
  listScopes(projectId: string): Promise<readonly ConversationScopeView[]>;
  /** Open (idempotently) one Project-scoped direct conversation. */
  openDirectConversation(
    projectId: string,
    input: { readonly participants: readonly string[] },
  ): Promise<ConversationScopeView>;
  /** Every Working group of one Project. */
  listWorkingGroups(projectId: string): Promise<readonly ConversationScopeView[]>;
  /** Create one Working group and its channel atomically (Human authority). */
  createWorkingGroup(
    projectId: string,
    input: CreateWorkingGroupInput,
  ): Promise<WorkingGroupScopeView>;
  getWorkingGroup(id: string): Promise<WorkingGroupScopeView>;
  /** Append one content version; earlier versions are never rewritten. */
  updateWorkingGroupContent(
    id: string,
    input: {
      readonly displayName?: string;
      /** Absent keeps the current goal; `null` clears it. */
      readonly goal?: string | null;
      readonly rules?: readonly string[];
      readonly reason?: string;
    },
  ): Promise<WorkingGroupScopeView>;
  addWorkingGroupMember(
    id: string,
    input: { readonly memberId: string; readonly reason?: string },
  ): Promise<WorkingGroupScopeView>;
  /** End one participation non-destructively; history and attribution remain. */
  endWorkingGroupMember(
    id: string,
    memberId: string,
    input?: { readonly reason?: string },
  ): Promise<WorkingGroupScopeView>;
  /** Disband: the channel becomes read-only; nothing is deleted. */
  disbandWorkingGroup(id: string, input?: { readonly reason?: string }): Promise<WorkingGroupScopeView>;
  /** Restore a disbanded Working group when its members are still eligible. */
  restoreWorkingGroup(id: string, input?: { readonly reason?: string }): Promise<WorkingGroupScopeView>;
  /** One scope projected for the Human: record, read-only state, governing context. */
  inspectScope(scopeId: string): Promise<ScopeInspectionView>;
}

function jsonCommand(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function createConversationBrowserAdapter(
  transport: BrowserTransport,
): ConversationBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listUnread() {
      const response = await transport.request<{ readonly scopes: readonly import('../../../src/web/chat-read-router.ts').UnreadScopeCount[] }>('/api/chat/unread');
      return response.scopes;
    },
    async markRead(scopeId, messageIds) {
      return transport.request<import('../../../src/web/chat-read-router.ts').UnreadScopeCount>(`/api/scopes/` + encodeURIComponent(scopeId) + '/read', jsonCommand({ messageIds }));
    },
    async listScopes(projectId) {
      const response = await transport.request<{ readonly scopes: readonly ConversationScopeView[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/scopes`,
      );
      return response.scopes;
    },
    async openDirectConversation(projectId, input) {
      const response = await transport.request<{ readonly scope: ConversationScopeView }>(
        `/api/projects/${encodeURIComponent(projectId)}/scopes/direct`,
        jsonCommand(input),
      );
      return response.scope;
    },
    async listWorkingGroups(projectId) {
      const response = await transport.request<{
        readonly workingGroups: readonly ConversationScopeView[];
      }>(`/api/projects/${encodeURIComponent(projectId)}/working-groups`);
      return response.workingGroups;
    },
    async createWorkingGroup(projectId, input) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/projects/${encodeURIComponent(projectId)}/working-groups`,
        jsonCommand(input),
      );
      return response.workingGroup;
    },
    async getWorkingGroup(id) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/working-groups/${encodeURIComponent(id)}`,
      );
      return response.workingGroup;
    },
    async updateWorkingGroupContent(id, input) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/working-groups/${encodeURIComponent(id)}/content`,
        jsonCommand(input),
      );
      return response.workingGroup;
    },
    async addWorkingGroupMember(id, input) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/working-groups/${encodeURIComponent(id)}/members`,
        jsonCommand(input),
      );
      return response.workingGroup;
    },
    async endWorkingGroupMember(id, memberId, input) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/working-groups/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/end`,
        jsonCommand(input ?? {}),
      );
      return response.workingGroup;
    },
    async disbandWorkingGroup(id, input) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/working-groups/${encodeURIComponent(id)}/disband`,
        jsonCommand(input ?? {}),
      );
      return response.workingGroup;
    },
    async restoreWorkingGroup(id, input) {
      const response = await transport.request<{ readonly workingGroup: WorkingGroupScopeView }>(
        `/api/working-groups/${encodeURIComponent(id)}/restore`,
        jsonCommand(input ?? {}),
      );
      return response.workingGroup;
    },
    async inspectScope(scopeId) {
      return transport.request<ScopeInspectionView>(
        `/api/scopes/${encodeURIComponent(scopeId)}`,
      );
    },
  };
}
