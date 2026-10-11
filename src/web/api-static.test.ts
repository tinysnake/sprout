import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import { createRunApi } from './api.ts';
import { defaultReadFile } from '../runtime.ts';
import { build } from './api-harness.ts';

test('production static serving: root path resolves to the app index with 200', async () => {
  const context = build();
  const appIndexHtml = '<!doctype html><title>Sprout App</title><div id="app"></div>';
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from(appIndexHtml)],
    ['/static/prototype/index.html', Buffer.from('<!doctype html><title>Prototype</title>')],
  ]);
  const mockDirs = new Set(['/static', '/static/']);

  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([]),
    staticRoot: '/static',
    readFile: async (path: string) => {
      if (mockDirs.has(path)) {
        const error = new Error(`EISDIR: illegal operation on a directory, read '${path}'`) as NodeJS.ErrnoException;
        error.code = 'EISDIR';
        throw error;
      }
      return mockFiles.get(path);
    },
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await root.text(), appIndexHtml);

    const explicitIndex = await fetch(`${base}/index.html`);
    assert.equal(explicitIndex.status, 200);
    assert.equal(explicitIndex.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await explicitIndex.text(), appIndexHtml);
  } finally {
    await api.close();
  }
});

test('production static serving: SPA history-mode deep link resolves to the app index with 200', async () => {
  const context = build();
  const appIndexHtml = '<!doctype html><title>Sprout App</title><div id="app"></div>';
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from(appIndexHtml)],
    ['/static/prototype/index.html', Buffer.from('<!doctype html><title>Prototype</title>')],
  ]);

  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([]),
    staticRoot: '/static',
    readFile: async (path: string) => mockFiles.get(path),
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Deep link without trailing slash
    const deepLink = await fetch(`${base}/manage/environments`);
    assert.equal(deepLink.status, 200);
    assert.equal(deepLink.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await deepLink.text(), appIndexHtml);

    // Deep link with trailing slash
    const deepLinkSlash = await fetch(`${base}/manage/environments/`);
    assert.equal(deepLinkSlash.status, 200);
    assert.equal(deepLinkSlash.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await deepLinkSlash.text(), appIndexHtml);

    // Other SPA route
    const feedRoute = await fetch(`${base}/feed`);
    assert.equal(feedRoute.status, 200);
    assert.equal(feedRoute.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await feedRoute.text(), appIndexHtml);

    // Legacy pre-root URLs land on the app index; the router redirects them.
    const legacyApp = await fetch(`${base}/app/feed`);
    assert.equal(legacyApp.status, 200);
    assert.equal(await legacyApp.text(), appIndexHtml);
  } finally {
    await api.close();
  }
});

test('production static serving: prototype mount serves its own index and prototype-scoped SPA fallback', async () => {
  const context = build();
  const appIndexHtml = '<!doctype html><title>Sprout App</title><div id="app"></div>';
  const prototypeIndexHtml = '<!doctype html><title>Prototype</title><div id="app"></div>';
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from(appIndexHtml)],
    ['/static/prototype/index.html', Buffer.from(prototypeIndexHtml)],
  ]);

  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([]),
    staticRoot: '/static',
    readFile: async (path: string) => mockFiles.get(path),
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const withoutSlash = await fetch(`${base}/prototype`);
    assert.equal(withoutSlash.status, 200);
    assert.equal(withoutSlash.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await withoutSlash.text(), prototypeIndexHtml);

    const withSlash = await fetch(`${base}/prototype/`);
    assert.equal(withSlash.status, 200);
    assert.equal(withSlash.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await withSlash.text(), prototypeIndexHtml);

    // Unknown paths under the prototype mount stay inside the prototype SPA.
    const deepLink = await fetch(`${base}/prototype/mobile/feed`);
    assert.equal(deepLink.status, 200);
    assert.equal(await deepLink.text(), prototypeIndexHtml);
  } finally {
    await api.close();
  }
});

test('production static serving: missing asset extensions return 404 and do not fall back', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
    ['/static/assets/app.js', Buffer.from('console.log("app")')],
  ]);

  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([]),
    staticRoot: '/static',
    readFile: async (path: string) => mockFiles.get(path),
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Missing JS asset must stay 404, not fallback to index.html
    const missingJs = await fetch(`${base}/assets/missing.js`);
    assert.equal(missingJs.status, 404);

    // Missing CSS asset must stay 404
    const missingCss = await fetch(`${base}/style.css`);
    assert.equal(missingCss.status, 404);

    // Missing image asset must stay 404
    const missingImg = await fetch(`${base}/logo.png`);
    assert.equal(missingImg.status, 404);

    // Missing asset under the prototype mount must stay 404
    const missingProtoAsset = await fetch(`${base}/prototype/theme.css`);
    assert.equal(missingProtoAsset.status, 404);

    // Existing asset is served with 200 and correct content-type
    const existingJs = await fetch(`${base}/assets/app.js`);
    assert.equal(existingJs.status, 200);
    assert.equal(existingJs.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await existingJs.text(), 'console.log("app")');
  } finally {
    await api.close();
  }
});

test('production static serving: unmatched API paths stay JSON 404 and never receive SPA HTML', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
  ]);

  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([]),
    staticRoot: '/static',
    readFile: async (path: string) => mockFiles.get(path),
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const unknownApi = await fetch(`${base}/api/definitely-unknown`);
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.headers.get('content-type'), 'application/json');
    assert.deepEqual(await unknownApi.json(), { error: 'not found' });

    const apiRoot = await fetch(`${base}/api`);
    assert.equal(apiRoot.status, 404);
    assert.equal(apiRoot.headers.get('content-type'), 'application/json');
  } finally {
    await api.close();
  }
});

test('production static serving: directory traversal is refused', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
    ['/secret.txt', Buffer.from('sensitive data')],
  ]);

  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([]),
    staticRoot: '/static',
    readFile: async (path: string) => mockFiles.get(path),
  });

  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const traversal1 = await fetch(`${base}/../secret.txt`);
    assert.equal(traversal1.status, 404);

    const traversal2 = await fetch(`${base}/%2e%2e/secret.txt`);
    assert.equal(traversal2.status, 404);

    const traversal3 = await fetch(`${base}/prototype/%2e%2e/secret.txt`);
    assert.equal(traversal3.status, 404);
  } finally {
    await api.close();
  }
});

test('production static serving: real filesystem integration with defaultReadFile', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sprout-static-test-'));
  try {
    mkdirSync(join(tempDir, 'prototype'), { recursive: true });
    mkdirSync(join(tempDir, 'assets'), { recursive: true });

    writeFileSync(join(tempDir, 'index.html'), '<!doctype html><title>App SPA</title>');
    writeFileSync(join(tempDir, 'prototype', 'index.html'), '<!doctype html><title>Prototype</title>');
    writeFileSync(join(tempDir, 'assets', 'bundle.js'), 'console.log("bundle");');

    const context = build();
    const api = createRunApi({
      orchestrator: context.orchestrator,
      agents: new AgentRegistry([]),
      staticRoot: tempDir,
      readFile: defaultReadFile,
    });

    const { port } = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    try {
      // 1. Root path / resolves to the app index.html (no EISDIR 500 error)
      const root = await fetch(`${base}/`);
      assert.equal(root.status, 200);
      assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await root.text(), '<!doctype html><title>App SPA</title>');

      // 2. SPA deep-link /manage/environments resolves to the app index.html
      const deepLink = await fetch(`${base}/manage/environments`);
      assert.equal(deepLink.status, 200);
      assert.equal(deepLink.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await deepLink.text(), '<!doctype html><title>App SPA</title>');

      // 3. Missing asset stays 404
      const missingAsset = await fetch(`${base}/missing.js`);
      assert.equal(missingAsset.status, 404);

      // 4. Existing asset returns 200 with text/javascript
      const asset = await fetch(`${base}/assets/bundle.js`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(await asset.text(), 'console.log("bundle");');

      // 5. Directory path /prototype and /prototype/ resolve to prototype/index.html
      const protoNoSlash = await fetch(`${base}/prototype`);
      assert.equal(protoNoSlash.status, 200);
      assert.equal(protoNoSlash.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await protoNoSlash.text(), '<!doctype html><title>Prototype</title>');

      const protoSlash = await fetch(`${base}/prototype/`);
      assert.equal(protoSlash.status, 200);
      assert.equal(protoSlash.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await protoSlash.text(), '<!doctype html><title>Prototype</title>');
    } finally {
      await api.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
