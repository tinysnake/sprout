/* Host-run Pi child. It speaks only allowlisted turn events and readiness facts on stdout. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const EXPECTED_PROVIDER_FILES = {
  'provider.ts': '23e1afbbf69aea8404d600c029e94fa915c8fd81b3ab96e17e687365563c7e80',
  'catalog.ts': 'a6467bb8366b9b52462ace44f3ef528c2036fe5bf0eeb69215107b70e135920d',
  'constants.ts': '92fbbba1c4ad0aa96eaf35d407fe76b837bc19bdb9d1f2614cb751ecc5618d89',
  'gateway.ts': 'fcf9c535364ab7b54713bf9079d0419018be639362306d66011e7843646443e8',
};
const self = fileURLToPath(import.meta.url);

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeFailure(stage, code = 'other') {
  line({ kind: 'failure', stage, code });
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isDenied(path, flag) {
  try {
    const fd = openSync(path, flag);
    closeSync(fd);
    return false;
  } catch (error) {
    return ['EPERM', 'EACCES'].includes(error?.code);
  }
}

function sanitizeUsage(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw;
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const result = {};
  for (const key of ['input', 'output', 'totalTokens', 'cacheRead', 'cacheWrite', 'reasoning']) {
    const value = numeric(usage[key]);
    if (value !== undefined) result[key] = value;
  }
  if (typeof usage.cost === 'object' && usage.cost !== null) {
    const cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      const value = numeric(usage.cost[key]);
      if (value !== undefined) cost[key] = value;
    }
    result.cost = cost;
  }
  return result;
}

function sanitizeAssistantContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    typeof part?.text === 'string' && (part.type === 'text' || part.type === undefined)
      ? [{ type: 'text', text: part.text }]
      : [],
  );
}

async function createRuntime(config) {
  const packageVersion = JSON.parse(readFileSync(join(config.packageRoot, 'package.json'), 'utf8')).version;
  if (packageVersion !== '1.0.4') throw Object.assign(new Error(), { stage: 'sdk-version', code: 'unsupported' });
  for (const [name, expected] of Object.entries(EXPECTED_PROVIDER_FILES)) {
    if (fileHash(join(config.providerRoot, name)) !== expected) {
      throw Object.assign(new Error(), { stage: 'provider-source', code: 'unsupported' });
    }
  }

  const sdk = await import(pathToFileURL(join(config.packageRoot, 'dist/index.js')).href);
  const { ReadOnlyAuthStorage } = await import(pathToFileURL(join(config.packageRoot, 'dist/core/auth-storage.js')).href);
  const credentials = new ReadOnlyAuthStorage(config.authPath);
  const modelsPath = existsSync(config.modelsPath) ? config.modelsPath : null;
  const modelsStore = {
    read: async (provider) => {
      if (!existsSync(config.modelsStorePath)) return undefined;
      return JSON.parse(readFileSync(config.modelsStorePath, 'utf8'))[provider];
    },
    write: async () => { throw new Error('read-only-model-store'); },
    delete: async () => { throw new Error('read-only-model-store'); },
  };
  const runtime = await sdk.ModelRuntime.create({
    credentials,
    modelsPath,
    modelsStore,
    allowModelNetwork: false,
  });

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@earendil-works/pi-ai/compat') {
        return {
          url: pathToFileURL(join(dirname(config.packageRoot), 'pi-ai/dist/compat.js')).href,
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  const { createMagpieProvider } = await import(pathToFileURL(join(config.providerRoot, 'provider.ts')).href);
  const provider = createMagpieProvider().provider;
  if (provider.id !== config.provider) throw Object.assign(new Error(), { stage: 'provider-identity', code: 'unsupported' });
  const providerStream = provider.stream;
  provider.stream = (model, context, options) => {
    const declaredTools = new Map();
    for (const message of context.messages) {
      for (const tool of message.toolsRemoved ?? []) declaredTools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) declaredTools.set(tool.name, tool);
    }
    const tools = [...declaredTools.values()];
    const remoteRead = tools.find((tool) => tool.name === 'remote_read');
    const registeredRemoteRead = session?.getAllTools().find((tool) => tool.name === 'remote_read');
    if (config.remoteWorkspace) {
      line({ kind: 'provider-request-facts', facts: {
        modelApi: model.api,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        toolChoice: options?.toolChoice ?? 'auto',
        remoteReadPresent: remoteRead !== undefined,
        ...(remoteRead ? { remoteReadDescription: remoteRead.description, remoteReadParameters: remoteRead.parameters } : {}),
        remoteReadSource: registeredRemoteRead?.sourceInfo?.source ?? 'unknown',
        remoteReadIsBuiltin: registeredRemoteRead?.sourceInfo?.source === 'builtin',
      } });
    }
    return providerStream.call(provider, model, context, options);
  };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false, providers: [config.provider] });

  const model = runtime.getModel(config.provider, config.model);
  const modelPresent = model?.provider === config.provider && model?.id === config.model;
  const authConfigured = runtime.hasConfiguredAuth(config.provider);
  return { sdk, runtime, model: modelPresent ? model : undefined, modelPresent, authConfigured, packageVersion };
}

function emptyLoader(sdk, config) {
  const runtime = sdk.createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => config.instructions ?? '',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function probe(config) {
  let stage = 'sdk-import';
  try {
    const loaded = await createRuntime(config);
    stage = 'session-controls';
    let controlFacts = { catalogEmpty: false, callableCatalogEmpty: false, discoveryEmpty: false };
    if (loaded.model !== undefined) {
      const loader = emptyLoader(loaded.sdk, config);
      const { session } = await loaded.sdk.createAgentSession({
        cwd: config.agentRoot,
        agentDir: config.agentRoot,
        modelRuntime: loaded.runtime,
        model: loaded.model,
        thinkingLevel: 'off',
        noTools: 'all',
        tools: [],
        resourceLoader: loader,
        sessionManager: loaded.sdk.SessionManager.inMemory(config.agentRoot),
        settingsManager: loaded.sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      controlFacts = {
        catalogEmpty: session.getActiveToolNames().length === 0,
        callableCatalogEmpty: session.getCallableToolNames().length === 0,
        discoveryEmpty: loader.getAgentsFiles().agentsFiles.length === 0 &&
          loader.getExtensions().extensions.length === 0 && loader.getSkills().skills.length === 0 &&
          loader.getPrompts().prompts.length === 0,
      };
      session.dispose();
    }
    const facts = {
      installed: loaded.packageVersion === '1.0.4',
      authenticated: loaded.authConfigured,
      modelAvailable: loaded.modelPresent,
      modelIdentityExact: loaded.modelPresent,
      controlsReady: controlFacts.catalogEmpty && controlFacts.callableCatalogEmpty && controlFacts.discoveryEmpty &&
        isDenied(config.sentinelPath, 'r') && isDenied(config.sentinelPath, 'r+') && isDenied(config.authPath, 'r+'),
      authWriteDenied: isDenied(config.authPath, 'r+'),
      ...controlFacts,
      probedAt: Date.now(),
    };
    line({ kind: 'probe', facts });
  } catch (error) {
    safeFailure(error?.stage ?? stage, error?.code ?? 'other');
  }
}

async function openSession(config, input) {
  let stage = 'runtime-open';
  let session;
  const remotePending = new Map();
  let remoteCallSequence = 0;
  const remoteCall = (operation, args) => new Promise((resolve) => {
    const callId = `${config.sessionId}-${++remoteCallSequence}`;
    remotePending.set(callId, resolve);
    line({ kind: 'remote-call', callId, operation, args });
  });
  try {
    const loaded = await createRuntime(config);
    if (!loaded.modelPresent || !loaded.authConfigured || loaded.model === undefined) {
      line({ kind: 'failure', stage: 'model-readiness', code: 'not-ready' });
      return;
    }
    const sessionDir = config.sessionDirectory;
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const sessionPath = loaded.sdk.SessionManager.findById(config.agentRoot, config.sessionId, sessionDir);
    if (config.resumeSessionKey !== undefined && sessionPath === undefined) {
      line({ kind: 'failure', stage: 'resume', code: 'resume-refused' });
      return;
    }
    const manager = sessionPath === undefined
      ? loaded.sdk.SessionManager.create(config.agentRoot, sessionDir, { id: config.sessionId })
      : loaded.sdk.SessionManager.open(sessionPath, sessionDir, config.agentRoot);
    const remoteAvailable = typeof config.remoteWorkspace?.binding?.projectId === 'string';
    const customTools = remoteAvailable ? [
      {
        name: 'remote_read', label: 'Read remote file', description: 'Read a bounded text file from the authorized remote Project workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async (_id, args) => {
          const result = await remoteCall('read', args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: result.status !== 'completed' };
        },
      },
      {
        name: 'remote_search', label: 'Search remote files', description: 'Search bounded text files in the authorized remote Project workspace.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'], additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async (_id, args) => {
          const result = await remoteCall('search', args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: result.status !== 'completed' };
        },
      },
    ] : [];
    const remoteToolNames = customTools.map((tool) => tool.name);
    const loader = emptyLoader(loaded.sdk, config);
    stage = 'session-create';
    ({ session } = await loaded.sdk.createAgentSession({
      cwd: config.agentRoot,
      agentDir: config.agentRoot,
      modelRuntime: loaded.runtime,
      model: loaded.model,
      thinkingLevel: config.effort,
      noTools: remoteAvailable ? 'builtin' : 'all',
      tools: remoteToolNames,
      customTools,
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager: loaded.sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
    const selected = session.model;
    if (selected?.provider !== config.provider || selected?.id !== config.model ||
        JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify(remoteToolNames.slice().sort()) ||
        JSON.stringify(session.getCallableToolNames().sort()) !== JSON.stringify(remoteToolNames.slice().sort())) {
      line({ kind: 'failure', stage: 'session-controls', code: 'control-violation' });
      session.dispose();
      return;
    }

    let settled = false;
    session.subscribe((event) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent;
        if (update?.type === 'text_delta' && typeof update.delta === 'string') {
          line({ kind: 'pi-event', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: update.delta } } });
        }
        return;
      }
      if (event.type === 'message_end') {
        const message = event.message;
        if (message?.role === 'assistant') {
          line({ kind: 'pi-event', event: { type: 'message_end', message: {
            role: 'assistant',
            content: sanitizeAssistantContent(message.content),
            ...(message.stopReason === 'error' ? { stopReason: 'error' } : {}),
            ...(sanitizeUsage(message.usage) !== undefined ? { usage: sanitizeUsage(message.usage) } : {}),
          } } });
        }
        return;
      }
      if (event.type === 'agent_settled' && !settled) {
        settled = true;
        line({ kind: 'pi-event', event: { type: 'agent_settled' } });
        return;
      }
      if (update?.type === 'tool_execution_start') {
        if (!remoteToolNames.includes(update.toolName)) {
          session.abort();
          line({ kind: 'failure', stage: 'session-controls', code: 'control-violation' });
        }
        return;
      }
      if (event.type === 'tool_execution_start' || event.type === 'bash_execution_update') {
        session.abort();
        line({ kind: 'failure', stage: 'session-controls', code: 'control-violation' });
      }
    });
    line({ kind: 'ready', sessionId: config.sessionId });

    input.on('line', async (raw) => {
      let command;
      try { command = JSON.parse(raw); } catch { return; }
      if (command?.op === 'remote-result' && typeof command.callId === 'string') {
        const resolve = remotePending.get(command.callId);
        if (resolve) { remotePending.delete(command.callId); resolve(command.result); }
        return;
      }
      if (command?.op === 'prompt' && !settled && typeof command.prompt === 'string') {
        stage = 'turn';
        try {
          await session.prompt(command.prompt, { expandPromptTemplates: false, source: 'rpc' });
        } catch (error) {
          const code = error?.code === 'ENOENT' ? 'missing' : 'other';
          line({ kind: 'failure', stage, code });
        }
        return;
      }
      if (command?.op === 'abort') {
        session.abort();
        return;
      }
      if (command?.op === 'close') {
        session.dispose();
        input.close();
      }
    });
    input.on('close', () => { session?.dispose(); process.exit(0); });
  } catch (error) {
    session?.dispose();
    safeFailure(error?.stage ?? stage, error?.code ?? 'other');
  }
}

const input = createInterface({ input: process.stdin });
let firstLine = true;
input.on('line', async (raw) => {
  if (!firstLine) return;
  firstLine = false;
  let config;
  try { config = JSON.parse(raw); } catch { safeFailure('request', 'invalid'); input.close(); return; }
  if (config?.op === 'probe') {
    await probe(config);
    input.close();
  } else if (config?.op === 'open') {
    await openSession(config, input);
  } else {
    safeFailure('request', 'invalid');
    input.close();
  }
});
