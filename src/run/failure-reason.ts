import type { AgentRun } from './model.ts';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import { trustedTurnFailureMessage } from '../engine/turn-failure.ts';

/**
 * Chat-safe explanation of a persisted outcome. Never redact arbitrary engine
 * prose into a public diagnostic: only exact product-owned reasons cross this
 * boundary. Missing evidence is explicit, not an invented crash diagnosis.
 */
export function runFailureReason(run: Pick<AgentRun, 'result' | 'workOption'>): string {
  // Model identity is the saved product configuration, never an engine field.
  // Require an exact safe configured identifier; never publish a cleaned or
  // truncated value that would misidentify the model used by this run.
  const configured = run.workOption?.workModel;
  const model = typeof configured === 'string' && configured.length <= 160 && configured !== '' &&
    sanitizeIdentifier(configured, { fallback: '', kind: 'model', maxLength: 160 }) === configured
    ? configured : undefined;
  if (run.result?.status !== 'failed') {
    return `No error outcome was recorded.${model !== undefined ? ` Configured model: ${model}.` : ''}`;
  }
  const result = run.result;
  const message = trustedTurnFailureMessage(result.message);
  if (message !== undefined) {
    return model === undefined ? message
      : message.includes(' turn failed:')
        ? message.replace(' turn failed:', ` turn failed for model ${model}:`)
        : `${message} (configured model: ${model}).`;
  }
  const code = result.stopReason === 'error' ? 'stopReason: error' : 'code: failed';
  return `Engine failure (${code}).${model !== undefined ? ` Configured model: ${model}.` : ''}${result.message ? ' Error diagnostic withheld by privacy policy.' : ' No error message was recorded.'}`;
}
