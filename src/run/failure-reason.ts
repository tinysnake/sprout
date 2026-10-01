import type { AgentRun } from './model.ts';
import { trustedTurnFailureMessage } from '../engine/turn-failure.ts';

/**
 * Chat-safe explanation of a persisted outcome. Never redact arbitrary engine
 * prose into a public diagnostic: only exact product-owned reasons cross this
 * boundary. Missing evidence is explicit, not an invented crash diagnosis.
 */
export function runFailureReason(run: Pick<AgentRun, 'result'>): string {
  if (run.result?.status !== 'failed') return 'No error outcome was recorded.';
  const result = run.result;
  const message = trustedTurnFailureMessage(result.message);
  if (message !== undefined) return message;
  const code = result.stopReason === 'error' ? 'stopReason: error' : 'code: failed';
  return `Engine failure (${code}).${result.message ? ' Error diagnostic withheld by privacy policy.' : ' No error message was recorded.'}`;
}
