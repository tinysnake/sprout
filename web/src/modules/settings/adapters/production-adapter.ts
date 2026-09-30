import type { OperatorSettings, WebDiagnostic } from '../../../../../src/operations/contract.ts';
import type { createOperatorBrowserAdapter } from '../../../adapters/operator-api.ts';
import type { BrowserSessionView, OperatorSessionBrowserAdapter } from '../../../adapters/operator-session-api.ts';
import type { BrowserTransport, BrowserTransportState } from '../../../transport/browser-transport.ts';
import type { SettingsService } from '../ports.ts';

export class ProductionSettingsService implements SettingsService {
  private readonly operatorApi: ReturnType<typeof createOperatorBrowserAdapter>;
  private readonly sessionApi: OperatorSessionBrowserAdapter;
  private readonly transport: BrowserTransport;

  constructor(
    operatorApi: ReturnType<typeof createOperatorBrowserAdapter>,
    sessionApi: OperatorSessionBrowserAdapter,
    transport: BrowserTransport,
  ) {
    this.operatorApi = operatorApi;
    this.sessionApi = sessionApi;
    this.transport = transport;
  }

  state(): BrowserTransportState {
    return this.transport.state();
  }

  subscribeState(listener: (state: BrowserTransportState) => void): () => void {
    return this.transport.subscribeState(listener);
  }

  async loadSettings(): Promise<OperatorSettings> {
    return this.operatorApi.settings();
  }

  async loadSessions(): Promise<readonly BrowserSessionView[]> {
    return this.sessionApi.listSessions();
  }

  async loadDiagnostics(): Promise<WebDiagnostic> {
    return this.operatorApi.exportDiagnostics();
  }

  async revokeSession(id: string): Promise<void> {
    return this.sessionApi.revokeSession(id);
  }

  async revokeOtherSessions(): Promise<number> {
    return this.sessionApi.revokeOtherSessions();
  }

  async exportDiagnostics(): Promise<WebDiagnostic> {
    return this.operatorApi.exportDiagnostics();
  }
}
