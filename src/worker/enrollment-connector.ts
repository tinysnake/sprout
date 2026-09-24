/**
 * The Worker's outbound enrollment connection (#115, ADR-0012).
 *
 * A production host Worker dials the Sprout instance itself; the instance never
 * dials the Worker and never learns a host address. The Worker:
 *
 * 1. loads (or generates, once) its host-local private key and derives its
 *    public key — the private key never leaves the host;
 * 2. opens a WS/WSS connection to the instance, choosing `wss` off-loopback;
 * 3. presents its pending enrollment and the one-use claim secret read from the
 *    environment (never the command line);
 * 4. signs the core's identity challenge, proving key possession;
 * 5. hands the now-accepted bidirectional channel to the existing neutral,
 *    line-framed Worker JSON-RPC server.
 *
 * The Worker half keeps the engine and JSON-RPC detail out of authentication:
 * the handshake frames are in `gateway-protocol.ts`, and the accepted socket is
 * driven by `EnvironmentWorker` exactly as any carrier's stream is.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';

import { generateWorkerIdentity, signWorkerChallenge, validateWorkerIdentityPrivateKey } from '../environment/worker-proof.ts';
import { isLoopbackAddress } from '../environment/worker-transport.ts';
import type { WorkerEnrollmentTarget } from '../host-config.ts';
import { PRIVATE_FILE_MODE, writePrivateFile } from './host-files.ts';
import {
  encodeGatewayFrame,
  type WorkerGatewayClientFrame,
  type WorkerGatewayServerFrame,
} from './gateway-protocol.ts';

/** A duplex byte channel: both a readable and a writable stream. */
export type WorkerDuplex = Duplex;

export interface WorkerEnrollmentConnectorOptions {
  readonly target: WorkerEnrollmentTarget;
  /** The Worker protocol version this build reports. */
  readonly protocolVersion: string;
  /** The engines this Worker hosts, forwarded as neutral enrollment facts. */
  readonly engineFacts: readonly {
    readonly engine: string;
    readonly installed: boolean;
    readonly authenticated: boolean;
    readonly models: readonly string[];
  }[];
  readonly capabilityRequests?: readonly string[];
  readonly log?: (line: string) => void;
}

/** One accepted outbound channel plus the facts the Worker proved. */
export interface WorkerEnrollmentConnection {
  /** The accepted channel, now carrying the neutral Worker JSON-RPC. */
  readonly stream: WorkerDuplex;
  readonly enrollmentId: string;
  readonly environmentInstanceId: string;
  readonly epoch: number;
  readonly connectionId: string;
  close(): void;
}

/** Raised when the core refuses the enrollment connection. */
export class WorkerEnrollmentRefusedError extends Error {
  override readonly name = 'WorkerEnrollmentRefusedError';
  /** The core's neutral refusal category, when it named one. */
  readonly code: 'refused' | 'incompatible' | 'revoked';

  constructor(message: string, code: 'refused' | 'incompatible' | 'revoked' = 'refused') {
    super(message);
    this.code = code;
  }
}

/**
 * Raised when the identity is proven but a Human has not approved it yet.
 *
 * This is deliberately distinct from a refusal: the enrollment succeeded and the
 * host-local identity is now bound, so the CLI persists its configuration and a
 * later `start` reconnects once a Human approves. Treating it as a refusal would
 * tell an operator their enrollment failed when it did not (#117).
 */
export class WorkerEnrollmentPendingError extends Error {
  override readonly name = 'WorkerEnrollmentPendingError';
  /** The core's outcome code (`identity-claimed`, `duplicate-same-key`, …). */
  readonly outcome: string;
  /** The environment instance the proven identity belongs to, when disclosed. */
  readonly environmentInstanceId: string | undefined;

  constructor(outcome: string, environmentInstanceId?: string) {
    super(`the Sprout instance proved the Worker identity and is awaiting Human approval (${outcome})`);
    this.outcome = outcome;
    this.environmentInstanceId = environmentInstanceId;
  }
}

/**
 * Generate a host-local Worker identity once, then reuse it.
 *
 * The private key is written with owner-only permissions and is never read by
 * Sprout. This is the host's credential, not a portable record: a key file that
 * exists but is unreadable is an error rather than a reason to silently rotate
 * identity and orphan the approved enrollment. Only an absent file generates a
 * new identity; every other read failure is propagated.
 */
export function loadOrCreateWorkerIdentity(keyPath: string): {
  readonly privateKey: string;
  readonly generated: boolean;
} {
  let privateKey: string;
  try {
    const stat = lstatSync(keyPath);
    if (!stat.isFile() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error('the host-local Worker identity key has invalid permissions');
    }
    privateKey = readFileSync(keyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const generated = generateWorkerIdentity();
      // Owner-only, staged and renamed, so a key is never readable by other users
      // and is never observed half-written (#117).
      writePrivateFile(keyPath, generated.privateKey);
      return { privateKey: generated.privateKey, generated: true };
    }
    if (error instanceof Error && error.message.startsWith('the host-local')) throw error;
    throw new Error('the host-local Worker identity key could not be read');
  }
  validateWorkerIdentityPrivateKey(privateKey);
  return { privateKey, generated: false };
}

/** Derive the SPKI public key for a host-local private key. */
export function workerPublicKey(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/**
 * The URL this Worker dials, given its target host.
 *
 * Loopback defaults to plaintext `ws`; a non-loopback host always uses `wss`.
 * The transport rule itself lives in `worker-transport.ts` and is shared with the
 * core, so the two can never disagree.
 */
export function workerEnrollmentUrl(target: WorkerEnrollmentTarget): string {
  const loopback = isLoopbackAddress(target.host);
  const scheme = loopback ? 'ws' : 'wss';
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host;
  return `${scheme}://${host}:${target.port}/api/worker/connect`;
}

/**
 * Open the outbound connection and complete the handshake.
 *
 * A refusal from the core (unapproved identity, revoked enrollment, replayed
 * proof, plaintext off-loopback) throws a typed error, so the Worker's supervisor
 * can classify it and retry only when a retry can help.
 */
export async function connectWorkerEnrollment(
  options: WorkerEnrollmentConnectorOptions,
): Promise<WorkerEnrollmentConnection> {
  const identity = loadOrCreateWorkerIdentity(options.target.identityKeyPath);
  const publicKey = workerPublicKey(identity.privateKey);
  const { WebSocket, createWebSocketStream } = await import('ws');
  const socket = new WebSocket(workerEnrollmentUrl(options.target));
  const stream = await new Promise<WorkerDuplex>((resolve, reject) => {
    socket.on('open', () => resolve(createWebSocketStream(socket) as unknown as WorkerDuplex));
    socket.on('error', (error: Error) => reject(error));
  });  options.log?.(
    identity.generated
      ? 'generated a host-local Worker identity'
      : 'loaded the host-local Worker identity',
  );

  const reader = new CoreFrameReader(stream);
  const hello: WorkerGatewayClientFrame = {
    type: 'worker/hello',
    enrollmentId: options.target.enrollmentId,
    ...(options.target.claimSecret !== undefined ? { claimSecret: options.target.claimSecret } : {}),
  };
  write(stream, hello);

  try {
    for (;;) {
      const frame = await reader.next();
      if (frame === undefined) {
        throw new WorkerEnrollmentRefusedError('the Sprout instance closed the connection during enrollment');
      }
      if (frame.type === 'worker/claim-required') {
        if (options.target.claimSecret === undefined) {
          throw new WorkerEnrollmentRefusedError(
            'the enrollment requires a one-use claim secret, but none is configured',
          );
        }
        write(stream, { type: 'worker/claim', claimSecret: options.target.claimSecret });
        continue;
      }
      if (frame.type === 'worker/challenged') {
        const signature = signWorkerChallenge(identity.privateKey, {
          enrollmentId: frame.challenge.enrollmentId,
          nonce: frame.challenge.nonce,
        });
        write(stream, {
          type: 'worker/prove',
          proof: { challengeId: frame.challenge.id, publicKey, signature },
          platform: processPlatform(),
          protocolVersion: options.protocolVersion,
          ...(options.capabilityRequests !== undefined ? { capabilityRequests: options.capabilityRequests } : {}),
          engineFacts: options.engineFacts,
        });
        continue;
      }
      if (frame.type === 'worker/accepted') {
        // Acknowledge, then wait for the core's registration barrier so the
        // caller never uses the channel before the core can route to it.
        write(stream, { type: 'worker/ready' });
        const listening = await reader.next();
        if (listening === undefined || listening.type !== 'worker/listening') {
          throw new WorkerEnrollmentRefusedError('the Sprout instance did not confirm the accepted channel');
        }
        reader.dispose();
        return {
          stream,
          enrollmentId: frame.enrollmentId,
          environmentInstanceId: frame.environmentInstanceId,
          epoch: frame.epoch,
          connectionId: frame.connectionId,
          close: () => socket.close(),
        };
      }
      // `worker/pending` is terminal for this attempt but not a refusal: the
      // identity is bound and only Human approval remains (#117).
      if (frame.type === 'worker/pending') {
        socket.close();
        throw new WorkerEnrollmentPendingError(frame.outcome, frame.environmentInstanceId);
      }
      const reason = frame.type === 'worker/refused' ? frame.reason : 'the Sprout instance refused the connection';
      const code = frame.type === 'worker/refused' ? (frame.code ?? 'refused') : 'refused';
      socket.close();
      throw new WorkerEnrollmentRefusedError(reason, code);
    }
  } catch (error) {
    reader.dispose();
    socket.close();
    throw error;
  }
}

function processPlatform(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'container';
  }
}

function write(stream: WorkerDuplex, frame: WorkerGatewayClientFrame): void {
  stream.write(encodeGatewayFrame(frame));
}

/** Read the core's handshake frames from the accepted stream. */
class CoreFrameReader {
  #buffer = '';
  #queue: WorkerGatewayServerFrame[] = [];
  #waiters: ((frame: WorkerGatewayServerFrame | undefined) => void)[] = [];
  #ended = false;
  #onData: (chunk: Buffer | string) => void;
  #onEnd: () => void;
  #onClose: () => void;
  #onError: () => void;
  readonly #stream: WorkerDuplex;

  constructor(stream: WorkerDuplex) {
    this.#stream = stream;
    this.#onData = (chunk) => this.#receive(chunk.toString());
    this.#onEnd = () => this.#finish();
    this.#onClose = () => this.#finish();
    this.#onError = () => this.#finish();
    stream.on('data', this.#onData);
    stream.on('end', this.#onEnd);
    stream.on('close', this.#onClose);
    stream.on('error', this.#onError);
  }

  next(): Promise<WorkerGatewayServerFrame | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  dispose(): void {
    // The stream now carries JSON-RPC; stop consuming and detach so the Worker
    // server owns every subsequent line.
    if (this.#ended) return;
    this.#ended = true;
    this.#stream.removeListener('data', this.#onData);
    this.#stream.removeListener('end', this.#onEnd);
    this.#stream.removeListener('close', this.#onClose);
    this.#stream.removeListener('error', this.#onError);
    this.#stream.pause();
    const remainder = this.#buffer;
    this.#buffer = '';
    this.#queue = [];
    if (remainder.length > 0) {
      this.#stream.unshift(remainder);
    }
    this.#stream.once('newListener', (event) => {
      if (event === 'data') {
        process.nextTick(() => this.#stream.resume());
      }
    });
  }

  #receive(chunk: string): void {
    if (this.#ended) return;
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = decodeCoreFrame(line);
      if (frame !== undefined) {
        this.#deliver(frame);
        if (frame.type === 'worker/listening' || frame.type === 'worker/refused' || frame.type === 'worker/pending') {
          this.dispose();
          return;
        }
      }
      newline = this.#buffer.indexOf('\n');
    }
  }

  #deliver(frame: WorkerGatewayServerFrame): void {
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

function decodeCoreFrame(line: string): WorkerGatewayServerFrame | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return parsed as WorkerGatewayServerFrame;
}
