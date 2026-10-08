import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProductionHostPiAdapter, type HostPiEngineAdapter } from '../src/engine/pi-host.ts';
import type { RemoteWorkspaceOperationResult, StartSessionRequest } from '../src/engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';
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
let responseContainsMarker = false;
const piToolNames: string[] = [];
const providerRequestFacts: Record<string, unknown>[] = [];
let hostSession: { turnFacts?: () => readonly Record<string, unknown>[] } | undefined;
let engineFailure: string | undefined;
const resultFacts: {
  readonly status: string;
  readonly operation: string;
  readonly contentMatched: boolean;
  readonly identityMatched: boolean;
}[] = [];

let stage = 'host-pi-profile';

function report(facts: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

async function availablePortInAssignedRange(): Promise<number> {
  for (let port = 41000; port <= 41009; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolveProbe) => {
      server.once('error', () => resolveProbe(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolveProbe(true)));
    });
    if (available) return port;
  }
  throw new Error('assigned-port-block-unavailable');
}

function observeRemoteReads(adapter: HostPiEngineAdapter): HostPiEngineAdapter {
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
      const observed = {
        ...remote,
        observeProviderRequestFacts(facts: Record<string, unknown>) { providerRequestFacts.push(facts); },
        async read(path: string): Promise<RemoteWorkspaceOperationResult> {
          const response = await remote.read(path);
          resultFacts.push({
            status: response.status,
            operation: response.operation,
            contentMatched: response.content === 'REMOTE_WORKER_SENTINEL',
            identityMatched: response.projectId === remote.binding.projectId &&
              response.environmentInstanceId === remote.binding.environmentInstanceId &&
              response.bindingId === remote.binding.bindingId && response.generation === remote.binding.generation &&
              response.connectionEpoch === remote.binding.connectionEpoch && response.workspaceId === remote.binding.workspaceId,
          });
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
                responseMentionsTool ||= event.text.includes('remote_read');
                responseContainsMarker ||= event.text.includes('REMOTE_WORKER_SENTINEL');
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
      stage = 'runtime-create';
      const execution = observeRemoteReads(pi);
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
        projectRoot: process.cwd(),
        hostPi: execution,
      });

      const port = await availablePortInAssignedRange();
      stage = 'worker-enrollment';
      const listening = await runtime.api.listen(port, '127.0.0.1');
      runtimePorts.set(runtime, Promise.resolve(listening.port));
      const workerRoot = join(root, 'worker-workspaces');
      const keyPath = join(root, 'worker-identity.pem');
      const identity = loadOrCreateWorkerIdentity(keyPath);
      const enrollment = await runtime.enrollments.requestEnrollment({
        environmentInstanceId: INSTANCE_ID,
        displayName: 'Pi remote read Worker',
        publicKey: workerPublicKey(identity.privateKey),
        platform: 'macos', protocolVersion: '3.0',
        capabilityRequests: ['read-only-investigation'], engineFacts: [],
      });
      await runtime.enrollments.approve(enrollment.enrollment.id, {
        capabilityPermissions: { 'read-only-investigation': true },
      });
      await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
      stage = 'project-access';
      stage = 'project-create';
      await runtime.projectService.create({ id: 'pi-remote-read-project', displayName: 'Pi remote read Project' });
      stage = 'project-membership';
      await runtime.projectService.addMembership('pi-remote-read-project', { agentId: 'scout' });
      stage = 'workspace-grant';
      const access = await runtime.projectAccess.grant({
        projectId: 'pi-remote-read-project', environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'relative', path: 'repos/pi-read' },
      });
      stage = 'fixture-write';
      const hostRoot = join(root, 'host-files');
      await mkdir(hostRoot, { recursive: true });
      await writeFile(join(hostRoot, 'sentinel.txt'), 'LOCAL_HOST_SENTINEL');
      await writeFile(join(workerRoot, 'repos', 'pi-read', 'sentinel.txt'), 'REMOTE_WORKER_SENTINEL');

      stage = 'model-turn';
      const { id } = await runtime.orchestrator.submit({
        agentId: 'scout', projectId: 'pi-remote-read-project',
        prompt: 'You must call the remote_read tool exactly once with path sentinel.txt. Do not infer or guess its contents. Return only the exact text returned by that tool.',
      });
      stage = 'model-turn-wait';
      const run = await runtime.orchestrator.waitFor(id);
      // turn-facts arrive on the child stdout after the terminal session event;
      // give them a beat to flush before reading the observed facts.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const observation = resultFacts[0];
      const accepted = run.status === 'completed' && observation?.status === 'completed' &&
        observation.operation === 'read' && observation.contentMatched && observation.identityMatched;
      report({
        outcome: accepted ? 'model-issued-read-passed' : 'model-issued-read-incomplete',
        piVersion: readiness.version ?? 'unknown',
        runStatus: run.status,
        eventTypes: run.events.map((event) => event.type),
        toolNames: piToolNames,
        providerRequestFacts,
        engineTurnStatus,
        engineFailure,
        turnFacts: hostSession?.turnFacts?.() ?? [],
        responseMentionsTool,
        responseContainsMarker,
        hostPiSessionStarted,
        remoteWorkspaceAttached,
        hostProfileMatched: run.engineHostProfileId === pi.profileId,
        remoteReadCallCount: resultFacts.length,
        remoteReadCompleted: observation?.status === 'completed',
        remoteMarkerMatched: observation?.contentMatched ?? false,
        bindingIdentityMatched: observation?.identityMatched ?? false,
        exactAuthorizedModelRetained: pi.authorizedModel === model,
        verifiedProbeSelection: pi.provider === 'magpie' && pi.authorizedModel === 'codex/gpt-6.1-sol',
        workerHasNoModelEngine: (await runtime.enrollmentEnvironment.info?.(INSTANCE_ID))?.engines.length === 0,
        leaseCount: runtime.pool.leases().length,
        initialBindingGeneration: access.current?.generation ?? 0,
      });
      if (!accepted) process.exitCode = 1;
    }
  }
} catch (error) {
  report({
    outcome: 'blocked', reason: 'bounded-probe-failed', stage,
    errorType: error instanceof Error ? error.name : 'unknown',
    errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
  });
  process.exitCode = 2;
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
