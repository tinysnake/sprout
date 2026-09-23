import { DEFAULT_PROBE_SUMMARY, sanitizeOperatorText, sanitizeProbeVersion } from '../environment/privacy.ts';
import type { WorkerProbeFact, WorkerReadinessProbeResult, WorkerObservationEnvelope } from './protocol.ts';

/**
 * Validate one authenticated Worker's readiness-probe JSON-RPC result.
 *
 * TypeScript types do not validate a peer. Both the automatic observation and
 * browser-requested paths must cross this same closed-shape guard before any
 * durable write, including the requirement that the embedded and returned
 * probe records describe exactly the same Worker observation.
 */
export function validateWorkerReadinessProbeResult(
  value: unknown,
): WorkerReadinessProbeResult | undefined {
  if (isRecord(value) && value.protocolVersion === '3') {
    if (!hasOnlyKeys(value, ['protocolVersion', 'observedAt', 'engines', 'probe', 'attemptId']) ||
        !isWorkerProbe(value.probe) || !Array.isArray(value.engines) || !value.engines.every(isWorkerEngine) ||
        (value.observedAt !== undefined && !isNonNegativeInteger(value.observedAt)) ||
        (value.attemptId !== undefined && (typeof value.attemptId !== 'string' || !/^obs-[0-9a-f-]{36}$/.test(value.attemptId)))) return undefined;
    const envelope = value as unknown as WorkerObservationEnvelope & { attemptId?: string };
    const probe = sanitizeWorkerProbe(envelope.probe);
    return { ...(envelope.attemptId !== undefined ? { attemptId: envelope.attemptId } : {}),
      readiness: { protocolVersion: '3', ...(envelope.observedAt !== undefined ? { observedAt: envelope.observedAt } : {}), engines: envelope.engines, probe }, probe };
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['readiness', 'probe', 'attemptId']) || !isWorkerProbe(value.probe) ||
      (value.attemptId !== undefined && (typeof value.attemptId !== 'string' || !/^obs-[0-9a-f-]{36}$/.test(value.attemptId)))) {
    return undefined;
  }
  const readiness = value.readiness;
  if (!isRecord(readiness) || !hasOnlyKeys(readiness, ['protocolVersion', 'observedAt', 'engines', 'probe'])) {
    return undefined;
  }
  if (typeof readiness.protocolVersion !== 'string' || !/^v?2(?:[.\-]|$)/.test(readiness.protocolVersion)) return undefined;
  if (readiness.observedAt !== undefined && !isNonNegativeInteger(readiness.observedAt)) return undefined;
  if (!Array.isArray(readiness.engines) || !readiness.engines.every(isWorkerEngine)) return undefined;
  if (!isWorkerProbe(readiness.probe) || !sameWorkerProbe(readiness.probe, value.probe)) return undefined;

  // Normalize only after the closed raw records have compared equal. This
  // keeps a mismatch from becoming equal merely because two hostile values
  // collapse to the same fallback, while ensuring the requester, durable
  // sanitizer, and readback all compare the same privacy-reduced fact.
  const probe = sanitizeWorkerProbe(value.probe);
  return {
    ...(value.attemptId !== undefined ? { attemptId: value.attemptId as string } : {}),
    readiness: {
      protocolVersion: readiness.protocolVersion,
      ...(readiness.observedAt !== undefined ? { observedAt: readiness.observedAt } : {}),
      engines: readiness.engines,
      probe,
    },
    probe,
  };
}

/** The canonical privacy reduction for an authenticated Worker probe payload. */
export function sanitizeWorkerProbe(probe: WorkerProbeFact): WorkerProbeFact {
  return {
    at: probe.at,
    latencyMs: probe.latencyMs,
    protocolOk: probe.protocolOk,
    enginesOk: probe.enginesOk,
    source: 'worker',
    version: sanitizeProbeVersion(probe.version),
    summary: sanitizeOperatorText(probe.summary, { fallback: DEFAULT_PROBE_SUMMARY }),
  };
}

function isWorkerEngine(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'engine', 'version', 'installed', 'readiness', 'modelAvailability', 'models',
    'authenticated', 'authMode', 'authType', 'modelIdPresent', 'targetModels', 'requirementRevision', 'probedAt', 'probeExitCode', 'source',
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
    (value.targetModels === undefined || (Array.isArray(value.targetModels) && value.targetModels.every((model) => typeof model === 'string'))) &&
    (value.requirementRevision === undefined || (typeof value.requirementRevision === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requirementRevision))) &&
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
