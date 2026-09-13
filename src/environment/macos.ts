import { spawn } from 'node:child_process';

/**
 * The macOS environment adapter.
 *
 * macOS is a **fixed** environment: its instance already exists and is not
 * provisioned by Sprout, so this adapter reports readiness and runs commands in
 * the instance's working directory rather than creating anything. Cloneable
 * container provisioning is a separate adapter (#4).
 *
 * What Sprout must not do is leak "this is macOS" into callers: the capability
 * list and the lease rules are the same vocabulary a container instance uses.
 */

export interface MacOsEnvironmentOptions {
  /** The absolute working directory runs execute in. */
  readonly workingDirectory: string;
  readonly commandTimeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MacOsEnvironmentAdapter {
  /** Whether the host is currently usable, without mutating it. */
  probe(): Promise<{ readonly available: boolean; readonly detail: string }>;
  /** Run one command in the environment's working directory. */
  run(command: string): Promise<CommandResult>;
}

export class MacOsEnvironment implements MacOsEnvironmentAdapter {
  readonly #options: MacOsEnvironmentOptions;

  constructor(options: MacOsEnvironmentOptions) {
    this.#options = options;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    // A read-only check: capability discovery must not require a lease (#4).
    const result = await this.run('uname -s');
    const available = result.exitCode === 0 && result.stdout.trim() === 'Darwin';
    return {
      available,
      detail: available
        ? `macOS host ready at ${this.#options.workingDirectory}`
        : `host probe failed: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    };
  }

  async run(command: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', command], {
        cwd: this.#options.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // macOS ships no `timeout`, so the deadline is enforced here rather than
      // by shelling out to a tool that may not exist.
      const timeoutMs = this.#options.commandTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr });
      });
    });
  }
}
