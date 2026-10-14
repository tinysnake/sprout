import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultRuntimes } from '@botiverse/oar';

import { OarEngineAdapter } from './oar.ts';
import { type EngineAdapter } from './port.ts';
import {
  createRuntime,
  hostConfiguration,
  project,
  scriptedEnvironment,
  INSTANCE_ID,
  PROJECT_ID,
  waitFor,
} from '../runtime-test-harness.ts';
import {
  loadOrCreateWorkerIdentity,
  workerPublicKey,
  connectWorkerEnrollment,
  WorkerEnrollmentRefusedError,
} from '../worker/enrollment-connector.ts';
import { EnvironmentWorker } from '../worker/server.ts';
import {
  createEnvironmentWorkerEngines,
  describeEnvironmentWorkerEngines,
  lookupCommand,
  type EngineHostFacts,
} from '../worker/engine-selection.ts';
import { probeEnvironmentReadiness } from '../worker/readiness.ts';
import { workerReadinessProbeFixture } from '../worker/readiness-fixture.ts';
import {
  hostPiConfigurationProvider,
  OAR_PI_DISALLOWED_BUILTIN_TOOLS,
} from './oar-runtime-policy.ts';
import {
  CONTENTION_SKIP_MESSAGE,
  attemptLivePiStart,
  startLivePiSession,
} from './oar-live-pi-test-support.ts';
import { redactSensitiveText } from '../environment/privacy.ts';
import type { WorkerReadinessProbeParams } from '../worker/protocol.ts';

/** Turn a loaded extension path into a stable identifier without exposing its host path. */
function sanitizedExtensionId(resolvedPath: string): string {
  const segments = resolvedPath.split(/[\\/]+/).filter(Boolean);
  const marker = Math.max(...['extensions', 'node_modules', 'packages'].map((name) => segments.lastIndexOf(name)));
  return (marker >= 0 ? segments.slice(marker + 1) : segments.slice(-2)).join('/');
}

async function listenOnReservedPort(runtime: any): Promise<number> {
  let lastError: unknown;
  for (let port = 47600; port <= 47604; port += 1) {
    try {
      return (await runtime.api.listen(port)).port;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('No port in the reserved 47600–47604 block was available', { cause: lastError });
}

async function livePiConfiguration(installation: any, cwd: string): Promise<{
  readonly model: string;
  readonly extensions: readonly string[];
  readonly activeTools: readonly string[];
  readonly registeredTools: readonly string[];
}> {
  const piRuntime = defaultRuntimes.require('pi');
  const nativeSession = await piRuntime.session(installation, { cwd });
  let model: string | undefined;
  try {
    model = nativeSession.model?.().value ?? undefined;
  } finally {
    await nativeSession.dispose();
  }
  assert.ok(typeof model === 'string' && model.length > 0, 'Host Pi provider extension registered a live model');
  const provider = model.slice(0, model.indexOf('/'));
  const sdk = await import('@earendil-works/pi-coding-agent');
  const agentDir = hostPiConfigurationProvider.resolve().agentDir;
  const services = await sdk.createAgentSessionServices({ cwd, agentDir });
  const extensionInventory = services.resourceLoader.getExtensions().extensions
    .map((extension) => sanitizedExtensionId(extension.resolvedPath)).sort();
  assert.ok(services.modelRuntime.getModel(provider, model.slice(model.indexOf('/') + 1)), 'Host Pi provider is registered through the session services');
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    excludeTools: [...OAR_PI_DISALLOWED_BUILTIN_TOOLS],
  });
  try {
    const activeTools = session.getActiveToolNames().sort();
    const registeredTools = session.getAllTools().map((tool) => tool.name).sort();
    const disallowed = new Set<string>(OAR_PI_DISALLOWED_BUILTIN_TOOLS);
    assert.deepEqual(activeTools.filter((name) => disallowed.has(name)), []);
    assert.deepEqual(registeredTools.filter((name) => disallowed.has(name)), [], 'Suppressed built-ins are absent from the Pi tool registry');
    return { model, extensions: extensionInventory, activeTools, registeredTools };
  } finally {
    session.dispose();
  }
}
test('the production Worker selects the shared OAR Pi adapter', () => {
  const facts: EngineHostFacts = {
    configuration: {
      environmentPlatform: 'host',
      engineBinaries: { pi: '/synthetic/bin/pi' },
      piSessionDirectory: undefined,
    },
    platform: 'darwin',
    locate: () => '/synthetic/bin/pi',
  };

  const pi = createEnvironmentWorkerEngines(facts).get('pi');
  assert.ok(pi instanceof OarEngineAdapter);
  assert.equal(pi.id, 'pi');
});

test('AC5 scripted: unsupported Pi session-directory setting blocks admission on a replaced enrolled Worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-pi-storage-message-'));
  const instanceId = 'pi-storage-refusal-worker';
  const model = 'openai-codex/gpt-6.1-sol';
  const sessionDirectory = join(directory, 'legacy-pi-sessions');
  const runtimeConfiguration = hostConfiguration({
    environmentSource: 'enrollment',
    engineId: 'pi',
    executionMode: 'environment-hosted',
    databasePath: join(directory, 'runtime.db'),
    workingDirectory: directory,
    runtimeConfiguration: {
      agents: [{
        id: 'scout', name: 'Pi Storage Agent', engine: 'pi', capability: 'agent-run', model, effort: 'low',
        workOptions: [{ id: 'pi-storage', engine: 'pi', workModel: model, effort: 'low' }],
      }],
      project: {
        ...project(),
        availableEnvironmentInstanceIds: [instanceId],
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
      },
    },
  });
  const readinessFor = (requirements?: WorkerReadinessProbeParams['requirements']) => {
    const requirementRevision = requirements?.revisionsByEngine?.pi;
    return workerReadinessProbeFixture({
      protocolVersion: '3',
      observedAt: Date.now(),
      engines: [{
        engine: 'pi', version: '1.2.0', installed: true, readiness: 'unknown', authenticated: true,
        modelAvailability: 'unknown', models: [], source: 'unsupported-control',
        ...(requirementRevision !== undefined ? { requirementRevision } : {}),
      }],
    }, { version: 'scripted Pi readiness', summary: 'Pi session-directory control is unsupported on the OAR route.' });
  };
  const facts: EngineHostFacts = {
    configuration: {
      environmentPlatform: 'macos',
      piSessionDirectory: sessionDirectory,
      engineBinaries: { pi: '/synthetic/bin/pi' },
    },
    platform: 'darwin',
    locate: () => '/synthetic/bin/pi',
  };
  const adapter = createEnvironmentWorkerEngines(facts).get('pi');
  assert.ok(adapter instanceof OarEngineAdapter);
  let sessionStarts = 0;
  const startSession = adapter.startSession.bind(adapter);
  adapter.startSession = async (request) => {
    sessionStarts += 1;
    return startSession(request);
  };

  let runtime: any;
  const workers: EnvironmentWorker[] = [];
  const connections: Array<{ close(): void; connectionId: string; epoch: number }> = [];
  try {
    runtime = await createRuntime({ configuration: runtimeConfiguration, projectRoot: directory });
    await runtime.projectService.create({
      id: PROJECT_ID,
      displayName: 'Pi Storage Refusal Project',
      rules: [],
      agentMemberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
    });
    const workerPort = await listenOnReservedPort(runtime);
    const identityPath = join(directory, 'worker-identity.pem');
    const identity = loadOrCreateWorkerIdentity(identityPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: instanceId,
      displayName: 'Pi Storage Refusal Worker',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      protocolVersion: '3',
      capabilityRequests: ['agent-run'],
      engineFacts: [{ engine: 'pi', installed: true, authenticated: true, models: [model] }],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true },
      modelAuthorizations: { pi: [model] },
    });

    const currentReadiness = { value: readinessFor() };
    const connectWorker = async () => {
      const connection = await connectWorkerEnrollment({
        target: {
          enrollmentId: enrollment.enrollment.id,
          host: '127.0.0.1',
          port: workerPort,
          claimSecret: undefined,
          identityKeyPath: identityPath,
        },
        protocolVersion: '3',
        engineFacts: [{ engine: 'pi', installed: true, authenticated: true, models: [model] }],
      });
      connections.push(connection);
      const worker = new EnvironmentWorker({
        environmentInstanceId: instanceId,
        engines: new Map([['pi', adapter]]),
        input: connection.stream,
        output: connection.stream,
        workspaceRoot: directory,
        readiness: () => currentReadiness.value.readiness,
        readinessProbe: async (params) => {
          currentReadiness.value = readinessFor(params.requirements);
          return currentReadiness.value;
        },
      });
      workers.push(worker);
      await waitFor(async () =>
        (await runtime.enrollments.readiness(enrollment.enrollment.id)).receipt !== undefined,
      'Pi storage Worker readiness receipt');
      return connection;
    };

    const firstConnection = await connectWorker();
    const firstEpoch = firstConnection.epoch;
    const secondConnection = await connectWorker();
    assert.ok(secondConnection.epoch > firstEpoch, 'a connected Worker replacement advances the enrollment epoch');
    assert.equal(runtime.workerGateway.isCurrentConnection(enrollment.enrollment.id, firstConnection.connectionId), false);
    assert.equal(runtime.workerGateway.isCurrentConnection(enrollment.enrollment.id, secondConnection.connectionId), true);

    mkdirSync(join(directory, 'candidate-project'));
    await runtime.projectAccess.grant({
      projectId: PROJECT_ID,
      environmentInstanceId: instanceId,
      selection: { kind: 'relative', path: 'candidate-project' },
    });
    await runtime.refreshEnvironmentCatalog();
    const delivered = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout start the configured Pi session',
      deliveryKey: 'pi-storage-refusal-admitted-message',
      awaitReply: true,
    });
    assert.equal(delivered.admittedRunIds.length, 0, 'unsupported Worker control blocks before run admission');
    assert.equal(delivered.wakes[0]?.status, 'failed');
    assert.match(delivered.wakes[0]?.detail ?? '', /OAR Pi uses the host Pi session store/);
    assert.equal(sessionStarts, 0, 'the blocked option never starts an OAR session');
    assert.deepEqual(await runtime.stores.sessionKeys.list(), [], 'blocked admission creates no saved session key');

    await runtime.enrollments.revoke(enrollment.enrollment.id, 'scripted live revocation');
    await waitFor(() => runtime.workerGateway.liveFor(instanceId) === undefined, 'revoked Worker disconnect');
    assert.equal(runtime.workerGateway.isCurrentConnection(enrollment.enrollment.id, secondConnection.connectionId), false);
    await assert.rejects(connectWorkerEnrollment({
      target: {
        enrollmentId: enrollment.enrollment.id,
        host: '127.0.0.1',
        port: workerPort,
        claimSecret: undefined,
        identityKeyPath: identityPath,
      },
      protocolVersion: '3',
      engineFacts: [{ engine: 'pi', installed: true, authenticated: true, models: [model] }],
    }), (error: unknown) => error instanceof WorkerEnrollmentRefusedError && error.code === 'revoked',
    'a revoked live enrollment cannot reconnect');
  } finally {
    for (const worker of workers) await worker.shutdown().catch(() => undefined);
    for (const connection of connections) connection.close();
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC2: Bounded live macOS Pi Message-to-reply demonstration through the enrolled path', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const piRuntime = defaultRuntimes.require('pi');
  let installation: any;
  try {
    installation = await piRuntime.installation?.();
  } catch {
    t.skip('Pi installation probe failed');
    return;
  }

  if (installation?.kind !== 'available') {
    t.skip('Pi runtime is not available on this host');
    return;
  }

  const liveHostPi = await livePiConfiguration(installation, process.cwd());
  const liveModel = liveHostPi.model;
  assert.ok(liveHostPi.extensions.length > 0, 'Host Pi extension inventory was loaded');
  assert.ok(liveHostPi.activeTools.length > 0, 'Host extension tools remain active under the empty built-in policy');
  const liveEffort = 'low';

  const directory = mkdtempSync(join(tmpdir(), 'sprout-oar-pi-live-'));
  const instanceId = 'pi-enrolled-live-worker';
  const marker = 'PONG';
  const rules = [
    'On the first request, remember the word VIOLET and reply with only PONG.',
    'On a later request asking what word was remembered, reply with only that word.',
    'Do not use tools.',
  ];
  const collaborationInstructions = 'Follow the Project reply rule for the current request.';

  let projectInstructionsReceived = false;
  let projectModelReceived = false;
  let projectEffortReceived = false;
  let leaseContentionObserved = false;
  let sessionStartCount = 0;

  const piHostFacts: EngineHostFacts = {
    configuration: { environmentPlatform: 'macos', piSessionDirectory: undefined, engineBinaries: {} },
    platform: process.platform,
    locate: (command, options) => lookupCommand(command, process.platform, options.preferWindowsExecutable),
  };
  const realAdapter = createEnvironmentWorkerEngines(piHostFacts).get('pi');
  assert.ok(realAdapter instanceof OarEngineAdapter, 'the enrolled Worker uses the shared OAR selection');
  const observedStart = realAdapter.startSession.bind(realAdapter);

  realAdapter.startSession = async (request) => {
    sessionStartCount += 1;
    projectInstructionsReceived = request.instructions?.includes(marker) === true;
    projectModelReceived = request.model === liveModel;
    projectEffortReceived = request.effort === liveEffort;
    const attempt = await attemptLivePiStart(() => observedStart(request));
    if (attempt.kind === 'contention') {
      leaseContentionObserved = true;
      throw attempt.error;
    }
    return attempt.value;
  };

  const engines = new Map<string, EngineAdapter>([['pi', realAdapter]]);

  let runtime: any;
  let worker: EnvironmentWorker | undefined;
  let connection: any;
  let current: any;
  const runtimeConfiguration = hostConfiguration({
    environmentSource: 'enrollment',
    engineId: 'pi',
    executionMode: 'environment-hosted',
    databasePath: join(directory, 'runtime.db'),
    workingDirectory: directory,
    runtimeConfiguration: {
      agents: [{
        id: 'scout',
        name: 'Live Pi Agent',
        engine: 'pi',
        capability: 'agent-run',
        model: liveModel,
        effort: liveEffort,
        workOptions: [{ id: 'pi-live-opt', engine: 'pi', workModel: liveModel, effort: liveEffort }],
      }],
      project: {
        ...project(),
        availableEnvironmentInstanceIds: [instanceId],
        rules,
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions }],
      },
    },
  });

  try {
    runtime = await createRuntime({ configuration: runtimeConfiguration, projectRoot: directory });

    await runtime.projectService.create({
      id: PROJECT_ID,
      displayName: 'Live Pi Enrolled Project',
      rules,
      agentMemberships: [{
        agentId: 'scout',
        responsibilities: [],
        collaborationInstructions,
      }],
    });

    const identityPath = join(directory, 'worker-identity.pem');
    const identity = loadOrCreateWorkerIdentity(identityPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: instanceId,
      displayName: 'Live Pi Enrolled Worker',
      publicKey: workerPublicKey(identity.privateKey),
      platform: 'macos',
      protocolVersion: '3',
      capabilityRequests: ['agent-run'],
      engineFacts: [{ engine: 'pi', installed: true, authenticated: true, models: [liveModel] }],
    });

    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true },
      modelAuthorizations: { pi: [liveModel] },
    });

    const workerPort = await listenOnReservedPort(runtime);
    const hostFacts = {
      configuration: {
        environmentPlatform: 'macos' as const,
        piSessionDirectory: undefined,
        engineBinaries: {},
      },
      platform: process.platform,
      locate: (cmd: string, opts: { preferWindowsExecutable: boolean }) =>
        lookupCommand(cmd, process.platform, opts.preferWindowsExecutable),
    };
    const configurations = describeEnvironmentWorkerEngines(hostFacts).filter(
      (c) => c.engine === 'pi',
    );
    current = await probeEnvironmentReadiness(configurations);

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
        engineFacts: [{ engine: 'pi', installed: true, authenticated: true, models: [liveModel] }],
      });

      worker = new EnvironmentWorker({
        environmentInstanceId: instanceId,
        engines,
        input: connection.stream,
        output: connection.stream,
        workspaceRoot: directory,
        readiness: () => current.readiness,
        readinessProbe: async (params) => {
          current = await probeEnvironmentReadiness(configurations, {
            ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),
          });
          return current;
        },
      });
      await waitFor(async () =>
        (await runtime.enrollments.readiness(enrollment.enrollment.id)).receipt !== undefined,
      'Pi enrolled Worker readiness receipt');
    };

    await connectWorker();


    // Evaluate admission
    let decision;
    const admissionDeadline = Date.now() + 20_000;
    do {
      await runtime.refreshEnvironmentCatalog();
      decision = await runtime.orchestrator.evaluateOptionAdmission('scout', instanceId);
      if (decision.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < admissionDeadline);
    assert.ok(decision?.ok, `Admission refused: ${decision?.reason}`);
    assert.equal(sessionStartCount, 0, 'readiness probes and admission did not start a Pi model session');

    // Grant workspace access
    mkdirSync(join(directory, 'candidate-project'));
    await runtime.projectAccess.grant({
      projectId: PROJECT_ID,
      environmentInstanceId: instanceId,
      selection: { kind: 'relative', path: 'candidate-project' },
    });

    const delivered = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: `@scout Remember the word VIOLET. Reply with only ${marker}.`,
      deliveryKey: `live-pi-enrolled-${Date.now()}`,
      awaitReply: true,
    });

    assert.equal(delivered.duplicate, false);
    assert.equal(delivered.admittedRunIds.length, 1);

    const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
    if (leaseContentionObserved) {
      t.skip(CONTENTION_SKIP_MESSAGE);
      return;
    }
    assert.equal(run.status, 'completed', `Admitted run settled as completed: ${run.failure === undefined ? 'no failure detail' : redactSensitiveText(run.failure)}`);
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
    assert.ok(run.result?.detailedTokens !== undefined, 'Detailed tokens recorded');

    // External observation of project settings delivered
    assert.equal(projectInstructionsReceived, true, 'Project instructions delivered to session');
    assert.equal(projectModelReceived, true, 'Project model delivered to session');
    assert.equal(projectEffortReceived, true, 'Project effort delivered to session');

    // Real progress events streamed
    const progressEvents = run.events.filter((e: any) => e.type === 'message' && !e.final);
    assert.ok(progressEvents.length > 0, 'Real incremental progress events streamed during turn');

    // Verify exactly one reply was projected back to the scope
    const messages = await runtime.collaboration.listMessages();
    const projected = messages.filter(
      (m: any) => m.author.kind === 'agent' && m.inReplyTo === delivered.message.id,
    );
    assert.equal(projected.length, 1, 'Exactly one reply was projected from the root turn');
    assert.equal(projected[0]?.author.id, 'scout');
    assert.match(projected[0]?.body ?? '', /PONG/i);

    // Reconcile and assert still exactly one reply
    await runtime.collaboration.reconcile();
    const projectedAfter = (await runtime.collaboration.listMessages()).filter(
      (m: any) => m.author.kind === 'agent' && m.inReplyTo === delivered.message.id,
    );
    assert.equal(projectedAfter.length, 1, 'Still exactly one reply after reconcile');

    // Persisted run record in store matches
    const persisted = await runtime.stores.runs.get(run.id);
    assert.equal(persisted?.result?.status, 'completed');
    assert.match(persisted?.result?.text ?? '', /PONG/i);

    const savedKeysBeforeResume = await runtime.stores.sessionKeys.list();
    assert.equal(savedKeysBeforeResume.length, 1, 'the completed native run persisted one scoped continuation key');
    assert.ok(savedKeysBeforeResume[0]?.key.length > 0);
    assert.equal(savedKeysBeforeResume[0]?.scope.kind, 'conversation');
    assert.equal(savedKeysBeforeResume[0]?.scope.id, `channel-${PROJECT_ID}`);

    const firstUsageView = await runtime.usage.getRunUsage(run.id);
    assert.ok(firstUsageView, 'the live runtime exposes a persisted usage view for the admitted run');
    assert.equal(firstUsageView.effectiveObservation?.completeness, 'complete');
    assert.equal(firstUsageView.effectiveObservation?.source, 'oar');
    assert.equal(firstUsageView.effectiveObservation?.sourceVersion, '0.59.1');
    assert.deepEqual(firstUsageView.effectiveObservation?.tokens, run.result?.detailedTokens);

    assert.equal(sessionStartCount, 1, 'the first admitted Message started one Pi model session');
    await worker?.shutdown();
    worker = undefined;
    connection.close();
    connection = undefined;
    await connectWorker();
    assert.equal(sessionStartCount, 1, 'reconnect and readiness probes did not start inference');

    await runtime.refreshEnvironmentCatalog();
    const continuedAdmission = await runtime.orchestrator.evaluateOptionAdmission('scout', instanceId);
    assert.ok(continuedAdmission.ok, `continued Pi admission refused: ${continuedAdmission.reason}`);
    const continued = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout What word did I ask you to remember? Reply with only that word.',
      deliveryKey: `live-pi-enrolled-continuation-${Date.now()}`,
      awaitReply: true,
    });
    assert.equal(continued.admittedRunIds.length, 1);
    const continuedRun = await runtime.orchestrator.waitFor(continued.admittedRunIds[0]!);
    assert.equal(continuedRun.status, 'completed', continuedRun.failure === undefined
      ? 'continued enrolled Pi run completed'
      : `continued enrolled Pi run failed: ${redactSensitiveText(continuedRun.failure)}`);
    assert.match(continuedRun.result?.status === 'completed' ? continuedRun.result.text : '', /VIOLET/i,
      'the enrolled Worker continued the authorized native conversation after reconnect');
    assert.equal(continuedRun.result?.source, 'oar');
    assert.equal(sessionStartCount, 2, 'the continuation started exactly one new OAR session');
    assert.equal(projectInstructionsReceived, true);
    assert.equal(projectModelReceived, true);
    assert.equal(projectEffortReceived, true);
    const continuedTokens = continuedRun.result?.tokenUsage;
    if (continuedTokens === undefined) {
      assert.equal(continuedRun.result?.detailedTokens, undefined,
        'usage without a verified resumed-session baseline remains unavailable');
    } else {
      assert.ok(continuedTokens.promptTokens > 0);
      assert.ok(continuedTokens.completionTokens > 0);
    }
    const savedKeysAfterResume = await runtime.stores.sessionKeys.list();
    assert.equal(savedKeysAfterResume.length, 1);
    assert.equal(savedKeysAfterResume[0]?.key, savedKeysBeforeResume[0]?.key,
      'the enrolled continuation reused the saved native key for the same Project conversation');
    const continuedUsageView = await runtime.usage.getRunUsage(continuedRun.id);
    assert.ok(continuedUsageView);
    assert.equal(continuedUsageView.effectiveObservation?.completeness,
      continuedTokens === undefined ? 'unavailable' : 'complete');
    assert.equal(continuedUsageView.effectiveObservation?.source, 'oar');
    assert.equal(continuedUsageView.effectiveObservation?.sourceVersion, '0.59.1');

    const interruption = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout Write 300 numbered lines, each containing only ALPHA, and do not stop early.',
      deliveryKey: `live-pi-interruption-${Date.now()}`,
      awaitReply: false,
    });
    assert.equal(interruption.admittedRunIds.length, 1);
    const interruptionRunId = interruption.admittedRunIds[0]!;
    let observedProgress = false;
    let liveRun = await runtime.orchestrator.load(interruptionRunId);
    const progressDeadline = Date.now() + 30_000;
    while (Date.now() < progressDeadline) {
      liveRun = await runtime.orchestrator.load(interruptionRunId);
      observedProgress = liveRun?.events.some((event: any) => event.type === 'message') === true;
      if (observedProgress || liveRun?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(liveRun?.status, 'running', 'the live Pi model was still producing the admitted turn');
    assert.equal(observedProgress, true, 'the real Pi model emitted progress before interruption');
    const interruptedRun = await runtime.orchestrator.interrupt(interruptionRunId);
    assert.equal(interruptedRun.status, 'interrupted');
    assert.equal(interruptedRun.result?.status, 'interrupted');
    assert.equal(sessionStartCount, 3);
    const interruptionLease = runtime.pool.getLease(interruptedRun.leaseId!);
    assert.equal(interruptionLease?.state,
      interruptedRun.result?.outcomeCertainty === 'uncertain' || interruptedRun.result?.engineSessionTermination === 'uncertain'
        ? 'recovering' : 'released',
      'the live Pi run lease is protected exactly when settlement or execution termination is uncertain');
    assert.equal((await runtime.collaboration.listMessages()).filter((message: any) =>
      message.author.kind === 'agent' && message.inReplyTo === interruption.message.id).length, 0,
    'the interrupted live Pi turn does not project a reply');
  } finally {
    await worker?.shutdown();
    connection?.close();
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC2: Bounded live Pi Runtime Message continuation and usage survive SQLite runtime reopen', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const piRuntime = defaultRuntimes.require('pi');
  let installation: any;
  try {
    installation = await piRuntime.installation?.();
  } catch {
    t.skip('Pi installation probe failed');
    return;
  }
  if (installation?.kind !== 'available') {
    t.skip('Pi runtime is not available on this host');
    return;
  }

  const liveModel = (await livePiConfiguration(installation, process.cwd())).model;
  const directory = mkdtempSync(join(tmpdir(), 'sprout-oar-pi-reopen-'));
  const databasePath = join(directory, 'runtime.db');
  const adapter = new OarEngineAdapter({ runtimeId: 'pi' });
  const adapterStart = adapter.startSession.bind(adapter);
  let leaseContentionObserved = false;
  adapter.startSession = async (request) => {
    const attempt = await attemptLivePiStart(() => adapterStart(request));
    if (attempt.kind === 'contention') {
      leaseContentionObserved = true;
      throw attempt.error;
    }
    return attempt.value;
  };
  const collaborationInstructions = 'Follow the Project rule for the current request.';
  const runtimeConfiguration = hostConfiguration({
    databasePath,
    workingDirectory: directory,
    engineId: 'pi',
    runtimeConfiguration: {
      agents: [{
        id: 'scout', name: 'Live Pi Agent', engine: 'pi', capability: 'agent-run',
        model: liveModel, effort: 'low',
        workOptions: [{ id: 'pi-live-reopen', engine: 'pi', workModel: liveModel, effort: 'low' }],
      }],
      project: {
        ...project(),
        id: PROJECT_ID,
        goal: 'Continue the same native Pi conversation after runtime restart.',
        availableEnvironmentInstanceIds: [INSTANCE_ID],
        rules: [
          'On the first request, remember the word VIOLET and reply with only PONG.',
          'On a later request asking what word was remembered, reply with only that word.',
          'Do not use tools.',
        ],
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions }],
      },
    },
  });
  const createLiveRuntime = () => createRuntime({
    configuration: runtimeConfiguration,
    projectRoot: directory,
    environment: scriptedEnvironment({ adapters: new Map([['pi', adapter]]) }),
  });
  let runtime: any;

  try {
    runtime = await createLiveRuntime();
    const firstDelivery = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout Remember the word VIOLET. Reply with only PONG.',
      deliveryKey: `live-pi-reopen-first-${Date.now()}`,
      awaitReply: true,
    });
    assert.equal(firstDelivery.admittedRunIds.length, 1);
    const firstRun = await runtime.orchestrator.waitFor(firstDelivery.admittedRunIds[0]!);
    if (leaseContentionObserved) {
      t.skip(CONTENTION_SKIP_MESSAGE);
      return;
    }
    assert.equal(firstRun.status, 'completed');
    assert.match(firstRun.result?.status === 'completed' ? firstRun.result.text : '', /PONG/i);
    assert.equal(firstRun.result?.source, 'oar');
    assert.ok(firstRun.result?.tokenUsage?.promptTokens && firstRun.result.tokenUsage.promptTokens > 0);
    assert.ok(firstRun.result?.tokenUsage?.completionTokens && firstRun.result.tokenUsage.completionTokens > 0);
    const firstKeys = await runtime.stores.sessionKeys.list();
    assert.equal(firstKeys.length, 1);
    assert.equal(firstKeys[0]?.scope.kind, 'conversation');
    assert.equal(firstKeys[0]?.scope.id, `channel-${PROJECT_ID}`);

    await runtime.close();
    runtime = await createLiveRuntime();
    const reopenedKeys = await runtime.stores.sessionKeys.list();
    assert.equal(reopenedKeys.length, 1);
    assert.equal(reopenedKeys[0]?.key, firstKeys[0]?.key,
      'the native Pi session key survives SQLite runtime reopen in the authorized conversation scope');

    const continuedDelivery = await runtime.collaboration.deliver({
      scopeId: `channel-${PROJECT_ID}`,
      author: { id: 'operator', kind: 'human' },
      body: '@scout What word did I ask you to remember? Reply with only that word.',
      deliveryKey: `live-pi-reopen-second-${Date.now()}`,
      awaitReply: true,
    });
    assert.equal(continuedDelivery.admittedRunIds.length, 1);
    const continuedRun = await runtime.orchestrator.waitFor(continuedDelivery.admittedRunIds[0]!);
    if (leaseContentionObserved) {
      t.skip(CONTENTION_SKIP_MESSAGE);
      return;
    }
    assert.equal(continuedRun.status, 'completed', continuedRun.failure === undefined
      ? 'The returning Pi run did not complete.'
      : `The returning Pi run failed: ${redactSensitiveText(continuedRun.failure)}`);
    assert.match(continuedRun.result?.status === 'completed' ? continuedRun.result.text : '', /VIOLET/i,
      'the model recalls the first run fact after the runtime and database were reopened');
    assert.equal(continuedRun.result?.source, 'oar');
    const continuedTokens = continuedRun.result?.tokenUsage;
    if (continuedTokens === undefined) {
      assert.equal(continuedRun.result?.detailedTokens, undefined,
        'usage without a verified resumed-session baseline remains unavailable');
    } else {
      assert.ok(continuedTokens.promptTokens > 0);
      assert.ok(continuedTokens.completionTokens > 0);
    }
    assert.ok(continuedRun.result?.sourceVersion);
    const reply = (await runtime.collaboration.listMessages()).filter(
      (message: any) => message.author.kind === 'agent' && message.inReplyTo === continuedDelivery.message.id,
    );
    assert.equal(reply.length, 1);
    assert.match(reply[0]?.body ?? '', /VIOLET/i);
    const persistedRun = await runtime.stores.runs.get(continuedRun.id);
    assert.equal(persistedRun?.result?.status, 'completed');
    assert.deepEqual(persistedRun?.result?.tokenUsage, continuedRun.result?.tokenUsage);
    const usageView = await runtime.usage.getRunUsage(continuedRun.id);
    assert.ok(usageView);
    assert.equal(usageView.effectiveObservation?.completeness, continuedTokens === undefined ? 'unavailable' : 'complete');
    assert.equal(usageView.effectiveObservation?.source, 'oar');
    assert.equal(usageView.effectiveObservation?.sourceVersion, '0.59.1');
    assert.deepEqual(usageView.effectiveObservation?.tokens, continuedRun.result?.detailedTokens);
    await t.test(
      continuedTokens === undefined
        ? 'resumed usage view is unavailable because no verified baseline was available'
        : 'resumed usage view is complete with verified per-run usage',
      () => {},
    );
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC2 & AC4: Bounded live macOS Pi execution discovers and invokes controlled MCP workspace tool through OAR', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const piRuntime = defaultRuntimes.require('pi');
  let installation: any;
  try {
    installation = await piRuntime.installation?.();
  } catch {
    t.skip('Pi installation probe failed');
    return;
  }
  if (installation?.kind !== 'available') {
    t.skip('Pi runtime is not available on this host');
    return;
  }

  const liveModel = (await livePiConfiguration(installation, process.cwd())).model;
  let readInvoked = false;
  let invokedPath = '';

  const adapter = new OarEngineAdapter({ runtimeId: 'pi' });

  const session = await startLivePiSession(adapter, {
    agentId: 'scout',
    workingDirectory: process.cwd(),
    model: liveModel,
    remoteWorkspace: {
      binding: {
        projectId: 'live-proj-pi',
        environmentInstanceId: 'live-env-pi',
        bindingId: 'live-bind-pi',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws-pi',
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
          operationId: 'op-live-pi-mcp',
          projectId: 'live-proj-pi',
          environmentInstanceId: 'live-env-pi',
          bindingId: 'live-bind-pi',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'live-ws-pi',
          operation: 'read',
          status: 'completed',
          content: 'ALPHA_LIVE_VERIFIED_PI_CONTENT',
        };
      },
      search: async () => ({
        operationId: 'op-live-pi-search',
        projectId: 'live-proj-pi',
        environmentInstanceId: 'live-env-pi',
        bindingId: 'live-bind-pi',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws-pi',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  }, message => t.skip(message));
  if (!session) return;

  try {
    const turn = session.run('Please call the tool mcp__sprout_workspace__read with path "probe-target.txt" and report its content.');
    const observedToolCalls: string[] = [];
    const drain = (async () => {
      try {
        for await (const event of turn.events) {
          if (event.type === 'tool-call') observedToolCalls.push(event.name);
        }
      } catch { /* Completion carries the failure; retain only sanitized tool names. */ }
    })();
    const result = await turn.completion;
    await drain;

    assert.equal(result.status, 'completed', 'Turn settled as completed');
    assert.equal(readInvoked, true, `Real Pi discovered and called remote MCP read tool; observed tool calls: ${observedToolCalls.join(', ') || 'none'}`);
    assert.match(invokedPath, /probe-target\.txt/, 'Read tool received correct target path');
    assert.match(result.text, /ALPHA_LIVE_VERIFIED_PI_CONTENT/, 'Result reflects content returned by MCP tool');
  } finally {
    await session.close();
  }
});

test('AC2 & AC4: Bounded live macOS Pi execution enforces binding-fence refusal when capability is no longer current', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('Live demonstration requires macOS host');
    return;
  }

  const piRuntime = defaultRuntimes.require('pi');
  let installation: any;
  try {
    installation = await piRuntime.installation?.();
  } catch {
    t.skip('Pi installation probe failed');
    return;
  }
  if (installation?.kind !== 'available') {
    t.skip('Pi runtime is not available on this host');
    return;
  }

  const liveModel = (await livePiConfiguration(installation, process.cwd())).model;
  let readInvoked = false;

  const adapter = new OarEngineAdapter({ runtimeId: 'pi' });

  const session = await startLivePiSession(adapter, {
    agentId: 'scout',
    workingDirectory: process.cwd(),
    model: liveModel,
    remoteWorkspace: {
      binding: {
        projectId: 'live-proj-pi-stale',
        environmentInstanceId: 'live-env-pi',
        bindingId: 'live-bind-pi-stale',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws-pi',
      },
      bindingFence: {
        generation: 1,
        // Capability is no longer current
        isCurrent: () => false,
      },
      operations: ['read'],
      read: async () => {
        readInvoked = true;
        return {
          operationId: 'op-stale',
          projectId: 'live-proj-pi-stale',
          environmentInstanceId: 'live-env-pi',
          bindingId: 'live-bind-pi-stale',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'live-ws-pi',
          operation: 'read',
          status: 'completed',
          content: 'MUST_NEVER_BE_READ',
        };
      },
      search: async () => ({
        operationId: 'op-stale-search',
        projectId: 'live-proj-pi-stale',
        environmentInstanceId: 'live-env-pi',
        bindingId: 'live-bind-pi-stale',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'live-ws-pi',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  }, message => t.skip(message));
  if (!session) return;

  try {
    const turn = session.run('Please call the tool mcp__sprout_workspace__read with path "probe-target.txt" and report its content.');
    const result = await turn.completion;

    assert.equal(result.status, 'completed', 'Turn completed (model observed failure and replied)');
    assert.equal(readInvoked, false, 'Read was NOT invoked when binding fence reported not current');
    assert.ok(
      !result.text.includes('ALPHA_LIVE_VERIFIED_PI_CONTENT'),
      'Output does not contain forbidden content',
    );
  } finally {
    await session.close();
  }
});
