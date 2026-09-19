export type PlatformType = 'macos' | 'windows' | 'container';
export type TrafficLight = 'green' | 'yellow' | 'red';
export type EnrollmentStatus = 'approved' | 'pending' | 'revoked' | 'archived';
export type ConnectionState = 'online' | 'reconnecting' | 'offline' | 'never_connected';
export type ProtocolCompatibility = 'compatible' | 'incompatible' | 'unknown';
export type WorkSafety = 'clear' | 'held' | 'reconciling' | 'recovery';
export type EngineStatus = 'ready' | 'login-required' | 'missing' | 'unknown';

export type CapabilityKey = 'fileReadWrite' | 'processExecution' | 'networkAccess' | 'guiAutomation';

export interface CapabilityPermissions {
  fileReadWrite: boolean;
  processExecution: boolean;
  networkAccess: boolean;
  guiAutomation: boolean;
}

export interface EngineReadiness {
  codex: EngineStatus;
  pi: EngineStatus;
  agy: EngineStatus;
  opencode: EngineStatus;
}

export interface EngineDetailInfo {
  version: string;
  authStatus: string;
  modelAvailability?: string;
  notes?: string;
}

export interface ActiveLeaseHolder {
  holderId: string;
  holderKind: 'task';
  taskTitle?: string;
  projectId: string;
  leadAgentName?: string;
  acquiredAt: string;
}

export interface ReconciledEvidence {
  retainedEventsCount: number;
  engineStoppedProof: boolean;
}

export interface LeaseRecovery {
  cause: string;
  interruptedRunId?: string;
  interruptedRunAgent?: string;
  unresolvedFacts: string[];
  reconciledEvidence?: ReconciledEvidence;
}

export interface ForcedReleaseRecord {
  actor: string;
  timestamp: string;
  reason: string;
}

export interface ProbeRecord {
  timestamp: string;
  latencyMs: number;
  protocolOk: boolean;
  enginesOk: boolean;
  summary: string;
}

export interface BoundWorkspace {
  projectId: string;
  projectDisplayName: string;
  workspaceRoot: string;
  relativeWorkspacePath: string;
  status: string;
}

export interface EnvironmentInstance {
  id: string;
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
  workSafety: WorkSafety;
  activeLeaseHolder?: ActiveLeaseHolder | undefined;
  capabilityPermissions: CapabilityPermissions;
  engineReadiness: EngineReadiness;
  engineDetails?: Record<string, EngineDetailInfo> | undefined;
  leaseRecovery?: LeaseRecovery | undefined;
  forcedReleaseRecord?: ForcedReleaseRecord | undefined;
  probeHistory: ProbeRecord[];
  boundWorkspaces: BoundWorkspace[];
}

export type EnvironmentFilter = 'all' | 'ready' | 'attention' | 'action-required' | 'archived';

export interface ForceReleaseParams {
  environmentId: string;
  taskId: string;
  reason: string;
  acknowledgedRisks: boolean;
}
