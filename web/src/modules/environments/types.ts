export type PlatformType = 'macos' | 'windows' | 'container';
export type TrafficLight = 'green' | 'yellow' | 'red';
export type EnrollmentStatus = 'approved' | 'pending' | 'revoked' | 'archived';
export type ConnectionState = 'online' | 'reconnecting' | 'offline' | 'never_connected';
export type ProtocolCompatibility = 'compatible' | 'incompatible' | 'unknown';
export type WorkSafety = 'clear' | 'held' | 'reconciling' | 'recovery';
export type EngineStatus = 'ready' | 'login-required' | 'missing' | 'unknown';

export type CapabilityKey = string;

/**
 * The engine readiness rows the page renders.
 *
 * The production adapter reports whatever engines the Worker declared plus the
 * required set; the prototype's fixed Codex/Pi/agy/opencode quadrants are the
 * fixture's one representative ordering, not the schema. Components iterate.
 */
export type EngineReadiness = Record<string, EngineStatus>;

export interface EngineDetailInfo {
  version?: string;
  /** Independent Worker facts; none is inferred from readiness or another row. */
  installed?: boolean;
  readiness?: EngineStatus;
  authStatus: string;
  authenticated?: boolean;
  authMode?: string;
  authType?: string;
  modelAvailability?: string;
  models?: string[];
  targetModels?: string[];
  modelIdPresent?: boolean;
  observedAt?: number;
  probeExitCode?: number;
  source?: string;
  notes?: string;
  modelAuthorizations?: readonly {
    readonly engine: string;
    readonly model: string;
    readonly source: 'human-approval';
    readonly requirementRevision?: string;
    readonly authorizedAt: number;
    readonly actor?: string;
  }[];
}

export interface ActiveLeaseHolder {
  holderId: string;
  holderKind: 'task' | 'run';
  taskTitle?: string;
  projectId: string;
  leadAgentName?: string;
  acquiredAt: string;
}

export interface ReconciledEvidence {
  retainedEventsCount: number;
  engineStoppedProof: boolean;
  turnSettlementObserved?: boolean;
  terminalStatus?: 'completed' | 'failed' | 'interrupted' | 'stopped';
  taskContextRecycled?: boolean;
}

export interface LeaseRecovery {
  cause: string;
  /** The open recovery record's lease id, the target of every decision. */
  leaseId?: string;
  interruptedRunId?: string;
  interruptedRunAgent?: string;
  /** True once evidence was synchronized; it gates the ordinary decisions. */
  evidenceSynchronized?: boolean;
  /** Sanitized server signal for unresolved remote outcomes or process stops. */
  remoteWorkEvidence?: { unresolved: boolean };
  unresolvedFacts: string[];
  reconciledEvidence?: ReconciledEvidence;
}

export interface ForcedReleaseRecord {
  actor: string;
  timestamp: string;
  reason: string;
}

export interface ProbeRecord {
  /** ISO rendering of the Worker's `at`, never the browser request time. */
  timestamp: string;
  observedAt?: number;
  latencyMs: number;
  protocolOk: boolean;
  enginesOk: boolean;
  summary: string;
  source?: 'worker';
  version?: string;
}

/** The capabilities the enrollment actually declared, keyed by name. */
export type CapabilityPermissions = Record<string, boolean>;

export interface BoundWorkspace {
  projectId: string;
  projectDisplayName: string;
  workspaceRoot: string;
  relativeWorkspacePath: string;
  status: string;
}

export interface EnvironmentInstance {
  /** Enrollment key for Manage Environments routes and enrollment commands. */
  id: string;
  /** Runtime/catalog identity for Project access, workspace and Agent compatibility. */
  environmentInstanceId: string;
  displayName: string;
  platform: PlatformType;
  trafficLight: TrafficLight;
  trafficLightReason: string;
  enrollmentStatus: EnrollmentStatus;
  connectionState: ConnectionState;
  connectionAgeSec: number;
  lastConfirmedTime: string;
  protocolVersion: string;
  protocolCompatibility: ProtocolCompatibility;
  protocolMismatchDetail?: string | undefined;
  /** A proved, refused connection attempt; never current compatibility. */
  connectionAttempt?: { outcome: 'incompatible'; reason: string; at: number } | undefined;
  workSafety: WorkSafety;
  activeLeaseHolder?: ActiveLeaseHolder | undefined;
  capabilityPermissions: CapabilityPermissions;
  engineReadiness: EngineReadiness;
  engineDetails?: Record<string, EngineDetailInfo> | undefined;
  leaseRecovery?: LeaseRecovery | undefined;
  forcedReleaseRecord?: ForcedReleaseRecord | undefined;
  probeHistory: ProbeRecord[];
  boundWorkspaces: BoundWorkspace[];
  identityDigest?: string | undefined;
  claim?: {
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly consumedAt?: number;
  } | undefined;
  decisions?: readonly {
    readonly kind: string;
    readonly actor: string;
    readonly at: number;
    readonly reason: string;
  }[] | undefined;
  requestedCapabilities?: readonly string[] | undefined;
  targetModelsByEngine?: Record<string, readonly string[]> | undefined;
  requirements?: import('../../adapters/environment-api.ts').ReadinessRequirementScope | undefined;
}

export type EnvironmentFilter = 'all' | 'ready' | 'attention' | 'action-required' | 'archived' | 'revoked';

export interface ForceReleaseParams {
  environmentId: string;
  taskId: string;
  reason: string;
  acknowledgedRisks: boolean;
}
