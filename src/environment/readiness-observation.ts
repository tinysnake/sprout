import { validateWorkerReadinessProbeResult } from '../worker/readiness-ingress.ts';
import type { WorkerProbeFact } from '../worker/protocol.ts';
import {
  allowlistedReadinessValue,
  observedFactsFromWorkerReadiness,
  READINESS_AUTH_MODES,
  READINESS_AUTH_TYPES,
  READINESS_SOURCES,
  type ProbeResultFact,
  type ProtocolVersionRange,
  type ReadinessRequirementScope,
} from './readiness.ts';
import {
  DEFAULT_COMPATIBILITY_DETAIL, DEFAULT_PROBE_SUMMARY, sanitizeIdentifier,
  sanitizeOperatorText, sanitizeProbeVersion, sanitizeProtocolVersion,
} from './privacy.ts';
import type { ObservedReadiness, ReadinessWriteAuthority } from './readiness-store.ts';
import {
  type ObservationAuthorityVerifier,
  type ReadinessObservationAuthority,
} from './readiness-authority.ts';

declare const canonicalObservation: unique symbol;

/** Runtime-opaque proof of canonical validation, privacy reduction, and scope. */
export interface ReadinessObservation {
  readonly [canonicalObservation]: true;
}

/** Immutable authority scope representation for readiness observations (#126). */
export interface ReadinessAuthorityScope {
  readonly environmentInstanceId: string;
  readonly enrollmentId: string;
  readonly connectionEpoch: number;
  readonly connectionId?: string;
  readonly lifecycleGeneration?: number;
}

export interface StoredObservationPair {
  readonly observationId: string;
  readonly readiness: ObservedReadiness;
  readonly probe: ProbeResultFact & WorkerProbeFact;
  readonly requirements?: ReadinessRequirementScope;
  readonly authorityScope: ReadinessAuthorityScope;
}

/** Generate an opaque, non-sensitive observation identity (#126). */
export function createObservationId(): string {
  return `obs-${crypto.randomUUID()}`;
}

// A type assertion, object spread, or copied brand cannot forge this identity.
// Neither the caller's Worker result nor a store reader owns these snapshots.
const observations = new WeakMap<object, {
  readonly environmentInstanceId: string;
  readonly authority: ReadinessWriteAuthority;
  readonly verifyAuthority: ObservationAuthorityVerifier;
  readonly observationId: string;
  readonly requirements?: ReadinessRequirementScope;
  readonly authorityScope: ReadinessAuthorityScope;
  readonly pair: {
    readonly readiness: ObservedReadiness;
    readonly probe: ProbeResultFact & WorkerProbeFact;
  };
}>();

export interface CreateObservationScope {
  readonly environmentInstanceId: string;
  readonly authority: ReadinessObservationAuthority;
  readonly supported: ProtocolVersionRange;
  readonly at: number;
  readonly verifyAuthority: ObservationAuthorityVerifier;
  readonly requirements?: ReadinessRequirementScope;
}

/** The only constructor; there is deliberately no projected-fact constructor. */
export function createReadinessObservation(
  result: unknown,
  scope: CreateObservationScope,
): ReadinessObservation | undefined {
  const verified = scope.verifyAuthority(scope.authority, {
    environmentInstanceId: scope.environmentInstanceId,
  });
  if (verified === undefined) return undefined;
  const validated = validateWorkerReadinessProbeResult(result);
  if (validated === undefined) return undefined;
  const { authority } = scope;
  const { enrollmentId, connectionEpoch } = verified;
  if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch <= 0) return undefined;
  const observationId = createObservationId();
  const requirements = scope.requirements;
  if (requirements !== undefined && (
    (requirements.revision !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(requirements.revision)) ||
    [requirements.requiredEngines, requirements.requiredModels].some((values) =>
      values !== undefined && (!Array.isArray(values) || values.some((value) =>
        typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value))))
  )) return undefined;
  const requirementSnapshot = requirements === undefined ? undefined : structuredClone(requirements);
  const authorityScope: ReadinessAuthorityScope = {
    environmentInstanceId: verified.environmentInstanceId,
    enrollmentId: verified.enrollmentId,
    connectionId: verified.connectionId,
    connectionEpoch: verified.connectionEpoch,
    lifecycleGeneration: verified.lifecycleGeneration,
  };
  const readiness = sanitizeObservedReadiness({
    ...observedFactsFromWorkerReadiness({
      ...validated.readiness, at: scope.at, supported: scope.supported,
    }),
    enrollmentId, connectionEpoch,
    observationId,
  });
  // The canonical validator already reduced the complete Worker probe. Unlike
  // historical readback, a new write never has optional provenance/version.
  const probe = { ...validated.probe, enrollmentId, connectionEpoch };
  const observation = Object.freeze({}) as ReadinessObservation;
  observations.set(observation, {
    environmentInstanceId: scope.environmentInstanceId,
    authority,
    verifyAuthority: scope.verifyAuthority,
    observationId,
    authorityScope,
    ...(requirementSnapshot !== undefined ? { requirements: requirementSnapshot } : {}),
    pair: { readiness, probe },
  });
  return observation;
}

/**
 * Store mutation guard. Refuse raw/forged writes and scope substitution, then
 * check the original live authority immediately before a synchronous mutation.
 * Return a detached pair so even adapter callers cannot alter a sealed write.
 */
export function readReadinessObservation(
  environmentInstanceId: string,
  observation: unknown,
  authority: ReadinessObservationAuthority,
): StoredObservationPair | undefined {
  if (typeof observation !== 'object' || observation === null) return undefined;
  const write = observations.get(observation);
  if (write === undefined) return undefined;
  const verified = write.verifyAuthority(authority, { environmentInstanceId });
  if (verified === undefined) return undefined;
  if (write.environmentInstanceId !== environmentInstanceId ||
      write.authority !== authority ||
      write.pair.readiness.enrollmentId !== verified.enrollmentId ||
      write.pair.readiness.connectionEpoch !== verified.connectionEpoch) return undefined;
  if (write.authorityScope.connectionId !== verified.connectionId ||
      write.authorityScope.lifecycleGeneration !== verified.lifecycleGeneration) return undefined;
  if (!authority.isCurrent()) return undefined;
  return structuredClone({
    observationId: write.observationId,
    authorityScope: write.authorityScope,
    readiness: write.pair.readiness,
    probe: write.pair.probe,
    ...(write.requirements !== undefined ? { requirements: write.requirements } : {}),
  });
}

function sanitizeEngineVersion(value: string): string | undefined {
  // Version is a structured semver fact, not free-form Worker output. Generic
  // identifier redaction treats dotted unknown text as a host instead.
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : undefined;
}

/** Also used for additive privacy reduction of historical documents on read. */
export function sanitizeObservedReadiness(observed: ObservedReadiness): ObservedReadiness {
  const protocolVersion = sanitizeProtocolVersion(observed.compatibility.workerProtocolVersion);
  return {
    ...(observed.observationId !== undefined ? { observationId: observed.observationId } : {}),
    // Authority keys come from the core, never Worker text; preserve them exactly.
    ...(observed.enrollmentId !== undefined ? { enrollmentId: observed.enrollmentId } : {}),
    ...(Number.isSafeInteger(observed.connectionEpoch) && (observed.connectionEpoch ?? 0) > 0
      ? { connectionEpoch: observed.connectionEpoch }
      : {}),
    connection: {
      state: observed.connection.state,
      ...(observed.connection.lastConfirmedAt !== undefined
        ? { lastConfirmedAt: observed.connection.lastConfirmedAt }
        : {}),
    },
    compatibility: {
      state: observed.compatibility.state,
      ...(protocolVersion !== undefined ? { workerProtocolVersion: protocolVersion } : {}),
      ...(observed.compatibility.detail !== undefined
        ? { detail: sanitizeOperatorText(observed.compatibility.detail, { fallback: DEFAULT_COMPATIBILITY_DETAIL }) }
        : {}),
    },
    engines: observed.engines.map((engine) => {
      const authMode = allowlistedReadinessValue(engine.authMode, READINESS_AUTH_MODES);
      const authType = allowlistedReadinessValue(engine.authType, READINESS_AUTH_TYPES);
      const source = allowlistedReadinessValue(engine.source, READINESS_SOURCES);
      return {
        engine: sanitizeIdentifier(engine.engine, { fallback: 'unknown-engine', kind: 'engine' }),
        ...(engine.version !== undefined
          ? { version: sanitizeEngineVersion(engine.version) ?? 'unknown-version' }
          : {}),
        installed: engine.installed,
        readiness: engine.readiness,
        required: engine.required,
        models: {
          state: engine.models.state,
          models: engine.models.models.map((model) =>
            sanitizeIdentifier(model, { fallback: 'unknown-model', kind: 'model' }),
          ),
        },
        ...(engine.authenticated !== undefined ? { authenticated: engine.authenticated } : {}),
        ...(authMode !== undefined ? { authMode } : {}),
        ...(authType !== undefined ? { authType } : {}),
        ...(engine.modelIdPresent !== undefined ? { modelIdPresent: engine.modelIdPresent } : {}),
        ...(engine.probedAt !== undefined ? { probedAt: engine.probedAt } : {}),
        ...(engine.probeExitCode !== undefined ? { probeExitCode: engine.probeExitCode } : {}),
        ...(source !== undefined ? { source } : {}),
      };
    }),
  };
}

/** Historical source-less rows may be read, but cannot mint a canonical write. */
export function sanitizeProbe(probe: ProbeResultFact): ProbeResultFact {
  return {
    enrollmentId: probe.enrollmentId,
    connectionEpoch: probe.connectionEpoch,
    at: probe.at,
    latencyMs: probe.latencyMs,
    protocolOk: probe.protocolOk,
    enginesOk: probe.enginesOk,
    ...(probe.version !== undefined ? { version: sanitizeProbeVersion(probe.version) } : {}),
    ...(probe.source === 'worker' ? { source: 'worker' as const } : {}),
    summary: sanitizeOperatorText(probe.summary, { fallback: DEFAULT_PROBE_SUMMARY }),
  };
}
