import type { AgentRunEvent, EngineTurnResult } from './port.ts';

/**
 * Translation from `agy`'s `--output-format stream-json` stream into
 * engine-neutral run events.
 *
 * A pure function over one decoded line and a state object, so it is testable
 * against recorded traffic without invoking the engine. Mappings were confirmed
 * against `agy 1.2.2` on this host:
 *
 * - Frames are `{"event": "init" | "step_update" | "result", ...}`.
 * - `step_update` carries `step_type` of `user_input`, `agent_response`, or
 *   `tool`, with `state` of `ACTIVE` or `DONE`. **All step fields are on the
 *   frame's top level**, not nested under a `step` key.
 * - An `agent_response` step streams its text as `text_delta`.
 * - A `tool` step names `tool_name`; its `tool_info` holds the invocation and,
 *   once `DONE`, an `output` string. There is no incremental tool output.
 * - `result` carries the turn's final `response` and a `status`.
 */

export interface AgyTurnState {
  text: string;
  failure: string | undefined;
}

export function newAgyTurnState(): AgyTurnState {
  return { text: '', failure: undefined };
}

export interface AgyOutcome {
  readonly events: readonly AgentRunEvent[];
  readonly finish?: EngineTurnResult;
  readonly ignored?: true;
}

export function mapAgyEvent(raw: unknown, state: AgyTurnState): AgyOutcome {
  if (typeof raw !== 'object' || raw === null) return { events: [], ignored: true };
  const frame = raw as Record<string, unknown>;
  const event = frame['event'];
  if (typeof event !== 'string') return { events: [], ignored: true };

  switch (event) {
    case 'step_update':
      return mapStepUpdate(frame['step_update'], state);

    case 'result':
      return mapResult(frame['result'], state);

    case 'error': {
      const detail = describe(frame['message'] ?? frame['error']) || 'agy reported an error';
      state.failure = detail;
      return { events: [], finish: { status: 'failed', message: detail } };
    }

    default:
      // `init` is session framing, not run progress.
      return { events: [], ignored: true };
  }
}

function mapStepUpdate(step: unknown, state: AgyTurnState): AgyOutcome {
  if (typeof step !== 'object' || step === null) return { events: [], ignored: true };
  const update = step as Record<string, unknown>;
  const stepType = update['step_type'];
  const lifecycle = update['state'];

  if (stepType === 'agent_response') {
    const delta = typeof update['text_delta'] === 'string' ? update['text_delta'] : '';
    if (delta === '') return { events: [] };
    state.text += delta;
    return { events: [{ type: 'message', text: delta, final: false }] };
  }

  if (stepType === 'tool' && lifecycle === 'ACTIVE') {
    const name = typeof update['tool_name'] === 'string' ? update['tool_name'] : 'tool';
    return {
      events: [{ type: 'tool-call', name, detail: describe(update['tool_info']) }],
    };
  }

  if (stepType === 'tool' && lifecycle === 'DONE') {
    // `tool_info.output` is where agy puts what the tool produced, and there is
    // no incremental form, so output arrives once, when the tool finishes.
    const info = update['tool_info'];
    const nested = typeof info === 'object' && info !== null ? (info as Record<string, unknown>)['output'] : undefined;
    const output = typeof nested === 'string' ? nested : '';
    return output === '' ? { events: [] } : { events: [{ type: 'tool-output', text: output }] };
  }

  return { events: [], ignored: true };
}

function mapResult(result: unknown, state: AgyTurnState): AgyOutcome {
  if (typeof result !== 'object' || result === null) {
    return { events: [], finish: { status: 'failed', message: 'agy produced no result' } };
  }
  const settled = result as Record<string, unknown>;
  const status = typeof settled['status'] === 'string' ? settled['status'] : '';
  const response = typeof settled['response'] === 'string' ? settled['response'] : '';

  if (status !== 'SUCCESS' && status !== '') {
    return {
      events: [],
      finish: { status: 'failed', message: state.failure ?? `agy run did not succeed: ${status}` },
    };
  }
  // The turn's answer is the result frame's `response`, which is authoritative:
  // `text_delta` fragments are its prefix, not a separate answer.
  return { events: [], finish: { status: 'completed', text: response || state.text } };
}

/** Render an agy `tool_info` compactly for display. */
function describe(info: unknown): string {
  if (typeof info === 'string') return info;
  if (typeof info !== 'object' || info === null) return '';
  const record = info as Record<string, unknown>;
  // The command is the meaningful detail for a shell tool; `name` repeats what
  // is already shown, so it is skipped.
  if (typeof record['command'] === 'string') return record['command'];
  const parameters = record['parameters'];
  if (typeof parameters === 'object' && parameters !== null) {
    for (const key of ['CommandLine', 'command', 'commandline']) {
      const value = (parameters as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  try {
    return JSON.stringify(parameters ?? record);
  } catch {
    return '';
  }
}
