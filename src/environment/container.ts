import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';

/**
 * The container environment: cloneable instances provisioned by Sprout.
 *
 * The container is the first environment Sprout does not itself run on, which is
 * why ADR-0003's worker model exists. This module owns everything `docker`, and
 * *only* this module: the carrier uses it and the core never does.
 *
 * Facts from #4 that this module depends on and must not re-learn:
 *
 * - Docker enforces **unique names only**, not mutual exclusion, so exclusivity
 *   is Sprout's lease registry's job exactly as it is for macOS.
 * - `stop`/`start` preserves a container filesystem, `commit`/`export` captures
 *   it, and **`rm -f` is the only irrecoverable action**. Nothing here destroys a
 *   container implicitly; teardown is an explicit caller decision.
 */

const execFileAsync = promisify(execFile);

export interface ContainerAvailability {
  readonly available: boolean;
  readonly detail: string;
}

/**
 * The container runtime, as a seam.
 *
 * Keeping this an interface means the orchestrator, the lease registry, and the
 * carrier can all be tested without Docker, and a different runtime could be
 * substituted without touching anything above it.
 */
export interface ContainerRuntime {
  available(): Promise<ContainerAvailability>;
  create(options: CreateContainerOptions): Promise<void>;
  exists(name: string): Promise<boolean>;
  exec(
    name: string,
    command: readonly string[],
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface CreateContainerOptions {
  readonly name: string;
  readonly image: string;
  /** Volumes as `host:container[:mode]`. */
  readonly volumes?: readonly string[];
  readonly environment?: Record<string, string>;
  readonly labels?: Record<string, string>;
  /** The container runtime may need to reach the host, e.g. for a proxy. */
  readonly addHostGateway?: boolean;
}

export class DockerRuntime implements ContainerRuntime {
  readonly #binary: string;

  constructor(options: { readonly binary?: string } = {}) {
    this.#binary = options.binary ?? 'docker';
  }

  async available(): Promise<ContainerAvailability> {
    try {
      const { stdout } = await execFileAsync(this.#binary, ['info', '--format', '{{.ServerVersion}}']);
      return { available: true, detail: `docker server ${stdout.trim()}` };
    } catch (error) {
      return {
        available: false,
        detail: `docker is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async create(options: CreateContainerOptions): Promise<void> {
    const args = ['run', '-d', '--name', options.name];
    if (options.addHostGateway) args.push('--add-host', 'host.docker.internal:host-gateway');
    for (const volume of options.volumes ?? []) args.push('-v', volume);
    for (const [key, value] of Object.entries(options.environment ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      args.push('--label', `${key}=${value}`);
    }
    // Kept alive so a long-lived worker can be started inside it; the worker is
    // not the container's entry process, so the container must not exit when a
    // worker stops.
    args.push(options.image, 'sleep', 'infinity');
    await execFileAsync(this.#binary, args);
  }

  async exists(name: string): Promise<boolean> {
    const { stdout } = await execFileAsync(this.#binary, [
      'ps',
      '-a',
      '--filter',
      `name=^${name}$`,
      '--format',
      '{{.Names}}',
    ]);
    return stdout.split('\n').some((line) => line.trim() === name);
  }

  async exec(
    name: string,
    command: readonly string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(this.#binary, ['exec', name, ...command], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message,
      };
    }
  }

  /**
   * Start an exec with piped stdio.
   *
   * The carrier needs the *process*, not its output, because the worker protocol
   * runs over that pipe: this is the container's equivalent of spawning a worker
   * locally. It is here rather than in the carrier so the carrier stays free of
   * `docker` specifics.
   */
  execProcess(
    name: string,
    command: readonly string[],
    options: { readonly environment?: Record<string, string> } = {},
  ): ChildProcess {
    const args = ['exec', '-i'];
    for (const [key, value] of Object.entries(options.environment ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(name, ...command);
    return spawn(this.#binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async stop(name: string): Promise<void> {
    await execFileAsync(this.#binary, ['stop', name]);
  }

  async remove(name: string): Promise<void> {
    await execFileAsync(this.#binary, ['rm', '-f', name]);
  }
}

/**
 * The container environment definition.
 *
 * Capabilities declare `requiresLease` exactly as the macOS definition does, so
 * the lease registry needs no container-specific rule and the platform
 * difference stays confined to this module.
 */
export function containerEnvironmentDefinition(options: {
  readonly id: string;
  readonly image: string;
}): EnvironmentDefinition {
  return {
    id: options.id,
    platform: 'container',
    capabilities: [
      { name: 'agent-run', requiresLease: true },
      { name: 'read-only-investigation', requiresLease: false },
    ],
  };
}

export function containerEnvironmentInstance(options: {
  readonly instanceId: string;
  readonly definitionId: string;
}): EnvironmentInstance {
  return { id: options.instanceId, definitionId: options.definitionId };
}
