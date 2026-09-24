import type { AgentWorkOption } from './model.ts';
import {
  evaluateEngineOption,
  type EngineReadinessFact,
  type ReadinessRequirementScope,
} from '../environment/readiness.ts';

/**
 * Run admission's ordered work-option selection (#90, ADR-0008).
 *
 * At admission — always before an engine accepts the work — Sprout walks the
 * Agent's options in order and admits the first one the selected Environment's
 * current facts support. A pure function keeps the one rule in one place:
 * the orchestrator records what this returns on the durable run and never
 * revisits it after an engine accepts.
 */

/**
 * The Environment facts one option is evaluated against.
 *
 * Structural mirror of the observed engine readiness facts (#87), kept local so
 * the run seam does not import the Environment module.
 */
export interface AgentWorkOptionEngineFact {
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

/**
 * Whether an engine's observed facts admit this option.
 *
 * Consumes the shared engine/model evaluation (#123 §6, #129 AC1).
 * `unknown` is not admissible: an unverified readiness must never be treated as
 * a confirmation, exactly as the readiness summary refuses to colour it green.
 */
export function optionAdmissible(
  option: AgentWorkOption,
  facts: (EngineReadinessFact | AgentWorkOptionEngineFact) | undefined,
  requirements?: ReadinessRequirementScope,
): boolean {
  return (
    evaluateEngineOption(option, facts as EngineReadinessFact | undefined, requirements).state ===
    'available'
  );
}

export interface AdmissibleOptionDecision {
  readonly ok: boolean;
  readonly option?: AgentWorkOption;
  readonly reason?: string;
}

/**
 * Evaluate configured work options in order and return the admission decision
 * with the decisive explanation (#129 AC1, AC2, AC6).
 */
export function evaluateAdmissibleWorkOption(
  options: readonly AgentWorkOption[],
  availableEngines: readonly (EngineReadinessFact | AgentWorkOptionEngineFact)[],
  requirements?: ReadinessRequirementScope,
): AdmissibleOptionDecision {
  const engines = new Map(availableEngines.map((fact) => [fact.engine, fact]));
  let firstRefusalReason: string | undefined;
  for (const option of options) {
    const evaluation = evaluateEngineOption(
      option,
      engines.get(option.engine) as EngineReadinessFact | undefined,
      requirements,
    );
    if (evaluation.state === 'available') {
      return { ok: true, option };
    }
    if (firstRefusalReason === undefined) {
      firstRefusalReason = evaluation.reason;
    }
  }
  return {
    ok: false,
    reason: firstRefusalReason ?? 'no work option is compatible with observed environment facts',
  };
}

/**
 * The first option compatible with the supplied Environment facts, or
 * `undefined` when none is.
 *
 * An empty fact list means nothing is verifiable, so every option is refused:
 * a caller without Environment observations opts out entirely by not wiring
 * `engineFacts` (the orchestrator then admits the first option unchanged),
 * while a caller with wiring gets honest `no compatible work option` refusals.
 */
export function selectAdmissibleWorkOption(
  options: readonly AgentWorkOption[],
  availableEngines: readonly (EngineReadinessFact | AgentWorkOptionEngineFact)[],
  requirements?: ReadinessRequirementScope,
): AgentWorkOption | undefined {
  return evaluateAdmissibleWorkOption(options, availableEngines, requirements).option;
}
