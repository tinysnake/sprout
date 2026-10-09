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

import { sanitizeOperatorText } from '../environment/privacy.ts';

export interface SessionEventProgressState {
  readonly lastTextByCallId: Map<string, string>;
  emittedBytes: number;
}

export function createSessionEventProgressState(): SessionEventProgressState {
  return { lastTextByCallId: new Map(), emittedBytes: 0 };
}

export interface SessionEventDispositionState {
  /** Whether the terminal settle has already been forwarded this turn. */
  readonly settled: boolean;
  /** The only tool names this session may execute. */
  readonly remoteToolNames: readonly string[];
  /** Per-turn output budget for sanitized remote command progress. */
  readonly progress?: SessionEventProgressState;
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

const MAX_REMOTE_PROGRESS_EVENT_BYTES = 2_048;
const MAX_REMOTE_PROGRESS_TURN_BYTES = 32 * 1024;
const REMOTE_OPERATION_NAMES = new Set(['read', 'search', 'edit', 'patch', 'command', 'inspect']);
const REMOTE_OPERATION_STATUSES = new Set([
  'completed', 'failed', 'cancelled', 'recovery-required', 'unknown', 'not-found', 'running', 'cancel-requested',
]);

function remoteOperationName(toolName: string): string {
  const operation = toolName.startsWith('remote_') ? toolName.slice('remote_'.length) : '';
  return REMOTE_OPERATION_NAMES.has(operation) ? operation : 'operation';
}

function extractToolText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null) return '';
  const content = (payload as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => {
    if (typeof part !== 'object' || part === null) return [];
    const record = part as Record<string, unknown>;
    return typeof record['text'] === 'string' && (record['type'] === undefined || record['type'] === 'text')
      ? [record['text']]
      : [];
  }).join('');
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function safeProgressEvent(message: Record<string, unknown>, state: SessionEventDispositionState): SessionEventDisposition {
  if (message['toolName'] !== 'remote_command') return IGNORE;
  const partial = extractToolText(message['partialResult']);
  if (partial === '') return IGNORE;
  const callId = typeof message['toolCallId'] === 'string' ? message['toolCallId'] : 'remote_command';
  const progress = state.progress;
  const previous = progress?.lastTextByCallId.get(callId) ?? '';
  const delta = partial.startsWith(previous) ? partial.slice(previous.length) : partial;
  if (progress) {
    if (!progress.lastTextByCallId.has(callId) && progress.lastTextByCallId.size >= 32) {
      const oldest = progress.lastTextByCallId.keys().next().value;
      if (oldest !== undefined) progress.lastTextByCallId.delete(oldest);
    }
    progress.lastTextByCallId.set(callId, partial);
  }
  if (delta === '') return IGNORE;
  const remaining = Math.max(0, MAX_REMOTE_PROGRESS_TURN_BYTES - (progress?.emittedBytes ?? 0));
  if (remaining === 0) return IGNORE;
  const sanitized = sanitizeOperatorText(delta, { fallback: '', maxLength: MAX_REMOTE_PROGRESS_EVENT_BYTES });
  const text = truncateUtf8(sanitized, Math.min(MAX_REMOTE_PROGRESS_EVENT_BYTES, remaining));
  if (text === '') return IGNORE;
  if (progress) progress.emittedBytes += Buffer.byteLength(text, 'utf8');
  return {
    action: 'pi-event',
    event: { type: 'tool_execution_update', toolName: 'remote_command', partialResult: { content: [{ type: 'text', text }], details: {} } },
  };
}

function safeTerminalEvent(message: Record<string, unknown>): SessionEventDisposition {
  const toolName = message['toolName'] as string;
  const operation = remoteOperationName(toolName);
  const result = message['result'];
  const details = typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)['details']
    : undefined;
  const rawDetails = typeof details === 'object' && details !== null ? details as Record<string, unknown> : {};
  const rawOperation = rawDetails['operation'];
  const safeOperation = typeof rawOperation === 'string' && REMOTE_OPERATION_NAMES.has(rawOperation) ? rawOperation : operation;
  const rawStatus = rawDetails['status'];
  const safeStatus = typeof rawStatus === 'string' && REMOTE_OPERATION_STATUSES.has(rawStatus)
    ? rawStatus
    : message['isError'] === true ? 'failed' : 'completed';
  return {
    action: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolName,
      result: {
        content: [{ type: 'text', text: `Remote ${safeOperation} ${safeStatus}.` }],
        details: { operation: safeOperation, status: safeStatus },
      },
      isError: message['isError'] === true,
    },
  };
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
      if (type === 'tool_execution_update') return safeProgressEvent(message, state);
      if (type === 'tool_execution_end') return safeTerminalEvent(message);
      return IGNORE;
    }
    default:
      // Session framing (agent_start, message_start, turn framing, queue
      // updates, telemetry, future events) carries no run progress.
      return IGNORE;
  }
}
