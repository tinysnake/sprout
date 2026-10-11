const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError',
  'AggregateError', 'AbortError', 'TimeoutError',
]);

const ERROR_CODE_CLASSIFICATIONS = new Map([
  ['ENOENT', 'missing'],
  ['EACCES', 'permission-denied'],
  ['EPERM', 'permission-denied'],
  ['ECONNRESET', 'connection-reset'],
  ['ECONNREFUSED', 'connection-refused'],
  ['ETIMEDOUT', 'timeout'],
  ['ENOTFOUND', 'name-resolution-failed'],
  ['EAI_AGAIN', 'name-resolution-failed'],
  ['ERR_NETWORK', 'network-failed'],
]);

function errorField(error: unknown, field: string): unknown {
  return error !== null && typeof error === 'object' && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

export function safeErrorName(error: unknown): string {
  const name = errorField(error, 'name');
  return typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'unknown';
}

export function safeErrorCode(error: unknown): string | undefined {
  const code = errorField(error, 'code');
  return typeof code === 'string' ? ERROR_CODE_CLASSIFICATIONS.get(code) : undefined;
}

/** Fixed error fields for probe JSON; unknown codes are omitted. */
export function sanitizedProbeErrorFields(error: unknown): Record<string, string> {
  const code = safeErrorCode(error);
  return {
    errorType: safeErrorName(error),
    ...(code !== undefined ? { errorCode: code } : {}),
  };
}

/** Fixed error fields for Host Pi prompt turn facts. */
export function sanitizedPromptErrorFields(error: unknown): Record<string, string> {
  const code = safeErrorCode(error);
  return {
    promptErrorName: safeErrorName(error),
    ...(code !== undefined ? { promptErrorCode: code } : {}),
  };
}

/** Sanitized provider-boundary error facts: identity fields only, never messages. */
export function sanitizeStreamError(error: unknown): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: safeErrorName(error) };
  const code = safeErrorCode(error);
  if (code !== undefined) entry.code = code;
  const status = errorField(error, 'status');
  if (typeof status === 'number' && status >= 100 && status <= 599) entry.status = status;
  const cause = errorField(error, 'cause');
  if (cause && typeof cause === 'object') {
    const causeEntry: Record<string, unknown> = { name: safeErrorName(cause) };
    const causeCode = safeErrorCode(cause);
    if (causeCode !== undefined) causeEntry.code = causeCode;
    entry.cause = causeEntry;
  }
  return entry;
}
