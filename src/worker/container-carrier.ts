import { join } from 'node:path';

import type { ChildProcess } from 'node:child_process';

import type { ContainerRuntime } from '../environment/container.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { WorkerClient, WorkerContextClient } from './client.ts';
import type { WorkerInfo } from './protocol.ts';
import type { WorkerConnection } from './carrier.ts';

/**
 * The container carrier.
 *
 * ADR-0003 says the worker protocol and its semantics are identical everywhere
 * and only the carrier differs. This is that difference: the worker is started
 * inside a container with the runtime's exec channel as its stdio, so **no port
 * is published** and there is nothing to authenticate or version-negotiate yet.
 *
 * The worker's code has to exist inside the container. It is mounted from the
 * repository rather than baked into the image, so a running container uses the
 * same worker source as the core — which is what makes a stale image a mount
 * problem rather than a silent protocol skew.
 */

export interface ContainerWorkerOptions {
  readonly runtime: ContainerRuntime;
  readonly containerName: string;
  /** The worker entry point's path inside the container. */
  readonly workerEntryPath: string;
  readonly environmentInstanceId: string;
  /** Where the worker runs inside the container. */
  readonly workingDirectory: string;
  /** Environment for the exec'd worker, e.g. a proxy and the Codex binary path. */
  readonly environment?: Record<string, string>;
  readonly label?: string;
  readonly onLog?: (line: string) => void;
}

export class ContainerCarrier {
  readonly #options: ContainerWorkerOptions;

  constructor(options: ContainerWorkerOptions) {
    this.#options = options;
  }

  /**
   * Start a worker inside the container and connect to it.
   *
   * Readiness is proven by the `worker/info` handshake itself, not by a readiness
   * line: the exec pipe *is* the channel here, so there is no address to discover.
   * The worker still prints its line for the local carrier's benefit, where an
   * address genuinely has to be found.
   */
  async start(): Promise<WorkerConnection> {
    const runtime = this.#options.runtime;
    const label = this.#options.label ?? `container:${this.#options.containerName}`;

    if (!(await runtime.exists(this.#options.containerName))) {
      throw new Error(`container instance does not exist: ${this.#options.containerName}`);
    }

    if (!execProcessAvailable(runtime)) {
      throw new Error('container runtime cannot provide an interactive exec channel');
    }

    const process = runtime.execProcess(
      this.#options.containerName,
      ['node', this.#options.workerEntryPath],
      {
        environment: {
          // The exec pipe is the channel, so the worker serves on its own stdio.
          SPROUT_WORKER_TRANSPORT: 'stdio',
          SPROUT_ENV_INSTANCE: this.#options.environmentInstanceId,
          // Tells the worker it *is* the isolation boundary, so the engine must
          // not try to build a second sandbox inside it.
          SPROUT_ENV_PLATFORM: 'container',
          // A Worker-owned root inside the mounted environment.  This is a
          // Worker configuration fact, not a Project identity or core path.
          SPROUT_WORKSPACE_ROOT: join(this.#options.workingDirectory, '.sprout-workspaces'),
          ...this.#options.environment,
        },
      },
    );

    if (!process.stdin || !process.stdout) {
      process.kill('SIGTERM');
      throw new Error(`container worker did not expose stdio (${label})`);
    }

    process.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '') this.#options.onLog?.(line);
      }
    });

    let alive = true;
    const transport = new LineJsonRpcTransport({
      input: process.stdout,
      output: process.stdin,
      onClose: () => {
        alive = false;
      },
    });

    const exited = new Promise<never>((_resolve, reject) => {
      process.on('exit', (code) => {
        alive = false;
        reject(
          new Error(`container worker exited before it was ready (${label}, code ${String(code)})`),
        );
      });
    });

    const connection = await Promise.race([WorkerClient.connect(transport), exited]).catch(
      async (error: unknown) => {
        transport.close();
        process.kill('SIGTERM');
        throw error;
      },
    );

    return {
      info: connection.info as WorkerInfo,
      adapters: connection.adapters,
      contexts: new WorkerContextClient(transport),
      get alive() {
        return alive;
      },
      close: async () => {
        alive = false;
        transport.close();
        process.kill('SIGTERM');
      },
    };
  }
}

function execProcessAvailable(
  runtime: ContainerRuntime,
): runtime is ContainerRuntime & {
  execProcess: (
    name: string,
    command: readonly string[],
    options: { environment?: Record<string, string> },
  ) => ChildProcess;
} {
  return typeof (runtime as { execProcess?: unknown }).execProcess === 'function';
}

/** Where the worker entry point lives inside a container that mounts the repo. */
export function containerWorkerEntry(mountRoot: string): string {
  return join(mountRoot, 'src', 'worker', 'main.ts');
}
