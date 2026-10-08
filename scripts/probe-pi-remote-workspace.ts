import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProductionHostPiAdapter, type HostPiEngineAdapter } from '../src/engine/pi-host.ts';
import type { RemoteWorkspaceOperationResult, StartSessionRequest } from '../src/engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';
import { sanitizedProbeErrorFields } from '../src/engine/pi-error-facts.ts';
import { toRunView } from '../src/web/views.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  INSTANCE_ID,
  project,
  runtimePorts,
} from '../src/runtime-test-harness.ts';

const root = await mkdtemp(join(tmpdir(), 'sprout-live-pi-remote-read-'));
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let hostPiSessionStarted = false;
let remoteWorkspaceAttached = false;
let engineTurnStatus: string | undefined;
let responseMentionsTool = false;
let responseContainsEditedMarker = false;
const piToolNames: string[] = [];
const providerRequestFacts: Record<string, unknown>[] = [];
let remoteOperations: readonly string[] = [];
let commandCwdClass = 'unset';
let workerRootForSanitization = '';
let hostSession: { turnFacts?: () => readonly Record<string, unknown>[] } | undefined;
let engineFailure: string | undefined;
const resultFacts: {
  readonly status: string;
  readonly operation: string;
  readonly failure?: string;
  readonly resultMatched: boolean;
  readonly identityMatched: boolean;
  readonly outputBytes: number;
  readonly outputBounded: boolean;
  readonly outputSanitized: boolean;
  readonly progressSequences: readonly number[];
}[] = [];

let stage = 'host-pi-profile';

function report(facts: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

async function availablePortInAssignedRange(): Promise<number> {
  for (let port = 41010; port <= 41019; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolveProbe) => {
      server.once('error', () => resolveProbe(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolveProbe(true)));
    });
    if (available) return port;
  }
  throw new Error('assigned-port-block-unavailable');
}

function observeRemoteWorkspace(adapter: HostPiEngineAdapter): HostPiEngineAdapter {
  return {
    id: adapter.id,
    profileId: adapter.profileId,
    authorizedModel: adapter.authorizedModel,
    capabilities: adapter.capabilities,
    readiness: adapter.readiness.bind(adapter),
    async startSession(request: StartSessionRequest) {
      hostPiSessionStarted = true;
      const remote = request.remoteWorkspace;
      if (!remote) return adapter.startSession(request);
      remoteWorkspaceAttached = true;
      remoteOperations = remote.operations ?? [];
      const identityMatches = (response: RemoteWorkspaceOperationResult): boolean => response.projectId === remote.binding.projectId &&
        response.environmentInstanceId === remote.binding.environmentInstanceId && response.bindingId === remote.binding.bindingId &&
        response.generation === remote.binding.generation && response.connectionEpoch === remote.binding.connectionEpoch &&
        response.workspaceId === remote.binding.workspaceId;
      const observed = {
        ...remote,
        observeProviderRequestFacts(facts: Record<string, unknown>) { providerRequestFacts.push(facts); },
        async read(path: string): Promise<RemoteWorkspaceOperationResult> {
          const response = await remote.read(path);
          resultFacts.push({ status: response.status, operation: response.operation,
            resultMatched: response.content?.startsWith('REMOTE_WORKER_SENTINEL\n') === true, identityMatched: identityMatches(response),
            outputBytes: Buffer.byteLength(response.content ?? '', 'utf8'), outputBounded: Buffer.byteLength(response.content ?? '', 'utf8') <= 64 * 1024,
            outputSanitized: true, progressSequences: [] });
          return response;
        },
        async edit(path: string, oldText: string, newText: string, operationId?: string): Promise<RemoteWorkspaceOperationResult> {
          const response = await remote.edit!(path, oldText, newText, operationId);
          resultFacts.push({ status: response.status, operation: response.operation,
            resultMatched: response.changedPaths?.length === 1 && response.changedPaths[0] === 'sentinel.txt',
            identityMatched: identityMatches(response), outputBytes: 0, outputBounded: true, outputSanitized: true, progressSequences: [] });
          return response;
        },
        async command(executable: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number }, operationId: string,
          onProgress?: (progress: import('../src/engine/port.ts').RemoteWorkspaceProgress) => void): Promise<RemoteWorkspaceOperationResult> {
          commandCwdClass = options.cwd === undefined ? 'unset' : options.cwd === '.' ? 'project-root'
            : options.cwd.startsWith('/') || /^[A-Za-z]:/.test(options.cwd) ? 'absolute'
              : options.cwd.split(/[\\/]/).includes('..') ? 'traversal' : 'relative';
          const progressSequences: number[] = [];
          let progressBytes = 0;
          const response = await remote.command!(executable, args, options, operationId, progress => {
            progressSequences.push(progress.sequence);
            progressBytes += Buffer.byteLength(progress.text, 'utf8');
            onProgress?.(progress);
          });
          const output = response.output ?? '';
          const outputBytes = Buffer.byteLength(output, 'utf8');
          resultFacts.push({ status: response.status, operation: response.operation,
            ...(response.failure !== undefined ? { failure: response.failure } : {}),
            resultMatched: /# tests 1\b[\s\S]*# pass 1\b/.test(output), identityMatched: identityMatches(response),
            outputBytes, outputBounded: outputBytes <= 32 * 1024 && progressBytes <= 32 * 1024,
            outputSanitized: !output.includes(workerRootForSanitization) && !/\x1B|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(output),
            progressSequences });
          return response;
        },
      };
      const session = await adapter.startSession({ ...request, remoteWorkspace: observed });
      hostSession = session as unknown as { turnFacts?: () => readonly Record<string, unknown>[] };
      return {
        sessionId: session.sessionId,
        engineSessionKey: session.engineSessionKey,
        run(prompt: string) {
          const turn = session.run(prompt);
          const events = (async function* () {
            for await (const event of turn.events) {
              if (event.type === 'tool-call') piToolNames.push(event.name);
              if (event.type === 'message') {
                responseMentionsTool ||= event.text.includes('remote_read') || event.text.includes('remote_edit') || event.text.includes('remote_command');
                responseContainsEditedMarker ||= event.text.includes('REMOTE_EDITED_SENTINEL');
              }
              yield event;
            }
          })();
          const completion = turn.completion.then((result) => {
            engineTurnStatus = result.status;
            if (result.status === 'failed') engineFailure = result.message;
            return result;
          });
          return { events, completion };
        },
        interrupt: session.interrupt.bind(session),
        close: session.close.bind(session),
      };
    },
  } as unknown as HostPiEngineAdapter;
}

try {
  const pi = createProductionHostPiAdapter({
    ...process.env,
    SPROUT_HOST_PI_PROVIDER: 'magpie',
    SPROUT_HOST_PI_MODEL: 'codex/gpt-6.1-sol',
  }, {
    providerRoot: resolve(process.cwd(), '..', 'pi-extensions', 'pi-magpie'),
    runnerRoot: join(root, 'engine-runner'),
  });
  if (!pi) {
    report({ outcome: 'blocked', reason: 'host-pi-profile-unconfigured' });
    process.exitCode = 2;
  } else {
    const readiness = await pi.readiness(true);
    if (readiness.status !== 'ready') {
      report({ outcome: 'blocked', reason: 'host-pi-readiness-unavailable', installation: readiness.installation,
        authentication: readiness.authentication, modelAvailability: readiness.modelAvailability,
        adapterControls: readiness.adapterControls });
      process.exitCode = 2;
    } else {
      const model = pi.authorizedModel;
      const workerRoot = join(root, 'worker-workspaces');
      workerRootForSanitization = workerRoot;
      const hostRoot = join(root, 'host-files');
      await mkdir(hostRoot, { recursive: true });
      stage = 'runtime-create';
      const execution = observeRemoteWorkspace(pi);
      runtime = await createRuntime({
        configuration: hostConfiguration({
          executionMode: 'host-run', environmentSource: 'enrollment',
          databasePath: ':memory:',
          runtimeConfiguration: {
            agents: [{
              id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
              workOptions: [{ id: 'host-pi-exact', engine: 'pi', workModel: model, effort: 'medium' }],
            }],
            project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] },
          },
        }),
        projectRoot: hostRoot,
        hostPi: execution,
      });

      const port = await availablePortInAssignedRange();
      stage = 'worker-enrollment';
      const listening = await runtime.api.listen(port, '127.0.0.1');
      runtimePorts.set(runtime, Promise.resolve(listening.port));
      const keyPath = join(root, 'worker-identity.pem');
      const identity = loadOrCreateWorkerIdentity(keyPath);
      const enrollment = await runtime.enrollments.requestEnrollment({
        environmentInstanceId: INSTANCE_ID,
        displayName: 'Pi remote operation Worker',
        publicKey: workerPublicKey(identity.privateKey),
        platform: 'macos', protocolVersion: '3.0',
        capabilityRequests: ['agent-run', 'read-only-investigation'], engineFacts: [],
      });
      await runtime.enrollments.approve(enrollment.enrollment.id, {
        capabilityPermissions: { 'agent-run': true, 'read-only-investigation': true },
      });
      await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
      await runtime.projectService.create({ id: 'pi-remote-workspace-project', displayName: 'Pi remote workspace Project' });
      stage = 'project-membership';
      await runtime.projectService.addMembership('pi-remote-workspace-project', { agentId: 'scout' });
      stage = 'workspace-grant';
      const access = await runtime.projectAccess.grant({
        projectId: 'pi-remote-workspace-project', environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'relative', path: 'repos/pi-work' },
      });
      stage = 'fixture-write';
      const pathArgumentSentinel = '/srv/synthetic-host/private/remote-sentinel.txt';
      const credentialArgumentSentinel = 'api_key=ghp_abcdefghijklmnopqrstuvwx';
      const workerProjectRoot = join(workerRoot, 'repos', 'pi-work');
      await mkdir(join(workerProjectRoot, 'test'), { recursive: true });
      await writeFile(join(hostRoot, 'sentinel.txt'), 'LOCAL_HOST_SENTINEL');
      await writeFile(join(workerProjectRoot, 'sentinel.txt'), `REMOTE_WORKER_SENTINEL\n${pathArgumentSentinel}\n${credentialArgumentSentinel}`);
      await writeFile(join(workerProjectRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2));
      await writeFile(join(workerProjectRoot, 'test', 'remote.test.js'), [
        "import assert from 'node:assert/strict';",
        "import { readFile } from 'node:fs/promises';",
        "import { test } from 'node:test';",
        "test('the model edit is present in the remote Project workspace', async () => {",
        "  assert.equal(await readFile(new URL('../sentinel.txt', import.meta.url), 'utf8'), 'REMOTE_EDITED_SENTINEL');",
        '});',
        '',
      ].join('\n'));

      stage = 'model-turn';
      const { id } = await runtime.orchestrator.submit({
        agentId: 'scout', projectId: 'pi-remote-workspace-project',
        prompt: 'Use the authorized remote tools in this exact order. First call remote_read once on sentinel.txt. Then call remote_edit once, replacing exactly the full text returned by remote_read with REMOTE_EDITED_SENTINEL. Then call remote_command once with executable npm and args ["test", "--", "--test-reporter=tap"]. Do not use any other tool or repeat the file contents. Report the remote test counters only after the command passes.',
      });
      stage = 'model-turn-wait';
      const run = await runtime.orchestrator.waitFor(id);
      const projectedEvents = toRunView(run).events;
      const projectedEventJson = JSON.stringify(projectedEvents);
      const visibleRemoteOutcomes = ['read', 'edit', 'command'].every(operation =>
        projectedEvents.some(event => event.type === 'notice' && event.text === `Remote ${operation} completed.`));
      const remoteProgressVisible = projectedEvents.some(event => event.type === 'tool-output' && typeof event.text === 'string' && event.text.trim() !== '');
      const eventPrivacySentinelsAbsent = ![
        workerRoot, hostRoot, pathArgumentSentinel, credentialArgumentSentinel,
        'LOCAL_HOST_SENTINEL', 'REMOTE_WORKER_SENTINEL', 'REMOTE_EDITED_SENTINEL',
      ].some(sentinel => projectedEventJson.includes(sentinel));
      // turn-facts arrive on the child stdout after the terminal session event;
      // give them a beat to flush before reading the observed facts.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const readObservation = resultFacts[0];
      const editObservation = resultFacts[1];
      const commandObservation = resultFacts[2];
      const expectedCalls = ['remote_read', 'remote_edit', 'remote_command'];
      const expectedTools = expectedCalls.every(name => piToolNames.filter(tool => tool === name).length === 1) && piToolNames.length === expectedCalls.length;
      const localFileUnchanged = await readFile(join(hostRoot, 'sentinel.txt'), 'utf8') === 'LOCAL_HOST_SENTINEL';
      const remoteFileEdited = await readFile(join(workerProjectRoot, 'sentinel.txt'), 'utf8') === 'REMOTE_EDITED_SENTINEL';
      const lease = runtime.pool.leases().find(item => item.runId === id);
      const finalText = run.result?.status === 'completed' ? run.result.text : '';
      const modelReportedTestPass = /#\s*pass\s+1|tests?\s+passed|\bpass(?:ed|ing)?\b/i.test(finalText);
      const modelFinalTextSanitized = !finalText.includes(workerRoot) && !finalText.includes(hostRoot) &&
        !finalText.includes(pathArgumentSentinel) && !finalText.includes(credentialArgumentSentinel);
      const progressContiguous = commandObservation !== undefined && commandObservation.progressSequences.length > 0 &&
        commandObservation.progressSequences.every((sequence, index) => sequence === index + 1);
      const accepted = run.status === 'completed' && engineTurnStatus === 'completed' && expectedTools &&
        resultFacts.length === 3 && readObservation?.status === 'completed' && readObservation.operation === 'read' && readObservation.resultMatched &&
        editObservation?.status === 'completed' && editObservation.operation === 'edit' && editObservation.resultMatched &&
        commandObservation?.status === 'completed' && commandObservation.operation === 'command' && commandObservation.resultMatched &&
        commandObservation.identityMatched && commandObservation.outputBounded && commandObservation.outputSanitized && progressContiguous && modelReportedTestPass && modelFinalTextSanitized &&
        visibleRemoteOutcomes && remoteProgressVisible && eventPrivacySentinelsAbsent &&
        localFileUnchanged && remoteFileEdited && lease?.state === 'released';
      report({
        outcome: accepted ? 'model-issued-edit-and-test-passed' : 'model-issued-edit-and-test-incomplete',
        piVersion: readiness.version ?? 'unknown',
        runStatus: run.status,
        eventTypes: run.events.map((event) => event.type),
        visibleRemoteOutcomes,
        remoteProgressVisible,
        eventPrivacySentinelsAbsent,
        toolNames: piToolNames,
        remoteOperations,
        providerRequestFacts,
        engineTurnStatus,
        engineFailure,
        turnFacts: hostSession?.turnFacts?.() ?? [],
        responseMentionsTool,
        responseContainsEditedMarker,
        hostPiSessionStarted,
        remoteWorkspaceAttached,
        hostProfileMatched: run.engineHostProfileId === pi.profileId,
        operationSequence: resultFacts.map(result => result.operation),
        readCompleted: readObservation?.status === 'completed',
        readMarkerMatched: readObservation?.resultMatched ?? false,
        editCompleted: editObservation?.status === 'completed',
        editPathMatched: editObservation?.resultMatched ?? false,
        commandCompleted: commandObservation?.status === 'completed',
        commandFailure: commandObservation?.failure ?? 'none',
        commandCwdClass,
        remoteTestPassed: commandObservation?.resultMatched ?? false,
        modelReportedTestPass,
        modelFinalTextSanitized,
        commandOutputBytes: commandObservation?.outputBytes ?? 0,
        commandOutputBounded: commandObservation?.outputBounded ?? false,
        commandOutputSanitized: commandObservation?.outputSanitized ?? false,
        progressSequences: commandObservation?.progressSequences ?? [],
        operationBindingsMatched: resultFacts.every(result => result.identityMatched),
        localHostSentinelUnchanged: localFileUnchanged,
        remoteProjectSentinelEdited: remoteFileEdited,
        exactAuthorizedModelRetained: pi.authorizedModel === model,
        verifiedProbeSelection: pi.provider === 'magpie' && pi.authorizedModel === 'codex/gpt-6.1-sol',
        workerHasNoModelEngine: (await runtime.enrollmentEnvironment.info?.(INSTANCE_ID))?.engines.length === 0,
        leaseState: lease?.state ?? 'missing',
        initialBindingGeneration: access.current?.generation ?? 0,
      });
      if (!accepted) process.exitCode = 1;
    }
  }
} catch (error) {
  report({
    outcome: 'blocked', reason: 'bounded-probe-failed', stage,
    ...sanitizedProbeErrorFields(error),
  });
  process.exitCode = 2;
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
