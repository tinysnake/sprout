/**
 * Sanitized failure reasons for engine turns that end in error (#182).
 *
 * A turn that ends in error settles its run as **failed**, and the reason the
 * durable failure field carries is authored here — never assembled from engine
 * text. Raw upstream response bodies, prompts, contract text, and tool output
 * must never reach `agent_runs.failure` / `result.message` (privacy constraint
 * on #182); only a stable failure class and the engine identity (provider/model
 * class) may appear. This holds regardless of transport: the Worker diagnostics
 * boundary (`sanitizeEngineTurnResult`) replaces engine failure text before it
 * crosses Worker JSON-RPC, and this module keeps the same guarantee for any
 * in-process composition of an adapter with the run seam.
 */

/**
 * The stable classes an engine turn can fail under.
 *
 * Each value names *how* the turn terminated as an error, not what the engine
 * said about it: the engine's own text stays inside the engine boundary.
 */
export type EngineTurnFailureCause =
  /** The engine ended the turn with an error stop reason (Pi `stopReason: "error"`). */
  | 'error-stop-reason'
  /** The engine sent an explicit error event/notification on the protocol channel. */
  | 'engine-error'
  /** The engine settled the turn with a failed status or error object (Codex). */
  | 'turn-error'
  /** The engine rejected the turn start request outright. */
  | 'turn-start-rejected'
  /** The engine ended the turn without a recognized successful/interrupted outcome. */
  | 'unexpected-termination';

const REASONS: Readonly<Record<EngineTurnFailureCause, string>> = {
  'error-stop-reason': 'the engine ended the turn with an error stop reason',
  'engine-error': 'the engine reported an error',
  'turn-error': 'the engine settled the turn as failed',
  'turn-start-rejected': 'the engine rejected the turn start',
  'unexpected-termination': 'the engine ended the turn without a recognized outcome',
};

/**
 * Stable, content-free failure text for one engine turn.
 *
 * Deterministic by construction: `<engine> turn failed: <class reason>`. No
 * parameter of this function accepts engine-provided text, so no upstream body,
 * prompt, or tool content can be composed into the durable failure field.
 */
export function sanitizedTurnFailure(engine: string, cause: EngineTurnFailureCause): string {
  return `${engine} turn failed: ${REASONS[cause]}`;
}

/** Exact product-owned messages only; prefixes never authorize engine prose. */
export function trustedTurnFailureMessage(message: unknown): string | undefined {
  if (typeof message !== 'string' || message.length > 200) return undefined;
  if (message === 'the engine turn failed' || message === 'the engine refused the saved session' ||
      message === 'the engine session could not be started') return message;
  for (const engine of ['pi', 'codex', 'agy', 'claude']) {
    for (const cause of Object.keys(REASONS) as EngineTurnFailureCause[]) {
      if (message === sanitizedTurnFailure(engine, cause)) return message;
    }
  }
  return undefined;
}
