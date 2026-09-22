import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { PassThrough } from 'node:stream';

import { LineJsonRpcTransport, type JsonRpcTransport } from '../engine/jsonrpc.ts';
import type { EngineAdapter } from '../engine/port.ts';
import { WorkerClient, WorkerContextClient, WorkerReadinessClient } from './client.ts';
import type { WorkerInfo } from './protocol.ts';

/**
 * Carriers: how the core actually reaches a worker.
 *
 * ADR-0003 makes every environment a network environment: the protocol is
 * uniform and only the thing that moves bytes differs. That difference lives
 * here and nowhere else, so nothing above this module branches on whether an
 * environment is local.
 *
 * - A **local machine** is a real network endpoint: the worker listens on
 *   loopback TCP and the core connects to it. There is no in-process shortcut.
 * - A **container** is reached through the container runtime's exec channel,
 *   which needs no published port, no authentication, and no version
 *   negotiation to work at M1 size.
 */

export interface WorkerConnection {
  readonly info: WorkerInfo;
  /** One adapter per engine the worker hosts, keyed by engine id. */
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  /** Worker-owned persistent Project workspace and Task context operations. */
  readonly contexts: WorkerContextClient;
  /** Worker-hosted non-inference readiness operation. */
  readonly readiness?: WorkerReadinessClient;
  /** Whether this connection is still usable. False once the channel died. */
  readonly alive: boolean;
  /** End the carrier and fail anything still in flight. */
  close(): Promise<void>;
}

/** The line a worker prints once it is listening, so the core can find it. */
export const WORKER_READY_PREFIX = 'SPROUT_WORKER_READY ';

export interface WorkerReady {
  readonly host: string;
  readonly port: number;
}

/**
 * Starts a worker and connects to its network endpoint.
 *
 * The worker is a separate process with its own address, which is what makes a
 * local environment indistinguishable from any other by the time the core talks
 * to it.
 */
export class EndpointCarrier {
  /**
   * Launch a worker and wait for its readiness line.
   *
   * A worker that exits, or never becomes ready, produces a start error rather
   * than an empty engine list, so "unreachable" is never confused with "has no
   * engines".
   */
  static async start(options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly label: string;
    readonly readyTimeoutMs?: number;
    readonly onLog?: (line: string) => void;
  }): Promise<WorkerConnection> {
    const child = spawn(options.command, [...options.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    try {
      const ready = await waitForReady(child, options);
      return await connectEndpoint({
        createTransport: (onClose) => {
          const socket = connect({ host: ready.host, port: ready.port });
          const transport = new LineJsonRpcTransport({
            input: socket,
            output: socket,
            ...(onClose !== undefined ? { onClose } : {}),
          });
          return {
            transport,
            close: async () => {
              transport.close();
              socket.destroy();
              child.kill('SIGTERM');
            },
          };
        },
      });
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  /**
   * Run a worker inside a container through the runtime's exec channel.
   *
   * No port is published: the channel is a pipe, not a socket, which is why the
   * container case needs no authentication or version negotiation yet.
   */
  static async throughProcess(options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly label: string;
    readonly onLog?: (line: string) => void;
  }): Promise<WorkerConnection> {
    const child = spawn(options.command, [...options.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (!child.stdin || !child.stdout) {
      child.kill('SIGTERM');
      throw new Error(`worker carrier did not expose stdio (${options.label})`);
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      if (options.onLog) {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim() !== '') options.onLog(line);
        }
      } else {
        process.stderr.write(`[${options.label}] ${chunk.toString()}`);
      }
    });

    let alive = true;
    const transport = new LineJsonRpcTransport({
      input: child.stdout,
      output: child.stdin,
      onClose: () => {
        alive = false;
      },
    });

    const exited = new Promise<never>((_resolve, reject) => {
      child.on('exit', (code) => {
        alive = false;
        reject(new Error(`worker exited before it was ready (${options.label}, code ${String(code)})`));
      });
    });

    const connection = await Promise.race([
      connectWorkerTransport(transport),
      exited,
    ]).catch(async (error: unknown) => {
      transport.close();
      child.kill('SIGTERM');
      throw error;
    });

    return {
      ...connection,
      // Liveness belongs to the channel, not to any one adapter: every adapter on
      // this connection shares the same transport.
      get alive() {
        return alive;
      },
      close: async () => {
        alive = false;
        transport.close();
        child.kill('SIGTERM');
      },
    };
  }
}

async function connectEndpoint(options: {
  createTransport: (
    onClose?: (reason: string) => void,
  ) => { transport: JsonRpcTransport; close: () => Promise<void> };
}): Promise<WorkerConnection> {
  let adapters = new Map<string, WorkerClient>();
  const holder = options.createTransport((reason) => {
    for (const adapter of adapters.values()) adapter.notifyChannelClosed(reason);
  });
  const connected = await WorkerClient.connect(holder.transport);
  adapters = new Map(connected.adapters);
  let alive = true;
  for (const adapter of adapters.values()) {
    // The channel dying is what invalidates the connection.
    const watched = adapter as { alive?: boolean };
    if (watched.alive === false) alive = false;
  }
  return {
    info: connected.info,
    adapters,
    contexts: new WorkerContextClient(holder.transport),
    readiness: new WorkerReadinessClient(holder.transport),
    get alive() {
      for (const adapter of adapters.values()) {
        if ((adapter as { alive?: boolean }).alive === false) return false;
      }
      return alive;
    },
    close: holder.close,
  };
}

async function connectWorkerTransport(transport: JsonRpcTransport): Promise<{
  readonly info: WorkerInfo;
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  readonly contexts: WorkerContextClient;
  readonly readiness: WorkerReadinessClient;
}> {
  const connected = await WorkerClient.connect(transport);
  return {
    info: connected.info,
    adapters: connected.adapters,
    contexts: new WorkerContextClient(transport),
    readiness: new WorkerReadinessClient(transport),
  };
}

function waitForReady(
  child: ChildProcess,
  options: { readonly label: string; readonly readyTimeoutMs?: number; readonly onLog?: (line: string) => void },
): Promise<WorkerReady> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(
      () => reject(new Error(`worker did not become ready (${options.label})`)),
      options.readyTimeoutMs ?? 15_000,
    );

    const settle = (fn: () => void) => {
      clearTimeout(timeout);
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith(WORKER_READY_PREFIX)) {
          const parsed = JSON.parse(line.slice(WORKER_READY_PREFIX.length)) as WorkerReady;
          settle(() => resolve(parsed));
          return;
        }
        if (line !== '') options.onLog?.(line);
        newline = buffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '') options.onLog?.(line);
      }
    });

    child.on('exit', (code) => {
      settle(() =>
        reject(new Error(`worker exited before it was ready (${options.label}, code ${String(code)})`)),
      );
    });
    child.on('error', (error) => settle(() => reject(error)));
  });
}

/**
 * Serves a worker over loopback TCP.
 *
 * The core's model is that a worker is an addressable endpoint, so this is how a
 * local machine presents one, and it is deliberately the same protocol a
 * container would speak.
 */
export async function serveWorkerEndpoint(options: {
  readonly host?: string;
  readonly port?: number;
  /** A duplex socket: it is both halves of the transport. */
  readonly serve: (socket: Duplex) => void;
}): Promise<{ readonly ready: WorkerReady; readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    options.serve(socket);
  });
  const ready = await new Promise<WorkerReady>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve({ host: address.address, port: address.port });
      } else {
        reject(new Error('worker endpoint did not report an address'));
      }
    });
  });

  return {
    ready,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Sockets held open by a worker would otherwise keep the process alive.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      }),
  };
}

export { PassThrough };
