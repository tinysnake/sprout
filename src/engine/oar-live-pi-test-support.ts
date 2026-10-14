import { OarPolicyContentionError, type EngineAdapter, type EngineSession, type StartSessionRequest } from './port.ts';

export const CONTENTION_SKIP_MESSAGE = '[CONTENTION SKIP] another OAR Pi session holds the machine-global agent-directory policy lease; this test does not run concurrently with it';

export type LivePiStartAttempt<T> =
  | { readonly kind: 'started'; readonly value: T }
  | { readonly kind: 'contention'; readonly error: OarPolicyContentionError };

export async function attemptLivePiStart<T>(start: () => Promise<T>): Promise<LivePiStartAttempt<T>> {
  try {
    return { kind: 'started', value: await start() };
  } catch (error) {
    if (error instanceof OarPolicyContentionError) return { kind: 'contention', error };
    throw error;
  }
}

export function skipIfLivePiContention<T>(
  skip: (message: string) => void,
  attempt: LivePiStartAttempt<T>,
): attempt is Extract<LivePiStartAttempt<T>, { kind: 'contention' }> {
  if (attempt.kind !== 'contention') return false;
  skip(CONTENTION_SKIP_MESSAGE);
  return true;
}

export async function startLivePiSession(
  adapter: EngineAdapter,
  request: StartSessionRequest,
  skip: (message: string) => void,
): Promise<EngineSession | undefined> {
  const attempt = await attemptLivePiStart(() => adapter.startSession(request));
  if (skipIfLivePiContention(skip, attempt)) return undefined;
  return attempt.value;
}

// This module is imported only by tests; production cannot use its skip policy.
