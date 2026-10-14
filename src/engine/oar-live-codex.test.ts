import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultRuntimes } from '@botiverse/oar';

import { OarEngineAdapter } from './oar.ts';
import {
  createRuntime,
  hostConfiguration,
  INSTANCE_ID,
  PROJECT_ID,
  scriptedEnvironment,
} from '../runtime-test-harness.ts';
import {
  connectWorkerEnrollment,
  loadOrCreateWorkerIdentity,
  workerPublicKey,
} from '../worker/enrollment-connector.ts';
import { EnvironmentWorker } from '../worker/server.ts';
import {
  createEnvironmentWorkerEngines,
  describeEnvironmentWorkerEngines,
  lookupCommand,
  type EngineHostFacts,
} from '../worker/engine-selection.ts';
import { probeEnvironmentReadiness } from '../worker/readiness.ts';
import { waitFor } from '../runtime-test-harness.ts';

async function listenOnReservedPort(runtime: any): Promise<number> {
  let lastError: unknown;
  for (let port = 46510; port <= 46519; port += 1) {
    try {
      return (await runtime.api.listen(port, '127.0.0.1')).port;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('No port in the reserved 46510–46519 block was available', { cause: lastError });
}

function withOarOptIn<T>(selection: 'codex' | 'pi' | 'all', action: () => T): T {
  const previous = process.env['SPROUT_USE_OAR_ENGINE'];
  process.env['SPROUT_USE_OAR_ENGINE'] = selection;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env['SPROUT_USE_OAR_ENGINE'];
    else process.env['SPROUT_USE_OAR_ENGINE'] = previous;
  }
}

async function liveCodexModel(installation: any, cwd: string): Promise<string> {
  const nativeSession = await defaultRuntimes.require('codex').session(installation, { cwd });
  try {
    const model = nativeSession.model?.().value;
    assert.ok(typeof model === 'string' && model.length > 0, 'OAR reports the configured live Codex model');
    return model;
  } finally {
    await nativeSession.dispose();
  }
}

test('AC8: Production Worker selects the shared OAR Codex adapter through the pre-rollout opt-in', () => {
  const facts: EngineHostFacts = {
    configuration: {
      environmentPlatform: 'host',
      engineBinaries: { codex: '/synthetic/bin/codex' },
      piSessionDirectory: undefined,
    },
    platform: 'darwin',
    locate: () => '/synthetic/bin/codex',
  };

  const codex = withOarOptIn('codex', () => createEnvironmentWorkerEngines(facts).get('codex'));
  assert.ok(codex instanceof OarEngineAdapter);
  assert.equal(codex.id, 'codex');
});

test('AC2: Live Codex Message continuation through an authenticated enrolled Worker', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('This live evidence currently runs on macOS only');
    return;
  }

  const codexRuntime = defaultRuntimes.require('codex');
  let installation: any;
  try {
    installation = await codexRuntime.installation?.();
  } catch {
    t.skip('Codex installation probe failed');
    return;
  }
  if (installation?.kind !== 'available') {
    t.skip('Codex executable is not available on this host');
    return;
  }
  assert.ok(installation.version, 'OAR reports the installed Codex CLI version');
  const liveModel = await liveCodexModel(installation, process.cwd());
  const effort = 'low';
  const directory = mkdtempSync(join(tmpdir(), 'sprout-oar-codex-enrolled-'));
  const instanceId = 'codex-enrolled-live-worker';
  const instructionMarker = 'PROJECT_RULE_MARKER';
  const rules = [
    `Follow the Project rule ${instructionMarker}. On the first request, remember VIOLET and reply only PONG.`,
    'On a later request asking what word was remembered, reply only with that word.',
    'Do not use tools.',
  ];
  const collaborationInstructions = 'Follow the Project reply rule for the current request.';
  const runtimeConfiguration = hostConfiguration({
    environmentSource: 'enrollment',
    executionMode: 'environment-hosted',
    databasePath: join(directory, 'runtime.db'),
    workingDirectory: directory,
    engineId: 'codex',
    runtimeConfiguration: {
      agents: [{
        id: 'scout', name: 'Live Codex Agent', engine: 'codex', capability: 'agent-run',
        model: liveModel, effort,
        workOptions: [{ id: 'codex-live', engine: 'codex', workModel: liveModel, effort }],
      }],
      project: {
        id: PROJECT_ID,
        goal: 'Continue one native Codex conversation through the enrolled Worker.',
        rules,
        availableEnvironmentInstanceIds: [instanceId],
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions }],
      },
    },
  });
  const createLiveRuntime = () => createRuntime({ configuration: runtimeConfiguration, projectRoot: directory });
  const hostFacts: EngineHostFacts = {
    configuration: { environmentPlatform: 'macos', piSessionDirectory: undefined, engineBinaries: {} },
    platform: process.platform,
    locate: (command, options) => lookupCommand(command, process.platform, options.preferWindowsExecutable),
  };
  const engineConfigurations = describeEnvironmentWorkerEngines(hostFacts)
    .filter(configuration => configuration.engine === 'codex');
  assert.equal(engineConfigurations[0]?.engine === 'codex' ? engineConfigurations[0].sandbox : undefined, 'read-only',
    'the current host sandbox selection remains read-only');
  const adapter = withOarOptIn('codex', () => createEnvironmentWorkerEngines(hostFacts).get('codex'));
  assert.ok(adapter instanceof OarEngineAdapter, 'the production Worker selection is OAR Codex');
  const engines = new Map([['codex', adapter]]);
  const startRequests: Array<{ readonly model: string | undefined; readonly effort: string | undefined; readonly instructions: string | undefined }> = [];
  const actualStartSession = adapter.startSession.bind(adapter);
  adapter.startSession = async request => {
    startRequests.push({ model: request.model, effort: request.effort, instructions: request.instructions });
    return actualStartSession(request);
  };

  let runtime: any;
  let worker: EnvironmentWorker | undefined;
  let connection: any;
  try {
    runtime = await createLiveRuntime();
    await runtime.projectService.create({
      id: PROJECT_ID,
      displayName: 'Live Codex Enrolled Project',
      rules,
      agentMemberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions }],
    });
    const workerPort = await listenOnReservedPort(runtime);
    const identityPath = join(directory, 'worker-identity.pem');
    const identity = loadOrCreateWorkerIdentity(identityPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: instanceId,
      displayName: 'Live Codex Enrolled Worker',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      protocolVersion: '3',
      capabilityRequests: ['agent-run'],
      engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [liveModel] }],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true },
      modelAuthorizations: { codex: [liveModel] },
    });

    let readiness = await probeEnvironmentReadiness(engineConfigurations);
    const measuredCodex = readiness.readiness.engines.find(fact => fact.engine === 'codex');
    assert.equal(measuredCodex?.installed, true);
    assert.equal(measuredCodex?.authenticated, true);
    assert.equal(measuredCodex?.modelAvailability, 'unknown',
      'measured account readiness keeps entitlement unknown beside explicit Human model authorization');

    const connectWorker = async () => {
      connection = await connectWorkerEnrollment({
        target: {
          enrollmentId: enrollment.enrollment.id,
          host: '127.0.0.1',
          port: workerPort,
          claimSecret: undefined,
          identityKeyPath: identityPath,
        },
        protocolVersion: '3',
        engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [liveModel] }],
      });
      worker = new EnvironmentWorker({
        environmentInstanceId: instanceId,
        engines,
        input: connection.stream,
        output: connection.stream,
        workspaceRoot: directory,
        readiness: () => readiness.readiness,
        readinessProbe: async params => {
          readiness = await probeEnvironmentReadiness(engineConfigurations, {
            ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),
          });
          return readiness;
        },
      });
    };

    await connectWorker();
    await waitFor(async () => (await runtime.enrollments.readiness(enrollment.enrollment.id)).receipt !== undefined,
      'Codex enrolled Worker readiness receipt');
    assert.equal(startRequests.length, 0, 'readiness and the authenticated connection caused no model session');

    const admissionDeadline = Date.now() + 20_000;
    let admission: any;
    do {
      await runtime.refreshEnvironmentCatalog();
      admission = await runtime.orchestrator.evaluateOptionAdmission('scout', instanceId);
      if (admission.ok) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < admissionDeadline);
    assert.ok(admission?.ok, `Codex admission refused: ${admission?.reason}`);

    mkdirSync(join(directory, 'candidate-project'));
    const projectAccess = await runtime.projectAccess.grant({
      projectId: PROJECT_ID,
      environmentInstanceId: instanceId,
      selection: { kind: 'relative', path: 'candidate-project' },
    });
    assert.equal(projectAccess.status, 'active');
    assert.deepEqual(runtime.projects.get(PROJECT_ID)?.availableEnvironmentInstanceIds, [instanceId]);
    assert.ok(runtime.workerGateway.liveFor(instanceId), 'the authenticated Worker is connected at Message admission');
    const first = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout Remember the word VIOLET. Reply with only PONG.',
      deliveryKey: 'live-codex-enrolled-first',
      awaitReply: true,
    });
    assert.equal(first.admittedRunIds.length, 1);
    const firstRun = await runtime.orchestrator.waitFor(first.admittedRunIds[0]!);
    assert.equal(firstRun.status, 'completed', firstRun.failure ?? firstRun.result?.message ?? 'Codex run did not complete');
    assert.equal(firstRun.result?.status, 'completed');
    assert.match(firstRun.result?.status === 'completed' ? firstRun.result.text : '', /PONG/i);
    assert.equal(firstRun.result?.source, 'oar');
    assert.ok(firstRun.result?.tokenUsage?.promptTokens && firstRun.result.tokenUsage.promptTokens > 0);
    assert.ok(firstRun.result?.tokenUsage?.completionTokens && firstRun.result.tokenUsage.completionTokens > 0);
    assert.ok(firstRun.events.some((event: { readonly type: string; readonly final?: boolean }) => event.type === 'message' && !event.final),
      'real incremental progress was delivered before the final reply');
    assert.equal(startRequests[0]?.model, liveModel);
    assert.equal(startRequests[0]?.effort, effort);
    assert.ok(startRequests[0]?.instructions?.includes(instructionMarker), 'Project instructions reached the model session');
    const firstKeys = await runtime.stores.sessionKeys.list();
    assert.equal(firstKeys.length, 1);
    assert.equal(firstKeys[0]?.scope.kind, 'conversation');
    assert.equal(firstKeys[0]?.scope.id, `channel-${PROJECT_ID}`);
    const firstUsage = await runtime.usage.getRunUsage(firstRun.id);
    assert.equal(firstUsage?.effectiveObservation?.source, 'oar');
    assert.equal(firstUsage?.effectiveObservation?.sourceVersion, '0.59.1');
    assert.equal(firstUsage?.effectiveObservation?.completeness, 'complete');

    const continued = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout What word did I ask you to remember? Reply with only that word.',
      deliveryKey: 'live-codex-enrolled-continuation',
      awaitReply: true,
    });
    assert.equal(continued.admittedRunIds.length, 1);
    const continuedRun = await runtime.orchestrator.waitFor(continued.admittedRunIds[0]!);
    assert.equal(continuedRun.status, 'completed');
    assert.match(continuedRun.result?.status === 'completed' ? continuedRun.result.text : '', /VIOLET/i);
    assert.equal(startRequests.length, 2);
    assert.equal(startRequests[1]?.model, liveModel);
    assert.equal(startRequests[1]?.effort, effort);
    assert.ok(startRequests[1]?.instructions?.includes(instructionMarker));
    assert.equal((await runtime.stores.sessionKeys.list())[0]?.key, firstKeys[0]?.key,
      'continuation reused the native key scoped to the same Project conversation');
    assert.equal((await runtime.collaboration.listMessages()).filter((message: { readonly author: { readonly kind: string }; readonly inReplyTo?: string }) =>
      message.author.kind === 'agent' && message.inReplyTo === continued.message.id).length, 1);

    await worker?.shutdown();
    worker = undefined;
    connection.close();
    connection = undefined;
    await connectWorker();
    await waitFor(async () => (await runtime.enrollments.readiness(enrollment.enrollment.id)).receipt !== undefined,
      'Codex Worker reconnect readiness receipt');
    assert.equal(startRequests.length, 2, 'Worker reconnect and readiness probes did not start inference');
  } finally {
    await worker?.shutdown();
    connection?.close();
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC2 supplemental: Bounded live Codex continuation on the direct Runtime harness', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const codexRuntime = defaultRuntimes.require('codex');
  let installation: any;
  try {
    installation = await codexRuntime.installation?.();
  } catch {
    t.skip('Codex installation probe failed');
    return;
  }

  if (installation?.kind !== 'available') {
    t.skip('Codex executable is not available on this host');
    return;
  }
  assert.ok(installation.version, 'Codex CLI reports version');
  assert.match(installation.version ?? '', /\b\d+\.\d+/, 'Codex CLI reports version');

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'read-only',
  });

  const directory = mkdtempSync(join(tmpdir(), 'sprout-oar-codex-live-'));
  const databasePath = join(directory, 'runtime.db');
  const runtimeConfiguration = hostConfiguration({
    databasePath,
    workingDirectory: directory,
    engineId: 'codex',
    runtimeConfiguration: {
      agents: [{ id: 'scout', name: 'Live Codex Agent', engine: 'codex', capability: 'agent-run' }],
      project: {
        id: PROJECT_ID,
        goal: 'Continue the same native Codex conversation after runtime restart.',
        rules: [],
        availableEnvironmentInstanceIds: [INSTANCE_ID],
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
      },
    },
  });
  const createLiveRuntime = () => createRuntime({
    configuration: runtimeConfiguration,
    projectRoot: directory,
    environment: scriptedEnvironment({ adapters: new Map([['codex', adapter]]) }),
  });
  let runtime = await createLiveRuntime();

  try {
    const delivered = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout Remember the word VIOLET. Reply with only the word PONG.',
      deliveryKey: `live-codex-admission-${Date.now()}`,
      awaitReply: true,
    });

    assert.equal(delivered.duplicate, false);
    assert.equal(delivered.admittedRunIds.length, 1);

    const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
    assert.equal(run.status, 'completed', 'Admitted run settled as completed');
    assert.equal(run.result?.status, 'completed', 'Turn result completed');
    assert.match(run.result?.status === 'completed' ? run.result.text : '', /PONG/i, 'Terminal answer contains PONG');
    assert.equal(run.result?.source, 'oar', 'Result source is oar');
    assert.ok(
      run.result?.tokenUsage && run.result.tokenUsage.promptTokens > 0,
      'Truthful prompt tokens recorded',
    );
    assert.ok(
      run.result?.tokenUsage && run.result.tokenUsage.completionTokens > 0,
      'Truthful completion tokens recorded',
    );

    // Verify exactly one reply was projected back to the scope
    const messages = await runtime.collaboration.listMessages();
    const projected = messages.filter(
      (m) => m.author.kind === 'agent' && m.inReplyTo === delivered.message.id,
    );
    assert.equal(projected.length, 1, 'Exactly one reply was projected from the root turn');
    assert.equal(projected[0]?.author.id, 'scout');
    assert.match(projected[0]?.body ?? '', /PONG/i);

    const persistedFirst = await runtime.stores.runs.get(run.id);
    assert.equal(persistedFirst?.result?.status, 'completed');
    const savedKeysBeforeRestart = await runtime.stores.sessionKeys.list();
    assert.equal(savedKeysBeforeRestart.length, 1);
    assert.equal(savedKeysBeforeRestart[0]?.scope.kind, 'conversation');
    assert.equal(savedKeysBeforeRestart[0]?.scope.id, `channel-${PROJECT_ID}`);

    await runtime.close();
    runtime = await createLiveRuntime();

    const continued = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout What word did I ask you to remember? Reply with only that word.',
      deliveryKey: `live-codex-continuation-${Date.now()}`,
      awaitReply: true,
    });
    assert.equal(continued.duplicate, false);
    assert.equal(continued.admittedRunIds.length, 1);
    const continuedRun = await runtime.orchestrator.waitFor(continued.admittedRunIds[0]!);
    assert.equal(continuedRun.status, 'completed');
    assert.equal(continuedRun.result?.status, 'completed');
    assert.match(continuedRun.result?.status === 'completed' ? continuedRun.result.text : '', /VIOLET/i,
      'the second model-issued run recalls a fact supplied only in the first native conversation');
    const continuedTokens = continuedRun.result?.tokenUsage;
    if (continuedTokens === undefined) {
      assert.equal(continuedRun.result?.detailedTokens, undefined,
        'a resumed turn without a verified usage baseline remains unavailable');
    } else {
      assert.ok(continuedTokens.promptTokens > 0);
      assert.ok(continuedTokens.completionTokens > 0);
    }
    const continuedMessages = await runtime.collaboration.listMessages();
    const continuedReply = continuedMessages.filter(
      (m) => m.author.kind === 'agent' && m.inReplyTo === continued.message.id,
    );
    assert.equal(continuedReply.length, 1);
    assert.match(continuedReply[0]?.body ?? '', /VIOLET/i);
    const persistedContinued = await runtime.stores.runs.get(continuedRun.id);
    assert.equal(persistedContinued?.result?.status, 'completed');
    assert.match(persistedContinued?.result?.status === 'completed' ? persistedContinued.result.text : '', /VIOLET/i);
    assert.deepEqual(persistedContinued?.result?.tokenUsage, continuedRun.result?.tokenUsage,
      'the persisted usage view matches the completed run result');
    const savedKeysAfterRestart = await runtime.stores.sessionKeys.list();
    assert.equal(savedKeysAfterRestart.length, 1);
    assert.equal(savedKeysAfterRestart[0]?.key, savedKeysBeforeRestart[0]?.key,
      'the durable native key survives runtime/database reopen in its authorized conversation scope');
    const usageView = await runtime.usage.getRunUsage(continuedRun.id);
    assert.ok(usageView, 'the live runtime exposes a persisted usage view for this run');
    const usageObservation = usageView.effectiveObservation;
    assert.equal(usageObservation?.completeness, continuedTokens === undefined ? 'unavailable' : 'complete');
    assert.equal(usageObservation?.source, 'oar');
    assert.equal(usageObservation?.sourceVersion, '0.59.1');
    assert.deepEqual(usageObservation?.tokens, continuedRun.result?.detailedTokens);

    const interruption = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout Write 300 numbered lines, each containing only ALPHA, and do not stop early.',
      deliveryKey: `live-codex-interruption-${Date.now()}`,
      awaitReply: false,
    });
    assert.equal(interruption.admittedRunIds.length, 1);
    const interruptionRunId = interruption.admittedRunIds[0]!;
    let observedProgress = false;
    let liveRun = await runtime.orchestrator.load(interruptionRunId);
    const progressDeadline = Date.now() + 30_000;
    while (Date.now() < progressDeadline) {
      liveRun = await runtime.orchestrator.load(interruptionRunId);
      observedProgress = liveRun?.events.some((event) => event.type === 'message') === true;
      if (observedProgress || liveRun?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(liveRun?.status, 'running', 'the live model was still producing the admitted turn');
    assert.equal(observedProgress, true, 'the real model emitted progress before interruption');
    const interruptedRun = await runtime.orchestrator.interrupt(interruptionRunId);
    assert.equal(interruptedRun.status, 'interrupted');
    assert.equal(interruptedRun.result?.status, 'interrupted');
    const interruptionLease = runtime.pool.getLease(interruptedRun.leaseId!);
    assert.equal(interruptionLease?.state,
      interruptedRun.result?.outcomeCertainty === 'uncertain' || interruptedRun.result?.engineSessionTermination === 'uncertain'
        ? 'recovering' : 'released',
      'the live run lease is protected exactly when settlement or execution termination is uncertain');
    assert.equal((await runtime.collaboration.listMessages()).filter((message) =>
      message.author.kind === 'agent' && message.inReplyTo === interruption.message.id).length, 0,
    'the interrupted live model turn does not project a reply');

    await t.test(
      continuedTokens === undefined
        ? 'resumed usage view is unavailable because no verified baseline was available'
        : 'resumed usage view is complete with verified per-run usage',
      () => {},
    );
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC8 & AC4 (F4): Bounded live macOS Codex execution discovers and invokes controlled MCP workspace tool through OAR', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const codexRuntime = defaultRuntimes.require('codex');
  let installation: any;
  try {
    installation = await codexRuntime.installation?.();
  } catch {
    t.skip('Codex installation probe failed');
    return;
  }
  if (installation?.kind !== 'available') {
    t.skip('Codex executable is not available on this host');
    return;
  }

  let readInvoked = false;
  let invokedPath = '';

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    // Adapter conformance uses a reachable MCP channel; the production host selection remains read-only.
    sandbox: 'danger-full-access',
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: process.cwd(),
    remoteWorkspace: {
      binding: {
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
      },
      bindingFence: {
        generation: 1,
        isCurrent: () => true,
      },
      operations: ['read'],
      read: async (path: string) => {
        readInvoked = true;
        invokedPath = path;
        return {
          operationId: 'op-live-mcp',
          projectId: 'live-proj',
          environmentInstanceId: 'live-env',
          bindingId: 'live-bind',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'live-ws',
          operation: 'read',
          status: 'completed',
          content: 'ALPHA_LIVE_VERIFIED_CONTENT',
        };
      },
      search: async () => ({
        operationId: 'op-live-search',
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  try {
    const turn = session.run('Please read file "probe-target.txt" using the read tool from sprout_workspace and report its content.');
    const result = await turn.completion;

    assert.equal(result.status, 'completed', 'Turn settled as completed');
    assert.equal(readInvoked, true, 'Real Codex discovered and called remote MCP read tool');
    assert.match(invokedPath, /probe-target\.txt/, 'Read tool received correct target path');
    assert.match(result.text, /ALPHA_LIVE_VERIFIED_CONTENT/, 'Result reflects content returned by MCP tool');
  } finally {
    await session.close();
  }
});

test('AC8 & AC4 (F4): Bounded live macOS Codex execution enforces binding-fence refusal when capability is no longer current', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const codexRuntime = defaultRuntimes.require('codex');
  let installation: any;
  try {
    installation = await codexRuntime.installation?.();
  } catch {
    t.skip('Codex installation probe failed');
    return;
  }
  if (installation?.kind !== 'available') {
    t.skip('Codex executable is not available on this host');
    return;
  }

  let readInvoked = false;

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'read-only',
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: process.cwd(),
    remoteWorkspace: {
      binding: {
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
      },
      // Binding fence is closed/stale: capability is no longer current!
      bindingFence: {
        generation: 1,
        isCurrent: () => false,
      },
      operations: ['read'],
      read: async () => {
        readInvoked = true;
        return {
          operationId: 'op-stale',
          projectId: 'live-proj',
          environmentInstanceId: 'live-env',
          bindingId: 'live-bind',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'live-ws',
          operation: 'read',
          status: 'completed',
          content: 'SHOULD_NOT_BE_REACHED',
        };
      },
      search: async () => ({
        operationId: 'op-stale-search',
        projectId: 'live-proj',
        environmentInstanceId: 'live-env',
        bindingId: 'live-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  try {
    const turn = session.run('Please read file "fence-test.txt" using the read tool from sprout_workspace.');
    const result = await turn.completion;

    assert.equal(result.status, 'completed', 'Turn settled as completed');
    assert.equal(readInvoked, false, 'Underlying read operation must not be reached when binding fence is closed');
    assert.match(
      result.text,
      /no longer available|couldn’t read|could not read|unavailable/i,
      'Codex informs user of capability unavailability',
    );
  } finally {
    await session.close();
  }
});
