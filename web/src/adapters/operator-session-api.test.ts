import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOperatorSessionBrowserAdapter } from './operator-session-api.ts';
import type { BrowserTransport } from '../transport/browser-transport.ts';

test('operator session adapter keeps bearer cookies opaque and only supplies CSRF to transport', async () => {
  let csrf: string | undefined;
  const requested: string[] = [];
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: (token) => { csrf = token; },
    async request<T>(path: string): Promise<T> {
      requested.push(path);
      return { csrfToken: 'request-forgery-value' } as T;
    },
    events: () => () => undefined,
  };
  const adapter = createOperatorSessionBrowserAdapter(transport);

  const result = await adapter.signIn('host-supplied-operator-credential');
  assert.equal(result, undefined);
  assert.equal(csrf, 'request-forgery-value');
  assert.deepEqual(requested, ['/api/auth/session']);
  assert.equal(JSON.stringify(adapter).includes('request-forgery-value'), false);
});
