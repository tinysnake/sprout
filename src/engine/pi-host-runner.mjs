/* Host-run Pi child. It speaks only allowlisted turn events and readiness facts on stdout. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { sessionEventDisposition } from './pi-runner-events.ts';
import { buildProjectMcpTools } from './pi-host-tools.ts';
import { safeErrorCode, safeErrorName, sanitizeStreamError, sanitizedPromptErrorFields } from './pi-error-facts.ts';

const EXPECTED_PROVIDER_FILES = {
  'provider.ts': '23e1afbbf69aea8404d600c029e94fa915c8fd81b3ab96e17e687365563c7e80',
  'catalog.ts': 'a6467bb8366b9b52462ace44f3ef528c2036fe5bf0eeb69215107b70e135920d',
  'constants.ts': '92fbbba1c4ad0aa96eaf35d407fe76b837bc19bdb9d1f2614cb751ecc5618d89',
  'gateway.ts': 'fcf9c535364ab7b54713bf9079d0419018be639362306d66011e7843646443e8',
};
const self = fileURLToPath(import.meta.url);
const SAFE_FAILURE_STAGES = new Set([
  'request', 'sdk-import', 'sdk-version', 'provider-source', 'provider-identity',
  'session-controls', 'runtime-open', 'model-readiness', 'resume', 'session-create', 'turn',
]);
const SAFE_FAILURE_CODES = new Set([
  'invalid', 'other', 'missing', 'unsupported', 'not-ready', 'resume-refused', 'control-violation',
]);

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeFailure(stage, code = 'other') {
  const safeStage = typeof stage === 'string' && SAFE_FAILURE_STAGES.has(stage) ? stage : 'runtime-open';
  const safeCode = typeof code === 'string' && SAFE_FAILURE_CODES.has(code) ? code : 'other';
  line({ kind: 'failure', stage: safeStage, code: safeCode });
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
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false, providers: [config.provider] });

  const model = runtime.getModel(config.provider, config.model);
  const modelPresent = model?.provider === config.provider && model?.id === config.model;
  const authConfigured = runtime.hasConfiguredAuth(config.provider);
  return { sdk, runtime, model: modelPresent ? model : undefined, modelPresent, authConfigured, packageVersion };
}

async function readFetchBody(input, init) {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (init?.body instanceof ArrayBuffer) return new TextDecoder().decode(init.body);
  if (typeof Request !== 'undefined' && input instanceof Request) return input.clone().text();
  return undefined;
}

function summarizeFetchBody(body) {
  if (typeof body !== 'string') return { toolCount: null, toolNames: [], toolChoice: 'unknown', remoteReadPresent: null };
  let request;
  try { request = JSON.parse(body); } catch {
    return { toolCount: null, toolNames: [], toolChoice: 'unknown', remoteReadPresent: null };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { toolCount: null, toolNames: [], toolChoice: 'unknown', remoteReadPresent: null };
  }
  const tools = Array.isArray(request.tools) ? request.tools
    : Array.isArray(request.functions) ? request.functions : [];
  const toolNames = tools.flatMap((tool) => {
    const name = tool?.function?.name ?? tool?.name;
    return typeof name === 'string' ? [name] : [];
  });
  const rawChoice = request.tool_choice;
  let toolChoice = 'unspecified';
  if (typeof rawChoice === 'string' && ['auto', 'none', 'required'].includes(rawChoice)) {
    toolChoice = rawChoice;
  } else if (rawChoice && typeof rawChoice === 'object') {
    const name = rawChoice.function?.name;
    if (rawChoice.type === 'function' && typeof name === 'string') toolChoice = { type: 'function', name };
    else if (['auto', 'none', 'required'].includes(rawChoice.type)) toolChoice = rawChoice.type;
    else toolChoice = 'other';
  }
  return { toolCount: tools.length, toolNames, toolChoice, remoteReadPresent: toolNames.includes('remote_read') };
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
  const turnTelemetry = { streamCalls: 0, streamRejections: [] };
  let rawEventTypes = {};
  const remoteCall = (operation, args) => new Promise((resolve) => {
    const callId = `${config.sessionId}-${++remoteCallSequence}`;
    remotePending.set(callId, resolve);
    line({ kind: 'remote-call', callId, operation, args });
  });
  try {
    const loaded = await createRuntime(config);
    // Provider-boundary probe: count every hand-off to the model transport and
    // capture sanitized rejection identity (name/code/status only).
    for (const method of ["streamSimple", "stream"]) {
      const original = loaded.runtime[method];
      if (typeof original !== "function") continue;
      loaded.runtime[method] = function (...args) {
        turnTelemetry.streamCalls += 1;
        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === "function") {
            return result.then(undefined, (error) => {
              turnTelemetry.streamRejections.push(sanitizeStreamError(error));
              throw error;
            });
          }
          return result;
        } catch (error) {
          turnTelemetry.streamRejections.push(sanitizeStreamError(error));
          throw error;
        }
      };
    }
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
    const remoteMcpTools = buildProjectMcpTools(config.remoteProjectMcp?.tools ?? [], remoteCall);
    const remoteMcpAvailable = remoteMcpTools.length > 0;
    const customTools = [
      ...(remoteAvailable ? [
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
      ] : []),
      ...remoteMcpTools,
    ];
    const remoteToolNames = customTools.map((tool) => tool.name);
    const loader = emptyLoader(loaded.sdk, config);
    stage = 'session-create';
    ({ session } = await loaded.sdk.createAgentSession({
      cwd: config.agentRoot,
      agentDir: config.agentRoot,
      modelRuntime: loaded.runtime,
      model: loaded.model,
      thinkingLevel: config.effort,
      noTools: remoteAvailable || remoteMcpAvailable ? 'builtin' : 'all',
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
      const eventType = typeof event?.type === 'string' ? event.type : 'unknown';
      rawEventTypes[eventType] = (rawEventTypes[eventType] ?? 0) + 1;
      const disposition = sessionEventDisposition(event, { settled, remoteToolNames });
      if (disposition.action === 'settle') {
        settled = true;
        line({ kind: 'pi-event', event: { type: 'agent_settled' } });
      } else if (disposition.action === 'pi-event') {
        line({ kind: 'pi-event', event: disposition.event });
      } else if (disposition.action === 'violation') {
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
        rawEventTypes = {};
        turnTelemetry.streamCalls = 0;
        turnTelemetry.streamRejections.length = 0;
        const turn = { fetchAttempts: 0, promptResolved: false, promptErrorName: undefined, promptErrorCode: undefined };
        const originalFetch = globalThis.fetch;
        const observedFetch = async function (input, init) {
          turn.fetchAttempts += 1;
          if (config.remoteWorkspace) {
            let body;
            try { body = await readFetchBody(input, init); } catch { /* Keep observation failures out of the request path. */ }
            line({ kind: 'provider-request-facts', facts: summarizeFetchBody(body) });
          }
          return originalFetch.call(this, input, init);
        };
        globalThis.fetch = observedFetch;
        try {
          await session.prompt(command.prompt, { expandPromptTemplates: false, source: 'rpc' });
          turn.promptResolved = true;
        } catch (error) {
          Object.assign(turn, sanitizedPromptErrorFields(error));
          const code = error?.code === 'ENOENT' ? 'missing' : 'other';
          line({ kind: 'failure', stage, code });
        } finally {
          if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
          line({ kind: 'turn-facts', facts: {
            promptResolved: turn.promptResolved,
            ...(turn.promptErrorName !== undefined ? { promptErrorName: turn.promptErrorName } : {}),
            ...(turn.promptErrorCode !== undefined ? { promptErrorCode: turn.promptErrorCode } : {}),
            fetchAttempts: turn.fetchAttempts,
            streamCalls: turnTelemetry.streamCalls,
            streamRejections: [...turnTelemetry.streamRejections],
            rawEventTypes: { ...rawEventTypes },
          } });
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
