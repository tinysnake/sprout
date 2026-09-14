import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ContractDelivery } from './port.ts';

/**
 * `agy` standing-instructions delivery through the engine's own config hook.
 *
 * `agy` has **no system-prompt flag** (`agy --help` on 1.2.2 lists none), and —
 * contrary to the working-directory assumption this adapter previously carried —
 * its headless (`--print`) runs do **not** read a project `AGENTS.md` or
 * `.agents/rules/*.md` from the working directory. Measured facts from probing
 * `agy 1.2.2` on the development host:
 *
 * - A worktree `AGENTS.md` with a distinctive instruction changed nothing, in a
 *   plain temp directory, in a git repository, and even in a directory listed in
 *   `settings.json` `trustedWorkspaces`; a 6,000-word `AGENTS.md` did not move the
 *   reported `input_tokens` at all.
 * - `--help` exposes no instruction/rule-discovery flag; no documented env var
 *   relocates the customization root.
 * - **`agy`'s global customization root (`~/.gemini/config/`) *is* read.** A
 *   standalone `AGENTS.md` there injects standing rules, and a `hooks.json`
 *   `SessionStart` or `PreInvocation` hook may return
 *   `{"injectSteps":[{"ephemeralMessage":"…"}]}` to inject a system message
 *   before the model runs. The hook subprocess inherits the environment Sprout
 *   launches `agy` with, so a per-run payload file can be selected by env var.
 *
 * Verified end to end: with a Sprout-written `SessionStart` hook and a payload
 * carrying a contract-specific fact, `agy` answered with that fact (the probe's
 * codeword), while the same process without the env var answered normally. The
 * rule changed agy's answer, so the channel is real rather than declared.
 *
 * This module installs that hook **once, idempotently**, gated on an env var so
 * it is inert for every agy run Sprout did not start. The channel it reports is
 * `engine-hook`; a config root that cannot be written is reported `unavailable`
 * rather than silently claiming delivery.
 */

/** The hook name Sprout owns inside `hooks.json`; other names are preserved. */
export const AGY_CONTRACT_HOOK_NAME = 'sprout-project-contract';

/** The Sprout-owned hook script, relative to the agy customization root. */
export const AGY_CONTRACT_HOOK_SCRIPT = join('hooks', 'sprout-project-contract.sh');

/**
 * The environment variable that selects this run's contract payload.
 *
 * The hook is a no-op unless it is set, so an installed hook never affects an
 * agy run Sprout did not launch.
 */
export const AGY_CONTRACT_PAYLOAD_ENV = 'SPROUT_AGY_CONTRACT_PAYLOAD';

/** The hook script's content. Kept literal so the write is auditable. */
const HOOK_SCRIPT = `#!/bin/sh
# Managed by Sprout. Provides the project contract to agy as a system message.
# Inert unless Sprout set ${AGY_CONTRACT_PAYLOAD_ENV} for this run.
if [ -n "\${${AGY_CONTRACT_PAYLOAD_ENV}:-}" ] && [ -f "\${${AGY_CONTRACT_PAYLOAD_ENV}}" ]; then
  cat "\${${AGY_CONTRACT_PAYLOAD_ENV}}"
else
  printf '{}\\n'
fi
`;

export interface AgyContractDeliveryRequest {
  /** `agy`'s global customization root (the directory holding `hooks.json`). */
  readonly configDirectory: string;
  /** Where to write this run's payload; Sprout owns the file's lifetime. */
  readonly payloadPath: string;
  readonly instructions: string;
}

/**
 * The result of preparing agy-side delivery: what to report, and the environment
 * addition the run must be spawned with.
 */
export interface AgyContractDelivery {
  readonly delivery: ContractDelivery;
  /** The env var assignment to add to the spawned process, when delivery worked. */
  readonly env: Readonly<Record<string, string>>;
  /** The payload file Sprout wrote, for the caller to remove on session close. */
  readonly payloadPath?: string;
}

/**
 * Install the hook and write this run's payload.
 *
 * Never throws and never clobbers an unreadable `hooks.json`: a config root that
 * cannot be prepared produces an `unavailable` delivery, which the worker
 * reports, rather than a silent claim that the contract reached the engine.
 */
export function deliverContractThroughAgyHook(
  request: AgyContractDeliveryRequest,
): AgyContractDelivery {
  const hooksPath = join(request.configDirectory, 'hooks.json');
  const scriptPath = join(request.configDirectory, AGY_CONTRACT_HOOK_SCRIPT);

  const existing = readHooks(hooksPath);
  if (existing.kind !== 'ok') {
    return {
      delivery: {
        mechanism: 'unavailable',
        path: hooksPath,
        reason: existing.reason,
      },
      env: {},
    };
  }

  const hookEntry = {
    SessionStart: [
      {
        type: 'command',
        command: `sh "${scriptPath}"`,
        timeout: 10,
      },
    ],
  };
  const updated: Record<string, unknown> = {
    ...existing.hooks,
    [AGY_CONTRACT_HOOK_NAME]: hookEntry,
  };

  if (!writeIfPossible(scriptPath, HOOK_SCRIPT, true)) {
    return {
      delivery: {
        mechanism: 'unavailable',
        path: scriptPath,
        reason: `could not write the agy contract hook at ${scriptPath}`,
      },
      env: {},
    };
  }
  // Only rewrite `hooks.json` when its content actually changes: a rewrite per
  // run is needless churn and needlessly widens the window in which a concurrent
  // writer could lose its own edit.
  const nextHooks = `${JSON.stringify(updated, null, 2)}\n`;
  if (existing.text !== nextHooks) {
    if (!writeIfPossible(hooksPath, nextHooks, false)) {
      return {
        delivery: {
          mechanism: 'unavailable',
          path: hooksPath,
          reason: `could not register the agy contract hook in ${hooksPath}`,
        },
        env: {},
      };
    }
  }

  const payload = `${JSON.stringify({
    injectSteps: [{ ephemeralMessage: request.instructions }],
  })}\n`;
  if (!writeIfPossible(request.payloadPath, payload, false)) {
    return {
      delivery: {
        mechanism: 'unavailable',
        path: request.payloadPath,
        reason: `could not write the agy contract payload at ${request.payloadPath}`,
      },
      env: {},
    };
  }

  return {
    delivery: { mechanism: 'engine-hook', path: hooksPath },
    env: { [AGY_CONTRACT_PAYLOAD_ENV]: request.payloadPath },
    payloadPath: request.payloadPath,
  };
}

/** Remove a payload file once the session that used it is closed. */
export function removeAgyContractPayload(path: string | undefined): void {
  if (path === undefined) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never written: nothing to clean up.
  }
}

type HooksRead =
  | { readonly kind: 'ok'; readonly hooks: Record<string, unknown>; readonly text: string | undefined }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Read `hooks.json` as a JSON object.
 *
 * An absent file is an empty set of hooks (safe to create). A file that exists
 * but cannot be read or parsed is an error: it belongs to the user, and Sprout
 * must not replace it with its own version.
 */
function readHooks(path: string): HooksRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { kind: 'ok', hooks: {}, text: undefined };
    return { kind: 'error', reason: `could not read ${path} (${errorMessage(error)})` };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'error', reason: `${path} is not a JSON object` };
    }
    return { kind: 'ok', hooks: { ...(parsed as Record<string, unknown>) }, text };
  } catch (error) {
    return { kind: 'error', reason: `could not parse ${path} (${errorMessage(error)})` };
  }
}

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

function writeIfPossible(path: string, content: string, makeExecutable: boolean): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, makeExecutable ? { mode: 0o755 } : undefined);
    return true;
  } catch {
    return false;
  }
}
