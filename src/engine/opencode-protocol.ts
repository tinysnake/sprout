import type { AgentRunEvent, EngineTurnResult } from './port.ts';

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
}

export function newOpenCodeTurnState(): OpenCodeTurnState {
  return { text: '', failure: undefined };
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

    case 'error': {
      const message = describeError(frame['error']);
      if (message === '') return { events: [], ignored: true };
      state.failure = message;
      return { events: [], finish: { status: 'failed', message } };
    }

    default:
      // step_start / step_finish are accounting framing for a provider hop; the
      // adapter does not report them as run progress.
      return { events: [], ignored: true };
  }
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
