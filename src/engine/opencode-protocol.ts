import type { AgentRunEvent, DetailedTokenDimensions, EngineTurnResult, TokenUsage } from './port.ts';

/**
 * Translation from `opencode run --format json` into engine-neutral run events.
 *
 * A pure function over one decoded event and a state object, so it is testable
 * against recorded traffic without invoking the engine.
 *
 * Facts this mapping relies on, contract-verified against `opencode 1.18.x`:
 *
 * - Frames are `{ type, sessionID?, part?, error? }`, and the session id travels
 *   on every frame, so the adapter can capture it from any of them.
 * - Assistant text arrives as a `text` event carrying `part.text` as **one whole
 *   block per provider hop**, never as deltas. This is why the adapter declares
 *   `turn` rather than `incremental`: progress between hops is not observable.
 * - A tool use arrives as `tool_use` naming the tool.
 * - `error` frames carry a structured error; a non-empty one means the turn
 *   failed.
 *
 * The adapter is deliberately honest about the limit this imposes: with
 * `opencode`, Sprout cannot show tool output or partial text mid-run, so the run
 * is quiet until the hop finishes and then reports. That satisfies the M1 policy
 * (final text may arrive whole) but is a real observability regression relative
 * to the other three engines, and it is recorded as fog rather than hidden.
 */

export interface OpenCodeTurnState {
  text: string;
  failure: string | undefined;
  tokenUsage: TokenUsage | undefined;
  detailedTokens: DetailedTokenDimensions | undefined;
}

export function newOpenCodeTurnState(): OpenCodeTurnState {
  return { text: '', failure: undefined, tokenUsage: undefined, detailedTokens: undefined };
}

export interface OpenCodeOutcome {
  readonly events: readonly AgentRunEvent[];
  readonly finish?: EngineTurnResult;
  readonly ignored?: true;
}

interface OpenCodePart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly state?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly tokens?: unknown;
}

export function mapOpenCodeEvent(raw: unknown, state: OpenCodeTurnState): OpenCodeOutcome {
  if (typeof raw !== 'object' || raw === null) return { events: [], ignored: true };
  const frame = raw as Record<string, unknown>;
  const type = frame['type'];
  if (typeof type !== 'string') return { events: [], ignored: true };

  switch (type) {
    case 'text': {
      const part = frame['part'] as OpenCodePart | undefined;
      const text = typeof part?.text === 'string' ? part.text : '';
      if (text === '') return { events: [] };
      state.text += text;
      // One whole block per hop. Marked final so a caller can tell where a hop's
      // text ended, even though more hops may follow.
      return { events: [{ type: 'message', text, final: true }] };
    }

    case 'tool_use': {
      const part = frame['part'] as OpenCodePart | undefined;
      const name = typeof part?.name === 'string' ? part.name : 'tool';
      return {
        events: [{ type: 'tool-call', name, detail: describeToolUse(part) }],
      };
    }

    case 'step_finish': {
      const part = frame['part'] as OpenCodePart | undefined;
      addOpenCodeUsage(state, part?.['tokens']);
      return { events: [] };
    }

    case 'error': {
      const message = describeError(frame['error']);
      if (message === '') return { events: [], ignored: true };
      state.failure = message;
      return { events: [], finish: {
        status: 'failed',
        message,
        ...(state.tokenUsage !== undefined ? { tokenUsage: state.tokenUsage } : {}),
        ...(state.detailedTokens !== undefined ? { detailedTokens: state.detailedTokens } : {}),
      } };
    }

    default:
      // step_start is framing, not run progress. Other event kinds are ignored.
      return { events: [], ignored: true };
  }
}

function addOpenCodeUsage(state: OpenCodeTurnState, raw: unknown): void {
  if (!isRecord(raw)) return;
  const input = raw['input'];
  const output = raw['output'];
  const reasoning = raw['reasoning'];
  const reportedTotal = raw['total'];
  if (!isTokenCount(input) || !isTokenCount(output) ||
      (reasoning !== undefined && !isTokenCount(reasoning)) ||
      (reportedTotal !== undefined && !isTokenCount(reportedTotal))) return;

  const cache = isRecord(raw['cache']) ? raw['cache'] : undefined;
  const cachedInputTokens = cache && isTokenCount(cache['read']) ? cache['read'] : undefined;
  const cacheWriteInputTokens = cache && isTokenCount(cache['write']) ? cache['write'] : undefined;
  if (cachedInputTokens !== undefined && cachedInputTokens > input) return;

  const inputTokens = input + (cachedInputTokens ?? 0);
  const uncachedInputTokens = cachedInputTokens === undefined ? undefined : input;
  // OpenCode separates visible output and reasoning; normalized output includes
  // both, while reasoning remains a detail within that output total.
  const completionTokens = output + (reasoning ?? 0);
  const totalTokens = reportedTotal ?? inputTokens + completionTokens;
  const nextUsage: TokenUsage = { promptTokens: inputTokens, completionTokens, totalTokens };
  const nextDetailed: DetailedTokenDimensions = {
    inputTokens,
    ...(uncachedInputTokens !== undefined ? { uncachedInputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    outputTokens: completionTokens,
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    totalTokens,
  };

  if (state.tokenUsage === undefined || state.detailedTokens === undefined) {
    state.tokenUsage = nextUsage;
    state.detailedTokens = nextDetailed;
    return;
  }

  const previous = state.detailedTokens;
  const sumReportedDimension = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined || right === undefined ? undefined : left + right;
  const uncached = sumReportedDimension(previous.uncachedInputTokens, nextDetailed.uncachedInputTokens);
  const cached = sumReportedDimension(previous.cachedInputTokens, nextDetailed.cachedInputTokens);
  const cacheWrite = sumReportedDimension(previous.cacheWriteInputTokens, nextDetailed.cacheWriteInputTokens);
  const reasoningOutput = sumReportedDimension(previous.reasoningOutputTokens, nextDetailed.reasoningOutputTokens);
  state.tokenUsage = {
    promptTokens: state.tokenUsage.promptTokens + nextUsage.promptTokens,
    completionTokens: state.tokenUsage.completionTokens + nextUsage.completionTokens,
    totalTokens: state.tokenUsage.totalTokens + nextUsage.totalTokens,
  };
  state.detailedTokens = {
    inputTokens: (previous.inputTokens ?? 0) + inputTokens,
    ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    outputTokens: (previous.outputTokens ?? 0) + completionTokens,
    ...(reasoningOutput !== undefined ? { reasoningOutputTokens: reasoningOutput } : {}),
    totalTokens: (previous.totalTokens ?? 0) + totalTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Tool invocations carry a name and sometimes a human title. */
function describeToolUse(part: OpenCodePart | undefined): string {
  if (!part) return '';
  if (typeof part.title === 'string' && part.title.trim() !== '') return part.title;
  return '';
}

function describeError(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  const data = typeof record['data'] === 'object' && record['data'] !== null ? (record['data'] as Record<string, unknown>) : undefined;
  for (const candidate of [data?.['message'], record['message'], record['name']]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export type { AgentRunEvent };
