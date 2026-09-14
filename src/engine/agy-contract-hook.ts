import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';

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
 * **The hook command is platform-specific.** `agy`'s own embedded hook
 * documentation states a `command` is "run via `sh -c` on Unix, `cmd /c` on
 * Windows", so a hook that always invoked `sh` was Unix-only while `docs/roadmap.md`
 * treats Windows as a supported target (O2, #5). This module therefore installs
 * an entry native to the host platform — a POSIX shell script executed with `sh`
 * on Unix, a batch file executed by `cmd` on Windows — and reports `unavailable`
 * rather than installing a hook the platform's shell cannot run. Windows is
 * selectable explicitly so the Windows contract is unit-tested on a POSIX host;
 * production uses the running platform.
 *
 * This module installs that hook **once, idempotently**, gated on an env var so
 * it is inert for every agy run Sprout did not start. The channel it reports is
 * `engine-hook`; a config root that cannot be written is reported `unavailable`
 * rather than silently claiming delivery.
 *
 * **The installed hook persists in the operator's configuration.** Sprout writes
 * one stable entry (`sprout-project-contract`) into `hooks.json` and one script
 * beside it; it overwrites neither other hooks nor a `hooks.json` it cannot
 * parse, and the entry is a no-op unless the payload env var is set. That is a
 * deliberate trade: `agy` reads customization only from this global root, so
 * there is no project-scoped file Sprout could write instead, and removing the
 * entry on session close would race any other concurrent run and could leave a
 * plan-on-disk configuration Sprout owns half-installed. The gating is what
 * makes the persistence safe — an operator running `agy` themselves is
 * unaffected — and the worker reports every run's actual delivery, so the
 * installation is visible rather than hidden.
 *
 * **Filesystem success is not proof the engine consumed the payload.** The
 * `injectSteps`/`ephemeralMessage` result shape is `agy`'s own hook ABI, taken
 * from the binary's embedded documentation and probing rather than a published
 * interface; a later build could change it. Sprout reports `unavailable` when the
 * root cannot be prepared, but it cannot detect a silently changed payload
 * schema, so a future `agy` build could accept the file and inject nothing. The
 * per-run report keeps that failure visible as a delivered-but-ineffective
 * contract rather than a crash. Re-probing the ABI on a later build is recorded
 * as follow-up work, not asserted here.
 */

/** The hook name Sprout owns inside `hooks.json`; other names are preserved. */
export const AGY_CONTRACT_HOOK_NAME = 'sprout-project-contract';

/** The environment variable that selects this run's contract payload. */
export const AGY_CONTRACT_PAYLOAD_ENV = 'SPROUT_AGY_CONTRACT_PAYLOAD';

/** The platforms whose hook contract Sprout can satisfy. */
export type HookPlatform = 'posix' | 'windows';

/** The hook script's path relative to the agy customization root. */
export function agyContractHookScriptPath(platform: HookPlatform): string {
  return platform === 'windows'
    ? win32.join('hooks', 'sprout-project-contract.cmd')
    : join('hooks', 'sprout-project-contract.sh');
}

/**
 * The installed hook script's path, as a constant for the running host.
 *
 * Exported for tests and for callers that need the file's location without
 * recomputing the platform; the delimiter follows {@link currentHookPlatform}.
 */
export const AGY_CONTRACT_HOOK_SCRIPT = agyContractHookScriptPath(currentHookPlatform());

/** The POSIX hook script: emit the selected payload, or `{}` when inert. */
const POSIX_HOOK_SCRIPT = `#!/bin/sh
# Managed by Sprout. Provides the project contract to agy as a system message.
# Inert unless Sprout set ${AGY_CONTRACT_PAYLOAD_ENV} for this run.
if [ -n "\${${AGY_CONTRACT_PAYLOAD_ENV}:-}" ] && [ -f "\${${AGY_CONTRACT_PAYLOAD_ENV}}" ]; then
  cat "\${${AGY_CONTRACT_PAYLOAD_ENV}}"
else
  printf '{}\\n'
fi
`;

/**
 * The Windows hook script.
 *
 * `agy` runs hook commands through `cmd /c`, so this is a batch file rather than
 * a shell script. It is built line by line and joined with `\r\n` because a
 * batch file is the one place the host's line endings matter; the quotes around
 * `{}` keep `echo` literal.
 */
const WINDOWS_HOOK_SCRIPT = [
  '@echo off',
  'rem Managed by Sprout. Provides the project contract to agy as a system message.',
  `rem Inert unless Sprout set ${AGY_CONTRACT_PAYLOAD_ENV} for this run.`,
  `if "%${AGY_CONTRACT_PAYLOAD_ENV}%"=="" goto sprout_inert`,
  `if not exist "%${AGY_CONTRACT_PAYLOAD_ENV}%" goto sprout_inert`,
  `type "%${AGY_CONTRACT_PAYLOAD_ENV}%"`,
  'goto :eof',
  ':sprout_inert',
  'echo {}',
  '',
].join('\r\n');

/** The platform a hook is being installed for; defaults to the running host. */
export function currentHookPlatform(): HookPlatform {
  return process.platform === 'win32' ? 'windows' : 'posix';
}

/** Whether a hook can be installed at all for a named platform. */
export function isHookPlatform(platform: string): platform is HookPlatform {
  return platform === 'posix' || platform === 'windows';
}

export interface AgyContractDeliveryRequest {
  /** `agy`'s global customization root (the directory holding `hooks.json`). */
  readonly configDirectory: string;
  /** Where to write this run's payload; Sprout owns the file's lifetime. */
  readonly payloadPath: string;
  readonly instructions: string;
  /**
   * The platform whose hook contract to install.
   *
   * Defaults to the running host. Only `'posix'` and `'windows'` are installable;
   * any other value is reported `unavailable` rather than installing a hook the
   * platform's shell cannot run (C21-005). Named as a string rather than the
   * union so an unrecognised platform fails closed instead of failing to compile
   * or being silently coerced.
   */
  readonly platform?: string;
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
  const platform = request.platform ?? currentHookPlatform();
  if (!isHookPlatform(platform)) {
    return {
      delivery: {
        mechanism: 'unavailable',
        reason: `agy contract hook is not available on this platform (${String(platform)})`,
      },
      env: {},
    };
  }

  const hooksPath = join(request.configDirectory, 'hooks.json');
  const scriptRelative = agyContractHookScriptPath(platform);
  const scriptPath = join(request.configDirectory, scriptRelative);

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
        command: hookCommand(platform, scriptPath),
        timeout: 10,
      },
    ],
  };
  const updated: Record<string, unknown> = {
    ...existing.hooks,
    [AGY_CONTRACT_HOOK_NAME]: hookEntry,
  };

  const script = platform === 'windows' ? WINDOWS_HOOK_SCRIPT : POSIX_HOOK_SCRIPT;
  if (!writeIfPossible(scriptPath, script, platform === 'posix')) {
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

/**
 * The `command` string `agy` runs for this platform's hook.
 *
 * POSIX: `sh "<path>"` — `sh` is present on the supported Unix targets and the
 * quoting handles spaces in the customization root. Windows: `""<path>""` —
 * `agy` invokes the command through `cmd /c`, which runs the batch file
 * directly; the doubled outer quotes are the form `cmd /c` requires when the
 * command names a quoted path, and they keep a path containing spaces intact.
 */
export function hookCommand(platform: HookPlatform, scriptPath: string): string {
  if (platform === 'windows') {
    // `cmd /c` strips the outermost quotes; wrapping the quoted path in a second
    // pair is the standard way to hand `cmd` a quoted executable path.
    return `""${scriptPath}""`;
  }
  return `sh "${scriptPath}"`;
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
