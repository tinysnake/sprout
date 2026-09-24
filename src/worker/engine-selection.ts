import { execFileSync } from 'node:child_process';

import type { EngineAdapter } from '../engine/port.ts';
import { CodexEngineAdapter, type CodexSandboxMode } from '../engine/codex.ts';
import { PiEngineAdapter } from '../engine/pi.ts';
import { AgyEngineAdapter } from '../engine/agy.ts';
import { OpenCodeEngineAdapter } from '../engine/opencode.ts';
import type { WorkerConfiguration } from '../host-config.ts';

/**
 * Which engine adapters an Environment Worker hosts, and with what configuration.
 *
 * An engine adapter is the Worker's implementation (ADR-0003): the core never
 * starts an engine process, so the facts an adapter needs are facts about the
 * environment the Worker runs in — where a CLI lives, whether the environment is
 * itself the isolation boundary, and which platform the host speaks.
 *
 * This Module collects those facts once and reports the outcome as plain data,
 * so a caller can observe *what would be configured* for macOS, Windows,
 * container, Codex, and Pi without spawning a process or starting the Sprout
 * runtime. `createEnvironmentWorkerEngines` then turns that same data into the
 * real adapters, which is the only place an engine CLI is named.
 */

/**
 * Host facts engine selection depends on.
 *
 * Every one is injectable so the selection is a pure function of stated facts
 * rather than of whichever machine happens to run the test.
 */
export interface EngineHostFacts {
  readonly configuration: Pick<
    WorkerConfiguration,
    'environmentPlatform' | 'piSessionDirectory' | 'engineBinaries'
  >;
  readonly platform: NodeJS.Platform;
  /**
   * Resolve one engine CLI command on this host, or `undefined` when absent.
   *
   * `preferWindowsExecutable` keeps a measured Windows difference: npm puts an
   * extensionless `sh` shim first in `where` output, which node on Windows cannot
   * execute, while the codex distribution ships a directly runnable `.exe`.
   */
  locate(command: string, options: { readonly preferWindowsExecutable: boolean }): string | undefined;
}

export interface CodexEngineConfiguration {
  readonly engine: 'codex';
  readonly binaryPath: string;
  readonly args: readonly string[];
  /**
   * The sandbox posture for this environment.
   *
   * On a shared host Codex must stay bounded because other agents and the
   * owner's own work are on the same machine. Inside a container the container
   * is the boundary, and Codex's own sandbox is redundant and non-functional
   * there (an unprivileged container cannot create the user namespace `bwrap`
   * needs), so every turn would fail. This is a fact about the environment.
   */
  readonly sandbox: CodexSandboxMode;
}

export interface PiEngineConfiguration {
  readonly engine: 'pi';
  readonly binaryPath: string;
  /** Keeps Sprout's sessions out of the machine-local default store. */
  readonly sessionDirectory?: string;
}

export interface AgyEngineConfiguration {
  readonly engine: 'agy';
  readonly binaryPath: string;
  /**
   * `agy`'s permission model is binary; headless runs cannot prompt, so denial
   * means an empty answer. The environment decides this, exactly as it decides
   * the Codex sandbox.
   */
  readonly skipPermissions: true;
  /**
   * The platform whose hook command `agy` will run: `sh -c` on Unix, `cmd /c` on
   * Windows. Declared from the host platform rather than read inside the hook
   * installer, so the choice stays a stated fact.
   */
  readonly hookPlatform: 'windows' | 'posix';
}

export interface OpenCodeEngineConfiguration {
  readonly engine: 'opencode';
  readonly binaryPath: string;
}

export type EngineConfiguration =
  | CodexEngineConfiguration
  | PiEngineConfiguration
  | AgyEngineConfiguration
  | OpenCodeEngineConfiguration;

/**
 * Constructs the real adapter for one selected configuration.
 *
 * Injectable so selection can be asserted without constructing a real adapter,
 * which is what makes a configuration outcome testable without a live engine.
 */
export interface EngineAdapterFactories {
  codex(configuration: CodexEngineConfiguration): EngineAdapter;
  pi(configuration: PiEngineConfiguration): EngineAdapter;
  agy(configuration: AgyEngineConfiguration): EngineAdapter;
  opencode(configuration: OpenCodeEngineConfiguration): EngineAdapter;
}

const realFactories: EngineAdapterFactories = {
  codex: (configuration) =>
    new CodexEngineAdapter({
      binaryPath: configuration.binaryPath,
      args: [...configuration.args],
      sandbox: configuration.sandbox,
    }),
  pi: (configuration) =>
    new PiEngineAdapter({
      binaryPath: configuration.binaryPath,
      ...(configuration.sessionDirectory !== undefined
        ? { sessionDirectory: configuration.sessionDirectory }
        : {}),
    }),
  agy: (configuration) =>
    new AgyEngineAdapter({
      binaryPath: configuration.binaryPath,
      skipPermissions: configuration.skipPermissions,
      hookPlatform: configuration.hookPlatform,
    }),
  opencode: (configuration) => new OpenCodeEngineAdapter({ binaryPath: configuration.binaryPath }),
};

/**
 * The engine configuration this environment selects, in host order.
 *
 * Order is observable — a worker reports its engines in this order — so Codex,
 * Pi, `agy`, and `opencode` keep the order the entry point established. An engine
 * whose CLI is absent is omitted rather than configured against a missing binary.
 */
export function describeEnvironmentWorkerEngines(facts: EngineHostFacts): readonly EngineConfiguration[] {
  const configuration = facts.configuration;
  const configurations: EngineConfiguration[] = [];

  const codexBinary = resolveEngineBinary('codex', facts, { preferWindowsExecutable: false });
  if (codexBinary !== undefined) {
    configurations.push({
      engine: 'codex',
      binaryPath: codexBinary,
      args: ['--strict-config'],
      sandbox: configuration.environmentPlatform === 'container' ? 'danger-full-access' : 'read-only',
    });
  }

  const piBinary = resolveEngineBinary('pi', facts, { preferWindowsExecutable: true });
  if (piBinary !== undefined) {
    const sessionDirectory = configuration.piSessionDirectory;
    configurations.push({
      engine: 'pi',
      binaryPath: piBinary,
      ...(sessionDirectory !== undefined ? { sessionDirectory } : {}),
    });
  }

  const agyBinary = resolveEngineBinary('agy', facts, { preferWindowsExecutable: true });
  if (agyBinary !== undefined) {
    configurations.push({
      engine: 'agy',
      binaryPath: agyBinary,
      skipPermissions: true,
      hookPlatform: facts.platform === 'win32' ? 'windows' : 'posix',
    });
  }

  const opencodeBinary = resolveEngineBinary('opencode', facts, { preferWindowsExecutable: true });
  if (opencodeBinary !== undefined) {
    configurations.push({ engine: 'opencode', binaryPath: opencodeBinary });
  }

  return configurations;
}

/**
 * Build the Worker's engine adapters from this environment's facts.
 *
 * An empty map is a valid outcome and means the host has no engine CLI; deciding
 * that no engines is fatal stays with the Worker's entry point rather than this
 * Module, so the selection remains a pure description.
 */
export function createEnvironmentWorkerEngines(
  facts: EngineHostFacts,
  factories: Partial<EngineAdapterFactories> = {},
): Map<string, EngineAdapter> {
  const adapters = { ...realFactories, ...factories };
  const engines = new Map<string, EngineAdapter>();
  for (const configuration of describeEnvironmentWorkerEngines(facts)) {
    switch (configuration.engine) {
      case 'codex':
        engines.set('codex', adapters.codex(configuration));
        break;
      case 'pi':
        engines.set('pi', adapters.pi(configuration));
        break;
      case 'agy':
        engines.set('agy', adapters.agy(configuration));
        break;
      case 'opencode':
        engines.set('opencode', adapters.opencode(configuration));
        break;
    }
  }
  return engines;
}

/**
 * The host facts of the running Worker process.
 *
 * Host configuration has already crossed the typed boundary; this function adds
 * only the running platform and CLI lookup needed for engine selection.
 */
export function hostEngineFacts(
  configuration: WorkerConfiguration,
  platform: NodeJS.Platform = process.platform,
): EngineHostFacts {
  return {
    configuration,
    platform,
    locate: (command, options) => lookupCommand(command, platform, options.preferWindowsExecutable),
  };
}

/** An environment's typed override of one engine binary. */
function resolveEngineBinary(
  command: string,
  facts: EngineHostFacts,
  options: { readonly preferWindowsExecutable: boolean },
): string | undefined {
  const override = facts.configuration.engineBinaries[command];
  if (override !== undefined) return override;
  return facts.locate(command, options);
}

/**
 * Resolve a CLI through the host's own lookup command.
 *
 * Windows has no `/bin/sh` and no login-shell PATH, so `where` is its equivalent.
 * Codex must be launched through its real path because a PATH symlink is not
 * traversable under the sandbox profile.
 */
function lookupCommand(
  command: string,
  platform: NodeJS.Platform,
  preferWindowsExecutable: boolean,
): string | undefined {
  const lookup =
    platform === 'win32'
      ? { file: 'where.exe', args: [command] }
      : { file: '/bin/sh', args: ['-lc', `command -v ${command}`] };
  let found: string;
  try {
    found = execFileSync(lookup.file, lookup.args, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const candidates = found
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (candidates.length === 0) return undefined;
  if (platform !== 'win32' || !preferWindowsExecutable) return candidates[0];
  // npm puts an extensionless sh script FIRST in `where` output; node on Windows
  // cannot execute it (found live). An .exe or .cmd actually runs.
  const executable = candidates.find((candidate) => /\.(exe|cmd|bat)$/i.test(candidate));
  return executable ?? candidates[0];
}
