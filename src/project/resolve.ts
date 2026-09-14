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
  | { readonly ok: true; readonly instanceId: string; readonly projectId: string }
  | { readonly ok: false; readonly reason: 'no-project' | 'no-available-environment' };

/**
 * Resolve the environment instance for one run.
 *
 * `projects` are the projects the agent is a member of, in preference order.
 * Each project's `availableEnvironmentInstanceIds` is tried in its declared
 * order, and `pool` decides whether an instance can serve the capability.
 */
export function resolveEnvironmentInstance(
  projects: readonly Project[],
  capability: string,
  pool: Pick<EnvironmentPool, 'requiresLease'>,
): EnvironmentResolution {
  if (projects.length === 0) return { ok: false, reason: 'no-project' };

  for (const project of projects) {
    for (const instanceId of project.availableEnvironmentInstanceIds) {
      if (pool.requiresLease(instanceId, capability) !== undefined) {
        return { ok: true, instanceId, projectId: project.id };
      }
    }
  }

  return { ok: false, reason: 'no-available-environment' };
}
