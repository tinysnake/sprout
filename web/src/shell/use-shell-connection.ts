/**
 * One shell-wide connection state, read from either a page-supplied transport or
 * the browser-level fallback.
 *
 * Pages that own a #85 transport provide it, so the Shell reports exactly what
 * the transport observed. Pages that own nothing get the browser-level signal
 * rather than a fabricated `online` or a permanently offline shell.
 */
import { computed, inject, onScopeDispose, ref, type ComputedRef, type InjectionKey } from 'vue';
import {
  createBrowserConnectionSource,
  describeConnection,
  type ConnectionPresentation,
  type ShellConnectionSource,
} from './connection.js';
import type { BrowserTransportState } from '../transport/browser-transport.js';

export const SHELL_CONNECTION_SOURCE: InjectionKey<ShellConnectionSource> =
  Symbol('sprout.shell.connection');

export interface ShellConnection {
  readonly presentation: ComputedRef<ConnectionPresentation>;
  readonly state: ComputedRef<BrowserTransportState>;
}

export function useShellConnection(): ShellConnection {
  const injected = inject(SHELL_CONNECTION_SOURCE, null);
  const source = injected ?? createBrowserConnectionSource();
  const snapshot = ref<BrowserTransportState>(source.state());
  const unsubscribe = source.subscribeState((next) => {
    snapshot.value = next;
  });
  onScopeDispose(unsubscribe);

  return {
    state: computed(() => snapshot.value),
    presentation: computed(() => describeConnection(snapshot.value)),
  };
}
