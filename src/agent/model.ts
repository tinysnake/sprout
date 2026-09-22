/**
 * The portable Agent identity (ADR-0008, #90).
 *
 * An Agent is created independently of any Project or Environment. It requires a
 * stable identity, a non-empty display name, and at least one ordered **Agent
 * work option**, each naming an engine, a work model, and an effort. Standing
 * instructions are optional. None of these fields may carry a host path, an
 * engine credential, a hostname, or an address: a portable identity names no
 * machine.
 *
 * This module owns the identity vocabulary and its one validation rule set. It
 * deliberately knows nothing about leases, runs, or storage: the service
 * (`service.ts`) owns lifecycle and safety guards, the run orchestrator consumes
 * the ordered options at admission, and the store seam persists the document.
 */

import { sanitizeIdentifier, sanitizeOperatorText, redactSensitiveText } from '../environment/privacy.ts';

/** The Agent lifecycle. Archived is a status, never a delete (ADR-0008). */
export type AgentStatus = 'active' | 'archived';

/** One entry in an Agent's ordered execution preferences (CONTEXT.md). */
export interface AgentWorkOption {
  /** Stable within the Agent's configuration history once created. */
  readonly id: string;
  /** The engine kind this option runs on (`codex`, `pi`, ...). */
  readonly engine: string;
  /** The engine-neutral work model this option uses. */
  readonly workModel: string;
  /** The engine-neutral reasoning effort this option uses. */
  readonly effort: string;
}

/** One append-only version of an Agent's configuration. */
export interface AgentConfigurationVersion {
  readonly version: number;
  readonly at: number;
  /** The sanitized operator reason recorded for this version. */
  readonly reason: string;
  readonly options: readonly AgentWorkOption[];
  readonly instructions?: string;
}

/**
 * An Agent's configuration: the current version plus the append-only history.
 *
 * The history is what makes every run's actual engine, work model, effort, and
 * configuration version historically attributable: an old version is never
 * rewritten, so a past run's `configurationVersion` always resolves to the
 * options it was admitted under.
 */
export interface AgentConfiguration {
  readonly currentVersion: number;
  readonly versions: readonly AgentConfigurationVersion[];
}

/** A durable, portable Agent identity. */
export interface Agent {
  readonly id: string;
  readonly displayName: string;
  readonly status: AgentStatus;
  readonly configuration: AgentConfiguration;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The latest version of an Agent's configuration. */
export function currentConfiguration(agent: Agent): AgentConfigurationVersion {
  const versions = agent.configuration.versions;
  const latest = versions[versions.length - 1];
  if (latest === undefined || latest.version !== agent.configuration.currentVersion) {
    throw new Error(`agent ${agent.id} configuration history is inconsistent`);
  }
  return latest;
}

/** The Agent's ordered options as of its current configuration version. */
export function currentOptions(agent: Agent): readonly AgentWorkOption[] {
  return currentConfiguration(agent).options;
}

/**
 * The run seam's view of an Agent's ordered options.
 *
 * A definition that predates ordered options names exactly one engine, work
 * model, and effort; it is projected as a single option so admission walks one
 * code path. A definition carrying ordered options is passed through.
 */
export function effectiveWorkOptions(
  agent: {
    readonly engine: string;
    readonly model?: string;
    readonly effort?: string;
    readonly workOptions?: readonly AgentWorkOption[];
  },
): readonly AgentWorkOption[] {
  if (agent.workOptions !== undefined && agent.workOptions.length > 0) {
    return agent.workOptions;
  }
  return [
    {
      id: 'primary',
      engine: agent.engine,
      ...(agent.model !== undefined ? { workModel: agent.model } : { workModel: '' }),
      ...(agent.effort !== undefined ? { effort: agent.effort } : { effort: '' }),
    },
  ];
}

export type AgentIdentityErrorCode =
  | 'invalid-display-name'
  | 'invalid-identity'
  | 'no-work-option'
  | 'invalid-work-option'
  | 'unknown-agent'
  | 'already-archived'
  | 'not-archived'
  | 'archived-agent-is-read-only'
  | 'active-work-depends-on-agent';

export class AgentIdentityError extends Error {
  readonly code: AgentIdentityErrorCode;

  constructor(code: AgentIdentityErrorCode, message: string) {
    super(message);
    this.name = 'AgentIdentityError';
    this.code = code;
  }
}

const MAX_DISPLAY_NAME = 120;
const MAX_INSTRUCTIONS = 4_000;

/**
 * Validate and sanitize one work option.
 *
 * An option's fields are structured identifiers, not free text: a path, token,
 * or hostname typed into one is refused with the product-owned fallback rather
 * than persisted. `preserveId` keeps an option's stable id across edits.
 */
export function sanitizeWorkOption(
  raw: { readonly id?: string; readonly engine: string; readonly workModel: string; readonly effort: string },
  options: { readonly preserveId?: string } = {},
): AgentWorkOption {
  const engine = sanitizeIdentifier(raw.engine, { fallback: '', kind: 'engine' });
  const workModel = sanitizeIdentifier(raw.workModel, { fallback: '', kind: 'model' });
  const effort = sanitizeIdentifier(raw.effort, { fallback: '', kind: 'model' });
  if (engine === '') {
    throw new AgentIdentityError(
      'invalid-work-option',
      'an Agent work option requires a valid engine identifier',
    );
  }
  if (workModel === '') {
    throw new AgentIdentityError(
      'invalid-work-option',
      'an Agent work option requires a valid work model identifier',
    );
  }
  if (effort === '') {
    throw new AgentIdentityError(
      'invalid-work-option',
      'an Agent work option requires a valid effort identifier',
    );
  }
  const id = options.preserveId ?? sanitizeIdentifier(raw.id ?? '', { fallback: '', kind: 'generic' });
  return {
    ...(id !== '' ? { id } : { id: `option-${engine}` }),
    engine,
    workModel,
    effort,
  };
}

/** The sanitized display name, or an error when nothing usable remains. */
export function sanitizeDisplayName(value: string | undefined): string {
  const name = sanitizeOperatorText(value, { fallback: '', maxLength: MAX_DISPLAY_NAME });
  if (name === '') {
    throw new AgentIdentityError(
      'invalid-display-name',
      'an Agent requires a non-empty display name',
    );
  }
  return name;
}

/**
 * Sanitize standing instructions.
 *
 * Instructions are woven into the project contract and are free text, but they
 * still live in portable state, so credentials, host paths, addresses, and host
 * identities are redacted rather than preserved. Text that reduces to nothing
 * usable becomes absent instructions.
 */
export function sanitizeInstructions(value: string | undefined): string | undefined {
  const text = redactSensitiveText((value ?? '').trim());
  if (text === '') return undefined;
  const bounded = text.length <= MAX_INSTRUCTIONS
    ? text
    : `${text.slice(0, MAX_INSTRUCTIONS - 1).trimEnd()}\u2026`;
  return bounded === '' ? undefined : bounded;
}

/** Sanitize a stable Agent identity slug, or refuse it. */
export function sanitizeAgentId(value: string | undefined): string | undefined {
  const id = sanitizeIdentifier(value ?? '', { fallback: '', kind: 'generic', maxLength: 64 });
  return id === '' ? undefined : id;
}

/**
 * Create an Agent's first configuration version.
 *
 * `at` and `id` are injected so callers (and tests) control identity and time.
 * The one rule ADR-0008 makes absolute: at least one ordered work option.
 */
export function createAgentConfiguration(input: {
  readonly displayName: string;
  readonly instructions?: string;
  readonly workOptions: readonly {
    readonly id?: string;
    readonly engine: string;
    readonly workModel: string;
    readonly effort: string;
  }[];
  readonly at: number;
}): { readonly displayName: string; readonly instructions?: string; readonly configuration: AgentConfiguration } {
  if (input.workOptions.length === 0) {
    throw new AgentIdentityError(
      'no-work-option',
      'an Agent requires at least one ordered work option',
    );
  }
  const displayName = sanitizeDisplayName(input.displayName);
  const instructions = sanitizeInstructions(input.instructions);
  const options = input.workOptions.map((option) => sanitizeWorkOption(option));
  return {
    displayName,
    ...(instructions !== undefined ? { instructions } : {}),
    configuration: {
      currentVersion: 1,
      versions: [
        {
          version: 1,
          at: input.at,
          reason: 'Agent created with its initial ordered work options.',
          options,
          ...(instructions !== undefined ? { instructions } : {}),
        },
      ],
    },
  };
}
