import { execFileSync } from 'node:child_process';

import type { EngineAdapter } from '../engine/port.ts';
import { CodexEngineAdapter } from '../engine/codex.ts';
import { PiEngineAdapter } from '../engine/pi.ts';
import { AgyEngineAdapter } from '../engine/agy.ts';
import { OpenCodeEngineAdapter } from '../engine/opencode.ts';
import { parseWorkerConfiguration } from '../host-config.ts';
import { EnvironmentWorker } from './server.ts';
import { serveWorkerEndpoint, WORKER_READY_PREFIX } from './carrier.ts';

/**
 * The environment worker's entry point.
 *
 * This process is what runs *inside* an environment (ADR-0003). It is started by
 * a carrier — directly for a local machine, through the container runtime for a
 * container — and it publishes its address so the core can reach it. It is
 * deliberately long-lived: the core connects once and reuses it across runs, so
 * runs after the first skip worker start and engine cold start.
 *
 * Configuration is host facts, not product decisions, so it is read once from
 * the environment by the host-configuration Module; this entry point consumes
 * the typed result and keeps only the Worker's own boundary: which carrier
 * applies, which engine adapters exist, and which startup errors a missing fact
 * produces.
 */

const {
  environmentInstanceId,
  workerHost: host,
  workerPort: port,
  workerTransport: transportMode,
  workspaceRoot,
  environmentPlatform,
  piSessionDirectory,
  readyFile: configuredReadyFile,
  engineBinaries,
} = parseWorkerConfiguration(process.env, { workingDirectory: process.cwd() });

/** Codex must be launched through its real path; a PATH symlink fails sandboxed. */
function resolveCodexBinary(): string | undefined {
  const override = engineBinaries['codex'];
  if (override !== undefined) return override;
  // Windows has no /bin/sh and no login-shell PATH; `where` is its equivalent.
  // Unlike pi's .cmd shim, the Windows codex distribution ships an .exe, so the
  // first match is the one that runs.
  const lookup = process.platform === 'win32'
    ? { file: 'where.exe', args: ['codex'] }
    : { file: '/bin/sh', args: ['-lc', 'command -v codex'] };
  try {
    const found = execFileSync(lookup.file, lookup.args, { encoding: 'utf8' }).trim();
    const first = found.split(/\r?\n/).find((line) => line.trim() !== '');
    return first === undefined ? undefined : first.trim();
  } catch {
    return undefined;
  }
}

const engines = new Map<string, EngineAdapter>();
const codexBinary = resolveCodexBinary();
if (codexBinary !== undefined) {
  /**
   * The environment's platform decides the engine's sandbox posture.
   *
   * On a shared host, Codex must stay bounded, because other agents and the
   * owner's own work are on the same machine. Inside a container the container is
   * the boundary, and Codex's own sandbox is both redundant and non-functional:
   * an unprivileged container cannot create the user namespace `bwrap` needs, so
   * every turn fails. This is a fact about the environment, so it is decided here
   * where the environment is known, not in the core.
   */
  const sandbox = environmentPlatform === 'container' ? 'danger-full-access' : 'read-only';
  engines.set(
    'codex',
    new CodexEngineAdapter({
      binaryPath: codexBinary,
      args: ['--strict-config'],
      sandbox,
    }),
  );
}

/** Pi is resolved the same way, since a worker may host either engine. */
function resolveBinary(command: string): string | undefined {
  const override = engineBinaries[command];
  if (override !== undefined) return override;
  try {
    // Windows has no /bin/sh and no login-shell PATH; `where` is its equivalent.
    const lookup = process.platform === 'win32'
      ? { file: 'where.exe', args: [command] }
      : { file: '/bin/sh', args: ['-lc', `command -v ${command}`] };
    const found = execFileSync(lookup.file, lookup.args, { encoding: 'utf8' });
    const candidates = found.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    if (candidates.length === 0) return undefined;
    if (process.platform !== 'win32') return candidates[0];
    // npm puts an extensionless sh script FIRST in `where` output; node on
    // Windows cannot execute it (found live). An .exe or .cmd actually runs.
    const executable = candidates.find((c) => /\.(exe|cmd|bat)$/i.test(c));
    return executable ?? candidates[0];
  } catch {
    return undefined;
  }
}

const piBinary = resolveBinary('pi');
if (piBinary !== undefined) {
  engines.set(
    'pi',
    new PiEngineAdapter({
      binaryPath: piBinary,
      // Sessions live under Sprout's control rather than the user's default, so
      // one agent's conversation does not depend on a machine-local store.
      ...(piSessionDirectory !== undefined ? { sessionDirectory: piSessionDirectory } : {}),
    }),
  );
}

/**
 * `agy`'s permission model is binary: auto-deny every tool, or skip all
 * permissions. Headless runs cannot prompt, so denial means the run produces
 * nothing but an empty answer.
 *
 * The owner chose skip-permissions unconditionally: `agy` runs tools with no
 * sandbox tier between denied and unrestricted. That is an accepted trade-off
 * rather than an oversight, and it is recorded in ADR-0003's terms — what a run
 * may touch is the environment's business.
 */
const agyBinary = resolveBinary('agy');
if (agyBinary !== undefined) {
  // The environment's platform decides which hook command `agy` will run: it
  // executes hooks through `sh -c` on Unix and `cmd /c` on Windows. A worker on
  // Windows is a Windows process, so the running platform is the environment's
  // platform; passing it explicitly keeps the choice a declared fact rather
  // than a hidden `process.platform` read inside the hook installer.
  const hookPlatform = process.platform === 'win32' ? 'windows' : 'posix';
  engines.set(
    'agy',
    new AgyEngineAdapter({
      binaryPath: agyBinary,
      skipPermissions: true,
      hookPlatform,
    }),
  );
}

const opencodeBinary = resolveBinary('opencode');
if (opencodeBinary !== undefined) {
  engines.set(
    'opencode',
    new OpenCodeEngineAdapter({ binaryPath: opencodeBinary }),
  );
}

if (engines.size === 0) {
  process.stderr.write('sprout worker: no engine CLI found on this host; nothing to host\n');
  process.exit(2);
}

const log = (line: string) => process.stderr.write(`[sprout-worker] ${line}\n`);

/**
 * One `EnvironmentWorker` per connection.
 *
 * Engine processes are shared at the process level through `engines`, so a
 * reconnection does not pay a cold start, while session state stays scoped to
 * the connection that owns it.
 */
if (transportMode === 'stdio') {
  // The carrier owns the channel: this process's stdio *is* the transport, so
  // there is no address to publish and nothing to listen on.
  const worker = new EnvironmentWorker({
    environmentInstanceId,
    engines,
    input: process.stdin,
    output: process.stdout,
    onLog: log,
    workspaceRoot,
  });
  process.stdin.on('error', () => undefined);
  process.stdin.on('close', () => {
    void worker.shutdown();
  });
  log(`serving over stdio as ${environmentInstanceId}, engines: ${[...engines.keys()].join(', ')}`);
} else {
  const endpoint = await serveWorkerEndpoint({
    host,
    port,
    serve: (socket) => {
      // A socket is bidirectional and satisfies both halves of the transport.
      const worker = new EnvironmentWorker({
        environmentInstanceId,
        engines,
        input: socket,
        output: socket,
        onLog: log,
        workspaceRoot,
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        void worker.shutdown();
      });
    },
  });

  // The core discovers the address from this line, which is why a real port is
  // published even for a local machine: a worker is a network endpoint, not a
  // special case (ADR-0003).
  process.stdout.write(
    `${WORKER_READY_PREFIX}${JSON.stringify({ host: endpoint.ready.host, port: endpoint.ready.port })}\n`,
  );

  // A daemon started detached (Windows WMI, no console) has no stdout to read,
  // so the readiness address is also persisted where its provisioning channel
  // can find it. Best-effort: local discovery does not depend on it.
  const readyFile = configuredReadyFile;
  if (readyFile !== undefined && readyFile !== '') {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(readyFile, JSON.stringify(endpoint.ready));
  }
  log(
    `listening on ${endpoint.ready.host}:${endpoint.ready.port} ` +
      `as ${environmentInstanceId}, engines: ${[...engines.keys()].join(', ')}`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void endpoint.close().then(() => process.exit(0));
    });
  }
}
