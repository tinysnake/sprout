/**
 * Session-event disposition for the Host Pi runner child.
 *
 * Pure and total: every input maps to an allowlisted disposition and this
 * function never throws. A subscriber that throws inside `session.subscribe`
 * kills the turn before any provider request and the settle-before-reject
 * ordering masks the dead turn as completed, so totality here is the control
 * that keeps model turns observable (regression `7b6f661a`).
 *
 * Only three dispositions reach the parent process: streamed assistant text,
 * sanitized assistant message ends, and the terminal settle — plus tool events
 * gated to the authorized remote workspace tools.
 */

export interface SessionEventDispositionState {
  /** Whether the terminal settle has already been forwarded this turn. */
  readonly settled: boolean;
  /** The only tool names this session may execute. */
  readonly remoteToolNames: readonly string[];
}

export type SessionEventDisposition =
  | { readonly action: 'pi-event'; readonly event: Record<string, unknown> }
  | { readonly action: 'settle' }
  | { readonly action: 'violation' }
  | { readonly action: 'ignore' };

const IGNORE: SessionEventDisposition = { action: 'ignore' };

interface PiContentPart {
  readonly type?: string;
  readonly text?: string;
}

/** Usage numbers only — never cost objects or engine-authored fields. */
export function sanitizeUsage(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const numeric = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const result: Record<string, unknown> = {};
  for (const key of ['input', 'output', 'totalTokens', 'cacheRead', 'cacheWrite', 'reasoning']) {
    const value = numeric(usage[key]);
    if (value !== undefined) result[key] = value;
  }
  if (typeof usage['cost'] === 'object' && usage['cost'] !== null) {
    const cost = usage['cost'] as Record<string, unknown>;
    const costResult: Record<string, number> = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      const value = numeric(cost[key]);
      if (value !== undefined) costResult[key] = value;
    }
    if (Object.keys(costResult).length > 0) result['cost'] = costResult;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Text parts only — images and engine-authored structures never cross. */
export function sanitizeAssistantContent(content: unknown): { type: 'text'; text: string }[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const candidate = part as PiContentPart | undefined;
    return typeof candidate?.text === 'string' && (candidate.type === 'text' || candidate.type === undefined)
      ? [{ type: 'text' as const, text: candidate.text }]
      : [];
  });
}

/** Remote tool arguments may contain host paths or credential-shaped file text. */
export function sanitizeToolArgs(_args: unknown): Record<string, unknown> {
  // The bounded tool name and terminal operation status provide attribution;
  // argument values are unnecessary in durable Run events.
  return {};
}

/** Decide what the runner does with one AgentSession event. Total, no throws. */
export function sessionEventDisposition(event: unknown, state: SessionEventDispositionState): SessionEventDisposition {
  if (typeof event !== 'object' || event === null) return IGNORE;
  const message = event as Record<string, unknown>;
  const type = message['type'];
  if (typeof type !== 'string') return IGNORE;

  switch (type) {
    case 'message_update': {
      const update = message['assistantMessageEvent'] as Record<string, unknown> | undefined;
      if (update?.['type'] === 'text_delta' && typeof update['delta'] === 'string') {
        return {
          action: 'pi-event',
          event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: update['delta'] } },
        };
      }
      return IGNORE;
    }
    case 'message_end': {
      const msg = message['message'] as Record<string, unknown> | undefined;
      if (msg?.['role'] !== 'assistant') return IGNORE;
      const event: Record<string, unknown> = {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: sanitizeAssistantContent(msg['content']),
          ...(msg['stopReason'] === 'error' ? { stopReason: 'error' } : {}),
          ...(sanitizeUsage(msg['usage']) !== undefined ? { usage: sanitizeUsage(msg['usage']) } : {}),
        },
      };
      return { action: 'pi-event', event };
    }
    case 'agent_settled':
      return state.settled ? IGNORE : { action: 'settle' };
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
    case 'bash_execution_update': {
      // Tool events are top-level session events. Only the authorized remote
      // workspace tools may execute; everything else is a control violation,
      // and non-start phases of an authorized call let the turn continue.
      if (typeof message['toolName'] !== 'string' || !state.remoteToolNames.includes(message['toolName'] as string)) {
        return { action: 'violation' };
      }
      if (type === 'tool_execution_start') {
        return {
          action: 'pi-event',
          event: {
            type: 'tool_execution_start',
            toolName: message['toolName'],
            args: sanitizeToolArgs(message['args']),
          },
        };
      }
      return IGNORE;
    }
    default:
      // Session framing (agent_start, message_start, turn framing, queue
      // updates, telemetry, future events) carries no run progress.
      return IGNORE;
  }
}
