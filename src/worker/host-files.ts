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

import { chmodSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
export function writePrivateFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(dirname(filePath), PRIVATE_DIRECTORY_MODE);
  const staged = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const descriptor = openSync(staged, 'w', PRIVATE_FILE_MODE);
  try {
    writeFileSync(descriptor, content, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  chmodSync(staged, PRIVATE_FILE_MODE);
  renameSync(staged, filePath);
  chmodSync(filePath, PRIVATE_FILE_MODE);
}
