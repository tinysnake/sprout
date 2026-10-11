import type { OperatorSettings, WebDiagnostic } from '../../../../../src/operations/contract.ts';
import type { BrowserSessionView } from '../../../adapters/operator-session-api.ts';
import type { BrowserTransportState } from '../../../transport/browser-transport.ts';
import type { SettingsService } from '../ports.ts';

export interface FixtureSettingsOptions {
  settings?: OperatorSettings;
  sessions?: BrowserSessionView[];
  diagnostic?: WebDiagnostic;
  state?: BrowserTransportState;
  onRevokeSession?: (id: string) => Promise<void>;
  onRevokeOtherSessions?: () => Promise<number>;
  onExportDiagnostics?: () => Promise<WebDiagnostic>;
}

export class FixtureSettingsService implements SettingsService {
  private _state: BrowserTransportState;
  private _settings: OperatorSettings;
  private _sessions: BrowserSessionView[];
  private _diagnostic: WebDiagnostic;
  private readonly _listeners: Set<(state: BrowserTransportState) => void>;
  private readonly _options: FixtureSettingsOptions;

  constructor(options: FixtureSettingsOptions = {}) {
    this._options = options;
    this._listeners = new Set();
    this._state = options.state ?? {
      status: 'online',
      connection: 'online',
      loading: false,
    };
    this._settings = options.settings ?? {
      versions: {
        sprout: '0.2.0-m2',
        web: '0.2.0-m2',
        worker: '0.2.0-m2',
        workerProtocol: { minMajor: 2, maxMajor: 2 },
      },
      executionMode: 'environment-hosted',
      session: { authenticated: true, activeCount: 2 },
      access: {
        boundary: 'private-network-and-authentication',
        publicInternetSupported: false,
      },
      responsibilities: {
        web: ['sessions', 'enrollment', 'recovery', 'diagnostics'],
        hostLocal: ['credentials', 'engine-login', 'service', 'network', 'backup', 'upgrade'],
      },
    };
    this._sessions = options.sessions ?? [
      {
        id: 'sess-current',
        createdAt: Date.now() - 3600_000,
        lastSeenAt: Date.now() - 60_000,
        absoluteExpiresAt: Date.now() + 86400_000 * 30,
        idleExpiresAt: Date.now() + 3600_000 * 12,
        current: true,
      },
      {
        id: 'sess-phone',
        createdAt: Date.now() - 7200_000,
        lastSeenAt: Date.now() - 720_000,
        absoluteExpiresAt: Date.now() + 86400_000 * 30,
        idleExpiresAt: Date.now() + 3600_000 * 11,
        current: false,
      },
    ];
    this._diagnostic = options.diagnostic ?? {
      format: 1,
      scope: 'web',
      versions: this._settings.versions,
      schema: 24,
      service: 'running',
      data: 'accessible',
      environments: [
        {
          subject: 'env-hash-1',
          enrollment: 'approved',
          connection: 'online',
          compatibility: 'compatible',
          worker: 'connected',
          reachability: 'reachable',
          engines: [{ engine: 'codex', readiness: 'ready' }, { engine: 'pi', readiness: 'ready' }],
          workSafety: 'clear',
        },
      ],
      events: [
        { sequence: 1, subject: 'evt-1', kind: 'startup', state: 'ready', at: Date.now() - 10000 },
        { sequence: 2, subject: 'evt-2', kind: 'migration', state: 'migrated', at: Date.now() - 9000 },
      ],
    };
  }

  state(): BrowserTransportState {
    return this._state;
  }

  setState(next: BrowserTransportState): void {
    this._state = next;
    for (const listener of this._listeners) {
      listener(next);
    }
  }

  subscribeState(listener: (state: BrowserTransportState) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  async loadSettings(): Promise<OperatorSettings> {
    return {
      ...this._settings,
      session: {
        ...this._settings.session,
        activeCount: this._sessions.length,
      },
    };
  }

  async loadSessions(): Promise<readonly BrowserSessionView[]> {
    return [...this._sessions];
  }

  async loadDiagnostics(): Promise<WebDiagnostic> {
    return this._diagnostic;
  }

  async revokeSession(id: string): Promise<void> {
    if (this._options.onRevokeSession) {
      await this._options.onRevokeSession(id);
      return;
    }
    this._sessions = this._sessions.filter((s) => s.id !== id);
  }

  async revokeOtherSessions(): Promise<number> {
    if (this._options.onRevokeOtherSessions) {
      return this._options.onRevokeOtherSessions();
    }
    const revoked = this._sessions.filter((s) => !s.current).length;
    this._sessions = this._sessions.filter((s) => s.current);
    return revoked;
  }

  async exportDiagnostics(): Promise<WebDiagnostic> {
    if (this._options.onExportDiagnostics) {
      return this._options.onExportDiagnostics();
    }
    return this._diagnostic;
  }
}
