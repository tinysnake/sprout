import type {
  ActiveDialog,
  ActivityFeedItem,
  AgentDefinition,
  AttentionCategory,
  AttentionItem,
  AttentionSeverity,
  DensityMode,
  EnvironmentInstance,
  FeedLayoutVariant,
  FeedStatePreset,
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
  feedLayoutVariant: FeedLayoutVariant;
  feedStatePreset: FeedStatePreset;
  feedScopeFilter: string;
  feedAttentionSeverityFilter: 'all' | AttentionSeverity;
  feedAttentionFilter: 'all' | AttentionCategory | AttentionSeverity;
  feedActivityFilter: 'all' | 'tasks' | 'messages' | 'envs' | 'usage';
  mobileFeedSplitTab: 'attention' | 'activity';
  taskViewMode: 'list' | 'detail';
  taskFilter: string;
  chatViewMode: 'list' | 'detail';
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
  activityFeedItems: ActivityFeedItem[];
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
    id: "planner", displayName: "Planner", avatar: "PL",
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
    id: "designer", displayName: "Designer", avatar: "DS",
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
    id: "programmer", displayName: "Programmer", avatar: "PG",
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
    id: "reviewer", displayName: "Reviewer", avatar: "RV",
    description: 'Browser verification, regression tests, and acceptance audits.',
    standingInstructions: 'Run headless browser verification and check console error logs.',
    status: 'active',
    privateMemoryEntriesCount: 18,
    workOptions: [
      { id: 'opt-r1', engine: 'codex', workModel: 'gpt-4o', effort: 'high', isConfigured: true },
      { id: 'opt-r2', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'medium', isConfigured: true },
    ],
  },
  {
    id: "researcher", displayName: "Researcher", avatar: "RS",
    description: 'WebGL profiling, GPU buffer optimization, and browser benchmarks.',
    standingInstructions: 'Profile frametime bottlenecks and report GPU draw call telemetry.',
    status: 'active',
    privateMemoryEntriesCount: 7,
    workOptions: [
      { id: 'opt-rs1', engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'medium', isConfigured: true },
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
  {
    id: 'proj-unity-sims',
    displayName: 'Unity Room Lighting Prototype',
    templateSource: 'General collaboration template v1.0',
    createdAt: '3 days ago',
    goal: 'Prototype dynamic ray-traced ambient lighting for mobile and desktop room scenes.',
    rules: [
      'Maintain stable 60fps on M2 Max and Core i9 platforms.',
      'All lighting baking jobs execute on Windows Dev Host.',
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
        environmentId: 'win-dev-box',
        workspaceRoot: 'C:\\SproutWorkspaces',
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
        environmentId: 'mac-studio-primary',
        workspaceRoot: '/Users/workspace/sprout-projects',
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
    selectedEnvironmentId: 'win-dev-box',
    taskLeadId: 'programmer',
    lifecycle: 'proposed',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'none',
    currentVersion: {
      version: 1,
      createdAt: '1 hour ago',
      createdBy: 'Operator (Human)',
      title: 'Bake Progressive Lightmaps for Room Scene',
      goal: 'Generate 2048x2048 progressive GPU lightmaps on Windows Dev Host.',
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
    selectedEnvironmentId: 'mac-studio-primary',
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
  },
  {
    id: 'msg-11',
    projectId: 'proj-minesweeper',
    scope: { kind: 'direct-message', recipientId: 'researcher' },
    authorId: 'researcher',
    authorKind: 'agent',
    authorDisplayName: "Researcher", authorAvatar: "RS",
    timestamp: '1 day ago',
    content: 'Baseline WebGL benchmarks completed: 60fps steady on M2 Max, 45fps on Intel Iris.',
    disposition: 'informational',
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
    attribution: 'Worker Host (sprout-wk-windev-a19)',
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
    title: 'Pending Worker Enrollment: MacBook Air',
    summary: 'Worker sprout-wk-macair-e018df33 connected over Private Overlay and is requesting operator capability approval.',
    projectId: undefined,
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
    subtitle: 'Codex gpt-4o (run-205) executing Web Audio API oscillators on mac-studio-primary',
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
    title: 'New Worker Connected: sprout-wk-macair-e018df33',
    subtitle: 'Private Overlay transport · Protocol v1.4 compatible · Requesting enrollment approval',
    badgeKind: 'yellow',
    badgeLabel: 'Enrollment',
    actor: { name: "MacBook Air", avatar: "MB", kind: "worker" },
    targetNav: 'manage',
    targetManageTab: 'environments',
    targetEntityId: 'mac-laptop-pending',
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
    title: 'Worker win-dev-box heartbeat timed out',
    subtitle: 'Missed 4 consecutive heartbeat cycles · Task #104 lease placed in recovery',
    badgeKind: 'red',
    badgeLabel: 'Degraded',
    actor: { name: "Worker win-dev-box", avatar: "WN", kind: "system" },
    targetNav: 'manage',
    targetManageTab: 'environments',
    targetEntityId: 'win-dev-box',
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
    switch (preset) {
      case 'mixed': {
        this.state.attentionItems = [...initialAttentionItems];
        this.state.activityFeedItems = [...initialActivityFeedItems];
        const t101 = this.state.tasks.find((t) => t.id === 'task-101');
        if (t101) {
          t101.lifecycle = 'awaiting validation';
          t101.agentRunLifecycle = 'completed';
          t101.leaseLifecycle = 'held';
        }
        const t102 = this.state.tasks.find((t) => t.id === 'task-102');
        if (t102) {
          t102.lifecycle = 'active';
          t102.agentRunLifecycle = 'running';
          t102.leaseLifecycle = 'held';
        }
        const t103 = this.state.tasks.find((t) => t.id === 'task-103');
        if (t103) {
          t103.lifecycle = 'blocked';
          t103.agentRunLifecycle = 'stopped';
          t103.leaseLifecycle = 'held';
        }
        const t104 = this.state.tasks.find((t) => t.id === 'task-104');
        if (t104) {
          t104.lifecycle = 'recovery';
          t104.agentRunLifecycle = 'interrupted';
          t104.leaseLifecycle = 'recovering';
        }
        const winEnv = this.state.environments.find((e) => e.id === 'win-dev-box');
        if (winEnv) {
          winEnv.trafficLight = 'red';
          winEnv.trafficLightReason = 'Heartbeat timed out 12m ago · Task #104 lease held in unconfirmed recovery';
          winEnv.connectionState = 'offline';
        }
        const macStudio = this.state.environments.find((e) => e.id === 'mac-studio-primary');
        if (macStudio) {
          macStudio.trafficLight = 'green';
          macStudio.trafficLightReason = 'All 4 engine readiness probes confirmed · Lease held for Task #101';
          macStudio.connectionState = 'online';
        }
        const macLaptop = this.state.environments.find((e) => e.id === 'mac-laptop-pending');
        if (macLaptop) {
          macLaptop.enrollmentStatus = 'pending';
          macLaptop.trafficLight = 'yellow';
          macLaptop.trafficLightReason = 'Pending enrollment: Worker requesting capability permissions approval';
        }
        this.notify('Applied State Matrix Preset: Mixed (Default Realistic Operations)');
        break;
      }
      case 'empty': {
        this.state.attentionItems = [];
        const t101 = this.state.tasks.find((t) => t.id === 'task-101');
        if (t101) { t101.lifecycle = 'completed'; t101.agentRunLifecycle = 'completed'; t101.leaseLifecycle = 'released'; }
        const t102 = this.state.tasks.find((t) => t.id === 'task-102');
        if (t102) { t102.lifecycle = 'completed'; t102.agentRunLifecycle = 'completed'; t102.leaseLifecycle = 'released'; }
        const t103 = this.state.tasks.find((t) => t.id === 'task-103');
        if (t103) { t103.lifecycle = 'completed'; t103.agentRunLifecycle = 'completed'; t103.leaseLifecycle = 'released'; }
        const t104 = this.state.tasks.find((t) => t.id === 'task-104');
        if (t104) { t104.lifecycle = 'completed'; t104.agentRunLifecycle = 'completed'; t104.leaseLifecycle = 'released'; }
        for (const env of this.state.environments) {
          env.trafficLight = 'green';
          env.trafficLightReason = 'All engine readiness probes confirmed · Lease clear';
          env.connectionState = 'online';
          if (env.id === 'mac-laptop-pending') env.enrollmentStatus = 'approved';
        }
        this.notify('Applied State Matrix Preset: Empty (All Systems Clear)');
        break;
      }
      case 'healthy': {
        this.state.attentionItems = [];
        const t101 = this.state.tasks.find((t) => t.id === 'task-101');
        if (t101) {
          t101.lifecycle = 'active';
          t101.agentRunLifecycle = 'running';
          t101.leaseLifecycle = 'held';
        }
        const t102 = this.state.tasks.find((t) => t.id === 'task-102');
        if (t102) {
          t102.lifecycle = 'active';
          t102.agentRunLifecycle = 'running';
          t102.leaseLifecycle = 'held';
        }
        for (const env of this.state.environments) {
          env.trafficLight = 'green';
          env.trafficLightReason = 'Ready · All engines active · Low latency';
          env.connectionState = 'online';
          if (env.id === 'mac-laptop-pending') env.enrollmentStatus = 'approved';
        }
        this.notify('Applied State Matrix Preset: Healthy (Active Work Running Smoothly)');
        break;
      }
      case 'stale': {
        this.state.attentionItems = [
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
        const macStudio = this.state.environments.find((e) => e.id === 'mac-studio-primary');
        if (macStudio) {
          macStudio.trafficLight = 'yellow';
          macStudio.trafficLightReason = 'Heartbeat overdue 14m · Unconfirmed telemetry';
          macStudio.connectionState = 'reconnecting';
        }
        this.notify('Applied State Matrix Preset: Stale (Stale Telemetry & Unconfirmed Lease)');
        break;
      }
      case 'pending': {
        this.state.attentionItems = [
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
        this.notify('Applied State Matrix Preset: Pending (Proposed Tasks & Worker Enrollment)');
        break;
      }
      case 'degraded': {
        this.state.attentionItems = [
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
        const winEnv = this.state.environments.find((e) => e.id === 'win-dev-box');
        if (winEnv) {
          winEnv.trafficLight = 'red';
          winEnv.trafficLightReason = 'Heartbeat timed out 22m ago · Task #104 lease held in unconfirmed recovery';
          winEnv.connectionState = 'offline';
        }
        const macStudio = this.state.environments.find((e) => e.id === 'mac-studio-primary');
        if (macStudio) {
          macStudio.trafficLight = 'yellow';
          macStudio.trafficLightReason = '1/4 engine offline (Codex login-required) · Reconnecting';
          macStudio.engineReadiness.codex = 'login-required';
        }
        this.notify('Applied State Matrix Preset: Degraded (Offline Host & Engine Degraded)');
        break;
      }
      case 'intervention': {
        this.state.attentionItems = [
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
        this.notify('Applied State Matrix Preset: Intervention (Blockers & Validation Claims)');
        break;
      }
    }
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
      authorAvatar: "OP",
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
          authorDisplayName: "Designer", authorAvatar: "OP",
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

  public restoreWorkingGroup(projectId: string, wgId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const wg = project.workingGroups.find((g) => g.id === wgId);
    if (!wg) return;

    wg.status = 'active';
    this.notify(`Restored Working group "${wg.displayName}". Channel is active.`);
  }

  // --- Project Domain Actions (ADR-0006, ADR-0008) ---

  public createProject(
    displayName: string,
    goal?: string,
    rules?: string[],
    selectedAgentIds: string[] = [],
    boundEnvIds: string[] = []
  ) {
    if (!displayName || !displayName.trim()) {
      this.notify('Project creation failed: Display name cannot be empty.');
      return;
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

    for (const agentId of selectedAgentIds) {
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
        const root = env.workspaceRoots[0] || (env.platform === 'windows' ? 'C:\\SproutWorkspaces' : '/Users/workspace/sprout-projects');
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
  }

  public updateProjectContract(
    projectId: string,
    goal: string,
    rules: string[],
    completionGuidance?: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    project.goal = goal;
    project.rules = rules;
    if (completionGuidance !== undefined) {
      project.completionGuidance = completionGuidance;
    }
    this.notify(`Updated Project contract for "${project.displayName}". Affects future tasks and runs.`);
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

    project.status = 'archived';
    this.notify(`Archived Project "${project.displayName}". Channels are now read-only; history and workspaces preserved.`);
  }

  public restoreProject(projectId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    project.status = 'active';
    this.notify(`Restored Project "${project.displayName}" to active status.`);
  }

  public addProjectMembership(
    projectId: string,
    agentId: string,
    responsibilities?: string,
    instructions?: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const existing = project.memberships.find((m) => m.memberId === agentId);
    if (existing) {
      existing.status = 'active';
      if (responsibilities) existing.responsibilities = responsibilities;
      if (instructions) existing.collaborationInstructions = instructions;
      this.notify(`Restored membership for ${existing.displayName} in Project "${project.displayName}".`);
      return;
    }

    const globalAgent = this.state.agents.find((a) => a.id === agentId);
    if (!globalAgent) return;

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
  }

  public editProjectMembership(
    projectId: string,
    memberId: string,
    responsibilities?: string,
    instructions?: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const member = project.memberships.find((m) => m.memberId === memberId);
    if (!member) return;

    if (responsibilities !== undefined) member.responsibilities = responsibilities;
    if (instructions !== undefined) member.collaborationInstructions = instructions;
    this.notify(`Updated collaboration instructions for ${member.displayName} in Project "${project.displayName}".`);
  }

  public endProjectMembership(projectId: string, memberId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const member = project.memberships.find((m) => m.memberId === memberId);
    if (!member || member.memberKind === 'human') return; // Cannot remove local operator

    member.status = 'ended';

    // Also remove from active working groups
    for (const wg of project.workingGroups) {
      if (wg.status === 'active') {
        wg.memberIds = wg.memberIds.filter((id) => id !== memberId);
      }
    }

    // Check if active tasks depend on this lead
    const activeTasksWithLead = this.state.tasks.filter(
      (t) => t.projectId === projectId && t.taskLeadId === memberId && t.lifecycle !== 'completed' && t.lifecycle !== 'cancelled'
    );
    if (activeTasksWithLead.length > 0) {
      for (const t of activeTasksWithLead) {
        t.lifecycle = 'blocked';
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
  }

  public restoreProjectMembership(projectId: string, memberId: string) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const member = project.memberships.find((m) => m.memberId === memberId);
    if (!member) return;

    member.status = 'active';
    this.notify(`Restored membership for ${member.displayName} in Project "${project.displayName}".`);
  }

  public bindEnvironmentToProject(
    projectId: string,
    envId: string,
    workspaceRoot: string,
    relativePath: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const existing = project.boundEnvironmentWorkspaces.find((b) => b.environmentId === envId);
    if (existing) {
      existing.workspaceRoot = workspaceRoot;
      existing.relativeWorkspacePath = relativePath;
      existing.isPrepared = true;
      this.notify(`Updated workspace binding on ${envId} for Project "${project.displayName}".`);
      return;
    }

    project.boundEnvironmentWorkspaces.push({
      environmentId: envId,
      workspaceRoot,
      relativeWorkspacePath: relativePath,
      isPrepared: true,
    });
    this.notify(`Bound Environment ${envId} (${relativePath}) to Project "${project.displayName}". Workspace prepared.`);
  }

  public switchProjectWorkspacePath(
    projectId: string,
    envId: string,
    newRelativePath: string
  ) {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

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
  ) {
    const newId = `task-${Date.now().toString().slice(-3)}`;
    const newProp: TaskItem = {
      id: newId,
      projectId,
      proposerId: proposerId || (proposerKind === 'human' ? this.state.operator.id : 'planner'),
      proposerKind,
      createdAt: 'Just now',
      taskLeadId: leadId,
      lifecycle: 'proposed',
      agentRunLifecycle: 'none',
      leaseLifecycle: 'none',
      currentVersion: {
        version: 1,
        createdAt: 'Just now',
        createdBy: proposerKind === 'human' ? 'Operator (Human)' : `${leadId} (Agent)`,
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
  }

  public rejectTaskProposal(taskId: string, reason: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'proposed') return;

    task.lifecycle = 'rejected';
    this.notify(`Rejected Task Proposal #${taskId.replace('task-', '')}: ${reason}`);
  }

  public simulateLeadAutonomousRun(taskId: string, agentId?: string) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task || task.lifecycle !== 'active' || task.leaseLifecycle !== 'held') return;

    const targetAgentId = agentId || (task.runs.length % 2 === 0 ? 'reviewer' : task.taskLeadId);
    const agent = this.state.agents.find((a) => a.id === targetAgentId);
    const runId = `run-${Date.now().toString().slice(-3)}`;

    const newRun: NestedAgentRun = {
      id: runId,
      taskId: task.id,
      agentId: targetAgentId,
      agentDisplayName: agent ? agent.displayName : targetAgentId,
      engine: 'codex',
      workModel: 'gpt-4o',
      effort: 'high',
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

    if (task.activeRunId) {
      const run = task.runs.find((r) => r.id === task.activeRunId);
      if (run) {
        run.lifecycle = 'completed';
        run.settledAt = 'Just now';
      }
      delete task.activeRunId;
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
      default:
        break;
    }
  }
}

export const stateManager = new StateManager();
