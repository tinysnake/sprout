import type { AgentWorkOption } from './model.ts';
import {
  evaluateEngineOption,
  type EngineOptionEvaluationState,
  type EngineReadinessFact,
  type ReadinessRequirementScope,
} from '../environment/readiness.ts';

/**
 * Agent work-option compatibility, derived from current Environment facts (#90, ADR-0008).
 *
 * Compatibility is a **projection over facts**, never a stored state: an
 * Environment's observed engine readiness and model availability facts (#87)
 * are joined against an Agent's ordered work options here, at read time. Nothing
 * in this module consults a live process, an installation, or a login; it reads
 * only what the Environment's readiness record honestly states.
 *
 * The two rules this projection preserves:
 *
 * - An unsupported Agent remains a valid identity but is visibly unavailable:
 *   the projection reports per-option and overall availability rather than
 *   rejecting the Agent.
 * - The projection never decides the admission; it states which option
   * admission would take, and the orchestrator makes the actual, recorded
 *   choice from the same facts at submission time.
 */

/**
 * The Environment facts one option is checked against.
 *
 * This is the subset of `EngineReadinessFact` (#87) the projection needs, kept
 * structural so tests and adapters can supply it without importing the
 * Environment module.
 */
export interface OptionEngineFact {
  readonly engine: string;
  readonly installed: boolean;
  readonly readiness: 'ready' | 'login-required' | 'missing' | 'unknown';
  readonly models: { readonly state: 'available' | 'none' | 'unknown'; readonly models: readonly string[] };
  readonly version?: string;
  readonly authenticated?: boolean;
  readonly authMode?: string;
  readonly authType?: string;
  readonly modelIdPresent?: boolean;
  readonly targetModels?: readonly string[];
  readonly requirementRevision?: string;
  readonly probedAt?: number;
  readonly probeExitCode?: number;
  readonly source?: string;
}

export type OptionAvailabilityState = EngineOptionEvaluationState;

export interface OptionCompatibility {
  readonly option: AgentWorkOption;
  readonly state: OptionAvailabilityState;
  /** The decisive textual reason; never colour-only (ADR-0009). */
  readonly reason: string;
}

export interface AgentCompatibilityProjection {
  /** Per-option facts, in the Agent's declared order. */
  readonly options: readonly OptionCompatibility[];
  /** Whether the Agent could currently run on this Environment at all. */
  readonly available: boolean;
  /** The first available option, when any is. */
  readonly firstAvailable?: AgentWorkOption;
  /** The decisive reason the Agent is unavailable, when it is. */
  readonly unavailableReason?: string;
  /** Explicit statement that compatibility is not an authorization token to execute. */
  readonly explanation?: string;
}

/**
 * Project one Agent's ordered work options onto one Environment's engine facts.
 *
 * `availableEngines` is the current observed fact list for one Environment
 * instance. An option with an empty work model (a definition-era single engine
 * with no model configured) is available whenever the engine itself is ready.
 */
export function projectAgentCompatibility(input: {
  readonly workOptions: readonly AgentWorkOption[];
  readonly availableEngines: readonly (EngineReadinessFact | OptionEngineFact)[];
  readonly requirements?: ReadinessRequirementScope;
}): AgentCompatibilityProjection {
  const engines = new Map(input.availableEngines.map((engine) => [engine.engine, engine]));
  const options = input.workOptions.map((option): OptionCompatibility => {
    const observed = engines.get(option.engine);
    const evaluation = evaluateEngineOption(
      option,
      observed as EngineReadinessFact | undefined,
      input.requirements,
    );
    return {
      option,
      state: evaluation.state,
      reason: evaluation.reason,
    };
  });

  const firstAvailable = options.find((option) => option.state === 'available');
  return {
    options,
    available: firstAvailable !== undefined,
    ...(firstAvailable !== undefined ? { firstAvailable: firstAvailable.option } : {}),
    ...(firstAvailable === undefined
      ? { unavailableReason: options[0]?.reason ?? 'No work option can run on this Environment.' }
      : {}),
    explanation:
      'Compatibility reflects engine and model readiness only, not permission to execute. Runs remain independently gated by enrollment authority, capability permissions, leases, and work safety.',
  };
}
