#!/usr/bin/env node
/**
 * Throwaway protocol probe: can one Pi session discover, use, and replace MCP
 * tools after startup while preserving an environment-change context record?
 *
 * Usage: node scripts/probe-host-run-mcp-switch.mjs --pi-sdk <installed-package-directory>
 * Uses two local stdio fixtures, isolated config, and an in-memory session.
 * Makes no model request. Does not prove remote authorization or sandboxing.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const fixtureIndex = process.argv.indexOf('--fixture');
if (fixtureIndex !== -1) {
  const environment = process.argv[fixtureIndex + 1];
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: `fixture-${environment}`, version: '1.0.0' },
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: [{
          name: 'workspace_info',
          description: `Return the identity of fixture Environment ${environment}.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }] };
        break;
      case 'tools/call':
        assert.equal(request.params.name, 'workspace_info');
        result = { content: [{ type: 'text', text: JSON.stringify({ environment }) }] };
        break;
      default:
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Fixture method not supported' } })}\n`);
        continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
} else {
  const sdkIndex = process.argv.indexOf('--pi-sdk');
  if (sdkIndex === -1 || !process.argv[sdkIndex + 1]) {
    throw new Error('Usage: --pi-sdk <installed-package-directory>');
  }
  const sdkDirectory = resolve(process.argv[sdkIndex + 1]);
  const { version } = JSON.parse(await readFile(join(sdkDirectory, 'package.json'), 'utf8'));
  const {
    createAgentSession, createMcpExtension, DefaultResourceLoader,
    SessionManager, SettingsManager,
  } = await import(pathToFileURL(join(sdkDirectory, 'dist/index.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'sprout-mcp-switch-probe-'));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  let api;
  let session;
  const fixturePath = fileURLToPath(import.meta.url);
  const registered = new Set();
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
      systemPrompt: 'Protocol probe. Environment bindings are explicit and versioned.',
      extensionFactories: [createMcpExtension(), (pi) => { api = pi; }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: root, agentDir, resourceLoader: loader, settingsManager,
      noTools: 'builtin', sessionManager: SessionManager.inMemory(root),
    }));
    await session.bindExtensions({});
    assert.deepEqual(session.getActiveToolNames(), []);
    console.log(`Pi SDK ${version}: session started with no work tools.`);

    async function attach(environment, revision) {
      const name = `environment_${environment.toLowerCase()}_r${revision}`;
      registered.add(name);
      api.registerMcpServer(name, {
        command: process.execPath,
        args: [fixturePath, '--fixture', environment],
        cwd: root, exposure: 'direct', timeout: 5000,
      });
      const deadline = Date.now() + 10000;
      while (!session.getActiveToolNames().some((tool) => tool.includes(name))) {
        assert.ok(Date.now() < deadline, `MCP ${environment} discovery timed out`);
        await delay(25);
      }
      const tool = session.agent.state.tools.find((tool) => tool.name.includes(name));
      assert.ok(tool, 'Discovered tool must be in the actual Agent tool loadout');
      const result = await tool.execute(`probe-${revision}`, {}, new AbortController().signal);
      assert.notEqual(result.isError, true);
      const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('');
      assert.equal(JSON.parse(text).environment, environment);
      console.log(`Revision ${revision}: discovered and called ${environment}'s workspace_info.`);
      return name;
    }

    const a = await attach('A', 1);
    await session.sendCustomMessage({
      customType: 'sprout-environment-change', display: true,
      content: 'Binding revision 1: Environment A is current. Its workspace facts are scoped to A.',
      details: { environment: 'A', bindingRevision: 1 },
    }, { triggerTurn: false });
    const historyLength = session.messages.length;

    // No operation is in flight in this probe. Production must reconcile it first.
    api.unregisterMcpServer(a);
    registered.delete(a);
    const deadline = Date.now() + 5000;
    while (session.getActiveToolNames().some((tool) => tool.includes(a))) {
      assert.ok(Date.now() < deadline, 'Old tool withdrawal timed out');
      await delay(25);
    }
    await attach('B', 2);
    assert.ok(!session.agent.state.tools.some((tool) => tool.name.includes(a)));
    await session.sendCustomMessage({
      customType: 'sprout-environment-change', display: true,
      content: 'Binding revision 2: A is detached and B is current. A tools are unavailable. Recheck paths and build/editor state on B before continuing.',
      details: { previousEnvironment: 'A', environment: 'B', bindingRevision: 2 },
    }, { triggerTurn: false });
    assert.ok(session.messages.length > historyLength);
    assert.equal(session.messages.filter((message) => message.customType === 'sprout-environment-change').length, 2);
    console.log('Old tools withdrawn; new tools callable; both context records preserved.');
    console.log('PASS: live Pi registration/withdrawal and stdio tool calls; no model inference.');
  } finally {
    for (const name of registered) api?.unregisterMcpServer(name);
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
