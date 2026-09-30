import type { AgentRunEvent, EngineTurnResult, TokenUsage, DetailedTokenDimensions } from './port.ts';
import { extractPiCostEstimate } from '../usage/valuation.ts';
import { sanitizedTurnFailure, type EngineTurnFailureCause } from './turn-failure.ts';

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
 * - an assistant message (or the turn) ending with `stopReason: "error"` is an
 *   error termination: it settles the turn as **failed** with a sanitized
 *   reason, never as a completed empty turn (#182). The `errorMessage` that
 *   rides alongside it is the raw upstream body and is never read.
 */

export interface PiTurnState {
  /** Assistant text accumulated in the current turn. */
  text: string;
  /** The last assistant text block completed, which is a turn's answer. */
  finalText: string;
  failure: string | undefined;
  /** Sum of completed assistant and compaction calls in this Agent run. */
  tokenUsage: TokenUsage | undefined;
  detailedTokens: DetailedTokenDimensions | undefined;
  cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | undefined;
  /** The latest cumulative usage for the assistant message now streaming. */
  pendingDetailedUsage: {
    readonly tokenUsage: TokenUsage;
    readonly detailedTokens: DetailedTokenDimensions;
    readonly cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  } | undefined;
}

export function newPiTurnState(): PiTurnState {
  return {
    text: '',
    finalText: '',
    failure: undefined,
    tokenUsage: undefined,
    detailedTokens: undefined,
    cost: undefined,
    pendingDetailedUsage: undefined,
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
  /** `"stop" | "toolUse" | "error" | "aborted"`; `"error"` is an error termination. */
  readonly stopReason?: string;
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
      const detailed = readPiDetailedUsage(message['usage']);
      if (detailed !== undefined) state.pendingDetailedUsage = detailed;
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
      // An errored assistant message is a failure, not an empty answer. The
      // engine's `errorMessage` is the raw upstream body: it is deliberately
      // never read into state or the turn result (#182).
      if (msg.stopReason === 'error') return failTurn(state, 'error-stop-reason');
      const text = extractText(msg.content);
      if (text !== '') state.finalText = text;
      addPiDetailedUsage(state, readPiDetailedUsage(msg.usage) ?? state.pendingDetailedUsage);
      state.pendingDetailedUsage = undefined;
      return { events: [] };
    }

    case 'turn_end': {
      // The agent loop re-emits the terminal message on `turn_end`; checking it
      // too means an error termination is caught even when `message_end` was
      // omitted from a malformed stream.
      const msg = message['message'] as PiMessage | undefined;
      if (msg?.stopReason === 'error') return failTurn(state, 'error-stop-reason');
      // Turn framing otherwise carries no run progress.
      return { events: [], ignored: true };
    }

    case 'compaction_end': {
      const result = message['result'];
      const detailed =
        typeof result === 'object' && result !== null
          ? readPiDetailedUsage((result as Record<string, unknown>)['usage'])
          : undefined;
      addPiDetailedUsage(state, detailed);
      return { events: [] };
    }

    case 'agent_settled': {
      // Belt and braces: if an error was already classified anywhere in the
      // stream (or the settle event itself carries the error stop reason), the
      // turn settles as failed — an errored turn can never complete as an
      // empty successful turn (#182). An already-classified failure keeps its
      // own class rather than being re-labelled.
      if (state.failure !== undefined) {
        return { events: [], finish: createPiTurnResult(state, 'failed', state.failure) };
      }
      if (message['stopReason'] === 'error') return failTurn(state, 'error-stop-reason');
      // A malformed or interrupted stream may omit message_end. Keep a valid
      // final update observable rather than failing the otherwise healthy run.
      addPiDetailedUsage(state, state.pendingDetailedUsage);
      state.pendingDetailedUsage = undefined;
      return {
        events: [],
        finish: createPiTurnResult(state, 'completed'),
      };
    }

    case 'error': {
      // The event may carry the engine's raw detail (an upstream body); it is
      // never read. Only the stable failure class reaches durable state (#182).
      return failTurn(state, 'engine-error');
    }

    default:
      // Session, turn, agent, and telemetry framing carries no run progress.
      return { events: [], ignored: true };
  }
}

/**
 * Classify an error termination: stable failure text in state and in the turn
 * result, nothing engine-authored (#182).
 */
function failTurn(state: PiTurnState, cause: EngineTurnFailureCause): PiOutcome {
  // First classification wins, so every later settle attempt reports the same
  // stable reason for the same turn.
  const failure = state.failure ?? sanitizedTurnFailure('pi', cause);
  state.failure = failure;
  return { events: [], finish: createPiTurnResult(state, 'failed', failure) };
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

function createPiTurnResult(
  state: PiTurnState,
  status: 'completed' | 'failed',
  errorMessage?: string,
): EngineTurnResult {
  const hasUsage = state.tokenUsage !== undefined || state.detailedTokens !== undefined;
  const costEstimate = state.cost?.total !== undefined ? extractPiCostEstimate({ cost: state.cost, valuedAt: Date.now() }) : undefined;
  if (status === 'failed') {
    return {
      status: 'failed',
      message: errorMessage ?? 'failed',
      ...(state.tokenUsage !== undefined ? { tokenUsage: state.tokenUsage } : {}),
      ...(state.detailedTokens !== undefined ? { detailedTokens: state.detailedTokens } : {}),
      ...(costEstimate !== undefined ? { costEstimate } : {}),
      ...(hasUsage ? {
        billingBasis: 'metered_api' as const,
        source: 'pi-protocol:message_end',
        sourceVersion: 'pi 0.85.1',
      } : {}),
    };
  }
  return {
    status: 'completed',
    text: state.finalText || state.text,
    ...(state.tokenUsage !== undefined ? { tokenUsage: state.tokenUsage } : {}),
    ...(state.detailedTokens !== undefined ? { detailedTokens: state.detailedTokens } : {}),
    ...(costEstimate !== undefined ? { costEstimate } : {}),
    ...(hasUsage ? {
      billingBasis: 'metered_api' as const,
      source: 'pi-protocol:message_end',
      sourceVersion: 'pi 0.85.1',
    } : {}),
  };
}

/** Map Pi's provider-neutral usage shape to Sprout's detailed metrics. */
function readPiDetailedUsage(raw: unknown): {
  readonly tokenUsage: TokenUsage;
  readonly detailedTokens: DetailedTokenDimensions;
  readonly cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
} | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const input = usage['input'];
  const output = usage['output'];
  const total = usage['totalTokens'];
  if (!isTokenCount(input) || !isTokenCount(output)) return undefined;
  if (total !== undefined && !isTokenCount(total)) return undefined;

  const cacheRead = isTokenCount(usage['cacheRead']) ? usage['cacheRead'] : 0;
  const cacheWrite = isTokenCount(usage['cacheWrite']) ? usage['cacheWrite'] : 0;
  const reasoning = isTokenCount(usage['reasoning']) ? usage['reasoning'] : undefined;
  const uncachedInput = typeof cacheRead === 'number' ? Math.max(0, input - cacheRead) : undefined;

  const detailedTokens: DetailedTokenDimensions = {
    inputTokens: input,
    ...(uncachedInput !== undefined ? { uncachedInputTokens: uncachedInput } : {}),
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    totalTokens: total ?? input + output,
  };

  let cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | undefined;
  if (typeof usage['cost'] === 'object' && usage['cost'] !== null) {
    const rawCost = usage['cost'] as Record<string, unknown>;
    cost = {
      ...(typeof rawCost['input'] === 'number' ? { input: rawCost['input'] } : {}),
      ...(typeof rawCost['output'] === 'number' ? { output: rawCost['output'] } : {}),
      ...(typeof rawCost['cacheRead'] === 'number' ? { cacheRead: rawCost['cacheRead'] } : {}),
      ...(typeof rawCost['cacheWrite'] === 'number' ? { cacheWrite: rawCost['cacheWrite'] } : {}),
      ...(typeof rawCost['total'] === 'number' ? { total: rawCost['total'] } : {}),
    };
  }

  return {
    tokenUsage: {
      promptTokens: input,
      completionTokens: output,
      totalTokens: total ?? input + output,
    },
    detailedTokens,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function addPiDetailedUsage(
  state: PiTurnState,
  next: {
    readonly tokenUsage: TokenUsage;
    readonly detailedTokens: DetailedTokenDimensions;
    readonly cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  } | undefined,
): void {
  if (next === undefined) return;
  const prevTokens = state.tokenUsage;
  state.tokenUsage = prevTokens === undefined
    ? next.tokenUsage
    : {
        promptTokens: prevTokens.promptTokens + next.tokenUsage.promptTokens,
        completionTokens: prevTokens.completionTokens + next.tokenUsage.completionTokens,
        totalTokens: prevTokens.totalTokens + next.tokenUsage.totalTokens,
      };

  const prevDetailed = state.detailedTokens;
  state.detailedTokens = prevDetailed === undefined
    ? next.detailedTokens
    : {
        inputTokens: (prevDetailed.inputTokens ?? 0) + (next.detailedTokens.inputTokens ?? 0),
        uncachedInputTokens: (prevDetailed.uncachedInputTokens ?? 0) + (next.detailedTokens.uncachedInputTokens ?? 0),
        cachedInputTokens: (prevDetailed.cachedInputTokens ?? 0) + (next.detailedTokens.cachedInputTokens ?? 0),
        cacheWriteInputTokens: (prevDetailed.cacheWriteInputTokens ?? 0) + (next.detailedTokens.cacheWriteInputTokens ?? 0),
        outputTokens: (prevDetailed.outputTokens ?? 0) + (next.detailedTokens.outputTokens ?? 0),
        reasoningOutputTokens: (prevDetailed.reasoningOutputTokens ?? 0) + (next.detailedTokens.reasoningOutputTokens ?? 0),
        totalTokens: (prevDetailed.totalTokens ?? 0) + (next.detailedTokens.totalTokens ?? 0),
      };

  if (next.cost !== undefined) {
    const prevCost = state.cost;
    state.cost = prevCost === undefined
      ? next.cost
      : {
          input: (prevCost.input ?? 0) + (next.cost.input ?? 0),
          output: (prevCost.output ?? 0) + (next.cost.output ?? 0),
          cacheRead: (prevCost.cacheRead ?? 0) + (next.cost.cacheRead ?? 0),
          cacheWrite: (prevCost.cacheWrite ?? 0) + (next.cost.cacheWrite ?? 0),
          total: (prevCost.total ?? 0) + (next.cost.total ?? 0),
        };
  }
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
