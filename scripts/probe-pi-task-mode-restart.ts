import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProductionHostPiAdapter, type HostPiEngineAdapter } from '../src/engine/pi-host.ts';
import type { EngineSession, RemoteWorkspaceOperationResult, StartSessionRequest } from '../src/engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from '../src/worker/enrollment-connector.ts';
import { sanitizedProbeErrorFields } from '../src/engine/pi-error-facts.ts';
import { connectRuntimeWorker, createRuntime, hostConfiguration, INSTANCE_ID, project } from '../src/runtime-test-harness.ts';

const root = await mkdtemp(join(tmpdir(), 'sprout-task-mode-restart-'));
const databasePath = join(root, 'state.sqlite');
const workerRoot = join(root, 'worker');
const identityPath = join(root, 'worker-identity.pem');
const projectId = 'pi-task-mode-restart-project';
const taskPath = 'origin.txt';
const marker = 'MODE_RESTART_SENTINEL';
const runtimeConfiguration = {
  agents: [{
    id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model: 'codex/gpt-6.1-sol', effort: 'medium',
    workOptions: [{ id: 'host-pi-exact', engine: 'pi', workModel: 'codex/gpt-6.1-sol', effort: 'medium' }],
  }],
  project: { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: 'Read the bounded Task context and authorized Project workspace.' }] },
};
const operations: { status: string; failure: string; pathMatched: boolean; markerMatched: boolean; taskLeaseHeld: boolean }[] = [];
const knownWorkspaceFailures = new Set([
  'invalid-path', 'not-text', 'file-too-large', 'content-conflict', 'invalid-patch', 'operation-limit',
  'command-not-allowed', 'command-timeout', 'run-context-unavailable', 'not-found', 'unsupported',
  'operation-identity-conflict', 'outcome-unknown-inspect-required', 'operation-journal-unavailable',
  'command-start-failed', 'command-failed', 'cancelled', 'descendant-process-unknown',
  'command-supervision-unsupported', 'remote-operation-blocked', 'project-denied', 'access-ended',
  'workspace-unbound', 'worker-offline', 'stale-epoch', 'stale-generation', 'capability-denied',
  'lease-required', 'worker-refused',
]);
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let taskLeaseId: string | undefined;
let service: ChildProcess | undefined;
let serviceOutput = '';
let serviceBase = '';
let operatorCredential = '';
let stage = 'host-pi-profile';
let diagnosticFacts: Record<string, unknown> | undefined;

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

async function startService(mode: 'host-run' | 'environment-hosted'): Promise<void> {
  serviceOutput = '';
  service = spawn(process.execPath, ['src/main.ts', '--execution-mode', mode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SPROUT_PORT: '0',
      SPROUT_DATABASE: databasePath,
      SPROUT_ENV_SOURCE: 'enrollment',
      SPROUT_ENV_INSTANCE: INSTANCE_ID,
      SPROUT_RUNTIME_CONFIG: JSON.stringify(runtimeConfiguration),
      SPROUT_OPERATOR_CREDENTIAL: operatorCredential,
      SPROUT_HOST_PI_PROVIDER: 'magpie',
      SPROUT_HOST_PI_MODEL: 'codex/gpt-6.1-sol',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout?.on('data', chunk => { serviceOutput += chunk.toString('utf8'); });
  service.stderr?.on('data', chunk => { serviceOutput += chunk.toString('utf8'); });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const announcedEndpoint = serviceOutput.match(/Sprout listening on (https?:\/\/\S+)/)?.[1];
    if (announcedEndpoint !== undefined) {
      serviceBase = announcedEndpoint;
      return;
    }
    if (service.exitCode !== null) {
      diagnosticFacts = { ...diagnosticFacts, serviceStartupExited: true, serviceStartupFailure: serviceFailureClass() };
      throw new Error('production-service-did-not-start');
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  diagnosticFacts = { ...diagnosticFacts, serviceStartupExited: false, serviceStartupFailure: serviceFailureClass() };
  throw new Error('production-service-start-timeout');
}

function serviceFailureClass(): string {
  if (/EADDRINUSE/.test(serviceOutput)) return 'port-unavailable';
  if (/database schema|SchemaError/i.test(serviceOutput)) return 'database-schema-error';
  if (/Host-run execution is unavailable/.test(serviceOutput)) return 'host-run-profile-unavailable';
  if (/SPROUT_RUNTIME_CONFIG/.test(serviceOutput)) return 'runtime-configuration-error';
  if (/operator.*credential|credential.*operator/i.test(serviceOutput)) return 'operator-credential-rejected';
  if (serviceOutput.length === 0) return 'no-startup-output';
  return 'unclassified-startup-error';
}

function sanitizedServiceDiagnostic(): string {
  const configError = serviceOutput.match(/SPROUT_RUNTIME_CONFIG ([A-Za-z0-9_.]+) must be ([^\r\n]+)/);
  if (configError !== null) return `runtime-configuration field ${configError[1]} was rejected`;
  const line = serviceOutput.split(/\r?\n/).map(value => value.trim())
    .find(value => /^(?:Error|TypeError|SyntaxError|RangeError)(?::|$)/.test(value)) ?? '';
  return line
    .replaceAll(operatorCredential, '<credential>')
    .replaceAll(databasePath, '<database>')
    .replaceAll(root, '<probe-root>')
    .replaceAll(process.cwd(), '<repository>')
    .replace(/https?:\/\/[^\s]+/g, '<endpoint>')
    .replace(/\/(?:Users|home)\/[^\s/:)]+(?:\/[^\s:)]+)*/g, '<local-path>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<identity>')
    .slice(0, 200);
}

async function stopService(): Promise<void> {
  if (service === undefined || service.exitCode !== null) { service = undefined; return; }
  const child = service;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forced = new Promise<void>(resolveForced => {
    timeout = setTimeout(() => { child.kill('SIGKILL'); resolveForced(); }, 10_000);
  });
  await Promise.race([exited, forced]);
  if (timeout !== undefined) clearTimeout(timeout);
  service = undefined;
}

async function signIn(): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await fetch(`${serviceBase}/api/auth/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: operatorCredential }),
  });
  if (response.status !== 201) throw new Error('production-service-human-session-failed');
  const cookieHeader = response.headers.get('set-cookie');
  if (cookieHeader === null) throw new Error('production-service-session-cookie-missing');
  const body = await response.json() as { readonly csrfToken?: string };
  if (typeof body.csrfToken !== 'string') throw new Error('production-service-csrf-token-missing');
  return { cookie: cookieHeader.split(';', 1)[0]!, csrf: body.csrfToken };
}

async function readTaskFromService(taskId: string, session: { readonly cookie: string }) {
  const response = await fetch(`${serviceBase}/api/tasks/${encodeURIComponent(taskId)}`, {
    headers: { cookie: session.cookie },
  });
  if (response.status !== 200) throw new Error('production-service-task-read-failed');
  return await response.json() as {
    readonly task: Record<string, unknown>;
    readonly runs: readonly { readonly runId: string; readonly summary?: { readonly status: string } }[];
  };
}

function persistedLeaseState(leaseId: string): string {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT state, holder_kind, task_id FROM environment_leases WHERE id = ?').get(leaseId) as
      { readonly state?: unknown; readonly holder_kind?: unknown; readonly task_id?: unknown } | undefined;
    if (row?.holder_kind !== 'task' || row.task_id === undefined) return 'mismatch';
    return typeof row.state === 'string' ? row.state : 'missing';
  } finally {
    db.close();
  }
}

function observeWorkspace(adapter: HostPiEngineAdapter): HostPiEngineAdapter {
  return {
    id: adapter.id,
    profileId: adapter.profileId,
    authorizedModel: adapter.authorizedModel,
    capabilities: adapter.capabilities,
    readiness: adapter.readiness.bind(adapter),
    async startSession(request: StartSessionRequest) {
      const workspace = request.remoteWorkspace;
      if (workspace === undefined) throw new Error('task workspace was not attached');
      const observed = {
        ...workspace,
        async read(path: string, operationId?: string): Promise<RemoteWorkspaceOperationResult> {
          const result = await workspace.read(path, operationId);
          operations.push({
            status: result.status,
            failure: result.failure === undefined ? 'none'
              : knownWorkspaceFailures.has(result.failure) ? result.failure : 'other',
            pathMatched: path === taskPath,
            markerMatched: result.content?.trim() === marker,
            taskLeaseHeld: taskLeaseId !== undefined && runtime?.pool.getLease(taskLeaseId)?.holderKind === 'task' &&
              runtime.pool.getLease(taskLeaseId)?.state === 'active',
          });
          return result;
        },
      };
      const session: EngineSession = await adapter.startSession({ ...request, remoteWorkspace: observed });
      return {
        ...session,
        run: session.run.bind(session),
        interrupt: session.interrupt.bind(session),
        close: session.close.bind(session),
      };
    },
  } as unknown as HostPiEngineAdapter;
}

function config(executionMode: 'host-run' | 'environment-hosted') {
  return hostConfiguration({
    executionMode,
    environmentSource: 'enrollment',
    databasePath,
    runtimeConfiguration,
  });
}

try {
  const productionPi = createProductionHostPiAdapter({
    ...process.env,
    SPROUT_HOST_PI_PROVIDER: 'magpie',
    SPROUT_HOST_PI_MODEL: 'codex/gpt-6.1-sol',
  }, {
    providerRoot: resolve(process.cwd(), '..', 'pi-extensions', 'pi-magpie'),
    runnerRoot: join(root, 'engine-runner'),
  });
  if (productionPi === undefined) throw new Error('host-pi-profile-unconfigured');
  const readiness = await productionPi.readiness(true);
  if (readiness.status !== 'ready') throw new Error('host-pi-readiness-unavailable');

  stage = 'first-runtime-start';
  runtime = await createRuntime({ configuration: config('host-run'), projectRoot: root, hostPi: observeWorkspace(productionPi) });
  stage = 'worker-enrollment';
  const identity = loadOrCreateWorkerIdentity(identityPath);
  const enrollment = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Task mode restart Worker',
    publicKey: workerPublicKey(identity.privateKey),
    platform: 'macos', protocolVersion: '3.0', engineFacts: [],
    capabilityRequests: ['agent-run', 'read-only-investigation'],
  });
  await runtime.enrollments.approve(enrollment.enrollment.id, {
    capabilityPermissions: { 'agent-run': true, 'read-only-investigation': true },
  });
  await connectRuntimeWorker(runtime, enrollment.enrollment.id, identityPath, undefined, workerRoot);
  stage = 'project-setup';
  await runtime.projectService.create({ id: projectId, displayName: 'Pi Task mode restart Project' });
  await runtime.projectService.addMembership(projectId, { agentId: 'scout' });
  await runtime.projectAccess.grant({
    projectId, environmentInstanceId: INSTANCE_ID, selection: { kind: 'relative', path: 'repos/mode-restart' },
  });
  const workspacePath = join(workerRoot, 'repos', 'mode-restart');
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, taskPath), `${marker}\n`, 'utf8');

  stage = 'propose-task';
  const actor = await runtime.taskProposals.humanAuthority(projectId);
  const proposal = await runtime.taskProposals.propose(projectId, actor, {
    title: 'Host-run Task mode restart probe',
    goal: 'Read one authorized Project workspace marker before a mode-changing Runtime restart.',
    constraints: ['Use only the authorized remote Workspace tool.'],
    validationCriteria: ['The model-issued remote read returns the selected Project marker under the Task lease.'],
  });
  stage = 'begin-task';
  const begun = await runtime.taskAdmissions.beginForHuman(proposal.id, {
    expectedRevision: proposal.revision,
    environmentInstanceId: INSTANCE_ID,
    lead: actor,
    reason: 'Seed one Host-run Task for a mode-changing restart check.',
  });
  const taskId = begun.task.id;
  taskLeaseId = begun.task.environmentLeaseId;
  const placementBeforeRestart = begun.task.executionPlacement?.mode;
  if (taskLeaseId === undefined || placementBeforeRestart !== 'host-run' ||
      runtime.pool.getLease(taskLeaseId)?.holderKind !== 'task' || runtime.pool.getLease(taskLeaseId)?.state !== 'active') {
    throw new Error('initial-task-placement-or-lease-mismatch');
  }
  stage = 'advance-host-run-task';
  const advanced = await runtime.taskAdmissions.advanceForHuman(taskId, {
    targetAgentId: 'scout',
    reason: 'Record one Host-run read before restart.',
    prompt: `Use remote_read exactly once to read ${taskPath}. Report only the marker returned. Do not use any other tool.`,
  });
  stage = 'settle-initial-run';
  const runBeforeRestart = await waitForBounded(runtime.orchestrator.waitFor(advanced.runId));
  stage = 'verify-seeded-task';
  const taskBeforeRestart = await runtime.tasks.get(taskId);
  const linksBeforeRestart = (await runtime.tasks.getWithRuns(taskId))?.runs ?? [];
  const leaseActiveBeforeRestart = runtime.pool.getLease(taskLeaseId)?.state === 'active';
  const taskIdleBeforeRestart = taskBeforeRestart?.environmentLifecycleState === 'idle';
  diagnosticFacts = {
    runStatusBeforeRestart: runBeforeRestart.status,
    operationCount: operations.length,
    operationStatuses: operations.map(item => item.status),
    operationFailures: operations.map(item => item.failure),
    operationPathsMatched: operations.map(item => item.pathMatched),
    operationMarkersMatched: operations.map(item => item.markerMatched),
    operationTaskLeasesHeld: operations.map(item => item.taskLeaseHeld),
    taskLifecycleBeforeRestart: taskBeforeRestart?.environmentLifecycleState ?? 'missing',
    taskPlacementBeforeRestart: taskBeforeRestart?.executionPlacement?.mode ?? 'missing',
    taskLeaseActiveBeforeRestart: leaseActiveBeforeRestart,
    taskRunLinkCountBeforeRestart: linksBeforeRestart.length,
  };
  if (runBeforeRestart.status !== 'completed' || operations.length !== 1 || operations[0]?.status !== 'completed' ||
      operations[0]?.markerMatched !== true || operations[0]?.taskLeaseHeld !== true || !leaseActiveBeforeRestart ||
      !taskIdleBeforeRestart || linksBeforeRestart.length !== 1) {
    throw new Error('seeded-host-run-task-did-not-settle');
  }
  stage = 'close-seeded-runtime';
  await runtime.close();
  runtime = undefined;
  operatorCredential = randomBytes(32).toString('hex');

  stage = 'start-host-run-service';
  await startService('host-run');
  const hostRunSession = await signIn();
  const taskAfterHostRunStartup = await readTaskFromService(taskId, hostRunSession);
  const hostRunLeaseState = persistedLeaseState(taskLeaseId);
  const hostRunStartupModeReported = serviceOutput.includes('execution:  host-run');
  const hostRunStartupPreserved = taskAfterHostRunStartup.task.environmentLeaseId === taskLeaseId &&
    (taskAfterHostRunStartup.task.executionPlacement as { mode?: string } | undefined)?.mode === 'host-run' &&
    taskAfterHostRunStartup.task.environmentLifecycleState === 'recovery' && hostRunLeaseState === 'recovering' &&
    taskAfterHostRunStartup.runs.length === 1 && taskAfterHostRunStartup.runs[0]?.runId === advanced.runId &&
    taskAfterHostRunStartup.runs[0]?.summary?.status === 'completed';

  stage = 'restart-environment-hosted-service';
  await stopService();
  await startService('environment-hosted');
  const environmentHostedSession = await signIn();
  const taskAfterModeChange = await readTaskFromService(taskId, environmentHostedSession);
  const leaseStateAfterModeChange = persistedLeaseState(taskLeaseId);
  const environmentHostedStartupModeReported = serviceOutput.includes('execution:  environment-hosted');
  let mismatchStatus = 0;
  let mismatchCode = 'none';
  stage = 'mismatched-task-refusal';
  const mismatchResponse = await fetch(`${serviceBase}/api/tasks/${encodeURIComponent(taskId)}/advances`, {
    method: 'POST',
    headers: {
      cookie: environmentHostedSession.cookie,
      'x-sprout-csrf': environmentHostedSession.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ targetAgentId: 'scout', reason: 'Verify the recorded Host-run Task is refused in Environment-hosted mode.' }),
  });
  mismatchStatus = mismatchResponse.status;
  const mismatchBody = await mismatchResponse.json() as { readonly code?: string };
  mismatchCode = mismatchBody.code ?? 'none';
  const taskAfterMismatch = await readTaskFromService(taskId, environmentHostedSession);
  const leaseStateAfterMismatch = persistedLeaseState(taskLeaseId);
  const samePlacement = taskAfterModeChange.task.environmentLeaseId === taskLeaseId &&
    (taskAfterModeChange.task.executionPlacement as { mode?: string } | undefined)?.mode === 'host-run';
  const sameLease = leaseStateAfterModeChange === 'recovering' && leaseStateAfterMismatch === 'recovering' &&
    taskAfterMismatch.task.environmentLeaseId === taskLeaseId;
  const mismatchRefused = mismatchStatus === 409 && mismatchCode === 'execution-mode-mismatch';
  const noReplay = taskAfterHostRunStartup.runs.length === 1 && taskAfterModeChange.runs.length === 1 &&
    taskAfterMismatch.runs.length === 1 && taskAfterMismatch.runs[0]?.runId === advanced.runId &&
    taskAfterMismatch.runs[0]?.summary?.status === 'completed' && taskAfterMismatch.task.activeRunId === undefined;
  const accepted = hostRunStartupModeReported && environmentHostedStartupModeReported && hostRunStartupPreserved &&
    samePlacement && sameLease && mismatchRefused && noReplay &&
    taskAfterModeChange.task.environmentLifecycleState === 'recovery';
  report({
    outcome: accepted ? 'host-run-task-mode-restart-passed' : 'host-run-task-mode-restart-incomplete',
    restartKind: 'production src/main.ts process restarted over the same SQLite database; Task seeded through the production Runtime composition',
    processModesReported: [hostRunStartupModeReported ? 'host-run' : 'unverified', environmentHostedStartupModeReported ? 'environment-hosted' : 'unverified'],
    taskPlacementBeforeRestart: placementBeforeRestart,
    taskPlacementAfterHostRunStartup: (taskAfterHostRunStartup.task.executionPlacement as { mode?: string } | undefined)?.mode ?? 'missing',
    taskPlacementAfterModeChange: (taskAfterModeChange.task.executionPlacement as { mode?: string } | undefined)?.mode ?? 'missing',
    taskEnvironmentInstancePreserved: taskAfterModeChange.task.environmentInstanceId === INSTANCE_ID,
    taskLeaseIdPreserved: sameLease,
    taskLeaseStates: [hostRunLeaseState, leaseStateAfterModeChange, leaseStateAfterMismatch],
    taskLifecycleAfterModeChange: taskAfterModeChange.task.environmentLifecycleState ?? 'missing',
    preRestartRunStatus: runBeforeRestart.status,
    runLinkCounts: [linksBeforeRestart.length, taskAfterHostRunStartup.runs.length, taskAfterModeChange.runs.length, taskAfterMismatch.runs.length],
    mismatchedTaskRefused: mismatchRefused,
    mismatchRefusalCode: mismatchCode,
    noReplay: noReplay,
    initialReadOperations: operations.map(item => ({ ...item })),
  });
  if (!accepted) process.exitCode = 1;
} catch (error) {
  report({ outcome: 'blocked', reason: 'bounded-restart-probe-failed', stage, ...sanitizedProbeErrorFields(error),
    ...(diagnosticFacts !== undefined ? { taskFacts: diagnosticFacts } : {}),
    ...(serviceOutput !== '' ? { serviceStartupDiagnostic: sanitizedServiceDiagnostic() } : {}) });
  process.exitCode = 2;
} finally {
  await stopService().catch(() => undefined);
  if (runtime !== undefined) await runtime.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
