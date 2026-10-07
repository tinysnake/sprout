import type { AgentRunEvent, EngineTurnResult } from './port.ts';
import type { JsonRpcNotification } from './jsonrpc.ts';
import { classifyEngineTurnFailure, isRetryableEngineTurnFailure, sanitizedTurnFailure, type EngineTurnFailureCause } from './turn-failure.ts';

/**
 * Translation from Codex `app-server` notifications into the engine-neutral run
 * events the core understands.
 *
 * Kept as a pure function over (notification, state) so it can be tested against
 * recorded protocol traffic without spawning Codex. The mappings below were
 * confirmed by probing `codex-cli 0.154.0`; the shapes are protocol facts, not
 * guesses:
 *
 * - `item/agentMessage/delta` carries incremental assistant text.
 * - `item/started` for `commandExecution` is the tool call becoming visible,
 *   including the command string, *before* it completes.
 * - `item/commandExecution/outputDelta` carries command output as it arrives.
 * - `item/completed` for `agentMessage` carries the turn's full text.
 * - `turn/completed` reports `turn.status` of `completed` or `interrupted`, and
 *   an `error` object when the turn failed. It carries no token usage.
 *
 * Error terminations are classified as **failed** with a sanitized reason and
 * never as completed empty turns (#182): a `failed`/`error` status, an error
 * object, a non-retrying `error` notification, or a settlement status Sprout
 * does not recognize all fail the turn. The engine's own error text (an
 * upstream body) is deliberately never read.
 */

export interface CodexTurnState {
  text: string;
  finalText: string;
  failure: string | undefined;
}

export interface CodexNotificationOutcome {
  readonly events: readonly AgentRunEvent[];
  readonly finish?: EngineTurnResult;
}

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
  readonly command?: string;
  readonly status?: string;
  readonly exitCode?: number | null;
  readonly aggregatedOutput?: string | null;
}

interface CodexTurn {
  readonly status?: string;
  readonly error?: { readonly message?: string } | null;
}

export function mapCodexNotification(
  notification: JsonRpcNotification,
  state: CodexTurnState,
): CodexNotificationOutcome {
  switch (notification.method) {
    case 'item/agentMessage/delta': {
      const params = notification.params as { delta?: string } | undefined;
      const delta = params?.delta ?? '';
      state.text += delta;
      return { events: [{ type: 'message', text: delta, final: false }] };
    }

    case 'item/commandExecution/outputDelta': {
      const params = notification.params as { delta?: string } | undefined;
      const delta = params?.delta ?? '';
      return delta === '' ? { events: [] } : { events: [{ type: 'tool-output', text: delta }] };
    }

    case 'item/started': {
      const params = notification.params as { item?: CodexItem } | undefined;
      const item = params?.item;
      if (item?.type === 'commandExecution') {
        const what = firstCommandAction(item) ?? item.command ?? 'command';
        return { events: [{ type: 'tool-call', name: 'shell', detail: what }] };
      }
      if (item?.type === 'reasoning') {
        return { events: [{ type: 'notice', text: 'reasoning' }] };
      }
      return { events: [] };
    }

    case 'item/completed': {
      const params = notification.params as { item?: CodexItem } | undefined;
      const item = params?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        state.finalText = item.text;
        return { events: [{ type: 'message', text: item.text, final: true }] };
      }
      if (item?.type === 'commandExecution') {
        const output = item.aggregatedOutput ?? undefined;
        const summary = output ?? `exit ${item.exitCode ?? 'unknown'}`;
        return { events: [{ type: 'tool-output', text: summary }] };
      }
      return { events: [] };
    }

    case 'turn/completed': {
      const params = notification.params as { turn?: CodexTurn } | undefined;
      const turn = params?.turn;
      const status = turn?.status;
      // An error object is the engine's own report that the turn failed; its
      // message is an upstream body and is never read (#182).
      if (turn?.error !== undefined && turn.error !== null) {
        return failTurn(classifyEngineTurnFailure(turn.error) ?? 'turn-error');
      }
      if (status === 'interrupted') {
        return { events: [], finish: { status: 'interrupted' } };
      }
      if (status === 'failed' || status === 'error') {
        // A failed status without an error message is still a failed turn —
        // completing it here would record the silent empty success #182 forbids.
        return failTurn('turn-error');
      }
      if (status === 'completed') {
        return {
          events: [],
          finish: { status: 'completed', text: state.finalText || state.text },
        };
      }
      // The settlement names no recognized outcome, so success is unknown:
      // fail closed rather than fabricate a completed empty turn (#182).
      return failTurn('unexpected-termination');
    }

    case 'error': {
      const params = notification.params as
        | {
            message?: string;
            error?: { message?: string; willRetry?: boolean };
          }
        | undefined;
      // Codex reports transient transport failures (e.g. a reconnecting
      // stream) as error notifications with willRetry: true — found live on
      // Windows, where the first provider attempt timed out and the retry
      // succeeded. Failing the turn there would abandon a turn the engine
      // itself is still pursuing; only a non-retrying error is terminal.
      if (params?.error?.willRetry === true) {
        return { events: [] };
      }
      // The notification's message is engine/provider text (potentially a raw
      // upstream body); only the stable failure class is reported (#182).
      return failTurn(classifyEngineTurnFailure(params?.error ?? params) ?? 'engine-error');
    }

    default:
      return { events: [] };
  }
}

/** Classify an error termination with stable, content-free failure text (#182). */
function failTurn(cause: EngineTurnFailureCause): CodexNotificationOutcome {
  return {
    events: [],
    finish: {
      status: 'failed',
      message: sanitizedTurnFailure('codex', cause),
      ...(isRetryableEngineTurnFailure(cause) ? { retryable: true as const } : {}),
    },
  };
}

function firstCommandAction(item: CodexItem): string | undefined {
  const actions = (item as { commandActions?: readonly { command?: string }[] }).commandActions;
  return actions?.[0]?.command;
}
