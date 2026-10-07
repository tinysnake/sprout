import type { OperatorSettings, WebDiagnostic } from '../../../src/operations/contract.ts';
import type { BrowserTransport } from '../transport/browser-transport.ts';
/** Exports typed facts only; the transport owns cookies and live/stale state. */
export function createOperatorBrowserAdapter(transport: BrowserTransport) {
  return {
    state: () => transport.state(),
    settings: (): Promise<OperatorSettings> => transport.request('/api/operator/settings'),
    exportDiagnostics: (): Promise<WebDiagnostic> => transport.request('/api/operator/diagnostics'),
  };
}
