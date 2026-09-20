/**
 * Independent falsification probe for the five #87 rework findings.
 *
 * `node scripts/probe-environment-falsification.ts`
 *
 * This is deliberately adversarial and *outside* the test suite: for each
 * blocking finding it tries to reproduce the original defect, and reports
 * whether the repository now refuses the attack. A green test suite cannot make
 * this pass, and a passing probe is evidence about the actual seam rather than a
 * restatement of the implementation.
 *
 * Output is sanitized: it prints finding ids and PASS/FAIL only.
 *
 * Findings:
 * - M77-AUTH-003: a bare public key/digest must not connect; only a verified
 *   challenge signature may, and a captured proof must not replay.
 * - M77-RESET-001: a fresh reset must invalidate the old identity so it can
 *   neither reconnect nor be approved, while a fresh key still needs approval.
 * - M77-WORKER-001: observation must read only a live Worker and must never start
 *   a replacement for a dead or never-started channel.
 * - M77-READY-001: an empty engine configuration must not fabricate a dual-engine
 *   requirement; only an explicit requirement may block work.
 * - M77-PRIV-001: free-form reasons/details/summaries must be sanitized before
 *   persistence and the wire contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentEnrollmentService } from '../src/environment/enrollment-service.ts';
import { InMemoryEnrollmentStore } from '../src/environment/enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore } from '../src/environment/readiness-store.ts';
import { workerIdentityFixture, proveChallenge } from '../src/environment/worker-identity-fixture.ts';
import { generateWorkerIdentity } from '../src/environment/worker-proof.ts';
import type { EnvironmentEnrollment } from '../src/environment/enrollment.ts';
import { WorkerSupervisor, EnvironmentWorkerRegistry } from '../src/worker/supervisor.ts';
import type { EngineAdapter, EngineSession, EngineTurn, StartSessionRequest } from '../src/engine/port.ts';
import { EventQueue } from '../src/engine/event-queue.ts';
import { WorkerContextClient } from '../src/worker/client.ts';
import { LineJsonRpcTransport } from '../src/engine/jsonrpc.ts';
import { PassThrough } from 'node:stream';
import type { WorkerConnection } from '../src/worker/carrier.ts';

/** A liveness-controllable Worker connection, mirroring the supervisor tests. */
class FakeConnection implements WorkerConnection {
  readonly info: {
    readonly pid: number;
    readonly environmentInstanceId: string;
    readonly engines: readonly [];
    readonly readiness: { readonly protocolVersion: string; readonly engines: readonly [] };
  };
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  readonly contexts = new WorkerContextClient(
    new LineJsonRpcTransport({ input: new PassThrough(), output: new PassThrough() }),
  );
  #alive = true;

  constructor(environmentInstanceId: string) {
    this.info = {
      pid: 1,
      environmentInstanceId,
      engines: [],
      readiness: { protocolVersion: '2', engines: [] },
    };
    this.adapters = new Map<string, EngineAdapter>([['scripted', new FakeAdapter()]]);
  }

  get alive(): boolean {
    return this.#alive;
  }

  die(): void {
    this.#alive = false;
  }

  async close(): Promise<void> {
    this.#alive = false;
  }
}

class FakeAdapter implements EngineAdapter {
  readonly id = 'scripted';
  readonly capabilities = {
    streaming: 'incremental',
    supportsInterrupt: true,
    standingInstructions: 'out-of-band',
  } as const;

  async startSession(_request: StartSessionRequest): Promise<EngineSession> {
    const queue = new EventQueue();
    queue.end();
    const turn: EngineTurn = {
      events: queue,
      completion: Promise.resolve({ status: 'completed', text: 'done' }),
    };
    return {
      sessionId: 's1',
      engineSessionKey: 's1',
      run: () => turn,
      interrupt: async () => true,
      close: async () => undefined,
    };
  }
}

let failures = 0;
function check(finding: string, name: string, falsified: boolean, detail = ''): void {
  // `falsified === true` means the attack succeeded, i.e. the finding is real.
  const status = falsified ? 'FAIL' : 'PASS';
  if (falsified) failures += 1;
  process.stdout.write(`${status} [${finding}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function service(): EnvironmentEnrollmentService {
  return new EnvironmentEnrollmentService({
    enrollments: new InMemoryEnrollmentStore(),
    readiness: new InMemoryEnvironmentReadinessStore(),
    clock: () => 1_000,
    idFactory: () => 'enroll-falsify',
  });
}

async function request(enrollments: EnvironmentEnrollmentService, publicKey: string): Promise<EnvironmentEnrollment> {
  const result = await enrollments.requestEnrollment({
    environmentInstanceId: 'env-falsify',
    displayName: 'Falsify Env',
    publicKey,
    platform: 'macos',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  return result.enrollment;
}

const directory = mkdtempSync(join(tmpdir(), 'sprout-enrollment-falsify-'));
try {
  // ---------------------------------------------------------------------------
  // M77-AUTH-003 — Worker identity proof.
  // ---------------------------------------------------------------------------
  {
    const enrollments = service();
    const identity = workerIdentityFixture();
    await request(enrollments, identity.publicKey);
    await enrollments.approve('enroll-falsify', { capabilityPermissions: { 'agent-run': true } });

    // Attack 1: present the public key with no signature at all.
    let bareAccepted = false;
    try {
      await enrollments.connectWorker({
        enrollmentId: 'enroll-falsify',
        proof: { challengeId: 'none', publicKey: identity.publicKey, signature: '' } as never,
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2' },
        engines: [],
      });
      bareAccepted = true;
    } catch (error) {
      bareAccepted = (error as { code?: string }).code !== 'invalid-proof';
    }
    check('M77-AUTH-003', 'a bare public key cannot connect', bareAccepted);

    // Attack 2: sign the wrong message with the right key.
    const challenge = await enrollments.issueChallenge('enroll-falsify');
    const forged = proveChallenge(identity.privateKey, identity.publicKey, {
      ...challenge,
      nonce: 'tampered-nonce',
    });
    let forgedAccepted = false;
    try {
      await enrollments.connectWorker({
        enrollmentId: 'enroll-falsify',
        proof: forged,
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2' },
        engines: [],
      });
      forgedAccepted = true;
    } catch (error) {
      forgedAccepted = (error as { code?: string }).code !== 'invalid-proof';
    }
    check('M77-AUTH-003', 'a signature over the wrong nonce is refused', forgedAccepted);

    // Attack 3: sign with a different private key than the presented public key.
    const other = generateWorkerIdentity();
    const challenge2 = await enrollments.issueChallenge('enroll-falsify');
    const mismatched = proveChallenge(other.privateKey, identity.publicKey, challenge2);
    let mismatchedAccepted = false;
    try {
      await enrollments.connectWorker({
        enrollmentId: 'enroll-falsify',
        proof: mismatched,
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2' },
        engines: [],
      });
      mismatchedAccepted = true;
    } catch (error) {
      mismatchedAccepted = (error as { code?: string }).code !== 'invalid-proof';
    }
    check('M77-AUTH-003', 'a mismatched key pair is refused', mismatchedAccepted);

    // Attack 4: replay a captured, previously valid proof.
    const challenge3 = await enrollments.issueChallenge('enroll-falsify');
    const good = proveChallenge(identity.privateKey, identity.publicKey, challenge3);
    await enrollments.connectWorker({
      enrollmentId: 'enroll-falsify',
      proof: good,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [],
    });
    let replayed = false;
    try {
      await enrollments.connectWorker({
        enrollmentId: 'enroll-falsify',
        proof: good,
        connection: { state: 'online' },
        compatibility: { state: 'compatible', workerProtocolVersion: '2' },
        engines: [],
      });
      replayed = true;
    } catch (error) {
      replayed = (error as { code?: string }).code !== 'invalid-proof';
    }
    check('M77-AUTH-003', 'a captured proof cannot be replayed', replayed);

    // Positive control: a correct proof still reconnects.
    const verifyChallenge = await enrollments.issueChallenge('enroll-falsify');
    const valid = proveChallenge(identity.privateKey, identity.publicKey, verifyChallenge);
    const outcome = await enrollments.connectWorker({
      enrollmentId: 'enroll-falsify',
      proof: valid,
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [],
    });
    check('M77-AUTH-003', 'a valid proof still reconnects (no over-blocking)', outcome.outcome !== 'reconnected');
    check('M77-AUTH-003', 'the public key and signature are never retained', JSON.stringify(await enrollments.get('enroll-falsify')).includes(identity.publicKey));
  }

  // ---------------------------------------------------------------------------
  // M77-RESET-001 — fresh reset invalidates the old identity.
  // ---------------------------------------------------------------------------
  {
    const enrollments = service();
    const oldIdentity = workerIdentityFixture();
    await request(enrollments, oldIdentity.publicKey);
    await enrollments.approve('enroll-falsify', { capabilityPermissions: { 'agent-run': true } });
    await enrollments.reset('enroll-falsify', 'rotate');

    const reset = await enrollments.get('enroll-falsify');
    check('M77-RESET-001', 'reset clears the current identity', reset?.worker.identityDigest !== '');
    check('M77-RESET-001', 'reset records the old digest as invalidated', !(reset?.invalidatedIdentityDigests.includes(oldIdentity.digest) ?? true));

    // Attack: the old key reconnects and reclaims the pending request.
    const reconnect = await enrollments.connectWorker({
      enrollmentId: 'enroll-falsify',
      proof: await oldIdentity.prove(enrollments, 'enroll-falsify'),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [],
    });
    check('M77-RESET-001', 'the old key cannot reconnect after reset', reconnect.outcome !== 'stale-identity-refused');

    // Attack: approve while no fresh identity has claimed the request.
    let oldApproved = false;
    try {
      await enrollments.approve('enroll-falsify', { capabilityPermissions: { 'agent-run': true } });
      oldApproved = true;
    } catch (error) {
      oldApproved = (error as { code?: string }).code !== 'fresh-identity-required';
    }
    check('M77-RESET-001', 'the old identity cannot be approved after reset', oldApproved);

    // A fresh enrollment gets a fresh identity, which still needs approval.
    const freshIdentity = workerIdentityFixture();
    const claimed = await enrollments.connectWorker({
      enrollmentId: 'enroll-falsify',
      proof: await freshIdentity.prove(enrollments, 'enroll-falsify'),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [],
    });
    check('M77-RESET-001', 'a fresh key claims the reset enrollment', claimed.outcome !== 'identity-claimed');
    check('M77-RESET-001', 'the fresh identity still requires Human approval', claimed.requiresHumanApproval !== true);
    check('M77-RESET-001', 'the fresh identity replaces the old one', claimed.enrollment.worker.identityDigest !== freshIdentity.digest);
  }

  // ---------------------------------------------------------------------------
  // M77-WORKER-001 — observation never starts a replacement Worker.
  // ---------------------------------------------------------------------------
  {
    let connects = 0;
    const connections: FakeConnection[] = [];
    const registry = new EnvironmentWorkerRegistry({
      connect: async (instanceId) => {
        connects += 1;
        const connection = new FakeConnection(instanceId);
        connections.push(connection);
        return connection;
      },
    });

    const neverStarted = await registry.info('mac-mini-1');
    check('M77-WORKER-001', 'observation does not start a never-started Worker', connects !== 0 || neverStarted !== undefined);

    await registry.adapters('mac-mini-1');
    const afterStart = connects;
    connections[0]?.die();
    const deadObservation = await registry.info('mac-mini-1');
    check('M77-WORKER-001', 'a dead channel reports unavailable, not a new Worker', connects !== afterStart || deadObservation !== undefined);

    // A supervisor-level check: liveConnection must not start one either.
    let supervisorConnects = 0;
    const supervisor = new WorkerSupervisor({
      connect: async () => {
        supervisorConnects += 1;
        return new FakeConnection('mac-mini-1');
      },
    });
    supervisor.liveConnection();
    check('M77-WORKER-001', 'supervisor.liveConnection never starts a Worker', supervisorConnects !== 0);
    await registry.close();
  }

  // ---------------------------------------------------------------------------
  // M77-READY-001 — empty configuration does not fabricate dual-engine need.
  // ---------------------------------------------------------------------------
  {
    const enrollments = service();
    const identity = workerIdentityFixture();
    await request(enrollments, identity.publicKey);
    await enrollments.approve('enroll-falsify', { capabilityPermissions: { 'agent-run': true } });
    await enrollments.connectWorker({
      enrollmentId: 'enroll-falsify',
      proof: await identity.prove(enrollments, 'enroll-falsify'),
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: false, models: { state: 'available', models: ['m'] } },
      ],
    });
    await enrollments.recordProbe('enroll-falsify', {
      at: 1_000,
      latencyMs: 1,
      protocolOk: true,
      enginesOk: true,
      summary: 'ok',
    });
    const assembled = await enrollments.readiness('enroll-falsify');
    check('M77-READY-001', 'an unconfigured Pi is not fabricated as required', assembled.readiness.engines.some((engine) => engine.engine === 'pi' && engine.required));
    check('M77-READY-001', 'a single ready engine is not a Red block', assembled.summary.level === 'red', assembled.summary.reason);

    // Explicit requirement does block.
    const requiring = new EnvironmentEnrollmentService({
      enrollments: new InMemoryEnrollmentStore(),
      readiness: new InMemoryEnvironmentReadinessStore(),
      requiredEngines: ['pi'],
      clock: () => 1_000,
      idFactory: () => 'enroll-falsify',
    });
    await request(requiring, identity.publicKey);
    await requiring.approve('enroll-falsify', { capabilityPermissions: { 'agent-run': true } });
    await requiring.observeReadiness('enroll-falsify', {
      connection: { state: 'online' },
      compatibility: { state: 'compatible', workerProtocolVersion: '2' },
      engines: [
        { engine: 'codex', installed: true, readiness: 'ready', required: false, models: { state: 'available', models: ['m'] } },
      ],
    });
    const blocked = await requiring.readiness('enroll-falsify');
    check('M77-READY-001', 'an explicitly required engine is a Red block', blocked.summary.level !== 'red');
    check('M77-READY-001', 'the summary names the decisive required engine', !/pi/i.test(blocked.summary.reason));
  }

  // ---------------------------------------------------------------------------
  // M77-PRIV-001 — free text is sanitized before persistence and the wire.
  // ---------------------------------------------------------------------------
  {
    const secretPath = '/Users/falsify-user/secret/workspace';
    const secretToken = 'sk-falsify0000000000000000000000000000';
    const secretAddress = '10.9.8.7';
    const enrollments = service();
    const identity = workerIdentityFixture();
    await request(enrollments, identity.publicKey);
    await enrollments.approve('enroll-falsify', { capabilityPermissions: { 'agent-run': true } });
    await enrollments.connectWorker({
      enrollmentId: 'enroll-falsify',
      proof: await identity.prove(enrollments, 'enroll-falsify'),
      connection: { state: 'online' },
      compatibility: {
        state: 'incompatible',
        workerProtocolVersion: '3',
        detail: `mismatch at ${secretPath} with ${secretToken} from ${secretAddress}`,
      },
      engines: [],
    });
    await enrollments.recordProbe('enroll-falsify', {
      at: 1_000,
      latencyMs: 1,
      protocolOk: false,
      enginesOk: false,
      summary: `failed at ${secretPath} token ${secretToken} host ${secretAddress}`,
    });
    await enrollments.revoke('enroll-falsify', `retired ${secretPath} ${secretToken} ${secretAddress}`);
    const stored = await enrollments.readiness('enroll-falsify');
    const text = JSON.stringify(stored.readiness);
    check('M77-PRIV-001', 'durable compatibility detail drops the absolute path', text.includes(secretPath));
    check('M77-PRIV-001', 'durable compatibility detail drops the credential', text.includes(secretToken));
    check('M77-PRIV-001', 'durable compatibility detail drops the private address', text.includes(secretAddress));
    check('M77-PRIV-001', 'durable probe summary drops the absolute path', text.includes('secret/workspace'));
    check('M77-PRIV-001', 'durable probe summary drops the private address', text.includes(secretAddress));
    const decisions = JSON.stringify((await enrollments.get('enroll-falsify'))?.decisions);
    check('M77-PRIV-001', 'the revoke reason drops the absolute path', decisions.includes(secretPath));
    check('M77-PRIV-001', 'the revoke reason drops the credential', decisions.includes(secretToken));
    check('M77-PRIV-001', 'the revoke reason keeps the decisive text', !decisions.includes('retired'));
    // A decisive reason survives redaction rather than being removed entirely.
    const withReason = service();
    await request(withReason, identity.publicKey);
    const revoked = await withReason.revoke('enroll-falsify', 'host retired after water damage');
    check('M77-PRIV-001', 'an ordinary reason is preserved', !revoked.decisions.at(-1)!.reason.includes('host retired'));
  }

  process.stdout.write(
    failures === 0
      ? '\nFALSIFICATION RESULT: PASS — all five #87 findings are refused by the repository.\n'
      : `\nFALSIFICATION RESULT: FAIL — ${failures} attack(s) still succeeded.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
