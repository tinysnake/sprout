import type { AgentRunEvent, EngineTurnResult } from './port.ts';
import type { JsonRpcNotification } from './jsonrpc.ts';

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
      if (turn?.error?.message) {
        return { events: [], finish: { status: 'failed', message: turn.error.message } };
      }
      if (turn?.status === 'interrupted') {
        return { events: [], finish: { status: 'interrupted' } };
      }
      return {
        events: [],
        finish: { status: 'completed', text: state.finalText || state.text },
      };
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
      const message = params?.error?.message ?? params?.message ?? 'codex reported an error';
      return {
        events: [],
        finish: { status: 'failed', message },
      };
    }

    default:
      return { events: [] };
  }
}

function firstCommandAction(item: CodexItem): string | undefined {
  const actions = (item as { commandActions?: readonly { command?: string }[] }).commandActions;
  return actions?.[0]?.command;
}
