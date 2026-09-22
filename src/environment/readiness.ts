/**
 * The independent Environment readiness facts (#87, ADR-0008, ADR-0009).
 *
 * An Environment never collapses enrollment, connectivity, compatibility,
 * capability permission, engine readiness, model availability, readiness-probe
 * result, and work safety into one boolean. This Module owns those dimensions as
 * plain, separately inspectable facts and derives one deterministic
 * Green/Yellow/Red summary from them.
 *
 * Two rules make the summary honest:
 *
 * - The summary is a **projection over the facts**, never a replacement. The
 *   facts are returned alongside it so a caller can always see why.
 * - The summary always carries the decisive **textual reason** it chose, so
 *   colour never carries the distinction alone (ADR-0009).
 */

import { sanitizeProtocolVersion } from './privacy.ts';

export type EnrollmentStatus = 'pending' | 'approved' | 'revoked' | 'archived';
export type ConnectionState = 'never-connected' | 'online' | 'reconnecting' | 'offline';
export type ProtocolCompatibility = 'unknown' | 'compatible' | 'incompatible';
export type CapabilityPermission = 'allowed' | 'denied' | 'not-configured';
export type EngineReadiness = 'ready' | 'login-required' | 'missing' | 'unknown';
export type ModelAvailabilityState = 'available' | 'none' | 'unknown';
export type WorkSafetyState = 'clear' | 'held' | 'reconciling' | 'recovery';
export type ReadinessLevel = 'green' | 'yellow' | 'red';

export interface CapabilityReadinessFact {
  readonly name: string;
  readonly permission: CapabilityPermission;
  /** Whether the Environment's configured use requires this capability. */
  readonly required: boolean;
}

export interface ModelAvailability {
  readonly state: ModelAvailabilityState;
  readonly models: readonly string[];
}

export interface EngineReadinessFact {
  readonly engine: string;
  readonly version?: string;
  /** Whether the engine's executable was located on this Environment host. */
  readonly installed: boolean;
  readonly readiness: EngineReadiness;
  readonly required: boolean;
  readonly models: ModelAvailability;
  /** Privacy-reduced, independently sourced probe facts. */
  readonly authenticated?: boolean;
  readonly authMode?: string;
  readonly authType?: string;
  readonly modelIdPresent?: boolean;
  readonly probedAt?: number;
  readonly probeExitCode?: number;
  readonly source?: string;
}
/** One Worker-produced readiness probe before core-side authority binding. */
export interface ReadinessProbeFact {
  readonly at: number;
  readonly latencyMs: number;
  readonly protocolOk: boolean;
  readonly enginesOk: boolean;
  readonly summary: string;
  readonly source?: 'worker';
  readonly version?: string;
}

/** One recorded probe, bound to accepted authority in durable history. */
export interface ProbeResultFact extends ReadinessProbeFact {
  /** The enrollment authority that accepted the Worker which made this observation. */
  readonly enrollmentId: string;
  /** The accepted Worker connection epoch which made this observation. */
  readonly connectionEpoch: number;
}

export interface ConnectionFact {
  readonly state: ConnectionState;
  /** When the Worker's identity was last confirmed by a probe. */
  readonly lastConfirmedAt?: number;
}

export interface CompatibilityFact {
  readonly state: ProtocolCompatibility;
  /** The Worker's reported protocol version, when it reported one. */
  readonly workerProtocolVersion?: string;
  readonly detail?: string;
}

export interface WorkSafetyFact {
  readonly state: WorkSafetyState;
}

/** The independent facts plus the deterministic summary projection over them. */
export interface EnvironmentReadiness {
  readonly enrollmentStatus: EnrollmentStatus;
  readonly connection: ConnectionFact;
  readonly compatibility: CompatibilityFact;
  readonly capabilities: readonly CapabilityReadinessFact[];
  readonly engines: readonly EngineReadinessFact[];
  readonly probe?: ReadinessProbeFact;
  readonly workSafety: WorkSafetyFact;
}

export interface EnvironmentReadinessSummary {
  readonly level: ReadinessLevel;
  readonly reason: string;
}

export interface SummarizeEnvironmentOptions {
  /** Current time, so probe staleness is deterministic under a test clock. */
  readonly now: number;
  /** A probe older than this is stale. Defaults to 5 minutes. */
  readonly staleProbeAfterMs?: number;
}

/** A Worker protocol version range expressed by numeric major version. */
export interface ProtocolVersionRange {
  readonly minMajor: number;
  readonly maxMajor: number;
}

/** Product-owned detail used for every reported protocol incompatibility. */
export const PROTOCOL_INCOMPATIBLE_DETAIL =
  'the Worker protocol is incompatible with this Sprout build';

/** Parse the leading numeric major version of a protocol string, or `undefined`. */
export function protocolMajor(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const match = /^v?(\d+)(?:[.\-]|$)/.exec(version.trim());
  if (!match || match[1] === undefined) return undefined;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : undefined;
}

/**
 * Whether a Worker's reported protocol is inside the supported range.
 *
 * `unknown` when the Worker did not report a version, so "not yet known" is
 * never mistaken for a mismatch (ADR-0009: a version mismatch leaves enrollment
 * intact and blocks new work; an unreported version does not).
 */
export function protocolCompatibility(
  version: unknown,
  supported: ProtocolVersionRange,
): { readonly state: ProtocolCompatibility; readonly detail?: string } {
  if (version === undefined) return { state: 'unknown' };
  if (typeof version !== 'string') {
    return { state: 'incompatible', detail: PROTOCOL_INCOMPATIBLE_DETAIL };
  }
  const safeVersion = sanitizeProtocolVersion(version);
  const major = protocolMajor(safeVersion);
  // A present but malformed version is incompatible, not unknown: it is
  // evidence from an untrusted Worker, but it is never repeated in diagnostics.
  if (major === undefined || major < supported.minMajor || major > supported.maxMajor) {
    return { state: 'incompatible', detail: PROTOCOL_INCOMPATIBLE_DETAIL };
  }
  return { state: 'compatible' };
}

/**
 * Closed-world allowlists for the structured privacy-reduced readiness fields.
 *
 * The authenticated Worker is inside the trust boundary for *authority*, but it
 * is not allowed to widen the persisted fact vocabulary. These fields have a
 * tiny product-owned value set, so an unknown string must be dropped rather than
 * carried through a generic identifier sanitizer: a Worker that declares
 * `authType: "openai-codex"` or `authMode: "provider-account"` must never have
 * that provider/account identity persisted or projected (#114 C6, R118-BOUNDARY-003).
 */
export const READINESS_AUTH_MODES = new Set(['chatgpt', 'api_key', 'workload_identity']);
export const READINESS_AUTH_TYPES = new Set(['oauth', 'api_key']);
export const READINESS_SOURCES = new Set(['codex-account-read', 'pi-auth-check', 'unknown']);

/**
 * Reduce a Worker-declared auth/source field to the allowlisted enum, or drop it.
 *
 * Dropping (rather than rewriting to a generic `unknown` string) keeps the
 * absence of a fact explicit and guarantees no other value can reach storage.
 */
export function allowlistedReadinessValue(value: unknown, allow: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && allow.has(value) ? value : undefined;
}

/**
 * Map a Worker's neutral readiness declaration onto observed readiness facts.
 *
 * The Worker reports what it actually verified; a fact it did not verify is
 * `unknown`, never assumed. This keeps the enrollment observation an honest
 * projection and preserves the rule that installation, login, and availability
 * are separate facts.
 */
export function observedFactsFromWorkerReadiness(input: {
  readonly protocolVersion: string;
  readonly engines: readonly {
    readonly engine: string;
    readonly installed: boolean;
    readonly readiness: string;
    readonly modelAvailability: string;
    readonly models: readonly string[];
    readonly version?: string;
    readonly authenticated?: boolean;
    readonly authMode?: string;
    readonly authType?: string;
    readonly modelIdPresent?: boolean;
    readonly probedAt?: number;
    readonly probeExitCode?: number;
    readonly source?: string;
  }[];
  readonly at: number;
  readonly observedAt?: number;
  readonly supported: ProtocolVersionRange;
}): {
  readonly connection: ConnectionFact;
  readonly compatibility: CompatibilityFact;
  readonly engines: readonly EngineReadinessFact[];
} {
  const compatibility = protocolCompatibility(input.protocolVersion, input.supported);
  const protocolVersion = sanitizeProtocolVersion(input.protocolVersion);
  return {
    connection: { state: 'online', lastConfirmedAt: input.observedAt ?? input.at },
    compatibility: {
      ...compatibility,
      ...(protocolVersion !== undefined ? { workerProtocolVersion: protocolVersion } : {}),
    },
    engines: input.engines.map((engine) => {
      const authMode = allowlistedReadinessValue(engine.authMode, READINESS_AUTH_MODES);
      const authType = allowlistedReadinessValue(engine.authType, READINESS_AUTH_TYPES);
      const source = allowlistedReadinessValue(engine.source, READINESS_SOURCES);
      return {
        engine: engine.engine,
        ...(engine.version !== undefined ? { version: engine.version } : {}),
        installed: engine.installed === true,
        readiness: normalizeEngineReadiness(engine.readiness),
        required: false,
        models: {
          state: normalizeModelAvailability(engine.modelAvailability),
          models: [...engine.models],
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

function normalizeEngineReadiness(value: string): EngineReadiness {
  return value === 'ready' || value === 'login-required' || value === 'missing'
    ? value
    : 'unknown';
}

function normalizeModelAvailability(value: string): ModelAvailabilityState {
  return value === 'available' || value === 'none' ? value : 'unknown';
}

/** The minimal lease fact work safety needs, so this Module stays free of the lease adapter. */
export interface LeaseSafetyFact {
  readonly instanceId: string;
  readonly state: string;
}

/** Project the durable lease registry into the Environment's work-safety fact. */
export function workSafetyFromLeases(
  leases: readonly LeaseSafetyFact[],
  environmentId: string,
): WorkSafetyState {
  let held = false;
  for (const lease of leases) {
    if (lease.instanceId !== environmentId) continue;
    if (lease.state === 'recovering') return 'recovery';
    if (lease.state === 'active') held = true;
  }
  return held ? 'held' : 'clear';
}

/**
 * The deterministic Green/Yellow/Red summary with its decisive textual reason.
 *
 * Red marks a confirmed safety or availability block; Yellow marks a pending or
 * degraded fact without a confirmed block; Green marks a fully ready
 * Environment. Checks run in a fixed order so the same facts always produce the
 * same level and reason.
 */
export function summarizeEnvironmentReadiness(
  readiness: EnvironmentReadiness,
  options: SummarizeEnvironmentOptions,
): EnvironmentReadinessSummary {
  const red = (reason: string): EnvironmentReadinessSummary => ({ level: 'red', reason });
  const yellow = (reason: string): EnvironmentReadinessSummary => ({ level: 'yellow', reason });

  if (readiness.enrollmentStatus === 'revoked') {
    return red('Enrollment is revoked; a fresh reset and Human approval are required.');
  }
  // An archived instance admits no new work (ADR-0008) without being a safety
  // block: it stays Yellow with its own decisive reason, distinct from revoked.
  if (readiness.enrollmentStatus === 'archived') {
    return yellow('The Environment instance is archived; restore it before new work.');
  }
  if (readiness.compatibility.state === 'incompatible') {
    return red(readiness.compatibility.detail ?? 'The Worker protocol is incompatible.');
  }
  if (readiness.connection.state === 'offline') {
    return red('The Worker is offline.');
  }
  if (readiness.workSafety.state === 'recovery') {
    return red('Lease recovery is required.');
  }

  // A pending enrollment is Yellow, not Red (ADR-0009). Its ungranted
  // capabilities and unprobed engines are expected while the Human decides, so
  // the confirmed-block checks below apply only once enrollment is approved.
  if (readiness.enrollmentStatus === 'pending') {
    return yellow('Enrollment is pending Human approval.');
  }

  for (const capability of readiness.capabilities) {
    if (capability.required && capability.permission === 'denied') {
      return red(`Required capability "${capability.name}" is denied.`);
    }
    if (capability.required && capability.permission === 'not-configured') {
      return red(`Required capability "${capability.name}" has no granted permission.`);
    }
  }
  for (const engine of readiness.engines) {
    if (engine.required && (engine.readiness === 'missing' || engine.readiness === 'unknown')) {
      return red(`Required engine "${engine.engine}" is ${engine.readiness}.`);
    }
    if (engine.required && engine.models.state === 'none') {
      return red(`Required engine "${engine.engine}" has no available work model.`);
    }
  }

  if (readiness.connection.state === 'never-connected') {
    return yellow('Awaiting the first Worker connection.');
  }
  if (readiness.connection.state === 'reconnecting') {
    return yellow('The Worker is reconnecting.');
  }
  if (readiness.compatibility.state === 'unknown') {
    return yellow('Worker protocol compatibility is not yet confirmed.');
  }
  for (const capability of readiness.capabilities) {
    if (capability.permission !== 'allowed') {
      return yellow(`Capability "${capability.name}" is ${capability.permission}.`);
    }
  }
  for (const engine of readiness.engines) {
    if (engine.readiness === 'login-required') {
      return yellow(`Engine "${engine.engine}" requires a login on the Environment host.`);
    }
    if (engine.readiness !== 'ready') {
      return yellow(`Engine "${engine.engine}" is ${engine.readiness}.`);
    }
    if (engine.models.state === 'unknown') {
      return yellow(`Model availability for engine "${engine.engine}" is unknown.`);
    }
  }
  if (readiness.workSafety.state === 'reconciling') {
    return yellow('Environment work is reconciling.');
  }
  const staleAfter = options.staleProbeAfterMs ?? 300_000;
  if (readiness.probe !== undefined && options.now - readiness.probe.at > staleAfter) {
    return yellow('The readiness probe is stale.');
  }
  if (readiness.probe !== undefined && (!readiness.probe.protocolOk || !readiness.probe.enginesOk)) {
    return yellow('The latest readiness probe did not confirm every readiness dimension.');
  }
  if (readiness.probe === undefined) {
    return yellow('No readiness probe has succeeded yet.');
  }

  return { level: 'green', reason: 'Enrollment is approved and the Worker is online, compatible, and ready.' };
}
