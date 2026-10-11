import type { EnvironmentPlatform } from './environment/model.ts';
import type { ExecutionMode } from './execution-mode.ts';

/** Non-secret facts that identify where and under what boundary an engine ran. */
export interface EngineHostProfile {
  readonly platform: EnvironmentPlatform;
  readonly boundary: 'container' | 'shared-host' | 'unknown';
}

/** The actual host and its execution profile, kept separate from the work Environment. */
export interface EngineHostPlacement {
  readonly kind: 'environment' | 'sprout';
  /** Environment instance identity, or the opaque Sprout-host engine profile/session namespace for Host-run. */
  readonly id: string;
  readonly profile: EngineHostProfile;
}

/** Immutable process mode and, once resolved, the engine host/profile facts. */
export interface ExecutionPlacement {
  readonly mode: ExecutionMode;
  /** Absent only when a run failed before it was admitted to an engine host. */
  readonly engineHost?: EngineHostPlacement;
}

export type HostedExecutionPlacement = ExecutionPlacement & { readonly engineHost: EngineHostPlacement };

/** An authorized Conversation, Routing batch, or Task that owns native continuation. */
export type SessionKeyScope =
  | { readonly kind: 'conversation'; readonly id: string }
  | { readonly kind: 'routing-batch'; readonly id: string }
  | { readonly kind: 'task'; readonly id: string };

export function environmentEngineHost(instanceId: string, profile: EngineHostProfile): EngineHostPlacement {
  return { kind: 'environment', id: instanceId, profile };
}

/** Historical Environment-hosted rows have no measured profile; retain that uncertainty. */
export function legacyEnvironmentPlacement(instanceId?: string): ExecutionPlacement {
  return {
    mode: 'environment-hosted',
    ...(instanceId !== undefined && instanceId !== '' ? {
      engineHost: environmentEngineHost(instanceId, { platform: 'unknown', boundary: 'unknown' }),
    } : {}),
  };
}

export function normalizeLegacyRunPlacement<T extends {
  readonly environmentInstanceId: string;
  readonly executionPlacement?: ExecutionPlacement;
  readonly executionMode?: ExecutionMode;
  readonly engineHostProfileId?: string;
}>(run: T): T & { readonly executionPlacement: ExecutionPlacement } {
  if (run.executionPlacement !== undefined) return run as T & { readonly executionPlacement: ExecutionPlacement };
  const placement: ExecutionPlacement = run.executionMode === 'host-run'
    ? {
        mode: 'host-run',
        ...(run.engineHostProfileId !== undefined ? {
          engineHost: { kind: 'sprout', id: run.engineHostProfileId, profile: LEGACY_ENGINE_HOST_PROFILE },
        } : {}),
      }
    : legacyEnvironmentPlacement(run.environmentInstanceId);
  return { ...run, executionPlacement: placement };
}

export function normalizeLegacyTaskPlacement<T extends {
  readonly environmentInstanceId?: string;
  readonly executionPlacement?: ExecutionPlacement;
}>(task: T): T {
  return task.executionPlacement !== undefined || task.environmentInstanceId === undefined
    ? task
    : { ...task, executionPlacement: legacyEnvironmentPlacement(task.environmentInstanceId) };
}

/** Actionable reason shown when an unfinished Task belongs to another startup mode. */
export function executionModeMismatchReason(
  placement: ExecutionPlacement | undefined,
  processMode: ExecutionMode,
): string | undefined {
  if (placement === undefined || placement.mode === processMode) return undefined;
  return `Task was recorded under ${placement.mode}; this Sprout process is ${processMode}. Restart Sprout with --execution-mode ${placement.mode} to continue it. Its Environment, workspace, and lease remain bound to the recorded Task.`;
}

/** Historical Runs retain their recorded placement and are never replayed after restart. */
export function runExecutionModeMismatchReason(
  placement: ExecutionPlacement | undefined,
  processMode: ExecutionMode,
): string | undefined {
  if (placement === undefined || placement.mode === processMode) return undefined;
  return `Run was recorded under ${placement.mode}; this Sprout process is ${processMode}. Historical Runs are not replayed or relocated after restart.`;
}

export class ExecutionModeMismatchError extends Error {
  readonly code = 'execution-mode-mismatch' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ExecutionModeMismatchError';
  }
}

export function requireMatchingExecutionMode(
  placement: ExecutionPlacement | undefined,
  processMode: ExecutionMode,
): void {
  const reason = executionModeMismatchReason(placement, processMode);
  if (reason !== undefined) throw new ExecutionModeMismatchError(reason);
}

export function legacySessionScope(): SessionKeyScope {
  return { kind: 'conversation', id: 'legacy-unscoped' };
}

export const LEGACY_ENGINE_HOST_PROFILE: EngineHostProfile = {
  platform: 'unknown',
  boundary: 'unknown',
};

export function engineHostProfileForPlatform(platform: EnvironmentPlatform): EngineHostProfile {
  return {
    platform,
    boundary: platform === 'container' ? 'container' : platform === 'unknown' ? 'unknown' : 'shared-host',
  };
}

export function serializeExecutionPlacement(placement: ExecutionPlacement): string {
  return JSON.stringify(placement);
}

export function parseExecutionPlacement(value: string | null | undefined, environmentInstanceId?: string): ExecutionPlacement | undefined {
  if (value === null || value === undefined || value === '') {
    return environmentInstanceId === undefined ? undefined : legacyEnvironmentPlacement(environmentInstanceId);
  }
  const candidate = JSON.parse(value) as ExecutionPlacement;
  if (candidate.mode === 'environment-hosted' || candidate.mode === 'host-run') return candidate;
  return environmentInstanceId === undefined ? undefined : legacyEnvironmentPlacement(environmentInstanceId);
}

export function isEngineHostedPlacement(placement: ExecutionPlacement): placement is HostedExecutionPlacement {
  return placement.engineHost !== undefined;
}

export function sessionKeyPlacementTuple(placement: HostedExecutionPlacement): readonly unknown[] {
  return [
    placement.mode,
    placement.engineHost.kind,
    placement.engineHost.id,
    placement.engineHost.profile.platform,
    placement.engineHost.profile.boundary,
  ];
}

export function sessionKeyScopeTuple(scope: SessionKeyScope): readonly [SessionKeyScope['kind'], string] {
  return [scope.kind, scope.id];
}

export type { ExecutionMode } from './execution-mode.ts';
export type { EnvironmentPlatform } from './environment/model.ts';
