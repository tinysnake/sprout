import type {
  ActiveDialog,
  AgentDefinition,
  AttentionItem,
  DensityMode,
  EnvironmentInstance,
  ManageTab,
  MessageItem,
  NestedAgentRun,
  OperatorIdentity,
  PrimaryNav,
  ProjectItem,
  ProjectTab,
  ReturnContext,
  RoutingBatch,
  TaskItem,
  ThemeMode,
  UsageActivity,
  ViewportMode,
} from './types.js';

export type { ViewportMode };
export type ActiveTab = 'attention' | 'projects' | 'tasks' | 'environments' | 'agents' | 'usage' | 'onboarding' | 'primitives';

export interface PrototypeState {
  viewportMode: ViewportMode;
  theme: ThemeMode;
  density: DensityMode;
  primaryNav: PrimaryNav;
  projectTab: ProjectTab;
  manageTab: ManageTab;
  activeTab: ActiveTab;
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
  };
  inspectorSheet: {
    isOpen: boolean;
    kind: 'routing' | 'content-version' | 'run-telemetry' | 'force-release' | 'blocker' | 'validation' | 'none';
    entityId?: string | undefined;
  };
  reviewDrawerOpen: boolean;
  operator: OperatorIdentity;
  projects: ProjectItem[];
  agents: AgentDefinition[];
  environments: EnvironmentInstance[];
  tasks: TaskItem[];
  messages: MessageItem[];
  routingBatches: RoutingBatch[];
  usageActivities: UsageActivity[];
  attentionItems: AttentionItem[];
  scenarioLog: string[];
}

// Initial realistic seeded data
const initialOperator: OperatorIdentity = {
  id: 'op-primary',
  name: 'Lead Technical Operator',
  sessionCount: 2,
  connectionState: 'online',
  transport: 'private-overlay',
  overlayAddress: '100.64.0.4:5174',
};

const initialAgents: AgentDefinition[] = [
  {
    id: 'planner',
    displayName: 'Planner',
    avatar: '🧭',
    description: 'High-level architecture, task breakdown, and coordination lead.',
    standingInstructions: 'Always verify acceptance criteria before coordinating next steps.',
    status: 'active',
    privateMemoryEntriesCount: 14,
    workOptions: [
      { id: 'opt-p1', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'high', isConfigured: true },
      { id: 'opt-p2', engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
    ],
  },
  {
    id: 'designer',
    displayName: 'Designer',
    avatar: '🎨',
    description: 'UI/UX layout, CSS theme variables, and interaction specifications.',
    standingInstructions: 'Prioritize mobile touch targets and clear high-contrast hierarchy.',
    status: 'active',
    privateMemoryEntriesCount: 9,
    workOptions: [
      { id: 'opt-d1', engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
      { id: 'opt-d2', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'default', isConfigured: true },
    ],
  },
  {
    id: 'programmer',
    displayName: 'Programmer',
    avatar: '💻',
    description: 'Core logic, Three.js game loop, and DOM rendering implementation.',
    standingInstructions: 'Write pure functions where possible; ensure build and verification scripts pass.',
    status: 'active',
    privateMemoryEntriesCount: 26,
    workOptions: [
      { id: 'opt-pr1', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'high', isConfigured: true },
      { id: 'opt-pr2', engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
      { id: 'opt-pr3', engine: 'opencode', workModel: 'deepseek-coder-v2', effort: 'default', isConfigured: false },
    ],
  },
  {
    id: 'reviewer',
    displayName: 'Reviewer',
    avatar: '🔍',
    description: 'Browser verification, regression tests, and acceptance audits.',
    standingInstructions: 'Run headless browser verification and check console error logs.',
    status: 'active',
    privateMemoryEntriesCount: 18,
    workOptions: [
      { id: 'opt-r1', engine: 'codex', workModel: 'gpt-4o', effort: 'high', isConfigured: true },
      { id: 'opt-r2', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'medium', isConfigured: true },
    ],
  },
];

const initialEnvironments: EnvironmentInstance[] = [
  {
    id: 'mac-studio-primary',
    displayName: 'macOS Studio Host (M2 Max)',
    platform: 'macos',
    hostUser: 'operator-local',
    trafficLight: 'green',
    trafficLightReason: 'All capabilities permitted, engines authenticated, lease clear',
    enrollmentStatus: 'approved',
    workerIdentityKey: 'sprout-wk-mac-7f89a1c2',
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
    workSafety: 'clear',
    workspaceRoots: ['/Users/workspace/sprout-projects'],
    activeLeaseHolder: {
      holderKind: 'task',
      holderId: 'task-101',
      projectId: 'proj-minesweeper',
      acquiredAt: '18m ago',
    },
  },
  {
    id: 'win-dev-box',
    displayName: 'Windows Dev Host (Core i9)',
    platform: 'windows',
    hostUser: 'win-operator',
    trafficLight: 'red',
    trafficLightReason: 'Worker offline for 14 minutes · Lease recovery required',
    enrollmentStatus: 'approved',
    workerIdentityKey: 'sprout-wk-win-3b44c8d9',
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
    workSafety: 'recovery',
    workspaceRoots: ['C:\\SproutWorkspaces'],
    activeLeaseHolder: {
      holderKind: 'task',
      holderId: 'task-104',
      projectId: 'proj-minesweeper',
      acquiredAt: '45m ago',
    },
    leaseRecovery: {
      cause: 'Worker process terminated unexpectedly during active nested Agent run #206',
      interruptedRunId: 'run-206',
      unresolvedFacts: [
        'Host worker offline: engine process stop cannot be confirmed over carrier',
        'Temporary task scratch context directory unrecycled on Windows host',
        'Settlement telemetry uncollected for last 2 turns of turn execution',
      ],
    },
  },
  {
    id: 'mac-laptop-pending',
    displayName: 'MacBook Air Onboarding',
    platform: 'macos',
    hostUser: 'traveler-user',
    trafficLight: 'yellow',
    trafficLightReason: 'Pending enrollment approval by operator',
    enrollmentStatus: 'pending',
    workerIdentityKey: 'sprout-wk-macair-e018df33',
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
    workSafety: 'clear',
    workspaceRoots: ['/Users/traveler/projects'],
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
        avatar: '👤',
        responsibilities: 'Final task approval, validation, recovery, and scope changes.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'planner',
        memberKind: 'agent',
        displayName: 'Planner',
        avatar: '🧭',
        responsibilities: 'Roadmap planning, task coordination, task proposal formulation.',
        collaborationInstructions: 'Break tasks down into verifiable slices under 5 minutes duration.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'designer',
        memberKind: 'agent',
        displayName: 'Designer',
        avatar: '🎨',
        responsibilities: 'Color palette, 3D mesh geometry styles, mobile touch controls.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'programmer',
        memberKind: 'agent',
        displayName: 'Programmer',
        avatar: '💻',
        responsibilities: 'Board data structures, tile reveal recursion, mine placement algorithm.',
        joinedAt: '2 days ago',
        status: 'active',
      },
      {
        memberId: 'reviewer',
        memberKind: 'agent',
        displayName: 'Reviewer',
        avatar: '🔍',
        responsibilities: 'Headless browser testing, DOM verification, error detection.',
        joinedAt: '2 days ago',
        status: 'active',
      },
    ],
    boundEnvironmentWorkspaces: [
      {
        environmentId: 'mac-studio-primary',
        workspaceRoot: '/Users/workspace/sprout-projects',
        relativeWorkspacePath: 'minesweeper-threejs',
        isPrepared: true,
      },
      {
        environmentId: 'win-dev-box',
        workspaceRoot: 'C:\\SproutWorkspaces',
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
];

const initialTasks: TaskItem[] = [
  {
    id: 'task-101',
    projectId: 'proj-minesweeper',
    proposerId: 'planner',
    proposerKind: 'agent',
    createdAt: '35m ago',
    selectedEnvironmentId: 'mac-studio-primary',
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
          { time: '32m ago', kind: 'status_change', summary: 'Run admitted on mac-studio-primary using Task-held lease' },
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
    selectedEnvironmentId: 'mac-studio-primary',
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
        contentVersionUsed: 1,
        lifecycle: 'running',
        startedAt: '2m ago',
        events: [
          { time: '2m ago', kind: 'status_change', summary: 'Run admitted under Task-held lease on mac-studio-primary' },
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
    selectedEnvironmentId: 'mac-studio-primary',
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
      reason: 'Audio asset directory requires operator uncompress permission on mac-studio-primary.',
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
    selectedEnvironmentId: 'win-dev-box',
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
      goal: 'Precompile HLSL shaders on Windows host for native performance comparison.',
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
        contentVersionUsed: 1,
        lifecycle: 'interrupted',
        startedAt: '48m ago',
        settledAt: '14m ago',
        interruptionReason: 'Worker channel lost while Codex process was running on Windows host.',
        events: [
          { time: '48m ago', kind: 'status_change', summary: 'Run started' },
          { time: '46m ago', kind: 'tool_call', summary: 'bash dxc.exe -T ps_6_0 shader.hlsl' },
          { time: '14m ago', kind: 'status_change', summary: 'INTERRUPTED: Windows Worker disconnected unexpectedly' },
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
    taskLeadId: 'planner',
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
];

const initialMessages: MessageItem[] = [
  {
    id: 'msg-1',
    projectId: 'proj-minesweeper',
    scope: { kind: 'project-channel' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: 'Operator (Human)',
    authorAvatar: '👤',
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
    authorDisplayName: 'Planner',
    authorAvatar: '🧭',
    timestamp: '34m ago',
    content: 'Task #101 has been initiated with Programmer as lead to connect raycasting pointer events.',
    disposition: 'non-routing',
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
    authorDisplayName: 'Operator (Human)',
    authorAvatar: '👤',
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
    authorDisplayName: 'Designer',
    authorAvatar: '🎨',
    timestamp: '24m ago',
    content: 'I have adjusted the ambient light intensity in CSS/canvas configuration to 1.4 for crisp visibility.',
    disposition: 'non-routing',
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
    id: 'msg-5',
    projectId: 'proj-minesweeper',
    scope: { kind: 'working-group-channel', workingGroupId: 'wg-mechanics' },
    authorId: 'programmer',
    authorKind: 'agent',
    authorDisplayName: 'Programmer',
    authorAvatar: '💻',
    timestamp: '18m ago',
    content: 'Cascade recursion tested on 30x16 expert grid: depth 42 reached in under 1.2ms.',
    disposition: 'informational',
  },
  {
    id: 'msg-6',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'planner' },
    authorId: 'op-primary',
    authorKind: 'human',
    authorDisplayName: 'Operator (Human)',
    authorAvatar: '👤',
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
    authorDisplayName: 'Planner',
    authorAvatar: '🧭',
    timestamp: '9m ago',
    content: 'Yes, proposal Task #105 is ready for your Approve-and-Begin decision once Task #101 completes.',
    disposition: 'non-routing',
    isProjectedReply: true,
  },
];

const initialRoutingBatches: RoutingBatch[] = [
  {
    id: 'batch-002',
    projectId: 'proj-minesweeper',
    openedAt: '25m 00s ago',
    closedAt: '24m 30s ago',
    inputMessageIds: ['msg-3'],
    status: 'settled',
    attemptsCount: 1,
    wakeModel: 'gpt-4o-mini',
    frozenContextSummary: {
      tokenCount: 1840,
      projectRulesIncluded: true,
      recentMessagesCount: 4,
      tasksSummariesCount: 2,
      truncated: false,
    },
    decisions: [
      {
        messageId: 'msg-3',
        targetAgentId: 'designer',
        status: 'selected',
        rationale: 'Message discusses sRGB shader lighting aesthetics which maps directly to Designer responsibility slot.',
      },
    ],
    resultingWakeRequestIds: ['wake-02'],
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
    model: 'claude-3-5-sonnet',
    activityTime: '28m ago',
    wallDurationMs: 142000,
    tokenDimensions: {
      status: 'complete',
      totalInput: 50400,
      uncachedInput: 18400,
      cachedReads: 32000,
      cacheWrite: 4200,
      output: 6800,
      reasoningOutput: 2400,
      total: 61400,
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 142000, // $0.142
      provenance: 'harness_calculated',
      billingBasis: 'metered_api',
    },
    observationHistory: [
      {
        timestamp: '28m ago',
        source: 'Pi engine harness final turn emission',
        status: 'available',
        usdMicros: 142000,
        note: 'Calculated from frozen Pi model price catalogue v2025.2',
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
    model: 'gpt-4o',
    activityTime: '3m ago',
    wallDurationMs: 98000,
    tokenDimensions: {
      status: 'complete',
      totalInput: 36600,
      uncachedInput: 12100,
      cachedReads: 24500,
      cacheWrite: 0,
      output: 4100,
      reasoningOutput: 1200,
      total: 41900,
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 89000, // $0.089
      provenance: 'provider_estimated',
      billingBasis: 'metered_api',
    },
    observationHistory: [
      {
        timestamp: '3m ago',
        source: 'Codex app-server per-turn USD estimate',
        status: 'available',
        usdMicros: 89000,
        note: 'Emitted by Codex daemon turn/completed frame',
      },
    ],
  },
  {
    id: 'act-202',
    kind: 'agent_run',
    projectId: 'proj-minesweeper',
    agentId: 'designer',
    engine: 'codex',
    model: 'gpt-4o',
    activityTime: '24m ago',
    wallDurationMs: 34000,
    tokenDimensions: {
      status: 'complete',
      totalInput: 14200,
      uncachedInput: 4200,
      cachedReads: 10000,
      cacheWrite: 0,
      output: 1800,
      reasoningOutput: 600,
      total: 16000,
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 38000, // $0.038
      provenance: 'provider_estimated',
      billingBasis: 'metered_api',
    },
  },
  {
    id: 'act-wake-002',
    kind: 'routing_attempt',
    projectId: 'proj-minesweeper',
    model: 'gpt-4o-mini',
    activityTime: '24m 30s ago',
    wallDurationMs: 1400,
    tokenDimensions: {
      status: 'complete',
      totalInput: 1840,
      uncachedInput: 1840,
      cachedReads: 0,
      cacheWrite: 0,
      output: 120,
      reasoningOutput: 0,
      total: 1960,
    },
    costValuation: {
      attributableBilledCostStatus: 'unavailable',
      apiEquivalentStatus: 'available',
      estimatedUsdMicros: 350, // $0.00035
      provenance: 'locally_estimated',
      billingBasis: 'metered_api',
    },
  },
];

const initialAttentionItems: AttentionItem[] = [
  {
    id: 'att-1',
    severity: 'action_required',
    category: 'task_validation',
    title: 'Task #101 Awaiting Human Validation',
    summary: 'Lead Programmer submitted completion claim with browser verification evidence. Human decision required to accept or require correction.',
    referenceId: 'task-101',
    actionLabel: 'Review Completion Claim',
    actionTargetView: 'tasks',
  },
  {
    id: 'att-2',
    severity: 'action_required',
    category: 'task_recovery',
    title: 'Task #104 in Lease Recovery (Windows Host Offline)',
    summary: 'Windows worker disconnected during nested Agent run #206. Lease held in recovery; Human action needed (Resume, Discard, or Force Release).',
    referenceId: 'task-104',
    actionLabel: 'Inspect Recovery Options',
    actionTargetView: 'tasks',
  },
  {
    id: 'att-3',
    severity: 'attention',
    category: 'task_blocker',
    title: 'Task #103 Blocked on Asset Permission',
    summary: 'Lead Programmer reported blocker: Operator permission required to unpack spatial audio sound effect assets.',
    referenceId: 'task-103',
    actionLabel: 'Resolve Blocker',
    actionTargetView: 'tasks',
  },
  {
    id: 'att-4',
    severity: 'attention',
    category: 'env_enrollment',
    title: 'Pending Worker Enrollment: MacBook Air',
    summary: 'Worker sprout-wk-macair-e018df33 is requesting capability permissions approval.',
    referenceId: 'mac-laptop-pending',
    actionLabel: 'Review Enrollment',
    actionTargetView: 'environments',
  },
];

class StateManager {
  private state: PrototypeState;
  private listeners: Array<() => void> = [];

  constructor() {
    this.state = {
      viewportMode: 'mobile', // Default to mobile-first viewport
      theme: 'dark', // Default to dark theme
      density: 'comfortable', // Default to comfortable density
      primaryNav: 'feed', // 1st primary destination
      projectTab: 'tasks',
      manageTab: 'environments',
      activeTab: 'attention',
      selectedProjectId: 'proj-minesweeper',
      selectedScopeKind: 'project-channel',
      selectedTaskId: 'task-101',
      selectedEnvironmentId: 'mac-studio-primary',
      selectedAgentId: 'programmer',
      returnContext: null,
      activeDialog: null,
      usageFilter: {
        tab: 'run',
        timeRange: 'today',
        projectId: 'proj-minesweeper',
      },
      inspectorSheet: {
        isOpen: false,
        kind: 'none',
      },
      reviewDrawerOpen: false,
      operator: initialOperator,
      projects: initialProjects,
      agents: initialAgents,
      environments: initialEnvironments,
      tasks: initialTasks,
      messages: initialMessages,
      routingBatches: initialRoutingBatches,
      usageActivities: initialUsageActivities,
      attentionItems: initialAttentionItems,
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
      listener();
    }
  }

  // --- Primary Navigation & Context Tab Actions (ADR-0008, Issue #60) ---

  public setPrimaryNav(
    nav: PrimaryNav,
    projectTab?: ProjectTab,
    manageTab?: ManageTab
  ) {
    this.state.primaryNav = nav;
    if (projectTab) this.state.projectTab = projectTab;
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
    };
    if (target.taskId) this.state.selectedTaskId = target.taskId;
    if (target.envId) this.state.selectedEnvironmentId = target.envId;
    if (target.agentId) this.state.selectedAgentId = target.agentId;
    this.setPrimaryNav(target.nav, target.projectTab, target.manageTab);
    this.notify(`Deep-linked to ${target.nav} with return context from ${fromLabel}`);
  }

  public popReturnContext() {
    if (this.state.returnContext) {
      const { fromNav, fromProjectTab, fromManageTab, fromLabel } = this.state.returnContext;
      this.state.returnContext = null;
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

  public selectTask(taskId: string) {
    this.state.selectedTaskId = taskId;
    this.notify(`Selected Task #${taskId}`);
  }

  public selectEnvironment(envId: string) {
    this.state.selectedEnvironmentId = envId;
    this.notify(`Selected Environment ${envId}`);
  }

  public selectAgent(agentId: string) {
    this.state.selectedAgentId = agentId;
    this.notify(`Selected Agent ${agentId}`);
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

  public approveAndBeginProposal(taskId: string, environmentId: string, leadAgentId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'proposed') return;

    task.selectedEnvironmentId = environmentId;
    task.taskLeadId = leadAgentId;
    task.lifecycle = 'active';
    task.agentRunLifecycle = 'none';
    task.leaseLifecycle = 'held';

    // Simulate automatic first run submission for Agent lead
    const newRunId = `run-${Date.now().toString().slice(-3)}`;
    const leadAgent = this.state.agents.find((a) => a.id === leadAgentId);
    const newRun: NestedAgentRun = {
      id: newRunId,
      taskId: task.id,
      agentId: leadAgentId,
      agentDisplayName: leadAgent ? leadAgent.displayName : leadAgentId,
      engine: 'pi',
      workModel: 'claude-3-5-sonnet',
      effort: 'high',
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

    this.notify(`Approved & began Task #${taskId} on ${environmentId}. Lease held, first lead run started.`);
  }

  public pauseTask(taskId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (task.agentRunLifecycle === 'running') {
      // Stage 1: Pause requested (admission hold: current run finishes naturally)
      task.lifecycle = 'Task pause requested';
      this.notify(`Requested pause for Task #${taskId}: admission hold active; active run settling.`);
    } else {
      task.lifecycle = 'paused';
      this.notify(`Paused Task #${taskId}. Lease remains held.`);
    }
  }

  public interruptActiveRun(taskId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || !task.activeRunId) return;

    const run = task.runs.find((r) => r.id === task.activeRunId);
    if (run && run.lifecycle === 'running') {
      run.lifecycle = 'stopped';
      run.settledAt = 'Just now';
      run.stopRequestedBy = 'Operator (Human Interrupt)';
      run.events.push({ time: 'Just now', kind: 'status_change', summary: 'Run intentionally stopped by Human Interrupt.' });
    }

    task.agentRunLifecycle = 'stopped';
    task.lifecycle = 'paused';
    delete task.activeRunId;

    this.notify(`Interrupted active run in Task #${taskId}. Run stopped; Task paused; Lease retained.`);
  }

  public resumeTask(taskId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    task.lifecycle = 'active';
    task.agentRunLifecycle = 'none';
    this.notify(`Resumed Task #${taskId} to active deliberate advancement. Lease held.`);
  }

  public updateTaskContentVersion(
    taskId: string,
    newTitle: string,
    newGoal: string,
    newConstraints: string[],
    newValidationCriteria: string[],
    newLeadId: string
  ) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;

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

    this.notify(`Created Task content version v${nextVer} for Task #${taskId}. Active runs continue on prior version; future runs will use v${nextVer}.`);
  }

  public resolveBlocker(taskId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || !task.activeBlocker) return;

    delete task.activeBlocker;
    task.lifecycle = 'active';
    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);

    this.notify(`Resolved blocker on Task #${taskId}. Returned to active advancement.`);
  }

  public validateTaskCompletion(taskId: string, decision: 'accept' | 'require_correction', correctionNotes?: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || !task.pendingCompletionClaim) return;

    if (decision === 'accept') {
      task.lifecycle = 'completed';
      task.agentRunLifecycle = 'none';
      task.leaseLifecycle = 'released';
      delete task.pendingCompletionClaim;
      this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);

      // Release environment lease
      if (task.selectedEnvironmentId) {
        const env = this.state.environments.find((e) => e.id === task.selectedEnvironmentId);
        if (env && env.activeLeaseHolder?.holderId === task.id) {
          delete env.activeLeaseHolder;
          env.workSafety = 'clear';
          env.trafficLight = 'green';
          env.trafficLightReason = 'Ready for work · All capabilities permitted';
        }
      }

      this.notify(`Accepted Task #${taskId} completion claim! Task context recycled, lease safely released, Task completed.`);
    } else {
      task.lifecycle = 'active';
      delete task.pendingCompletionClaim;
      this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);

      // Add a note to history
      const correctionRun: NestedAgentRun = {
        id: `run-${Date.now().toString().slice(-3)}`,
        taskId: task.id,
        agentId: task.taskLeadId,
        agentDisplayName: task.taskLeadId,
        engine: 'pi',
        workModel: 'claude-3-5-sonnet',
        effort: 'high',
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
    }
  }

  public discardTask(taskId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    task.lifecycle = 'cancelled';
    task.agentRunLifecycle = 'none';
    task.leaseLifecycle = 'released';
    delete task.activeRunId;
    delete task.pendingCompletionClaim;
    delete task.activeBlocker;
    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId);

    if (task.selectedEnvironmentId) {
      const env = this.state.environments.find((e) => e.id === task.selectedEnvironmentId);
      if (env && env.activeLeaseHolder?.holderId === task.id) {
        delete env.activeLeaseHolder;
        env.workSafety = 'clear';
        env.trafficLight = 'green';
      }
    }

    this.notify(`Discarded Task #${taskId}. Safe Task end completed: scratch context recycled, lease released, Project workspace preserved.`);
  }

  // --- Recovery & Force Release Actions (ADR-0006, ADR-0009) ---

  public triggerSimulatedWorkerDisconnect(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.connectionState = 'offline';
    env.trafficLight = 'red';
    env.trafficLightReason = 'Worker connection lost mid-turn · Lease recovery required';
    env.workSafety = 'recovery';
    env.leaseRecovery = {
      cause: 'Carrier TCP connection timed out during active turn execution.',
      interruptedRunId: 'run-206',
      unresolvedFacts: [
        'Worker process unreachable over carrier overlay',
        'Engine process status unverified',
        'Task context directory not yet recycled',
      ],
    };

    // Mark task in recovery
    const task = this.state.tasks.find((t) => t.selectedEnvironmentId === envId && t.leaseLifecycle === 'held');
    if (task) {
      task.lifecycle = 'recovery';
      task.agentRunLifecycle = 'interrupted';
      task.leaseLifecycle = 'recovering';
      task.recoveryReason = 'Host worker channel lost mid-flight.';
    }

    this.state.attentionItems.unshift({
      id: `att-rec-${Date.now()}`,
      severity: 'action_required',
      category: 'task_recovery',
      title: `Recovery Required on ${env.displayName}`,
      summary: 'Carrier channel lost during active run. Lease held in recovery.',
      referenceId: task?.id ?? env.id,
      actionLabel: 'Inspect Recovery',
      actionTargetView: 'tasks',
    });

    this.notify(`Simulated worker disconnect on ${envId}. Lease locked in recovery; no automatic reassignment.`);
  }

  public resumeOrdinaryRecovery(taskId: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'recovery') return;

    task.lifecycle = 'active';
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
    this.notify(`Ordinary recovery: Resumed Task #${taskId} on same Environment. Interrupted run recorded as history fact.`);
  }

  public emergencyForceRelease(
    envId: string,
    taskId: string,
    reason: string,
    acknowledgedRisks: boolean
  ) {
    if (!acknowledgedRisks) return;

    const env = this.state.environments.find((e) => e.id === envId);
    const task = this.state.tasks.find((t) => t.id === taskId);

    if (task) {
      task.lifecycle = 'cancelled';
      task.agentRunLifecycle = 'none';
      task.leaseLifecycle = 'released';
      task.forcedReleaseDisposition = {
        actor: 'Operator (Human Emergency Force Release)',
        timestamp: new Date().toISOString(),
        reason,
        unresolvedFacts: env?.leaseRecovery?.unresolvedFacts ?? ['Unverified host cleanup'],
        risksAcknowledged: true,
      };
    }

    if (env) {
      delete env.activeLeaseHolder;
      delete env.leaseRecovery;
      env.workSafety = 'clear';
      env.trafficLight = 'green';
      env.trafficLightReason = `Force Released by Operator: "${reason}". Environment reassignable.`;
    }

    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== taskId && a.referenceId !== envId);
    this.closeInspector();

    this.notify(`EMERGENCY FORCE RELEASE authorized by Operator. Task #${taskId} cancelled with permanent forced release disposition. Environment ${envId} reassignable.`);
  }

  // --- Project, Messaging & Routing Actions (ADR-0007, ADR-0008) ---

  public sendMessage(
    projectId: string,
    scope: MessageItem['scope'],
    content: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const newMsgId = `msg-${Date.now().toString().slice(-4)}`;
    const isDirect = scope.kind === 'direct-message';
    const isExplicitMention = content.includes('@') || content.includes('@all');

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
      authorAvatar: '👤',
      timestamp: 'Just now',
      content,
      disposition,
    };

    this.state.messages.push(newMsg);

    if (disposition === 'addressed') {
      // Simulate deterministic reply
      setTimeout(() => {
        const replyMsgId = `msg-reply-${Date.now().toString().slice(-4)}`;
        const agentId = isDirect && 'recipientId' in scope ? scope.recipientId : 'programmer';
        const agent = this.state.agents.find((a) => a.id === agentId) ?? this.state.agents[0]!;

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
      }, 800);
      this.notify(`Sent addressed message ${newMsgId}. Bypasses wake policy; deterministic wake.`);
    } else if (disposition === 'wake-eligible') {
      // Simulate 30s batching window collection & wake model evaluation
      const batchId = `batch-${Date.now().toString().slice(-4)}`;
      const batch: RoutingBatch = {
        id: batchId,
        projectId,
        openedAt: 'Just now',
        closedAt: 'In 30s',
        inputMessageIds: [newMsgId],
        status: 'evaluating',
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
            targetAgentId: 'designer',
            status: 'selected',
            rationale: 'Unaddressed query matches Designer collaboration instructions.',
          },
        ],
        resultingWakeRequestIds: [`wake-${batchId}`],
      };
      this.state.routingBatches.unshift(batch);
      newMsg.routingCausalChainId = batchId;

      setTimeout(() => {
        batch.status = 'settled';
        batch.closedAt = 'Just now';
        const replyMsg: MessageItem = {
          id: `msg-proj-${Date.now().toString().slice(-4)}`,
          projectId,
          scope,
          authorId: 'designer',
          authorKind: 'agent',
          authorDisplayName: 'Designer',
          authorAvatar: '🎨',
          timestamp: 'Just now',
          content: `Evaluating unaddressed input from batch ${batchId}: Design updates configured.`,
          disposition: 'non-routing',
          isProjectedReply: true,
          projectedReplyMeta: {
            runId: `run-proj-${Date.now().toString().slice(-3)}`,
            agentId: 'designer',
            wakeRequestId: `wake-${batchId}`,
            triggeringMessageIds: [newMsgId],
          },
          routingCausalChainId: batchId,
        };
        this.state.messages.push(replyMsg);
        this.notify(`Routing batch ${batchId} settled. Projected reply emitted with non-routing disposition.`);
      }, 1200);

      this.notify(`Sent unaddressed message. Collected into 30s routing batch ${batchId}.`);
    } else {
      this.notify(`Sent informational message ${newMsgId}.`);
    }
  }

  public setProjectWakePolicy(projectId: string, policy: 'explicit-only' | 'wake-model-assisted') {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    project.wakePolicy = policy;
    this.notify(`Updated Project wake policy to ${policy}. Affects future messages only.`);
  }

  public createWorkingGroup(projectId: string, name: string, memberIds: string[], goal?: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const wgId = `wg-${Date.now().toString().slice(-4)}`;
    const newWg = {
      id: wgId,
      projectId,
      displayName: name,
      goal: goal ?? undefined,
      creatorId: this.state.operator.id,
      memberIds: Array.from(new Set([this.state.operator.id, ...memberIds])),
      status: 'active' as const,
      createdAt: 'Just now',
    };
    project.workingGroups.push(newWg);
    this.notify(`Created Working group "${name}" atomically with creator as initial member.`);
  }

  public disbandWorkingGroup(projectId: string, wgId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const wg = project.workingGroups.find((g) => g.id === wgId);
    if (!wg) return;

    wg.status = 'disbanded';
    this.notify(`Disbanded Working group "${wg.displayName}". Channel is now read-only; history preserved.`);
  }

  // --- Environment Enrollment Actions (ADR-0008, ADR-0009) ---

  public approveEnvironmentEnrollment(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.enrollmentStatus = 'approved';
    env.connectionState = 'online';
    env.trafficLight = 'green';
    env.trafficLightReason = 'Enrollment approved by Operator · All capabilities ready';
    this.state.attentionItems = this.state.attentionItems.filter((a) => a.referenceId !== envId);

    this.notify(`Approved Environment enrollment for ${env.displayName}. Worker identity verified.`);
  }

  public triggerReadinessProbe(envId: string) {
    const env = this.state.environments.find((e) => e.id === envId);
    if (!env) return;

    env.lastConfirmedTime = 'Just now';
    env.connectionAgeSec = 0;
    this.notify(`Ran live readiness probe on ${env.displayName}. Engines & protocol confirmed.`);
  }

  // --- Preset Scenario Jumpers for Owner Review ---

  public loadScenarioPreset(preset: string) {
    switch (preset) {
      case 'attention':
        this.setPrimaryNav('feed');
        this.notify('Loaded Scenario: Feed & Prominent Attention Section');
        break;
      case 'active-task':
        this.setPrimaryNav('project', 'tasks');
        this.state.selectedTaskId = 'task-102';
        this.notify('Loaded Scenario: Active Task with Live 2-Stage Pause & Interrupt');
        break;
      case 'validation-claim':
        this.setPrimaryNav('project', 'tasks');
        this.state.selectedTaskId = 'task-101';
        this.notify('Loaded Scenario: Task Awaiting Validation (Review Claim & Evidence)');
        break;
      case 'blocker-versioning':
        this.setPrimaryNav('project', 'tasks');
        this.state.selectedTaskId = 'task-103';
        this.notify('Loaded Scenario: Task Blocker & Content Versioning');
        break;
      case 'ordinary-recovery':
        this.setPrimaryNav('project', 'tasks');
        this.state.selectedTaskId = 'task-104';
        this.notify('Loaded Scenario: Worker Disconnect & Ordinary Lease Recovery');
        break;
      case 'emergency-force-release':
        this.setPrimaryNav('manage', undefined, 'environments');
        this.state.selectedEnvironmentId = 'win-dev-box';
        this.openInspector('force-release', 'win-dev-box');
        this.notify('Loaded Scenario: Emergency Override Force Release Modal');
        break;
      case 'wake-routing-batch':
        this.setPrimaryNav('project', 'chat');
        this.openInspector('routing', 'batch-002');
        this.notify('Loaded Scenario: Wake-Model Assisted Routing Batch & Causal Evidence');
        break;
      case 'usage-telemetry':
        this.setPrimaryNav('manage', undefined, 'usage');
        this.notify('Loaded Scenario: Usage & Monetary Cost Observability (6 Views)');
        break;
      case 'primitives-showcase':
        this.setPrimaryNav('primitives');
        this.notify('Loaded Scenario: Shared Interaction Primitives & State Language Testbed');
        break;
      default:
        break;
    }
  }
}

export const stateManager = new StateManager();
