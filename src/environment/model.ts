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
}

export interface Environment {
  readonly definition: EnvironmentDefinition;
  readonly instance: EnvironmentInstance;
}

export function findCapability(
  definition: EnvironmentDefinition,
  capability: string,
): EnvironmentCapability | undefined {
  return definition.capabilities.find((candidate) => candidate.name === capability);
}
