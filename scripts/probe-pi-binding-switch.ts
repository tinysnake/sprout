import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProductionHostPiAdapter, type HostPiEngineAdapter } from '../src/engine/pi-host.ts';
import type { RemoteWorkspaceOperationResult, StartSessionRequest } from '../src/engine/port.ts';
import { sanitizedProbeErrorFields } from '../src/engine/pi-error-facts.ts';
import { toRunView } from '../src/web/views.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';
import {
  connectRuntimeWorker,
  createRuntime,
  hostConfiguration,
  project,
  runtimePorts,
} from '../src/runtime-test-harness.ts';

const ENVIRONMENT_A = 'pi-binding-environment-a';
const ENVIRONMENT_B = 'pi-binding-environment-b';
const PROJECT_ID = 'pi-binding-switch-project';
const MODEL_PROVIDER = 'magpie';
const MODEL_ID = 'codex/gpt-6.1-sol';
const MARKER_A = 'PI_ENVIRONMENT_A_SENTINEL';
const MARKER_B = 'PI_ENVIRONMENT_B_SENTINEL';
const root = await mkdtemp(join(tmpdir(), 'sprout-live-pi-binding-switch-'));
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let stage = 'host-pi-profile';

interface OperationFact {
  readonly environmentInstanceId: string;
  readonly status: string;
  readonly identityMatched: boolean;
  readonly markerMatched: boolean;
}
interface SessionFact {
  readonly environmentInstanceId: string;
  readonly instructions: string;
  readonly resumeSessionKey?: string;
  prompt?: string;
  readonly tools: string[];
}

const operations: OperationFact[] = [];
const sessions: SessionFact[] = [];
const workerRoots = new Map<string, string>();

function report(facts: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

async function waitForBounded<T>(promise: Promise<T>, timeoutMs = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('model-turn-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function observeHostPi(adapter: HostPiEngineAdapter): HostPiEngineAdapter {
  return {
    id: adapter.id,
    profileId: adapter.profileId,
    authorizedModel: adapter.authorizedModel,
    capabilities: adapter.capabilities,
    readiness: adapter.readiness.bind(adapter),
    async startSession(request: StartSessionRequest) {
      const remote = request.remoteWorkspace;
      if (remote === undefined) throw new Error('authorized Work Environment tools were not attached');
      const environmentInstanceId = remote.binding.environmentInstanceId;
      const sessionFact: SessionFact = {
        environmentInstanceId,
        instructions: request.instructions ?? '',
        ...(request.resumeSessionKey !== undefined ? { resumeSessionKey: request.resumeSessionKey } : {}),
        tools: [],
      };
      sessions.push(sessionFact);
      const expectedMarker = environmentInstanceId === ENVIRONMENT_A ? MARKER_A : MARKER_B;
      const observedWorkspace = {
        ...remote,
        async read(path: string): Promise<RemoteWorkspaceOperationResult> {
          const result = await remote.read(path);
          operations.push({
            environmentInstanceId,
            status: result.status,
            identityMatched: result.projectId === remote.binding.projectId &&
              result.environmentInstanceId === remote.binding.environmentInstanceId &&
              result.bindingId === remote.binding.bindingId && result.generation === remote.binding.generation &&
              result.connectionEpoch === remote.binding.connectionEpoch && result.workspaceId === remote.binding.workspaceId,
            markerMatched: result.content?.trim() === expectedMarker,
          });
          return result;
        },
      };
      const session = await adapter.startSession({ ...request, remoteWorkspace: observedWorkspace });
      return {
        sessionId: session.sessionId,
        engineSessionKey: session.engineSessionKey,
        run(prompt: string) {
          sessionFact.prompt = prompt;
          const turn = session.run(prompt);
          const events = (async function* () {
            for await (const event of turn.events) {
              if (event.type === 'tool-call') sessionFact.tools.push(event.name);
              yield event;
            }
          })();
          return { events, completion: turn.completion };
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
    SPROUT_HOST_PI_PROVIDER: MODEL_PROVIDER,
    SPROUT_HOST_PI_MODEL: MODEL_ID,
  }, {
    providerRoot: resolve(process.cwd(), '..', 'pi-extensions', 'pi-magpie'),
    runnerRoot: join(root, 'engine-runner'),
  });
  if (pi === undefined) {
    report({ outcome: 'blocked', reason: 'host-pi-profile-unconfigured' });
    process.exitCode = 2;
  } else {
    const readiness = await pi.readiness(true);
    if (readiness.status !== 'ready') {
      report({ outcome: 'blocked', reason: 'host-pi-readiness-unavailable',
        installation: readiness.installation, authentication: readiness.authentication,
        modelAvailability: readiness.modelAvailability, adapterControls: readiness.adapterControls });
      process.exitCode = 2;
    } else {
      const model = pi.authorizedModel;
      const hostRoot = join(root, 'host-files');
      await mkdir(hostRoot, { recursive: true });
      const localSentinelPath = join(hostRoot, 'sentinel.txt');
      await writeFile(localSentinelPath, 'HOST_LOCAL_SENTINEL');
      const roots = new Map([
        [ENVIRONMENT_A, join(root, 'worker-a')],
        [ENVIRONMENT_B, join(root, 'worker-b')],
      ]);
      for (const [environmentInstanceId, workerRoot] of roots) {
        workerRoots.set(environmentInstanceId, workerRoot);
        const workspaceRoot = join(workerRoot, 'repos', 'pi-switch');
        await mkdir(workspaceRoot, { recursive: true });
        await writeFile(join(workspaceRoot, 'origin.txt'), environmentInstanceId === ENVIRONMENT_A ? MARKER_A : MARKER_B);
      }
      const execution = observeHostPi(pi);
      runtime = await createRuntime({
        configuration: hostConfiguration({
          executionMode: 'host-run', environmentSource: 'enrollment', databasePath: ':memory:',
          runtimeConfiguration: {
            agents: [{ id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
              workOptions: [{ id: 'host-pi-exact', engine: 'pi', workModel: model, effort: 'medium' }] }],
            project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] },
          },
        }),
        projectRoot: hostRoot,
        hostPi: execution,
      });

      stage = 'worker-enrollment';
      const port = await availablePortInAssignedRange();
      const listening = await runtime.api.listen(port, '127.0.0.1');
      runtimePorts.set(runtime, Promise.resolve(listening.port));
      for (const [index, [environmentInstanceId, workerRoot]] of [...roots].entries()) {
        const keyPath = join(root, `worker-${index}.pem`);
        const identity = loadOrCreateWorkerIdentity(keyPath);
        const enrollment = await runtime.enrollments.requestEnrollment({
          environmentInstanceId, displayName: `Pi binding switch Worker ${index}`,
          publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
          capabilityRequests: ['agent-run', 'read-only-investigation'], engineFacts: [],
        });
        await runtime.enrollments.approve(enrollment.enrollment.id, {
          capabilityPermissions: { 'agent-run': true, 'read-only-investigation': true },
        });
        await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
      }

      stage = 'project-membership';
      await runtime.projectService.create({ id: PROJECT_ID, displayName: 'Pi binding switch Project' });
      await runtime.projectService.addMembership(PROJECT_ID, { agentId: 'scout' });
      for (const environmentInstanceId of [ENVIRONMENT_A, ENVIRONMENT_B]) {
        await runtime.projectAccess.grant({
          projectId: PROJECT_ID, environmentInstanceId, selection: { kind: 'relative', path: 'repos/pi-switch' },
        });
      }

      const runOn = async (environmentInstanceId: string, prompt: string) => {
        const { id } = await runtime!.orchestrator.submit({
          agentId: 'scout', projectId: PROJECT_ID, workEnvironmentInstanceId: environmentInstanceId,
          sessionKeyScope: { kind: 'conversation', id: 'pi-binding-switch-conversation' }, prompt,
        });
        return waitForBounded(runtime!.orchestrator.waitFor(id));
      };

      stage = 'environment-a-turn';
      const runA = await runOn(ENVIRONMENT_A,
        `Use remote_read exactly once to read origin.txt. Report only the marker returned. Do not use any other tool.`);
      stage = 'environment-b-turn';
      const runB = await runOn(ENVIRONMENT_B,
        `Use remote_read exactly once to read origin.txt. Report only the marker returned. Do not use any other tool.`);

      const runAView = toRunView(runA);
      const runBView = toRunView(runB);
      const runAEvents = JSON.stringify(runAView.events);
      const runBEvents = JSON.stringify(runBView.events);
      const finalA = runA.result?.status === 'completed' ? runA.result.text : '';
      const finalB = runB.result?.status === 'completed' ? runB.result.text : '';
      const workerPathLeaks = [...workerRoots.values()].some(path => runAEvents.includes(path) || runBEvents.includes(path));
      const hostPathLeaks = runAEvents.includes(hostRoot) || runBEvents.includes(hostRoot) ||
        finalA.includes(hostRoot) || finalB.includes(hostRoot);
      const localFileUnchanged = await readFile(localSentinelPath, 'utf8') === 'HOST_LOCAL_SENTINEL';
      const runALease = runtime.pool.leases().find(item => item.runId === runA.id);
      const runBLease = runtime.pool.leases().find(item => item.runId === runB.id);
      const toolsA = sessions[0]?.tools ?? [];
      const toolsB = sessions[1]?.tools ?? [];
      const promptB = sessions[1]?.prompt ?? '';
      const accepted = runA.status === 'completed' && runB.status === 'completed' &&
        runA.workspaceBindingStatus === 'active' && runB.workspaceBindingStatus === 'active' &&
        runA.workspaceBinding?.environmentInstanceId === ENVIRONMENT_A &&
        runB.workspaceBinding?.environmentInstanceId === ENVIRONMENT_B &&
        operations.length === 2 && operations[0]?.environmentInstanceId === ENVIRONMENT_A &&
        operations[1]?.environmentInstanceId === ENVIRONMENT_B &&
        operations.every(item => item.status === 'completed' && item.identityMatched && item.markerMatched) &&
        toolsA.length === 1 && toolsA[0] === 'remote_read' && toolsB.length === 1 && toolsB[0] === 'remote_read' &&
        sessions.length === 2 && sessions[0]?.resumeSessionKey === undefined && sessions[1]?.resumeSessionKey === undefined &&
        sessions[1]?.instructions.includes(`Environment: ${ENVIRONMENT_B}`) === true &&
        sessions[1]?.instructions.includes(`Sprout switched the current Work Environment from ${ENVIRONMENT_A} to ${ENVIRONMENT_B}`) === true &&
        promptB.includes(`Environment ${ENVIRONMENT_A}`) && promptB.includes(MARKER_A) &&
        finalA.includes(MARKER_A) && finalB.includes(MARKER_B) && !workerPathLeaks && !hostPathLeaks &&
        localFileUnchanged && runALease === undefined && runBLease === undefined;
      report({
        outcome: accepted ? 'real-pi-binding-switch-passed' : 'real-pi-binding-switch-incomplete',
        piVersion: readiness.version ?? 'unknown',
        runStatuses: [runA.status, runB.status],
        bindingStatuses: [runA.workspaceBindingStatus ?? 'missing', runB.workspaceBindingStatus ?? 'missing'],
        requestedEnvironmentSequence: [runA.requestedWorkEnvironmentInstanceId ?? 'none', runB.requestedWorkEnvironmentInstanceId ?? 'none'],
        actualEnvironmentSequence: [runA.workspaceBinding?.environmentInstanceId ?? 'none', runB.workspaceBinding?.environmentInstanceId ?? 'none'],
        operationStatuses: operations.map(item => item.status),
        operationBindingsMatched: operations.every(item => item.identityMatched),
        environmentMarkersMatched: operations.every(item => item.markerMatched),
        toolNamesByActivation: [toolsA, toolsB],
        environmentBStartedFreshSession: sessions[1]?.resumeSessionKey === undefined,
        environmentBPromptIncludesAOrigin: promptB.includes(`Environment ${ENVIRONMENT_A}`) && promptB.includes(MARKER_A),
        currentSnapshotIncludesB: sessions[1]?.instructions.includes(`Environment: ${ENVIRONMENT_B}`) ?? false,
        bindingChangeFactIncludesAtoB: sessions[1]?.instructions.includes(
          `Sprout switched the current Work Environment from ${ENVIRONMENT_A} to ${ENVIRONMENT_B}`) ?? false,
        hostPathsAbsentFromRunEventsAndResults: !workerPathLeaks && !hostPathLeaks,
        hostLocalSentinelUnchanged: localFileUnchanged,
        leaseStates: [runALease?.state ?? 'none (read-only)', runBLease?.state ?? 'none (read-only)'],
        exactAuthorizedModelRetained: pi.authorizedModel === model,
        workerEnvironmentsHaveNoModelEngine: (await Promise.all([ENVIRONMENT_A, ENVIRONMENT_B].map(async id =>
          (await runtime!.enrollmentEnvironment.info?.(id))?.engines.length === 0))).every(Boolean),
      });
      if (!accepted) process.exitCode = 1;
    }
  }
} catch (error) {
  report({ outcome: 'blocked', reason: 'bounded-probe-failed', stage, ...sanitizedProbeErrorFields(error) });
  process.exitCode = 2;
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
