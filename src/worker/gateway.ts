/**
 * The enrollment-backed outbound Worker gateway (#115, ADR-0012).
 *
 * The Sprout instance never dials a Worker and never needs a host address
 * (ADR-0012). Instead a host-side Worker initiates one connection to
 * `/api/worker/connect`, and this gateway runs the machine-authentication
 * handshake before any Worker command is accepted:
 *
 * 1. the Worker presents the pending enrollment it belongs to;
 * 2. if the enrollment still has a live one-use claim, the Worker presents that
 *    secret and it is consumed exactly once;
 * 3. the core issues a short-lived, single-use identity challenge and the Worker
 *    signs it, proving possession of its host-local private key;
 * 4. only an approved enrollment is accepted, and it receives a monotonic
 *    connection epoch.
 *
 * After acceptance the **same** bidirectional channel carries the existing,
 * neutral, line-framed Worker JSON-RPC. This Module owns no engine detail: the
 * payloads are framed by `protocol.ts` and the core-side handle is the existing
 * `WorkerClient`, so there is no second, engine-specific protocol.
 *
 * The transport rule is enforced first: non-loopback plaintext is refused before
 * the handshake begins, so a downgraded carrier can never carry a Worker command.
 */

import type { Duplex } from 'node:stream';

import { LineJsonRpcTransport, type JsonRpcTransport } from '../engine/jsonrpc.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import { EnrollmentError } from '../environment/enrollment.ts';
import type { EnvironmentEnrollment } from '../environment/enrollment.ts';
import { WorkerProofError } from '../environment/worker-proof.ts';
import { decideWorkerTransport, type WorkerTransportFacts } from '../environment/worker-transport.ts';
import type { WorkerConnectionEpoch } from '../environment/worker-epoch.ts';
import { WorkerConnectionRegistry } from '../environment/worker-epoch.ts';
import { protocolCompatibility, type ProtocolVersionRange } from '../environment/readiness.ts';
import { SUPPORTED_WORKER_PROTOCOL } from '../environment/enrollment-service.ts';
import {
  encodeGatewayFrame,
  decodeGatewayFrame,
  type WorkerGatewayClientFrame,
  type WorkerGatewayServerFrame,
} from './gateway-protocol.ts';

/** The default handshake deadline: a stalled Worker cannot hold a socket open. */
export const DEFAULT_GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;

export interface WorkerGatewayOptions {
  readonly enrollments: EnvironmentEnrollmentService;
  readonly epochs?: WorkerConnectionRegistry;
  /** Milliseconds before an incomplete handshake is refused. */
  readonly handshakeTimeoutMs?: number;
  /** The Worker protocol range this core supports. */
  readonly supportedProtocol?: ProtocolVersionRange;
}

/** A refused or incomplete connection, described without leaking material. */
export interface WorkerGatewayRefusal {
  readonly accepted: false;
  readonly reason: string;
}

/** An accepted Worker connection, exposed as the existing neutral transport. */
export interface WorkerGatewayAcceptance {
  readonly accepted: true;
  readonly enrollment: EnvironmentEnrollment;
  readonly epoch: WorkerConnectionEpoch;
  /**
   * The line-framed JSON-RPC channel over the same socket. The core builds its
   * `WorkerClient` adapters from this, exactly as it does for any carrier.
   */
  readonly transport: JsonRpcTransport;
  /**
   * Subscribe to this accepted channel ending. The listener fires once when the
   * transport closes, so a cached handle can invalidate its adapters and facts
   * instead of reporting a dead channel as live (#115).
   */
  onChannelClosed(listener: () => void): () => void;
  /** End this connection and fail anything in flight. */
  close(): void;
}

export type WorkerGatewayOutcome = WorkerGatewayAcceptance | WorkerGatewayRefusal;

/**
 * Serves the machine-authentication boundary of one Worker connection.
 *
 * It is deliberately transport-agnostic: the HTTP layer produces a duplex stream
 * (from a WS/WSS socket) plus the observed transport facts, and this gateway
 * decides. That keeps the loopback/WSS rule in one place.
 */
export class WorkerGateway {
  readonly #enrollments: EnvironmentEnrollmentService;
  readonly #epochs: WorkerConnectionRegistry;
  readonly #handshakeTimeoutMs: number;
  readonly #supportedProtocol: ProtocolVersionRange;
  /** Live accepted connections per enrollment, so a new epoch can supersede. */
  readonly #live = new Map<string, { connectionId: string; transport: JsonRpcTransport }>();
  /** Live accepted connections keyed by environment instance id (#115). */
  readonly #byInstance = new Map<string, WorkerGatewayAcceptance>();
  /**
   * Accepted connections that have not finished the `worker/ready` barrier.
   *
   * They are tracked so runtime shutdown can tear them down, and their later
   * `worker/ready` is handled by re-checking epoch authority after the barrier:
   * an older in-flight connection must never register itself once a newer epoch
   * has been accepted (the readiness-barrier race).
   */
  readonly #inFlight = new Map<string, { readonly enrollmentId: string; readonly stream: Duplex }>();
  readonly #acceptListeners = new Set<(acceptance: WorkerGatewayAcceptance) => void>();

  constructor(options: WorkerGatewayOptions) {
    this.#enrollments = options.enrollments;
    this.#epochs = options.epochs ?? new WorkerConnectionRegistry();
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_GATEWAY_HANDSHAKE_TIMEOUT_MS;
    this.#supportedProtocol = options.supportedProtocol ?? SUPPORTED_WORKER_PROTOCOL;
  }

  get epochs(): WorkerConnectionRegistry {
    return this.#epochs;
  }

  /** Subscribe to accepted connections, so a port can build adapters from them. */
  onAccept(listener: (acceptance: WorkerGatewayAcceptance) => void): () => void {
    this.#acceptListeners.add(listener);
    // An already-accepted connection is replayed so a late subscriber is not
    // blind to it (a connection can arrive before the runtime subscribes).
    for (const acceptance of this.#byInstance.values()) listener(acceptance);
    return () => this.#acceptListeners.delete(listener);
  }

  /** The live accepted connection for one environment instance, if any. */
  liveFor(environmentInstanceId: string): WorkerGatewayAcceptance | undefined {
    return this.#byInstance.get(environmentInstanceId);
  }

  /**
   * Supersede every registered connection for one enrollment with a newer epoch.
   *
   * Only the registered live transport is closed here. A connection still
   * waiting on the readiness barrier is deliberately left to re-check authority
   * after that barrier: it must never be able to register itself once a newer
   * epoch exists, and destroying its stream from here would race the arrival of
   * its `worker/ready` frame.
   */
  #supersedePrior(enrollmentId: string): void {
    const previous = this.#live.get(enrollmentId);
    if (previous !== undefined) previous.transport.close();
  }

  /**
   * Run the handshake over one freshly-upgraded connection.
   *
   * The transport rule runs before any frame is read, so a non-loopback
   * plaintext connection is refused without the Worker ever being able to issue
   * a command.
   */
  async handle(stream: Duplex, facts: WorkerTransportFacts): Promise<WorkerGatewayOutcome> {
    const decision = decideWorkerTransport(facts);
    if (!decision.allowed) {
      safeWrite(stream, { type: 'worker/refused', reason: decision.reason });
      stream.destroy();
      return { accepted: false, reason: decision.reason };
    }

    const reader = new FrameReader(stream);
    try {
      return await withTimeout(this.#handshake(stream, reader), this.#handshakeTimeoutMs);
    } catch (error) {
      const reason = sanitizeReason(error);
      safeWrite(stream, { type: 'worker/refused', reason });
      reader.dispose();
      stream.destroy();
      return { accepted: false, reason };
    }
  }

  async #handshake(stream: Duplex, reader: FrameReader): Promise<WorkerGatewayOutcome> {
    const hello = await reader.next();
    if (hello === undefined || hello.type !== 'worker/hello') {
      throw new Error('the Worker must begin with a worker/hello frame');
    }
    const enrollmentId = hello.enrollmentId;
    let enrollment = await this.#enrollments.get(enrollmentId);
    if (enrollment === undefined) {
      throw new Error('unknown enrollment');
    }

    // Step 2: consume the one-use claim if this enrollment still requires it.
    if (needsClaim(enrollment)) {
      let secret = hello.claimSecret;
      if (secret === undefined) {
        safeWrite(stream, { type: 'worker/claim-required', enrollmentId });
        const claim = await reader.next();
        if (claim === undefined || claim.type !== 'worker/claim') {
          throw new Error('the Worker did not present its one-use enrollment claim');
        }
        secret = claim.claimSecret;
      }
      enrollment = await this.#enrollments.claimEnrollment(enrollmentId, secret);
    }

    // Step 3: issue a fresh, single-use identity challenge.
    const challenge = await this.#enrollments.issueChallenge(enrollmentId);
    safeWrite(stream, {
      type: 'worker/challenged',
      challenge: { id: challenge.id, enrollmentId: challenge.enrollmentId, nonce: challenge.nonce },
    });
    const prove = await reader.next();
    if (prove === undefined || prove.type !== 'worker/prove') {
      throw new Error('the Worker did not answer the identity challenge');
    }

    // Step 4: refuse a protocol mismatch before acceptance, so a Worker the core
    // cannot speak to never receives an epoch or carries a command.
    const compatibility = protocolCompatibility(prove.protocolVersion, this.#supportedProtocol);
    if (compatibility.state === 'incompatible') {
      // Record the observation (the enrollment is preserved) but do not accept.
      await this.#enrollments.connectWorker({
        enrollmentId,
        proof: prove.proof,
        connection: { state: 'reconnecting' },
        compatibility: {
          ...compatibility,
          ...(prove.protocolVersion !== undefined ? { workerProtocolVersion: prove.protocolVersion } : {}),
        },
        engines: [],
      });
      const reason = compatibility.detail ?? 'the Worker protocol is incompatible with this Sprout build';
      safeWrite(stream, { type: 'worker/refused', reason });
      reader.dispose();
      stream.end();
      return { accepted: false, reason };
    }

    const outcome = await this.#enrollments.connectWorker({
      enrollmentId,
      proof: prove.proof,
      connection: { state: 'online' },
      compatibility: {
        // The Worker's own declared version decides compatibility, so a protocol
        // mismatch blocks admission instead of being assumed compatible.
        ...compatibility,
        ...(prove.protocolVersion !== undefined ? { workerProtocolVersion: prove.protocolVersion } : {}),
      },
      engines: [],
    });

    // Step 4: only an approved identity is accepted; a proven-but-pending
    // identity waits for the Human and reconnects after approval.
    if (outcome.outcome !== 'reconnected') {
      const pending = awaitingApproval(outcome.requiresHumanApproval, outcome.outcome);
      safeWrite(stream, pending
        ? { type: 'worker/pending', enrollmentId, outcome: outcome.outcome }
        : { type: 'worker/refused', reason: 'the Worker identity is not approved for work' });
      reader.dispose();
      stream.end();
      return {
        accepted: false,
        reason: pending
          ? 'the Worker identity is proven and awaiting Human approval'
          : 'the Worker identity is not approved for work',
      };
    }

    // Accept: a newer epoch supersedes and tears down any prior registered
    // connection. A connection still waiting on the readiness barrier re-checks
    // authority after that barrier instead (see below).
    const epoch = this.#epochs.accept(enrollmentId);
    this.#supersedePrior(enrollmentId);
    this.#inFlight.set(epoch.connectionId, { enrollmentId, stream });
    safeWrite(stream, {
      type: 'worker/accepted',
      enrollmentId,
      environmentInstanceId: outcome.enrollment.environmentInstanceId,
      epoch: epoch.epoch,
      connectionId: epoch.connectionId,
    });
    // Wait for the Worker's readiness barrier before opening the JSON-RPC
    // channel. The Worker confirms it has stopped reading handshake frames, so a
    // `worker/info` request can never arrive in the same chunk as `accepted` and
    // be consumed as a handshake frame.
    let ready: WorkerGatewayClientFrame | undefined;
    try {
      ready = await reader.next();
    } finally {
      // The connection is no longer in flight once the barrier resolves or the
      // stream ends, so a failed barrier cannot leak the tracked stream.
      this.#inFlight.delete(epoch.connectionId);
    }
    if (ready === undefined || ready.type !== 'worker/ready') {
      throw new Error('the Worker did not confirm readiness after acceptance');
    }
    // Readiness-barrier race: a newer epoch may have been accepted while this
    // older connection waited. Re-check authority after the barrier, so a
    // delayed older connection can never register itself as live or routable.
    if (!this.#epochs.isCurrent(enrollmentId, epoch.connectionId)) {
      reader.dispose();
      safeWrite(stream, { type: 'worker/refused', reason: 'a newer Worker connection epoch superseded this connection' });
      stream.destroy();
      return { accepted: false, reason: 'a newer Worker connection epoch superseded this connection' };
    }
    reader.dispose();
    const channelClosedListeners = new Set<() => void>();
    const transport = new LineJsonRpcTransport({
      input: stream,
      output: stream,
      onClose: () => {
        this.#epochs.invalidate(enrollmentId, epoch.connectionId);
        if (this.#live.get(enrollmentId)?.connectionId === epoch.connectionId) {
          this.#live.delete(enrollmentId);
        }
        const live = this.#byInstance.get(outcome.enrollment.environmentInstanceId);
        if (live?.epoch.connectionId === epoch.connectionId) {
          this.#byInstance.delete(outcome.enrollment.environmentInstanceId);
        }
        for (const listener of channelClosedListeners) listener();
        channelClosedListeners.clear();
      },
    });
    this.#live.set(enrollmentId, { connectionId: epoch.connectionId, transport });
    const acceptance: WorkerGatewayAcceptance = {
      accepted: true,
      enrollment: outcome.enrollment,
      epoch,
      transport,
      onChannelClosed: (listener) => {
        channelClosedListeners.add(listener);
        return () => channelClosedListeners.delete(listener);
      },
      close: () => {
        transport.close();
        stream.destroy();
      },
    };
    // A newer epoch for the same instance supersedes the prior acceptance.
    this.#byInstance.set(outcome.enrollment.environmentInstanceId, acceptance);
    // Tell the Worker the channel is registered before it returns, so a caller
    // never observes acceptance before the core can route to it.
    safeWrite(stream, { type: 'worker/listening', epoch: epoch.epoch });
    for (const listener of this.#acceptListeners) listener(acceptance);
    return acceptance;
  }

  /** Invalidate every live connection, used on runtime shutdown. */
  close(): void {
    for (const { transport } of this.#live.values()) transport.close();
    for (const inFlight of this.#inFlight.values()) inFlight.stream.destroy();
    this.#inFlight.clear();
    this.#live.clear();
    this.#byInstance.clear();
    this.#acceptListeners.clear();
  }

  /**
   * Serve the machine-authenticated HTTP routes (#115).
   *
   * These run *before* the Human browser boundary and never read a cookie, CSRF
   * token, or Human actor. The one-use claim secret is the only credential, and
   * it is verified and consumed by the enrollment service.
   */
  async handleHttpRequest(input: {
    readonly method: string | undefined;
    readonly pathname: string;
    readonly segments: readonly string[];
    readonly readBody: () => Promise<Record<string, unknown>>;
    readonly json: (status: number, body: unknown) => void;
  }): Promise<boolean> {
    const { method, segments, json } = input;
    // POST /api/worker/enrollments/:id/claim — consume the one-use claim.
    if (
      method === 'POST' &&
      segments.length === 5 &&
      segments[0] === 'api' &&
      segments[1] === 'worker' &&
      segments[2] === 'enrollments' &&
      segments[4] === 'claim'
    ) {
      const body = await input.readBody();
      const claimSecret = typeof body.claimSecret === 'string' ? body.claimSecret : '';
      if (claimSecret === '') {
        json(400, { error: 'claimSecret is required' });
        return true;
      }
      try {
        const enrollment = await this.#enrollments.claimEnrollment(segments[3] ?? '', claimSecret);
        json(200, {
          enrollmentId: enrollment.id,
          environmentInstanceId: enrollment.environmentInstanceId,
          claimed: true,
        });
      } catch (error) {
        json(machineFailureStatus(error), { error: sanitizeReason(error) });
      }
      return true;
    }
    // Any other `/api/worker/...` path is a machine-boundary 404, never a Human
    // route fallthrough.
    if (segments[0] === 'api' && segments[1] === 'worker') {
      json(404, { error: 'unknown worker endpoint' });
      return true;
    }
    return false;
  }
}

/** Whether a Web-created enrollment still has an unconsumed claim to present. */
function needsClaim(enrollment: EnvironmentEnrollment): boolean {
  return enrollment.claim !== undefined && enrollment.claim.consumedAt === undefined;
}

/** Whether a proven-but-unapproved identity should wait for Human approval. */
function awaitingApproval(requiresHumanApproval: boolean, outcome: string): boolean {
  return (
    requiresHumanApproval &&
    (outcome === 'identity-claimed' || outcome === 'duplicate-same-key' || outcome === 'reconnected')
  );
}

/** Read newline-delimited handshake frames from a duplex stream. */
class FrameReader {
  readonly #stream: Duplex;
  #buffer = '';
  #queue: WorkerGatewayClientFrame[] = [];
  #waiters: ((frame: WorkerGatewayClientFrame | undefined) => void)[] = [];
  #ended = false;

  constructor(stream: Duplex) {
    this.#stream = stream;
    stream.on('data', (chunk: Buffer | string) => this.#receive(chunk.toString()));
    stream.on('end', () => this.#finish());
    stream.on('close', () => this.#finish());
    stream.on('error', () => this.#finish());
  }

  next(): Promise<WorkerGatewayClientFrame | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  dispose(): void {
    this.#stream.removeAllListeners('data');
    this.#stream.removeAllListeners('end');
    this.#stream.removeAllListeners('close');
    this.#stream.removeAllListeners('error');
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = decodeGatewayFrame(line);
      if (frame !== undefined) this.#deliver(frame);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #deliver(frame: WorkerGatewayClientFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(frame);
    else this.#queue.push(frame);
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters) waiter(undefined);
    this.#waiters = [];
  }
}

function safeWrite(stream: Duplex, frame: WorkerGatewayServerFrame): void {
  try {
    if (!stream.destroyed) stream.write(encodeGatewayFrame(frame));
  } catch {
    // A dead socket is already a refused connection; nothing to recover.
  }
}

function sanitizeReason(error: unknown): string {
  if (error instanceof EnrollmentError) return error.message;
  if (error instanceof WorkerProofError) {
    return `the Worker identity proof is not valid: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'the Worker connection was refused';
}

/** A machine route refusal is a precondition problem, not a server fault. */
function machineFailureStatus(error: unknown): number {
  if (error instanceof EnrollmentError && error.code === 'unknown-enrollment') return 404;
  return 409;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Worker handshake timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
