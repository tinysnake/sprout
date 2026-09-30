import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProductionSettingsService } from './production-adapter.ts';
import type { BrowserTransport, BrowserTransportState } from '../../../transport/browser-transport.ts';
import { createOperatorBrowserAdapter } from '../../../adapters/operator-api.ts';
import { createOperatorSessionBrowserAdapter, type BrowserSessionView } from '../../../adapters/operator-session-api.ts';
import type { OperatorSettings, WebDiagnostic } from '../../../../../src/operations/contract.ts';

function createMockTransport(options?: {
  initialState?: BrowserTransportState;
  onRequest?: (path: string, init?: RequestInit) => Promise<unknown>;
}): BrowserTransport {
  let currentState: BrowserTransportState = options?.initialState ?? {
    status: 'online',
    connection: 'online',
    loading: false,
  };
  const listeners = new Set<(state: BrowserTransportState) => void>();

  return {
    state: () => currentState,
    subscribeState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCsrfToken: () => undefined,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (options?.onRequest) {
        return (await options.onRequest(path, init)) as T;
      }
      throw new Error(`Unhandled path: ${path}`);
    },
    events: () => () => undefined,
  };
}

test('ProductionSettingsService reads settings, sessions, diagnostics and respects transport truthfulness', async () => {
  const requestedPaths: string[] = [];

  const mockSettings: OperatorSettings = {
    versions: {
      sprout: '0.2.0',
      web: '0.2.0',
      worker: '0.2.0',
      workerProtocol: { minMajor: 2, maxMajor: 2 },
    },
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

  const mockSessions: BrowserSessionView[] = [
    {
      id: 'sess-current',
      createdAt: 1000,
      lastSeenAt: 2000,
      absoluteExpiresAt: 3000,
      idleExpiresAt: 2500,
      current: true,
    },
    {
      id: 'sess-other',
      createdAt: 1100,
      lastSeenAt: 1900,
      absoluteExpiresAt: 3000,
      idleExpiresAt: 2400,
      current: false,
    },
  ];

  const mockDiagnostic: WebDiagnostic = {
    format: 1,
    scope: 'web',
    versions: mockSettings.versions,
    schema: 24,
    service: 'running',
    data: 'accessible',
    environments: [],
    events: [
      { sequence: 1, subject: 'hash1', kind: 'startup', state: 'ready', at: 100 },
      { sequence: 2, subject: 'hash2', kind: 'migration', state: 'migrated', at: 110 },
    ],
  };

  const transport = createMockTransport({
    async onRequest(path, init) {
      requestedPaths.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/operator/settings') return mockSettings;
      if (path === '/api/auth/sessions') return { sessions: mockSessions, csrfToken: 'csrf-1' };
      if (path === '/api/operator/diagnostics') return mockDiagnostic;
      if (path === '/api/auth/sessions/sess-other/revoke') return { revoked: true };
      if (path === '/api/auth/sessions/revoke-others') return { revoked: 1 };
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  const operatorApi = createOperatorBrowserAdapter(transport);
  const sessionApi = createOperatorSessionBrowserAdapter(transport);
  const service = new ProductionSettingsService(operatorApi, sessionApi, transport);

  // 1. Verify state matches transport
  assert.deepEqual(service.state(), transport.state());

  // 2. Load settings
  const settings = await service.loadSettings();
  assert.equal(settings.session.authenticated, true);
  assert.equal(settings.session.activeCount, 2);
  assert.deepEqual(settings, mockSettings, 'Adapter preserves only reported authority facts, without compatibility or copy assurances');

  // 3. Load sessions
  const sessions = await service.loadSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.id, 'sess-current');
  assert.equal(sessions[0]?.current, true);

  // 4. Load diagnostics
  const diagnostic = await service.loadDiagnostics();
  assert.equal(diagnostic.format, 1);
  assert.equal(diagnostic.schema, 24);

  // 5. Revoke one session
  await service.revokeSession('sess-other');
  assert.ok(requestedPaths.includes('POST /api/auth/sessions/sess-other/revoke'));

  // 6. Revoke other sessions
  const revokedCount = await service.revokeOtherSessions();
  assert.equal(revokedCount, 1);
  assert.ok(requestedPaths.includes('POST /api/auth/sessions/revoke-others'));

  // 7. Export diagnostics (returns ONLY the sanitized WebDiagnostic contract)
  const exported = await service.exportDiagnostics();
  assert.equal(exported.format, 1);
  assert.equal(exported.scope, 'web');
  assert.equal(JSON.stringify(exported).includes('/Users/'), false);
  assert.equal(JSON.stringify(exported).includes('password'), false);
  assert.equal(JSON.stringify(exported).includes('credential'), false);
});
