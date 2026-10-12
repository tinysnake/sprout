/**
 * Node.js deployment version verification for OAR-backed engine adapters.
 *
 * OAR requires Node.js 24+ (engines.node: ">=24.0.0"). An unsupported version
 * must refuse work before admission with actionable, sanitized guidance.
 */

export const MINIMUM_NODE_MAJOR = 24;

export function normalizeNodeVersion(version: string): string | undefined {
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(version);
  if (!match || match[0] !== version) return undefined;
  const normalized = match[1]!;
  return normalized.split('.').every((part) => Number.isSafeInteger(Number(part))) ? normalized : undefined;
}

export function parseNodeMajor(version = process.versions.node): number {
  return Number(normalizeNodeVersion(version)?.split('.')[0] ?? 0);
}

export function formatNodeUpgradeGuidance(currentVersion = process.versions.node): string {
  const version = normalizeNodeVersion(currentVersion) ?? 'unknown';
  return (
    `Node.js 24+ is required by OAR (detected Node.js ${version}). ` +
    `Please upgrade Node.js to version 24.0.0 or later before admitting work.`
  );
}

export class UnsupportedOarNodeVersionError extends Error {
  constructor(currentVersion = process.versions.node) {
    super(formatNodeUpgradeGuidance(currentVersion));
    this.name = 'UnsupportedOarNodeVersionError';
  }
}

export function isSupportedNodeVersion(currentVersion = process.versions.node): boolean {
  return parseNodeMajor(currentVersion) >= MINIMUM_NODE_MAJOR;
}

export function assertSupportedNodeVersion(currentVersion = process.versions.node): void {
  if (!isSupportedNodeVersion(currentVersion)) {
    throw new UnsupportedOarNodeVersionError(currentVersion);
  }
}
