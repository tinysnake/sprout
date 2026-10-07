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
  | 'model-rejected'
  | 'auth-rejected'
  | 'rate-limited'
  | 'timeout'
  | 'upstream-unavailable'
  | 'connection-lost'
  | 'context-overflow'
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
  'model-rejected': 'the engine rejected the model',
  'auth-rejected': 'authentication was rejected',
  'rate-limited': 'the engine rate limit was reached',
  'timeout': 'the engine request timed out',
  'upstream-unavailable': 'the upstream service was unavailable',
  'connection-lost': 'the engine connection was lost',
  'context-overflow': 'the context exceeded the model limit',
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

const ERROR_CODES: Readonly<Record<string, EngineTurnFailureCause>> = {
  model_not_found: 'model-rejected', unknown_model: 'model-rejected',
  invalid_model: 'model-rejected', model_unavailable: 'model-rejected',
  model_rejected: 'model-rejected', unsupported_model: 'model-rejected',
  authentication_error: 'auth-rejected', invalid_api_key: 'auth-rejected',
  unauthorized: 'auth-rejected', permission_denied: 'auth-rejected',
  rate_limit_exceeded: 'rate-limited', rate_limit_error: 'rate-limited',
  usage_limit_reached: 'rate-limited',
  etimedout: 'timeout', request_timeout: 'timeout', timeout: 'timeout',
  econnreset: 'connection-lost', econnrefused: 'connection-lost',
  enotfound: 'connection-lost', eai_again: 'connection-lost',
  epipe: 'connection-lost', connection_error: 'connection-lost',
  context_length_exceeded: 'context-overflow', context_window_exceeded: 'context-overflow',
  // Codex app-server's codexErrorInfo enum (including object variants).
  contextwindowexceeded: 'context-overflow', usagelimitexceeded: 'rate-limited',
  httpconnectionfailed: 'connection-lost', responsestreamconnectionfailed: 'connection-lost',
  responsestreamdisconnected: 'connection-lost', responsestreamfailed: 'connection-lost',
  responsestreamdisconnectedmaxretries: 'connection-lost',
};

/**
 * Inspect only named machine fields inside the engine boundary. No message,
 * prompt, content, stderr or tool output is searched for diagnostic keywords.
 * Some Pi providers serialize an HTTP status + JSON error into errorMessage;
 * parse that envelope locally, but never return its body or free-form message.
 */
export function classifyEngineTurnFailure(raw: unknown, depth = 0): EngineTurnFailureCause | undefined {
  if (depth > 5 || typeof raw !== 'object' || raw === null) return undefined;
  const signal = raw as Record<string, unknown>;
  for (const key of ['code', 'errorCode', 'type']) {
    const code = signal[key];
    if (typeof code === 'string' && Object.hasOwn(ERROR_CODES, code.toLowerCase())) return ERROR_CODES[code.toLowerCase()];
  }
  // Explicit nested codes are more specific than a broad HTTP status.
  for (const key of ['error', 'cause', 'data']) {
    const cause = classifyEngineTurnFailure(signal[key], depth + 1);
    if (cause !== undefined) return cause;
  }
  for (const key of ['status', 'statusCode', 'httpStatusCode']) {
    switch (signal[key]) {
      case 401: case 403: return 'auth-rejected';
      case 429: return 'rate-limited';
      case 408: case 504: return 'timeout';
      case 502: case 503: return 'upstream-unavailable';
    }
  }
  const info = signal['codexErrorInfo'];
  if (typeof info === 'string' && Object.hasOwn(ERROR_CODES, info.toLowerCase())) return ERROR_CODES[info.toLowerCase()];
  if (typeof info === 'object' && info !== null) {
    for (const [variant, details] of Object.entries(info)) {
      if (!Object.hasOwn(ERROR_CODES, variant.toLowerCase())) continue;
      return classifyEngineTurnFailure(details, depth + 1) ?? ERROR_CODES[variant.toLowerCase()];
    }
  }
  const encoded = signal['errorMessage'];
  if (typeof encoded === 'string' && encoded.length <= 32_768) {
    // A plain sentence (even one prefixed with a status) conveys no class.
    const envelope = /^(?:([45]\d{2}) )?(\{[\s\S]*\})$/.exec(encoded.trim());
    if (envelope !== null) {
      try {
        return classifyEngineTurnFailure(JSON.parse(envelope[2]!), depth + 1) ??
          classifyEngineTurnFailure({ statusCode: Number(envelope[1]) }, depth + 1);
      } catch { /* Malformed JSON provides no structured evidence. */ }
    }
  }
  return undefined;
}

/** Whether an already-classified engine failure is safe to retry automatically. */
export function isRetryableEngineTurnFailure(cause: EngineTurnFailureCause | undefined): boolean {
  return cause === 'timeout' || cause === 'connection-lost' || cause === 'upstream-unavailable';
}

/** Exact product-owned messages only; prefixes never authorize engine prose. */
export function trustedTurnFailureCause(message: unknown): EngineTurnFailureCause | undefined {
  if (typeof message !== 'string' || message.length > 200) return undefined;
  for (const engine of ['pi', 'codex', 'agy', 'claude']) {
    for (const cause of Object.keys(REASONS) as EngineTurnFailureCause[]) {
      if (message === sanitizedTurnFailure(engine, cause)) return cause;
    }
  }
  return undefined;
}

/** Exact product-owned messages only; prefixes never authorize engine prose. */
export function trustedTurnFailureMessage(message: unknown): string | undefined {
  const trusted = trustedTurnFailureCause(message);
  if (trusted !== undefined) return message as string;
  if (typeof message !== 'string' || message.length > 200) return undefined;
  if (message === 'the engine turn failed' || message === 'the engine refused the saved session' ||
      message === 'the engine session could not be started') return message;
  return undefined;
}
