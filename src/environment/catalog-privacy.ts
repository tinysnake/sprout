import { createHash } from 'node:crypto';

import type { EnvironmentDefinition, EnvironmentInstance, EnvironmentPlatform } from './model.ts';
import { sanitizeIdentifier } from './privacy.ts';

/** The only platforms this build can describe without inventing host facts. */
function portablePlatform(value: unknown): EnvironmentPlatform {
  return value === 'macos' || value === 'container' || value === 'windows' ? value : 'unknown';
}

/**
 * Narrow one catalog record to its portable durable representation.
 *
 * The catalog is not a diagnostic or host-configuration store. In particular,
 * `EnvironmentInstance.workingDirectory` is useful on configured test carriers
 * but is not portable enrollment identity, so it is deliberately never written
 * here. Selecting fields rather than spreading caller objects also discards
 * credentials, key material, network data, browser/engine secrets, and raw
 * diagnostics supplied by corrupt or legacy callers.
 */
export function sanitizeEnvironmentCatalogRecord(input: {
  readonly instanceId: unknown;
  readonly enrollmentId: unknown;
  readonly definition: unknown;
  readonly instance: unknown;
  readonly updatedAt: unknown;
}): {
  readonly instanceId: string;
  readonly enrollmentId: string;
  readonly definition: EnvironmentDefinition;
  readonly instance: EnvironmentInstance;
  readonly updatedAt: number;
} {
  const rawDefinition = object(input.definition);
  const rawInstance = object(input.instance);
  const instanceId = safeId(input.instanceId, 'unknown-instance', 'instance');
  const definitionId = safeId(
    rawDefinition.id ?? rawInstance.definitionId,
    'unknown-definition',
    'definition',
  );
  const capabilities = Array.isArray(rawDefinition.capabilities)
    ? rawDefinition.capabilities.flatMap((candidate) => {
        const capability = object(candidate);
        if (capability.name === undefined) return [];
        return [{
          name: sanitizeIdentifier(String(capability.name), {
            fallback: 'unknown-capability',
            kind: 'capability',
          }),
          requiresLease: capability.requiresLease === true,
        }];
      })
    : [];
  return {
    instanceId,
    enrollmentId: safeId(input.enrollmentId, 'unknown-enrollment', 'enrollment'),
    definition: {
      id: definitionId,
      platform: portablePlatform(rawDefinition.platform),
      capabilities,
    },
    instance: {
      // The primary-key identity is authoritative. A nested id is untrusted
      // legacy JSON and is intentionally ignored rather than persisted.
      id: instanceId,
      definitionId,
    },
    updatedAt: Number.isSafeInteger(input.updatedAt) && Number(input.updatedAt) >= 0
      ? Number(input.updatedAt)
      : 0,
  };
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function safeId(value: unknown, fallback: string, kind: string): string {
  // Instance/enrollment ids are already product-approved opaque identities.
  // Preserve their exact portable reference (including ids with numeric suffixes)
  // while refusing paths, URLs, whitespace, and arbitrary diagnostic text.
  if (typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value)) return value;

  // Historical v11 rows may use a private path as identity. A shared fallback
  // would collapse distinct rows onto one primary key during privacy migration.
  // Keep a one-way, domain-separated digest instead: it is deterministic across
  // reopen/migration reruns, distinct for distinct historical identities, and
  // never writes the private source value back to durable storage.
  const digest = createHash('sha256')
    .update(`sprout-catalog-${kind}\0${typeof value}\0${String(value)}`)
    .digest('hex');
  return `${fallback}-${digest}`;
}
