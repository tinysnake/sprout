/**
 * Host-local private file writes for the Environment Worker (#117).
 *
 * Two Modules need to place a secret-bearing file on the Environment host with
 * owner-only permissions and no half-written window: the Worker CLI's host-state
 * store (configuration, runtime state, the LaunchAgent plist) and the outbound
 * enrollment connector (the host-generated identity key). Keeping the staging
 * and permission logic here means they cannot drift, and it keeps the connector
 * from depending on the CLI layer just to write a key.
 *
 * The technique is deliberately small: create a sibling temporary file with the
 * restrictive mode *before* any bytes are written, then rename it into place.
 * Rename is atomic on the same filesystem, so a reader never observes a partial
 * file, and the final path is never briefly more permissive than 0600.
 */

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

export interface PrivateFileSecurityDependencies {
  readonly platform: NodeJS.Platform;
  readonly run: (program: string, args: readonly string[]) => string;
}

export const defaultPrivateFileSecurityDependencies: PrivateFileSecurityDependencies = {
  platform: process.platform,
  run: (program, args) => execFileSync(program, [...args], { encoding: 'utf8', windowsHide: true }),
};

/** Apply an explicit, non-inheriting ACL to a private file on Windows. */
export function applyWindowsPrivateFileAcl(
  filePath: string,
  dependencies: PrivateFileSecurityDependencies = defaultPrivateFileSecurityDependencies,
): void {
  try {
    const currentUser = dependencies.run('whoami', []).trim();
    if (!currentUser || /[\r\n]/.test(currentUser)) throw new Error('unavailable');
    dependencies.run('icacls', [filePath, '/inheritance:r', '/grant:r', `${currentUser}:F`]);
  } catch {
    // Do not leak the path, user name, or child-process output.
    throw new Error('could not apply the required host-local file restrictions');
  }
}

export type PrivateFileRestriction = 'restricted' | 'permissive' | 'unverifiable';

/** Assess private-file permissions using the host platform's security model. */
export function privateFileRestriction(
  filePath: string,
  exact = false,
  security: PrivateFileSecurityDependencies = defaultPrivateFileSecurityDependencies,
): PrivateFileRestriction {
  if (security.platform === 'win32') return verifyWindowsPrivateFileAcl(filePath, security);
  const mode = statSync(filePath).mode & 0o777;
  return (exact ? mode === PRIVATE_FILE_MODE : (mode & 0o077) === 0) ? 'restricted' : 'permissive';
}

/** Verify the Windows ACL conservatively; unknown principals or output fail closed. */
export function verifyWindowsPrivateFileAcl(
  filePath: string,
  dependencies: PrivateFileSecurityDependencies = defaultPrivateFileSecurityDependencies,
): PrivateFileRestriction {
  try {
    const currentUser = dependencies.run('whoami', []).trim().toLocaleLowerCase('en-US');
    const output = dependencies.run('icacls', [filePath]).replace(/\r/g, '');
    if (!currentUser || /\n/.test(currentUser) || !output.trim()) return 'unverifiable';
    const allowed = new Set([currentUser, 'builtin\\administrators', 'nt authority\\system']);
    const entries: string[] = [];
    const normalizedPath = filePath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('en-US');
    for (const [index, rawLine] of output.split('\n').entries()) {
      const line = index === 0 && rawLine.replace(/\\/g, '/').toLocaleLowerCase('en-US').startsWith(normalizedPath)
        ? rawLine.slice(normalizedPath.length)
        : rawLine;
      if (!line.includes(':(')) continue;
      const match = line.match(/^\s*(.+?):((?:\([A-Za-z,]+\))+?)\s*$/);
      if (!match) return 'unverifiable';
      const permissions = match[2]!;
      if (/\(I\)/i.test(permissions)) return 'permissive';
      entries.push(match[1]!.trim().toLocaleLowerCase('en-US'));
    }
    if (entries.length === 0) return 'unverifiable';
    return entries.includes(currentUser) && entries.every((principal) => allowed.has(principal)) ? 'restricted' : 'permissive';
  } catch {
    return 'unverifiable';
  }
}

/** Owner-only permissions for a file that holds identity or configuration. */
export const PRIVATE_FILE_MODE = 0o600;

/** Owner-only permissions for a directory that holds private files. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * Write a private file atomically with owner-only permissions.
 *
 * `mkdirSync(..., {recursive: true, mode})` applies the mode only when it
 * creates the directory, so an existing directory is explicitly tightened; the
 * temporary file is created with the restrictive mode and the final path is
 * chmodded after the rename so a pre-existing permissive target is corrected.
 */
export function writePrivateFile(
  filePath: string,
  content: string,
  security: PrivateFileSecurityDependencies = defaultPrivateFileSecurityDependencies,
): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(dirname(filePath), PRIVATE_DIRECTORY_MODE);
  const staged = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const descriptor = openSync(staged, 'w', PRIVATE_FILE_MODE);
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(staged, PRIVATE_FILE_MODE);
  renameSync(staged, filePath);
  chmodSync(filePath, PRIVATE_FILE_MODE);
  if (security.platform === 'win32') applyWindowsPrivateFileAcl(filePath, security);
  // Persist the directory entry too: a successful rename alone does not survive
  // every power loss on POSIX filesystems.
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(filePath), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
