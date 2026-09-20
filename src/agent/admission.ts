import type { AgentWorkOption } from './model.ts';

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
}

/**
 * Whether an engine's observed facts admit this option.
 *
 * `unknown` is not admissible: an unverified readiness must never be treated as
 * a confirmation, exactly as the readiness summary refuses to colour it green.
 */
function optionAdmissible(option: AgentWorkOption, facts: AgentWorkOptionEngineFact | undefined): boolean {
  if (facts === undefined) return false;
  if (!facts.installed || facts.readiness === 'missing' || facts.readiness === 'login-required') return false;
  if (facts.readiness !== 'ready') return false;
  if (option.workModel === '') return true;
  if (facts.models.state === 'available') return facts.models.models.includes(option.workModel);
  return false;
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
  availableEngines: readonly AgentWorkOptionEngineFact[],
): AgentWorkOption | undefined {
  const engines = new Map(availableEngines.map((fact) => [fact.engine, fact]));
  return options.find((option) => optionAdmissible(option, engines.get(option.engine)));
}
