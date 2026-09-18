import type {
  ActiveDialog,
  ActivityFeedItem,
  AgentDefinition,
  AgentAttributionRecord,
  AgentWorkOption,
  AttentionCategory,
  AttentionItem,
  AttentionSeverity,
  DensityMode,
  EngineKind,
  EnvironmentInstance,
  FeedLayoutVariant,
  FeedScenarioSnapshot,
  FeedStatePreset,
  ManageTab,
  MessageItem,
  NestedAgentRun,
  OperatorIdentity,
  PrimaryNav,
  ProjectItem,
  ProjectMembership,
  ProjectTab,
  ReturnContext,
  RoutingBatch,
  ResultingWakeRequestRecord,
  OperatorSettingsModel,
  TaskItem,
  ThemeMode,
  UsageActivity,
  ViewportMode,
} from './types.js';

export type { ViewportMode };
export type SettingsCategoryTab = 'access' | 'system' | 'data';
export type ActiveTab = 'attention' | 'projects' | 'tasks' | 'environments' | 'agents' | 'usage' | 'onboarding' | 'primitives';

export type EnvironmentEligibilityCheck = {
  isEligible: boolean;
  reason?: string;
};

type AdmissionStep = {
  priority: number;
  option: AgentWorkOption;
  status: 'selected' | 'skipped_unsupported' | 'skipped_unauthenticated' | 'skipped_model_missing' | 'skipped_unconfigured';
  reason: string;
};

type PendingProjectedReply = {
  agentId: string;
  projectId: string;
  timer: ReturnType<typeof setTimeout>;
  onCancel: (cancellation: PendingReplyCancellation) => void;
};

type PendingReplyCancellation = {
  responsibleKind: 'agent' | 'project';
  responsibleId: string;
  reason: string;
};

type WakeRequestTerminalStatus = NonNullable<ResultingWakeRequestRecord['terminalStatus']>;

function terminalTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Returns the status that should be shown for a WakeRequest.  Older persisted
 * fixtures only have admissionStatus, so a completed run/reply pair is
 * interpreted as settled without rewriting that historical fixture in-place.
 */
export function getWakeRequestDisplayStatus(
  wakeRequest: ResultingWakeRequestRecord
): ResultingWakeRequestRecord['admissionStatus'] | WakeRequestTerminalStatus {
  if (wakeRequest.terminalStatus) return wakeRequest.terminalStatus;
  if (wakeRequest.admissionStatus === 'failed-closed' || wakeRequest.admissionStatus === 'cancelled') {
    return wakeRequest.admissionStatus;
  }
  if (wakeRequest.linkedRunId && wakeRequest.projectedReplyId) return 'settled';
  return wakeRequest.admissionStatus;
}

type CollaborationEligibility = {
  success: boolean;
  reason?: string;
};

type MentionToken = {
  value: string;
  normalized: string;
};

function extractExactMentionTokens(content: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  const matcher = /(^|[^a-zA-Z0-9_-])@([a-zA-Z0-9_-]+)(?=$|[^a-zA-Z0-9_-])/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(content)) !== null) {
    const value = match[2];
    if (!value) continue;
    tokens.push({ value, normalized: value.toLowerCase() });
  }
  return tokens;
}

export type AdmissionEvaluation = {
  agent?: AgentDefinition;
  environment?: EnvironmentInstance;
  envIneligibilityReason?: string | undefined;
  rejectionReason?: string | undefined;
  evaluationSteps: AdmissionStep[];
  selectedOption: AgentWorkOption | null;
  guaranteeNote: string;
};

export function checkEnvironmentEligibility(env: EnvironmentInstance): EnvironmentEligibilityCheck {
  if (env.enrollmentStatus !== 'approved') {
    return {
      isEligible: false,
      reason: `Host is not approved for work admission (enrollment status: ${env.enrollmentStatus}).`,
    };
  }
  if (env.connectionState !== 'online') {
    return {
      isEligible: false,
      reason: `Host is ${env.connectionState}; online connection required for admission.`,
    };
  }
  if (env.protocolCompatibility !== 'compatible') {
    return {
      isEligible: false,
      reason: `Protocol incompatible: ${env.protocolMismatchDetail || `worker protocol ${env.protocolVersion} is incompatible`}.`,
    };
  }
  if (env.leaseRecovery) {
    return {
      isEligible: false,
      reason: 'Work safety blocked: unresolved lease-recovery evidence is still attached to this Environment.',
    };
  }
  if (env.workSafety !== 'clear') {
    return {
      isEligible: false,
      reason: `Work safety blocked: Environment is in ${env.workSafety} state (lease recovery required).`,
    };
  }
  if (env.capabilityPermissions && env.capabilityPermissions.processExecution === false) {
    return {
      isEligible: false,
      reason: 'Host capability restriction: processExecution permission is disabled.',
    };
  }
  return { isEligible: true };
}

export function checkEngineModelAvailability(
  engine: EngineKind,
  workModel: string,
  env: EnvironmentInstance
): { isAvailable: boolean; reason?: string } {
  const readiness = env.engineReadiness[engine];
  if (!readiness || readiness === 'missing') {
    return {
      isAvailable: false,
      reason: `Engine "${engine}" is not installed or supported on host ${env.displayName}.`,
    };
  }
  if (readiness === 'login-required') {
    return {
      isAvailable: false,
      reason: `Engine "${engine}" requires login/authentication on host ${env.displayName}.`,
    };
  }
  if (readiness !== 'ready') {
    return {
      isAvailable: false,
      reason: `Engine "${engine}" readiness status is ${readiness} on host ${env.displayName}.`,
    };
  }

  const detail = env.engineDetails?.[engine];
  const rawAvailability = detail?.modelAvailability?.trim() || '';
  if (rawAvailability === '' || rawAvailability.toLowerCase() === 'none' || rawAvailability.toLowerCase() === 'unknown') {
    return {
      isAvailable: false,
      reason: `Model availability for engine "${engine}" on host ${env.displayName} is unknown or unavailable.`,
    };
  }

  const availableModels = rawAvailability.split(',').map((model) => model.trim().toLowerCase()).filter(Boolean);
  const requestedModel = workModel.trim().toLowerCase();
  if (!requestedModel || !availableModels.includes(requestedModel)) {
    return {
      isAvailable: false,
      reason: `Model "${workModel}" is not available for engine "${engine}" on host ${env.displayName} (available: ${rawAvailability}).`,
    };
  }

  return { isAvailable: true };
}

export interface PrototypeState {
  viewportMode: ViewportMode;
  theme: ThemeMode;
  density: DensityMode;
  primaryNav: PrimaryNav;
  projectTab: ProjectTab;
  manageTab: ManageTab;
  activeTab: ActiveTab;
  feedLayoutVariant: FeedLayoutVariant;
  feedStatePreset: FeedStatePreset;
  feedScenarioSnapshot?: FeedScenarioSnapshot | undefined;
  feedScopeFilter: string;
  feedAttentionSeverityFilter: 'all' | AttentionSeverity;
  feedAttentionFilter: 'all' | AttentionCategory | AttentionSeverity;
  feedActivityFilter: 'all' | 'tasks' | 'messages' | 'envs' | 'usage';
  mobileFeedSplitTab: 'attention' | 'activity';
  taskViewMode: 'list' | 'detail';
  taskFilter: string;
  chatViewMode: 'list' | 'detail';
  environmentViewMode: 'list' | 'detail';
  environmentFilter: string;
  agentViewMode: 'list' | 'detail';
  agentFilter: string;
  selectedProjectId: string;
  selectedScopeKind: 'project-channel' | 'working-group-channel' | 'direct-message';
  selectedWorkingGroupId?: string | undefined;
  selectedDirectMessagePeerId?: string | undefined;
  selectedTaskId?: string | undefined;
  selectedEnvironmentId?: string | undefined;
  selectedAgentId?: string | undefined;
  returnContext?: ReturnContext | null | undefined;
  activeDialog?: ActiveDialog | null | undefined;
  usageFilter: {
    tab: 'run' | 'task' | 'project' | 'agent' | 'model' | 'time';
    timeRange: 'today' | '7d' | '30d' | 'all';
    projectId?: string | undefined;
    agentId?: string | undefined;
    model?: string | undefined;
    selectedActivityId?: string | undefined;
  };
  inspectorSheet: {
    isOpen: boolean;
    kind: 'routing' | 'content-version' | 'run-telemetry' | 'force-release' | 'blocker' | 'validation' | 'none';
    entityId?: string | undefined;
  };
  reviewDrawerOpen: boolean;
  operator: OperatorIdentity;
  settings: OperatorSettingsModel;
  settingsCategoryTab: SettingsCategoryTab;
  projects: ProjectItem[];
  agents: AgentDefinition[];
  environments: EnvironmentInstance[];
  tasks: TaskItem[];
  messages: MessageItem[];
  routingBatches: RoutingBatch[];
  usageActivities: UsageActivity[];
  attentionItems: AttentionItem[];
  activityFeedItems: ActivityFeedItem[];
  scenarioLog: string[];
}

/**
 * Projects retain runs and messages as the source of truth. The Agent detail
 * projects those durable facts instead of relying only on its older summary
 * cache, which can otherwise drift after an Agent is archived.
 */
export function getAgentAttributionHistory(
  state: Pick<PrototypeState, 'projects' | 'tasks' | 'messages'>,
  agent: AgentDefinition
): AgentAttributionRecord[] {
  const records = new Map<string, AgentAttributionRecord>();
  const projectNameFor = (projectId: string) =>
    state.projects.find((project) => project.id === projectId)?.displayName ?? projectId;
  const add = (record: AgentAttributionRecord) => {
    const key = `${record.entityKind}:${record.entityId}`;
    if (!records.has(key)) records.set(key, record);
  };

  state.tasks.forEach((task) => {
    task.runs
      .filter((run) => run.agentId === agent.id)
      .forEach((run) => {
        add({
          id: `run:${run.id}`,
          projectName: projectNameFor(task.projectId),
          projectId: task.projectId,
          entityKind: 'task_run',
          entityId: run.id,
          timestamp: run.settledAt ?? run.startedAt,
          configVersionUsed: run.agentConfigVersionUsed,
          engineUsed: run.engine,
          modelUsed: run.workModel,
          effortUsed: run.effort,
          summary: run.finalAssistantText ?? `Task run for “${task.currentVersion.title}” (${run.lifecycle}).`,
        });
      });
  });

  state.messages
    .filter((message) => message.authorKind === 'agent' && message.authorId === agent.id)
    .forEach((message) => {
      const attribution = message.agentAttribution;
      if (!attribution) return;
      add({
        id: `message:${message.id}`,
        projectName: projectNameFor(message.projectId),
        projectId: message.projectId,
        entityKind: 'message',
        entityId: message.id,
        timestamp: message.timestamp,
        ...attribution,
        summary: message.content,
      });
    });

  (agent.attributionHistory ?? []).forEach(add);
  return [...records.values()];
}

function currentAgentExecutionAttribution(agent: AgentDefinition) {
  const option = agent.workOptions.find((candidate) => candidate.isConfigured) ?? agent.workOptions[0];
  if (!option) return undefined;
  return {
    configVersionUsed: agent.version ?? 1,
    engineUsed: option.engine,
    modelUsed: option.workModel,
    effortUsed: option.effort,
  };
}

// Initial realistic seeded data
const initialOperator: OperatorIdentity = {
  id: 'op-primary',
  name: 'Lead Technical Operator',
  sessionCount: 2,
  connectionState: 'online',
  transport: 'private-overlay',
};

const initialSettings: OperatorSettingsModel = {
  accessBoundary: {
    authenticationState: 'authenticated',
    identityModel: 'single-operator',
    networkBoundary: 'loopback-or-private-network',
    publicExposure: 'unsupported',
    agentCredentialAccess: 'never',
  },
  browserSessions: [
    {
      id: 'browser-session-current',
      deviceLabel: 'Desktop browser',
      browserLabel: 'Current session',
      lastSeen: 'Now',
      transportLabel: 'Private network or loopback',
      state: 'current',
    },
    {
      id: 'browser-session-phone',
      deviceLabel: 'Phone browser',
      browserLabel: 'Safari-like mobile client',
      lastSeen: '12 minutes ago',
      transportLabel: 'Private network',
      state: 'active',
    },
  ],
  credentials: {
    state: 'healthy',
    lastRotated: 'Never in this prototype fixture',
    recoveryOwner: 'host-local',
    hasDefault: false,
    rotationConsequence: 'Host-local recovery or rotation invalidates every other browser session. Agents and Workers never receive this credential.',
  },
  instance: {
    sproutVersion: '0.2.0-m2',
    protocolVersion: 'worker protocol 2.1',
    schemaVersion: 'schema 12',
    supportedSchemaRange: 'schema 11 to 12',
    compatibility: 'compatible',
    compatibilityReason: 'This instance and its enrolled Workers are within the supported protocol and schema range.',
  },
  migration: {
    state: 'warning',
    sourceSchema: 'schema 11',
    targetSchema: 'schema 12',
    safetyCopyState: 'created',
    safetyCopyLabel: 'Local pre-migration safety copy is retained until a later migration succeeds or the host operator removes it.',
    startupBlocked: false,
    hostGuidance: 'Migration runs on the stopped host. Web does not restore, downgrade, or serve partially migrated state.',
  },
  durableData: {
    rootLocation: 'host-local application data root',
    databaseLocation: 'database file under the host-local data root',
    components: ['SQLite database', 'WAL and shared-memory files', 'Migration safety copy', 'Host-local troubleshooting logs'],
    backupBoundary: 'This location is guidance for host-managed backup. It is not a Web backup or restore workflow.',
    copyState: 'idle',
  },
  diagnostics: {
    state: 'ready',
    lastExport: 'Not exported in this prototype fixture',
    includedFacts: ['Sprout, Worker, protocol, and schema versions', 'Migration outcome and timestamps', 'Connection, compatibility, readiness, Task, run, lease, and recovery facts', 'Durable correlation identifiers'],
    excludedFacts: ['Credentials, tokens, account identity, hostnames, network addresses, absolute paths', 'Message content, prompts, private reasoning, commands, tool output, and raw stderr'],
    hostFallback: 'If Web is unavailable, run the host-local diagnostic command in the Sprout user session. It checks service registration, durable-data access, Worker state, reachability, and engine readiness.',
  },
  boundaries: {
    webRoutineOperations: ['Inspect health and compatibility', 'Manage Projects, Agents, Tasks, Messages, and leases', 'Approve or revoke Environment enrollment', 'Inspect diagnostics and choose normal recovery outcomes'],
    hostLocalAdministration: ['Install, update, or remove Sprout and Workers', 'Recover or rotate the operator credential', 'Log Codex or Pi in and out', 'Configure startup, workspace, firewall, private overlay, or Worker identity', 'Run diagnostics while Web is unreachable'],
  },
  stateMatrix: [
    { key: 'normal', label: 'Normal', summary: 'Authenticated operator, compatible instance, current diagnostic export available.' },
    { key: 'loading', label: 'Loading', summary: 'Web is checking compatibility or preparing a sanitized export; no destructive action is assumed.' },
    { key: 'warning', label: 'Warning', summary: 'Migration safety copy is present. This is a migration guard, not a backup system.' },
    { key: 'unavailable', label: 'Unavailable', summary: 'Web cannot reach Sprout. No command is queued offline. Use the host-local fallback.' },
    { key: 'failure', label: 'Failure', summary: 'Safety copy creation or migration failed. Original data remains protected and startup stays blocked.' },
    { key: 'risk', label: 'Risk-bearing', summary: 'Credential rotation revokes other browser sessions and requires host-local recovery if access is lost.' },
  ],
  review: {
    status: 'approved',
    acceptedPatterns: ['Inherited Settings tab keeps the Manage hierarchy and uses the #61 shell, tokens, touch floor, and status language.', 'Primary facts stay visible; migration, diagnostics, and host boundary detail stays on demand.', 'Environment recovery and Force Release remain in Manage > Environments.'],
    rejectedPatterns: ['No Web restart or maintenance control.', 'No backup or restore orchestration, onboarding wizard, multi-Human authorization, or public deployment governance.', 'No candidate dropdown harness controls or flat advanced-settings dashboard.'],
    approvedDecisions: [
      'The Manage > Settings surface uses Access & Security, Instance & System, and Data & Diagnostics as its three operator categories.',
      'Review evidence and state coverage remain available below the categories without becoming a fourth settings category.',
      'The Settings surface keeps Environment recovery and Force Release in Manage > Environments.',
    ],
    artifactPath: 'docs/prototype-settings-operator.md',
  },
};

const initialAgents: AgentDefinition[] = [
  {
    id: 'programmer',
    displayName: 'Programmer',
    avatar: 'PG',
    description: 'Core logic, Three.js game loop, and DOM rendering implementation.',
    standingInstructions: 'Write pure functions where possible; ensure build and verification scripts pass.',
    status: 'active',
    privateMemoryEntriesCount: 26,
    version: 3,
    createdAt: '3 days ago',
    updatedAt: '2 hours ago',
    workOptions: [
      { id: 'opt-pr1', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'high', isConfigured: true },
      { id: 'opt-pr2', engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
      { id: 'opt-pr3', engine: 'opencode', workModel: 'deepseek-coder-v2', effort: 'default', isConfigured: false },
    ],
    versionHistory: [
      {
        version: 3,
        timestamp: '2 hours ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Added opencode deepseek-coder-v2 fallback option and refined testing instructions.',
        optionsCount: 3,
        standingInstructions: 'Write pure functions where possible; ensure build and verification scripts pass.',
      },
      {
        version: 2,
        timestamp: '1 day ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Switched primary engine from Codex to Pi claude-3-5-sonnet for superior spatial reasoning.',
        optionsCount: 2,
        standingInstructions: 'Write pure functions where possible; ensure build passes.',
      },
      {
        version: 1,
        timestamp: '3 days ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Initial Agent configuration created with Codex gpt-4o.',
        optionsCount: 1,
        standingInstructions: 'Build game logic.',
      },
    ],
    attributionHistory: [
      {
        id: 'attr-pr1',
        projectName: 'Minesweeper Three.js Web',
        projectId: 'proj-minesweeper',
        entityKind: 'task_run',
        entityId: 'run-101-1',
        timestamp: '10m ago',
        configVersionUsed: 3,
        engineUsed: 'pi',
        modelUsed: 'claude-3-5-sonnet',
        effortUsed: 'high',
        summary: 'Implemented 3D board mesh generation and texture buffer allocations.',
      },
      {
        id: 'attr-pr2',
        projectName: 'Minesweeper Three.js Web',
        projectId: 'proj-minesweeper',
        entityKind: 'message',
        entityId: 'msg-gen-4',
        timestamp: '25m ago',
        configVersionUsed: 3,
        engineUsed: 'pi',
        modelUsed: 'claude-3-5-sonnet',
        effortUsed: 'high',
        summary: 'Clarified WebGL context loss recovery strategy in #general.',
      },
      {
        id: 'attr-pr3',
        projectName: 'General Data Pipeline',
        projectId: 'proj-data-pipeline',
        entityKind: 'task_run',
        entityId: 'run-92-4',
        timestamp: '2 days ago',
        configVersionUsed: 2,
        engineUsed: 'codex',
        modelUsed: 'gpt-4o',
        effortUsed: 'medium',
        summary: 'Generated parquet compression benchmark scripts.',
      },
    ],
  },
  {
    id: 'planner',
    displayName: 'Planner',
    avatar: 'PL',
    description: 'High-level architecture, task breakdown, and coordination lead.',
    standingInstructions: 'Always verify acceptance criteria before coordinating next steps.',
    status: 'active',
    privateMemoryEntriesCount: 14,
    version: 2,
    createdAt: '4 days ago',
    updatedAt: '1 day ago',
    workOptions: [
      { id: 'opt-p1', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'high', isConfigured: true },
      { id: 'opt-p2', engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
    ],
    versionHistory: [
      {
        version: 2,
        timestamp: '1 day ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Added Codex fallback option with medium effort.',
        optionsCount: 2,
        standingInstructions: 'Always verify acceptance criteria before coordinating next steps.',
      },
      {
        version: 1,
        timestamp: '4 days ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Initial Planner agent setup with Pi claude-3-5-sonnet.',
        optionsCount: 1,
      },
    ],
    attributionHistory: [
      {
        id: 'attr-p1',
        projectName: 'Minesweeper Three.js Web',
        projectId: 'proj-minesweeper',
        entityKind: 'task_run',
        entityId: 'run-102-1',
        timestamp: '1 hour ago',
        configVersionUsed: 2,
        engineUsed: 'pi',
        modelUsed: 'claude-3-5-sonnet',
        effortUsed: 'high',
        summary: 'Formulated audio synthesis sprint breakdown.',
      },
    ],
  },
  {
    id: 'designer',
    displayName: 'Designer',
    avatar: 'DS',
    description: 'UI/UX layout, CSS theme variables, and interaction specifications.',
    standingInstructions: 'Prioritize mobile touch targets and clear high-contrast hierarchy.',
    status: 'active',
    privateMemoryEntriesCount: 9,
    version: 2,
    createdAt: '3 days ago',
    updatedAt: '1 day ago',
    workOptions: [
      { id: 'opt-d1', engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
      { id: 'opt-d2', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'default', isConfigured: true },
    ],
    versionHistory: [
      {
        version: 2,
        timestamp: '1 day ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Configured secondary Pi fallback option.',
        optionsCount: 2,
      },
    ],
    attributionHistory: [],
  },
  {
    id: 'reviewer',
    displayName: 'Reviewer',
    avatar: 'RV',
    description: 'Browser verification, regression tests, and acceptance audits.',
    standingInstructions: 'Run headless browser verification and check console error logs.',
    status: 'active',
    privateMemoryEntriesCount: 18,
    version: 2,
    createdAt: '3 days ago',
    updatedAt: '2 days ago',
    workOptions: [
      { id: 'opt-r1', engine: 'codex', workModel: 'gpt-4o', effort: 'high', isConfigured: true },
      { id: 'opt-r2', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'medium', isConfigured: true },
    ],
    versionHistory: [
      {
        version: 2,
        timestamp: '2 days ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Added Pi claude-3-5-sonnet validation fallback.',
        optionsCount: 2,
      },
    ],
    attributionHistory: [],
  },
  {
    id: 'researcher',
    displayName: 'Researcher',
    avatar: 'RS',
    description: 'WebGL profiling, GPU buffer optimization, and browser benchmarks.',
    standingInstructions: 'Profile frametime bottlenecks and report GPU draw call telemetry.',
    status: 'active',
    privateMemoryEntriesCount: 7,
    version: 1,
    createdAt: '2 days ago',
    updatedAt: '2 days ago',
    workOptions: [
      { id: 'opt-rs1', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'medium', isConfigured: true },
      { id: 'opt-rs2', engine: 'agy', workModel: 'gemini-1.5-pro', effort: 'default', isConfigured: true },
    ],
    versionHistory: [
      {
        version: 1,
        timestamp: '2 days ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Initial profile researcher agent definition.',
        optionsCount: 2,
      },
    ],
    attributionHistory: [],
  },
  {
    id: 'sentinel',
    displayName: 'Sentinel',
    avatar: 'ST',
    description: 'Automated container sandbox validator and compiler regression watcher.',
    standingInstructions: 'Audit compilation memory footprints and binary symbol visibility.',
    status: 'active',
    privateMemoryEntriesCount: 3,
    version: 1,
    createdAt: '1 day ago',
    updatedAt: '1 day ago',
    workOptions: [
      { id: 'opt-st1', engine: 'opencode', workModel: 'deepseek-coder-v2', effort: 'high', isConfigured: false },
    ],
    versionHistory: [
      {
        version: 1,
        timestamp: '1 day ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Setup sentinel compiler audit agent requiring opencode engine.',
        optionsCount: 1,
      },
    ],
    attributionHistory: [],
  },
  {
    id: 'legacy-coder',
    displayName: 'Legacy Coder (Archived)',
    avatar: 'LC',
    description: 'Former prototype engine coordinator retired after M1 architectural transition.',
    standingInstructions: 'Preserved standing instructions from M1 sprint.',
    status: 'archived',
    privateMemoryEntriesCount: 12,
    version: 1,
    createdAt: '2 weeks ago',
    updatedAt: '1 week ago',
    workOptions: [
      { id: 'opt-lc1', engine: 'codex', workModel: 'gpt-4o-mini', effort: 'low', isConfigured: true },
    ],
    versionHistory: [
      {
        version: 1,
        timestamp: '2 weeks ago',
        author: 'Lead Technical Operator',
        changeSummary: 'Legacy M1 agent setup.',
        optionsCount: 1,
      },
    ],
    attributionHistory: [
      {
        id: 'attr-lc1',
        projectName: 'Minesweeper Three.js Web',
        projectId: 'proj-minesweeper',
        entityKind: 'task_run',
        entityId: 'run-88-1',
        timestamp: '1 week ago',
        configVersionUsed: 1,
        engineUsed: 'codex',
        modelUsed: 'gpt-4o-mini',
        effortUsed: 'low',
        summary: 'Initial canvas boilerplates and random seed generation during M1 sprint.',
      },
    ],
  },
];

const initialEnvironments: EnvironmentInstance[] = [
  {
    id: 'env-ready',
    displayName: 'Ready Environment',
    platform: 'macos',
    hostUser: 'local user context',
    trafficLight: 'green',
    trafficLightReason: 'All capabilities permitted · Engines authenticated · Lease held by Task #101',
    enrollmentStatus: 'approved',
    workerIdentityKey: 'identity-withheld',
    connectionState: 'online',
    lastConfirmedTime: '10s ago',
    connectionAgeSec: 10,
    protocolCompatibility: 'compatible',
    protocolVersion: 'v2.1',
    capabilityPermissions: {
      fileReadWrite: true,
      processExecution: true,
      networkAccess: true,
      guiAutomation: false,
    },
    engineReadiness: {
      codex: 'ready',
      pi: 'ready',
      agy: 'ready',
      opencode: 'ready',
    },
    engineDetails: {
      codex: { version: 'v0.18.2', authStatus: 'authenticated', modelAvailability: 'gpt-4o, gpt-4o-mini', notes: 'Readiness confirmed on worker' },
      pi: { version: 'v0.3.1', authStatus: 'authenticated', modelAvailability: 'claude-3-5-sonnet', notes: 'Readiness confirmed on worker' },
      agy: { version: 'v1.4.0', authStatus: 'authenticated', modelAvailability: 'gemini-1.5-pro', notes: 'Config hook installed' },
      opencode: { version: 'v0.8.0', authStatus: 'authenticated', modelAvailability: 'deepseek-coder-v2', notes: 'Local harness ready' },
    },
    workSafety: 'clear',
    workspaceRoots: ['workspace-root'],
    activeLeaseHolder: {
      holderKind: 'task',
      holderId: 'task-101',
      projectId: 'proj-minesweeper',
      acquiredAt: '18m ago',
      taskTitle: 'Implement 3D Board Grid & Click Reveal Logic',
      leadAgentName: 'Programmer',
    },
    probeHistory: [
      { id: 'pr-ready-1', timestamp: '10s ago', latencyMs: 14, protocolOk: true, enginesOk: true, capabilitiesOk: true, summary: 'Readiness probe confirmed: 4 engines ready, TLS/WSS latency 14ms' },
      { id: 'pr-ready-2', timestamp: '5m ago', latencyMs: 16, protocolOk: true, enginesOk: true, capabilitiesOk: true, summary: 'Periodic heartbeat confirmed: Protocol v2.1 compatible' },
    ],
  },
  {
    id: 'env-recovery',
    displayName: 'Recovery Environment',
    platform: 'windows',
    hostUser: 'local user context',
    trafficLight: 'red',
    trafficLightReason: 'Worker offline for 14 minutes · Lease recovery required (interrupted run #206)',
    enrollmentStatus: 'approved',
    workerIdentityKey: 'identity-withheld',
    connectionState: 'offline',
    lastConfirmedTime: '14m ago',
    connectionAgeSec: 840,
    protocolCompatibility: 'compatible',
    protocolVersion: 'v2.1',
    capabilityPermissions: {
      fileReadWrite: true,
      processExecution: true,
      networkAccess: true,
      guiAutomation: true,
    },
    engineReadiness: {
      codex: 'login-required',
      pi: 'ready',
      agy: 'missing',
      opencode: 'unknown',
    },
    engineDetails: {
      codex: { version: 'v0.18.2', authStatus: 'login-required', modelAvailability: 'gpt-4o', notes: 'Interactive readiness step required' },
      pi: { version: 'v0.3.1', authStatus: 'authenticated', modelAvailability: 'claude-3-5-sonnet', notes: 'Readiness confirmed on worker' },
      agy: { version: 'missing', authStatus: 'uninstalled', modelAvailability: 'none', notes: 'Not installed on host' },
      opencode: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown', notes: 'Host worker unprobed' },
    },
    workSafety: 'recovery',
    workspaceRoots: ['workspace-root'],
    activeLeaseHolder: {
      holderKind: 'task',
      holderId: 'task-104',
      projectId: 'proj-minesweeper',
      acquiredAt: '45m ago',
      taskTitle: 'Refactor Particle Explode Shader for Loss Animation',
      leadAgentName: 'Programmer',
    },
    leaseRecovery: {
      cause: 'Worker process terminated unexpectedly during active nested Agent run #206',
      interruptedRunId: 'run-206',
      interruptedRunAgent: 'Programmer',
      unresolvedFacts: [
        'Host worker offline: engine process stop cannot be confirmed over carrier',
        'Temporary task scratch context directory unrecycled on worker host',
        'Settlement telemetry uncollected for last 2 turns of turn execution',
      ],
    },
    probeHistory: [
      { id: 'pr-recovery-1', timestamp: '14m ago', latencyMs: 320, protocolOk: true, enginesOk: false, capabilitiesOk: true, summary: 'Probe failed: Connection timed out after 320ms' },
      { id: 'pr-recovery-2', timestamp: '45m ago', latencyMs: 24, protocolOk: true, enginesOk: true, capabilitiesOk: true, summary: 'Probe confirmed: All harnesses online prior to disconnect' },
    ],
  },
  {
    id: 'env-pending',
    displayName: 'Pending Environment',
    platform: 'macos',
    hostUser: 'local user context',
    trafficLight: 'yellow',
    trafficLightReason: 'Pending enrollment approval by operator · Worker identity verified',
    enrollmentStatus: 'pending',
    workerIdentityKey: 'identity-withheld',
    connectionState: 'reconnecting',
    lastConfirmedTime: 'Just now',
    connectionAgeSec: 2,
    protocolCompatibility: 'compatible',
    protocolVersion: 'v2.1',
    capabilityPermissions: {
      fileReadWrite: true,
      processExecution: true,
      networkAccess: false,
      guiAutomation: false,
    },
    engineReadiness: {
      codex: 'ready',
      pi: 'ready',
      agy: 'unknown',
      opencode: 'unknown',
    },
    engineDetails: {
      codex: { version: 'v0.18.2', authStatus: 'authenticated', modelAvailability: 'gpt-4o', notes: 'CLI session verified' },
      pi: { version: 'v0.3.1', authStatus: 'authenticated', modelAvailability: 'claude-3-5-sonnet', notes: 'CLI session verified' },
      agy: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown' },
      opencode: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown' },
    },
    workSafety: 'clear',
    workspaceRoots: ['workspace-root'],
    probeHistory: [
      { id: 'pr-pending-1', timestamp: 'Just now', latencyMs: 12, protocolOk: true, enginesOk: true, capabilitiesOk: true, summary: 'Bootstrap enrollment probe: Worker identity verified over private transport' },
    ],
  },
  {
    id: 'env-degraded',
    displayName: 'Degraded Environment',
    platform: 'container',
    hostUser: 'local user context',
    trafficLight: 'yellow',
    trafficLightReason: 'Degraded · Codex engine login required · GUI automation unavailable',
    enrollmentStatus: 'approved',
    workerIdentityKey: 'identity-withheld',
    connectionState: 'online',
    lastConfirmedTime: '45s ago',
    connectionAgeSec: 45,
    protocolCompatibility: 'compatible',
    protocolVersion: 'v2.1',
    capabilityPermissions: {
      fileReadWrite: true,
      processExecution: true,
      networkAccess: true,
      guiAutomation: false,
    },
    engineReadiness: {
      codex: 'login-required',
      pi: 'ready',
      agy: 'ready',
      opencode: 'ready',
    },
    engineDetails: {
      codex: { version: 'v0.18.2', authStatus: 'login-required', modelAvailability: 'gpt-4o', notes: 'Interactive readiness step required' },
      pi: { version: 'v0.3.1', authStatus: 'authenticated', modelAvailability: 'claude-3-5-sonnet', notes: 'Readiness confirmed on worker' },
      agy: { version: 'v1.4.0', authStatus: 'authenticated', modelAvailability: 'gemini-1.5-flash', notes: 'Local CLI ready' },
      opencode: { version: 'v0.8.0', authStatus: 'authenticated', modelAvailability: 'deepseek-coder-v2', notes: 'Local model weights cached' },
    },
    workSafety: 'clear',
    workspaceRoots: ['workspace-root'],
    probeHistory: [
      { id: 'pr-degraded-1', timestamp: '45s ago', latencyMs: 8, protocolOk: true, enginesOk: false, capabilitiesOk: true, summary: 'Probe degraded: Codex requires an interactive readiness step' },
    ],
  },
  {
    id: 'env-incompatible',
    displayName: 'Incompatible Environment',
    platform: 'macos',
    hostUser: 'local user context',
    trafficLight: 'red',
    trafficLightReason: 'Protocol incompatible: worker protocol v1.8 is below required v2.0+',
    enrollmentStatus: 'approved',
    workerIdentityKey: 'identity-withheld',
    connectionState: 'online',
    lastConfirmedTime: '1m ago',
    connectionAgeSec: 60,
    protocolCompatibility: 'incompatible',
    protocolVersion: 'v1.8',
    protocolMismatchDetail: 'Worker protocol v1.8 is outdated. Update Sprout worker binary on host to v2.1+ to enable Task admission.',
    capabilityPermissions: {
      fileReadWrite: true,
      processExecution: true,
      networkAccess: false,
      guiAutomation: false,
    },
    engineReadiness: {
      codex: 'ready',
      pi: 'ready',
      agy: 'unknown',
      opencode: 'unknown',
    },
    engineDetails: {
      codex: { version: 'v0.16.0', authStatus: 'authenticated', modelAvailability: 'gpt-4o', notes: 'Older harness' },
      pi: { version: 'v0.2.8', authStatus: 'authenticated', modelAvailability: 'claude-3-5-sonnet', notes: 'Older harness' },
      agy: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown' },
      opencode: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown' },
    },
    workSafety: 'clear',
    workspaceRoots: ['workspace-root'],
    probeHistory: [
      { id: 'pr-incompatible-1', timestamp: '1m ago', latencyMs: 16, protocolOk: false, enginesOk: true, capabilitiesOk: true, summary: 'Probe incompatible: Protocol version mismatch (v1.8 < v2.0)' },
    ],
  },
  {
    id: 'env-archived',
    displayName: 'Archived Environment',
    platform: 'windows',
    hostUser: 'local user context',
    trafficLight: 'yellow',
    trafficLightReason: 'Archived instance · Enrollment preserved · No active work admitted',
    enrollmentStatus: 'archived',
    workerIdentityKey: 'identity-withheld',
    connectionState: 'offline',
    lastConfirmedTime: '3d ago',
    connectionAgeSec: 259200,
    protocolCompatibility: 'compatible',
    protocolVersion: 'v2.0',
    capabilityPermissions: {
      fileReadWrite: true,
      processExecution: true,
      networkAccess: true,
      guiAutomation: true,
    },
    engineReadiness: {
      codex: 'ready',
      pi: 'ready',
      agy: 'ready',
      opencode: 'ready',
    },
    workSafety: 'clear',
    workspaceRoots: ['workspace-root'],
    probeHistory: [
      { id: 'pr-arch-1', timestamp: '3d ago', latencyMs: 22, protocolOk: true, enginesOk: true, capabilitiesOk: true, summary: 'Last probe before archive: all clear' },
    ],
  },
];

const initialProjects: ProjectItem[] = [
  {
    id: 'proj-minesweeper',
    displayName: 'Three.js Minesweeper Game',
    templateSource: 'General collaboration template v1.0',
    createdAt: '2 days ago',
    goal: 'Build a browser-playable Three.js 3D Minesweeper game with interactive reveal, flag counter, and win/loss animations.',
    rules: [
      'Pure ES modules; Three.js imported via CDN bundle.',
      'Maintain separate game state logic from 3D scene rendering.',
      'Human must validate all completion claims with headless browser script verification.',
    ],
    completionGuidance: 'Verified in headless Chromium with zero console errors and 100% test pass.',
    wakePolicy: 'wake-model-assisted',
    batchCollectionIntervalSec: 30,
    status: 'active',
    memberships: [
      {
        memberId: 'op-primary',
        memberKind: 'human',
        displayName: 'Operator (Human)',
        avatar: "OP",
        responsibilities: 'Final task approval, validation, recovery, and scope changes.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'planner',
        memberKind: 'agent',
        displayName: 'Planner',
        avatar: "PL",
        responsibilities: 'Roadmap planning, task coordination, task proposal formulation.',
        collaborationInstructions: 'Break tasks down into verifiable slices under 5 minutes duration.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'designer',
        memberKind: 'agent',
        displayName: 'Designer',
        avatar: "DS",
        responsibilities: 'Color palette, 3D mesh geometry styles, mobile touch controls.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'programmer',
        memberKind: 'agent',
        displayName: 'Programmer',
        avatar: "PG",
        responsibilities: 'Board data structures, tile reveal recursion, mine placement algorithm.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'reviewer',
        memberKind: 'agent',
        displayName: 'Reviewer',
        avatar: "RV",
        responsibilities: 'Headless browser testing, DOM verification, error detection.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'researcher',
        memberKind: 'agent',
        displayName: 'Researcher',
        avatar: "RS",
        responsibilities: 'WebGL performance profiling and browser compatibility benchmarks.',
        joinedAt: '2 days ago',
        status: 'ended',
      },
    ],
    boundEnvironmentWorkspaces: [
      {
        environmentId: 'env-ready',
        workspaceRoot: 'workspace-root',
        relativeWorkspacePath: 'minesweeper-threejs',
        isPrepared: true,
      },
      {
        environmentId: 'env-recovery',
        workspaceRoot: 'workspace-root',
        relativeWorkspacePath: 'minesweeper-threejs',
        isPrepared: true,
      },
    ],
    workingGroups: [
      {
        id: 'wg-mechanics',
        projectId: 'proj-minesweeper',
        displayName: 'Core Mechanics WG',
        goal: 'Tune board cell reveal speed and cascade recursion limits.',
        rules: ['Benchmark tile reveal on 30x16 expert board.'],
        creatorId: 'op-primary',
        memberIds: ['op-primary', 'planner', 'programmer'],
        status: 'active',
        createdAt: '1 day ago',
      },
      {
        id: 'wg-audio',
        projectId: 'proj-minesweeper',
        displayName: 'WebAudio Effects WG (Disbanded)',
        goal: 'Sound effects for tile clicks and explosions.',
        creatorId: 'planner',
        memberIds: ['op-primary', 'designer'],
        status: 'disbanded',
        createdAt: '2 days ago',
      },
    ],
  },
  {
    id: 'proj-unity-sims',
    displayName: 'Unity Room Lighting Prototype',
    templateSource: 'General collaboration template v1.0',
    createdAt: '3 days ago',
    goal: 'Prototype dynamic ray-traced ambient lighting for mobile and desktop room scenes.',
    rules: [
      'Maintain stable 60fps across supported desktop and mobile-capable platforms.',
      'All lighting baking jobs execute on Recovery Environment.',
    ],
    completionGuidance: 'Lightmap artifacts bakes cleanly with zero UV overlap warnings.',
    wakePolicy: 'explicit-only',
    batchCollectionIntervalSec: 30,
    status: 'active',
    memberships: [
      {
        memberId: 'op-primary',
        memberKind: 'human',
        displayName: 'Operator (Human)',
        avatar: 'OP',
        responsibilities: 'Overall direction and bake asset approval.',
        joinedAt: '3 days ago',
        status: 'active',
      },
      {
        memberId: 'programmer',
        memberKind: 'agent',
        displayName: 'Programmer',
        avatar: 'PG',
        responsibilities: 'C# Unity Editor scripts and light probe placement automation.',
        collaborationInstructions: 'Verify Unity Editor compilation before advancing.',
        joinedAt: '3 days ago',
        status: 'active',
      },
      {
        memberId: 'reviewer',
        memberKind: 'agent',
        displayName: 'Reviewer',
        avatar: 'RV',
        responsibilities: 'Shader compilation tests and draw-call performance profiling.',
        joinedAt: '3 days ago',
        status: 'active',
      },
    ],
    boundEnvironmentWorkspaces: [
      {
        environmentId: 'env-recovery',
        workspaceRoot: 'workspace-root',
        relativeWorkspacePath: 'unity-lighting-system',
        isPrepared: true,
      },
    ],
    workingGroups: [
      {
        id: 'wg-raytracing',
        projectId: 'proj-unity-sims',
        displayName: 'Raytracing Shaders WG',
        goal: 'Optimize compute shader dispatch grid.',
        creatorId: 'op-primary',
        memberIds: ['op-primary', 'programmer'],
        status: 'active',
        createdAt: '2 days ago',
      },
    ],
  },
  {
    id: 'proj-docs-portal',
    displayName: 'Operator Architecture Docs Portal',
    templateSource: 'General collaboration template v1.0',
    createdAt: '5 days ago',
    goal: 'Author and verify static Markdown architecture guidelines for Sprout M2.',
    rules: ['Adhere strictly to ADR decisions and CONTEXT.md definitions.'],
    completionGuidance: 'All cross-references link to valid repository docs.',
    wakePolicy: 'explicit-only',
    batchCollectionIntervalSec: 30,
    status: 'archived',
    memberships: [
      {
        memberId: 'op-primary',
        memberKind: 'human',
        displayName: 'Operator (Human)',
        avatar: 'OP',
        responsibilities: 'Architecture review and final acceptance.',
        joinedAt: '5 days ago',
        status: 'active',
      },
      {
        memberId: 'designer',
        memberKind: 'agent',
        displayName: 'Designer',
        avatar: 'DS',
        responsibilities: 'Mermaid diagram layout and document styling.',
        joinedAt: '5 days ago',
        status: 'active',
      },
    ],
    boundEnvironmentWorkspaces: [
      {
        environmentId: 'env-ready',
        workspaceRoot: 'workspace-root',
        relativeWorkspacePath: 'docs-portal',
        isPrepared: true,
      },
    ],
    workingGroups: [],
  },
];

const initialTasks: TaskItem[] = [
  {
    id: 'task-101',
    projectId: 'proj-minesweeper',
    proposerId: 'planner',
    proposerKind: 'agent',
    createdAt: '35m ago',
    selectedEnvironmentId: 'env-ready',
    taskLeadId: 'programmer',
    lifecycle: 'awaiting validation',
    agentRunLifecycle: 'completed',
    leaseLifecycle: 'held',
    activeRunId: 'run-204',
    currentVersion: {
      version: 1,
      createdAt: '35m ago',
      createdBy: 'Planner (Agent proposal approved by Operator)',
      title: 'Implement 3D Board Grid & Click Reveal Logic',
      goal: 'Construct 3D tile meshes in Three.js and connect raycaster pointer events to reveal adjacent empty cells.',
      constraints: [
        'Do not allocate memory inside the animation render loop.',
        'Use raycasting with touch event coordinates for mobile support.',
      ],
      validationCriteria: [
        'Browser script triggers click on (0,0) and verifies cell texture changes.',
        'Zero uncaught exceptions in console log.',
      ],
      taskLeadId: 'programmer',
    },
    historyVersions: [],
    pendingCompletionClaim: {
      id: 'claim-101',
      submittedAt: '3m ago',
      submittedByLeadId: 'programmer',
      contentVersion: 1,
      outcomeSummary: '3D board grid, Raycaster pointer detection, recursive reveal algorithm, and mobile touch events implemented and verified.',
      validationEvidence: 'scripts/verify-o7-minesweeper-browser.ts ran 14 assertion checks with 100% pass.',
      durableChanges: [
        'templates/o7-minesweeper/src/main.js',
        'templates/o7-minesweeper/src/board.js',
        'templates/o7-minesweeper/index.html',
      ],
      knownLimitations: 'Flagging tiles currently requires double-tap gesture on mobile; long-press gesture not yet configured.',
      recommendedDisposition: 'completed',
    },
    runs: [
      {
        id: 'run-203',
        taskId: 'task-101',
        agentId: 'programmer',
        agentDisplayName: 'Programmer',
        engine: 'pi',
        workModel: 'claude-3-5-sonnet',
        effort: 'high',
        agentConfigVersionUsed: 3,
        contentVersionUsed: 1,
        lifecycle: 'completed',
        startedAt: '32m ago',
        settledAt: '28m ago',
        wallDurationMs: 142000,
        tokenUsage: {
          status: 'complete',
          uncachedInput: 18400,
          cachedReads: 32000,
          cacheWrite: 4200,
          output: 6800,
          reasoningOutput: 2400,
          total: 61400,
        },
        monetaryCost: {
          attributableBilledCostStatus: 'unavailable',
          apiEquivalentStatus: 'available',
          estimatedUsdMicros: 142000,
          provenance: 'harness_calculated',
          billingBasis: 'metered_api',
        },
        events: [
          { time: '32m ago', kind: 'status_change', summary: 'Run admitted on env-ready using Task-held lease' },
          { time: '31m ago', kind: 'tool_call', summary: 'read templates/o7-minesweeper/src/main.js' },
          { time: '30m ago', kind: 'tool_call', summary: 'edit templates/o7-minesweeper/src/board.js' },
          { time: '28m ago', kind: 'text_delta', summary: 'Implemented raycaster touch handler.' },
        ],
        finalAssistantText: 'Board grid and click reveal mechanics updated. Ready for verification run.',
      },
      {
        id: 'run-204',
        taskId: 'task-101',
        agentId: 'reviewer',
        agentDisplayName: 'Reviewer',
        engine: 'codex',
        workModel: 'gpt-4o',
        effort: 'high',
        agentConfigVersionUsed: 2,
        contentVersionUsed: 1,
        lifecycle: 'completed',
        startedAt: '12m ago',
        settledAt: '3m ago',
        wallDurationMs: 98000,
        tokenUsage: {
          status: 'complete',
          uncachedInput: 12100,
          cachedReads: 24500,
          cacheWrite: 0,
          output: 4100,
          reasoningOutput: 1200,
          total: 41900,
        },
        monetaryCost: {
          attributableBilledCostStatus: 'unavailable',
          apiEquivalentStatus: 'available',
          estimatedUsdMicros: 89000,
          provenance: 'provider_estimated',
          billingBasis: 'metered_api',
        },
        events: [
          { time: '12m ago', kind: 'status_change', summary: 'Sequential review run initiated autonomously by Lead Programmer' },
          { time: '10m ago', kind: 'tool_call', summary: 'bash npm run verify:o7-game-browser' },
          { time: '4m ago', kind: 'tool_output', summary: 'Playwright verified 14/14 tests passed.' },
          { time: '3m ago', kind: 'text_delta', summary: 'Submitting Task Completion Claim for Human validation.' },
        ],
        finalAssistantText: 'Verification passed with zero console errors. Submitted completion claim for operator review.',
      },
    ],
  },
  {
    id: 'task-102',
    projectId: 'proj-minesweeper',
    proposerId: 'op-primary',
    proposerKind: 'human',
    createdAt: '15m ago',
    selectedEnvironmentId: 'env-ready',
    taskLeadId: 'designer',
    lifecycle: 'active',
    agentRunLifecycle: 'running',
    leaseLifecycle: 'held',
    activeRunId: 'run-205',
    currentVersion: {
      version: 1,
      createdAt: '15m ago',
      createdBy: 'Operator (Human)',
      title: 'Responsive HUD & Mobile Touch Controls',
      goal: 'Implement clean high-contrast flag counter HUD and mobile pinch-to-zoom controls.',
      constraints: ['Buttons must have minimum 44px touch bounding box.'],
      validationCriteria: ['Inspectable on iPhone 390px viewport width.'],
      taskLeadId: 'designer',
    },
    historyVersions: [],
    runs: [
      {
        id: 'run-205',
        taskId: 'task-102',
        agentId: 'designer',
        agentDisplayName: 'Designer',
        engine: 'codex',
        workModel: 'gpt-4o',
        effort: 'medium',
        agentConfigVersionUsed: 2,
        contentVersionUsed: 1,
        lifecycle: 'running',
        startedAt: '2m ago',
        events: [
          { time: '2m ago', kind: 'status_change', summary: 'Run admitted under Task-held lease on env-ready' },
          { time: '1m ago', kind: 'tool_call', summary: 'read templates/o7-minesweeper/src/style.css' },
          { time: 'Just now', kind: 'text_delta', summary: 'Structuring responsive HUD container CSS.' },
        ],
      },
    ],
  },
  {
    id: 'task-103',
    projectId: 'proj-minesweeper',
    proposerId: 'planner',
    proposerKind: 'agent',
    createdAt: '1 hour ago',
    selectedEnvironmentId: 'env-ready',
    taskLeadId: 'programmer',
    lifecycle: 'blocked',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'held',
    currentVersion: {
      version: 1,
      createdAt: '1 hour ago',
      createdBy: 'Planner (Agent)',
      title: 'Spatial Audio Explosion Synthesis',
      goal: 'Integrate WebAudio positional panner node for 3D explosion sound effects.',
      constraints: ['Audio context must resume on first touch interaction.'],
      validationCriteria: ['Audio buffer plays cleanly without click artifacts.'],
      taskLeadId: 'programmer',
    },
    historyVersions: [],
    activeBlocker: {
      id: 'blocker-103',
      reason: 'Audio asset directory requires operator uncompress permission on env-ready.',
      requiredNextAction: 'Operator must grant folder extraction capability or provide sample assets.',
      responsibleActor: 'Operator (Human)',
      whoAdvancesWhenCleared: 'Lead Programmer (Agent)',
      createdAt: '40m ago',
    },
    runs: [],
  },
  {
    id: 'task-104',
    projectId: 'proj-minesweeper',
    proposerId: 'planner',
    proposerKind: 'agent',
    createdAt: '50m ago',
    selectedEnvironmentId: 'env-recovery',
    taskLeadId: 'programmer',
    lifecycle: 'recovery',
    agentRunLifecycle: 'interrupted',
    leaseLifecycle: 'recovering',
    recoveryReason: 'Worker connection lost mid-turn. Environment entered recovery.',
    currentVersion: {
      version: 1,
      createdAt: '50m ago',
      createdBy: 'Planner',
      title: 'DirectX 12 Shader Compilation Pipeline',
      goal: 'Precompile HLSL shaders on the worker host for native performance comparison.',
      constraints: ['Must compile cleanly with dxc.exe.'],
      validationCriteria: ['Shader bytecode verified.'],
      taskLeadId: 'programmer',
    },
    historyVersions: [],
    runs: [
      {
        id: 'run-206',
        taskId: 'task-104',
        agentId: 'programmer',
        agentDisplayName: 'Programmer',
        engine: 'codex',
        workModel: 'gpt-4o',
        effort: 'high',
        agentConfigVersionUsed: 3,
        contentVersionUsed: 1,
        lifecycle: 'interrupted',
        startedAt: '48m ago',
        settledAt: '14m ago',
        interruptionReason: 'Worker channel lost while Codex process was running on the worker host.',
        events: [
          { time: '48m ago', kind: 'status_change', summary: 'Run started' },
          { time: '46m ago', kind: 'tool_call', summary: 'bash dxc.exe -T ps_6_0 shader.hlsl' },
          { time: '14m ago', kind: 'status_change', summary: 'INTERRUPTED: Worker disconnected unexpectedly' },
        ],
      },
    ],
  },
  {
    id: 'task-105-prop',
    projectId: 'proj-minesweeper',
    proposerId: 'planner',
    proposerKind: 'agent',
    createdAt: '10m ago',
    taskLeadId: 'designer',
    lifecycle: 'proposed',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'none',
    currentVersion: {
      version: 1,
      createdAt: '10m ago',
      createdBy: 'Planner (Agent Proposal)',
      title: 'Particle Fireworks Animation on Game Victory',
      goal: 'Spawn 500 celebratory 3D particles when all non-mine tiles are revealed.',
      constraints: ['Particle count must scale down smoothly on low-power mobile devices.'],
      validationCriteria: ['FPS stays above 55 during win animation.'],
      taskLeadId: 'designer',
    },
    historyVersions: [],
    runs: [],
  },
  {
    id: 'task-106-prop',
    projectId: 'proj-minesweeper',
    proposerId: 'designer',
    proposerKind: 'agent',
    createdAt: '8m ago',
    taskLeadId: 'programmer',
    lifecycle: 'proposed',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'none',
    currentVersion: {
      version: 1,
      createdAt: '8m ago',
      createdBy: 'Designer (Agent Proposal)',
      title: 'Spatial Audio Reverb Engine Integration',
      goal: 'Implement custom impulse response convolution filters for cavern sound ambiance.',
      constraints: ['Fall back gracefully on devices without WebAudio convolution support.'],
      validationCriteria: ['Impulse response loads asynchronously in under 50ms.'],
      taskLeadId: 'programmer',
    },
    historyVersions: [],
    runs: [],
  },
  {
    id: 'task-201',
    projectId: 'proj-unity-sims',
    proposerId: 'op-primary',
    proposerKind: 'human',
    createdAt: '1 hour ago',
    selectedEnvironmentId: 'env-recovery',
    taskLeadId: 'programmer',
    lifecycle: 'proposed',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'none',
    currentVersion: {
      version: 1,
      createdAt: '1 hour ago',
      createdBy: 'Operator (Human)',
      title: 'Bake Progressive Lightmaps for Room Scene',
      goal: 'Generate 2048x2048 progressive GPU lightmaps on Recovery Environment.',
      constraints: ['DirectX 12 backend with RTX acceleration.'],
      validationCriteria: ['Zero dark spot artifacts in corner probe samples.'],
      taskLeadId: 'programmer',
    },
    historyVersions: [],
    runs: [],
  },
  {
    id: 'task-301',
    projectId: 'proj-docs-portal',
    proposerId: 'op-primary',
    proposerKind: 'human',
    createdAt: '4 days ago',
    selectedEnvironmentId: 'env-ready',
    taskLeadId: 'designer',
    lifecycle: 'completed',
    agentRunLifecycle: 'completed',
    leaseLifecycle: 'released',
    currentVersion: {
      version: 1,
      createdAt: '4 days ago',
      createdBy: 'Operator (Human)',
      title: 'Publish Operator Architecture Guidelines v1.0',
      goal: 'Compile all ADR decisions into searchable single-context documentation.',
      constraints: ['100% accurate ADR cross-references.'],
      validationCriteria: ['All internal markdown links verified.'],
      taskLeadId: 'designer',
    },
    historyVersions: [],
    runs: [],
  },
];

const initialMessages: MessageItem[] = [
  {
    id: 'msg-1',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: "Operator (Human)", authorAvatar: "OP",
    timestamp: '35m ago',
    content: '@all Let us review the Three.js board mechanics and make sure touch coordinates map accurately.',
    disposition: 'addressed',
    routingCausalChainId: 'batch-001',
  },
  {
    id: 'msg-2',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'planner',
    authorKind: 'agent',
    authorDisplayName: "Planner", authorAvatar: "PL",
    timestamp: '34m ago',
    content: 'Task #101 has been initiated with Programmer as lead to connect raycasting pointer events.',
    disposition: 'non-routing',
    agentAttribution: { configVersionUsed: 2, engineUsed: 'pi', modelUsed: 'claude-3-5-sonnet', effortUsed: 'high' },
    isProjectedReply: true,
    projectedReplyMeta: {
      runId: 'run-201',
      agentId: 'planner',
      wakeRequestId: 'wake-01',
      triggeringMessageIds: ['msg-1'],
    },
    routingCausalChainId: 'batch-001',
  },
  {
    id: 'msg-3',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: "Operator (Human)", authorAvatar: "OP",
    timestamp: '25m ago',
    content: 'The shader lighting looks slightly dark on standard sRGB displays.',
    disposition: 'wake-eligible',
    routingCausalChainId: 'batch-002',
  },
  {
    id: 'msg-4',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'designer',
    authorKind: 'agent',
    authorDisplayName: "Designer", authorAvatar: "DS",
    timestamp: '24m ago',
    content: 'I have adjusted the ambient light intensity in CSS/canvas configuration to 1.4 for crisp visibility.',
    disposition: 'non-routing',
    agentAttribution: { configVersionUsed: 2, engineUsed: 'codex', modelUsed: 'gpt-4o', effortUsed: 'medium' },
    isProjectedReply: true,
    projectedReplyMeta: {
      runId: 'run-202',
      agentId: 'designer',
      wakeRequestId: 'wake-02',
      triggeringMessageIds: ['msg-3'],
    },
    routingCausalChainId: 'batch-002',
  },
  {
    id: 'msg-suppressed-1',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: "Operator (Human)", authorAvatar: "OP",
    timestamp: '18m ago',
    content: 'Nice weather today for building 3D games!',
    disposition: 'wake-eligible',
    routingCausalChainId: 'batch-003',
  },
  {
    id: 'msg-failed-1',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: "Operator (Human)", authorAvatar: "OP",
    timestamp: '14m ago',
    content: 'Please evaluate GPU fallback behavior on legacy Intel Iris GPUs.',
    disposition: 'wake-eligible',
    routingCausalChainId: 'batch-004',
  },
  {
    id: 'msg-open-1',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: "Operator (Human)", authorAvatar: "OP",
    timestamp: '12s ago',
    content: 'We should verify touch event latency on iOS Safari before declaring milestone complete.',
    disposition: 'wake-eligible',
    routingCausalChainId: 'batch-005',
  },
  {
    id: 'msg-5',
    projectId: 'proj-minesweeper',
    scope: { kind: 'working-group-channel', workingGroupId: 'wg-mechanics' },
    authorId: 'programmer',
    authorKind: 'agent',
    authorDisplayName: "Programmer", authorAvatar: "PG",
    timestamp: '18m ago',
    content: 'Cascade recursion tested on 30x16 expert grid: depth 42 reached in under 1.2ms.',
    disposition: 'informational',
    agentAttribution: { configVersionUsed: 3, engineUsed: 'pi', modelUsed: 'claude-3-5-sonnet', effortUsed: 'high' },
  },
  {
    id: 'msg-5b',
    projectId: 'proj-minesweeper',
    scope: { kind: 'working-group-channel', workingGroupId: 'wg-audio' },
    authorId: 'designer',
    authorKind: 'agent',
    authorDisplayName: "Designer", authorAvatar: "DS",
    timestamp: '12m ago',
    content: 'Synthesizer oscillators hooked to user click gestures; audio buffer warm and latency under 5ms.',
    disposition: 'informational',
    agentAttribution: { configVersionUsed: 2, engineUsed: 'codex', modelUsed: 'gpt-4o', effortUsed: 'medium' },
  },
  {
    id: 'msg-6',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'planner' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: "Operator (Human)", authorAvatar: "OP",
    timestamp: '10m ago',
    content: 'Should we schedule Task #105 (Fireworks particle effect) right after validation?',
    disposition: 'addressed',
  },
  {
    id: 'msg-7',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'op-primary' },
    authorId: 'planner',
    authorKind: 'agent',
    authorDisplayName: "Planner", authorAvatar: "PL",
    timestamp: '9m ago',
    content: 'Yes, proposal Task #105 is ready for your Approve-and-Begin decision once Task #101 completes.',
    disposition: 'non-routing',
    agentAttribution: { configVersionUsed: 2, engineUsed: 'pi', modelUsed: 'claude-3-5-sonnet', effortUsed: 'high' },
    isProjectedReply: true,
  },
  {
    id: 'msg-8',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'programmer' },
    authorId: 'programmer',
    authorKind: 'agent',
    authorDisplayName: "Programmer", authorAvatar: "PG",
    timestamp: '6m ago',
    content: 'Lease held on Task #101; awaiting operator review for 3D coordinate mapping verification.',
    disposition: 'addressed',
    agentAttribution: { configVersionUsed: 3, engineUsed: 'pi', modelUsed: 'claude-3-5-sonnet', effortUsed: 'high' },
  },
  {
    id: 'msg-9',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'reviewer' },
    authorId: 'reviewer',
    authorKind: 'agent',
    authorDisplayName: "Reviewer", authorAvatar: "RV",
    timestamp: '4m ago',
    content: 'All unit test suites passing with 100% assertions green on macOS and Ubuntu runners.',
    disposition: 'informational',
    agentAttribution: { configVersionUsed: 2, engineUsed: 'codex', modelUsed: 'gpt-4o', effortUsed: 'high' },
  },
  {
    id: 'msg-10',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'designer' },
    authorId: 'designer',
    authorKind: 'agent',
    authorDisplayName: "Designer", authorAvatar: "DS",
    timestamp: '2m ago',
    content: 'Refined UI tokens and dark mode contrast ratios for high visibility.',
    disposition: 'informational',
    agentAttribution: { configVersionUsed: 2, engineUsed: 'codex', modelUsed: 'gpt-4o', effortUsed: 'medium' },
  },
  {
    id: 'msg-11',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'researcher' },
    authorId: 'researcher',
    authorKind: 'agent',
    authorDisplayName: "Researcher", authorAvatar: "RS",
    timestamp: '1 day ago',
    content: 'Baseline WebGL benchmarks completed: 60fps steady on the ready environment, 45fps on the compatibility environment.',
    disposition: 'informational',
    agentAttribution: { configVersionUsed: 1, engineUsed: 'pi', modelUsed: 'claude-3-5-sonnet', effortUsed: 'medium' },
  },
];

const initialRoutingBatches: RoutingBatch[] = [
  {
    id: 'batch-002',
    projectId: 'proj-minesweeper',
    openedAt: '25m 00s ago',
    closedAt: '24m 30s ago',
    collectionWindowDurationSec: 30,
    inputMessageIds: ['msg-3'],
    status: 'settled',
    attemptsCount: 1,
    attemptsHistory: [
      {
        attemptNumber: 1,
        timestamp: '24m 30s ago',
        wakeModel: 'gpt-4o-mini',
        durationMs: 640,
        status: 'success',
      },
    ],
    wakeModel: 'gpt-4o-mini',
    frozenContextSummary: {
      tokenCount: 1840,
      projectRulesIncluded: true,
      recentMessagesCount: 4,
      tasksSummariesCount: 2,
      truncated: false,
    },
    privacyBoundaryManifest: {
      directMessagesExcluded: true,
      privateMemoryExcluded: true,
      sessionsAndTranscriptsExcluded: true,
      credentialsExcluded: true,
      hostFactsExcluded: true,
      transientEnvCapacityExcluded: true,
    },
    decisions: [
      {
        messageId: 'msg-3',
        targetAgentId: 'designer',
        status: 'selected',
        rationale:
          'Message discusses sRGB shader lighting aesthetics which maps directly to Designer responsibility slot.',
      },
    ],
    resultingWakeRequestIds: ['wake-02'],
    resultingWakeRequests: [
      {
        wakeRequestId: 'wake-02',
        targetAgentId: 'designer',
        admissionStatus: 'admitted',
        linkedRunId: 'run-202',
        projectedReplyId: 'msg-4',
        terminalStatus: 'settled',
        terminalResponsibility: { kind: 'agent', id: 'designer' },
        terminalReason: 'Agent run settled and its projected reply was persisted.',
        terminalTimestamp: '24m 30s ago',
      },
    ],
  },
  {
    id: 'batch-003',
    projectId: 'proj-minesweeper',
    openedAt: '18m 00s ago',
    closedAt: '17m 30s ago',
    collectionWindowDurationSec: 30,
    inputMessageIds: ['msg-suppressed-1'],
    status: 'suppressed',
    attemptsCount: 1,
    attemptsHistory: [
      {
        attemptNumber: 1,
        timestamp: '17m 30s ago',
        wakeModel: 'gpt-4o-mini',
        durationMs: 480,
        status: 'success',
      },
    ],
    wakeModel: 'gpt-4o-mini',
    frozenContextSummary: {
      tokenCount: 1520,
      projectRulesIncluded: true,
      recentMessagesCount: 5,
      tasksSummariesCount: 2,
      truncated: false,
    },
    privacyBoundaryManifest: {
      directMessagesExcluded: true,
      privateMemoryExcluded: true,
      sessionsAndTranscriptsExcluded: true,
      credentialsExcluded: true,
      hostFactsExcluded: true,
      transientEnvCapacityExcluded: true,
    },
    decisions: [
      {
        messageId: 'msg-suppressed-1',
        targetAgentId: undefined,
        status: 'suppressed',
        rationale:
          'Casual conversational remark does not require project action or agent wake; deliberately suppressed (0 agents selected).',
      },
    ],
    resultingWakeRequestIds: [],
    resultingWakeRequests: [],
  },
  {
    id: 'batch-004',
    projectId: 'proj-minesweeper',
    openedAt: '14m 00s ago',
    closedAt: '13m 30s ago',
    collectionWindowDurationSec: 30,
    inputMessageIds: ['msg-failed-1'],
    status: 'failed-closed',
    attemptsCount: 2,
    attemptsHistory: [
      {
        attemptNumber: 1,
        timestamp: '13m 30s ago',
        wakeModel: 'gpt-4o-mini',
        durationMs: 10000,
        status: 'timeout',
        errorDetail: 'Gateway timeout (10000ms) waiting for wake model response',
      },
      {
        attemptNumber: 2,
        timestamp: '13m 15s ago',
        wakeModel: 'gpt-4o-mini',
        durationMs: 1200,
        status: 'malformed_output',
        errorDetail: 'Model emitted malformed JSON schema lacking complete input accounting',
      },
    ],
    failureReason:
      'Fails closed after 2 failed model attempts under ADR-0007. Zero agents woken; input message preserved with durable routing failure.',
    wakeModel: 'gpt-4o-mini',
    frozenContextSummary: {
      tokenCount: 1710,
      projectRulesIncluded: true,
      recentMessagesCount: 6,
      tasksSummariesCount: 2,
      truncated: false,
    },
    privacyBoundaryManifest: {
      directMessagesExcluded: true,
      privateMemoryExcluded: true,
      sessionsAndTranscriptsExcluded: true,
      credentialsExcluded: true,
      hostFactsExcluded: true,
      transientEnvCapacityExcluded: true,
    },
    decisions: [
      {
        messageId: 'msg-failed-1',
        targetAgentId: undefined,
        status: 'failed',
        rationale: 'Attempt 1 timed out (10s); Attempt 2 failed validation. Routing failed closed.',
      },
    ],
    resultingWakeRequestIds: [],
    resultingWakeRequests: [],
  },
  {
    id: 'batch-005',
    projectId: 'proj-minesweeper',
    openedAt: '12s ago',
    closedAt: 'In 18s',
    collectionWindowDurationSec: 30,
    countdownRemainingSec: 18,
    inputMessageIds: ['msg-open-1'],
    status: 'open',
    attemptsCount: 0,
    wakeModel: 'gpt-4o-mini',
    frozenContextSummary: {
      tokenCount: 1400,
      projectRulesIncluded: true,
      recentMessagesCount: 6,
      tasksSummariesCount: 2,
      truncated: false,
    },
    privacyBoundaryManifest: {
      directMessagesExcluded: true,
      privateMemoryExcluded: true,
      sessionsAndTranscriptsExcluded: true,
      credentialsExcluded: true,
      hostFactsExcluded: true,
      transientEnvCapacityExcluded: true,
    },
    decisions: [],
    resultingWakeRequestIds: [],
    resultingWakeRequests: [],
  },
];

const initialUsageActivities: UsageActivity[] = [
  {
    id: 'act-203',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    taskId: 'task-101',
    agentId: 'programmer',
    engine: 'pi',
    provider: 'Anthropic',
    modelIdentity: { source: 'Pi telemetry', provider: 'Anthropic', version: 'Pi 0.85.1' },
    model: 'claude-3-5-sonnet',
    activityTime: '28m ago',
    settlementRange: 'today',
    outcome: 'completed',
    sessionMode: 'resumed',
    observationState: 'stable',
    wallDurationMs: 142000,
    durationStatus: 'complete',
    engineDurationMs: undefined,
    taskCalendarElapsedMs: 2100000,
    durationSource: 'Sprout run lifecycle: started to settled',
    coverageNote: 'All token dimensions observed on the final usage-bearing call.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 50400,
      uncachedInput: 18400,
      cachedReads: 32000,
      cacheWrite: 4200,
      output: 6800,
      reasoningOutput: 2400,
      total: 61400,
      source: 'Pi message_end final Usage',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 142000,
      provenance: 'harness_calculated',
      billingBasis: 'metered_api',
      source: 'Pi usage.cost',
      sourceVersion: 'Pi 0.85.1 catalogue snapshot',
      note: 'API-equivalent only. Calculated once from the frozen Pi catalogue.',
    },
    observationHistory: [
      {
        timestamp: '28m ago',
        source: 'Pi engine harness final turn emission',
        status: 'available',
        usdMicros: 142000,
        note: 'Harness-calculated from the frozen Pi model price catalogue.',
      },
    ],
  },
  {
    id: 'act-204',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    taskId: 'task-101',
    agentId: 'reviewer',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '3m ago',
    settlementRange: 'today',
    outcome: 'completed',
    sessionMode: 'new',
    observationState: 'corrected',
    wallDurationMs: 98000,
    durationStatus: 'complete',
    engineDurationMs: 94100,
    taskCalendarElapsedMs: 2100000,
    durationSource: 'Sprout run lifecycle: started to settled',
    coverageNote: 'Complete per-turn usage. A later provider estimate superseded the local fallback.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 36600,
      uncachedInput: 12100,
      cachedReads: 24500,
      cacheWrite: 0,
      output: 4100,
      reasoningOutput: 1200,
      total: 41900,
      source: 'Codex thread/tokenUsage.updated last by turnId',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 89000,
      provenance: 'provider_estimated',
      billingBasis: 'metered_api',
      source: 'Codex per-turn backend estimate',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Provider estimate selected after the delayed backend response. It is not a bill.',
    },
    observationHistory: [
      {
        timestamp: '3m ago',
        source: 'Sprout frozen Codex price snapshot',
        status: 'superseded',
        usdMicros: 76000,
        note: 'Local estimate retained for correction history.',
      },
      {
        timestamp: '1m ago',
        source: 'Codex per-turn backend estimate',
        status: 'available and selected',
        usdMicros: 89000,
        note: 'Delayed provider estimate corrected the selected valuation.',
        supersedes: 'Sprout frozen Codex price snapshot',
      },
    ],
  },
  {
    id: 'act-202',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    agentId: 'designer',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '24m ago',
    settlementRange: 'today',
    outcome: 'stopped',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 34000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to stopped',
    coverageNote: 'Stopped after a trustworthy final usage event. Stopped does not mean zero usage.',
    outcomeReason: 'Human stopped the run before the next tool turn.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 14200,
      uncachedInput: 4200,
      cachedReads: 10000,
      cacheWrite: 0,
      output: 1800,
      reasoningOutput: 600,
      total: 16000,
      source: 'Codex thread/tokenUsage.updated last by turnId',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 38000,
      provenance: 'provider_estimated',
      billingBasis: 'subscription_included',
      source: 'Codex per-turn backend estimate',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Subscription-inclusive basis leaves billed cost unavailable; the estimate is not converted to zero.',
    },
  },
  {
    id: 'act-wake-002',
    kind: 'routing_attempt',
    projectId: 'proj-minesweeper',
    engine: undefined,
    provider: 'OpenAI',
    modelIdentity: { source: 'Wake-model adapter', provider: 'OpenAI', version: 'OpenAI pricing snapshot 2025.2' },
    model: 'gpt-4o-mini',
    activityTime: '24m 30s ago',
    settlementRange: 'today',
    outcome: 'completed',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 1400,
    durationStatus: 'complete',
    durationSource: 'Sprout routing-attempt lifecycle',
    coverageNote: 'Routing telemetry is complete for this attempt. It belongs to the Project, not an Agent or Task.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 1840,
      uncachedInput: 1840,
      cachedReads: 0,
      cacheWrite: 0,
      output: 120,
      reasoningOutput: 0,
      total: 1960,
      source: 'Wake-model adapter attempt result',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 350,
      provenance: 'locally_estimated',
      billingBasis: 'metered_api',
      source: 'Frozen official price snapshot',
      sourceVersion: 'OpenAI pricing snapshot 2025.2',
      note: 'Routing activity is a separate Project-owned model activity.',
    },
  },
  {
    id: 'act-206',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    taskId: 'task-101',
    agentId: 'programmer',
    engine: 'pi',
    provider: 'Anthropic',
    modelIdentity: { source: 'Pi telemetry', provider: 'Anthropic', version: 'Pi 0.85.1' },
    model: 'claude-3-5-sonnet',
    activityTime: 'ongoing now',
    settlementRange: 'today',
    outcome: 'ongoing',
    sessionMode: 'resumed',
    observationState: 'pending',
    wallDurationMs: 38000,
    durationStatus: 'partial',
    taskCalendarElapsedMs: 2100000,
    durationSource: 'Sprout run lifecycle: observed so far',
    coverageNote: 'Partial observation. The run is ongoing and is excluded from finalized totals.',
    tokenDimensions: {
      status: 'partial',
      totalInput: 22000,
      uncachedInput: 7200,
      cachedReads: 14800,
      cacheWrite: undefined,
      output: 3100,
      reasoningOutput: 900,
      total: undefined,
      source: 'Pi streaming usage observed so far',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'pending',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'subscription_included',
      source: 'Pi final Usage not emitted yet',
      sourceVersion: 'Pi 0.85.1',
      note: 'Pending settlement. Known observed tokens are not a finalized estimate.',
    },
  },
  {
    id: 'act-207',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'researcher',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '2h ago',
    settlementRange: '7d',
    outcome: 'failed',
    sessionMode: 'new',
    observationState: 'delayed',
    wallDurationMs: 71000,
    durationStatus: 'complete',
    engineDurationMs: 68000,
    durationSource: 'Sprout run lifecycle: started to failed',
    coverageNote: 'Partial token observation before failure. Cost backend has not returned a correlated value.',
    outcomeReason: 'Engine reported a turn failure after tool invocation.',
    tokenDimensions: {
      status: 'partial',
      totalInput: 11800,
      uncachedInput: 11800,
      cachedReads: undefined,
      cacheWrite: undefined,
      output: 900,
      reasoningOutput: undefined,
      total: undefined,
      source: 'Codex last usage before turn failure',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'pending',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'unknown',
      source: 'Codex per-turn cost poll pending',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Delayed cost is not a zero and is not included in available USD arithmetic.',
    },
    observationHistory: [
      {
        timestamp: '2h ago',
        source: 'Codex turn/tokenUsage.updated',
        status: 'partial',
        note: 'Failure settled before all token dimensions were observed.',
      },
    ],
  },
  {
    id: 'act-208',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'designer',
    engine: 'pi',
    provider: 'Anthropic',
    modelIdentity: { source: 'Pi telemetry', provider: 'Anthropic', version: 'Pi 0.85.1' },
    model: 'claude-3-5-sonnet',
    activityTime: 'yesterday',
    settlementRange: '7d',
    outcome: 'stopped',
    sessionMode: 'resumed',
    observationState: 'stable',
    wallDurationMs: 54000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to stopped',
    coverageNote: 'Complete usage for the resumed invocation. Historical session context is not counted again.',
    outcomeReason: 'Human interrupt settled the Agent run as stopped.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 18200,
      uncachedInput: 6200,
      cachedReads: 12000,
      cacheWrite: 1400,
      output: 2200,
      reasoningOutput: 700,
      total: 20400,
      source: 'Pi message_end final Usage for resumed invocation',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 21000,
      provenance: 'harness_calculated',
      billingBasis: 'subscription_included',
      source: 'Pi usage.cost',
      sourceVersion: 'Pi 0.85.1 catalogue snapshot',
      note: 'Subscription-inclusive basis is shown independently from the API-equivalent estimate.',
    },
  },
  {
    id: 'act-209',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'researcher',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: 'yesterday',
    settlementRange: '7d',
    outcome: 'interrupted',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 29000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to interrupted',
    coverageNote: 'Partial usage retained from before interruption. It is not omitted or zero-filled.',
    outcomeReason: 'Worker disconnect interrupted the run before terminal engine usage.',
    tokenDimensions: {
      status: 'partial',
      totalInput: 8600,
      uncachedInput: 8600,
      cachedReads: undefined,
      cacheWrite: undefined,
      output: 600,
      reasoningOutput: 200,
      total: 9200,
      source: 'Codex last usage before interruption',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'unavailable',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'unknown',
      source: 'No correlated provider estimate',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'Unavailable because the interrupted turn could not be correlated to a priced response.',
    },
  },
  {
    id: 'act-wake-003',
    kind: 'routing_attempt',
    projectId: 'proj-docs-portal',
    model: 'gpt-4o-mini',
    provider: 'OpenAI',
    modelIdentity: { source: 'Wake-model adapter', provider: 'OpenAI', version: 'Wake-model adapter contract pending' },
    activityTime: 'yesterday',
    settlementRange: '7d',
    outcome: 'failed',
    sessionMode: 'new',
    observationState: 'stable',
    wallDurationMs: 12000,
    durationStatus: 'complete',
    durationSource: 'Sprout routing-attempt lifecycle',
    coverageNote: 'Routing attempt failed validation. Missing routing telemetry is shown as a coverage gap.',
    outcomeReason: 'Wake model response was malformed after the bounded retry.',
    tokenDimensions: {
      status: 'unavailable',
      source: 'Routing adapter did not emit trustworthy usage',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'unavailable',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'unknown',
      source: 'No routing valuation emitted',
      sourceVersion: 'Wake-model adapter contract pending',
      note: 'Unavailable is a coverage fact, not a zero-cost assertion.',
    },
  },
  {
    id: 'act-210',
    kind: 'agent_run',
    projectId: 'proj-docs-portal',
    taskId: 'task-102',
    agentId: 'programmer',
    engine: 'codex',
    provider: 'OpenAI',
    modelIdentity: { source: 'Codex telemetry', provider: 'OpenAI', version: 'Codex CLI 0.154.0' },
    model: 'gpt-4o',
    activityTime: '3d ago',
    settlementRange: '30d',
    outcome: 'completed',
    sessionMode: 'new',
    observationState: 'delayed',
    wallDurationMs: 121000,
    durationStatus: 'complete',
    durationSource: 'Sprout run lifecycle: started to settled',
    coverageNote: 'Complete tokens. Cost remains pending after the bounded provider collection window.',
    tokenDimensions: {
      status: 'complete',
      totalInput: 29000,
      uncachedInput: 15000,
      cachedReads: 14000,
      cacheWrite: 800,
      output: 3600,
      reasoningOutput: 1000,
      total: 32600,
      source: 'Codex last usage correlated by turnId',
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'pending',
      estimatedUsdMicros: undefined,
      provenance: undefined,
      billingBasis: 'metered_api',
      source: 'Codex backend estimate collection window',
      sourceVersion: 'Codex CLI 0.154.0',
      note: 'The late provider observation is still pending. No value is invented for the gap.',
    },
  },
];

const initialAttentionItems: AttentionItem[] = [
  {
    id: 'att-1',
    severity: 'attention',
    category: 'task_validation',
    title: 'Task #101 Awaiting Human Validation',
    summary: 'Lead Programmer submitted completion claim with browser verification evidence (14/14 tests pass). Human decision required to accept or require correction.',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    referenceId: 'task-101',
    referenceType: 'task',
    actionLabel: 'Review Claim in Tasks',
    actionTargetView: 'tasks',
    targetNav: 'project',
    targetProjectTab: 'tasks',
    timestamp: '3m ago',
    lifecycleSentence: 'Task awaiting validation · Run completed · Lease held',
    attribution: 'Programmer (Pi claude-3-5-sonnet)',
  },
  {
    id: 'att-2',
    severity: 'action_required',
    category: 'task_recovery',
    title: 'Task #104 in Lease Recovery (Windows Host Offline)',
    summary: 'Windows worker disconnected during nested Agent run #206. Lease held in recovery; Human action needed in Tasks (Resume, Discard, or Force Release).',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    referenceId: 'task-104',
    referenceType: 'task',
    actionLabel: 'Inspect Recovery in Tasks',
    actionTargetView: 'tasks',
    targetNav: 'project',
    targetProjectTab: 'tasks',
    timestamp: '12m ago',
    lifecycleSentence: 'Task recovery · Run interrupted · Lease recovering',
    attribution: 'Environment worker',
  },
  {
    id: 'att-3',
    severity: 'action_required',
    category: 'task_blocker',
    title: 'Task #103 Blocked on Asset Permission',
    summary: 'Lead Programmer reported blocker: Operator permission required to unpack spatial audio sound effect assets into workspace.',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    referenceId: 'task-103',
    referenceType: 'task',
    actionLabel: 'Resolve Blocker in Tasks',
    actionTargetView: 'tasks',
    targetNav: 'project',
    targetProjectTab: 'tasks',
    timestamp: '18m ago',
    lifecycleSentence: 'Task blocked · Run stopped · Lease held',
    attribution: 'Programmer (Pi claude-3-5-sonnet)',
  },
  {
    id: 'att-4',
    severity: 'attention',
    category: 'env_enrollment',
    title: 'Pending Worker Enrollment: Pending Environment',
    summary: 'An environment worker connected over private transport and is requesting operator capability approval.',
    projectId: undefined,
    projectName: 'Infrastructure',
    referenceId: 'env-pending',
    referenceType: 'environment',
    actionLabel: 'Review Enrollment in Envs',
    actionTargetView: 'environments',
    targetNav: 'manage',
    targetManageTab: 'environments',
    timestamp: '5m ago',
    lifecycleSentence: 'Enrollment pending · Protocol compatible · 0 leases',
    attribution: 'Environment worker',
  },
  {
    id: 'att-5',
    severity: 'attention',
    category: 'env_unhealthy',
    title: 'Degraded Host: Degraded Environment',
    summary: 'Codex engine requires an interactive readiness step. Pi harness ready; GUI automation unavailable.',
    projectId: undefined,
    projectName: 'Infrastructure',
    referenceId: 'env-degraded',
    referenceType: 'environment',
    actionLabel: 'Inspect Environment in Envs',
    actionTargetView: 'environments',
    targetNav: 'manage',
    targetManageTab: 'environments',
    timestamp: '45s ago',
    lifecycleSentence: 'Host degraded · Codex login required · Clear safety',
    attribution: 'Environment worker',
  },
  {
    id: 'att-6',
    severity: 'action_required',
    category: 'env_unhealthy',
    title: 'Protocol Mismatch: Incompatible Environment',
    summary: 'Worker protocol v1.8 is below required v2.0+. Worker update on host required to admit Tasks.',
    projectId: undefined,
    projectName: 'Infrastructure',
    referenceId: 'env-incompatible',
    referenceType: 'environment',
    actionLabel: 'Inspect Protocol in Envs',
    actionTargetView: 'environments',
    targetNav: 'manage',
    targetManageTab: 'environments',
    timestamp: '1m ago',
    lifecycleSentence: 'Protocol incompatible · Task admission barred',
    attribution: 'Environment worker',
  },
];

const initialActivityFeedItems: ActivityFeedItem[] = [
  {
    id: 'act-1',
    kind: 'task_lifecycle',
    timestamp: '2025-05-18T14:32:00Z',
    relativeTime: '3m ago',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    title: 'Task #101: Reviewer completed validation check (14/14 passed)',
    subtitle: 'Playwright browser verification suite passed with zero errors · Completion claim submitted for operator review',
    badgeKind: 'purple',
    badgeLabel: 'Validation Claim',
    actor: { name: "Reviewer", avatar: "RV", kind: "agent" },
    targetNav: 'project',
    targetProjectTab: 'tasks',
    targetEntityId: 'task-101',
    metadata: { tokens: { input: 12100, output: 4100, cached: 24500 }, durationMs: 98000, costEstimate: '$0.089' },
  },
  {
    id: 'act-2',
    kind: 'agent_turn',
    timestamp: '2025-05-18T14:27:00Z',
    relativeTime: '8m ago',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    title: 'Task #102: Designer active turn running on Sound FX Synthesis',
    subtitle: 'Codex gpt-4o (run-205) executing Web Audio API oscillators on env-ready',
    badgeKind: 'blue',
    badgeLabel: 'Active Turn',
    actor: { name: "Designer", avatar: "DS", kind: "agent" },
    targetNav: 'project',
    targetProjectTab: 'tasks',
    targetEntityId: 'task-102',
    metadata: { durationMs: 480000, costEstimate: '$0.045' },
  },
  {
    id: 'act-3',
    kind: 'env_heartbeat',
    timestamp: '2025-05-18T14:25:00Z',
    relativeTime: '10m ago',
    projectId: undefined,
    projectName: 'Infrastructure',
    title: 'New Environment Worker Connected',
    subtitle: 'Private transport · Protocol v1.4 compatible · Requesting enrollment approval',
    badgeKind: 'yellow',
    badgeLabel: 'Enrollment',
    actor: { name: "Pending Environment", avatar: "MB", kind: "worker" },
    targetNav: 'manage',
    targetManageTab: 'environments',
    targetEntityId: 'env-pending',
  },
  {
    id: 'act-4',
    kind: 'chat_message',
    timestamp: '2025-05-18T14:22:00Z',
    relativeTime: '13m ago',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    title: 'Project Channel: Planner posted sprint architecture update',
    subtitle: '"Touch zoom and 3D raycasting ready; sound effects in progress by Designer."',
    badgeKind: 'blue',
    badgeLabel: 'Message',
    actor: { name: "Planner", avatar: "PL", kind: "agent" },
    targetNav: 'project',
    targetProjectTab: 'chat',
  },
  {
    id: 'act-5',
    kind: 'env_heartbeat',
    timestamp: '2025-05-18T14:18:00Z',
    relativeTime: '17m ago',
    projectId: undefined,
    projectName: 'Infrastructure',
    title: 'Environment Worker heartbeat timed out',
    subtitle: 'Missed 4 consecutive heartbeat cycles · Task #104 lease placed in recovery',
    badgeKind: 'red',
    badgeLabel: 'Degraded',
    actor: { name: "Environment worker", avatar: "WN", kind: "system" },
    targetNav: 'manage',
    targetManageTab: 'environments',
    targetEntityId: 'env-recovery',
  },
  {
    id: 'act-6',
    kind: 'routing_batch',
    timestamp: '2025-05-18T14:14:00Z',
    relativeTime: '21m ago',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    title: 'Wake-Model Assisted Routing Batch #002 settled',
    subtitle: 'Woke 2 recipients (Programmer, Designer) · Frozen context 1,420 tokens',
    badgeKind: 'green',
    badgeLabel: 'Routing',
    actor: { name: "Wake Model", avatar: "WM", kind: "system" },
    targetNav: 'project',
    targetProjectTab: 'chat',
    metadata: { routingDecision: 'Selected 2 agents; suppressed 1 non-actionable message' },
  },
  {
    id: 'act-7',
    kind: 'usage_milestone',
    timestamp: '2025-05-18T14:08:00Z',
    relativeTime: '27m ago',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    title: 'Usage Milestone: O7 Minesweeper reached $0.38 API-equivalent today',
    subtitle: '4 agent runs · 103.3k total tokens · 0 unallocated token debt',
    badgeKind: 'gray',
    badgeLabel: 'Cost',
    actor: { name: "Metering", avatar: "MT", kind: "system" },
    targetNav: 'manage',
    targetManageTab: 'usage',
  },
  {
    id: 'act-8',
    kind: 'chat_message',
    timestamp: '2025-05-18T14:02:00Z',
    relativeTime: '33m ago',
    projectId: 'proj-minesweeper',
    projectName: 'O7 Minesweeper',
    title: 'Direct Message: Programmer → Designer',
    subtitle: '"Can you verify that CSS variables match high-contrast dark theme before audio merges?"',
    badgeKind: 'blue',
    badgeLabel: 'DM',
    actor: { name: "Programmer", avatar: "PG", kind: "agent" },
    targetNav: 'project',
    targetProjectTab: 'chat',
  },
];

class StateManager {
  private state: PrototypeState;
  private listeners: Array<() => void> = [];
  // Projected replies are admitted work even though this prototype does not
  // model them as Task runs. Archive cancels them before the Agent becomes
  // read-only, and the callback independently fails closed on Agent status.
  private pendingProjectedReplies = new Map<string, PendingProjectedReply>();
  private nextPendingProjectedReplyId = 1;

  constructor() {
    this.state = {
      viewportMode: 'mobile', // Default to mobile-first viewport
      theme: 'dark', // Default to dark theme
      density: 'comfortable', // Default to comfortable density
      primaryNav: 'feed', // 1st primary destination
      projectTab: 'overview',
      manageTab: 'environments',
      activeTab: 'attention',
      feedLayoutVariant: 'unified',
      feedStatePreset: 'mixed',
      feedScopeFilter: 'all',
      feedAttentionSeverityFilter: 'all',
      feedAttentionFilter: 'all',
      feedActivityFilter: 'all',
      mobileFeedSplitTab: 'attention',
      taskViewMode: 'list',
      taskFilter: 'all',
      chatViewMode: 'list',
      environmentViewMode: 'list',
      environmentFilter: 'all',
      agentViewMode: 'list',
      agentFilter: 'all',
      selectedProjectId: 'proj-minesweeper',
      selectedScopeKind: 'project-channel',
      selectedTaskId: 'task-101',
      selectedEnvironmentId: 'env-ready',
      selectedAgentId: 'programmer',
      returnContext: null,
      activeDialog: null,
      usageFilter: {
        tab: 'run',
        timeRange: 'all',
        projectId: 'all',
        agentId: 'all',
        model: 'all',
      },
      inspectorSheet: {
        isOpen: false,
        kind: 'none',
      },
      reviewDrawerOpen: false,
      operator: initialOperator,
      settings: initialSettings,
      settingsCategoryTab: 'access',
      projects: initialProjects,
      agents: initialAgents,
      environments: initialEnvironments,
      tasks: initialTasks,
      messages: initialMessages,
      routingBatches: initialRoutingBatches,
      usageActivities: initialUsageActivities,
      attentionItems: initialAttentionItems,
      activityFeedItems: initialActivityFeedItems,
      scenarioLog: [
        'Seeded Sprout M2 prototype with 4 Agents, 3 Environments, 5 Tasks, and live multi-agent history.',
      ],
    };
  }

  public getSnapshot(): PrototypeState {
    return this.state;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(logMessage?: string) {
    if (logMessage) {
      this.state.scenarioLog.unshift(`[${new Date().toLocaleTimeString()}] ${logMessage}`);
      if (this.state.scenarioLog.length > 50) this.state.scenarioLog.pop();
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener exceptions during DOM teardown
      }
    }
  }

  private scheduleProjectedReply(
    projectId: string,
    agentId: string,
    delayMs: number,
    emit: (agent: AgentDefinition) => void,
    onCancel: (cancellation: PendingReplyCancellation) => void
  ) {
    const pendingReplyId = `pending-projected-reply-${this.nextPendingProjectedReplyId++}`;
    const timer = setTimeout(() => {
      const pendingReply = this.pendingProjectedReplies.get(pendingReplyId);
      if (!pendingReply) return;
      this.pendingProjectedReplies.delete(pendingReplyId);

      // Clearing a timer during archive is the primary cancellation path. This
      // recheck makes a callback that was already queued fail closed as well.
      const agent = this.state.agents.find((candidate) => candidate.id === pendingReply.agentId);
      const project = this.state.projects.find((candidate) => candidate.id === pendingReply.projectId);
      if (!project || project.status !== 'active') {
        pendingReply.onCancel({
          responsibleKind: 'project',
          responsibleId: pendingReply.projectId,
          reason: `Cancelled because Project "${project?.displayName ?? pendingReply.projectId}" is unavailable before reply settlement. No reply was emitted and the admitted work will not replay.`,
        });
        return;
      }
      if (!agent || agent.status !== 'active') {
        pendingReply.onCancel({
          responsibleKind: 'agent',
          responsibleId: pendingReply.agentId,
          reason: `Cancelled because Agent "${agent?.displayName ?? pendingReply.agentId}" is unavailable before reply settlement. No reply was emitted and the admitted work will not replay.`,
        });
        return;
      }
      emit(agent);
    }, delayMs);
    this.pendingProjectedReplies.set(pendingReplyId, { agentId, projectId, timer, onCancel });
  }

  private cancelPendingProjectedReplies(
    agentId: string,
    agentDisplayName: string
  ): number {
    let cancelled = 0;
    for (const [pendingReplyId, pendingReply] of this.pendingProjectedReplies) {
      if (pendingReply.agentId !== agentId) continue;
      clearTimeout(pendingReply.timer);
      this.pendingProjectedReplies.delete(pendingReplyId);
      pendingReply.onCancel({
        responsibleKind: 'agent',
        responsibleId: agentId,
        reason: `Cancelled because Agent "${agentDisplayName}" was archived before reply settlement. No reply was emitted and the admitted work will not replay.`,
      });
      cancelled += 1;
    }
    return cancelled;
  }

  private cancelProjectPendingProjectedReplies(
    projectId: string,
    projectDisplayName: string
  ): number {
    let cancelled = 0;
    for (const [pendingReplyId, pendingReply] of this.pendingProjectedReplies) {
      if (pendingReply.projectId !== projectId) continue;
      clearTimeout(pendingReply.timer);
      this.pendingProjectedReplies.delete(pendingReplyId);
      pendingReply.onCancel({
        responsibleKind: 'project',
        responsibleId: projectId,
        reason: `Cancelled because Project "${projectDisplayName}" was archived before reply settlement. No reply was emitted and the admitted work will not replay.`,
      });
      cancelled += 1;
    }
    return cancelled;
  }

  private failClosedRoutingBatch(
    batch: RoutingBatch,
    cancellation: PendingReplyCancellation
  ) {
    const responsibility: RoutingBatch['terminalResponsibility'] = {
      kind: cancellation.responsibleKind,
      id: cancellation.responsibleId,
    };
    batch.status = 'failed-closed';
    batch.closedAt = 'Just now';
    batch.failureReason = cancellation.reason;
    batch.terminalResponsibility = responsibility;
    batch.decisions = batch.decisions.map((decision) =>
      decision.status === 'selected'
        ? { ...decision, status: 'failed', rationale: cancellation.reason }
        : decision
    );
    batch.resultingWakeRequests = batch.resultingWakeRequests?.map((wakeRequest) => {
      if (wakeRequest.terminalStatus === 'settled') return wakeRequest;
      this.terminalizeWakeRequest(wakeRequest, 'failed-closed', responsibility, cancellation.reason);
      return wakeRequest;
    });
  }

  private terminalizeWakeRequest(
    wakeRequest: ResultingWakeRequestRecord,
    status: WakeRequestTerminalStatus,
    responsibility: NonNullable<RoutingBatch['terminalResponsibility']>,
    reason: string
  ) {
    // A settled WakeRequest is historical evidence of a completed run and
    // projected reply. Archive/cancellation must never rewrite that fact.
    if (wakeRequest.terminalStatus === 'settled') return;

    wakeRequest.terminalStatus = status;
    wakeRequest.terminalResponsibility = responsibility;
    wakeRequest.terminalReason = reason;
    wakeRequest.terminalTimestamp = wakeRequest.terminalTimestamp ?? terminalTimestamp();
    if (status === 'settled') {
      wakeRequest.admissionStatus = 'admitted';
      return;
    }

    // Preserve the pre-existing admission fact (`failed` is used by older
    // fixtures and projections) while exposing the independent terminal
    // outcome required by ADR-0007.
    wakeRequest.admissionStatus = 'failed';
    wakeRequest.failureReason = reason;
  }

  private completeLegacyWakeRequestFacts(
    wakeRequest: ResultingWakeRequestRecord,
    projectId: string,
    fallbackResponsibility: NonNullable<RoutingBatch['terminalResponsibility']>
  ): boolean {
    if (wakeRequest.terminalStatus) {
      const isSettled = wakeRequest.terminalStatus === 'settled';
      if (!wakeRequest.terminalResponsibility) {
        wakeRequest.terminalResponsibility = isSettled
          ? { kind: 'agent', id: wakeRequest.targetAgentId }
          : fallbackResponsibility;
      }
      if (!wakeRequest.terminalReason) {
        wakeRequest.terminalReason = isSettled
          ? 'Agent run settled and its projected reply was persisted.'
          : wakeRequest.failureReason ?? 'WakeRequest failed closed without a projected reply.';
      }
      if (!wakeRequest.terminalTimestamp) wakeRequest.terminalTimestamp = terminalTimestamp();
      if (!isSettled && !wakeRequest.failureReason) {
        wakeRequest.failureReason = wakeRequest.terminalReason;
      }
      return true;
    }

    if (wakeRequest.linkedRunId && wakeRequest.projectedReplyId) {
      this.terminalizeWakeRequest(
        wakeRequest,
        'settled',
        { kind: 'agent', id: wakeRequest.targetAgentId },
        'Agent run settled and its projected reply was persisted.'
      );
      return true;
    }

    if (
      wakeRequest.admissionStatus === 'failed' ||
      wakeRequest.admissionStatus === 'cancelled' ||
      wakeRequest.admissionStatus === 'failed-closed'
    ) {
      this.terminalizeWakeRequest(
        wakeRequest,
        wakeRequest.admissionStatus === 'cancelled' ? 'cancelled' : 'failed-closed',
        fallbackResponsibility,
        wakeRequest.failureReason ?? `WakeRequest for Agent "${wakeRequest.targetAgentId}" failed closed in Project "${projectId}".`
      );
      return true;
    }

    return false;
  }

  private failClosedPersistedProjectRouting(
    projectId: string,
    projectDisplayName: string
  ): number {
    const cancellation: PendingReplyCancellation = {
      responsibleKind: 'project',
      responsibleId: projectId,
      reason: `Cancelled because Project "${projectDisplayName}" was archived before routing settlement. No reply was emitted and the admitted work will not replay.`,
    };
    let terminalized = 0;
    for (const batch of this.state.routingBatches) {
      if (batch.projectId !== projectId) continue;

      const requests = batch.resultingWakeRequests ?? [];
      requests.forEach((wakeRequest) =>
        this.completeLegacyWakeRequestFacts(wakeRequest, projectId, { kind: 'project', id: projectId })
      );
      const hasNonTerminalRequest = requests.some((wakeRequest) => !wakeRequest.terminalStatus);
      if (batch.status === 'open' || batch.status === 'evaluating') {
        this.failClosedRoutingBatch(batch, cancellation);
        terminalized += 1;
      } else if (hasNonTerminalRequest) {
        // A settled/suppressed parent is historical evidence and must remain
        // unchanged. Its stale embedded request still needs its own terminal
        // archive fact, however.
        requests.forEach((wakeRequest) => {
          if (!wakeRequest.terminalStatus) {
            this.terminalizeWakeRequest(
              wakeRequest,
              'failed-closed',
              { kind: 'project', id: projectId },
              cancellation.reason
            );
          }
        });
        terminalized += 1;
      }
    }
    return terminalized;
  }

  private failClosedPersistedAgentRouting(
    agentId: string,
    agentDisplayName: string
  ): number {
    const cancellation: PendingReplyCancellation = {
      responsibleKind: 'agent',
      responsibleId: agentId,
      reason: `Cancelled because Agent "${agentDisplayName}" was archived before routing settlement. No reply was emitted and the admitted work will not replay.`,
    };
    let terminalized = 0;
    for (const batch of this.state.routingBatches) {
      const requests = batch.resultingWakeRequests ?? [];
      requests
        .filter((wakeRequest) => wakeRequest.targetAgentId === agentId)
        .forEach((wakeRequest) =>
          this.completeLegacyWakeRequestFacts(wakeRequest, batch.projectId, { kind: 'agent', id: agentId })
        );
      const hasSelectedDecision = batch.decisions.some(
        (decision) => decision.targetAgentId === agentId && decision.status === 'selected'
      );
      const hasPendingWake = requests.some(
        (wakeRequest) => wakeRequest.targetAgentId === agentId && !wakeRequest.terminalStatus
      );
      if (!hasSelectedDecision && !hasPendingWake) continue;
      if (batch.status === 'open' || batch.status === 'evaluating') {
        // A RoutingBatch is one frozen evaluation and therefore settles as one
        // aggregate. If an admitted recipient becomes invalid before settlement,
        // fail the whole pending batch closed rather than leaving an aggregate
        // evaluating around a terminal per-recipient fact.
        this.failClosedRoutingBatch(batch, cancellation);
        terminalized += 1;
      } else if (hasPendingWake) {
        // Do not rewrite a settled parent merely because a legacy embedded
        // request was incomplete. Terminalize that request independently.
        requests
          .filter((wakeRequest) => wakeRequest.targetAgentId === agentId && !wakeRequest.terminalStatus)
          .forEach((wakeRequest) =>
            this.terminalizeWakeRequest(
              wakeRequest,
              'failed-closed',
              { kind: 'agent', id: agentId },
              cancellation.reason
            )
          );
        terminalized += 1;
      }
    }
    return terminalized;
  }

  // --- Primary Navigation & Context Tab Actions (ADR-0008, Issue #60) ---

  public setPrimaryNav(
    nav: PrimaryNav,
    projectTab?: ProjectTab,
    manageTab?: ManageTab
  ) {
    this.state.primaryNav = nav;
    if (projectTab) {
      this.state.projectTab = projectTab;
      if (projectTab !== 'tasks') {
        this.state.taskViewMode = 'list';
      }
    } else if (nav === 'project') {
      this.state.projectTab = 'overview';
      this.state.taskViewMode = 'list';
    }
    if (manageTab) this.state.manageTab = manageTab;

    // Maintain backwards compatibility with activeTab
    if (nav === 'feed') this.state.activeTab = 'attention';
    else if (nav === 'project') {
      if (this.state.projectTab === 'tasks') this.state.activeTab = 'tasks';
      else this.state.activeTab = 'projects';
    } else if (nav === 'manage') {
      if (this.state.manageTab === 'environments') this.state.activeTab = 'environments';
      else if (this.state.manageTab === 'agents') this.state.activeTab = 'agents';
      else if (this.state.manageTab === 'usage') this.state.activeTab = 'usage';
      else this.state.activeTab = 'onboarding';
    } else if (nav === 'primitives') {
      this.state.activeTab = 'primitives';
    }

    this.notify(`Navigated to primary destination: ${nav}`);
  }

  public setActiveTab(tab: ActiveTab) {
    this.state.activeTab = tab;
    if (tab === 'attention') this.state.primaryNav = 'feed';
    else if (tab === 'projects') {
      this.state.primaryNav = 'project';
      this.state.projectTab = 'overview';
    } else if (tab === 'tasks') {
      this.state.primaryNav = 'project';
      this.state.projectTab = 'tasks';
    } else if (tab === 'environments') {
      this.state.primaryNav = 'manage';
      this.state.manageTab = 'environments';
    } else if (tab === 'agents') {
      this.state.primaryNav = 'manage';
      this.state.manageTab = 'agents';
    } else if (tab === 'usage') {
      this.state.primaryNav = 'manage';
      this.state.manageTab = 'usage';
    } else if (tab === 'primitives') {
      this.state.primaryNav = 'primitives';
    }
    this.notify(`Navigated to ${tab}`);
  }

  public setProjectTab(tab: ProjectTab) {
    this.state.projectTab = tab;
    if (this.state.primaryNav !== 'project') {
      this.state.primaryNav = 'project';
    }
    if (tab === 'tasks') this.state.activeTab = 'tasks';
    else this.state.activeTab = 'projects';
    this.notify(`Project tab switched to ${tab}`);
  }

  public setManageTab(tab: ManageTab) {
    this.state.manageTab = tab;
    if (this.state.primaryNav !== 'manage') {
      this.state.primaryNav = 'manage';
    }
    if (tab === 'environments') this.state.activeTab = 'environments';
    else if (tab === 'agents') this.state.activeTab = 'agents';
    else if (tab === 'usage') this.state.activeTab = 'usage';
    this.notify(`Manage tab switched to ${tab}`);
  }

  public navigateWithReturn(
    target: {
      nav: PrimaryNav;
      projectTab?: ProjectTab;
      manageTab?: ManageTab;
      taskId?: string;
      envId?: string;
      agentId?: string;
    },
    fromLabel: string
  ) {
    this.state.returnContext = {
      fromNav: this.state.primaryNav,
      fromLabel,
      fromProjectTab: this.state.projectTab,
      fromManageTab: this.state.manageTab,
      fromFeedScope: this.state.feedScopeFilter,
      fromFeedSeverity: this.state.feedAttentionSeverityFilter,
    };
    if (target.taskId) {
      this.state.selectedTaskId = target.taskId;
      this.state.taskViewMode = 'detail';
    }
    if (target.envId) this.state.selectedEnvironmentId = target.envId;
    if (target.agentId) this.state.selectedAgentId = target.agentId;
    this.setPrimaryNav(target.nav, target.projectTab, target.manageTab);
    this.notify(`Deep-linked to ${target.nav} with return context from ${fromLabel}`);
  }

  public popReturnContext() {
    if (this.state.returnContext) {
      const { fromNav, fromProjectTab, fromManageTab, fromLabel, fromFeedScope, fromFeedSeverity } =
        this.state.returnContext;
      this.state.returnContext = null;
      if (fromFeedScope) this.state.feedScopeFilter = fromFeedScope;
      if (fromFeedSeverity) this.state.feedAttentionSeverityFilter = fromFeedSeverity as any;
      this.setPrimaryNav(fromNav, fromProjectTab, fromManageTab);
      this.notify(`Returned back to ${fromLabel}`);
    }
  }

  public clearReturnContext() {
    this.state.returnContext = null;
    this.notify('Cleared return context');
  }

  // --- Theme, Density & Viewport Settings ---

  public setTheme(theme: ThemeMode) {
    this.state.theme = theme;
    this.notify(`Changed theme to ${theme}`);
  }

  public toggleTheme() {
    const nextTheme: ThemeMode = this.state.theme === 'dark' ? 'light' : 'dark';
    this.setTheme(nextTheme);
  }

  public setDensity(density: DensityMode) {
    this.state.density = density;
    this.notify(`Changed density to ${density}`);
  }

  public toggleDensity() {
    const nextDensity: DensityMode = this.state.density === 'comfortable' ? 'compact' : 'comfortable';
    this.setDensity(nextDensity);
  }

  public setViewportMode(mode: ViewportMode) {
    this.state.viewportMode = mode;
    this.notify(`Switched viewport mode to ${mode}`);
  }

  // --- General / Operator Settings (Ticket #68, ADR-0009) ---

  private syncOperatorSessionCount() {
    this.state.operator.sessionCount = this.state.settings.browserSessions.filter(
      (session) => session.state === 'current' || session.state === 'active'
    ).length;
  }

  public revokeOtherBrowserSessions() {
    this.state.settings.browserSessions = this.state.settings.browserSessions.map((session) =>
      session.state === 'active' ? { ...session, state: 'revoked' as const, lastSeen: 'Revoked just now' } : session
    );
    this.syncOperatorSessionCount();
    this.notify('Revoked all other browser sessions. The current session remains active.');
  }

  public revokeBrowserSession(sessionId: string): { success: boolean; reason?: string } {
    const session = this.state.settings.browserSessions.find((candidate) => candidate.id === sessionId);
    if (!session) return { success: false, reason: 'Browser session not found.' };
    if (session.state === 'current') {
      const reason = 'The current browser session cannot revoke itself. Use credential rotation on the host to invalidate all other sessions.';
      this.notify(reason);
      return { success: false, reason };
    }
    if (session.state === 'revoked') return { success: true };
    session.state = 'revoked';
    session.lastSeen = 'Revoked just now';
    this.syncOperatorSessionCount();
    this.notify(`Revoked browser session: ${session.deviceLabel}.`);
    return { success: true };
  }

  public rotateOperatorCredential(): { success: boolean; reason?: string } {
    const currentSession = this.state.settings.browserSessions.find((session) => session.state === 'current');
    if (!currentSession) {
      const reason = 'Credential rotation cannot continue without a current browser session. Recover access on the Sprout host.';
      this.notify(reason);
      return { success: false, reason };
    }

    this.state.settings.browserSessions = this.state.settings.browserSessions.map((session) =>
      session.id === currentSession.id
        ? session
        : { ...session, state: 'revoked' as const, lastSeen: 'Revoked by credential rotation' }
    );
    this.state.settings.credentials.state = 'rotation-complete';
    this.state.settings.credentials.lastRotated = 'Just now';
    this.syncOperatorSessionCount();
    this.notify('Rotated the operator credential. Other browser sessions were revoked; host-local recovery remains the fallback.');
    return { success: true };
  }

  public exportSanitizedDiagnostics() {
    this.state.settings.diagnostics.state = 'exported';
    this.state.settings.diagnostics.lastExport = 'Prepared just now. Prototype export contains sanitized facts only.';
    this.notify('Prepared a sanitized diagnostic export. Credentials, content, host identity, and raw logs were excluded.');
  }

  public markDurableDataLocationCopied() {
    this.state.settings.durableData.copyState = 'copied';
    this.notify('Copied the relative durable-data location guidance.');
  }

  public setSettingsCategoryTab(tab: SettingsCategoryTab) {
    this.state.settingsCategoryTab = tab;
    this.notify(`Switched Settings category to ${tab}`);
  }

  // --- Feed & Attention Actions (Ticket #62) ---

  public setFeedLayoutVariant(variant: FeedLayoutVariant) {
    this.state.feedLayoutVariant = variant;
    this.notify(`Feed layout variant set to ${variant}`);
  }

  public setFeedStatePreset(preset: FeedStatePreset) {
    this.state.feedStatePreset = preset;
    this.applyFeedPreset(preset);
  }

  public setFeedScopeFilter(scope: string) {
    this.state.feedScopeFilter = scope;
    this.notify(`Feed scope filter set to ${scope}`);
  }

  public setFeedAttentionSeverityFilter(severity: 'all' | AttentionSeverity) {
    this.state.feedAttentionSeverityFilter = severity;
    this.notify(`Feed attention severity filter set to ${severity}`);
  }

  public setFeedAttentionFilter(filter: 'all' | AttentionCategory | AttentionSeverity) {
    this.state.feedAttentionFilter = filter;
    this.notify(`Feed attention filter set to ${filter}`);
  }

  public setFeedActivityFilter(filter: 'all' | 'tasks' | 'messages' | 'envs' | 'usage') {
    this.state.feedActivityFilter = filter;
    this.notify(`Feed activity filter set to ${filter}`);
  }

  public setMobileFeedSplitTab(tab: 'attention' | 'activity') {
    this.state.mobileFeedSplitTab = tab;
    this.notify(`Mobile feed split tab set to ${tab}`);
  }

  public applyFeedPreset(preset: FeedStatePreset) {
    this.state.feedStatePreset = preset;
    let attentionItems: AttentionItem[] = [...initialAttentionItems];
    let activeTaskIds: string[] = ['task-102'];
    let degradedEnvironmentIds: string[] = ['win-dev-box', 'mac-laptop-pending'];
    let logMessage = '';

    // Feed presets are review fixtures, not lifecycle commands. Keep them in
    // an isolated projection so a visual "all clear" example cannot mutate a
    // Task or Environment that is still authoritative in its source module.
    switch (preset) {
      case 'mixed': {
        logMessage = 'Applied State Matrix Preset: Mixed (Default Realistic Operations)';
        break;
      }
      case 'empty': {
        attentionItems = [];
        activeTaskIds = [];
        degradedEnvironmentIds = [];
        logMessage = 'Applied State Matrix Preset: Empty (All Systems Clear)';
        break;
      }
      case 'healthy': {
        attentionItems = [];
        degradedEnvironmentIds = [];
        logMessage = 'Applied State Matrix Preset: Healthy (Active Work Running Smoothly)';
        break;
      }
      case 'stale': {
        attentionItems = [
          {
            id: 'att-stale-1',
            severity: 'attention',
            category: 'env_unhealthy',
            title: 'Stale Heartbeat on mac-studio-primary',
            summary: 'Heartbeat overdue by 14 minutes. Environment telemetry unconfirmed; agent runs may be proceeding without status confirmation.',
            projectName: 'Infrastructure',
            referenceId: 'mac-studio-primary',
            referenceType: 'environment',
            actionLabel: 'Inspect Environment in Envs',
            actionTargetView: 'environments',
            targetNav: 'manage',
            targetManageTab: 'environments',
            timestamp: '14m overdue',
            lifecycleSentence: 'Heartbeat overdue 14m · Telemetry stale',
            attribution: 'Worker mac-studio-primary',
          },
          {
            id: 'att-stale-2',
            severity: 'attention',
            category: 'task_recovery',
            title: 'Unconfirmed Task #101 Lease Status',
            summary: 'Worker telemetry stale; Task lease status unconfirmed since 14m ago. Operator check advised.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'task-101',
            referenceType: 'task',
            actionLabel: 'Inspect Lease in Tasks',
            actionTargetView: 'tasks',
            targetNav: 'project',
            targetProjectTab: 'tasks',
            timestamp: '14m ago',
            lifecycleSentence: 'Task active · Run unconfirmed · Lease stale',
            attribution: 'Worker mac-studio-primary',
          },
        ];
        degradedEnvironmentIds = ['mac-studio-primary'];
        logMessage = 'Applied State Matrix Preset: Stale (Stale Telemetry & Unconfirmed Lease)';
        break;
      }
      case 'pending': {
        attentionItems = [
          {
            id: 'att-pend-1',
            severity: 'info',
            category: 'task_proposed',
            title: 'Proposed Task #105: High Score Persistence & Leaderboard',
            summary: 'Planner proposed new task with 3 constraints and 2 verification criteria. Awaiting Human Authorization to begin and acquire Environment lease.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'task-105',
            referenceType: 'task',
            actionLabel: 'Authorize Task in Tasks',
            actionTargetView: 'tasks',
            targetNav: 'project',
            targetProjectTab: 'tasks',
            timestamp: '10m ago',
            lifecycleSentence: 'Task proposed · Run none · Lease none',
            attribution: 'Planner (Agent Proposal)',
          },
          {
            id: 'att-pend-2',
            severity: 'info',
            category: 'task_proposed',
            title: 'Proposed Task #106: Spatial Audio Reverb Engine',
            summary: 'Designer proposed audio expansion task for custom impulse response filters. Awaiting Human Begin Authorization.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'task-105',
            referenceType: 'task',
            actionLabel: 'Authorize Task in Tasks',
            actionTargetView: 'tasks',
            targetNav: 'project',
            targetProjectTab: 'tasks',
            timestamp: '8m ago',
            lifecycleSentence: 'Task proposed · Run none · Lease none',
            attribution: 'Designer (Agent Proposal)',
          },
          {
            id: 'att-pend-3',
            severity: 'attention',
            category: 'env_enrollment',
            title: 'Pending Worker Enrollment: MacBook Air',
            summary: 'Worker sprout-wk-macair-e018df33 connected over Private Overlay and is requesting operator capability approval.',
            projectName: 'Infrastructure',
            referenceId: 'mac-laptop-pending',
            referenceType: 'environment',
            actionLabel: 'Review Enrollment in Envs',
            actionTargetView: 'environments',
            targetNav: 'manage',
            targetManageTab: 'environments',
            timestamp: '5m ago',
            lifecycleSentence: 'Enrollment pending · Protocol compatible · 0 leases',
            attribution: 'sprout-wk-macair-e018df33 (Worker)',
          },
        ];
        activeTaskIds = [];
        degradedEnvironmentIds = ['mac-laptop-pending'];
        logMessage = 'Applied State Matrix Preset: Pending (Proposed Tasks & Worker Enrollment)';
        break;
      }
      case 'degraded': {
        attentionItems = [
          {
            id: 'att-deg-1',
            severity: 'action_required',
            category: 'env_unhealthy',
            title: 'Windows Worker Offline (Task #104 Lease Held)',
            summary: 'Host win-dev-box disconnected 22m ago while holding Task #104 lease. Lease is in unconfirmed recovery. Human action needed in Envs or Tasks.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'win-dev-box',
            referenceType: 'environment',
            actionLabel: 'Inspect Host in Envs',
            actionTargetView: 'environments',
            targetNav: 'manage',
            targetManageTab: 'environments',
            timestamp: '22m ago',
            lifecycleSentence: 'Worker offline 22m · Held lease blocked',
            attribution: 'win-dev-box (Windows Host)',
          },
          {
            id: 'att-deg-2',
            severity: 'attention',
            category: 'env_unhealthy',
            title: 'Codex Engine Login Required on mac-studio-primary',
            summary: 'Codex engine reports login-required. 1 of 4 engines degraded; Pi, agy, and opencode remain ready.',
            projectName: 'Infrastructure',
            referenceId: 'mac-studio-primary',
            referenceType: 'environment',
            actionLabel: 'Inspect Readiness in Envs',
            actionTargetView: 'environments',
            targetNav: 'manage',
            targetManageTab: 'environments',
            timestamp: '30m ago',
            lifecycleSentence: '1/4 engine offline (Codex login-required)',
            attribution: 'mac-studio-primary (Worker)',
          },
          {
            id: 'att-deg-3',
            severity: 'info',
            category: 'routing_fallback',
            title: 'Wake-Model Assisted Routing Failure Notice',
            summary: 'Wake model syntax error in Batch #002; failed open to broadcast all project members per ADR-0007.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'batch-002',
            referenceType: 'routing_batch',
            actionLabel: 'Inspect Batch in Chat',
            actionTargetView: 'chat',
            targetNav: 'project',
            targetProjectTab: 'chat',
            timestamp: '4m ago',
            lifecycleSentence: 'Routing batch failed-open · Broadcast delivered',
            attribution: 'Wake Model (System)',
          },
        ];
        degradedEnvironmentIds = ['win-dev-box', 'mac-studio-primary'];
        logMessage = 'Applied State Matrix Preset: Degraded (Offline Host & Engine Degraded)';
        break;
      }
      case 'intervention': {
        attentionItems = [
          {
            id: 'att-int-1',
            severity: 'action_required',
            category: 'task_blocker',
            title: 'Task #103 Blocked on Spatial Audio Asset Permission',
            summary: 'Lead Programmer declared blocker: Operator permission required to unpack spatial audio sound effect assets into workspace.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'task-103',
            referenceType: 'task',
            actionLabel: 'Resolve Blocker in Tasks',
            actionTargetView: 'tasks',
            targetNav: 'project',
            targetProjectTab: 'tasks',
            timestamp: '18m ago',
            lifecycleSentence: 'Task blocked · Run stopped · Lease held',
            attribution: 'Programmer (Pi claude-3-5-sonnet)',
          },
          {
            id: 'att-int-2',
            severity: 'action_required',
            category: 'task_validation',
            title: 'Task #101 Awaiting Operator Validation',
            summary: 'Lead Programmer submitted completion claim with browser verification evidence (14/14 passed). Human decision required to accept or require correction.',
            projectId: 'proj-minesweeper',
            projectName: 'O7 Minesweeper',
            referenceId: 'task-101',
            referenceType: 'task',
            actionLabel: 'Review Claim in Tasks',
            actionTargetView: 'tasks',
            targetNav: 'project',
            targetProjectTab: 'tasks',
            timestamp: '3m ago',
            lifecycleSentence: 'Task awaiting validation · Run completed · Lease held',
            attribution: 'Programmer (Pi claude-3-5-sonnet)',
          },
        ];
        degradedEnvironmentIds = [];
        logMessage = 'Applied State Matrix Preset: Intervention (Blockers & Validation Claims)';
        break;
      }
    }

    this.state.feedScenarioSnapshot = {
      preset,
      attentionItems: structuredClone(attentionItems),
      activityFeedItems: structuredClone(initialActivityFeedItems),
      activeTaskIds: [...activeTaskIds],
      degradedEnvironmentIds: [...degradedEnvironmentIds],
    };
    this.notify(logMessage);
  }

  // --- Dialog & Sheet Actions ---

  public openDialog(dialog: ActiveDialog) {
    this.state.activeDialog = dialog;
    this.notify(`Opened dialog: ${dialog.title}`);
  }

  public closeDialog() {
    if (this.state.activeDialog) {
      const title = this.state.activeDialog.title;
      this.state.activeDialog = null;
      this.notify(`Closed dialog: ${title}`);
    }
  }

  public selectProject(projectId: string) {
    this.state.selectedProjectId = projectId;
    this.notify(`Selected project ${projectId}`);
  }

  public selectScope(
    kind: 'project-channel' | 'working-group-channel' | 'direct-message',
    id?: string
  ) {
    this.state.selectedScopeKind = kind;
    if (kind === 'working-group-channel') {
      this.state.selectedWorkingGroupId = id;
    } else if (kind === 'direct-message') {
      this.state.selectedDirectMessagePeerId = id;
    }
    this.notify(`Changed conversation scope to ${kind}`);
  }

  public openChatDetail(
    kind: 'project-channel' | 'working-group-channel' | 'direct-message',
    id?: string,
    pushHistory = true
  ) {
    this.state.selectedScopeKind = kind;
    if (kind === 'working-group-channel') {
      this.state.selectedWorkingGroupId = id;
    } else if (kind === 'direct-message') {
      this.state.selectedDirectMessagePeerId = id;
    }
    this.state.chatViewMode = 'detail';
    if (pushHistory && typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
      try {
        window.history.pushState(
          { page: 'chat-detail', scopeKind: kind, scopeId: id },
          '',
          window.location.pathname + '#chat-' + (id || 'general')
        );
      } catch {}
    }
    this.notify(`Opened conversation detail for ${id || 'general'}`);
  }

  public closeChatDetail(pushHistory = true) {
    this.state.chatViewMode = 'list';
    if (pushHistory && typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
      try {
        window.history.pushState({ page: 'chat-list' }, '', window.location.pathname + '#chats');
      } catch {}
    }
    this.notify('Closed chat detail and returned to chat list');
  }

  public selectTask(taskId: string) {
    this.openTaskDetail(taskId);
  }

  public openTaskDetail(taskId: string, pushHistory = true) {
    this.state.taskViewMode = 'detail';
    this.state.selectedTaskId = taskId;
    if (pushHistory && typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
      try {
        window.history.pushState(
          { page: 'task-detail', taskId },
          '',
          window.location.pathname + '#task-' + taskId
        );
      } catch {}
    }
    this.notify(`Opened Task Detail for #${taskId.replace('task-', '')}`);
  }

  public closeTaskDetail(pushHistory = true) {
    this.state.taskViewMode = 'list';
    if (pushHistory && typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
      try {
        window.history.pushState({ page: 'task-list' }, '', window.location.pathname + '#tasks');
      } catch {}
    }
    this.notify('Returned to Task List view');
  }

  public setTaskFilter(filter: string) {
    this.state.taskFilter = filter;
    this.notify(`Set task filter to ${filter}`);
  }

  public selectEnvironment(envId: string, pushHistory = true) {
    this.state.selectedEnvironmentId = envId;
    this.state.environmentViewMode = 'detail';
    if (pushHistory && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ page: 'env-detail', envId }, '', `#env-${envId}`);
    }
    this.notify(`Selected Environment ${envId}`);
  }

  public openEnvironmentDetail(envId: string, pushHistory = true) {
    this.state.selectedEnvironmentId = envId;
    this.state.environmentViewMode = 'detail';
    if (pushHistory && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ page: 'env-detail', envId }, '', `#env-${envId}`);
    }
    this.notify(`Opened Environment Detail for ${envId}`);
  }

  public closeEnvironmentDetail(pushHistory = true) {
    this.state.environmentViewMode = 'list';
    if (pushHistory && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ page: 'env-list' }, '', '#envs');
    }
    this.notify('Returned to Environment list');
  }

  public setEnvironmentFilter(filter: string) {
    this.state.environmentFilter = filter;
    this.notify(`Set environment filter to ${filter}`);
  }

  public selectAgent(agentId: string, pushHistory = true) {
    this.state.selectedAgentId = agentId;
    this.state.agentViewMode = 'detail';
    if (pushHistory && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ page: 'agent-detail', agentId }, '', `#agents/${agentId}`);
    }
    this.notify(`Selected Agent ${agentId}`);
  }

  public openAgentDetail(agentId: string, pushHistory = true) {
    this.state.selectedAgentId = agentId;
    this.state.agentViewMode = 'detail';
    if (pushHistory && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ page: 'agent-detail', agentId }, '', `#agents/${agentId}`);
    }
    this.notify(`Opened Agent Detail for ${agentId}`);
  }

  public closeAgentDetail(pushHistory = true) {
    this.state.agentViewMode = 'list';
    if (pushHistory && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ page: 'agent-list' }, '', '#agents');
    }
    this.notify('Returned to Agent list');
  }

  public setAgentFilter(filter: string) {
    this.state.agentFilter = filter;
    this.notify(`Set agent filter to ${filter}`);
  }

  public createAgent(agent: {
    displayName: string;
    description: string;
    avatar?: string | undefined;
    standingInstructions?: string | undefined;
    workOptions?: AgentWorkOption[] | undefined;
  }) {
    const id = agent.displayName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `agent-${Date.now()}`;
    const avatar = agent.avatar || agent.displayName.slice(0, 2).toUpperCase();
    const workOptions: AgentWorkOption[] = (agent.workOptions && agent.workOptions.length > 0)
      ? agent.workOptions
      : [
          { id: `opt-${id}-1`, engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'high', isConfigured: true },
        ];

    const newAgent: AgentDefinition = {
      id,
      displayName: agent.displayName.trim(),
      avatar,
      description: agent.description.trim(),
      standingInstructions: agent.standingInstructions?.trim() || undefined,
      workOptions,
      status: 'active',
      privateMemoryEntriesCount: 0,
      version: 1,
      createdAt: 'Just now',
      updatedAt: 'Just now',
      versionHistory: [
        {
          version: 1,
          timestamp: 'Just now',
          author: this.state.operator.name,
          changeSummary: 'Initial Agent creation with portable work options.',
          optionsCount: workOptions.length,
          standingInstructions: agent.standingInstructions?.trim() || undefined,
        },
      ],
      attributionHistory: [],
    };
    this.state.agents.push(newAgent);
    this.state.selectedAgentId = id;
    this.state.agentViewMode = 'detail';
    this.notify(`Created Agent "${newAgent.displayName}" (v1).`);
    return newAgent;
  }

  public updateAgentIdentity(
    agentId: string,
    updates: { displayName?: string | undefined; description?: string | undefined; standingInstructions?: string | undefined }
  ) {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return;

    const oldVersion = agent.version || 1;
    const newVersion = oldVersion + 1;
    agent.version = newVersion;
    agent.updatedAt = 'Just now';

    const changes: string[] = [];
    if (updates.displayName !== undefined && updates.displayName !== agent.displayName) {
      changes.push(`Renamed to "${updates.displayName}"`);
      agent.displayName = updates.displayName;
    }
    if (updates.description !== undefined && updates.description !== agent.description) {
      changes.push(`Updated description`);
      agent.description = updates.description;
    }
    if (updates.standingInstructions !== undefined && updates.standingInstructions !== agent.standingInstructions) {
      changes.push(`Updated standing instructions`);
      agent.standingInstructions = updates.standingInstructions.trim() || undefined;
    }

    if (!agent.versionHistory) agent.versionHistory = [];
    agent.versionHistory.unshift({
      version: newVersion,
      timestamp: 'Just now',
      author: this.state.operator.name,
      changeSummary: changes.join(', ') || 'Updated agent identity facts.',
      optionsCount: agent.workOptions.length,
      standingInstructions: agent.standingInstructions,
    });

    this.notify(`Updated Agent "${agent.displayName}" to v${newVersion}.`);
  }

  public addAgentWorkOption(
    agentId: string,
    option: { engine: EngineKind; workModel: string; effort: 'low' | 'medium' | 'high' | 'default'; isConfigured?: boolean }
  ) {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return;

    const newOptId = `opt-${agent.id}-${Date.now()}`;
    const newOption: AgentWorkOption = {
      id: newOptId,
      engine: option.engine,
      workModel: option.workModel,
      effort: option.effort,
      isConfigured: option.isConfigured ?? true,
    };
    agent.workOptions.push(newOption);

    const oldVersion = agent.version || 1;
    const newVersion = oldVersion + 1;
    agent.version = newVersion;
    agent.updatedAt = 'Just now';

    if (!agent.versionHistory) agent.versionHistory = [];
    agent.versionHistory.unshift({
      version: newVersion,
      timestamp: 'Just now',
      author: this.state.operator.name,
      changeSummary: `Added Priority ${agent.workOptions.length} option: ${option.engine.toUpperCase()} (${option.workModel} · ${option.effort}).`,
      optionsCount: agent.workOptions.length,
      standingInstructions: agent.standingInstructions,
    });

    this.notify(`Added work option to Agent "${agent.displayName}" (v${newVersion}).`);
  }

  public removeAgentWorkOption(agentId: string, optionId: string): boolean {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return false;

    // Invariant (ADR-0008): Cannot leave an Agent with no work option
    if (agent.workOptions.length <= 1) {
      if (typeof window !== 'undefined' && window.alert) {
        window.alert('Cannot remove the only work option. An Agent must have at least one ordered work option (ADR-0008).');
      }
      return false;
    }

    const targetOpt = agent.workOptions.find((o) => o.id === optionId);
    agent.workOptions = agent.workOptions.filter((o) => o.id !== optionId);

    const oldVersion = agent.version || 1;
    const newVersion = oldVersion + 1;
    agent.version = newVersion;
    agent.updatedAt = 'Just now';

    if (!agent.versionHistory) agent.versionHistory = [];
    agent.versionHistory.unshift({
      version: newVersion,
      timestamp: 'Just now',
      author: this.state.operator.name,
      changeSummary: `Removed work option ${targetOpt?.engine.toUpperCase()} (${targetOpt?.workModel}).`,
      optionsCount: agent.workOptions.length,
      standingInstructions: agent.standingInstructions,
    });

    this.notify(`Removed work option from Agent "${agent.displayName}" (v${newVersion}).`);
    return true;
  }

  public reorderAgentWorkOptions(agentId: string, sourceIdx: number, targetIdx: number) {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return;
    if (sourceIdx < 0 || sourceIdx >= agent.workOptions.length) return;
    if (targetIdx < 0 || targetIdx >= agent.workOptions.length) return;
    if (sourceIdx === targetIdx) return;

    const [movedOpt] = agent.workOptions.splice(sourceIdx, 1);
    if (!movedOpt) return;
    agent.workOptions.splice(targetIdx, 0, movedOpt);

    const oldVersion = agent.version || 1;
    const newVersion = oldVersion + 1;
    agent.version = newVersion;
    agent.updatedAt = 'Just now';

    if (!agent.versionHistory) agent.versionHistory = [];
    agent.versionHistory.unshift({
      version: newVersion,
      timestamp: 'Just now',
      author: this.state.operator.name,
      changeSummary: `Reordered execution preferences (Priority ${sourceIdx + 1} -> Priority ${targetIdx + 1}).`,
      optionsCount: agent.workOptions.length,
      standingInstructions: agent.standingInstructions,
    });

    this.notify(`Reordered work options for Agent "${agent.displayName}" (v${newVersion}).`);
  }

  public archiveAgent(agentId: string): { success: boolean; reason?: string } {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return { success: false, reason: 'Agent not found' };

    // Invariant (ADR-0008): An Agent cannot be archived during an active run or while it remains Task lead of an unfinished Task.
    // 1. Check for active runs by this agent (regardless of task lead ownership)
    const taskWithActiveRun = this.state.tasks.find(
      (t) =>
        t.runs.some((r) => r.agentId === agentId && r.lifecycle === 'running') ||
        (t.agentRunLifecycle === 'running' && t.activeRunId && t.runs.some((r) => r.id === t.activeRunId && r.agentId === agentId))
    );
    if (taskWithActiveRun) {
      const activeRun = taskWithActiveRun.runs.find(
        (r) => r.agentId === agentId && (r.lifecycle === 'running' || r.id === taskWithActiveRun.activeRunId)
      );
      const msg = `Cannot archive Agent "${agent.displayName}": Agent is currently executing active run #${activeRun?.id || 'in-progress'} in Task #${taskWithActiveRun.id.replace('task-', '')}. Wait for completion or interrupt run first (ADR-0008).`;
      if (typeof window !== 'undefined' && window.alert) {
        window.alert(msg);
      }
      return { success: false, reason: msg };
    }

    // 2. Check for unfinished task lead ownership
    const activeTasksWithLead = this.state.tasks.filter(
      (t) =>
        t.taskLeadId === agentId &&
        t.lifecycle !== 'completed' &&
        t.lifecycle !== 'cancelled' &&
        t.lifecycle !== 'rejected' &&
        t.lifecycle !== 'withdrawn'
    );
    if (activeTasksWithLead.length > 0) {
      const msg = `Cannot archive Agent "${agent.displayName}": Agent is currently Task lead for ${activeTasksWithLead.length} unfinished task(s) (e.g. Task #${activeTasksWithLead[0]!.id.replace('task-', '')}). Reassign or complete tasks first (ADR-0008).`;
      if (typeof window !== 'undefined' && window.alert) {
        window.alert(msg);
      }
      return { success: false, reason: msg };
    }

    const cancelledReplyCount = this.cancelPendingProjectedReplies(agentId, agent.displayName);
    const terminalizedBatchCount = this.failClosedPersistedAgentRouting(agentId, agent.displayName);
    agent.status = 'archived';
    this.notify(
      `Archived Agent "${agent.displayName}".${
        cancelledReplyCount > 0 ? ` Cancelled ${cancelledReplyCount} admitted projected repl${cancelledReplyCount === 1 ? 'y' : 'ies'}.` : ''
      }${
        terminalizedBatchCount > 0 ? ` Terminalized ${terminalizedBatchCount} persisted routing batch${terminalizedBatchCount === 1 ? '' : 'es'}.` : ''
      } Historical attribution, private memory, and session slots preserved.`
    );
    return { success: true };
  }

  public restoreAgent(agentId: string) {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return;

    agent.status = 'active';
    this.notify(`Restored Agent "${agent.displayName}". Agent is available for new project assignments and runs.`);
  }

  public evaluateAdmissionFallback(agentId: string, environmentId: string): AdmissionEvaluation | null {
    const agent = this.state.agents.find((a) => a.id === agentId);
    const env = this.state.environments.find((e) => e.id === environmentId);
    if (!agent || !env) return null;

    // Guard: Archived Agent cannot be admitted for new work (ADR-0008)
    if (agent.status === 'archived') {
      return {
        agent,
        environment: env,
        envIneligibilityReason: `Agent "${agent.displayName}" is archived and cannot be admitted for new runs (ADR-0008).`,
        evaluationSteps: agent.workOptions.map((opt, i) => ({
          priority: i + 1,
          option: opt,
          status: 'skipped_unsupported' as const,
          reason: `Agent "${agent.displayName}" is archived. Restore agent before admission.`,
        })),
        selectedOption: null,
        guaranteeNote:
          'Pre-Acceptance Fallback Guarantee: Evaluated before run admission. Once accepted by engine, execution failure is reported directly; Sprout never silently replays work (ADR-0008).',
      };
    }

    // 1. Evaluate Environment-level eligibility (enrollment, connection, protocol, work safety, capability)
    const envCheck = checkEnvironmentEligibility(env);
    if (!envCheck.isEligible) {
      return {
        agent,
        environment: env,
        envIneligibilityReason: envCheck.reason,
        evaluationSteps: agent.workOptions.map((opt, i) => ({
          priority: i + 1,
          option: opt,
          status: 'skipped_unsupported' as const,
          reason: `Host ${env.displayName} is ineligible: ${envCheck.reason}`,
        })),
        selectedOption: null,
        guaranteeNote:
          'Pre-Acceptance Fallback Guarantee: Evaluated before run admission. Once accepted by engine, execution failure is reported directly; Sprout never silently replays work (ADR-0008).',
      };
    }

    const evaluationSteps: AdmissionStep[] = [];

    let selectedOption: AgentWorkOption | null = null;

    for (let i = 0; i < agent.workOptions.length; i++) {
      const opt = agent.workOptions[i]!;

      // Check Option configuration flag (ADR-0008)
      if (opt.isConfigured === false) {
        evaluationSteps.push({
          priority: i + 1,
          option: opt,
          status: 'skipped_unconfigured',
          reason: `Option Priority ${i + 1} (${opt.engine.toUpperCase()} · ${opt.workModel}) is marked unconfigured (isConfigured: false).`,
        });
        continue;
      }

      // Check Engine Readiness
      const engineReadiness = env.engineReadiness[opt.engine];
      if (engineReadiness === 'missing' || !engineReadiness) {
        evaluationSteps.push({
          priority: i + 1,
          option: opt,
          status: 'skipped_unsupported',
          reason: `Engine "${opt.engine}" is not installed or supported on host ${env.displayName}.`,
        });
        continue;
      }

      if (engineReadiness === 'login-required') {
        evaluationSteps.push({
          priority: i + 1,
          option: opt,
          status: 'skipped_unauthenticated',
          reason: `Engine "${opt.engine}" requires login/authentication on host ${env.displayName}.`,
        });
        continue;
      }

      if (engineReadiness !== 'ready') {
        evaluationSteps.push({
          priority: i + 1,
          option: opt,
          status: 'skipped_unsupported',
          reason: `Engine readiness status is ${engineReadiness} on host ${env.displayName}.`,
        });
        continue;
      }

      // Check Model Availability
      const modelCheck = checkEngineModelAvailability(opt.engine, opt.workModel, env);
      if (!modelCheck.isAvailable) {
        evaluationSteps.push({
          priority: i + 1,
          option: opt,
          status: 'skipped_model_missing',
          reason: modelCheck.reason || `Model "${opt.workModel}" is not available on host ${env.displayName}.`,
        });
        continue;
      }

      // Option is configured, engine is ready, and model is available!
      evaluationSteps.push({
        priority: i + 1,
        option: opt,
        status: 'selected',
        reason: `Engine "${opt.engine}" is permitted, authenticated, and model "${opt.workModel}" is available on ${env.displayName}.`,
      });
      selectedOption = opt;
      break; // Pre-acceptance fallback selects the first admissible option
    }

    return {
      agent,
      environment: env,
      evaluationSteps,
      selectedOption,
      rejectionReason: selectedOption
        ? undefined
        : evaluationSteps.at(-1)?.reason || `No configured work option is available on ${env.displayName}.`,
      guaranteeNote:
        'Pre-Acceptance Fallback Guarantee: Evaluated before run admission. Once accepted by engine, execution failure is reported directly; Sprout never silently replays work (ADR-0008).',
    };
  }

  /**
   * The one task/run admission seam. It composes the ordered option evaluator
   * with Project membership, workspace, and lease checks before any Task or
   * run state is changed.
   */
  public evaluateTaskAdmission(taskId: string, environmentId: string, leadAgentId: string): AdmissionEvaluation {
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    const project = task && this.state.projects.find((candidate) => candidate.id === task.projectId);
    const agent = this.state.agents.find((candidate) => candidate.id === leadAgentId);
    const env = this.state.environments.find((candidate) => candidate.id === environmentId);
    const guaranteeNote =
      'Pre-Acceptance Fallback Guarantee: Evaluated before run admission. Once accepted by engine, execution failure is reported directly; Sprout never silently replays work (ADR-0008).';

    if (!task) {
      return { rejectionReason: 'Task not found.', evaluationSteps: [], selectedOption: null, guaranteeNote };
    }
    if (!agent) {
      return { rejectionReason: 'Selected Agent not found.', evaluationSteps: [], selectedOption: null, guaranteeNote };
    }
    if (!env) {
      return { agent, rejectionReason: 'Selected Environment not found.', evaluationSteps: [], selectedOption: null, guaranteeNote };
    }

    // This is intentionally called for every Task/run path, rather than
    // replicating option, model, and host checks at individual call sites.
    const evaluation = this.evaluateAdmissionFallback(leadAgentId, environmentId)!;
    if (!evaluation.selectedOption) return evaluation;

    if (!project || project.status !== 'active') {
      return { ...evaluation, selectedOption: null, rejectionReason: 'Project is unavailable for new work admission.' };
    }
    const membership = project.memberships.find(
      (member) => member.memberId === leadAgentId && member.memberKind === 'agent' && member.status === 'active'
    );
    if (!membership) {
      return {
        ...evaluation,
        selectedOption: null,
        rejectionReason: `Agent "${agent.displayName}" is not an active member of Project "${project.displayName}". Add or restore Project membership before beginning work.`,
      };
    }
    const workspace = project.boundEnvironmentWorkspaces.find(
      (binding) => binding.environmentId === environmentId && binding.isPrepared
    );
    if (!workspace) {
      return {
        ...evaluation,
        selectedOption: null,
        rejectionReason: `Environment "${env.displayName}" has no prepared Project workspace for "${project.displayName}".`,
      };
    }
    if (env.activeLeaseHolder && env.activeLeaseHolder.holderId !== task.id) {
      return {
        ...evaluation,
        selectedOption: null,
        rejectionReason: `Environment "${env.displayName}" is busy with another Task lease and cannot admit new work.`,
      };
    }

    return evaluation;
  }

  public setUsageFilter(filter: Partial<PrototypeState['usageFilter']>) {
    this.state.usageFilter = { ...this.state.usageFilter, ...filter };
    this.notify('Updated usage telemetry filter');
  }

  public openInspector(kind: PrototypeState['inspectorSheet']['kind'], entityId?: string) {
    this.state.inspectorSheet = {
      isOpen: true,
      kind,
      entityId,
    };
    this.notify(`Opened inspector sheet: ${kind}`);
  }

  public closeInspector() {
    this.state.inspectorSheet = {
      isOpen: false,
      kind: 'none',
      entityId: undefined,
    };
    this.notify('Closed inspector sheet');
  }

  public toggleReviewDrawer(open?: boolean) {
    this.state.reviewDrawerOpen = open !== undefined ? open : !this.state.reviewDrawerOpen;
    this.notify(this.state.reviewDrawerOpen ? 'Opened owner review panel' : 'Closed owner review panel');
  }

  // --- Task Journey Actions (ADR-0006) ---

  private evaluateTaskLeadEligibility(task: TaskItem, leadAgentId = task.taskLeadId): CollaborationEligibility {
    const project = this.state.projects.find((candidate) => candidate.id === task.projectId);
    if (!project || project.status !== 'active') {
      return {
        success: false,
        reason: `Task lead cannot advance because Project "${project?.displayName ?? task.projectId}" is unavailable.`,
      };
    }
    const lead = this.state.agents.find((candidate) => candidate.id === leadAgentId);
    const membership = project.memberships.find(
      (candidate) =>
        candidate.memberId === leadAgentId &&
        candidate.memberKind === 'agent' &&
        candidate.status === 'active'
    );
    if (!lead || lead.status !== 'active' || !membership) {
      return {
        success: false,
        reason: `Task lead "${lead?.displayName ?? leadAgentId}" must be an active global Agent with current active Project membership.`,
      };
    }
    return { success: true };
  }

  /**
   * Completion claims judge an immutable Task content version, not whatever
   * happens to be current when a Human opens the validation control.  Keep
   * the lookup at the state boundary so validation can distinguish a
   * legitimate historical claim from a forged or no-longer-recorded version.
   */
  private findTaskContentVersion(task: TaskItem, version: number) {
    if (!Number.isInteger(version) || version < 1) return undefined;
    if (task.currentVersion.version === version) return task.currentVersion;
    return task.historyVersions.find((candidate) => candidate.version === version);
  }

  private keepTaskBlockedForLeadSelection(task: TaskItem, reason: string) {
    task.lifecycle = 'blocked';
    if (!task.activeBlocker?.id.startsWith('blocker-lead-')) {
      task.activeBlocker = {
        id: `blocker-lead-${Date.now()}`,
        reason,
        requiredNextAction: 'Operator must assign an active Project Agent as replacement Task Lead through Task content revision.',
        responsibleActor: 'Operator (Human)',
        whoAdvancesWhenCleared: 'Replacement Task Lead',
        createdAt: 'Just now',
      };
    }
  }

  private canReturnTaskToActive(task: TaskItem, action: string): boolean {
    const leadEligibility = this.evaluateTaskLeadEligibility(task);
    if (!leadEligibility.success) {
      this.keepTaskBlockedForLeadSelection(task, leadEligibility.reason ?? 'Task lead is unavailable.');
      this.notify(`Cannot ${action} Task #${task.id}: ${leadEligibility.reason} Human lead replacement is required.`);
      return false;
    }
    if (task.activeBlocker?.id.startsWith('blocker-lead-')) {
      this.keepTaskBlockedForLeadSelection(
        task,
        'Task lead responsibility must be confirmed by a Human through Task content revision.'
      );
      this.notify(`Cannot ${action} Task #${task.id}: the lead blocker requires Human replacement/content revision and cannot be cleared generically.`);
      return false;
    }
    if (task.activeBlocker) {
      task.lifecycle = 'blocked';
      this.notify(`Cannot ${action} Task #${task.id}: its routable blocker is still unresolved.`);
      return false;
    }
    if (task.agentRunLifecycle === 'running' || task.activeRunId) {
      this.notify(`Cannot ${action} Task #${task.id}: an active run must settle before active advancement resumes.`);
      return false;
    }
    if (task.leaseLifecycle !== 'held') {
      this.notify(`Cannot ${action} Task #${task.id}: only the normal Task begin or recovery boundary may establish a held lease.`);
      return false;
    }
    return true;
  }

  /**
   * Check the Task-held resource boundary before changing lifecycle state.
   *
   * The prototype keeps the Task lease and the Environment projection as two
   * durable facts.  A lifecycle action that releases or recovers a lease must
   * therefore validate both facts instead of trusting the button that called
   * it.  The non-release controls intentionally do not require the seeded
   * Environment projection's holder id: older prototype fixtures can show more
   * than one Task's historical held lease on the same host. Recovery and
   * emergency release always require an exact Task-held match; normal end
   * preserves a different current holder rather than releasing it.
   */
  private checkTaskLease(
    task: TaskItem,
    action: string,
    expected: 'held' | 'recovering',
    requireHolderMatch: boolean
  ): { success: true; env: EnvironmentInstance } | { success: false; reason: string } {
    if (task.leaseLifecycle !== expected) {
      return {
        success: false,
        reason: `Cannot ${action} Task #${task.id}: Task lease is ${task.leaseLifecycle}, expected ${expected}.`,
      };
    }
    if (!task.selectedEnvironmentId) {
      return { success: false, reason: `Cannot ${action} Task #${task.id}: no bound Environment lease exists.` };
    }
    const env = this.state.environments.find((candidate) => candidate.id === task.selectedEnvironmentId);
    if (!env) {
      return { success: false, reason: `Cannot ${action} Task #${task.id}: bound Environment is unavailable.` };
    }
    if (expected === 'held' && (env.workSafety === 'recovery' || env.leaseRecovery)) {
      return {
        success: false,
        reason: `Cannot ${action} Task #${task.id}: Environment ${env.id} still has unresolved lease-recovery evidence.`,
      };
    }
    if (expected === 'recovering' && (env.workSafety !== 'recovery' || !env.leaseRecovery)) {
      return {
        success: false,
        reason: `Cannot ${action} Task #${task.id}: matching Environment lease recovery evidence is required.`,
      };
    }
    if (requireHolderMatch && (
      env.activeLeaseHolder?.holderKind !== 'task' ||
      env.activeLeaseHolder.holderId !== task.id ||
      env.activeLeaseHolder.projectId !== task.projectId
    )) {
      return {
        success: false,
        reason: `Cannot ${action} Task #${task.id}: Environment ${env.id} is not held by this Task.`,
      };
    }
    return { success: true, env };
  }

  /** Stop every still-running nested run before a terminal Task transition. */
  private stopTaskRuns(task: TaskItem, reason: string): { success: true } | { success: false; reason: string } {
    const runningRuns = task.runs.filter((run) => run.lifecycle === 'running');
    if (task.agentRunLifecycle === 'running' && runningRuns.length === 0) {
      return {
        success: false,
        reason: `Cannot end Task #${task.id}: the active run fact has no running run record to settle.`,
      };
    }

    for (const run of runningRuns) {
      run.lifecycle = 'stopped';
      run.settledAt = 'Just now';
      run.stopRequestedBy = reason;
      run.events.push({ time: 'Just now', kind: 'status_change', summary: `${reason} settled the active run before Task end.` });
    }
    if (runningRuns.length > 0 || task.agentRunLifecycle === 'running') {
      task.agentRunLifecycle = 'stopped';
    }
    delete task.activeRunId;
    return { success: true };
  }

  /**
   * Complete the safe Task-end boundary after its lease and run checks pass.
   * This is the only normal cancellation/completion path that clears an
   * Environment lease projection or lease-recovery evidence.
   */
  private completeTaskEnd(
    task: TaskItem,
    terminal: 'completed' | 'cancelled',
    env: EnvironmentInstance
  ) {
    task.lifecycle = terminal;
    task.agentRunLifecycle = 'none';
    task.leaseLifecycle = 'released';
    delete task.activeRunId;
    delete task.pendingCompletionClaim;
    delete task.activeBlocker;
    delete task.recoveryReason;

    const ownsEnvironmentProjection =
      env.activeLeaseHolder?.holderKind === 'task' &&
      env.activeLeaseHolder.holderId === task.id &&
      env.activeLeaseHolder.projectId === task.projectId;
    if (ownsEnvironmentProjection) {
      delete env.activeLeaseHolder;
      // Safe Task end is the lease/recovery boundary: no stale recovery
      // marker may survive a terminal Task with a released Environment.
      delete env.leaseRecovery;
      env.workSafety = 'clear';
      env.trafficLight = 'green';
      env.trafficLightReason = terminal === 'completed'
        ? 'Task completed cleanly · Scratch context recycled by worker · Lease released'
        : 'Task discarded cleanly · Scratch context recycled by worker · Lease released';
    }
    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== task.id);
  }

  public approveAndBeginProposal(taskId: string, environmentId: string, leadAgentId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'proposed') return { success: false, reason: 'Task proposal is unavailable.' };
    if (task.leaseLifecycle !== 'none' || task.agentRunLifecycle !== 'none' || task.activeRunId) {
      const reason = `Cannot approve & begin Task #${taskId}: proposal contains an unexpected lease or run fact.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const admission = this.evaluateTaskAdmission(taskId, environmentId, leadAgentId);
    const selectedOption = admission.selectedOption;
    if (!selectedOption) {
      const reason = admission.rejectionReason || admission.envIneligibilityReason || 'No compatible configured work option is available.';
      this.notify(`Cannot approve & begin Task #${taskId.replace('task-', '')}: ${reason}`);
      return { success: false, reason };
    }

    task.selectedEnvironmentId = environmentId;
    task.taskLeadId = leadAgentId;
    task.lifecycle = 'active';
    task.agentRunLifecycle = 'none';
    task.leaseLifecycle = 'held';

    // Simulate automatic first run submission for Agent lead
    const newRunId = `run-${Date.now().toString().slice(-3)}`;
    const leadAgent = this.state.agents.find((a) => a.id === leadAgentId)!;
    const env = this.state.environments.find((candidate) => candidate.id === environmentId)!;
    const newRun: NestedAgentRun = {
      id: newRunId,
      taskId: task.id,
      agentId: leadAgentId,
      agentDisplayName: leadAgent ? leadAgent.displayName : leadAgentId,
      engine: selectedOption.engine,
      workModel: selectedOption.workModel,
      effort: selectedOption.effort,
      agentConfigVersionUsed: leadAgent.version ?? 1,
      contentVersionUsed: task.currentVersion.version,
      lifecycle: 'running',
      startedAt: 'Just now',
      events: [
        { time: 'Just now', kind: 'status_change', summary: `Task begin approved by Human; Task lease acquired on ${environmentId}` },
        { time: 'Just now', kind: 'status_change', summary: `First lead run initiated for ${leadAgentId}` },
      ],
    };

    task.runs.unshift(newRun);
    task.activeRunId = newRunId;
    task.agentRunLifecycle = 'running';
    env.activeLeaseHolder = {
      holderKind: 'task',
      holderId: task.id,
      projectId: task.projectId,
      acquiredAt: 'Just now',
      taskTitle: task.currentVersion.title,
      leadAgentName: leadAgent.displayName,
    };

    this.notify(`Approved & began Task #${taskId} on ${environmentId} using ${selectedOption.engine} · ${selectedOption.workModel}. Lease held, first lead run started.`);
    return { success: true };
  }

  public pauseTask(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };

    // Validation is itself a deliberate Human hold.  A Human may place a
    // settled completion claim on the paused surface without resuming work;
    // the claim, lease, and run history remain available for validation.
    if (task.lifecycle === 'awaiting validation') {
      if (!task.pendingCompletionClaim) {
        const reason = `Cannot pause Task #${taskId}: awaiting-validation state has no completion claim.`;
        this.notify(reason);
        return { success: false, reason };
      }
      const leaseCheck = this.checkTaskLease(task, 'pause', 'held', false);
      if (!leaseCheck.success) {
        this.notify(leaseCheck.reason);
        return leaseCheck;
      }
      if (task.agentRunLifecycle === 'running') {
        const reason = `Cannot pause Task #${taskId}: completion claim cannot coexist with an active run.`;
        this.notify(reason);
        return { success: false, reason };
      }
      if (task.activeRunId) {
        const settledRun = task.runs.find((run) => run.id === task.activeRunId);
        if (!settledRun || settledRun.lifecycle === 'running') {
          const reason = `Cannot pause Task #${taskId}: the claimed run pointer is not settled.`;
          this.notify(reason);
          return { success: false, reason };
        }
        delete task.activeRunId;
      }
      task.lifecycle = 'paused';
      this.notify(`Paused Task #${taskId} while its completion claim awaits Human validation. Lease remains held.`);
      return { success: true };
    }

    if (task.lifecycle === 'Task pause requested' || task.lifecycle === 'paused') {
      const leaseCheck = this.checkTaskLease(task, 'pause', 'held', false);
      if (!leaseCheck.success) {
        this.notify(leaseCheck.reason);
        return leaseCheck;
      }
      if (task.lifecycle === 'Task pause requested') {
        const activeRun = task.activeRunId
          ? task.runs.find((run) => run.id === task.activeRunId)
          : undefined;
        if (task.agentRunLifecycle !== 'running' || !activeRun || activeRun.lifecycle !== 'running') {
          const reason = `Cannot pause Task #${taskId}: pause-requested state has no coherent active run.`;
          this.notify(reason);
          return { success: false, reason };
        }
      } else if (task.agentRunLifecycle === 'running' || task.activeRunId) {
        const reason = `Cannot pause Task #${taskId}: paused state cannot retain an active run.`;
        this.notify(reason);
        return { success: false, reason };
      }
      return { success: true };
    }
    if (task.lifecycle !== 'active') {
      const reason = `Cannot pause Task #${taskId}: only an active Task with a held lease may be paused.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const leaseCheck = this.checkTaskLease(task, 'pause', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }

    if (task.agentRunLifecycle === 'running') {
      const activeRun = task.activeRunId
        ? task.runs.find((run) => run.id === task.activeRunId)
        : undefined;
      if (!activeRun || activeRun.lifecycle !== 'running') {
        const reason = `Cannot pause Task #${taskId}: active run state is inconsistent and cannot be placed on hold.`;
        this.notify(reason);
        return { success: false, reason };
      }
      // Stage 1: Pause requested (admission hold: current run finishes naturally)
      task.lifecycle = 'Task pause requested';
      this.notify(`Requested pause for Task #${taskId}: admission hold active; active run settling.`);
    } else {
      if (task.activeRunId) delete task.activeRunId;
      task.lifecycle = 'paused';
      this.notify(`Paused Task #${taskId}. Lease remains held.`);
    }
    return { success: true };
  }

  public interruptActiveRun(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (task.lifecycle !== 'active' && task.lifecycle !== 'Task pause requested') {
      const reason = `Cannot interrupt Task #${taskId}: no active Task run may be interrupted from ${task.lifecycle}.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'interrupt', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }
    if (!task.activeRunId) {
      const reason = `Cannot interrupt Task #${taskId}: no active run is recorded.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const run = task.runs.find((r) => r.id === task.activeRunId);
    if (!run || run.lifecycle !== 'running') {
      const reason = `Cannot interrupt Task #${taskId}: active run record is not running.`;
      this.notify(reason);
      return { success: false, reason };
    }

    run.lifecycle = 'stopped';
    run.settledAt = 'Just now';
    run.stopRequestedBy = 'Operator (Human Interrupt)';
    run.events.push({ time: 'Just now', kind: 'status_change', summary: 'Run intentionally stopped by Human Interrupt.' });
    task.agentRunLifecycle = 'stopped';
    task.lifecycle = 'paused';
    delete task.activeRunId;

    this.notify(`Interrupted active run in Task #${taskId}. Run stopped; Task paused; Lease retained.`);
    return { success: true };
  }

  public resumeTask(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (task.lifecycle !== 'paused') {
      const reason = `Cannot resume Task #${taskId}: only a paused Task may resume deliberate advancement.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'resume', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }
    if (task.pendingCompletionClaim) {
      const reason = `Cannot resume Task #${taskId}: Human must validate or require correction for the pending completion claim first.`;
      this.notify(reason);
      return { success: false, reason };
    }

    if (task.activeRunId || task.agentRunLifecycle === 'running') {
      const reason = `Cannot resume Task #${taskId}: an active run must settle before Task resume.`;
      this.notify(reason);
      return { success: false, reason };
    }

    if (!this.canReturnTaskToActive(task, 'resume')) return { success: false, reason: 'Task remains blocked.' };

    task.lifecycle = 'active';
    task.agentRunLifecycle = 'none';
    this.notify(`Resumed Task #${taskId} to active deliberate advancement. Lease held.`);
    return { success: true };
  }

  public updateTaskContentVersion(
    taskId: string,
    newTitle: string,
    newGoal: string,
    newConstraints: string[],
    newValidationCriteria: string[],
    newLeadId: string
  ): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled' || task.lifecycle === 'rejected' || task.lifecycle === 'withdrawn') {
      const reason = `Cannot revise completed Task #${taskId}: terminal Task content is immutable.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.lifecycle === 'proposed') {
      if (task.leaseLifecycle !== 'none' || task.agentRunLifecycle !== 'none' || task.activeRunId) {
        const reason = `Cannot revise Task proposal #${taskId}: proposal contains an unexpected lease or run fact.`;
        this.notify(reason);
        return { success: false, reason };
      }
    } else if (task.lifecycle === 'recovery' || task.leaseLifecycle === 'recovering') {
      const leaseCheck = this.checkTaskLease(task, 'revise Task content', 'recovering', true);
      if (!leaseCheck.success) {
        this.notify(leaseCheck.reason);
        return leaseCheck;
      }
    } else {
      const leaseCheck = this.checkTaskLease(task, 'revise Task content', 'held', false);
      if (!leaseCheck.success) {
        this.notify(leaseCheck.reason);
        return leaseCheck;
      }
    }
    const leadEligibility = this.evaluateTaskLeadEligibility(task, newLeadId);
    if (!leadEligibility.success) {
      const reason = `Cannot revise Task responsibility: lead "${newLeadId}" must be an active global Agent with current active Project membership. Existing content and lead remain unchanged.`;
      this.notify(reason);
      return { success: false, reason };
    }

    task.historyVersions.push({ ...task.currentVersion });
    const nextVer = task.currentVersion.version + 1;
    task.currentVersion = {
      version: nextVer,
      createdAt: 'Just now',
      createdBy: 'Operator (Human edit)',
      title: newTitle,
      goal: newGoal,
      constraints: newConstraints,
      validationCriteria: newValidationCriteria,
      taskLeadId: newLeadId,
      changeNote: `Version ${nextVer} created by operator.`,
    };
    task.taskLeadId = newLeadId;
    if (task.activeBlocker?.id.startsWith('blocker-lead-')) {
      delete task.activeBlocker;
      if (task.lifecycle === 'blocked' && task.leaseLifecycle === 'held') {
        task.lifecycle = 'active';
      } else if (task.lifecycle === 'blocked' && task.leaseLifecycle === 'recovering') {
        // Lead replacement resolves responsibility, not Environment recovery.
        // Return to the Human recovery boundary rather than fabricating active
        // work or a held lease.
        task.lifecycle = 'recovery';
      }
    }

    this.notify(`Created Task content version v${nextVer} for Task #${taskId}. Active runs continue on prior version; future runs will use v${nextVer}.`);
    return { success: true };
  }

  public resolveBlocker(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (!task.activeBlocker) return { success: false, reason: 'Task has no active blocker.' };
    if (task.lifecycle === 'proposed') {
      this.notify(`Cannot clear proposal blocker for Task #${taskId} without selecting an eligible lead. Proposal still holds no lease and admits no run.`);
      return { success: false, reason: 'Task proposal blockers require Human lead/content revision.' };
    }
    const wasPaused = task.lifecycle === 'paused';
    if (task.lifecycle !== 'blocked' && !wasPaused) {
      const reason = `Cannot resolve blocker on Task #${taskId}: Task lifecycle is ${task.lifecycle}, not blocked or paused.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'resolve blocker', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }

    const leadEligibility = this.evaluateTaskLeadEligibility(task);
    if (!leadEligibility.success) {
      this.keepTaskBlockedForLeadSelection(task, leadEligibility.reason ?? 'Task lead is unavailable.');
      this.notify(`Cannot resolve blocker on Task #${taskId}: ${leadEligibility.reason} Human lead replacement is required.`);
      return { success: false, reason: leadEligibility.reason ?? 'Task lead is unavailable.' };
    }
    if (task.activeBlocker.id.startsWith('blocker-lead-')) {
      this.keepTaskBlockedForLeadSelection(
        task,
        'Task lead responsibility must be confirmed by a Human through Task content revision.'
      );
      this.notify(`Cannot clear lead blocker on Task #${taskId} generically. Human replacement/content revision must select an eligible lead.`);
      return { success: false, reason: 'Human lead replacement/content revision is required.' };
    }

    delete task.activeBlocker;
    if (!wasPaused) task.lifecycle = 'active';
    if (!task.pendingCompletionClaim) {
      this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);
    }

    this.notify(
      wasPaused
        ? `Resolved blocker on paused Task #${taskId}. Admission hold and lease remain in place until Human Resume.`
        : `Resolved blocker on Task #${taskId}. Returned to active advancement.`
    );
    return { success: true };
  }

  public validateTaskCompletion(
    taskId: string,
    decision: 'accept' | 'require_correction',
    correctionNotes?: string
  ): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (!task.pendingCompletionClaim) return { success: false, reason: 'Task has no pending completion claim.' };

    // Validation is state-authoritative. A stale claim cannot end a blocked,
    // proposed, recovering, or otherwise ineligible Task merely because the
    // claim object survived a later membership change. A paused Task is an
    // intentional admission hold, so it is a valid validation surface too.
    const leadEligibility = this.evaluateTaskLeadEligibility(task);
    if (!leadEligibility.success) {
      if (task.lifecycle !== 'proposed' && task.lifecycle !== 'completed' && task.lifecycle !== 'cancelled') {
        this.keepTaskBlockedForLeadSelection(task, leadEligibility.reason ?? 'Task lead is unavailable.');
      }
      const reason = `Cannot validate Task #${taskId}: ${leadEligibility.reason} Human lead replacement is required.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.lifecycle !== 'awaiting validation' && task.lifecycle !== 'paused') {
      const reason = `Cannot validate Task #${taskId}: current Task lifecycle is ${task.lifecycle}; awaiting validation or paused is required.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const claim = task.pendingCompletionClaim;
    const claimedVersion = this.findTaskContentVersion(task, claim.contentVersion);
    if (!claimedVersion) {
      const reason = `Cannot validate Task #${taskId}: completion claim references an unrecorded Task content version.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (claimedVersion.taskLeadId !== claim.submittedByLeadId) {
      const reason = `Cannot validate Task #${taskId}: completion claim attribution does not match the lead recorded by its Task content version.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.currentVersion.taskLeadId !== task.taskLeadId) {
      const reason = `Cannot validate Task #${taskId}: current Task lead facts are inconsistent with the current content version.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.activeBlocker) {
      const reason = `Cannot validate Task #${taskId}: its active blocker must be resolved before completion validation.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'validate completion', 'held', true);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }

    if (task.agentRunLifecycle === 'running') {
      const reason = `Cannot validate Task #${taskId}: active run ${task.activeRunId ?? 'unknown'} must settle before validation.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.activeRunId) {
      const historicalRun = task.runs.find((run) => run.id === task.activeRunId);
      if (!historicalRun || historicalRun.lifecycle === 'running') {
        const reason = `Cannot validate Task #${taskId}: active run pointer is not settled.`;
        this.notify(reason);
        return { success: false, reason };
      }
    }

    if (decision === 'accept') {
      this.completeTaskEnd(task, 'completed', leaseCheck.env);
      this.notify(`Accepted Task #${taskId} completion claim! Task context recycled, lease safely released, Task completed.`);
      return { success: true };
    } else {
      const wasPaused = task.lifecycle === 'paused';
      if (wasPaused) {
        // Requiring correction records the Human decision but does not
        // override a prior pause.  The next run remains an explicit Human
        // Resume decision, and no admission evaluation or run is started.
        delete task.pendingCompletionClaim;
        delete task.activeRunId;
        task.lifecycle = 'paused';
        this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);
        this.notify(`Required correction on paused Task #${taskId}. Lease and admission hold remain until Human Resume.`);
        return { success: true };
      }

      const admission = this.evaluateTaskAdmission(task.id, task.selectedEnvironmentId || '', task.taskLeadId);
      const selectedOption = admission.selectedOption;
      if (!selectedOption) {
        const reason = admission.rejectionReason || admission.envIneligibilityReason || 'no compatible configured work option is available.';
        this.notify(`Cannot require correction for Task #${taskId}: ${reason}`);
        return { success: false, reason };
      }
      task.lifecycle = 'active';
      delete task.pendingCompletionClaim;
      delete task.activeRunId;
      this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);

      // Add a note to history
      const correctionRun: NestedAgentRun = {
        id: `run-${Date.now().toString().slice(-3)}`,
        taskId: task.id,
        agentId: task.taskLeadId,
        agentDisplayName: task.taskLeadId,
        engine: selectedOption.engine,
        workModel: selectedOption.workModel,
        effort: selectedOption.effort,
        agentConfigVersionUsed: admission.agent?.version ?? 1,
        contentVersionUsed: task.currentVersion.version,
        lifecycle: 'running',
        startedAt: 'Just now',
        events: [
          { time: 'Just now', kind: 'status_change', summary: `Human required correction: ${correctionNotes ?? 'Refine implementation.'}` },
        ],
      };
      task.runs.unshift(correctionRun);
      task.activeRunId = correctionRun.id;
      task.agentRunLifecycle = 'running';

      this.notify(`Required correction on Task #${taskId}. Retained Environment lease, started deliberate correction advance.`);
      return { success: true };
    }
  }

  public discardTask(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (task.lifecycle === 'cancelled') return { success: true };
    if (task.lifecycle === 'completed' || task.lifecycle === 'rejected' || task.lifecycle === 'withdrawn') {
      const reason = `Cannot discard Task #${taskId}: terminal Task lifecycle is ${task.lifecycle}.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.lifecycle === 'proposed') {
      const reason = `Cannot discard proposed Task #${taskId}: withdraw or reject the proposal without pretending it held a lease.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (task.lifecycle === 'recovery' || task.leaseLifecycle === 'recovering') {
      return this.discardOrdinaryRecovery(taskId);
    }

    if (!['active', 'Task pause requested', 'paused', 'blocked', 'awaiting validation'].includes(task.lifecycle)) {
      const reason = `Cannot discard Task #${taskId}: lifecycle ${task.lifecycle} is not a safe Task-end state.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'discard', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }
    const runStop = this.stopTaskRuns(task, 'Operator (Human Discard)');
    if (!runStop.success) {
      this.notify(runStop.reason);
      return runStop;
    }
    this.completeTaskEnd(task, 'cancelled', leaseCheck.env);
    this.notify(`Discarded Task #${taskId}. Safe Task end completed: scratch context recycled, lease released, Project workspace preserved.`);
    return { success: true };
  }

  // --- Recovery & Force Release Actions (ADR-0006, ADR-0009) ---

  public triggerSimulatedWorkerDisconnect(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    // Prefer the Task with an actual running turn when several historical
    // held-lease fixtures point at the same Environment. A disconnect must
    // record the run that was interrupted rather than a hard-coded fixture
    // id, and the run must no longer remain falsely runnable in recovery.
    const heldTasks = this.state.tasks.filter(
      (candidate) => candidate.selectedEnvironmentId === envId && candidate.leaseLifecycle === 'held'
    );
    const projectedTask = heldTasks.find(
      (candidate) =>
        env.activeLeaseHolder?.holderKind === 'task' &&
        env.activeLeaseHolder.holderId === candidate.id &&
        env.activeLeaseHolder.projectId === candidate.projectId
    );
    const task = projectedTask ?? heldTasks.find(
      (candidate) =>
        candidate.agentRunLifecycle === 'running' || candidate.runs.some((run) => run.lifecycle === 'running')
    ) ?? heldTasks[0];
    const activeRun = task
      ? (task.activeRunId
        ? task.runs.find((run) => run.id === task.activeRunId && run.lifecycle === 'running') ?? task.runs.find((run) => run.lifecycle === 'running')
        : task.runs.find((run) => run.lifecycle === 'running'))
      : undefined;
    const runningRuns = task?.runs.filter((run) => run.lifecycle === 'running') ?? [];

    env.connectionState = 'offline';
    env.trafficLight = 'red';
    env.trafficLightReason = 'Worker connection lost mid-turn · Lease recovery required';
    env.workSafety = 'recovery';
    env.leaseRecovery = {
      cause: 'Carrier TCP connection timed out during active turn execution.',
      interruptedRunId: activeRun?.id,
      interruptedRunAgent: activeRun?.agentDisplayName,
      unresolvedFacts: [
        'Worker process unreachable over carrier overlay',
        'Engine process status unverified',
        'Task context directory not yet recycled',
      ],
    };

    // Mark task in recovery
    if (task) {
      for (const run of runningRuns) {
        run.lifecycle = 'interrupted';
        run.settledAt = 'Just now';
        run.interruptionReason = 'Worker channel lost while the run was executing.';
        run.events.push({
          time: 'Just now',
          kind: 'status_change',
          summary: 'INTERRUPTED: Worker channel lost; run retained for Human recovery decision.',
        });
      }
      task.lifecycle = 'recovery';
      task.agentRunLifecycle = 'interrupted';
      task.leaseLifecycle = 'recovering';
      delete task.activeRunId;
      task.recoveryReason = 'Host worker channel lost mid-flight.';
    }

    this.state.attentionItems.unshift({
      id: `att-rec-${Date.now()}`,
      severity: 'action_required',
      category: 'task_recovery',
      title: `Recovery Required on ${env.displayName}`,
      summary: 'Carrier channel lost during active run. Lease held in recovery.',
      referenceId: task?.id ?? env.id,
      referenceType: task ? 'task' : 'environment',
      actionLabel: 'Inspect Recovery in Tasks',
      actionTargetView: 'tasks',
      targetNav: 'project',
      targetProjectTab: 'tasks',
      timestamp: 'Just now',
      lifecycleSentence: 'Task recovery · Run interrupted · Lease recovering',
      attribution: `Worker (${env.displayName})`,
    });

    this.notify(`Simulated worker disconnect on ${envId}. Lease locked in recovery; no automatic reassignment.`);
  }

  public resumeOrdinaryRecovery(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    const isRecoveryLifecycle = task.lifecycle === 'recovery' ||
      (task.lifecycle === 'blocked' && task.leaseLifecycle === 'recovering');
    if (!isRecoveryLifecycle) {
      const reason = `Cannot resume ordinary recovery for Task #${taskId}: lifecycle is ${task.lifecycle}.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'resume ordinary recovery', 'recovering', true);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }
    const runStop = this.stopTaskRuns(task, 'Worker recovery reconciliation');
    if (!runStop.success) {
      this.notify(runStop.reason);
      return runStop;
    }

    task.agentRunLifecycle = 'none';
    task.leaseLifecycle = 'held';
    delete task.recoveryReason;

    if (task.selectedEnvironmentId) {
      const env = this.state.environments.find((e) => e.id === task.selectedEnvironmentId);
      if (env) {
        env.connectionState = 'online';
        env.workSafety = 'clear';
        env.trafficLight = 'green';
        env.trafficLightReason = 'Reconnected & reconciled · Lease held by Task';
        delete env.leaseRecovery;
      }
    }

    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);
    if (!this.canReturnTaskToActive(task, 'resume recovery for')) {
      this.notify(`Ordinary recovery reconciled Task #${taskId}, but it remains blocked until a Human selects an eligible replacement lead.`);
      return { success: false, reason: 'Task remains blocked pending eligible lead replacement.' };
    }
    task.lifecycle = 'active';
    this.notify(`Ordinary recovery: Resumed Task #${taskId} on same Environment. Interrupted run recorded as history fact.`);
    return { success: true };
  }

  public emergencyForceRelease(
    envId: string,
    taskId: string,
    reason: string,
    acknowledgedRisks: boolean
  ): { success: boolean; reason?: string } {
    if (!acknowledgedRisks) return { success: false, reason: 'Risk acknowledgement is required.' };

    const env = this.state.environments.find((e) => e.id === envId);
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!env) return { success: false, reason: `Cannot force release: Environment ${envId} was not found.` };
    if (!task) return { success: false, reason: `Cannot force release Environment ${envId}: its owning Task was not found.` };
    if (task.selectedEnvironmentId !== env.id) {
      const failure = `Cannot force release Environment ${envId}: Task #${taskId} is not bound to this Environment.`;
      this.notify(failure);
      return { success: false, reason: failure };
    }
    const isRecoveryLifecycle = task.lifecycle === 'recovery' ||
      (task.lifecycle === 'blocked' && task.leaseLifecycle === 'recovering');
    if (!isRecoveryLifecycle) {
      const failure = `Cannot force release Task #${taskId}: only a Task in recovery may use the emergency boundary.`;
      this.notify(failure);
      return { success: false, reason: failure };
    }
    const leaseCheck = this.checkTaskLease(task, 'force release', 'recovering', true);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }
    const runStop = this.stopTaskRuns(task, 'Operator (Human Emergency Force Release)');
    if (!runStop.success) {
      this.notify(runStop.reason);
      return runStop;
    }

    const unresolvedFacts = [...(env.leaseRecovery?.unresolvedFacts ?? ['Unverified host cleanup'])];
    const timestamp = new Date().toISOString();
    task.forcedReleaseDisposition = {
      actor: 'Operator (Human Emergency Force Release)',
      timestamp,
      reason,
      unresolvedFacts,
      risksAcknowledged: true,
    };
    this.completeTaskEnd(task, 'cancelled', env);
    env.trafficLightReason = `Force Released by Operator: "${reason}". Environment reassignable.`;
    env.forcedReleaseRecord = {
      actor: 'Operator (Human Emergency Force Release)',
      timestamp,
      reason,
      unresolvedFacts,
      risksAcknowledged: true,
    };
    env.probeHistory = env.probeHistory || [];
    env.probeHistory.unshift({
      id: `pr-fr-${Date.now()}`,
      timestamp: 'Just now',
      latencyMs: 0,
      protocolOk: true,
      enginesOk: true,
      capabilitiesOk: true,
      summary: `EMERGENCY FORCE RELEASE authorized: ${reason}`,
    });

    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId && a.referenceId !== envId);
    this.closeInspector();

    this.notify(`EMERGENCY FORCE RELEASE authorized by Operator. Task #${taskId} cancelled with permanent forced release disposition. Environment ${envId} reassignable.`);
    return { success: true };
  }

  // --- Project, Messaging & Routing Actions (ADR-0007, ADR-0008) ---

  private checkAgentProjectEligibility(
    project: ProjectItem,
    agentId: string,
    action: string
  ): CollaborationEligibility {
    const agent = this.state.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      return {
        success: false,
        reason: `Cannot ${action}: Agent "${agentId}" does not exist. The target was not substituted.`,
      };
    }
    if (agent.status === 'archived') {
      return {
        success: false,
        reason: `Cannot ${action} Agent "${agent.displayName}": Agent is archived. Restore the Agent first; history remains review-only (ADR-0008).`,
      };
    }

    const membership = project.memberships.find(
      (candidate) => candidate.memberId === agentId && candidate.memberKind === 'agent'
    );
    if (!membership || membership.status !== 'active') {
      return {
        success: false,
        reason: `Cannot ${action} Agent "${agent.displayName}": an active Project membership is required. The target was not substituted.`,
      };
    }
    return { success: true };
  }

  private getRetainedWorkingGroupMemberIds(group: ProjectItem['workingGroups'][number]): string[] {
    return Array.from(new Set(group.retainedMemberIds ?? group.memberIds));
  }

  private ensureWorkingGroupMembershipHistory(group: ProjectItem['workingGroups'][number]) {
    if (group.membershipHistory) return;
    group.membershipHistory = this.getRetainedWorkingGroupMemberIds(group).map((memberId) => ({
      memberId,
      joinedAt: group.createdAt,
    }));
  }

  public evaluateWorkingGroupEligibility(
    projectId: string,
    workingGroupId: string,
    operation: 'message' | 'restore' = 'message'
  ): CollaborationEligibility {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const projectMutationCheck = this.checkActiveProjectMutation(
      project,
      operation === 'restore' ? 'restore a Working Group' : 'send a Working Group message',
      false
    );
    if (!projectMutationCheck.success) return projectMutationCheck;

    const group = project.workingGroups.find((candidate) => candidate.id === workingGroupId);
    if (!group) return { success: false, reason: 'Working Group not found' };
    if (operation === 'message' && group.status !== 'active') {
      return {
        success: false,
        reason: `Cannot send a message: Working Group "${group.displayName}" is disbanded. History remains readable.`,
      };
    }
    if (operation === 'restore' && group.status !== 'disbanded') {
      return { success: false, reason: `Working Group "${group.displayName}" is already active.` };
    }

    const memberIds = operation === 'restore' ? this.getRetainedWorkingGroupMemberIds(group) : group.memberIds;
    for (const memberId of memberIds) {
      const membership = project.memberships.find((candidate) => candidate.memberId === memberId);
      if (!membership || membership.status !== 'active') {
        const displayName = membership?.displayName ?? memberId;
        return {
          success: false,
          reason: `Cannot ${operation} Working Group "${group.displayName}": member "${displayName}" no longer has an active Project membership. Group history remains review-only (ADR-0008).`,
        };
      }
      if (membership.memberKind === 'agent') {
        const agentEligibility = this.checkAgentProjectEligibility(
          project,
          memberId,
          operation === 'restore' ? `restore Working Group with` : `send a Working Group message to`
        );
        if (!agentEligibility.success) {
          return {
            success: false,
            reason: `Cannot ${operation} Working Group "${group.displayName}": ${agentEligibility.reason}`,
          };
        }
      }
    }
    return { success: true };
  }

  private resolveDeterministicRouting(
    project: ProjectItem,
    scope: MessageItem['scope'],
    content: string
  ): NonNullable<MessageItem['deterministicRoutingOutcomes']> {
    if (scope.kind === 'direct-message') {
      const agent = this.state.agents.find((candidate) => candidate.id === scope.recipientId);
      return [
        {
          targetAgentId: scope.recipientId,
          targetDisplayName: agent?.displayName,
          status: 'admitted',
          reason: 'Project-scoped direct Message deterministically admitted.',
        },
      ];
    }

    const tokens = extractExactMentionTokens(content);
    if (tokens.length === 0) return [];

    const outcomes = new Map<string, NonNullable<MessageItem['deterministicRoutingOutcomes']>[number]>();
    const group =
      scope.kind === 'working-group-channel'
        ? project.workingGroups.find((candidate) => candidate.id === scope.workingGroupId)
        : undefined;
    const scopeMemberIds = group ? new Set(group.memberIds) : undefined;

    const addAgentTarget = (agentId: string, mentionLabel: string) => {
      if (outcomes.has(agentId)) return;
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      const projectEligibility = this.checkAgentProjectEligibility(project, agentId, `route exact mention ${mentionLabel} to`);
      if (!projectEligibility.success) {
        outcomes.set(agentId, {
          targetAgentId: agentId,
          targetDisplayName: agent?.displayName,
          status: 'failed',
          reason: projectEligibility.reason ?? 'Deterministic routing failed closed.',
        });
        return;
      }
      if (scopeMemberIds && !scopeMemberIds.has(agentId)) {
        outcomes.set(agentId, {
          targetAgentId: agentId,
          targetDisplayName: agent?.displayName,
          status: 'failed',
          reason: `Cannot route exact mention ${mentionLabel}: Agent "${agent?.displayName ?? agentId}" is not a current member of this Working Group. The target was not substituted.`,
        });
        return;
      }
      outcomes.set(agentId, {
        targetAgentId: agentId,
        targetDisplayName: agent?.displayName,
        status: 'admitted',
        reason: `Exact mention ${mentionLabel} deterministically admitted without wake-model judgement.`,
      });
    };

    for (const token of tokens) {
      if (token.normalized === 'all') {
        project.memberships
          .filter(
            (membership) =>
              membership.memberKind === 'agent' &&
              membership.status === 'active' &&
              (!scopeMemberIds || scopeMemberIds.has(membership.memberId))
          )
          .forEach((membership) => addAgentTarget(membership.memberId, '@all'));
        continue;
      }

      const target = this.state.agents.find(
        (candidate) =>
          candidate.id.toLowerCase() === token.normalized ||
          candidate.displayName.toLowerCase().replace(/\s+/g, '-') === token.normalized
      );
      if (!target) {
        const unknownKey = `unknown:${token.normalized}`;
        if (!outcomes.has(unknownKey)) {
          outcomes.set(unknownKey, {
            targetAgentId: token.value,
            status: 'failed',
            reason: `Cannot route exact mention @${token.value}: no matching Agent exists. The target was not substituted or sent to wake-model judgement (ADR-0007).`,
          });
        }
        continue;
      }
      addAgentTarget(target.id, `@${token.value}`);
    }

    return [...outcomes.values()];
  }

  public sendMessage(
    projectId: string,
    scope: MessageItem['scope'],
    content: string
  ): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };

    const admission = this.checkChatAdmission(project, scope);
    if (!admission.success) {
      this.notify(admission.reason);
      return admission;
    }

    const isDirect = scope.kind === 'direct-message';
    const exactMentions = isDirect ? [] : extractExactMentionTokens(content);
    const isExplicitMention = exactMentions.length > 0;
    const deterministicRoutingOutcomes =
      isDirect || isExplicitMention ? this.resolveDeterministicRouting(project, scope, content) : [];
    const newMsgId = `msg-${Date.now().toString().slice(-4)}`;

    let disposition: MessageItem['disposition'] = 'informational';
    if (isDirect || isExplicitMention) {
      disposition = 'addressed';
    } else if (project.wakePolicy === 'wake-model-assisted') {
      disposition = 'wake-eligible';
    }

    const newMsg: MessageItem = {
      id: newMsgId,
      projectId,
      scope,
      authorId: this.state.operator.id,
      authorKind: 'human',
      authorDisplayName: this.state.operator.name,
      authorAvatar: "OP",
      timestamp: 'Just now',
      content,
      disposition,
      deterministicRoutingOutcomes:
        deterministicRoutingOutcomes.length > 0 ? deterministicRoutingOutcomes : undefined,
    };

    this.state.messages.push(newMsg);

    if (disposition === 'addressed') {
      const admittedTargets = deterministicRoutingOutcomes.filter((outcome) => outcome.status === 'admitted');
      for (const target of admittedTargets) {
        // Capture each exact target now. Archive can cancel only that Agent's
        // admitted work, and no invalid target can silently fall through.
        this.scheduleProjectedReply(projectId, target.targetAgentId, 800, (agent) => {
          const replyMsgId = `msg-reply-${Date.now().toString().slice(-4)}`;
          const replyMsg: MessageItem = {
            id: replyMsgId,
            projectId,
            scope,
            authorId: agent.id,
            authorKind: 'agent',
            authorDisplayName: agent.displayName,
            authorAvatar: agent.avatar,
            timestamp: 'Just now',
            content: `Acknowledged: "${content.slice(0, 40)}...". Proceeding with deterministic execution.`,
            disposition: 'non-routing',
            agentAttribution: currentAgentExecutionAttribution(agent),
            isProjectedReply: true,
            projectedReplyMeta: {
              runId: `run-det-${Date.now().toString().slice(-3)}`,
              agentId: agent.id,
              wakeRequestId: `wake-det-${Date.now().toString().slice(-3)}`,
              triggeringMessageIds: [newMsgId],
            },
          };
          this.state.messages.push(replyMsg);
          this.notify(`Projected reply from ${agent.displayName} received (Non-routing; cannot loop-wake).`);
        }, (cancellation) => {
          if (target.status !== 'admitted') return;
          target.status = 'cancelled';
          target.reason = cancellation.reason;
          target.terminalResponsibility = {
            kind: cancellation.responsibleKind,
            id: cancellation.responsibleId,
          };
        });
      }
      const failedTargets = deterministicRoutingOutcomes.filter((outcome) => outcome.status === 'failed');
      this.notify(
        `Sent addressed message ${newMsgId}. ${admittedTargets.length} deterministic target(s) admitted; ${failedTargets.length} failed closed with durable evidence.`
      );
    } else if (disposition === 'wake-eligible') {
      // Simulate 30s batching window collection & wake model evaluation
      const batchId = `batch-${Date.now().toString().slice(-4)}`;
      const wakeTargetId = 'designer';
      const wakeTargetEligibility = this.checkAgentProjectEligibility(
        project,
        wakeTargetId,
        'admit wake-model selection for'
      );
      const wakeRequest: ResultingWakeRequestRecord = {
        wakeRequestId: `wake-${batchId}`,
        targetAgentId: wakeTargetId,
        admissionStatus: 'admitted',
      };
      if (!wakeTargetEligibility.success) {
        this.terminalizeWakeRequest(
          wakeRequest,
          'failed-closed',
          { kind: 'agent', id: wakeTargetId },
          wakeTargetEligibility.reason ?? 'Selected Agent failed current membership admission.'
        );
      }
      const batch: RoutingBatch = {
        id: batchId,
        projectId,
        openedAt: 'Just now',
        closedAt: wakeTargetEligibility.success ? 'In 30s' : 'Just now',
        inputMessageIds: [newMsgId],
        status: wakeTargetEligibility.success ? 'evaluating' : 'failed-closed',
        attemptsCount: 1,
        wakeModel: 'gpt-4o-mini',
        frozenContextSummary: {
          tokenCount: 1620,
          projectRulesIncluded: true,
          recentMessagesCount: 3,
          tasksSummariesCount: 1,
          truncated: false,
        },
        decisions: [
          {
            messageId: newMsgId,
            targetAgentId: wakeTargetId,
            status: wakeTargetEligibility.success ? 'selected' : 'failed',
            rationale: wakeTargetEligibility.success
              ? 'Unaddressed query matches Designer collaboration instructions.'
              : wakeTargetEligibility.reason ?? 'Selected Agent failed current membership admission.',
          },
        ],
        resultingWakeRequestIds: [wakeRequest.wakeRequestId],
        resultingWakeRequests: [wakeRequest],
        failureReason: wakeTargetEligibility.success
          ? undefined
          : `Wake-model selection failed current Agent admission. ${wakeTargetEligibility.reason}`,
        terminalResponsibility: wakeTargetEligibility.success
          ? undefined
          : { kind: 'agent', id: wakeTargetId },
      };
      this.state.routingBatches.unshift(batch);
      newMsg.routingCausalChainId = batchId;

      if (!wakeTargetEligibility.success) {
        this.notify(`Sent unaddressed message. Routing batch ${batchId} failed closed: ${wakeTargetEligibility.reason}`);
        return {
          success: true,
          reason: wakeTargetEligibility.reason ?? 'Wake-model selection failed current Agent admission.',
        };
      }

      this.scheduleProjectedReply(projectId, wakeTargetId, 1200, (agent) => {
        const wakeRequest = batch.resultingWakeRequests?.find(
          (candidate) => candidate.wakeRequestId === `wake-${batchId}`
        );
        const runId = `run-proj-${Date.now().toString().slice(-3)}`;
        const replyMsgId = `msg-proj-${Date.now().toString().slice(-4)}`;
        batch.status = 'settled';
        batch.closedAt = 'Just now';
        if (wakeRequest) {
          wakeRequest.linkedRunId = runId;
          wakeRequest.projectedReplyId = replyMsgId;
          this.terminalizeWakeRequest(
            wakeRequest,
            'settled',
            { kind: 'agent', id: agent.id },
            'Agent run settled and its projected reply was persisted.'
          );
        }
        const replyMsg: MessageItem = {
          id: replyMsgId,
          projectId,
          scope,
          authorId: agent.id,
          authorKind: 'agent',
          authorDisplayName: "Designer", authorAvatar: "OP",
          timestamp: 'Just now',
          content: `Evaluating unaddressed input from batch ${batchId}: Design updates configured.`,
          disposition: 'non-routing',
          agentAttribution: currentAgentExecutionAttribution(agent),
          isProjectedReply: true,
          projectedReplyMeta: {
            runId,
            agentId: agent.id,
            wakeRequestId: `wake-${batchId}`,
            triggeringMessageIds: [newMsgId],
          },
          routingCausalChainId: batchId,
        };
        this.state.messages.push(replyMsg);
        this.notify(`Routing batch ${batchId} settled. Projected reply emitted with non-routing disposition.`);
      }, (cancellation) => {
        if (batch.status !== 'evaluating' && batch.status !== 'open') return;
        this.failClosedRoutingBatch(batch, cancellation);
      });

      this.notify(`Sent unaddressed message. Collected into 30s routing batch ${batchId}.`);
    } else {
      this.notify(`Sent informational message ${newMsgId}.`);
    }
    return { success: true };
  }

  public setProjectWakePolicy(projectId: string, policy: 'explicit-only' | 'wake-model-assisted') {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const mutationCheck = this.checkActiveProjectMutation(project, 'change the wake policy');
    if (!mutationCheck.success) return mutationCheck;

    project.wakePolicy = policy;
    this.notify(`Updated Project wake policy to ${policy}. Affects future messages only.`);
    return { success: true };
  }

  public createWorkingGroup(
    projectId: string,
    name: string,
    memberIds: string[],
    goal?: string
  ): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const mutationCheck = this.checkActiveProjectMutation(project, 'create a Working Group');
    if (!mutationCheck.success) return mutationCheck;

    for (const memberId of new Set(memberIds)) {
      const member = project.memberships.find((candidate) => candidate.memberId === memberId);
      const agent = this.state.agents.find((candidate) => candidate.id === memberId);
      if (!member || member.memberKind !== 'agent' || member.status !== 'active') {
        const reason = `Cannot add Agent "${agent?.displayName || memberId}" to a Working Group: an active Project membership is required.`;
        this.notify(reason);
        return { success: false, reason };
      }
      if (!agent || agent.status === 'archived') {
        const reason = `Cannot add Agent "${agent?.displayName || member.displayName}" to a Working Group: Agent is archived. Restore the Agent first; historical collaboration remains review-only (ADR-0008).`;
        this.notify(reason);
        return { success: false, reason };
      }
    }

    const wgId = `wg-${Date.now().toString().slice(-4)}`;
    const newWg = {
      id: wgId,
      projectId,
      displayName: name,
      goal: goal ?? undefined,
      creatorId: this.state.operator.id,
      memberIds: Array.from(new Set([this.state.operator.id, ...memberIds])),
      membershipHistory: Array.from(new Set([this.state.operator.id, ...memberIds])).map((memberId) => ({
        memberId,
        joinedAt: 'Just now',
      })),
      status: 'active' as const,
      createdAt: 'Just now',
    };
    project.workingGroups.push(newWg);
    this.notify(`Created Working group "${name}" atomically with creator as initial member.`);
    return { success: true };
  }

  public disbandWorkingGroup(projectId: string, wgId: string): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const mutationCheck = this.checkActiveProjectMutation(project, 'disband a Working Group');
    if (!mutationCheck.success) return mutationCheck;
    const wg = project.workingGroups.find((g) => g.id === wgId);
    if (!wg) return { success: false, reason: 'Working Group not found' };

    this.ensureWorkingGroupMembershipHistory(wg);
    wg.retainedMemberIds = Array.from(new Set(wg.memberIds));
    wg.memberIds = [];
    wg.status = 'disbanded';
    this.notify(`Disbanded Working group "${wg.displayName}". Channel is now read-only; history preserved.`);
    return { success: true };
  }

  public restoreWorkingGroup(projectId: string, wgId: string): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const wg = project.workingGroups.find((g) => g.id === wgId);
    if (!wg) return { success: false, reason: 'Working Group not found' };
    const eligibility = this.evaluateWorkingGroupEligibility(projectId, wgId, 'restore');
    if (!eligibility.success) {
      this.notify(eligibility.reason);
      return eligibility;
    }

    const restoredMemberIds = this.getRetainedWorkingGroupMemberIds(wg);
    this.ensureWorkingGroupMembershipHistory(wg);
    for (const memberId of restoredMemberIds) {
      const hasCurrentHistory = wg.membershipHistory?.some(
        (record) => record.memberId === memberId && !record.endedAt
      );
      if (!hasCurrentHistory) {
        wg.membershipHistory?.push({ memberId, joinedAt: 'Just now' });
      }
    }
    wg.memberIds = restoredMemberIds;
    wg.status = 'active';
    this.notify(`Restored Working group "${wg.displayName}". Channel is active.`);
    return { success: true };
  }

  private checkChatAdmission(
    project: ProjectItem,
    scope: MessageItem['scope']
  ): { success: boolean; reason?: string } {
    if (project.status === 'archived') {
      return {
        success: false,
        reason: `Cannot send a message in archived Project "${project.displayName}". Communication history is read-only.`,
      };
    }

    if (scope.kind === 'direct-message') {
      const member = project.memberships.find((candidate) => candidate.memberId === scope.recipientId);
      const agent = this.state.agents.find((candidate) => candidate.id === scope.recipientId);
      if (!agent) {
        return {
          success: false,
          reason: `Cannot message Agent "${scope.recipientId}": global Agent record not found. Message was not persisted or retargeted.`,
        };
      }
      const eligibility = this.checkAgentProjectEligibility(project, agent.id, 'message');
      if (!eligibility.success) return eligibility;
      if (!member || member.memberKind !== 'agent') return { success: false, reason: 'Active Agent membership not found.' };
    }

    if (scope.kind === 'working-group-channel') {
      return this.evaluateWorkingGroupEligibility(project.id, scope.workingGroupId, 'message');
    }

    return { success: true };
  }

  // --- Project Domain Actions (ADR-0006, ADR-0008) ---

  public createProject(
    displayName: string,
    goal?: string,
    rules?: string[],
    selectedAgentIds: string[] = [],
    boundEnvIds: string[] = []
  ): { success: boolean; reason?: string } {
    if (!displayName || !displayName.trim()) {
      const reason = 'Project creation failed: Display name cannot be empty.';
      this.notify(reason);
      return { success: false, reason };
    }

    const invalidAgentId = selectedAgentIds.find((agentId) => {
      const agent = this.state.agents.find((candidate) => candidate.id === agentId);
      return !agent || agent.status !== 'active';
    });
    if (invalidAgentId) {
      const invalidAgent = this.state.agents.find((agent) => agent.id === invalidAgentId);
      const reason = invalidAgent
        ? `Cannot create Project with Agent "${invalidAgent.displayName}": archived Agents cannot receive new Project memberships. Restore the Agent first (ADR-0008).`
        : `Cannot create Project with unknown Agent "${invalidAgentId}": every requested membership must resolve to an active global Agent.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const unavailableEnvironmentId = boundEnvIds.find((envId) => {
      const env = this.state.environments.find((candidate) => candidate.id === envId);
      return !env || env.enrollmentStatus !== 'approved';
    });
    if (unavailableEnvironmentId) {
      const env = this.state.environments.find((candidate) => candidate.id === unavailableEnvironmentId);
      const reason = `Cannot create Project with Environment "${env?.displayName ?? unavailableEnvironmentId}": a current approved enrollment is required for new Project assignment (ADR-0008).`;
      this.notify(reason);
      return { success: false, reason };
    }

    const projectId = `proj-${Date.now().toString().slice(-4)}`;
    const memberships: ProjectItem['memberships'] = [
      {
        memberId: this.state.operator.id,
        memberKind: 'human',
        displayName: 'Operator (Human)',
        avatar: 'OP',
        responsibilities: 'Overall lead authority, Task begin/end, recovery, validation.',
        joinedAt: 'Just now',
        status: 'active',
      },
    ];

    for (const agentId of new Set(selectedAgentIds)) {
      const globalAgent = this.state.agents.find((a) => a.id === agentId);
      if (globalAgent) {
        memberships.push({
          memberId: globalAgent.id,
          memberKind: 'agent',
          displayName: globalAgent.displayName,
          avatar: globalAgent.avatar,
          responsibilities: globalAgent.description,
          collaborationInstructions: globalAgent.standingInstructions,
          joinedAt: 'Just now',
          status: 'active',
        });
      }
    }

    const boundEnvironmentWorkspaces: ProjectItem['boundEnvironmentWorkspaces'] = [];
    for (const envId of boundEnvIds) {
      const env = this.state.environments.find((e) => e.id === envId);
      if (env) {
        const root = env.workspaceRoots[0] || 'workspace-root';
        boundEnvironmentWorkspaces.push({
          environmentId: env.id,
          workspaceRoot: root,
          relativeWorkspacePath: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          isPrepared: true,
        });
      }
    }

    const newProject: ProjectItem = {
      id: projectId,
      displayName: displayName.trim(),
      templateSource: 'General collaboration template v1.0',
      createdAt: 'Just now',
      goal: goal && goal.trim() ? goal.trim() : 'Collaborate effectively on project deliverables.',
      rules: rules && rules.length > 0 ? rules : ['Follow modular boundaries', 'Validate work through tests'],
      completionGuidance: 'All criteria validated with headless verification script before task completion claim.',
      wakePolicy: 'wake-model-assisted',
      batchCollectionIntervalSec: 30,
      status: 'active',
      memberships,
      boundEnvironmentWorkspaces,
      workingGroups: [],
    };

    this.state.projects.unshift(newProject);
    this.selectProject(projectId);
    this.setPrimaryNav('project', 'overview');
    this.notify(`Created Project "${displayName}" atomically with General collaboration template v1.0.`);
    return { success: true };
  }

  public updateProjectContract(
    projectId: string,
    goal: string,
    rules: string[],
    completionGuidance?: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const mutationCheck = this.checkActiveProjectMutation(project, 'update the Project contract');
    if (!mutationCheck.success) return mutationCheck;

    project.goal = goal;
    project.rules = rules;
    if (completionGuidance !== undefined) {
      project.completionGuidance = completionGuidance;
    }
    this.notify(`Updated Project contract for "${project.displayName}". Affects future tasks and runs.`);
    return { success: true };
  }

  public archiveProject(projectId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    // Safety check: Cannot archive project with active runs, held leases, or recovery
    const projectTasks = this.state.tasks.filter((t) => t.projectId === projectId);
    const activeTask = projectTasks.find(
      (t) =>
        t.agentRunLifecycle === 'running' ||
        t.leaseLifecycle === 'held' ||
        t.leaseLifecycle === 'recovering' ||
        t.lifecycle === 'active' ||
        t.lifecycle === 'awaiting validation' ||
        t.lifecycle === 'recovery' ||
        t.lifecycle === 'Task pause requested'
    );

    if (activeTask) {
      this.notify(
        `Cannot archive Project "${project.displayName}" while Task #${activeTask.id.replace('task-', '')} (${activeTask.lifecycle}, lease ${activeTask.leaseLifecycle}) is active. Settle or discard task first.`
      );
      return;
    }

    const cancelledReplyCount = this.cancelProjectPendingProjectedReplies(projectId, project.displayName);
    const terminalizedBatchCount = this.failClosedPersistedProjectRouting(projectId, project.displayName);
    project.status = 'archived';
    this.notify(
      `Archived Project "${project.displayName}". Channels are now read-only; history and workspaces preserved.${
        cancelledReplyCount > 0
          ? ` Cancelled ${cancelledReplyCount} pending projected repl${cancelledReplyCount === 1 ? 'y' : 'ies'}.`
          : ''
      }${
        terminalizedBatchCount > 0
          ? ` Terminalized ${terminalizedBatchCount} persisted routing batch${terminalizedBatchCount === 1 ? '' : 'es'} with per-WakeRequest responsibility.`
          : ''
      }`
    );
  }

  public restoreProject(projectId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    project.status = 'active';
    const environments = project.boundEnvironmentWorkspaces.map((binding) => {
      const env = this.state.environments.find((candidate) => candidate.id === binding.environmentId);
      if (!env) {
        return {
          environmentId: binding.environmentId,
          status: 'unavailable' as const,
          reason: 'Bound Environment record was not found.',
        };
      }
      if (!binding.isPrepared) {
        return {
          environmentId: binding.environmentId,
          status: 'unavailable' as const,
          reason: 'Project workspace is not prepared on this Environment.',
        };
      }

      const environmentEligibility = checkEnvironmentEligibility(env);
      if (!environmentEligibility.isEligible) {
        return {
          environmentId: binding.environmentId,
          status: 'unavailable' as const,
          reason: environmentEligibility.reason ?? 'Environment is unavailable for work admission.',
        };
      }

      const activeAgentMemberIds = project.memberships
        .filter((membership) => membership.memberKind === 'agent' && membership.status === 'active')
        .map((membership) => membership.memberId);
      const compatibleAgent = activeAgentMemberIds.find(
        (agentId) => this.evaluateAdmissionFallback(agentId, binding.environmentId)?.selectedOption
      );
      if (!compatibleAgent) {
        return {
          environmentId: binding.environmentId,
          status: 'unavailable' as const,
          reason: 'No active Project Agent has a configured, ready engine and model on this Environment.',
        };
      }

      return {
        environmentId: binding.environmentId,
        status: 'compatible' as const,
        reason: `Prepared workspace and compatible work option confirmed for Agent "${compatibleAgent}".`,
      };
    });
    const readyCount = environments.filter((result) => result.status === 'compatible').length;
    const status = readyCount > 0 ? 'ready' as const : 'unavailable' as const;
    const summary =
      status === 'ready'
        ? `Restore compatibility check: ${readyCount} of ${environments.length} bound Environment(s) can admit Project work.`
        : project.boundEnvironmentWorkspaces.length === 0
          ? 'Restore compatibility check: Project restored without a bound Environment; Task begin remains unavailable.'
          : 'Restore compatibility check: no bound Environment can currently admit Project work; Task begin remains unavailable.';
    project.compatibilityHistory ??= [];
    project.compatibilityHistory.unshift({
      evaluatedAt: 'Just now',
      trigger: 'restore',
      status,
      summary,
      environments,
    });
    this.notify(`Restored Project "${project.displayName}" to active status. ${summary}`);
  }

  public addProjectMembership(
    projectId: string,
    agentId: string,
    responsibilities?: string,
    instructions?: string
  ): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const projectMutationCheck = this.checkActiveProjectMutation(project, 'add Agent membership');
    if (!projectMutationCheck.success) return projectMutationCheck;

    const globalAgent = this.state.agents.find((a) => a.id === agentId);
    if (!globalAgent) return { success: false, reason: 'Agent not found' };

    // Invariant (ADR-0008): Archiving blocks new Project memberships and new work admission while preserving historical attribution.
    if (globalAgent.status === 'archived') {
      const msg = `Cannot add Agent "${globalAgent.displayName}" to Project: Agent is archived. Restore the Agent first to assign new Project memberships (ADR-0008).`;
      if (typeof window !== 'undefined' && window.alert) {
        window.alert(msg);
      }
      return { success: false, reason: msg };
    }

    const existing = project.memberships.find((m) => m.memberId === agentId);
    if (existing) {
      existing.status = 'active';
      if (responsibilities) existing.responsibilities = responsibilities;
      if (instructions) existing.collaborationInstructions = instructions;
      this.notify(`Restored membership for ${existing.displayName} in Project "${project.displayName}".`);
      return { success: true };
    }

    project.memberships.push({
      memberId: globalAgent.id,
      memberKind: 'agent',
      displayName: globalAgent.displayName,
      avatar: globalAgent.avatar,
      responsibilities: responsibilities || globalAgent.description,
      collaborationInstructions: instructions || globalAgent.standingInstructions,
      joinedAt: 'Just now',
      status: 'active',
    });

    this.notify(`Added Agent ${globalAgent.displayName} to Project "${project.displayName}".`);
    return { success: true };
  }

  public editProjectMembership(
    projectId: string,
    memberId: string,
    responsibilities?: string,
    instructions?: string
  ): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const projectMutationCheck = this.checkActiveProjectMutation(project, 'edit Project membership');
    if (!projectMutationCheck.success) return projectMutationCheck;
    const member = project.memberships.find((m) => m.memberId === memberId);
    if (!member) return { success: false, reason: 'Project membership not found' };
    const mutationCheck = this.checkProjectMembershipMutation(project, member, 'edit');
    if (!mutationCheck.success) return mutationCheck;

    if (responsibilities !== undefined) member.responsibilities = responsibilities;
    if (instructions !== undefined) member.collaborationInstructions = instructions;
    this.notify(`Updated collaboration instructions for ${member.displayName} in Project "${project.displayName}".`);
    return { success: true };
  }

  public endProjectMembership(projectId: string, memberId: string): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const projectMutationCheck = this.checkActiveProjectMutation(project, 'end Project membership');
    if (!projectMutationCheck.success) return projectMutationCheck;
    const member = project.memberships.find((m) => m.memberId === memberId);
    if (!member) return { success: false, reason: 'Project membership not found' };
    if (member.memberKind === 'human') return { success: false, reason: 'Cannot end local operator membership' };
    const mutationCheck = this.checkProjectMembershipMutation(project, member, 'end');
    if (!mutationCheck.success) return mutationCheck;

    member.status = 'ended';

    // End current participation in every Working Group without erasing the
    // group's retained restore candidates or participation history.
    for (const wg of project.workingGroups) {
      this.ensureWorkingGroupMembershipHistory(wg);
      if (wg.status === 'disbanded' && !wg.retainedMemberIds) {
        wg.retainedMemberIds = Array.from(new Set(wg.memberIds));
      }
      const currentHistory = wg.membershipHistory?.find(
        (record) => record.memberId === memberId && !record.endedAt
      );
      if (currentHistory) currentHistory.endedAt = 'Just now';
      wg.memberIds = wg.status === 'disbanded' ? [] : wg.memberIds.filter((id) => id !== memberId);
    }

    // Check if active tasks depend on this lead
    const activeTasksWithLead = this.state.tasks.filter(
      (t) =>
        t.projectId === projectId &&
        t.taskLeadId === memberId &&
        t.lifecycle !== 'completed' &&
        t.lifecycle !== 'cancelled' &&
        t.lifecycle !== 'rejected' &&
        t.lifecycle !== 'withdrawn'
    );
    if (activeTasksWithLead.length > 0) {
      for (const t of activeTasksWithLead) {
        // An unapproved proposal remains a proposal and therefore owns no
        // resources. Its blocker records that the proposed responsibility is
        // no longer admissible without pretending the Task has begun.
        if (t.lifecycle !== 'proposed') t.lifecycle = 'blocked';
        t.activeBlocker = {
          id: `blocker-lead-${Date.now()}`,
          reason: `Task lead ${member.displayName} membership ended in project.`,
          requiredNextAction: 'Operator must assign an active Project Agent as replacement Task Lead.',
          responsibleActor: 'Operator (Human)',
          whoAdvancesWhenCleared: 'Replacement Task Lead',
          createdAt: 'Just now',
        };
      }
      this.notify(
        `Ended membership for ${member.displayName}. Historical messages and run attribution preserved. Blocked ${activeTasksWithLead.length} tasks requiring lead replacement.`
      );
    } else {
      this.notify(`Ended membership for ${member.displayName}. Historical messages and run attribution preserved.`);
    }
    return { success: true };
  }

  public restoreProjectMembership(projectId: string, memberId: string): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    const projectMutationCheck = this.checkActiveProjectMutation(project, 'restore Project membership');
    if (!projectMutationCheck.success) return projectMutationCheck;
    const member = project.memberships.find((m) => m.memberId === memberId);
    if (!member) return { success: false, reason: 'Project membership not found' };
    const mutationCheck = this.checkProjectMembershipMutation(project, member, 'restore');
    if (!mutationCheck.success) return mutationCheck;

    member.status = 'active';
    this.notify(`Restored membership for ${member.displayName} in Project "${project.displayName}".`);
    return { success: true };
  }

  private checkProjectMembershipMutation(
    project: ProjectItem,
    member: ProjectMembership,
    action: 'edit' | 'end' | 'restore'
  ): { success: boolean; reason?: string } {
    const projectMutationCheck = this.checkActiveProjectMutation(project, `${action} Project membership`);
    if (!projectMutationCheck.success) return projectMutationCheck;
    if (member.memberKind !== 'agent') return { success: true };

    const globalAgent = this.state.agents.find((agent) => agent.id === member.memberId);
    if (!globalAgent) {
      const reason = `Cannot ${action} membership for Agent "${member.displayName}" in Project "${project.displayName}": global Agent record not found.`;
      this.notify(reason);
      return { success: false, reason };
    }
    if (globalAgent.status === 'archived') {
      const reason = `Cannot ${action} membership for Agent "${globalAgent.displayName}" in Project "${project.displayName}": Agent is archived. Restore the Agent first; historical membership and attribution remain preserved (ADR-0008).`;
      this.notify(reason);
      return { success: false, reason };
    }
    return { success: true };
  }

  private checkActiveProjectMutation(
    project: ProjectItem,
    operation: string,
    notifyOnFailure = true
  ): { success: boolean; reason?: string } {
    if (project.status !== 'active') {
      const reason = `Cannot ${operation} in archived Project "${project.displayName}". Restore the Project first; memberships, contract, Working Group, wake policy, and history remain preserved.`;
      if (notifyOnFailure) this.notify(reason);
      return { success: false, reason };
    }
    return { success: true };
  }

  public bindEnvironmentToProject(
    projectId: string,
    envId: string,
    workspaceRoot: string,
    relativePath: string
  ): { success: boolean; reason?: string } {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    if (project.status !== 'active') {
      const reason = `Cannot bind an Environment to archived Project "${project.displayName}". Existing bindings and history remain preserved.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const env = this.state.environments.find((candidate) => candidate.id === envId);
    if (!env || env.enrollmentStatus !== 'approved') {
      const reason = `Cannot bind Environment "${env?.displayName ?? envId}": a current approved enrollment is required for new Project assignment (ADR-0008).`;
      this.notify(reason);
      return { success: false, reason };
    }

    const existing = project.boundEnvironmentWorkspaces.find((b) => b.environmentId === envId);
    if (existing) {
      existing.workspaceRoot = workspaceRoot;
      existing.relativeWorkspacePath = relativePath;
      existing.isPrepared = true;
      this.notify(`Updated workspace binding on ${envId} for Project "${project.displayName}".`);
      return { success: true };
    }

    project.boundEnvironmentWorkspaces.push({
      environmentId: envId,
      workspaceRoot,
      relativeWorkspacePath: relativePath,
      isPrepared: true,
    });
    this.notify(`Bound Environment ${envId} (${relativePath}) to Project "${project.displayName}". Workspace prepared.`);
    return { success: true };
  }

  public switchProjectWorkspacePath(
    projectId: string,
    envId: string,
    newRelativePath: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (project.status !== 'active') {
      this.notify(`Cannot change a workspace binding in archived Project "${project.displayName}". Existing binding history remains preserved.`);
      return;
    }

    // Safety check: Cannot change workspace while active run or held lease on this environment
    const activeTask = this.state.tasks.find(
      (t) =>
        t.projectId === projectId &&
        t.selectedEnvironmentId === envId &&
        (t.agentRunLifecycle === 'running' || t.leaseLifecycle === 'held' || t.leaseLifecycle === 'recovering')
    );
    if (activeTask) {
      this.notify(`Cannot change workspace path on ${envId} while Task #${activeTask.id} holds lease. Settle task first.`);
      return;
    }

    const binding = project.boundEnvironmentWorkspaces.find((b) => b.environmentId === envId);
    if (binding) {
      binding.relativeWorkspacePath = newRelativePath;
      binding.isPrepared = true;
      this.notify(`Switched workspace relative path to "${newRelativePath}" on ${envId}. New native session slot will be created.`);
    }
  }

  public unbindEnvironmentFromProject(projectId: string, envId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (project.status !== 'active') {
      this.notify(`Cannot unbind an Environment from archived Project "${project.displayName}". Existing binding history remains preserved.`);
      return;
    }

    // Safety check
    const activeTask = this.state.tasks.find(
      (t) =>
        t.projectId === projectId &&
        t.selectedEnvironmentId === envId &&
        (t.agentRunLifecycle === 'running' || t.leaseLifecycle === 'held' || t.leaseLifecycle === 'recovering')
    );
    if (activeTask) {
      this.notify(`Cannot unbind Environment ${envId} while Task #${activeTask.id} holds active lease.`);
      return;
    }

    project.boundEnvironmentWorkspaces = project.boundEnvironmentWorkspaces.filter((b) => b.environmentId !== envId);
    this.notify(`Unbound Environment ${envId} from Project "${project.displayName}". Files on host are preserved.`);
  }

  public createTaskProposal(
    projectId: string,
    title: string,
    goal: string,
    constraints: string[],
    validationCriteria: string[],
    leadId: string,
    proposerKind: 'human' | 'agent' = 'human',
    proposerId?: string
  ): { success: boolean; reason?: string } {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) return { success: false, reason: 'Project not found' };
    if (project.status === 'archived') {
      const reason = `Cannot create a Task proposal in archived Project "${project.displayName}". Restore the Project first; existing Task history remains readable.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const resolvedProposerId = proposerId ?? (proposerKind === 'human' ? this.state.operator.id : undefined);
    let proposerDisplayName: string;
    if (proposerKind === 'human') {
      if (resolvedProposerId !== this.state.operator.id) {
        const reason = 'Cannot create Task proposal: the Human proposer must be the current Operator identity.';
        this.notify(reason);
        return { success: false, reason };
      }
      proposerDisplayName = 'Operator (Human)';
    } else {
      if (!resolvedProposerId) {
        const reason = 'Cannot create Agent Task proposal without an explicit proposer identity.';
        this.notify(reason);
        return { success: false, reason };
      }
      const proposer = this.state.agents.find((candidate) => candidate.id === resolvedProposerId);
      const proposerMembership = project.memberships.find(
        (membership) =>
          membership.memberId === resolvedProposerId &&
          membership.memberKind === 'agent' &&
          membership.status === 'active'
      );
      if (!proposer || proposer.status !== 'active' || !proposerMembership) {
        const reason = `Cannot create Task proposal for Agent proposer "${resolvedProposerId}": an active global Agent and current active Project membership are required (ADR-0006/0008).`;
        this.notify(reason);
        return { success: false, reason };
      }
      proposerDisplayName = `${proposer.displayName} (Agent)`;
    }

    const lead = this.state.agents.find((candidate) => candidate.id === leadId);
    const leadMembership = project.memberships.find(
      (membership) =>
        membership.memberId === leadId &&
        membership.memberKind === 'agent' &&
        membership.status === 'active'
    );
    if (!lead || lead.status !== 'active' || !leadMembership) {
      const reason = `Task proposal is non-admissible: proposed lead "${leadId}" must be an active global Agent with current active Project membership. Select an eligible lead; no responsibility, lease, or run was recorded.`;
      this.notify(reason);
      return { success: false, reason };
    }

    const newId = `task-${Date.now().toString().slice(-3)}`;
    const newProp: TaskItem = {
      id: newId,
      projectId,
      proposerId: resolvedProposerId,
      proposerKind,
      createdAt: 'Just now',
      taskLeadId: leadId,
      lifecycle: 'proposed',
      agentRunLifecycle: 'none',
      leaseLifecycle: 'none',
      currentVersion: {
        version: 1,
        createdAt: 'Just now',
        createdBy: proposerDisplayName,
        title: title.trim(),
        goal: goal.trim(),
        constraints: constraints.length > 0 ? constraints : ['Follow project rules.'],
        validationCriteria: validationCriteria.length > 0 ? validationCriteria : ['Verification script passes.'],
        taskLeadId: leadId,
      },
      historyVersions: [],
      runs: [],
    };

    this.state.tasks.unshift(newProp);
    this.selectTask(newId);
    this.notify(`Created Task Proposal #${newId.replace('task-', '')}: "${title}". Awaiting Human Approval to begin.`);
    return { success: true };
  }

  public rejectTaskProposal(taskId: string, reason: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'proposed') return;
    if (task.leaseLifecycle !== 'none' || task.agentRunLifecycle !== 'none' || task.activeRunId) {
      this.notify(`Cannot reject Task Proposal #${taskId.replace('task-', '')}: proposal contains an unexpected lease or run fact.`);
      return;
    }

    task.lifecycle = 'rejected';
    this.notify(`Rejected Task Proposal #${taskId.replace('task-', '')}: ${reason}`);
  }

  public simulateLeadAutonomousRun(taskId: string, agentId?: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'active' || task.leaseLifecycle !== 'held') return;
    if (task.agentRunLifecycle === 'running' || task.activeRunId) {
      this.notify(`Cannot start a sequential run for Task #${taskId}: an active run must settle first.`);
      return;
    }
    const leaseCheck = this.checkTaskLease(task, 'start a sequential run', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return;
    }

    const targetAgentId = agentId || (task.runs.length % 2 === 0 ? 'reviewer' : task.taskLeadId);
    const admission = this.evaluateTaskAdmission(task.id, task.selectedEnvironmentId || '', targetAgentId);
    const selectedOption = admission.selectedOption;
    if (!selectedOption) {
      this.notify(
        `Cannot start a sequential run for Task #${taskId}: ${admission.rejectionReason || admission.envIneligibilityReason || 'no compatible configured work option is available.'}`
      );
      return;
    }

    const agent = admission.agent!;
    const runId = `run-${Date.now().toString().slice(-3)}`;

    const newRun: NestedAgentRun = {
      id: runId,
      taskId: task.id,
      agentId: targetAgentId,
      agentDisplayName: agent ? agent.displayName : targetAgentId,
      engine: selectedOption.engine,
      workModel: selectedOption.workModel,
      effort: selectedOption.effort,
      agentConfigVersionUsed: agent.version ?? 1,
      contentVersionUsed: task.currentVersion.version,
      lifecycle: 'running',
      startedAt: 'Just now',
      tokenUsage: {
        status: 'complete',
        uncachedInput: 8400,
        cachedReads: 14200,
        cacheWrite: 0,
        output: 3200,
        reasoningOutput: 800,
        total: 26600,
      },
      monetaryCost: {
        attributableBilledCostStatus: 'unavailable',
        apiEquivalentStatus: 'available',
        estimatedUsdMicros: 64000,
        provenance: 'provider_estimated',
        billingBasis: 'metered_api',
      },
      events: [
        { time: 'Just now', kind: 'status_change', summary: `Lead ${task.taskLeadId} initiated sequential run with ${targetAgentId}` },
        { time: 'Just now', kind: 'tool_call', summary: 'read src/main.js' },
        { time: 'Just now', kind: 'text_delta', summary: 'Validating implementation assertions.' },
      ],
      finalAssistantText: `Autonomous execution turn completed by ${agent ? agent.displayName : targetAgentId}. Ready for next step.`,
    };

    task.runs.unshift(newRun);
    task.activeRunId = runId;
    task.agentRunLifecycle = 'running';

    this.notify(`Task lead ${task.taskLeadId} autonomously initiated Run ${runId} with ${agent ? agent.displayName : targetAgentId}.`);
  }

  public submitTaskCompletionClaim(
    taskId: string,
    outcomeSummary: string,
    evidence: string,
    changes: string[],
    limitations = 'None identified.'
  ) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'active') return;

    const leadEligibility = this.evaluateTaskLeadEligibility(task);
    if (!leadEligibility.success) {
      this.keepTaskBlockedForLeadSelection(task, leadEligibility.reason ?? 'Task lead is unavailable.');
      this.notify(`Cannot submit completion claim for Task #${taskId}: ${leadEligibility.reason} Human lead replacement is required.`);
      return;
    }
    const leaseCheck = this.checkTaskLease(task, 'submit completion claim', 'held', false);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return;
    }

    if (task.activeRunId) {
      const run = task.runs.find((r) => r.id === task.activeRunId);
      if (!run || run.lifecycle !== 'running') {
        this.notify(`Cannot submit completion claim for Task #${taskId}: active run pointer is not running.`);
        return;
      }
      run.lifecycle = 'completed';
      run.settledAt = 'Just now';
      delete task.activeRunId;
    } else if (task.agentRunLifecycle === 'running') {
      this.notify(`Cannot submit completion claim for Task #${taskId}: active run pointer is missing.`);
      return;
    }

    task.lifecycle = 'awaiting validation';
    task.agentRunLifecycle = 'completed';
    task.pendingCompletionClaim = {
      id: `claim-${Date.now().toString().slice(-3)}`,
      submittedAt: 'Just now',
      submittedByLeadId: task.taskLeadId,
      contentVersion: task.currentVersion.version,
      outcomeSummary,
      validationEvidence: evidence,
      durableChanges: changes,
      knownLimitations: limitations,
      recommendedDisposition: 'completed',
    };

    this.notify(`Lead ${task.taskLeadId} submitted Task Completion Claim for Task #${taskId}. Awaiting Human Validation.`);
  }

  public applyProjectStatePreset(preset: string) {
    switch (preset) {
      case 'project-active':
      case 'active':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-102');
        this.notify('Loaded Project Preset: Active Running Task (2-Stage Pause / Interrupt)');
        break;
      case 'project-validation':
      case 'validation':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-101');
        this.notify('Loaded Project Preset: Task Awaiting Human Validation Claim');
        break;
      case 'project-blocked':
      case 'blocked':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-103');
        this.notify('Loaded Project Preset: Routable Task Blocker');
        break;
      case 'project-proposal':
      case 'proposal':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-105-prop');
        this.notify('Loaded Project Preset: Task Proposal Awaiting Human Approve & Begin');
        break;
      case 'project-recovery':
      case 'recovery':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-104');
        this.notify('Loaded Project Preset: Interrupted Run & Ordinary Lease Recovery');
        break;
      case 'project-overview':
      case 'overview':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'overview');
        this.notify('Loaded Project Preset: Project Overview, Contract & Memberships');
        break;
      case 'project-archived':
      case 'archived':
        this.selectProject('proj-docs-portal');
        this.setPrimaryNav('project', 'overview');
        this.notify('Loaded Project Preset: Archived Read-Only Project');
        break;
      case 'project-chat':
      case 'chat':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.notify('Loaded Project Preset: Project Discussion & Working Groups Chat');
        break;
      default:
        break;
    }
  }

  // --- Environment Management & Recovery Actions (ADR-0008, ADR-0009) ---

  public approveEnvironmentEnrollment(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.enrollmentStatus = 'approved';
    env.connectionState = 'online';
    env.trafficLight = 'green';
    env.trafficLightReason = 'Enrollment approved by Operator · All capabilities ready';
    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== envId);

    env.probeHistory = env.probeHistory || [];
    env.probeHistory.unshift({
      id: `pr-appr-${Date.now()}`,
      timestamp: 'Just now',
      latencyMs: 15,
      protocolOk: true,
      enginesOk: true,
      capabilitiesOk: true,
      summary: 'Operator approved enrollment: Worker identity & transport verified',
    });

    this.notify(`Approved Environment enrollment for ${env.displayName}. Worker identity verified.`);
  }

  public unenrollEnvironment(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    // Refuse if active lease held or recovering
    if (env.activeLeaseHolder || env.workSafety === 'recovery') {
      this.notify(`Cannot unenroll ${env.displayName} while an active Task lease is held or recovering.`);
      return;
    }

    env.enrollmentStatus = 'revoked';
    env.trafficLight = 'red';
    env.trafficLightReason = 'Worker enrollment revoked by Operator · Reconnection barred';
    this.notify(`Revoked enrollment for ${env.displayName}. Identity barred from connecting.`);
  }

  public archiveEnvironment(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    // Refuse if active lease held or recovering
    if (env.activeLeaseHolder || env.workSafety === 'recovery') {
      this.notify(`Cannot archive ${env.displayName} while an active Task lease is held or recovering.`);
      return;
    }

    env.enrollmentStatus = 'archived';
    env.trafficLight = 'yellow';
    env.trafficLightReason = 'Archived instance · Enrollment preserved · No active work admitted';
    this.notify(`Archived Environment ${env.displayName}. Work admission disabled.`);
  }

  public restoreEnvironment(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.enrollmentStatus = 'approved';
    env.trafficLight = env.connectionState === 'online' ? 'green' : 'yellow';
    env.trafficLightReason = 'Restored instance · Enrollment approved';
    this.notify(`Restored Environment ${env.displayName}.`);
  }

  public toggleCapabilityPermission(
    envId: string,
    capability: keyof EnvironmentInstance['capabilityPermissions']
  ) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    const currentVal = env.capabilityPermissions[capability];
    // Safety check: revoking while lease is held
    if (currentVal && env.activeLeaseHolder) {
      this.notify(`Notice: Changed permission '${capability}' on ${env.displayName} while lease is held. Applies to future runs.`);
    }

    env.capabilityPermissions[capability] = !currentVal;
    this.notify(`Toggled ${capability} on ${env.displayName} to ${!currentVal ? 'Granted' : 'Refused'}.`);
  }

  public triggerReadinessProbe(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.lastConfirmedTime = 'Just now';
    env.connectionAgeSec = 0;
    if (env.connectionState !== 'offline' && env.enrollmentStatus === 'approved') {
      env.connectionState = 'online';
    }

    const latency = Math.floor(Math.random() * 15) + 8;
    env.probeHistory = env.probeHistory || [];
    env.probeHistory.unshift({
      id: `pr-${Date.now()}`,
      timestamp: 'Just now',
      latencyMs: latency,
      protocolOk: env.protocolCompatibility === 'compatible',
      enginesOk: Object.values(env.engineReadiness).every((s) => s === 'ready'),
      capabilitiesOk: env.capabilityPermissions.fileReadWrite && env.capabilityPermissions.processExecution,
      summary: `Live probe confirmed: latency ${latency}ms, protocol ${env.protocolVersion} ${env.protocolCompatibility}`,
    });

    this.notify(`Ran live readiness probe on ${env.displayName} (${latency}ms). Facts refreshed.`);
  }

  public triggerSimulatedWorkerReconnect(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.connectionState = 'online';
    env.lastConfirmedTime = 'Just now';
    env.connectionAgeSec = 0;

    if (env.workSafety === 'recovery') {
      env.workSafety = 'reconciling';
      env.trafficLight = 'yellow';
      env.trafficLightReason = 'Worker reconnected · Carrier online · Reconciling settlement evidence';
    }

    this.notify(`Worker on ${env.displayName} reconnected over TLS/WSS. Starting evidence reconciliation.`);
  }

  public reconcileEnvironmentEvidence(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    if (env.leaseRecovery) {
      env.leaseRecovery.reconciledEvidence = {
        retainedEventsCount: 4,
        turnSettlementObserved: true,
        engineSessionStopped: true,
        taskContextRecycled: false,
        synchronizedAt: 'Just now',
      };
    }

    env.workSafety = 'recovery';
    env.trafficLight = 'red';
    env.trafficLightReason = 'Reconciliation complete: evidence synced, engine stopped · Operator decision needed (Resume or Discard)';

    this.notify(`Synchronized evidence for ${env.displayName}. Proved engine stopped; awaiting Human Resume or Discard.`);
  }

  public discardOrdinaryRecovery(taskId: string): { success: boolean; reason?: string } {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return { success: false, reason: 'Task not found.' };
    if (task.lifecycle === 'cancelled') return { success: true };
    const isRecoveryLifecycle = task.lifecycle === 'recovery' ||
      (task.lifecycle === 'blocked' && task.leaseLifecycle === 'recovering');
    if (!isRecoveryLifecycle) {
      const reason = `Cannot discard ordinary recovery for Task #${taskId}: lifecycle is ${task.lifecycle}.`;
      this.notify(reason);
      return { success: false, reason };
    }
    const leaseCheck = this.checkTaskLease(task, 'discard ordinary recovery', 'recovering', true);
    if (!leaseCheck.success) {
      this.notify(leaseCheck.reason);
      return leaseCheck;
    }
    const runStop = this.stopTaskRuns(task, 'Operator (Human Recovery Discard)');
    if (!runStop.success) {
      this.notify(runStop.reason);
      return runStop;
    }
    this.completeTaskEnd(task, 'cancelled', leaseCheck.env);
    this.notify(`Discarded Task #${taskId}. Worker recycled scratch context; Project workspace preserved; Lease released.`);
    return { success: true };
  }

  public simulateRegisterNewPendingHost(platform: 'macos' | 'windows' | 'container' = 'macos') {
    const newId = `environment-${this.state.environments.length + 1}`;
    const newName = 'Pending Environment';
    const newKey = 'identity-withheld';

    const newEnv: EnvironmentInstance = {
      id: newId,
      displayName: newName,
      platform,
      hostUser: 'local user context',
      trafficLight: 'yellow',
      trafficLightReason: 'Pending enrollment approval by operator · Worker identity verified',
      enrollmentStatus: 'pending',
      workerIdentityKey: newKey,
      connectionState: 'online',
      lastConfirmedTime: 'Just now',
      connectionAgeSec: 0,
      protocolCompatibility: 'compatible',
      protocolVersion: 'v2.1',
      capabilityPermissions: {
        fileReadWrite: true,
        processExecution: true,
        networkAccess: false,
        guiAutomation: false,
      },
      engineReadiness: {
        codex: 'ready',
        pi: 'ready',
        agy: 'unknown',
        opencode: 'unknown',
      },
      engineDetails: {
        codex: { version: 'v0.18.2', authStatus: 'authenticated', modelAvailability: 'gpt-4o' },
        pi: { version: 'v0.3.1', authStatus: 'authenticated', modelAvailability: 'claude-3-5-sonnet' },
        agy: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown' },
        opencode: { version: 'unknown', authStatus: 'unknown', modelAvailability: 'unknown' },
      },
      workSafety: 'clear',
      workspaceRoots: ['workspace-root'],
      probeHistory: [
        { id: `pr-${Date.now()}`, timestamp: 'Just now', latencyMs: 11, protocolOk: true, enginesOk: true, capabilitiesOk: true, summary: 'New worker bootstrap connection: Identity verified over private transport' },
      ],
    };

    this.state.environments.push(newEnv);
    this.state.selectedEnvironmentId = newId;

    this.state.attentionItems.unshift({
      id: `att-enroll-${newId}`,
      severity: 'attention',
      category: 'env_enrollment',
      title: `Pending Worker Enrollment: ${newName}`,
      summary: 'An environment worker connected over private transport and is requesting operator capability approval.',
      referenceId: newId,
      referenceType: 'environment',
      actionLabel: 'Review Enrollment in Envs',
      actionTargetView: 'environments',
      targetNav: 'manage',
      targetManageTab: 'environments',
      timestamp: 'Just now',
      lifecycleSentence: 'Enrollment pending · Protocol compatible · 0 leases',
      attribution: 'Environment worker',
    });

    this.notify(`New environment connected in pending enrollment.`);
  }

  // --- Preset Scenario Jumpers for Owner Review ---

  public loadScenarioPreset(preset: string) {
    switch (preset) {
      case 'attention':
      case 'feed-matrix-mixed':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('mixed');
        this.notify('Loaded Scenario: Feed & Prominent Attention Section (Mixed Default)');
        break;
      case 'feed-matrix-empty':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('empty');
        this.notify('Loaded Scenario: Feed Empty State (All Systems Clear)');
        break;
      case 'feed-matrix-healthy':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('healthy');
        this.notify('Loaded Scenario: Feed Healthy State (Active Work Progressing)');
        break;
      case 'feed-matrix-stale':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('stale');
        this.notify('Loaded Scenario: Feed Stale Telemetry State');
        break;
      case 'feed-matrix-pending':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('pending');
        this.notify('Loaded Scenario: Feed Pending Approvals & Enrollments State');
        break;
      case 'feed-matrix-degraded':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('degraded');
        this.notify('Loaded Scenario: Feed Degraded Host & Login Required State');
        break;
      case 'feed-matrix-intervention':
        this.setPrimaryNav('feed');
        this.applyFeedPreset('intervention');
        this.notify('Loaded Scenario: Feed Intervention State (Blockers & Validation)');
        break;
      case 'proj-overview':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'overview');
        this.notify('Loaded Scenario: Project Overview, Contract & Memberships');
        break;
      case 'proj-active-task':
      case 'active-task':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-102');
        this.notify('Loaded Scenario: Active Task with Live 2-Stage Pause & Interrupt');
        break;
      case 'proj-validation-claim':
      case 'validation-claim':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-101');
        this.notify('Loaded Scenario: Task Awaiting Validation (Review Claim & Evidence)');
        break;
      case 'proj-blocker':
      case 'blocker-versioning':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-103');
        this.notify('Loaded Scenario: Task Blocker & Content Versioning');
        break;
      case 'proj-proposal':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-105-prop');
        this.notify('Loaded Scenario: Task Proposal Awaiting Human Approve & Begin');
        break;
      case 'proj-recovery':
      case 'ordinary-recovery':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'tasks');
        this.selectTask('task-104');
        this.notify('Loaded Scenario: Worker Disconnect & Ordinary Lease Recovery');
        break;
      case 'proj-archived':
        this.selectProject('proj-docs-portal');
        this.setPrimaryNav('project', 'overview');
        this.notify('Loaded Scenario: Archived Read-Only Project');
        break;
      case 'proj-chat':
      case 'chat-project-broadcast':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('project-channel');
        this.notify('Loaded Scenario: Project Broadcast Channel (#general) & Wake Policy');
        break;
      case 'chat-working-group':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('working-group-channel', 'wg-mechanics');
        this.notify('Loaded Scenario: Working Group Channel (Core Mechanics WG)');
        break;
      case 'chat-direct-message':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('direct-message', 'programmer');
        this.notify('Loaded Scenario: Project-Scoped Direct Message (@Programmer)');
        break;
      case 'chat-batch-open':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('project-channel');
        this.openInspector('routing', 'batch-005');
        this.notify('Loaded Scenario: Active 30s Collection Window (Open Batch)');
        break;
      case 'chat-batch-inspect-selected':
      case 'wake-routing-batch':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('project-channel');
        this.openInspector('routing', 'batch-002');
        this.notify('Loaded Scenario: Causal Routing Batch with Selected Agent & Projected Reply');
        break;
      case 'chat-batch-inspect-suppressed':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('project-channel');
        this.openInspector('routing', 'batch-003');
        this.notify('Loaded Scenario: Causal Routing Batch with Deliberate Suppression');
        break;
      case 'chat-batch-inspect-failed':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('project-channel');
        this.openInspector('routing', 'batch-004');
        this.notify('Loaded Scenario: Causal Routing Batch with Fail-Closed after 2 Attempts');
        break;
      case 'chat-empty-scope':
        this.selectProject('proj-docs-portal');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('project-channel');
        this.notify('Loaded Scenario: Empty Conversation Scope');
        break;
      case 'chat-disbanded-wg':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('working-group-channel', 'wg-audio');
        this.notify('Loaded Scenario: Disbanded Working Group (Read-Only State & History)');
        break;
      case 'chat-ended-membership':
        this.selectProject('proj-minesweeper');
        this.setPrimaryNav('project', 'chat');
        this.openChatDetail('direct-message', 'researcher');
        this.notify('Loaded Scenario: Direct Message with Ended Agent Membership (Read-Only)');
        break;
      case 'usage-telemetry':
        this.setPrimaryNav('manage', undefined, 'usage');
        this.notify('Loaded Scenario: Usage & Monetary Cost Observability (6 Views)');
        break;
      case 'primitives-showcase':
        this.setPrimaryNav('primitives');
        this.notify('Loaded Scenario: Shared Interaction Primitives & State Language Testbed');
        break;
      case 'env-healthy-macos':
        this.selectEnvironment('env-ready');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Ready Environment (Green: Ready · Lease Held)');
        break;
      case 'env-recovery-win':
        this.selectEnvironment('env-recovery');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Recovery Environment in Lease Recovery (Red: Action Required)');
        break;
      case 'env-pending-macair':
        this.selectEnvironment('env-pending');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Pending Environment Pending Enrollment Approval (Yellow: Attention)');
        break;
      case 'env-degraded-login':
        this.selectEnvironment('env-degraded');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Degraded Environment Engine Login (Yellow: Attention)');
        break;
      case 'env-protocol-mismatch':
        this.selectEnvironment('env-incompatible');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Legacy Worker Protocol Mismatch (Red: Action Required)');
        break;
      case 'env-force-release-flow':
        this.selectEnvironment('env-recovery');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.openInspector('force-release', 'env-recovery');
        this.notify('Loaded Scenario: Emergency Force Release Flow (Typed Confirmation & Risk Checklist)');
        break;
      case 'env-reconnect-reconcile':
        this.selectEnvironment('env-recovery');
        this.triggerSimulatedWorkerReconnect('env-recovery');
        this.reconcileEnvironmentEvidence('env-recovery');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Reconnect & Evidence Reconciliation Flow');
        break;
      case 'env-archived':
        this.selectEnvironment('env-archived');
        this.setPrimaryNav('manage', undefined, 'environments');
        this.notify('Loaded Scenario: Archived Environment Instance (Read-Only State)');
        break;
      default:
        break;
    }
  }
}

export const stateManager = new StateManager();
