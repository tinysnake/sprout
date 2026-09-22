import type { WorkerReadinessProbeResult } from './protocol.ts';

/**
 * Validate one authenticated Worker's readiness-probe JSON-RPC result.
 *
 * TypeScript types do not validate a peer. Both the automatic observation and
 * browser-requested paths must cross this same closed-shape guard before any
 * durable write, including the requirement that the embedded and returned
 * probe records describe exactly the same Worker observation.
 */
export function isCompleteWorkerReadinessProbeResult(
  value: unknown,
): value is WorkerReadinessProbeResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['readiness', 'probe']) || !isWorkerProbe(value.probe)) {
    return false;
  }
  const readiness = value.readiness;
  if (!isRecord(readiness) || !hasOnlyKeys(readiness, ['protocolVersion', 'observedAt', 'engines', 'probe'])) {
    return false;
  }
  if (typeof readiness.protocolVersion !== 'string' || readiness.protocolVersion === '') return false;
  if (readiness.observedAt !== undefined && !isNonNegativeInteger(readiness.observedAt)) return false;
  if (!Array.isArray(readiness.engines) || !readiness.engines.every(isWorkerEngine)) return false;
  return isWorkerProbe(readiness.probe) && sameWorkerProbe(readiness.probe, value.probe);
}

function isWorkerEngine(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'engine', 'version', 'installed', 'readiness', 'modelAvailability', 'models',
    'authenticated', 'authMode', 'authType', 'modelIdPresent', 'probedAt', 'probeExitCode', 'source',
  ])) return false;
  return typeof value.engine === 'string' && value.engine !== '' &&
    (value.version === undefined || typeof value.version === 'string') &&
    typeof value.installed === 'boolean' &&
    (value.readiness === 'ready' || value.readiness === 'login-required' || value.readiness === 'missing' || value.readiness === 'unknown') &&
    (value.modelAvailability === 'available' || value.modelAvailability === 'none' || value.modelAvailability === 'unknown') &&
    Array.isArray(value.models) && value.models.every((model) => typeof model === 'string') &&
    (value.authenticated === undefined || typeof value.authenticated === 'boolean') &&
    (value.authMode === undefined || typeof value.authMode === 'string') &&
    (value.authType === undefined || typeof value.authType === 'string') &&
    (value.modelIdPresent === undefined || typeof value.modelIdPresent === 'boolean') &&
    (value.probedAt === undefined || isNonNegativeInteger(value.probedAt)) &&
    (value.probeExitCode === undefined || Number.isSafeInteger(value.probeExitCode)) &&
    (value.source === undefined || typeof value.source === 'string');
}

function isWorkerProbe(value: unknown): value is WorkerReadinessProbeResult['probe'] {
  return isRecord(value) && hasOnlyKeys(value, [
    'at', 'latencyMs', 'protocolOk', 'enginesOk', 'source', 'version', 'summary',
  ]) &&
    isNonNegativeInteger(value.at) &&
    isNonNegativeInteger(value.latencyMs) &&
    typeof value.protocolOk === 'boolean' &&
    typeof value.enginesOk === 'boolean' &&
    value.source === 'worker' &&
    typeof value.version === 'string' && value.version !== '' &&
    typeof value.summary === 'string';
}

function sameWorkerProbe(
  left: WorkerReadinessProbeResult['probe'],
  right: WorkerReadinessProbeResult['probe'],
): boolean {
  return left.at === right.at &&
    left.latencyMs === right.latencyMs &&
    left.protocolOk === right.protocolOk &&
    left.enginesOk === right.enginesOk &&
    left.source === right.source &&
    left.version === right.version &&
    left.summary === right.summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
