/**
 * Node.js deployment version verification for OAR-backed engine adapters.
 *
 * OAR requires Node.js 24+ (engines.node: ">=24.0.0"). An unsupported version
 * must refuse work before admission with actionable, sanitized guidance.
 */

export const MINIMUM_NODE_MAJOR = 24;

export function parseNodeMajor(version = process.env['SPROUT_NODE_VERSION'] ?? process.versions.node): number {
  const clean = version.startsWith('v') ? version.slice(1) : version;
  const major = Number.parseInt(clean.split('.')[0] ?? '', 10);
  return Number.isSafeInteger(major) ? major : 0;
}

export function formatNodeUpgradeGuidance(currentVersion = process.env['SPROUT_NODE_VERSION'] ?? process.versions.node): string {
  return (
    `Node.js 24+ is required by OAR (detected Node.js ${currentVersion}). ` +
    `Please upgrade Node.js to version 24.0.0 or later before admitting work.`
  );
}

export function isSupportedNodeVersion(currentVersion = process.env['SPROUT_NODE_VERSION'] ?? process.versions.node): boolean {
  return parseNodeMajor(currentVersion) >= MINIMUM_NODE_MAJOR;
}

export function assertSupportedNodeVersion(currentVersion = process.env['SPROUT_NODE_VERSION'] ?? process.versions.node): void {
  const major = parseNodeMajor(currentVersion);
  if (major < MINIMUM_NODE_MAJOR) {
    throw new Error(formatNodeUpgradeGuidance(currentVersion));
  }
}
