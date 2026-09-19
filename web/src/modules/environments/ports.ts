import type {
  CapabilityKey,
  EnvironmentInstance,
  ForceReleaseParams,
  ProbeRecord,
} from './types.js';

/**
 * Authoritative remote-state port for Environment management and recovery.
 * Separates backend facts from UI state as specified in ADR-0011.
 */
export interface EnvironmentService {
  listEnvironments(): Promise<EnvironmentInstance[]>;
  getEnvironment(id: string): Promise<EnvironmentInstance | undefined>;
  approveEnrollment(id: string): Promise<void>;
  triggerProbe(id: string): Promise<ProbeRecord>;
  togglePermission(id: string, cap: CapabilityKey): Promise<void>;
  unbindWorkspace(projectId: string, envId: string): Promise<void>;
  reconcileEvidence(id: string): Promise<void>;
  resumeRecovery(taskId: string): Promise<void>;
  discardRecovery(taskId: string): Promise<void>;
  forceRelease(params: ForceReleaseParams): Promise<void>;
  archiveEnvironment(id: string): Promise<void>;
  restoreEnvironment(id: string): Promise<void>;
  unenrollEnvironment(id: string): Promise<void>;
}
