import type { InjectionKey } from 'vue';
import type { OperatorSettings, WebDiagnostic } from '../../../../src/operations/contract.ts';
import type { BrowserTransportState } from '../../transport/browser-transport.ts';
import type { BrowserSessionView } from '../../adapters/operator-session-api.ts';

export type SettingsCategoryTab = 'access' | 'system' | 'data';

export interface SettingsService {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  loadSettings(): Promise<OperatorSettings>;
  loadSessions(): Promise<readonly BrowserSessionView[]>;
  loadDiagnostics(): Promise<WebDiagnostic>;
  revokeSession(id: string): Promise<void>;
  revokeOtherSessions(): Promise<number>;
  exportDiagnostics(): Promise<WebDiagnostic>;
}

export const SETTINGS_SERVICE: InjectionKey<SettingsService> = Symbol('sprout.settings.service');
