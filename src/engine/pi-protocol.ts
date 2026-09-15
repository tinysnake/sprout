import type { AgentRunEvent, EngineTurnResult, TokenUsage } from './port.ts';

/**
 * Translation from Pi's `--mode json` stream into engine-neutral run events.
 *
 * Kept as a pure function over one decoded line and a state object, so it can be
 * tested against recorded traffic without invoking Pi. Every mapping below was
 * confirmed against `pi 0.85.1` on this host:
 *
 * - `message_update` carries an `assistantMessageEvent`; text arrives as
 *   `text_delta`, and tool calls as `toolcall_start` / `toolcall_delta` /
 *   `toolcall_end`.
 * - `tool_execution_start` carries the tool's full arguments, which is why the
 *   tool call is reported here rather than from the partial `toolcall_delta`s.
 * - `tool_execution_update` carries `partialResult` and `tool_execution_end`
 *   carries `result`, so command output is visible while the tool runs.
 * - `agent_settled` is the terminal event for a turn.
 */

export interface PiTurnState {
  /** Assistant text accumulated in the current turn. */
  text: string;
  /** The last assistant text block completed, which is a turn's answer. */
  finalText: string;
  failure: string | undefined;
  /** Sum of completed assistant and compaction calls in this Agent run. */
  tokenUsage: TokenUsage | undefined;
  /** The latest cumulative usage for the assistant message now streaming. */
  pendingMessageUsage: TokenUsage | undefined;
}

export function newPiTurnState(): PiTurnState {
  return {
    text: '',
    finalText: '',
    failure: undefined,
    tokenUsage: undefined,
    pendingMessageUsage: undefined,
  };
}

export interface PiOutcome {
  readonly events: readonly AgentRunEvent[];
  readonly finish?: EngineTurnResult;
  /** Set when the line should be ignored rather than treated as unknown. */
  readonly ignored?: true;
}

interface PiContentPart {
  readonly type?: string;
  readonly text?: string;
}

interface PiMessage {
  readonly role?: string;
  readonly content?: readonly PiContentPart[] | string;
  readonly usage?: unknown;
}

export function mapPiEvent(raw: unknown, state: PiTurnState): PiOutcome {
  if (typeof raw !== 'object' || raw === null) return { events: [], ignored: true };
  const message = raw as Record<string, unknown>;
  const type = message['type'];
  if (typeof type !== 'string') return { events: [], ignored: true };

  switch (type) {
    case 'message_update': {
      // Pi reports a cumulative metric while a message streams. It becomes a
      // run metric only when that assistant message ends, avoiding one count
      // for every streamed delta.
      const usage = readPiTokenUsage(message['usage']);
      if (usage !== undefined) state.pendingMessageUsage = usage;
      return mapAssistantUpdate(message, state);
    }

    case 'tool_execution_start': {
      const name = typeof message['toolName'] === 'string' ? message['toolName'] : 'tool';
      return {
        events: [{ type: 'tool-call', name, detail: describeArguments(message['args']) }],
      };
    }

    case 'tool_execution_update': {
      const text = extractContent(message['partialResult']);
      return text === '' ? { events: [] } : { events: [{ type: 'tool-output', text }] };
    }

    case 'tool_execution_end': {
      const text = extractContent(message['result']);
      const isError = message['isError'] === true;
      // A failed tool is reported, not treated as a failed turn: the engine
      // decides whether the turn can continue, and it will say so.
      if (text === '') {
        return isError ? { events: [{ type: 'notice', text: 'tool failed' }] } : { events: [] };
      }
      return { events: [{ type: 'tool-output', text }] };
    }

    case 'message_end': {
      // A completed assistant message is a turn's answer; the terminal text is
      // the last one, since a turn may contain tool calls before its answer.
      const msg = message['message'] as PiMessage | undefined;
      if (msg?.role !== 'assistant') return { events: [] };
      const text = extractText(msg.content);
      if (text !== '') state.finalText = text;
      addTokenUsage(state, readPiTokenUsage(msg.usage) ?? state.pendingMessageUsage);
      state.pendingMessageUsage = undefined;
      return { events: [] };
    }

    case 'compaction_end': {
      const result = message['result'];
      const usage =
        typeof result === 'object' && result !== null
          ? readPiTokenUsage((result as Record<string, unknown>)['usage'])
          : undefined;
      addTokenUsage(state, usage);
      return { events: [] };
    }

    case 'agent_settled':
      // A malformed or interrupted stream may omit message_end. Keep a valid
      // final update observable rather than failing the otherwise healthy run.
      addTokenUsage(state, state.pendingMessageUsage);
      state.pendingMessageUsage = undefined;
      return {
        events: [],
        finish: {
          status: 'completed',
          text: state.finalText || state.text,
          ...(state.tokenUsage !== undefined ? { tokenUsage: state.tokenUsage } : {}),
        },
      };

    case 'error': {
      const detail =
        typeof message['message'] === 'string'
          ? message['message']
          : typeof message['error'] === 'string'
            ? message['error']
            : 'pi reported an error';
      state.failure = detail;
      return { events: [], finish: { status: 'failed', message: detail } };
    }

    default:
      // Session, turn, agent, and telemetry framing carries no run progress.
      return { events: [], ignored: true };
  }
}

function mapAssistantUpdate(message: Record<string, unknown>, state: PiTurnState): PiOutcome {
  const event = message['assistantMessageEvent'];
  if (typeof event !== 'object' || event === null) return { events: [], ignored: true };
  const update = event as Record<string, unknown>;

  switch (update['type']) {
    case 'text_delta': {
      const delta = typeof update['delta'] === 'string' ? update['delta'] : '';
      if (delta === '') return { events: [] };
      state.text += delta;
      return { events: [{ type: 'message', text: delta, final: false }] };
    }
    case 'text_end': {
      const content = typeof update['content'] === 'string' ? update['content'] : '';
      if (content !== '') state.finalText = content;
      return { events: [] };
    }
    default:
      // Tool-call streaming deltas are partial JSON; the complete arguments
      // arrive with `tool_execution_start`, so nothing is emitted here.
      return { events: [] };
  }
}

/** Pi reports tool arguments as a structured value; show them compactly. */
function describeArguments(args: unknown): string {
  if (typeof args === 'string') return args;
  if (typeof args !== 'object' || args === null) return '';
  const record = args as Record<string, unknown>;
  // `command` is the meaningful detail for a shell tool; otherwise show the
  // arguments so a reader can tell what the tool was asked to do.
  if (typeof record['command'] === 'string') return record['command'];
  try {
    return JSON.stringify(record);
  } catch {
    return '';
  }
}

/** Pull text out of Pi's content parts, or a plain string. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content as PiContentPart[]) {
    if (typeof part?.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

/**
 * Pull text out of a tool result, which wraps its parts in `content`.
 *
 * `partialResult` and `result` are objects (`{ content: [...], details: {} }`),
 * not content arrays, so the wrapper has to be unwrapped before extracting text.
 */
function extractContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  return extractText((payload as { content?: unknown }).content);
}

/** Map Pi's provider-neutral usage shape to Sprout's neutral turn metric. */
function readPiTokenUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const input = usage['input'];
  const output = usage['output'];
  const total = usage['totalTokens'];
  if (!isTokenCount(input) || !isTokenCount(output)) return undefined;
  if (total !== undefined && !isTokenCount(total)) return undefined;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: total ?? input + output,
  };
}

function addTokenUsage(state: PiTurnState, next: TokenUsage | undefined): void {
  if (next === undefined) return;
  const previous = state.tokenUsage;
  state.tokenUsage = previous === undefined
    ? next
    : {
        promptTokens: previous.promptTokens + next.promptTokens,
        completionTokens: previous.completionTokens + next.completionTokens,
        totalTokens: previous.totalTokens + next.totalTokens,
      };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
