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
  /** Whether the engine's executable was located on this Environment host. */
  readonly installed: boolean;
  readonly readiness: EngineReadiness;
  readonly required: boolean;
  readonly models: ModelAvailability;
}
/** One recorded readiness probe, append-only in the durable observation history. */
export interface ProbeResultFact {
  readonly at: number;
  readonly latencyMs: number;
  readonly protocolOk: boolean;
  readonly enginesOk: boolean;
  readonly summary: string;
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
  readonly probe?: ProbeResultFact;
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
  version: string | undefined,
  supported: ProtocolVersionRange,
): { readonly state: ProtocolCompatibility; readonly detail?: string } {
  const major = protocolMajor(version);
  if (major === undefined || version === undefined) return { state: 'unknown' };
  if (major < supported.minMajor) {
    return {
      state: 'incompatible',
      detail: `Worker protocol ${version} is older than the supported minimum v${supported.minMajor}.`,
    };
  }
  if (major > supported.maxMajor) {
    return {
      state: 'incompatible',
      detail: `Worker protocol ${version} is newer than the supported maximum v${supported.maxMajor}.`,
    };
  }
  return { state: 'compatible' };
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
  }[];
  readonly at: number;
  readonly supported: ProtocolVersionRange;
}): {
  readonly connection: ConnectionFact;
  readonly compatibility: CompatibilityFact;
  readonly engines: readonly EngineReadinessFact[];
} {
  return {
    connection: { state: 'online', lastConfirmedAt: input.at },
    compatibility: {
      state: protocolCompatibility(input.protocolVersion, input.supported).state,
      workerProtocolVersion: input.protocolVersion,
    },
    engines: input.engines.map((engine) => ({
      engine: engine.engine,
      installed: engine.installed === true,
      readiness: normalizeEngineReadiness(engine.readiness),
      required: false,
      models: {
        state: normalizeModelAvailability(engine.modelAvailability),
        models: [...engine.models],
      },
    })),
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
