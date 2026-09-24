/**
 * Shared test harness and synthetic collaborators for Sprout runtime composition tests.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { workerReadinessProbeFixture } from './worker/readiness-fixture.ts';

import type { AgentDefinition } from './agent/registry.ts';
import { InMemoryCollaborationStore } from './collaboration/store.ts';
import type { EngineAdapter } from './engine/port.ts';
import { ScriptedEngineAdapter, type ScriptedTurn } from './engine/scripted.ts';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { readinessRequirements } from './environment/readiness.ts';
import type { ReadinessObservationAuthority } from './environment/readiness-authority.ts';
import { InMemoryLeaseStore } from './environment/pool.ts';
import type { HostConfiguration } from './host-config.ts';
import type { Project } from './project/model.ts';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerReadinessFacts,
  type WorkerReadinessProbeParams,
  type WorkerReadinessProbeResult,
} from './worker/protocol.ts';
import { EnvironmentWorker } from './worker/server.ts';
import {
  connectWorkerEnrollment,
  loadOrCreateWorkerIdentity,
  workerPublicKey,
  type WorkerEnrollmentConnection,
} from './worker/enrollment-connector.ts';
import { InMemoryProjectStore } from './project/store.ts';
import { InMemorySessionKeyStore } from './run/session-key-store.ts';
import { InMemoryRunStore } from './run/store.ts';
import { InMemoryTaskStore } from './task/store.ts';
import { InMemoryOperatorSessionStore } from './auth/store.ts';
import { InMemoryEnrollmentStore } from './environment/enrollment-store.ts';
import { InMemoryEnvironmentCatalogStore } from './environment/catalog-store.ts';
import { InMemoryEnvironmentReadinessStore } from './environment/readiness-store.ts';
import { InMemoryWorkerConnectionEpochStore } from './environment/worker-epoch-store.ts';
import { InMemoryRecoveryStore } from './environment/recovery-store.ts';
import { InMemoryAgentStore } from './agent/store.ts';
import { InMemoryProjectAuthorityStore } from './project/authority-store.ts';
import { InMemoryProjectAccessStore } from './project/access-store.ts';
import {
  createSproutRuntime,
  type RuntimeEnvironment,
  type RuntimeStores,
  type SproutRuntime,
  type TaskContextWorker,
} from './runtime.ts';

export const runtimeWorkerResources = new WeakMap<
  SproutRuntime,
  Array<{ readonly worker: EnvironmentWorker; readonly connection: WorkerEnrollmentConnection }>
>();

type TestComposition = Parameters<NonNullable<Parameters<typeof createSproutRuntime>[0]['onTestComposition']>>[0];
const compositions = new WeakMap<SproutRuntime, TestComposition>();

/** Explicit private adapter injection, unavailable from the application-facing Runtime. */
export function testComposition(runtime: SproutRuntime): TestComposition {
  const composition = compositions.get(runtime);
  assert.ok(composition, 'test composition was injected');
  return composition;
}

export async function createRuntime(options: Parameters<typeof createSproutRuntime>[0]) {
  let composition: TestComposition | undefined;
  const runtime = await createSproutRuntime({ ...options,
    onTestComposition: (value) => { composition = value; options.onTestComposition?.(value); },
  });
  assert.ok(composition);
  compositions.set(runtime, composition);
  const productionClose = runtime.close.bind(runtime);
  Object.defineProperty(runtime, 'close', {
    value: async () => {
      for (const resource of runtimeWorkerResources.get(runtime) ?? []) {
        await resource.worker.shutdown().catch(() => undefined);
        resource.connection.close();
      }
      runtimeWorkerResources.delete(runtime);
      await productionClose();
    },
  });
  return runtime;
}

/** The environment instance this composition test serves. */
export const INSTANCE_ID = 'composition-instance';
export const PROJECT_ID = 'composition-project';

export function readinessAuthority(
  runtime: SproutRuntime,
  enrollmentId: string,
  connectionEpoch: number,
  environmentInstanceId?: string,
) {
  const instanceId =
    environmentInstanceId ??
    runtime.environmentCatalog.entries().find((e) => e.enrollmentId === enrollmentId)?.instanceId ??
    INSTANCE_ID;
  const authority = testComposition(runtime).workerGateway.authorizeObservation(instanceId);
  assert.ok(authority, 'an authenticated accepted Worker owns observation authority');
  assert.equal(authority.enrollmentId, enrollmentId);
  assert.equal(authority.connectionEpoch, connectionEpoch);
  return authority;
}

export const runtimePorts = new WeakMap<SproutRuntime, Promise<number>>();

export async function runtimePort(runtime: SproutRuntime): Promise<number> {
  let port = runtimePorts.get(runtime);
  if (port === undefined) {
    port = runtime.api.listen(0, '127.0.0.1').then((listening) => listening.port);
    runtimePorts.set(runtime, port);
  }
  return port;
}

/** Establish authority through the real authenticated WorkerGateway handshake. */
export async function connectRuntimeWorker(
  runtime: SproutRuntime,
  enrollmentId: string,
  identityKeyPath: string,
  readiness: () => WorkerReadinessFacts = scriptedStartupReadiness,
): Promise<WorkerEnrollmentConnection> {
  const port = await runtimePort(runtime);
  const connection = await connectWorkerEnrollment({
    target: { enrollmentId, host: '127.0.0.1', port, claimSecret: undefined, identityKeyPath },
    protocolVersion: WORKER_PROTOCOL_VERSION,
    engineFacts: [{ engine: 'scripted', installed: true, authenticated: true, models: ['scripted-model'] }],
  });
  const enrollment = await runtime.enrollments.get(enrollmentId);
  assert.ok(enrollment);
  const worker = new EnvironmentWorker({
    environmentInstanceId: enrollment.environmentInstanceId,
    engines: new Map(),
    readiness,
    input: connection.stream,
    output: connection.stream,
  });
  const resources = runtimeWorkerResources.get(runtime) ?? [];
  resources.push({ worker, connection });
  runtimeWorkerResources.set(runtime, resources);
  await waitFor(
    () => runtime.workerGateway.liveFor(enrollment.environmentInstanceId) !== undefined,
    'authenticated WorkerGateway connection',
  );
  return connection;
}

/** A complete typed host configuration for one synthetic local environment. */
export function hostConfiguration(overrides: Partial<HostConfiguration> = {}): HostConfiguration {
  const configuration: HostConfiguration = {
    databasePath: ':memory:',
    workingDirectory: '/synthetic/work',
    port: 0,
    environmentInstanceId: INSTANCE_ID,
    engineId: 'scripted',
    runtimeConfiguration: {
      agents: [agent('scout'), agent('scribe')],
      project: project(),
    },
    environmentKind: 'local',
    environmentSource: 'configured',
    containerName: 'synthetic-container',
    windowsTarget: undefined,
    windowsReadyFile: 'C:/synthetic/ready.json',
    containerMountRoot: '/synthetic/mount',
    containerCodexHome: '/synthetic/codex',
    containerProxy: {},
    windowsTunnelPort: 12741,
    windowsWorkDirectory: 'C:/synthetic/work',
    projectId: PROJECT_ID,
    leaseTtlMs: 900_000,
    operatorCredential: undefined,
  };
  return { ...configuration, ...overrides, operatorCredential: overrides.operatorCredential ?? configuration.operatorCredential };
}

export function agent(id: string): AgentDefinition {
  return { id, name: id, engine: 'scripted', capability: 'agent-run' };
}

export function project(): Project {
  return {
    id: PROJECT_ID,
    goal: 'Prove the runtime composition is reachable.',
    rules: [],
    availableEnvironmentInstanceIds: [INSTANCE_ID],
    memberships: [
      { agentId: 'scout', responsibilities: [], collaborationInstructions: '' },
      { agentId: 'scribe', responsibilities: [], collaborationInstructions: '' },
    ],
  };
}

export function startupWorkerProbe() {
  return {
    at: 1_000,
    latencyMs: 1,
    protocolOk: true,
    enginesOk: true,
    source: 'worker' as const,
    version: '1.0.0',
    summary: 'Worker non-inference readiness probe completed.',
  };
}

/** All six per-domain in-memory stores behind one closable handle. */
export interface MemoryStores extends RuntimeStores {
  readonly runsStore: InMemoryRunStore;
  readonly closes: () => number;
}

export function inMemoryStores(): MemoryStores {
  const runs = new InMemoryRunStore();
  let closes = 0;
  return {
    runs,
    leases: new InMemoryLeaseStore(),
    projects: new InMemoryProjectStore(),
    sessionKeys: new InMemorySessionKeyStore(),
    collaboration: new InMemoryCollaborationStore(),
    tasks: new InMemoryTaskStore(),
    operatorSessions: new InMemoryOperatorSessionStore(),
    enrollments: new InMemoryEnrollmentStore(),
    environmentCatalog: new InMemoryEnvironmentCatalogStore(),
    environmentReadiness: new InMemoryEnvironmentReadinessStore(),
    workerConnectionEpochs: new InMemoryWorkerConnectionEpochStore(),
    recovery: new InMemoryRecoveryStore(),
    agentIdentities: new InMemoryAgentStore(),
    projectAuthorities: new InMemoryProjectAuthorityStore(),
    projectAccess: new InMemoryProjectAccessStore(),
    runsStore: runs,
    close: () => {
      closes += 1;
    },
    closes: () => closes,
  };
}

/** A scripted environment port that records its own lifecycle calls. */
export interface ScriptedEnvironment extends RuntimeEnvironment {
  readonly closes: () => number;
}

export function scriptedEnvironment(options: {
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  readonly contexts?: TaskContextWorker;
  /** When set, `adapters` rejects, modelling an unreachable worker. */
  readonly failAdapters?: string;
  /** A scripted workspace validator; defaults to an opaque acceptance. */
  readonly validateWorkspace?: RuntimeEnvironment['validateWorkspace'];
}): ScriptedEnvironment {
  let closes = 0;
  const contexts: TaskContextWorker = options.contexts ?? {
    async prepare() {
      return { bootstrapInstructions: '' };
    },
    async recycle() {
      return undefined;
    },
  };
  return {
    async adapters() {
      if (options.failAdapters !== undefined) throw new Error(options.failAdapters);
      return options.adapters;
    },
    async contexts() {
      return contexts;
    },
    async validateWorkspace(instanceId, input) {
      if (options.validateWorkspace !== undefined) return options.validateWorkspace(instanceId, input);
      // A stable hex digest-shaped opaque identity, as a real Worker returns.
      return {
        workspaceId: createHash('sha256')
          .update(`${instanceId}\u0000${input.projectId}\u0000${input.kind}\u0000${input.path ?? ''}`)
          .digest('hex')
          .slice(0, 24),
        kind: input.kind,
        ...(input.path !== undefined ? { path: input.path } : {}),
      };
    },
    async close() {
      closes += 1;
    },
    closes: () => closes,
  };
}

export function scriptedTurn(text: string): ScriptedTurn {
  return {
    events: [{ type: 'message', text, final: true }],
    result: { status: 'completed', text },
  };
}

export interface Built {
  readonly runtime: SproutRuntime;
  readonly stores: MemoryStores;
  readonly environment: ScriptedEnvironment;
}

export async function build(
  options: {
    readonly turns?: readonly ScriptedTurn[];
    readonly configuration?: Partial<HostConfiguration>;
    readonly environment?: RuntimeEnvironment;
    /** Start the Web surface, as the host entrypoint does before reconciling. */
    readonly listen?: boolean;
  } = {},
): Promise<Built> {
  const stores = inMemoryStores();
  const environment =
    options.environment ??
    scriptedEnvironment({
      adapters: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: options.turns ?? [scriptedTurn('ok')] })],
      ]),
    });
  const runtime = await createRuntime({
    configuration: hostConfiguration(options.configuration),
    projectRoot: '/synthetic/project-root',
    environment,
    stores,
  });
  // The host entrypoint listens before reconciling and before installing
  // signals, so the composition is exercised in its started shape; the first
  // test opts out to observe the pre-listen boundary.
  if (options.listen !== false) await runtime.api.listen(0);
  return { runtime, stores, environment: environment as ScriptedEnvironment };
}

export function scriptedReadinessProbe() {
  return workerReadinessProbeFixture({
    protocolVersion: '2',
    observedAt: Date.now(),
    engines: [{ engine: 'scripted', installed: true, readiness: 'ready', modelAvailability: 'available', models: ['scripted-model'] }],
  });
}

/** Synthetic gate control only: not evidence of a live account entitlement. */
export const scriptedScope = readinessRequirements([{ engine: 'scripted', workModel: '' }]);

export function targetBoundScriptedProbe() {
  const result = scriptedReadinessProbe();
  return {
    ...result,
    readiness: { ...result.readiness, engines: result.readiness.engines.map((engine) => ({
      ...engine, targetModels: [], modelIdPresent: true,
      ...(scriptedScope.revisionsByEngine?.scripted !== undefined ? { requirementRevision: scriptedScope.revisionsByEngine.scripted } : {}),
    })) },
  };
}

export function scriptedStartupReadiness() {
  return { ...targetBoundScriptedProbe().readiness, protocolVersion: WORKER_PROTOCOL_VERSION,
    probe: { ...startupWorkerProbe(), at: Date.now() } };
}

export async function observeSyntheticReady(runtime: SproutRuntime, enrollmentId: string, _authority: ReadinessObservationAuthority) {
  if (!_authority.isCurrent()) return undefined;
  const enrollment = await runtime.enrollments.get(enrollmentId);
  assert.ok(enrollment);
  await waitFor(async () => (await runtime.enrollments.readiness(enrollmentId)).receipt !== undefined,
    'accepted Worker bootstrap readiness');
  return (await runtime.enrollments.readiness(enrollmentId)).receipt;
}

/** A helper that enrolls, approves, and makes eligible one instance. */
export async function enrollEligibleInstance(
  runtime: SproutRuntime,
  instanceId: string,
  identityKeyPath: string,
): Promise<string> {
  const identity = loadOrCreateWorkerIdentity(identityKeyPath);
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: instanceId,
    displayName: instanceId,
    publicKey: workerPublicKey(identity.privateKey),
    platform: 'macos',
    capabilityRequests: [ADMISSION_CAPABILITY],
    engineFacts: [],
  });
  const enrollmentId = requested.enrollment.id;
  await runtime.enrollments.approve(enrollmentId, {
    capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
  });
  await connectRuntimeWorker(runtime, enrollmentId, identityKeyPath);
  const epoch = runtime.workerGateway.currentConnectionEpoch(enrollmentId)!;
  await observeSyntheticReady(runtime, enrollmentId,
    readinessAuthority(runtime, enrollmentId, epoch));
  await runtime.refreshEnvironmentCatalog();
  return enrollmentId;
}

/** Poll a predicate with a bounded deadline, so an async observer can settle. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  // The complete suite exercises browser builds alongside this real WS
  // composition. Keep the assertion bounded, but leave enough scheduler room
  // for the Worker to install its JSON-RPC server after the accepted transport.
  const deadline = Date.now() + 60_000;
  let delayMs = 10;
  const timeout = () => new Error(`timed out waiting for ${description}`);
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(predicate),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout()), remainingMs);
        }),
      ]);
      if (Date.now() >= deadline) throw timeout();
      if (result) return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(1, deadline - Date.now()))));
    delayMs = Math.min(delayMs * 2, 250);
  }
  throw timeout();
}

export async function readinessWorkflowHarness(options: {
  readonly backend: 'memory' | 'sqlite';
  readonly directory: string;
  readonly agents?: readonly AgentDefinition[];
  /** The configured engine this build's use requires (defaults to `scripted`). */
  readonly engineId?: string;
  /** Reopen the same durable enrollment instead of creating a second one. */
  readonly reopen?: boolean;
}): Promise<{
  readonly runtime: SproutRuntime;
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
  connect(
    enrollmentId: string,
    keyPath: string,
    worker?: {
      readonly readiness?: () => WorkerReadinessFacts;
      readonly readinessProbe?: (params: WorkerReadinessProbeParams) => Promise<WorkerReadinessProbeResult>;
      readonly engines?: ReadonlyMap<string, EngineAdapter>;
    },
    /** Dial protocol version, so an incompatible handshake can be composed. */
    dialProtocolVersion?: string,
  ): Promise<WorkerEnrollmentConnection>;
  close(): Promise<void>;
}> {
  const { connectWorkerEnrollment, loadOrCreateWorkerIdentity, workerPublicKey } = await import(
    './worker/enrollment-connector.ts'
  );
  const { EnvironmentWorker } = await import('./worker/server.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./worker/protocol.ts');
  const { signWorkerChallenge } = await import('./environment/worker-proof.ts');
  const credential = randomBytes(16).toString('base64url');
  const configuredEngineId = options.engineId ?? options.agents?.[0]?.engine;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      databasePath: join(options.directory, 'sprout.db'),
      environmentSource: 'enrollment',
      operatorCredential: credential,
      ...(configuredEngineId !== undefined ? { engineId: configuredEngineId } : {}),
      ...(options.agents !== undefined
        ? { runtimeConfiguration: { agents: [...options.agents] } }
        : {}),
    }),
    projectRoot: '/synthetic/project-root',
    ...(options.backend === 'memory' ? { stores: inMemoryStores() } : {}),
  });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const session = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(session.status, 201);
  const cookie = (session.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await session.json()) as { csrfToken: string };

  // Claim with the host key, prove possession, approve, then accept the Worker.
  const workers: EnvironmentWorker[] = [];
  const connections: WorkerEnrollmentConnection[] = [];

  if (!options.reopen) {
    const requested = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID,
      displayName: 'Workflow Host',
      platform: 'macos',
      capabilityRequests: [ADMISSION_CAPABILITY],
      engineFacts: [],
    });
    const enrollmentId = requested.enrollment.id;
    const keyPath = join(options.directory, 'worker-key.pem');
    const host = loadOrCreateWorkerIdentity(keyPath);
    await runtime.enrollments.claimEnrollment(enrollmentId, requested.claim?.secret ?? '');
    const challenge = await runtime.enrollments.issueChallenge(enrollmentId);
    await runtime.enrollments.connectWorker({
      enrollmentId,
      proof: {
        challengeId: challenge.id,
        publicKey: workerPublicKey(host.privateKey),
        signature: signWorkerChallenge(host.privateKey, challenge),
      },
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: WORKER_PROTOCOL_VERSION },
      engines: [],
    });
    await runtime.enrollments.approve(enrollmentId, {
      capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
    });
  }

  return {
    runtime,
    base,
    cookie,
    csrf: csrfToken,
    async connect(id, key, worker = {}, dialProtocolVersion = WORKER_PROTOCOL_VERSION) {
      const connection = await connectWorkerEnrollment({
        target: { enrollmentId: id, host: '127.0.0.1', port, claimSecret: undefined, identityKeyPath: key },
        protocolVersion: dialProtocolVersion,
        engineFacts: [{ engine: 'codex', installed: true, authenticated: true, models: [] }],
      });
      connections.push(connection);
      const declaration = worker.readiness;
      workers.push(new EnvironmentWorker({
        environmentInstanceId: INSTANCE_ID,
        workspaceRoot: join(options.directory, 'worker-workspace'),
        engines: worker.engines ?? new Map(),
        input: connection.stream,
        output: connection.stream,
        ...(declaration !== undefined ? { readiness: declaration } : {}),
        ...(worker.readinessProbe !== undefined ? { readinessProbe: worker.readinessProbe } : {}),
      }));
      return connection;
    },
    async close() {
      for (const worker of workers) await worker.shutdown().catch(() => undefined);
      for (const connection of connections) connection.close();
      await runtime.close();
    },
  };
}
