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

export type AgentVersionRecord = {
  version: number;
  timestamp: string;
  author: string;
  changeSummary: string;
  optionsCount: number;
  standingInstructions?: string | undefined;
};

export type AgentAttributionRecord = {
  id: string;
  projectName: string;
  projectId: string;
  entityKind: 'task_run' | 'message' | 'validation_claim';
  entityId: string;
  timestamp: string;
  configVersionUsed: number;
  engineUsed: EngineKind;
  modelUsed: string;
  effortUsed: string;
  summary: string;
};

export type AgentExecutionAttribution = Pick<
  AgentAttributionRecord,
  'configVersionUsed' | 'engineUsed' | 'modelUsed' | 'effortUsed'
>;

export type AgentDefinition = {
  id: string;
  displayName: string;
  avatar: string;
  description: string;
  standingInstructions?: string | undefined;
  workOptions: AgentWorkOption[];
  status: 'active' | 'archived';
  privateMemoryEntriesCount: number;
  version?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  versionHistory?: AgentVersionRecord[] | undefined;
  attributionHistory?: AgentAttributionRecord[] | undefined;
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
  /** Current participants while active. Empty while a disbanded group is read-only. */
  memberIds: string[];
  /** Frozen restore candidates captured when the group is disbanded. */
  retainedMemberIds?: string[] | undefined;
  /** Historical participation survives membership end and group restoration. */
  membershipHistory?:
    | {
        memberId: string;
        joinedAt: string;
        endedAt?: string | undefined;
      }[]
    | undefined;
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
  deterministicRoutingOutcomes?:
    | {
        targetAgentId: string;
        targetDisplayName?: string | undefined;
        status: 'admitted' | 'failed' | 'cancelled';
        reason: string;
        terminalResponsibility?:
          | {
              kind: 'agent' | 'project';
              id: string;
            }
          | undefined;
      }[]
    | undefined;
  agentAttribution?: AgentExecutionAttribution | undefined;
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

export type RoutingBatchStatus =
  | 'open'
  | 'evaluating'
  | 'settled'
  | 'suppressed'
  | 'failed-closed';

export type RoutingAttemptRecord = {
  attemptNumber: number;
  timestamp: string;
  wakeModel: string;
  durationMs: number;
  status: 'success' | 'timeout' | 'malformed_output' | 'failed';
  errorDetail?: string | undefined;
};

export type PrivacyBoundaryManifest = {
  directMessagesExcluded: boolean;
  privateMemoryExcluded: boolean;
  sessionsAndTranscriptsExcluded: boolean;
  credentialsExcluded: boolean;
  hostFactsExcluded: boolean;
  transientEnvCapacityExcluded: boolean;
};

export type ResultingWakeRequestRecord = {
  wakeRequestId: string;
  targetAgentId: string;
  admissionStatus: 'admitted' | 'pending' | 'waiting_capacity' | 'failed';
  linkedRunId?: string | undefined;
  projectedReplyId?: string | undefined;
  failureReason?: string | undefined;
  terminalResponsibility?: RoutingTerminalResponsibility | undefined;
};

export type RoutingTerminalResponsibility = {
  kind: 'agent' | 'project';
  id: string;
};

export type RoutingBatch = {
  id: string;
  projectId: string;
  openedAt: string;
  closedAt: string;
  collectionWindowDurationSec?: number | undefined;
  countdownRemainingSec?: number | undefined;
  inputMessageIds: string[];
  status: RoutingBatchStatus;
  attemptsCount: number;
  attemptsHistory?: RoutingAttemptRecord[] | undefined;
  wakeModel: string;
  frozenContextSummary: {
    tokenCount: number;
    projectRulesIncluded: boolean;
    recentMessagesCount: number;
    tasksSummariesCount: number;
    truncated: boolean;
  };
  privacyBoundaryManifest?: PrivacyBoundaryManifest | undefined;
  decisions: {
    messageId: string;
    targetAgentId?: string | undefined;
    status: 'selected' | 'suppressed' | 'failed';
    rationale: string;
  }[];
  resultingWakeRequestIds: string[];
  resultingWakeRequests?: ResultingWakeRequestRecord[] | undefined;
  failureReason?: string | undefined;
  terminalResponsibility?: RoutingTerminalResponsibility | undefined;
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
  agentConfigVersionUsed: number;
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

export type EngineStatus = 'ready' | 'login-required' | 'missing' | 'unknown';

export type EngineDetailInfo = {
  version: string;
  authStatus: 'authenticated' | 'login-required' | 'uninstalled' | 'unknown';
  modelAvailability: string;
  notes?: string | undefined;
};

export type ProbeRecord = {
  id: string;
  timestamp: string;
  latencyMs: number;
  protocolOk: boolean;
  enginesOk: boolean;
  capabilitiesOk: boolean;
  summary: string;
};

export type ReconciledEvidence = {
  retainedEventsCount: number;
  turnSettlementObserved: boolean;
  engineSessionStopped: boolean;
  taskContextRecycled: boolean;
  synchronizedAt: string;
};

export type EnvironmentInstance = {
  id: string;
  displayName: string;
  platform: 'macos' | 'windows' | 'container';
  hostUser: string;
  trafficLight: EnvironmentTrafficLight;
  trafficLightReason: string;
  enrollmentStatus: 'approved' | 'pending' | 'revoked' | 'archived';
  workerIdentityKey: string;
  connectionState: 'online' | 'reconnecting' | 'offline' | 'never connected';
  lastConfirmedTime: string;
  connectionAgeSec: number;
  protocolCompatibility: 'compatible' | 'incompatible' | 'unknown';
  protocolVersion: string;
  protocolMismatchDetail?: string | undefined;
  capabilityPermissions: {
    fileReadWrite: boolean;
    processExecution: boolean;
    networkAccess: boolean;
    guiAutomation: boolean;
  };
  engineReadiness: {
    codex: EngineStatus;
    pi: EngineStatus;
    agy: EngineStatus;
    opencode: EngineStatus;
  };
  engineDetails?: Record<EngineKind, EngineDetailInfo> | undefined;
  workSafety: 'clear' | 'reconciling' | 'recovery';
  workspaceRoots: string[];
  activeLeaseHolder?:
    | {
        holderKind: 'task' | 'run';
        holderId: string;
        projectId: string;
        acquiredAt: string;
        taskTitle?: string | undefined;
        leadAgentName?: string | undefined;
      }
    | undefined;
  leaseRecovery?:
    | {
        cause: string;
        interruptedRunId?: string | undefined;
        interruptedRunAgent?: string | undefined;
        unresolvedFacts: string[];
        reconciledEvidence?: ReconciledEvidence | undefined;
      }
    | undefined;
  forcedReleaseRecord?:
    | {
        actor: string;
        timestamp: string;
        reason: string;
        unresolvedFacts: string[];
        risksAcknowledged: boolean;
      }
    | undefined;
  probeHistory?: ProbeRecord[] | undefined;
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
  compatibilityHistory?:
    | {
        evaluatedAt: string;
        trigger: 'restore';
        status: 'ready' | 'unavailable';
        summary: string;
        environments: {
          environmentId: string;
          status: 'compatible' | 'unavailable';
          reason: string;
        }[];
      }[]
    | undefined;
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

export type PrimaryNav = 'feed' | 'project' | 'manage' | 'primitives';

export type ProjectTab = 'overview' | 'tasks' | 'chat';

export type ManageTab = 'environments' | 'agents' | 'usage' | 'settings';

export type ThemeMode = 'dark' | 'light';

export type DensityMode = 'comfortable' | 'compact';

export type ViewportMode = 'mobile' | 'desktop' | 'fluid';

export type ReturnContext = {
  fromNav: PrimaryNav;
  fromLabel: string;
  fromProjectTab?: ProjectTab | undefined;
  fromManageTab?: ManageTab | undefined;
  fromFeedScope?: string | undefined;
  fromFeedSeverity?: string | undefined;
};

export type ActiveDialogKind =
  | 'danger-confirm'
  | 'bottom-sheet'
  | 'modal-dialog'
  | 'slide-inspector'
  | 'none';

export type ActiveDialog = {
  id: string;
  kind: ActiveDialogKind;
  title: string;
  subtitle?: string | undefined;
  bodyText?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  isDestructive?: boolean | undefined;
  requireTypedConfirmation?: string | undefined;
  onConfirm?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
  metadata?: Record<string, any> | undefined;
};

export type AttentionSeverity = 'action_required' | 'attention' | 'info';

export type AttentionCategory =
  | 'task_validation'
  | 'task_recovery'
  | 'task_blocker'
  | 'task_proposed'
  | 'env_enrollment'
  | 'env_unhealthy'
  | 'routing_fallback';

export type FeedStatePreset =
  | 'mixed'
  | 'empty'
  | 'healthy'
  | 'stale'
  | 'pending'
  | 'degraded'
  | 'intervention';

export type FeedLayoutVariant = 'unified' | 'split-board' | 'project-grouped';

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  category: AttentionCategory;
  title: string;
  summary: string;
  projectId?: string | undefined;
  projectName?: string | undefined;
  referenceId: string;
  referenceType: 'task' | 'environment' | 'message' | 'routing_batch' | 'usage';
  actionLabel: string;
  actionTargetView: 'tasks' | 'environments' | 'projects' | 'chat' | 'usage' | 'feed';
  targetNav?: PrimaryNav | undefined;
  targetProjectTab?: ProjectTab | undefined;
  targetManageTab?: ManageTab | undefined;
  timestamp: string;
  lifecycleSentence?: string | undefined;
  attribution?: string | undefined;
};

export type ActivityFeedKind =
  | 'task_lifecycle'
  | 'agent_turn'
  | 'chat_message'
  | 'routing_batch'
  | 'env_heartbeat'
  | 'usage_milestone';

export type ActivityFeedItem = {
  id: string;
  kind: ActivityFeedKind;
  timestamp: string;
  relativeTime: string;
  projectId?: string | undefined;
  projectName?: string | undefined;
  title: string;
  subtitle: string;
  badgeKind: 'purple' | 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  badgeLabel?: string | undefined;
  actor: {
    name: string;
    avatar: string;
    kind: 'human' | 'agent' | 'system' | 'worker';
  };
  targetNav: PrimaryNav;
  targetProjectTab?: ProjectTab | undefined;
  targetManageTab?: ManageTab | undefined;
  targetEntityId?: string | undefined;
  metadata?: Record<string, any> | undefined;
};
