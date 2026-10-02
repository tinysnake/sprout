import type { AgentRun } from './model.ts';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import { trustedTurnFailureMessage } from '../engine/turn-failure.ts';

/**
 * Chat-safe explanation of a persisted outcome. Never redact arbitrary engine
 * prose into a public diagnostic: only exact product-owned reasons cross this
 * boundary. Missing evidence is explicit, not an invented crash diagnosis.
 */
export function runFailureReason(run: Pick<AgentRun, 'result' | 'workOption' | 'failureClass'>): string {
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
  if (run.failureClass === 'environment') {
    // Only the Environment admission class may admit this exact product grammar.
    // An engine cannot opt its arbitrary prose into this boundary by imitating it.
    const leased = /^environment busy: (\S{1,160}) is leased by (\S{1,160})$/.exec(result.message ?? '');
    const recovery = /^environment busy: (\S{1,160}) is in recovery \(held by (\S{1,160})\)$/.exec(result.message ?? '');
    const busy = leased ?? recovery;
    if (busy !== null) {
      const environment = sanitizeIdentifier(busy[1]!, { fallback: '<environment>' });
      const holder = sanitizeIdentifier(busy[2]!, { fallback: '<holder>' });
      const reason = leased !== null ? `Environment busy: ${environment} is leased by ${holder}.`
        : `Environment busy: ${environment} is in recovery (held by ${holder}). Human recovery is required.`;
      return `${reason}${model !== undefined ? ` Configured model: ${model}.` : ''}`;
    }
    return `Environment failure (${result.stopReason === 'error' ? 'stopReason: error' : 'code: failed'}).${model !== undefined ? ` Configured model: ${model}.` : ''}${result.message ? ' Error diagnostic withheld by privacy policy.' : ' No error message was recorded.'}`;
  }
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
