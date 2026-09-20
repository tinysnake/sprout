import type { EnvironmentEnrollment } from './enrollment.ts';
import {
  protocolCompatibility,
  summarizeEnvironmentReadiness,
  workSafetyFromLeases,
  type CapabilityReadinessFact,
  type CompatibilityFact,
  type ConnectionFact,
  type EngineReadinessFact,
  type EnvironmentReadiness,
  type EnvironmentReadinessSummary,
  type LeaseSafetyFact,
  type ProtocolVersionRange,
  type WorkSafetyState,
} from './readiness.ts';

/**
 * Assemble one Environment's independent readiness facts and its summary (#87).
 *
 * This is the single place the dimensions are joined, so no caller can collapse
 * them or invent a different summary. Every input is an explicit fact:
 *
 * - enrollment comes from the durable enrollment decision;
 * - connection, compatibility, and engine facts come from the durable Worker
 *   observation (never from the presence of a process);
 * - work safety is projected from the lease registry;
 * - capability permission is projected from the approved enrollment permissions.
 */

/**
 * The engines the Environment's configured use requires.
 *
 * ADR-0008 requires Codex and Pi *across the product*, not both on every
 * Environment instance, so there is deliberately no default pair. The required
 * set comes only from an explicit caller/configuration declaration: an empty
 * configuration requires nothing and must never fabricate a dual-engine
 * requirement. An engine the Worker declared but nobody requires stays an
 * honestly non-required fact (Yellow at most), never a fabricated Red.
 */
export interface ReadinessEnginesDeclaration {
  /** Engines the Environment's configured use requires. */
  readonly required: readonly string[];
}

export interface AssembleReadinessInput {
  readonly enrollment: EnvironmentEnrollment;
  readonly observed:
    | {
        readonly connection: ConnectionFact;
        readonly compatibility: CompatibilityFact;
        readonly engines: readonly EngineReadinessFact[];
      }
    | undefined;
  readonly leases: readonly LeaseSafetyFact[];
  readonly requiredEngines: readonly string[];
  readonly probe?: EnvironmentReadiness['probe'];
  readonly supportedProtocol: ProtocolVersionRange;
  readonly now: number;
  readonly staleProbeAfterMs?: number;
}

export interface AssembledReadiness {
  readonly readiness: EnvironmentReadiness;
  readonly summary: EnvironmentReadinessSummary;
}

export function assembleEnvironmentReadiness(input: AssembleReadinessInput): AssembledReadiness {
  const connection: ConnectionFact = input.observed?.connection ?? { state: 'never-connected' };
  const compatibility: CompatibilityFact =
    input.observed?.compatibility ?? { state: 'unknown' };
  const requiredEngines = new Set(input.requiredEngines);
  const capabilities: readonly CapabilityReadinessFact[] = Object.entries(
    input.enrollment.capabilityPermissions,
  ).map(([name, allowed]) => ({
    name,
    permission: allowed ? 'allowed' : 'denied',
    required: input.enrollment.worker.capabilityRequests.includes(name),
  }));

  const observedEngines = new Map(
    (input.observed?.engines ?? []).map((engine) => [engine.engine, engine] as const),
  );
  // Report every engine the Worker declared, so an engine that became missing is
  // visible rather than quietly dropped from the projection.
  const engineIds = new Set<string>([
    ...(input.observed?.engines ?? []).map((engine) => engine.engine),
    ...input.requiredEngines,
  ]);
  const engines: readonly EngineReadinessFact[] = [...engineIds].map((engine) => {
    const observed = observedEngines.get(engine);
    return {
      engine,
      installed: observed?.installed ?? false,
      readiness: observed?.readiness ?? 'unknown',
      required: requiredEngines.has(engine),
      models: observed?.models ?? { state: 'unknown', models: [] },
    };
  });

  const workSafetyState: WorkSafetyState = workSafetyFromLeases(
    input.leases,
    input.enrollment.environmentInstanceId,
  );

  const readiness: EnvironmentReadiness = {
    enrollmentStatus: input.enrollment.status,
    connection,
    // The durable compatibility observation is authoritative; a Worker version
    // that arrived on a later connection supersedes an older stored value.
    compatibility: refineCompatibility(compatibility, input.supportedProtocol),
    capabilities,
    engines,
    ...(input.probe !== undefined ? { probe: input.probe } : {}),
    workSafety: { state: workSafetyState },
  };

  return {
    readiness,
    summary: summarizeEnvironmentReadiness(readiness, {
      now: input.now,
      ...(input.staleProbeAfterMs !== undefined ? { staleProbeAfterMs: input.staleProbeAfterMs } : {}),
    }),
  };
}

/**
 * Re-derive compatibility from the reported version when one is present.
 *
 * The Worker reports a version, and the supported range is a Sprout fact. Storing
 * the derived state keeps reads cheap, but a later supported-range change must be
 * able to correct the projection, so the version always wins when present.
 */
function refineCompatibility(
  observed: CompatibilityFact,
  supported: ProtocolVersionRange,
): CompatibilityFact {
  if (observed.workerProtocolVersion === undefined) return observed;
  const derived = protocolCompatibility(observed.workerProtocolVersion, supported);
  return {
    state: derived.state,
    workerProtocolVersion: observed.workerProtocolVersion,
    ...(derived.detail !== undefined ? { detail: derived.detail } : {}),
  };
}
