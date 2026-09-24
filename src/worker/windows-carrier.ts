import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { WorkerClient, WorkerContextClient, WorkerReadinessClient } from './client.ts';
import type { WorkerConnection } from './carrier.ts';

const execFileAsync = promisify(execFile);

/**
 * The Windows carrier: an SSH-tunnelled loopback daemon.
 *
 * ADR-0003 says every environment is a network environment and workers are
 * long-lived. On Windows that means the worker daemon is started out-of-band
 * (provisioned over SSH, detached via WMI so it outlives any SSH session), and
 * the core connects to its loopback endpoint through an SSH local forward. No
 * port is published on the LAN: the tunnel provides both transport and
 * authentication, and the daemon binds 127.0.0.1 only.
 *
 * SSH is the provisioning and debugging channel; the data path is the tunnel.
 * What this carrier owns is the tunnel's lifetime and nothing about the daemon
 * itself — starting and stopping the daemon is `scripts/deploy-windows.sh`'s
 * job, because a daemon is an operator fact, not something the core spawns.
 *
 * Facts the transport probe verified against a real host (do not re-learn):
 * - `ssh -N -L` with `ExitOnForwardFailure=yes` fails fast if the endpoint is
 *   unreachable or the port is taken.
 * - The daemon publishes its readiness address to a file (SPROUT_READY_FILE)
 *   because a detached process has no stdout to read.
 */

export interface SshTunnelCarrierOptions {
  /** The daemon's port on the Windows host (from its readiness file). */
  readonly daemonPort: number;
  /** SSH target, e.g. `user@host`. */
  readonly target: string;
  /** Local port for the forward. There is no ephemeral option: ssh does not
   * report a chosen port for `-L 0:...`, so guessing would be dishonest. */
  readonly localPort: number;
  readonly label?: string;
  readonly onLog?: (line: string) => void;
}

export class SshTunnelCarrier {
  readonly #options: SshTunnelCarrierOptions;

  constructor(options: SshTunnelCarrierOptions) {
    this.#options = options;
  }

  async start(): Promise<WorkerConnection> {
    const label = this.#options.label ?? `windows:${this.#options.target}`;

    const localPort = this.#options.localPort;
    const forwardArgs = [
      '-N',
      '-L',
      `${localPort}:127.0.0.1:${this.#options.daemonPort}`,
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      this.#options.target,
    ];

    const tunnel: ChildProcess = spawn('ssh', forwardArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    // The forward is established asynchronously; the handshake below is the
    // authoritative proof, so just give ssh a moment and fail on early exit.
    const actualLocalPort = localPort;
    const tunnelReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2_000);
      tunnel.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`ssh tunnel exited before the forward was ready (${label}, code ${String(code)})`));
      });
    });

    if (tunnel.exitCode !== null || tunnel.signalCode !== null) {
      throw new Error(`ssh tunnel exited immediately (${label}); is the daemon reachable?`);
    }

    try {
      await tunnelReady;
      const connectToEndpoint = (): Promise<{ socket: import('node:net').Socket }> =>
        new Promise((resolve, reject) => {
          const socket = connect({ host: '127.0.0.1', port: actualLocalPort });
          socket.once('connect', () => resolve({ socket }));
          socket.once('error', reject);
        });

      // The handshake itself proves the path: if the daemon is not listening on
      // the far side, the connect succeeds (ssh accepts locally) but the first
      // request hangs or the channel closes.
      const firstBytes = await new Promise<{ socket: import('node:net').Socket; data: string }>((resolve, reject) => {
        void connectToEndpoint().then(({ socket }) => {
          socket.setTimeout(10_000, () => {
            socket.destroy();
            reject(new Error(`worker/info handshake timed out through the tunnel (${label})`));
          });
          let buffer = '';
          socket.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            if (buffer.includes('\n')) resolve({ socket, data: buffer });
          });
          socket.on('error', reject);
          socket.write(
            JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'worker/info', params: {} }) + '\n',
          );
        }).catch(reject);
      });

      // We consumed the handshake with a raw socket; hand the SAME socket to the
      // transport so the protocol state stays consistent.
      const socket = firstBytes.socket;
      socket.setTimeout(0);
      const transport = new LineJsonRpcTransport({
        input: socket,
        output: socket,
        onClose: () => {
          void this.#options.onLog?.('tunnel channel closed');
        },
      });
      void firstBytes.data;

      const connected = await WorkerClient.connect(transport);
      let alive = true;

      tunnel.on('exit', () => {
        alive = false;
      });

      return {
        info: connected.info,
        adapters: connected.adapters,
        contexts: new WorkerContextClient(transport),
        readiness: new WorkerReadinessClient(transport),
        get alive() {
          return alive;
        },
        close: async () => {
          alive = false;
          transport.close();
          socket.destroy();
          tunnel.kill('SIGTERM');
        },
      };
    } catch (error) {
      tunnel.kill('SIGTERM');
      throw error;
    }
  }
}

/** Reads the daemon's readiness file over SSH. Provisioning channel only. */
export async function readWindowsReadyFile(options: {
  readonly target: string;
  readonly remotePath: string;
}): Promise<{ readonly host: string; readonly port: number }> {
  const { stdout } = await execFileAsync(
    'ssh',
    ['-o', 'BatchMode=yes', '-T', options.target, 'Get-Content', options.remotePath],
    { timeout: 15_000 },
  );
  const match = stdout.match(/\{[\s\S]*\}/);
  if (match === null) throw new Error(`readiness file held no JSON: '${stdout.trim()}'`);
  const parsed = JSON.parse(match[0]) as { host: string; port: number };
  return { host: parsed.host, port: parsed.port };
}
