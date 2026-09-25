import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import { createRunApi } from './api.ts';
import { defaultReadFile } from '../runtime.ts';
import { build } from './api-harness.ts';

test('production static serving: /app/ directory path resolves to index.html with 200', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Root</title>')],
    ['/static/app/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
  ]);
  const mockDirs = new Set(['/static/app', '/static/app/']);

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
    const trailingSlash = await fetch(`${base}/app/`);
    assert.equal(trailingSlash.status, 200);
    assert.equal(trailingSlash.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await trailingSlash.text(), '<!doctype html><title>Sprout App</title>');

    const withoutSlash = await fetch(`${base}/app`);
    assert.equal(withoutSlash.status, 200);
    assert.equal(withoutSlash.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await withoutSlash.text(), '<!doctype html><title>Sprout App</title>');
  } finally {
    await api.close();
  }
});

test('production static serving: SPA history-mode deep link resolves to app index with 200', async () => {
  const context = build();
  const appIndexHtml = '<!doctype html><title>Sprout App</title><div id="app"></div>';
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Root</title>')],
    ['/static/app/index.html', Buffer.from(appIndexHtml)],
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
    const deepLink = await fetch(`${base}/app/manage/environments`);
    assert.equal(deepLink.status, 200);
    assert.equal(deepLink.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await deepLink.text(), appIndexHtml);

    // Deep link with trailing slash
    const deepLinkSlash = await fetch(`${base}/app/manage/environments/`);
    assert.equal(deepLinkSlash.status, 200);
    assert.equal(deepLinkSlash.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await deepLinkSlash.text(), appIndexHtml);

    // Other SPA route
    const feedRoute = await fetch(`${base}/app/feed`);
    assert.equal(feedRoute.status, 200);
    assert.equal(feedRoute.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await feedRoute.text(), appIndexHtml);
  } finally {
    await api.close();
  }
});

test('production static serving: missing asset extensions under app mount return 404 and do not fall back', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/app/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
    ['/static/app/assets/app.js', Buffer.from('console.log("app")')],
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
    const missingJs = await fetch(`${base}/app/assets/missing.js`);
    assert.equal(missingJs.status, 404);

    // Missing CSS asset must stay 404
    const missingCss = await fetch(`${base}/app/style.css`);
    assert.equal(missingCss.status, 404);

    // Missing image asset must stay 404
    const missingImg = await fetch(`${base}/app/logo.png`);
    assert.equal(missingImg.status, 404);

    // Existing asset is served with 200 and correct content-type
    const existingJs = await fetch(`${base}/app/assets/app.js`);
    assert.equal(existingJs.status, 200);
    assert.equal(existingJs.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await existingJs.text(), 'console.log("app")');
  } finally {
    await api.close();
  }
});

test('production static serving: genuinely missing paths outside app mount return 404', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Root</title>')],
    ['/static/app/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
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
    // History path outside /app does not trigger app SPA fallback
    const outsideApp = await fetch(`${base}/manage/environments`);
    assert.equal(outsideApp.status, 404);

    const missingRoot = await fetch(`${base}/missing-page`);
    assert.equal(missingRoot.status, 404);

    const missingAsset = await fetch(`${base}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
  } finally {
    await api.close();
  }
});

test('production static serving: directory traversal is refused', async () => {
  const context = build();
  const mockFiles = new Map<string, Buffer>([
    ['/static/index.html', Buffer.from('<!doctype html><title>Root</title>')],
    ['/static/app/index.html', Buffer.from('<!doctype html><title>Sprout App</title>')],
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
    const traversal1 = await fetch(`${base}/app/../secret.txt`);
    assert.equal(traversal1.status, 404);

    const traversal2 = await fetch(`${base}/app/%2e%2e/secret.txt`);
    assert.equal(traversal2.status, 404);

    const traversal3 = await fetch(`${base}/%2e%2e/secret.txt`);
    assert.equal(traversal3.status, 404);
  } finally {
    await api.close();
  }
});

test('production static serving: real filesystem integration with defaultReadFile', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sprout-static-test-'));
  try {
    mkdirSync(join(tempDir, 'app'), { recursive: true });
    mkdirSync(join(tempDir, 'prototype'), { recursive: true });
    mkdirSync(join(tempDir, 'assets'), { recursive: true });

    writeFileSync(join(tempDir, 'index.html'), '<!doctype html><title>Root Landing</title>');
    writeFileSync(join(tempDir, 'app', 'index.html'), '<!doctype html><title>App SPA</title>');
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
      // 1. Directory path /app/ resolves to app/index.html (no EISDIR 500 error)
      const appDir = await fetch(`${base}/app/`);
      assert.equal(appDir.status, 200);
      assert.equal(appDir.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await appDir.text(), '<!doctype html><title>App SPA</title>');

      // 2. Directory path /app without trailing slash resolves to app/index.html
      const appNoSlash = await fetch(`${base}/app`);
      assert.equal(appNoSlash.status, 200);
      assert.equal(appNoSlash.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await appNoSlash.text(), '<!doctype html><title>App SPA</title>');

      // 3. SPA deep-link /app/manage/environments resolves to app/index.html
      const deepLink = await fetch(`${base}/app/manage/environments`);
      assert.equal(deepLink.status, 200);
      assert.equal(deepLink.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await deepLink.text(), '<!doctype html><title>App SPA</title>');

      // 4. Missing asset under app stays 404
      const missingAsset = await fetch(`${base}/app/missing.js`);
      assert.equal(missingAsset.status, 404);

      // 5. Existing asset returns 200 with text/javascript
      const asset = await fetch(`${base}/assets/bundle.js`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(await asset.text(), 'console.log("bundle");');

      // 6. Root path / resolves to root index.html
      const root = await fetch(`${base}/`);
      assert.equal(root.status, 200);
      assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await root.text(), '<!doctype html><title>Root Landing</title>');

      // 7. Directory path /prototype/ resolves to prototype/index.html
      const proto = await fetch(`${base}/prototype/`);
      assert.equal(proto.status, 200);
      assert.equal(proto.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(await proto.text(), '<!doctype html><title>Prototype</title>');
    } finally {
      await api.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
