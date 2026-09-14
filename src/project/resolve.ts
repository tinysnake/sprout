import type { EnvironmentPreference } from '../environment/model.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import type { Project } from './model.ts';

/**
 * Environment resolution: choosing the instance a run actually uses.
 *
 * This is the seam that decouples an agent from a device. The agent declares a
 * capability; the project it is a member of declares which environment instances
 * its work may use; the pool says which of those can serve the capability. The
 * result is one instance id, resolved **before** a lease is requested, so the
 * existing lease conflict/recovery semantics still decide exclusivity.
 *
 * Resolution is deliberately deterministic and non-searching: the first
 * available instance that can serve the capability wins. It never "shops around"
 * for a free instance, because a run that quietly moved to another environment
 * on conflict would make lease conflicts — and recovery of uncommitted work —
 * unobservable.
 */

export type EnvironmentResolution =
  | {
      readonly ok: true;
      readonly instanceId: string;
      readonly projectId: string;
      /**
       * True only when the resolution honoured the caller's explicit
       * `environmentPreference` rather than falling through to project matching.
       * Persisted so a human can see that the preference was actually used.
       */
      readonly preferred: boolean;
    }
  | { readonly ok: false; readonly reason: 'no-project' | 'no-available-environment' };

/**
 * What a run needs for its environment resolved.
 *
 * `projects` are the projects the agent is a member of, in preference order;
 * each project's `availableEnvironmentInstanceIds` is tried in its declared
 * order. `environmentPreference`, when present, is honoured first — so an
 * explicitly selected Task environment takes priority over system matching — but
 * only for an instance the agent's projects actually grant.
 */
export interface ResolveEnvironmentRequest {
  readonly projects: readonly Project[];
  readonly capability: string;
  readonly environmentPreference?: EnvironmentPreference;
}

/**
 * Whether one instance satisfies an explicit environment preference.
 *
 * An `instance` preference matches the instance id; a `definition` preference
 * matches the definition the instance is built from. An instance the pool does
 * not know never matches.
 */
export function matchesPreference(
  instanceId: string,
  preference: EnvironmentPreference,
  pool: Pick<EnvironmentPool, 'instance'>,
): boolean {
  const instance = pool.instance(instanceId);
  if (instance === undefined) return false;
  return preference.kind === 'instance'
    ? instance.id === preference.id
    : instance.definitionId === preference.id;
}

/**
 * Resolve the environment instance for one run.
 *
 * Two layers, in order:
 *
 * 1. **Explicit preference.** When the caller names an environment, the first
 *    granted instance matching it wins. This is roadmap M1 scope item 8: "an
 *    explicitly selected task environment takes priority".
 * 2. **System matching.** Otherwise, or when the preference matches nothing
 *    available, the first granted instance that can serve the capability wins.
 */
export function resolveEnvironmentInstance(
  request: ResolveEnvironmentRequest,
  pool: Pick<EnvironmentPool, 'instance' | 'requiresLease'>,
): EnvironmentResolution;
/**
 * @deprecated Pass a request object so an environment preference can be honoured.
 * The positional form still resolves by project matching alone.
 */
export function resolveEnvironmentInstance(
  projects: readonly Project[],
  capability: string,
  pool: Pick<EnvironmentPool, 'instance' | 'requiresLease'>,
): EnvironmentResolution;
export function resolveEnvironmentInstance(
  requestOrProjects: ResolveEnvironmentRequest | readonly Project[],
  capabilityOrPool: string | Pick<EnvironmentPool, 'instance' | 'requiresLease'>,
  maybePool?: Pick<EnvironmentPool, 'instance' | 'requiresLease'>,
): EnvironmentResolution {
  const positional = Array.isArray(requestOrProjects);
  const request: ResolveEnvironmentRequest = positional
    ? {
        projects: requestOrProjects as readonly Project[],
        capability: capabilityOrPool as string,
      }
    : (requestOrProjects as ResolveEnvironmentRequest);
  const pool = (positional ? maybePool : capabilityOrPool) as Pick<
    EnvironmentPool,
    'instance' | 'requiresLease'
  >;
  const { projects, capability, environmentPreference } = request;
  if (projects.length === 0) return { ok: false, reason: 'no-project' };

  for (const project of projects) {
    for (const instanceId of project.availableEnvironmentInstanceIds) {
      if (pool.requiresLease(instanceId, capability) === undefined) continue;
      // A project may name an instance the pool does not know; a preference can
      // never match that instance, so it can still only be used by fallback.
      if (environmentPreference !== undefined && matchesPreference(instanceId, environmentPreference, pool)) {
        return { ok: true, instanceId, projectId: project.id, preferred: true };
      }
    }
  }

  for (const project of projects) {
    for (const instanceId of project.availableEnvironmentInstanceIds) {
      if (pool.requiresLease(instanceId, capability) !== undefined) {
        return { ok: true, instanceId, projectId: project.id, preferred: false };
      }
    }
  }

  return { ok: false, reason: 'no-available-environment' };
}
