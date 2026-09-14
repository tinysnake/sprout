/**
 * Environment vocabulary shared by the core and every environment adapter.
 *
 * Mirrors the model settled in #4: a definition declares capabilities, each of
 * which states whether it requires an environment lease; instances are concrete
 * systems that satisfy a definition.
 */

export type EnvironmentPlatform = 'macos' | 'container' | 'windows';

export interface EnvironmentCapability {
  readonly name: string;
  readonly requiresLease: boolean;
}

export interface EnvironmentDefinition {
  readonly id: string;
  readonly platform: EnvironmentPlatform;
  readonly capabilities: readonly EnvironmentCapability[];
}

export interface EnvironmentInstance {
  readonly id: string;
  readonly definitionId: string;
  /**
   * The directory runs execute in on this instance.
   *
   * A path is a fact about a system, not about an agent (ADR-0003): the same
   * agent needs a different path inside a container than on a host. An agent may
   * still name a fallback for instances that declare none, but the instance is
   * authoritative when it does.
   */
  readonly workingDirectory?: string;
}

export interface Environment {
  readonly definition: EnvironmentDefinition;
  readonly instance: EnvironmentInstance;
}

/**
 * An explicit environment selection for a run.
 *
 * A durable Task may name the environment its work wants instead of leaving the
 * choice entirely to project matching. `instance` names one concrete system;
 * `definition` names a kind of environment, and the first available instance of
 * that kind wins. A preference is a **priority, not a guarantee**: when the named
 * environment is not granted by a project the agent belongs to, or cannot serve
 * the capability, resolution falls back to standard project matching.
 */
export interface EnvironmentPreference {
  readonly kind: 'definition' | 'instance';
  readonly id: string;
}

export function findCapability(
  definition: EnvironmentDefinition,
  capability: string,
): EnvironmentCapability | undefined {
  return definition.capabilities.find((candidate) => candidate.name === capability);
}
