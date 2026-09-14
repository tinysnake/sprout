import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContractDelivery, ContractDeliveryMechanism } from './port.ts';

export type { ContractDelivery, ContractDeliveryMechanism };

/**
 * Working-directory delivery of the project contract.
 *
 * `opencode` has no system-prompt surface, so the only channel it exposes is a
 * file in the working directory the run executes in (#14, #15, #19). This module
 * is the one place that writes that file, so delivery behaves identically
 * wherever it is used and the ownership rule is stated once.
 *
 * **The contract file is Sprout-owned and user files are never clobbered.**
 * Sprout writes a file carrying `CONTRACT_FILE_MARKER`; a file at the target path
 * is only replaced when it already carries that marker (i.e. Sprout wrote it).
 *
 * The preferred path is `AGENTS.md`, because that is the name the engine actually
 * reads. When `AGENTS.md` exists and is *not* Sprout's — the repository's own
 * `AGENTS.md`, for example — it is left untouched and the contract goes to a
 * separate `SPROUT-PROJECT-CONTRACT.md` instead.
 *
 * **Every outcome is reported, successful or not.** The returned
 * `ContractDelivery` distinguishes a primary write (`agents.md`), a fallback
 * write (`sprout-contract-file`), and each way delivery failed
 * (`skipped-user-owned`, `skipped-unreadable`, `unavailable`). A fallback is a
 * *success* — the contract went somewhere — but it is still reported distinctly,
 * so a caller can always tell where the contract actually went and whether the
 * engine's primary file was passed over.
 */

/** The marker line that identifies a file as Sprout's to own and replace. */
export const CONTRACT_FILE_MARKER = '<!-- sprout:project-contract -->';

/** The Sprout-owned fallback path, used when `AGENTS.md` cannot be used. */
export const CONTRACT_FILE_NAME = 'SPROUT-PROJECT-CONTRACT.md';

/** The file the engine reads standing rules from. */
export const AGENTS_FILE_NAME = 'AGENTS.md';

/** What a probe of a candidate path found. */
type PathState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'sprout-owned' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Why an existing file was left alone. */
type SkipReason = 'user-owned' | 'unreadable';

/**
 * Deliver `instructions` into the working directory for one run.
 *
 * Returns `undefined` when there is no contract to deliver (an adapter handed no
 * instructions must not create files). Writing is best-effort: a read-only or
 * missing working directory produces an `unavailable` result rather than failing
 * the run, because a run's engine failure is the honest place for that, not a
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
  const agents = probePath(agentsPath);

  if (agents.kind === 'absent' || agents.kind === 'sprout-owned') {
    if (writeIfPossible(agentsPath, content)) {
      return { mechanism: 'agents.md', path: agentsPath };
    }
    return {
      mechanism: 'unavailable',
      path: agentsPath,
      reason: `could not write the contract file at ${agentsPath}`,
    };
  }

  // The primary file cannot be used. Never replace it; put the contract where
  // Sprout owns the name. Which reason applies is reported, because the engine
  // may not read the fallback file and a user needs to know the primary was
  // passed over and why.
  const skipped: SkipReason = agents.kind === 'foreign' ? 'user-owned' : 'unreadable';
  const sproutPath = join(request.workingDirectory, CONTRACT_FILE_NAME);
  const sprout = probePath(sproutPath);

  if (sprout.kind === 'foreign') {
    return { mechanism: 'skipped-user-owned', path: sproutPath, agentsMdSkipped: skipped };
  }
  if (sprout.kind === 'unreadable') {
    return { mechanism: 'skipped-unreadable', path: sproutPath, agentsMdSkipped: skipped };
  }
  if (!writeIfPossible(sproutPath, content)) {
    return {
      mechanism: 'unavailable',
      path: sproutPath,
      agentsMdSkipped: skipped,
      reason: `could not write the contract file at ${sproutPath}`,
    };
  }
  return {
    mechanism: 'sprout-contract-file',
    path: sproutPath,
    agentsMdSkipped: skipped,
  };
}

/**
 * Classify a candidate path.
 *
 * The distinction that matters is between an **absent** file (safe to create)
 * and an **unreadable** one (an existing file Sprout cannot inspect, so it must
 * not be replaced). Treating every read error as absence — as an earlier version
 * did — would silently overwrite a file whose permissions merely prevented
 * reading it. Only `ENOENT` means absence.
 */
function probePath(path: string): PathState {
  try {
    return readFileSync(path, 'utf8').startsWith(CONTRACT_FILE_MARKER)
      ? { kind: 'sprout-owned' }
      : { kind: 'foreign' };
  } catch (error) {
    if (isNotFound(error)) return { kind: 'absent' };
    return { kind: 'unreadable', reason: errorMessage(error) };
  }
}

/** Whether a read failure means the path does not exist. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeIfPossible(path: string, content: string): boolean {
  try {
    writeFileSync(path, content);
    return true;
  } catch {
    return false;
  }
}
