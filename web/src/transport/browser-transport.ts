/**
 * Same-origin browser transport for typed M2 adapters.
 *
 * It deliberately keeps no command queue. A command that cannot reach Sprout
 * rejects immediately; callers may show stale data, but may not replay a
 * control action after reconnect.
 */

export type BrowserConnectionState = 'online' | 'reconnecting' | 'stale' | 'offline';
export type BrowserTransportStatus = 'loading' | BrowserConnectionState;

export interface BrowserTransportState {
  readonly status: BrowserTransportStatus;
  readonly connection: BrowserConnectionState;
  readonly loading: boolean;
}

export type RequestFailureKind = 'authentication-required' | 'forbidden' | 'rejected' | 'unavailable';

/** Safe, typed request failure. Raw response bodies and network errors stay private. */
export class BrowserRequestError extends Error {
  readonly kind: RequestFailureKind;
  readonly status?: number;

  constructor(kind: RequestFailureKind, status?: number) {
    super(
      kind === 'authentication-required'
        ? 'operator authentication is required'
        : kind === 'forbidden'
          ? 'operator authority is required for this action'
          : 'request could not be completed',
    );
    this.name = 'BrowserRequestError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface BrowserEvent {
  readonly type: string;
  readonly data: unknown;
  readonly cursor?: string;
}

export interface BrowserEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface BrowserTransportOptions {
  readonly fetch?: typeof fetch;
  readonly eventSource?: (url: string) => BrowserEventSource;
  readonly staleAfterMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface BrowserTransport {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  setCsrfToken(token: string | undefined): void;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  events(listener: (event: BrowserEvent) => void): () => void;
}

export function createBrowserTransport(options: BrowserTransportOptions = {}): BrowserTransport {
  const requestFetch = options.fetch ?? globalThis.fetch;
  const makeEventSource = options.eventSource ?? ((url: string) => new EventSource(url));
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const listeners = new Set<(state: BrowserTransportState) => void>();
  let connection: BrowserConnectionState = navigatorOnline() ? 'online' : 'offline';
  let inFlightRequests = 0;
  let csrfToken: string | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;

  function snapshot(): BrowserTransportState {
    const loading = inFlightRequests > 0;
    return { status: loading ? 'loading' : connection, connection, loading };
  }

  function publish(): void {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }

  function setConnection(next: BrowserConnectionState): void {
    if (connection === next) return;
    connection = next;
    publish();
  }

  function resetStaleTimer(): void {
    if (staleTimer !== undefined) clearTimer(staleTimer);
    staleTimer = setTimer(() => setConnection('stale'), staleAfterMs);
  }

  return {
    state: snapshot,
    subscribeState(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    setCsrfToken(token) {
      csrfToken = token;
    },
    async request<T>(path: string, init: RequestInit = {}) {
      // This is intentionally per-request state, not a retained command. The
      // `init` is consumed once by fetch and is never stored after it settles.
      inFlightRequests += 1;
      publish();
      try {
        const headers = new Headers(init.headers);
        if (!safeMethod(init.method) && csrfToken !== undefined) headers.set('x-sprout-csrf', csrfToken);
        const response = await requestFetch(path, { ...init, headers, credentials: 'same-origin' });
        if (!response.ok) throw responseFailure(response.status);
        setConnection('online');
        return await response.json() as T;
      } catch (error) {
        if (error instanceof BrowserRequestError) {
          // HTTP reached Sprout, even if this session is no longer authorized.
          setConnection('online');
          throw error;
        }
        setConnection(navigatorOnline() ? 'offline' : 'offline');
        throw new BrowserRequestError('unavailable');
      } finally {
        inFlightRequests -= 1;
        publish();
      }
    },
    events(listener) {
      if (!navigatorOnline()) setConnection('offline');
      else setConnection('reconnecting');
      const source = makeEventSource('/api/events');
      let closed = false;
      // A durable cursor is stable across an API restart. Keep it for this
      // EventSource lifetime so a replay cannot publish an already-observed
      // durable run snapshot to its adapter again.
      const receivedDurableCursors = new Set<string>();
      const received = (event: MessageEvent<string>, type: string) => {
        if (closed) return;
        resetStaleTimer();
        setConnection('online');
        try {
          if (type === 'run' && event.lastEventId) {
            if (receivedDurableCursors.has(event.lastEventId)) return;
            receivedDurableCursors.add(event.lastEventId);
          }
          listener({ type, data: JSON.parse(event.data), ...(event.lastEventId ? { cursor: event.lastEventId } : {}) });
        } catch {
          // Malformed transport data is not passed to a domain adapter.
        }
      };
      source.onopen = () => {
        resetStaleTimer();
        setConnection('online');
      };
      source.onerror = () => {
        if (!closed) setConnection(navigatorOnline() ? 'reconnecting' : 'offline');
      };
      source.addEventListener('run', (event: MessageEvent<string>) => received(event, 'run'));
      source.onmessage = (event: MessageEvent<string>) => received(event, 'message');
      return () => {
        closed = true;
        if (staleTimer !== undefined) clearTimer(staleTimer);
        source.close();
      };
    },
  };
}

function safeMethod(method: string | undefined): boolean {
  return method === undefined || method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function responseFailure(status: number): BrowserRequestError {
  if (status === 401) return new BrowserRequestError('authentication-required', status);
  if (status === 403) return new BrowserRequestError('forbidden', status);
  return new BrowserRequestError('rejected', status);
}

function navigatorOnline(): boolean {
  // Node-based adapter tests have a Navigator shim but no browser window. A
  // missing browser surface is not evidence that Sprout is offline.
  return typeof window === 'undefined' || navigator.onLine;
}
