/**
 * Domain types for Sprout M2 Mobile-First Interactive Prototype.
 * Strictly aligned with CONTEXT.md and ADRs 0006, 0007, 0008, 0009, and 0010.
 */

export type OperatorIdentity = {
  id: string;
  name: string;
  sessionCount: number;
  connectionState: 'online' | 'reconnecting' | 'stale';
  transport: 'loopback' | 'private-overlay';
  overlayAddress?: string | undefined;
};

export type EngineKind = 'codex' | 'pi' | 'agy' | 'opencode';

export type AgentWorkOption = {
  id: string;
  engine: EngineKind;
  workModel: string;
  effort: 'low' | 'medium' | 'high' | 'default';
  isConfigured: boolean;
};

export type AgentDefinition = {
  id: string;
  displayName: string;
  avatar: string;
  description: string;
  standingInstructions?: string | undefined;
  workOptions: AgentWorkOption[];
  status: 'active' | 'archived';
  privateMemoryEntriesCount: number;
};

export type ProjectMembership = {
  memberId: string;
  memberKind: 'human' | 'agent';
  displayName: string;
  avatar: string;
  responsibilities?: string | undefined;
  collaborationInstructions?: string | undefined;
  joinedAt: string;
  status: 'active' | 'ended';
};

export type WorkingGroup = {
  id: string;
  projectId: string;
  displayName: string;
  goal?: string | undefined;
  rules?: string[] | undefined;
  creatorId: string;
  memberIds: string[];
  status: 'active' | 'disbanded';
  createdAt: string;
};

export type RoutingDisposition =
  | 'addressed'
  | 'wake-eligible'
  | 'informational'
  | 'human-action-required'
  | 'non-routing';

export type MessageScope =
  | { kind: 'project-channel' }
  | { kind: 'working-group-channel'; workingGroupId: string }
  | { kind: 'direct-message'; recipientId: string };

export type MessageItem = {
  id: string;
  projectId: string;
  scope: MessageScope;
  authorId: string;
  authorKind: 'human' | 'agent' | 'system';
  authorDisplayName: string;
  authorAvatar: string;
  timestamp: string;
  content: string;
  disposition: RoutingDisposition;
  isProjectedReply?: boolean | undefined;
  projectedReplyMeta?:
    | {
        runId: string;
        agentId: string;
        wakeRequestId: string;
        triggeringMessageIds: string[];
      }
    | undefined;
  routingCausalChainId?: string | undefined;
};

export type WakePolicy = 'explicit-only' | 'wake-model-assisted';

export type RoutingBatch = {
  id: string;
  projectId: string;
  openedAt: string;
  closedAt: string;
  inputMessageIds: string[];
  status: 'open' | 'evaluating' | 'settled' | 'failed-closed';
  attemptsCount: number;
  wakeModel: string;
  frozenContextSummary: {
    tokenCount: number;
    projectRulesIncluded: boolean;
    recentMessagesCount: number;
    tasksSummariesCount: number;
    truncated: boolean;
  };
  decisions: {
    messageId: string;
    targetAgentId?: string | undefined;
    status: 'selected' | 'suppressed' | 'failed';
    rationale: string;
  }[];
  resultingWakeRequestIds: string[];
};

export type TaskLifecycleState =
  | 'proposed'
  | 'active'
  | 'Task pause requested'
  | 'paused'
  | 'blocked'
  | 'awaiting validation'
  | 'ending'
  | 'recovery'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'withdrawn';

export type AgentRunLifecycleState =
  | 'none'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export type TaskLeaseLifecycleState =
  | 'none'
  | 'acquiring'
  | 'held'
  | 'recovering'
  | 'releasing'
  | 'released';

export type TaskContentVersion = {
  version: number;
  createdAt: string;
  createdBy: string;
  title: string;
  goal: string;
  constraints: string[];
  validationCriteria: string[];
  taskLeadId: string;
  changeNote?: string | undefined;
};

export type TaskBlocker = {
  id: string;
  reason: string;
  requiredNextAction: string;
  responsibleActor: string;
  whoAdvancesWhenCleared: string;
  createdAt: string;
};

export type TaskCompletionClaim = {
  id: string;
  submittedAt: string;
  submittedByLeadId: string;
  contentVersion: number;
  outcomeSummary: string;
  validationEvidence: string;
  durableChanges: string[];
  knownLimitations: string;
  recommendedDisposition: 'completed';
};

export type NestedAgentRun = {
  id: string;
  taskId: string;
  agentId: string;
  agentDisplayName: string;
  engine: EngineKind;
  workModel: string;
  effort: string;
  contentVersionUsed: number;
  lifecycle: AgentRunLifecycleState;
  startedAt: string;
  settledAt?: string | undefined;
  wallDurationMs?: number | undefined;
  stopRequestedBy?: string | undefined;
  interruptionReason?: string | undefined;
  tokenUsage?:
    | {
        status: 'complete' | 'partial' | 'unavailable';
        uncachedInput: number;
        cachedReads: number;
        cacheWrite: number;
        output: number;
        reasoningOutput: number;
        total: number;
      }
    | undefined;
  monetaryCost?:
    | {
        attributableBilledCostStatus: 'unavailable';
        apiEquivalentStatus: 'available' | 'pending' | 'unavailable';
        estimatedUsdMicros?: number | undefined;
        provenance?: 'provider_estimated' | 'harness_calculated' | 'locally_estimated' | undefined;
        billingBasis: 'metered_api' | 'subscription_included' | 'unknown';
      }
    | undefined;
  events: {
    time: string;
    kind: 'tool_call' | 'tool_output' | 'text_delta' | 'status_change';
    summary: string;
  }[];
  finalAssistantText?: string | undefined;
};

export type TaskItem = {
  id: string;
  projectId: string;
  sourceWorkingGroupId?: string | undefined;
  proposerId: string;
  proposerKind: 'human' | 'agent';
  createdAt: string;
  currentVersion: TaskContentVersion;
  historyVersions: TaskContentVersion[];
  selectedEnvironmentId?: string | undefined;
  taskLeadId: string;
  lifecycle: TaskLifecycleState;
  agentRunLifecycle: AgentRunLifecycleState;
  leaseLifecycle: TaskLeaseLifecycleState;
  activeRunId?: string | undefined;
  runs: NestedAgentRun[];
  activeBlocker?: TaskBlocker | undefined;
  pendingCompletionClaim?: TaskCompletionClaim | undefined;
  recoveryReason?: string | undefined;
  forcedReleaseDisposition?:
    | {
        actor: string;
        timestamp: string;
        reason: string;
        unresolvedFacts: string[];
        risksAcknowledged: boolean;
      }
    | undefined;
};

export type EnvironmentTrafficLight = 'green' | 'yellow' | 'red';

export type EnvironmentInstance = {
  id: string;
  displayName: string;
  platform: 'macos' | 'windows' | 'container';
  hostUser: string;
  trafficLight: EnvironmentTrafficLight;
  trafficLightReason: string;
  enrollmentStatus: 'approved' | 'pending' | 'revoked';
  workerIdentityKey: string;
  connectionState: 'online' | 'reconnecting' | 'offline' | 'never connected';
  lastConfirmedTime: string;
  connectionAgeSec: number;
  protocolCompatibility: 'compatible' | 'incompatible' | 'unknown';
  protocolVersion: string;
  capabilityPermissions: {
    fileReadWrite: boolean;
    processExecution: boolean;
    networkAccess: boolean;
    guiAutomation: boolean;
  };
  engineReadiness: {
    codex: 'ready' | 'login-required' | 'missing' | 'unknown';
    pi: 'ready' | 'login-required' | 'missing' | 'unknown';
    agy: 'ready' | 'login-required' | 'missing' | 'unknown';
    opencode: 'ready' | 'login-required' | 'missing' | 'unknown';
  };
  workSafety: 'clear' | 'reconciling' | 'recovery';
  workspaceRoots: string[];
  activeLeaseHolder?:
    | {
        holderKind: 'task' | 'run';
        holderId: string;
        projectId: string;
        acquiredAt: string;
      }
    | undefined;
  leaseRecovery?:
    | {
        cause: string;
        interruptedRunId?: string | undefined;
        unresolvedFacts: string[];
      }
    | undefined;
};

export type ProjectItem = {
  id: string;
  displayName: string;
  templateSource: string;
  createdAt: string;
  goal?: string | undefined;
  rules?: string[] | undefined;
  completionGuidance?: string | undefined;
  wakePolicy: WakePolicy;
  batchCollectionIntervalSec: number;
  memberships: ProjectMembership[];
  boundEnvironmentWorkspaces: {
    environmentId: string;
    workspaceRoot: string;
    relativeWorkspacePath: string;
    isPrepared: boolean;
  }[];
  workingGroups: WorkingGroup[];
  status: 'active' | 'archived';
};

export type UsageActivityKind = 'agent_run' | 'routing_attempt';

export type UsageActivity = {
  id: string;
  kind: UsageActivityKind;
  projectId: string;
  taskId?: string | undefined;
  agentId?: string | undefined;
  engine?: EngineKind | undefined;
  model: string;
  activityTime: string;
  wallDurationMs: number;
  tokenDimensions: {
    status: 'complete' | 'partial' | 'unavailable';
    totalInput: number;
    uncachedInput: number;
    cachedReads: number;
    cacheWrite: number;
    output: number;
    reasoningOutput: number;
    total: number;
  };
  costValuation: {
    attributableBilledCostStatus: 'unavailable';
    apiEquivalentStatus: 'available' | 'pending' | 'unavailable';
    estimatedUsdMicros: number;
    provenance: 'provider_estimated' | 'harness_calculated' | 'locally_estimated';
    billingBasis: 'metered_api' | 'subscription_included' | 'unknown';
  };
  observationHistory?:
    | {
        timestamp: string;
        source: string;
        status: string;
        usdMicros?: number | undefined;
        note: string;
      }[]
    | undefined;
};

export type AttentionItem = {
  id: string;
  severity: 'action_required' | 'attention' | 'info';
  category: 'task_validation' | 'task_recovery' | 'task_blocker' | 'env_enrollment' | 'env_unhealthy';
  title: string;
  summary: string;
  referenceId: string;
  actionLabel: string;
  actionTargetView: 'tasks' | 'environments' | 'projects';
};
