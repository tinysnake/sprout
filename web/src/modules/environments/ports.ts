import type { InjectionKey } from 'vue';
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
  /**
   * Whether this service can drive the "reconcile evidence" action at all.
   *
   * Retained settlement evidence is a Worker fact (ADR-0009): only the Worker
   * can synchronize what it retained. An adapter declares this capability only
   * when it really can reach such a Worker port. Production never does — no
   * Worker evidence port exists on the wire, and a placeholder payload would
   * fabricate the exact evidence gate that ordinary recovery decisions require.
   * When this is `false` the page renders the reconciling box read-only with an
   * explicit not-synchronized state instead of offering the action.
   */
  readonly supportsEvidenceReconciliation: boolean;
}

/**
 * The typed adapter the Environment route requires.
 *
 * A production route never constructs its own authority: the bootstrap wires a
 * real adapter here and deterministic tests inject a fixture one explicitly.
 * When nothing is provided the route fails closed with an explicit unavailable
 * state rather than falling back to fixture facts.
 */
export const ENVIRONMENT_SERVICE: InjectionKey<EnvironmentService> = Symbol(
  'sprout.environments.service'
);
