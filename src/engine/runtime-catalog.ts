import type { EngineCapabilities } from './port.ts';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type RuntimeAdapterKind = 'oar' | 'native';
export type RuntimeReadinessProbe =
  | 'codex-account-read'
  | 'pi-auth-check'
  | 'claude-auth-status'
  | 'unsupported';

export interface RuntimeCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** Only accepted entries appear in product work-option selectors. */
  readonly selection: 'accepted' | 'candidate' | 'disabled';
  readonly adapter: RuntimeAdapterKind;
  readonly workerOrder: number;
  readonly command: string;
  readonly startupArgs?: readonly string[];
  readonly preferWindowsExecutable: boolean;
  readonly capabilities: EngineCapabilities;
  readonly platform: {
    /** Platforms covered by the accepted macOS plus portable substrate. */
    readonly verified: readonly ('darwin' | 'linux' | 'win32')[];
    /** Explicitly postponed platform acceptance. */
    readonly deferred?: readonly ('darwin' | 'linux' | 'win32')[];
  };
  readonly version: {
    readonly minimumRuntime?: string;
    readonly adapterVersion?: string;
    readonly minimumNodeMajor?: number;
  };
  readonly readiness: {
    readonly probe: RuntimeReadinessProbe;
    readonly minimumVersion?: string;
    readonly unknownAction: string;
  };
  readonly policy: {
    readonly credentialOwner: 'environment-host' | 'host-configuration';
    readonly policyId: string;
    readonly limitations?: readonly string[];
    readonly unsupportedWorkerConfigurations?: readonly {
      readonly field: string;
      readonly explanation: string;
    }[];
  };
  readonly finalAnswer: 'turn-text' | 'last-message';
}

const PINNED_OAR_ADAPTER_VERSION = '0.59.1';
const REQUIRED_OAR_NODE_MAJOR = 24;

/**
 * Accepted Environment runtimes and explicitly unaccepted candidates.
 *
 * Discovery only supplies an installation path. It does not add entries here,
 * make a candidate selectable, or make readiness true. A work option is the
 * explicit product configuration that can make an accepted runtime required.
 */
export const ENGINE_RUNTIME_CATALOG = {
  pi: {
    id: 'pi',
    label: 'Pi',
    selection: 'accepted',
    adapter: 'oar',
    workerOrder: 1,
    command: 'pi',
    preferWindowsExecutable: true,
    capabilities: {
      streaming: 'incremental',
      supportsInterrupt: true,
      standingInstructions: 'out-of-band',
    },
    platform: { verified: ['darwin', 'linux'], deferred: ['win32'] },
    version: { minimumRuntime: '0.86.1', adapterVersion: PINNED_OAR_ADAPTER_VERSION, minimumNodeMajor: REQUIRED_OAR_NODE_MAJOR },
    readiness: {
      probe: 'pi-auth-check',
      minimumVersion: '0.86.1',
      unknownAction: 'Check that Pi is installed at a supported version and signed in on this Environment, then run a fresh readiness probe. The option stays unavailable until readiness is established.',
    },
    policy: {
      credentialOwner: 'host-configuration',
      policyId: 'oar-pi-empty-builtins-host-configuration',
      limitations: ['The admitted Pi built-in tool set is empty.'],
      unsupportedWorkerConfigurations: [{
        field: 'sessionDirectory',
        explanation: 'This run did not start; any saved Sprout session key is preserved. OAR Pi uses the host Pi session store and does not support a separate Pi session directory. Remove the Worker session-directory override, then reconnect and run a readiness probe.',
      }],
    },
    finalAnswer: 'turn-text',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    selection: 'accepted',
    adapter: 'oar',
    workerOrder: 0,
    command: 'codex',
    startupArgs: ['--strict-config'],
    preferWindowsExecutable: false,
    capabilities: {
      streaming: 'incremental',
      supportsInterrupt: true,
      standingInstructions: 'out-of-band',
    },
    platform: { verified: ['darwin', 'linux'], deferred: ['win32'] },
    version: { minimumRuntime: '0.154.0', adapterVersion: PINNED_OAR_ADAPTER_VERSION, minimumNodeMajor: REQUIRED_OAR_NODE_MAJOR },
    readiness: {
      probe: 'codex-account-read',
      minimumVersion: '0.154.0',
      unknownAction: 'Check that Codex is installed at a supported version and signed in on this Environment, then run a fresh readiness probe. The option stays unavailable until readiness is established.',
    },
    policy: {
      credentialOwner: 'environment-host',
      policyId: 'oar-codex-environment-sandbox',
      limitations: ['The controlled workspace read limitation remains tracked by #280.'],
    },
    finalAnswer: 'turn-text',
  },
  agy: {
    id: 'agy',
    label: 'agy',
    selection: 'accepted',
    adapter: 'native',
    workerOrder: 2,
    command: 'agy',
    preferWindowsExecutable: true,
    capabilities: {
      streaming: 'incremental',
      supportsInterrupt: true,
      standingInstructions: 'out-of-band',
    },
    platform: { verified: ['darwin', 'linux', 'win32'] },
    version: {},
    readiness: {
      probe: 'unsupported',
      unknownAction: 'Sprout has not established readiness for agy on this Environment. Check its installation and sign-in, or select another configured work option with established readiness. Sprout will not infer readiness from discovery.',
    },
    policy: {
      credentialOwner: 'environment-host',
      policyId: 'native-agy-environment-policy',
    },
    finalAnswer: 'turn-text',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    selection: 'accepted',
    adapter: 'native',
    workerOrder: 3,
    command: 'opencode',
    preferWindowsExecutable: true,
    capabilities: {
      streaming: 'turn',
      supportsInterrupt: true,
      standingInstructions: 'working-directory',
    },
    platform: { verified: ['darwin', 'linux', 'win32'] },
    version: {},
    readiness: {
      probe: 'unsupported',
      unknownAction: 'Sprout has not established readiness for OpenCode on this Environment. Check its installation and sign-in, or select another configured work option with established readiness. Sprout will not infer readiness from discovery.',
    },
    policy: {
      credentialOwner: 'environment-host',
      policyId: 'native-opencode-environment-policy',
    },
    finalAnswer: 'turn-text',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    selection: 'candidate',
    adapter: 'oar',
    workerOrder: 4,
    command: 'claude',
    preferWindowsExecutable: false,
    capabilities: {
      streaming: 'incremental',
      supportsInterrupt: true,
      standingInstructions: 'out-of-band',
    },
    platform: { verified: ['darwin'] },
    version: { minimumRuntime: '2.1.294', adapterVersion: PINNED_OAR_ADAPTER_VERSION, minimumNodeMajor: REQUIRED_OAR_NODE_MAJOR },
    readiness: {
      probe: 'claude-auth-status',
      minimumVersion: '2.1.294',
      unknownAction: 'Claude Code is a candidate runtime and is not enabled for Environment work options.',
    },
    policy: {
      credentialOwner: 'environment-host',
      policyId: 'oar-claude-candidate',
      limitations: ['Host-run authority is not established.'],
    },
    finalAnswer: 'last-message',
  },
} as const satisfies Record<string, RuntimeCatalogEntry>;

export type EngineRuntimeId = keyof typeof ENGINE_RUNTIME_CATALOG;

export function runtimeCatalogEntry(engine: string): RuntimeCatalogEntry | undefined {
  return Object.hasOwn(ENGINE_RUNTIME_CATALOG, engine)
    ? ENGINE_RUNTIME_CATALOG[engine as EngineRuntimeId]
    : undefined;
}

/** Product selectors are derived from accepted entries, never runtime discovery. */
export function selectableEngineRuntimes(): readonly RuntimeCatalogEntry[] {
  return Object.values(ENGINE_RUNTIME_CATALOG)
    .filter((runtime) => runtime.selection === 'accepted');
}

/** Return the accepted product explanation for an unsupported Worker setting. */
export function runtimeConfigurationIssue(
  engine: string,
  configuration: Readonly<Record<string, unknown>>,
): string | undefined {
  const runtime = runtimeCatalogEntry(engine);
  for (const limitation of runtime?.policy.unsupportedWorkerConfigurations ?? []) {
    const value = configuration[limitation.field];
    if (value !== undefined && value !== null && value !== '') return limitation.explanation;
  }
  return undefined;
}

export const OAR_ADAPTER_VERSION = ENGINE_RUNTIME_CATALOG.codex.version.adapterVersion!;
export const OAR_MINIMUM_NODE_MAJOR = ENGINE_RUNTIME_CATALOG.codex.version.minimumNodeMajor!;

export const OAR_RUNTIME_VERSION_FLOORS = {
  codex: ENGINE_RUNTIME_CATALOG.codex.readiness.minimumVersion!,
  pi: ENGINE_RUNTIME_CATALOG.pi.readiness.minimumVersion!,
  claude: ENGINE_RUNTIME_CATALOG.claude.readiness.minimumVersion!,
} as const;

export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
