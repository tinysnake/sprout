/**
 * Shell connection state.
 *
 * The Shell shows whether the browser is still receiving live facts from
 * Sprout. It consumes the accepted #85 transport state shape through a typed
 * source instead of re-deriving reachability, and it never queues an action:
 * an offline or stale shell disables control rather than replaying it later.
 */
import type { BrowserTransportState } from '../transport/browser-transport.js';

export interface ShellConnectionSource {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
}

/** A source whose published state a caller can drive. */
export interface ShellConnectionController extends ShellConnectionSource {
  set(state: BrowserTransportState): void;
}

export const OFFLINE_CONNECTION: BrowserTransportState = Object.freeze({
  status: 'offline',
  connection: 'offline',
  loading: false,
});

/**
 * A source that reports one state until it is set.
 *
 * The Shell never uses this as a production default; DOM tests use it to drive
 * loading, offline, and reconnecting deliberately.
 */
export function createShellConnectionController(
  initial: BrowserTransportState = OFFLINE_CONNECTION
): ShellConnectionController {
  const listeners = new Set<(state: BrowserTransportState) => void>();
  let current = initial;
  return {
    state: () => current,
    set(next) {
      current = next;
      for (const listener of listeners) listener(current);
    },
    subscribeState(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The browser-level reachability source.
 *
 * It reports the same initial rule the accepted #85 transport uses (a browser
 * that has not yet failed is `online`, a browser with no interface is
 * `offline`) and follows the browser's online/offline events. It never claims
 * that Sprout itself answered; a page that owns a transport passes that
 * transport here instead.
 */
export function createBrowserConnectionSource(): ShellConnectionSource {
  const listeners = new Set<(state: BrowserTransportState) => void>();

  function snapshot(): BrowserTransportState {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const connection = online ? 'online' : 'offline';
    return { status: connection, connection, loading: false };
  }

  return {
    state: snapshot,
    subscribeState(listener) {
      listeners.add(listener);
      listener(snapshot());
      const publish = () => listener(snapshot());
      const target = typeof window === 'undefined' ? undefined : window;
      target?.addEventListener('online', publish);
      target?.addEventListener('offline', publish);
      return () => {
        listeners.delete(listener);
        target?.removeEventListener('online', publish);
        target?.removeEventListener('offline', publish);
      };
    },
  };
}

export type ConnectionStatus = 'green' | 'yellow' | 'red';

export interface ConnectionPresentation {
  readonly status: ConnectionStatus;
  /** Short visible label. */
  readonly label: string;
  /** Screen-reader announcement, including what the state means for control. */
  readonly announce: string;
  /** Control actions are refused while the browser cannot reach Sprout. */
  readonly controlAvailable: boolean;
}

/**
 * Maps the transport state to product language.
 *
 * Every state carries text, so connection status never depends on colour, and
 * loading is distinguished from connected rather than assumed to be one.
 */
export function describeConnection(state: BrowserTransportState): ConnectionPresentation {
  if (state.loading) {
    return {
      status: 'yellow',
      label: 'Checking Connection',
      announce:
        'Checking connection to Sprout. Control actions wait for the check to finish.',
      controlAvailable: false,
    };
  }
  switch (state.connection) {
    case 'online':
      return {
        status: 'green',
        label: 'Operator Online',
        announce: 'Operator online. Live facts and control actions are available.',
        controlAvailable: true,
      };
    case 'reconnecting':
      return {
        status: 'yellow',
        label: 'Reconnecting',
        announce:
          'Reconnecting to Sprout. Shown facts may lag; control actions are unavailable until the connection returns.',
        controlAvailable: false,
      };
    case 'stale':
      return {
        status: 'yellow',
        label: 'Stale Connection',
        announce:
          'Connection is stale. Shown facts may be out of date; control actions are unavailable.',
        controlAvailable: false,
      };
    default:
      return {
        status: 'red',
        label: 'Offline',
        announce:
          'Offline. Shown facts are cached and control actions are unavailable rather than queued.',
        controlAvailable: false,
      };
  }
}
