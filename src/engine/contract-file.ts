import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContractDelivery, ContractDeliveryMechanism } from './port.ts';

export type { ContractDelivery, ContractDeliveryMechanism };

/**
 * Working-directory delivery of the project contract.
 *
 * `agy` and `opencode` have no system-prompt surface, so the only channel they
 * expose is a file in the working directory the run executes in (#14, #15, #19).
 * This module is the one place that writes that file, so both adapters behave
 * identically and the ownership rule is stated once.
 *
 * **The contract file is Sprout-owned and user files are never clobbered.**
 * Sprout writes a file carrying `CONTRACT_FILE_MARKER`; a file at the target path
 * is only replaced when it already carries that marker (i.e. Sprout wrote it).
 *
 * The preferred path is `AGENTS.md`, because that is the name both engines
 * actually read. When `AGENTS.md` exists and is *not* Sprout's — the repository's
 * own `AGENTS.md`, for example — it is left untouched and the contract goes to a
 * separate `SPROUT-PROJECT-CONTRACT.md` instead. The delivery mechanism is
 * reported so a caller can tell which happened; it is never silent.
 */

/** The marker line that identifies a file as Sprout's to own and replace. */
export const CONTRACT_FILE_MARKER = '<!-- sprout:project-contract -->';

/** The Sprout-owned fallback path, used when `AGENTS.md` is a user's file. */
export const CONTRACT_FILE_NAME = 'SPROUT-PROJECT-CONTRACT.md';

/** The file both `agy` and `opencode` read standing rules from. */
export const AGENTS_FILE_NAME = 'AGENTS.md';

/**
 * Deliver `instructions` into the working directory for one run.
 *
 * Returns `undefined` when there is no contract to deliver (an adapter handed no
 * instructions must not create files). Writing is best-effort: a read-only or
 * missing working directory leaves delivery unattempted rather than failing the
 * run, because a run's engine failure is the honest place for that, not a
 * bookkeeping side effect.
 */
export function deliverContractToWorkingDirectory(request: {
  readonly workingDirectory: string;
  readonly instructions?: string;
}): ContractDelivery | undefined {
  const instructions = request.instructions;
  if (instructions === undefined || instructions === '') return undefined;

  const content = `${CONTRACT_FILE_MARKER}\n${instructions}\n`;
  const agentsPath = join(request.workingDirectory, AGENTS_FILE_NAME);

  if (isSproutOwnedOrAbsent(agentsPath)) {
    if (writeIfPossible(agentsPath, content)) {
      return { mechanism: 'agents.md', path: agentsPath };
    }
    return { mechanism: 'skipped-user-owned' };
  }

  // `AGENTS.md` belongs to the user. Never replace it; put the contract where
  // Sprout owns the name. The engine may not read this file, which is why the
  // result says so explicitly.
  const sproutPath = join(request.workingDirectory, CONTRACT_FILE_NAME);
  if (!isSproutOwnedOrAbsent(sproutPath)) {
    return { mechanism: 'skipped-user-owned', agentsMdSkipped: 'user-owned' };
  }
  if (!writeIfPossible(sproutPath, content)) {
    return { mechanism: 'skipped-user-owned', agentsMdSkipped: 'user-owned' };
  }
  return {
    mechanism: 'sprout-contract-file',
    path: sproutPath,
    agentsMdSkipped: 'user-owned',
  };
}

/** Whether the path is absent or already a Sprout-owned contract file. */
function isSproutOwnedOrAbsent(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').startsWith(CONTRACT_FILE_MARKER);
  } catch {
    // Absent (ENOENT) or unreadable: treat as safe to create. An unreadable
    // existing file will fail the write below and be reported as skipped.
    return true;
  }
}

function writeIfPossible(path: string, content: string): boolean {
  try {
    writeFileSync(path, content);
    return true;
  } catch {
    return false;
  }
}
