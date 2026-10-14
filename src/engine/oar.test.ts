import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OarEngineAdapter, type OarRunnerProcess } from './oar.ts';
import { createOarMcpBridge } from './oar-mcp-bridge.ts';
import { assertSupportedNodeVersion, parseNodeMajor } from './oar-node-support.ts';
import { EngineResumeRefusedError, EngineStartError, type EngineAdapter } from './port.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';
import { WorkerRecoveryJournal } from '../worker/recovery-journal.ts';
import { EnvironmentWorker } from '../worker/server.ts';

// Keep adapter-policy tests from overlaying the developer's real Pi settings.
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const piTestAgentDir = mkdtempSync(join(tmpdir(), 'sprout-oar-test-agent-'));
const oarTestWorkingDirectory = mkdtempSync(join(tmpdir(), 'sprout-oar-test-work-'));
process.env.PI_CODING_AGENT_DIR = piTestAgentDir;
process.on('exit', () => {
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  rmSync(piTestAgentDir, { recursive: true, force: true });
  rmSync(oarTestWorkingDirectory, { recursive: true, force: true });
});

class FakeOarRunner implements OarRunnerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid = 98765;

  readonly receivedCommands: RunnerCommand[] = [];
  #exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  #errorListeners: ((err: Error) => void)[] = [];
  #buffer = '';
  #activeActivationId: string | undefined;

  killHandler?: ((signal?: NodeJS.Signals) => void) | undefined;
  ignoreDispose = false;
  readonly #onCommand: ((command: RunnerCommand, runner: FakeOarRunner) => void) | undefined;

  constructor(
    onCommand?: (command: RunnerCommand, runner: FakeOarRunner) => void,
  ) {
    this.#onCommand = onCommand;
    this.stdin.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString('utf8');
      let newline = this.#buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line) {
          const cmd = JSON.parse(line) as RunnerCommand;
          this.receivedCommands.push(cmd);
          if (cmd.op === 'prompt') this.#activeActivationId = cmd.activationId;
          if (this.#onCommand) {
            this.#onCommand(cmd, this);
          }
          if (cmd.op === 'dispose' && !this.ignoreDispose) {
            this.send({ kind: 'disposed' });
            this.exit(0);
          }
        }
        newline = this.#buffer.indexOf('\n');
      }
    });
  }

  send(msg: RunnerMessage): void {
    if (!this.stdout.writable || this.stdout.destroyed) return;
    let message = msg;
    if ((msg.kind === 'event' || msg.kind === 'turn_ended' || msg.kind === 'prompt_rejected') && msg.activationId === undefined && this.#activeActivationId !== undefined) {
      message = { ...msg, activationId: this.#activeActivationId };
    }
    this.stdout.write(`${JSON.stringify(message)}\n`);
    if (message.kind === 'turn_ended' || message.kind === 'prompt_rejected') {
      this.#activeActivationId = undefined;
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killHandler) {
      this.killHandler(signal);
      return true;
    }
    this.exit(0, signal);
    return true;
  }

  exitBeforeStdoutDrain(): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = 0;
    this.signalCode = null;
    this.stdin.end();
    for (const listener of this.#exitListeners) listener(0, null);
    setImmediate(() => {
      this.stdout.resume();
      this.stdout.end();
    });
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.end();
    this.stdout.end();
    for (const listener of this.#exitListeners) {
      listener(code, signal);
    }
  }

  emitError(err: Error): void {
    for (const listener of this.#errorListeners) {
      listener(err);
    }
  }

  on(event: 'exit' | 'error', listener: (...args: any[]) => void): this {
    if (event === 'exit') {
      this.#exitListeners.push(listener);
    } else if (event === 'error') {
      this.#errorListeners.push(listener);
    }
    return this;
  }
}

test('AC1: Node.js 24+ version enforcement refuses unsupported versions with actionable guidance', () => {
  assert.equal(parseNodeMajor('v26.11.1'), 26);
  assert.equal(parseNodeMajor('24.0.0'), 24);
  assert.equal(parseNodeMajor('23.9.0'), 23);

  // Supported version
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.0.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('26.11.1'));

  // Unsupported version refuses work before admission
  assert.throws(
    () => assertSupportedNodeVersion('22.12.0'),
    (err: Error) => {
      return (
        err.message.includes('Node.js 24+ is required by OAR') &&
        err.message.includes('detected Node.js 22.12.0') &&
        err.message.includes('upgrade Node.js to version 24.0.0 or later')
      );
    },
  );
});

test('AC2: OAR adapter maps cwd, instructions, model, effort, and resume correctly', async () => {
  let startedCommand: RunnerCommand | undefined;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      startedCommand = cmd;
      r.send({ kind: 'ready', sessionId: 'sess-123', engineSessionKey: 'native-codex-thread-1' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'read-only',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp/project-work',
    projectWorkspacePath: 'src/sub',
    instructions: 'Always use strict typing.',
    model: 'gpt-6.1-sol',
    effort: 'high',
    resumeSessionKey: 'prior-thread-99',
  });

  assert.equal(session.sessionId, 'sess-123');
  assert.equal(session.engineSessionKey, 'native-codex-thread-1');
  assert.ok(startedCommand);
  if (startedCommand.op === 'start') {
    assert.equal(startedCommand.runtimeId, 'codex');
    assert.equal(startedCommand.options.cwd, '/tmp/project-work');
    assert.deepEqual(startedCommand.options.additionalDirectories, ['src/sub']);
    assert.equal(startedCommand.options.appendSystemPrompt, 'Always use strict typing.');
    assert.equal(startedCommand.options.model, 'gpt-6.1-sol');
    assert.equal(startedCommand.options.effort, 'high');
    assert.equal(startedCommand.options.resume, 'prior-thread-99');
    assert.equal(startedCommand.hostPolicy?.sandbox, 'read-only');
  }

  await session.close();
});

test('AC2: Missing working directory is rejected at session start', async () => {
  const adapter = new OarEngineAdapter({ runtimeId: 'codex' });
  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: '' }),
    EngineStartError,
  );
});

test('AC2: Resume refusal error is properly classified so core can retry from a fresh session', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'error', code: 'session_not_found', message: 'OAR SessionNotFoundError for supplied native key' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory, resumeSessionKey: 'stale-thread-1' }),
    (err: Error) => {
      assert.ok(err instanceof EngineResumeRefusedError);
      assert.equal(err.sessionKey, 'stale-thread-1');
      return true;
    },
  );
});

test('AC2: Message text alone cannot classify a resume refusal', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'error', message: 'no rollout found for thread id saved-native-session' });
    }
  });
  const adapter = new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => runner });

  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory, resumeSessionKey: 'saved-native-session' }),
    (error: Error) => {
      assert.ok(error instanceof EngineStartError);
      assert.ok(!(error instanceof EngineResumeRefusedError));
      return true;
    },
  );
});

test('AC1 & AC2: Pi adapter maps cwd, instructions, model, effort, and resume correctly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-oar-pi-test-'));
  const canonicalDirectory = realpathSync(directory);
  let startedCommand: RunnerCommand | undefined;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      startedCommand = cmd;
      r.send({ kind: 'ready', sessionId: 'sess-pi-123', engineSessionKey: 'native-pi-key-1' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  try {
    const session = await adapter.startSession({
      agentId: 'scout',
      workingDirectory: directory,
      projectWorkspacePath: 'src/sub',
      instructions: 'Always use strict typing.',
      model: 'openai-codex/gpt-6.1-sol',
      effort: 'low',
      resumeSessionKey: 'prior-pi-session-99',
    });

    assert.equal(session.sessionId, 'sess-pi-123');
    assert.equal(session.engineSessionKey, 'native-pi-key-1');
    assert.ok(startedCommand);
    if (startedCommand.op === 'start') {
      assert.equal(startedCommand.runtimeId, 'pi');
      assert.equal(startedCommand.options.cwd, canonicalDirectory);
      // Pi SDK configures one cwd; additionalDirectories is omitted
      assert.equal(startedCommand.options.additionalDirectories, undefined);
      assert.equal(startedCommand.options.appendSystemPrompt, 'Always use strict typing.');
      assert.equal(startedCommand.options.model, 'openai-codex/gpt-6.1-sol');
      assert.equal(startedCommand.options.effort, 'low');
      assert.equal(startedCommand.options.resume, 'prior-pi-session-99');
    }

    await session.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OAR Pi leaves model and effort unconfigured so host Pi configuration supplies defaults', async () => {
  let startedCommand: RunnerCommand | undefined;
  const runner = new FakeOarRunner((cmd, currentRunner) => {
    if (cmd.op === 'start') {
      startedCommand = cmd;
      currentRunner.send({ kind: 'ready', sessionId: 'sess-pi-defaults', engineSessionKey: 'native-pi-defaults' });
    }
  });
  const adapter = new OarEngineAdapter({ runtimeId: 'pi', spawnProcess: () => runner });
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });

  assert.equal(startedCommand?.op, 'start');
  if (startedCommand?.op === 'start') {
    assert.equal(startedCommand.options.model, undefined);
    assert.equal(startedCommand.options.effort, undefined);
  }
  await session.close();
});

test('AC5: Configured custom sessionDirectory for Pi reports bounded compatibility refusal on session start', async () => {
  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    sessionDirectory: '/var/sprout/pi-sessions',
  });

  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory }),
    (err: Error) => {
      assert.ok(err instanceof EngineStartError);
      assert.match(err.message, /OAR Pi uses the host Pi session store/);
      return true;
    },
  );
});

test('AC5: Configured custom sessionDirectory for Pi refuses reuse without deleting the saved key', async () => {
  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    sessionDirectory: '/var/sprout/pi-sessions',
  });

  await assert.rejects(
    () =>
      adapter.startSession({
        agentId: 'scout',
        workingDirectory: oarTestWorkingDirectory,
        resumeSessionKey: 'prior-pi-key-1',
      }),
    (err: Error) => {
      assert.ok(err instanceof EngineStartError, 'unsupported storage is not a stale-key refusal');
      assert.match(err.message, /this run did not start.*saved Sprout session key is preserved/i);
      assert.doesNotMatch(err.message, /pi-sessions|\/var\//, 'the user-facing error does not expose a host path');
      return true;
    },
  );
});

test('Pi host-configuration seam replaces only the host config input on the same route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oar-pi-config-seam-'));
  const cwd = join(root, 'project');
  const agentDirs = [join(root, 'host-agent'), join(root, 'replacement-agent')];
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.pi'));
  for (const agentDir of agentDirs) mkdirSync(agentDir);
  const settings = join(cwd, '.pi', 'settings.json');
  const original = '{ "theme": "dark" }\n';
  writeFileSync(settings, original);
  const hostBefore = process.env.OAR_PI_AGENT_DIR;

  const capture = async (agentDir: string, sessionId: string) => {
    let startCommand: Extract<RunnerCommand, { op: 'start' }> | undefined;
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const runner = new FakeOarRunner((cmd, r) => {
      if (cmd.op === 'start') {
        startCommand = cmd;
        r.send({ kind: 'ready', sessionId, engineSessionKey: sessionId });
      }
    });
    const adapter = new OarEngineAdapter({
      runtimeId: 'pi',
      piConfigurationProvider: { resolve: () => ({ agentDir }) },
      spawnProcess: (_cmd, _args, options) => {
        spawnedEnv = options.env;
        return runner;
      },
    });
    const session = await adapter.startSession({
      agentId: 'scout',
      workingDirectory: cwd,
      instructions: 'same route input',
      model: 'fixture/provider-model',
    });
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).defaultTools, []);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).defaultTools, []);
    assert.equal(spawnedEnv?.OAR_PI_AGENT_DIR, hostBefore);
    await session.close();
    assert.equal(readFileSync(settings, 'utf8'), original);
    assert.equal(existsSync(join(agentDir, 'settings.json')), false);
    assert.equal(existsSync(join(agentDir, '.sprout-oar-policy')), false);
    return startCommand!;
  };

  try {
    const first = await capture(agentDirs[0]!, 'sess-agent-dir-a');
    const replacement = await capture(agentDirs[1]!, 'sess-agent-dir-b');
    assert.equal(first.hostPolicy?.pi?.agentDir, agentDirs[0]);
    assert.equal(replacement.hostPolicy?.pi?.agentDir, agentDirs[1]);
    assert.deepEqual(first.options, replacement.options);
    const normalizePolicy = (command: Extract<RunnerCommand, { op: 'start' }>) => {
      const { agentDir: _agentDir, ...policy } = command.hostPolicy?.pi ?? {};
      return { ...command.hostPolicy, pi: policy };
    };
    assert.deepEqual(normalizePolicy(first), normalizePolicy(replacement));
    assert.equal(process.env.OAR_PI_AGENT_DIR, hostBefore, 'Host Worker process.env must not be mutated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('AC5: Missing resume session for Pi classifies as EngineResumeRefusedError', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({
        kind: 'error',
        code: 'session_not_found',
        message: 'OAR SessionNotFoundError while opening a native Pi session',
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  await assert.rejects(
    () =>
      adapter.startSession({
        agentId: 'scout',
        workingDirectory: oarTestWorkingDirectory,
        resumeSessionKey: 'missing-pi-session-99',
      }),
    (err: Error) => {
      assert.ok(err instanceof EngineResumeRefusedError);
      assert.equal(err.sessionKey, 'missing-pi-session-99');
      return true;
    },
  );
});

test('AC4: Concurrent Pi and Codex sessions run in isolated runner processes without cross-session env or auth mutation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-concurrent-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const scriptPath = join(dir, 'env-reporter-runner.mjs');
  writeFileSync(
    scriptPath,
    `
import { createInterface } from 'node:readline';

const reportedEnv = {
  SESSION_KIND: process.env.SESSION_KIND,
  OAR_PI_AGENT_DIR: process.env.OAR_PI_AGENT_DIR,
  OAR_CODEX_SANDBOX: process.env.OAR_CODEX_SANDBOX,
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.op === 'start') {
    if (cmd.runtimeId === 'pi') {
      process.env.OAR_PI_AGENT_DIR = cmd.hostPolicy.pi.agentDir;
      reportedEnv.OAR_PI_AGENT_DIR = process.env.OAR_PI_AGENT_DIR;
    }
    process.stdout.write(JSON.stringify({
      kind: 'ready',
      sessionId: 'sess-' + (process.env.SESSION_KIND ?? 'default'),
      engineSessionKey: 'key-' + (process.env.SESSION_KIND ?? 'default'),
    }) + '\\n');
  } else if (cmd.op === 'prompt') {
    process.stdout.write(JSON.stringify({
      kind: 'prompt_accepted',
      activationId: cmd.activationId,
      seq: 1,
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      kind: 'event',
      activationId: cmd.activationId,
      event: {
        kind: 'text_delta',
        text: JSON.stringify(reportedEnv),
        sessionId: 'sess-' + (process.env.SESSION_KIND ?? 'default'),
        agentPath: [],
        seq: 2,
        receivedAt: Date.now(),
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      kind: 'turn_ended',
      activationId: cmd.activationId,
      seq: 3,
      outcome: { kind: 'completed' },
    }) + '\\n');
  } else if (cmd.op === 'dispose') {
    process.exit(0);
  }
});
`,
  );

  const piAgentDir = join(dir, 'pi-agent-isolate');
  mkdirSync(piAgentDir);

  const piAdapter = new OarEngineAdapter({
    runtimeId: 'pi',
    piConfigurationProvider: { resolve: () => ({ agentDir: piAgentDir }) },
    runnerScriptPath: scriptPath,
  });

  const codexAdapter = new OarEngineAdapter({
    runtimeId: 'codex',
    sandbox: 'read-only',
    runnerScriptPath: scriptPath,
  });

  // Start sessions concurrently in actual detached child processes
  const [piSession, codexSession] = await Promise.all([
    piAdapter.startSession({
      agentId: 'scout',
      workingDirectory: dir,
      sessionEnvironment: { SESSION_KIND: 'pi-worker' },
    }),
    codexAdapter.startSession({
      agentId: 'scout',
      workingDirectory: dir,
      sessionEnvironment: { SESSION_KIND: 'codex-worker' },
    }),
  ]);

  // Run turns concurrently and receive child-reported environments
  const [piTurn, codexTurn] = [piSession.run('Report Pi Env'), codexSession.run('Report Codex Env')];
  const [piResult, codexResult] = await Promise.all([piTurn.completion, codexTurn.completion]);

  assert.equal(piResult.status, 'completed');
  assert.equal(codexResult.status, 'completed');

  const piReported = JSON.parse(piResult.text);
  const codexReported = JSON.parse(codexResult.text);

  // Assert actual environment values observed inside the child processes
  assert.equal(piReported.SESSION_KIND, 'pi-worker', 'Pi child observed its own session environment');
  assert.equal(piReported.OAR_PI_AGENT_DIR, piAgentDir, 'Pi child observed its auth storage directory');
  assert.equal(piReported.OAR_CODEX_SANDBOX, undefined, 'Codex sandbox must not exist in Pi child process');

  assert.equal(codexReported.SESSION_KIND, 'codex-worker', 'Codex child observed its own session environment');
  assert.equal(codexReported.OAR_CODEX_SANDBOX, 'read-only', 'Codex child observed its sandbox mode');
  assert.equal(codexReported.OAR_PI_AGENT_DIR, undefined, 'Pi agent directory must not exist in Codex child process');

  // Verify Host Worker environment was never mutated
  assert.equal(process.env.SESSION_KIND, undefined, 'Host Worker process.env must not be mutated');
  assert.equal(process.env.OAR_PI_AGENT_DIR, undefined, 'Host Worker process.env must not receive OAR_PI_AGENT_DIR');
  assert.equal(process.env.OAR_CODEX_SANDBOX, undefined, 'Host Worker process.env must not receive OAR_CODEX_SANDBOX');

  // Bounded close of both real child processes
  await piSession.close();
  await codexSession.close();
});

test('AC4 (F3): Blocked runner startup triggers 25s startup deadline and cleans up child process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-startup-timeout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const scriptPath = join(dir, 'blocked-runner.mjs');
  writeFileSync(
    scriptPath,
    `
// Blocks startup by never responding to commands
setInterval(() => {}, 10_000);
`,
  );

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    runnerScriptPath: scriptPath,
  });

  const startedAt = Date.now();
  await assert.rejects(
    adapter.startSession({
      agentId: 'scout',
      workingDirectory: dir,
    }),
    (err: any) => {
      assert.ok(err instanceof EngineStartError);
      assert.match(err.message, /within timeout/i);
      return true;
    },
  );
  const elapsedMs = Date.now() - startedAt;

  // The deadline in oar.ts is 25_000 ms; assert measured bound
  assert.ok(
    elapsedMs >= 24_500 && elapsedMs <= 28_000,
    `Startup timeout fired within expected ~25s bound: ${elapsedMs}ms`,
  );
});

test('AC4 (F3): Non-cooperative interrupt escalates SIGINT -> SIGTERM -> SIGKILL with measured signal sequence and timing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-abort-escalate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const logFile = join(dir, 'signals.log');
  const scriptPath = join(dir, 'stubborn-runner.mjs');
  writeFileSync(
    scriptPath,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = process.env.SIGNAL_LOG_FILE;

process.on('SIGINT', () => {
  appendFileSync(logFile, 'SIGINT\\n');
});

process.on('SIGTERM', () => {
  appendFileSync(logFile, 'SIGTERM\\n');
});

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.op === 'start') {
    process.stdout.write(JSON.stringify({ kind: 'ready', sessionId: 'sess-esc', engineSessionKey: 'sess-esc' }) + '\\n');
  } else if (cmd.op === 'prompt') {
    process.stdout.write(JSON.stringify({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 1 }) + '\\n');
    process.stdout.write(JSON.stringify({
      kind: 'event',
      event: { kind: 'text_delta', text: 'Working...', sessionId: 'sess-esc', agentPath: [], seq: 1, receivedAt: Date.now() },
    }) + '\\n');
  } else if (cmd.op === 'abort') {
    appendFileSync(logFile, 'OP_ABORT_RECEIVED\\n');
    process.stdout.write(JSON.stringify({ kind: 'abort_result', activationId: cmd.activationId, accepted: true }) + '\\n');
    // Intentionally does NOT complete turn or exit, driving escalation
  }
});
`,
  );

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    runnerScriptPath: scriptPath,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: dir,
    sessionEnvironment: { SIGNAL_LOG_FILE: logFile },
  });

  const turn = session.run('Drive interrupt escalation');
  // Wait briefly for prompt to be accepted and work started
  await new Promise((resolve) => setTimeout(resolve, 200));

  const interruptStartedAt = Date.now();
  const interrupted = await session.interrupt();
  assert.equal(interrupted, true, 'interrupt returned true');

  const result = await turn.completion;
  const elapsedMs = Date.now() - interruptStartedAt;

  assert.equal(result.status, 'interrupted', 'Turn settled as interrupted upon escalation termination');
  assert.equal(result.outcomeCertainty, 'uncertain', 'no terminal event means the turn outcome remains uncertain');

  // Escalation timers in oar.ts:
  // 4,000ms -> SIGINT, then 2,000ms -> SIGTERM, then 2,000ms -> SIGKILL
  // Total elapsed should be around 8,000 ms (>= 7,800ms and <= 11_000ms)
  assert.ok(
    elapsedMs >= 7_800 && elapsedMs <= 11_000,
    `Escalation elapsed within expected ~8s bound: ${elapsedMs}ms`,
  );

  // Assert the child-observed signal order from real process signals
  assert.ok(existsSync(logFile), 'Signal log exists');
  const logged = readFileSync(logFile, 'utf8').trim().split('\n');
  assert.deepEqual(
    logged,
    ['OP_ABORT_RECEIVED', 'SIGINT', 'SIGTERM'],
    'Observed exact signal escalation sequence: op:abort -> SIGINT -> SIGTERM (followed by SIGKILL exit)',
  );

  await session.close();
});

test('AC4 (F3): Bounded close of non-cooperative child process terminates via SIGKILL within 1-2.5s', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-close-bound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const scriptPath = join(dir, 'stubborn-close-runner.mjs');
  writeFileSync(
    scriptPath,
    `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.op === 'start') {
    process.stdout.write(JSON.stringify({ kind: 'ready', sessionId: 'sess-close', engineSessionKey: 'sess-close' }) + '\\n');
  } else if (cmd.op === 'dispose') {
    // Intentionally ignores dispose
  }
});
`,
  );

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    runnerScriptPath: scriptPath,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: dir,
  });

  const closeStartedAt = Date.now();
  await session.close();
  const elapsedMs = Date.now() - closeStartedAt;

  // disposeTimer in oar.ts is 1_000 ms (sends SIGKILL)
  // Process should terminate shortly after 1_000 ms, well before the 2_500 ms killTimer
  assert.ok(
    elapsedMs >= 950 && elapsedMs <= 2_400,
    `Close bounded between 1s and 2.4s (terminated via SIGKILL): ${elapsedMs}ms`,
  );
});

test('AC3 & AC4: Root turn completion persists correct terminal answer and filters commentary/reasoning/child events', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-root', engineSessionKey: 'sess-root' });
    } else if (cmd.op === 'prompt') {
      // 1. Tool call
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_started',
          callId: 'call-1',
          tool: 'read',
          input: '{"path":"file.txt"}',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 1,
          receivedAt: Date.now(),
        },
      });
      // 2. Tool output
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-1',
          content: [{ type: 'text', text: 'file content' }],
          result: 'ok',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Private reasoning (MUST BE EXCLUDED)
      r.send({
        kind: 'event',
        event: {
          kind: 'reasoning',
          content: { kind: 'text', text: 'internal secret thoughts' },
          sessionId: 'sess-root',
          agentPath: [],
          seq: 3,
          receivedAt: Date.now(),
        },
      });
      // 4. Subagent / child turn text (agentPath: ['subagent'], MUST BE EXCLUDED from root reply)
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'child subagent commentary',
          sessionId: 'sess-root',
          agentPath: ['subagent'],
          seq: 4,
          receivedAt: Date.now(),
        },
      });
      // 5. Root assistant response text
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'The terminal answer.',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 5,
          receivedAt: Date.now(),
        },
      });
      // 6. Root turn ended
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
        usage: {
          total: { input: 120, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0 },
        },
      });
      // 7. Late runner event after turn ended (MUST BE IGNORED)
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'late leaked text',
          sessionId: 'sess-root',
          agentPath: [],
          seq: 6,
          receivedAt: Date.now(),
        },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Hello');

  const observedEvents: any[] = [];
  for await (const ev of turn.events) {
    observedEvents.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'The terminal answer.');
  assert.equal(result.source, 'oar');

  // Assert events streamed
  assert.deepEqual(observedEvents, [
    { type: 'tool-call', name: 'read', detail: '{"path":"<redacted-host>"}' },
    { type: 'tool-output', text: 'file content' },
    { type: 'message', text: 'The terminal answer.', final: false },
  ]);

  // Assert reasoning and child commentary never leaked into result or events
  assert.ok(!observedEvents.some(e => JSON.stringify(e).includes('internal secret thoughts')));
  assert.ok(!observedEvents.some(e => JSON.stringify(e).includes('child subagent commentary')));
  assert.ok(!observedEvents.some(e => JSON.stringify(e).includes('late leaked text')));
  assert.ok(!result.text.includes('internal secret thoughts'));
  assert.ok(!result.text.includes('child subagent commentary'));
  assert.ok(!result.text.includes('late leaked text'));

  await session.close();
});

test('AC5: Refused / busy prompt fails immediately without implicit queueing', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-busy', engineSessionKey: 'sess-busy' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_rejected', code: 'busy', reason: 'Session is currently running another turn' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Second prompt');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /OAR prompt rejected \(busy\)/);

  await session.close();
});

test('OAR ignores a non-JSON runner line and settles empty success', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-empty', engineSessionKey: 'sess-empty' });
    } else if (cmd.op === 'prompt') {
      // The retired Pi adapter accepted protocol-channel noise before settlement.
      r.stdout.write('non-JSON runner line\n');
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Silent turn');

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '');

  await session.close();
});

test('AC5: Empty error output settles with sanitized failure text', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-err', engineSessionKey: 'sess-err' });
    } else if (cmd.op === 'prompt') {
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'failed', failure: 'provider', reason: '' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Fail turn');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.status === 'failed' ? result.message : '', 'OAR turn failed');

  await session.close();
});

test('AC5: Spawn or early-exit failure settles turn without hanging', async () => {
  let currentRunner: FakeOarRunner | undefined;
  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => {
      currentRunner = new FakeOarRunner((cmd, r) => {
        if (cmd.op === 'start') {
          r.send({ kind: 'ready', sessionId: 'sess-crash', engineSessionKey: 'sess-crash' });
        } else if (cmd.op === 'prompt') {
          // Process crashes mid-turn without sending turn_ended
          queueMicrotask(() => {
            r.exit(1);
          });
        }
      });
      return currentRunner;
    },
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Crash turn');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /outcome is uncertain/i);
  assert.equal(result.status === 'failed' ? result.outcomeCertainty : undefined, 'uncertain');

  await session.close();
});

test('runner parent death leaves a surviving descendant visible until the process-group fence kills it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows process-tree proof remains an explicit platform prerequisite');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'oar-descendant-fence-'));
  const runnerPath = join(dir, 'runner.mjs');
  const childPidPath = join(dir, 'child.pid');
  let runner: OarRunnerProcess | undefined;
  let closeSession: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await closeSession?.(); } catch { /* keep test cleanup moving */ }
    if (runner?.pid !== undefined && process.platform !== 'win32') {
      try { process.kill(-runner.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(runnerPath, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.op === 'start') process.stdout.write(JSON.stringify({ kind: 'ready', sessionId: 'tree-session', engineSessionKey: 'tree-session' }) + '\\n');
  if (command.op === 'prompt') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
    process.exit(19);
  }
});
`);

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    runnerScriptPath: runnerPath,
    spawnProcess: (command, args, options) => {
      runner = spawn(command, [...args], options as unknown as Parameters<typeof spawn>[2]) as unknown as OarRunnerProcess;
      return runner;
    },
  });
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: dir });
  closeSession = () => session.close();
  const turn = session.run('Start the supervised child');
  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.outcomeCertainty, 'uncertain', 'parent death did not manufacture a terminal turn result');

  const parentPid = runner?.pid;
  assert.ok(parentPid);
  let childPid: number | undefined;
  const pidDeadline = Date.now() + 2_000;
  while (childPid === undefined && Date.now() < pidDeadline) {
    try { childPid = Number(readFileSync(childPidPath, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(childPid && Number.isSafeInteger(childPid), 'the runner recorded its surviving descendant');
  assert.doesNotThrow(() => process.kill(childPid!, 0), 'the descendant survived its parent');
  assert.doesNotThrow(() => process.kill(-parentPid!, 0), 'the runner process group still contains the descendant');

  await session.close();
  assert.equal(session.terminationEvidence, 'proved', 'close proved the whole process group empty');
  assert.throws(() => process.kill(-parentPid!, 0), { code: 'ESRCH' });
});

test('a rejected late abort preserves the terminal completed turn that wins the race', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-late-abort', engineSessionKey: 'sess-late-abort' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 1 });
    } else if (cmd.op === 'abort') {
      r.send({ kind: 'abort_result', activationId: cmd.activationId, accepted: false });
      setTimeout(() => {
        r.send({ kind: 'event', event: {
          kind: 'text_delta', text: 'actual completed answer', sessionId: 'sess-late-abort',
          agentPath: [], seq: 2, receivedAt: Date.now(),
        } });
        r.send({ kind: 'turn_ended', seq: 3, outcome: { kind: 'completed' } });
      }, 20);
    }
  });
  const adapter = new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => runner });
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Complete before the late abort');
  assert.equal(await session.interrupt(), true);
  const close = session.close();
  const result = await turn.completion;
  await close;
  assert.equal(result.status, 'completed');
  assert.equal(result.status === 'completed' ? result.text : '', 'actual completed answer');
  assert.equal(result.outcomeCertainty, undefined);
  assert.equal(session.terminationEvidence, 'proved');
});

test('terminal stdout buffered at runner exit wins before uncertain runner-loss settlement', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-exit-drain', engineSessionKey: 'sess-exit-drain' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 1 });
      r.send({ kind: 'event', activationId: cmd.activationId, event: {
        kind: 'text_delta', text: 'completed before exit', sessionId: 'sess-exit-drain',
        agentPath: [], seq: 2, receivedAt: Date.now(),
      } });
      r.stdout.pause();
      r.send({ kind: 'turn_ended', activationId: cmd.activationId, seq: 3, outcome: { kind: 'completed' } });
      r.exitBeforeStdoutDrain();
    }
  });
  const adapter = new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => runner });
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const result = await session.run('Finish before the runner exits').completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.status === 'completed' ? result.text : '', 'completed before exit');
  assert.equal(result.outcomeCertainty, undefined);
  await session.close();
  assert.equal(session.terminationEvidence, 'proved');
});

test('AC6: Bounded abort and close preserve uncertainty and settle turns as interrupted', async () => {
  let abortReceived = false;
  let disposeReceived = false;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-int', engineSessionKey: 'sess-int' });
    } else if (cmd.op === 'prompt') {
      // Running indefinitely
    } else if (cmd.op === 'abort') {
      abortReceived = true;
      r.send({ kind: 'abort_result', activationId: cmd.activationId, accepted: true });
      r.send({ kind: 'turn_ended', outcome: { kind: 'aborted' } });
    } else if (cmd.op === 'dispose') {
      disposeReceived = true;
      r.send({ kind: 'disposed' });
      r.exit(0);
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Long run');

  const interrupted = await session.interrupt();
  assert.equal(interrupted, true);
  assert.equal(abortReceived, true);

  const result = await turn.completion;
  assert.equal(result.status, 'interrupted');

  await session.close();
  assert.equal(disposeReceived, true);
  assert.equal(runner.exitCode, 0);
});

test('AC5: Multiple events sharing a single record sequence are all processed without deduplication', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-multi-seq', engineSessionKey: 'sess-multi-seq' });
    } else if (cmd.op === 'prompt') {
      // Frame containing multiple readings sharing seq 42
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-1',
          content: [{ type: 'text', text: 'finished tool' }],
          sessionId: 'sess-multi-seq',
          agentPath: [],
          seq: 42,
          receivedAt: 100,
        },
      });
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'shared seq text',
          sessionId: 'sess-multi-seq',
          agentPath: [],
          seq: 42,
          receivedAt: 100,
        },
      });
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Multi seq test');

  const events: any[] = [];
  for await (const ev of turn.events) {
    events.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'shared seq text');
  assert.deepEqual(events, [
    { type: 'tool-output', text: 'finished tool' },
    { type: 'message', text: 'shared seq text', final: false },
  ]);

  await session.close();
});

test('AC2 & Substrate: Remote workspace tools are exposed over MCP bridge to OAR session', async () => {
  let attachedMcpServers: readonly any[] | undefined;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      attachedMcpServers = cmd.options.mcpServers;
      r.send({ kind: 'ready', sessionId: 'sess-mcp', engineSessionKey: 'sess-mcp' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: oarTestWorkingDirectory,
    remoteWorkspace: {
      binding: {
        projectId: 'proj-1',
        environmentInstanceId: 'env-1',
        bindingId: 'bind-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-1',
      },
      read: async (path) => ({
        operationId: 'op-1',
        projectId: 'proj-1',
        environmentInstanceId: 'env-1',
        bindingId: 'bind-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-1',
        operation: 'read',
        status: 'completed',
        content: `file content for ${path}`,
      }),
      search: async () => ({
        operationId: 'op-2',
        projectId: 'proj-1',
        environmentInstanceId: 'env-1',
        bindingId: 'bind-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-1',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  assert.ok(attachedMcpServers);
  assert.equal(attachedMcpServers.length, 1);
  assert.equal(attachedMcpServers[0].name, 'sprout_workspace');
  assert.equal(attachedMcpServers[0].type, 'http');
  assert.ok(attachedMcpServers[0].headers?.authorization, 'MCP server must configure authorization header for OAR');

  const authHeaders = {
    'Content-Type': 'application/json',
    authorization: attachedMcpServers[0].headers.authorization,
  };

  try {
    // Query the MCP server over HTTP to prove it functions
    const mcpUrl = attachedMcpServers[0].url;
    const initRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const initJson = await initRes.json() as any;
    assert.equal(initJson.result?.serverInfo?.name, 'sprout_workspace');

    const listRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listJson = await listRes.json() as any;
    const toolNames = listJson.result?.tools?.map((t: any) => t.name);
    assert.ok(toolNames.includes('read'));

    const callRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'hello.txt' } },
      }),
    });
    const callJson = await callRes.json() as any;
    assert.equal(callJson.result?.isError, false);
    assert.ok(callJson.result?.content?.[0]?.text?.includes('file content for hello.txt'));
  } finally {
    await session.close();
  }
});

test('AC7: Usage attribution preserves deltas across multiple turns and redacts sensitive paths/credentials', async () => {
  let turnNumber = 0;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-usage', engineSessionKey: 'sess-usage' });
    } else if (cmd.op === 'prompt') {
      turnNumber++;
      if (turnNumber === 1) {
        r.send({
          kind: 'event',
          event: { kind: 'text_delta', text: 'turn 1 answer', sessionId: 'sess-usage', agentPath: [], seq: 1, receivedAt: Date.now() },
        });
        r.send({
          kind: 'turn_ended',
          outcome: { kind: 'completed' },
          usage: {
            total: { input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 0 },
          },
        });
      } else {
        r.send({
          kind: 'event',
          event: { kind: 'text_delta', text: 'turn 2 answer', sessionId: 'sess-usage', agentPath: [], seq: 2, receivedAt: Date.now() },
        });
        // Cumulative totals reported by OAR across the session
        r.send({
          kind: 'turn_ended',
          outcome: { kind: 'completed' },
          usage: {
            total: { input: 250, output: 70, reasoning: 15, cacheRead: 30, cacheWrite: 0 },
          },
        });
      }
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });

  // Turn 1
  const turn1 = session.run('First');
  const result1 = await turn1.completion;
  assert.equal(result1.status, 'completed');
  assert.deepEqual(result1.tokenUsage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  assert.deepEqual(result1.detailedTokens, { inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, cachedInputTokens: 10 });

  // Turn 2: verify delta attribution, not cumulative sum
  const turn2 = session.run('Second');
  const result2 = await turn2.completion;
  assert.equal(result2.status, 'completed');
  assert.deepEqual(result2.tokenUsage, { promptTokens: 150, completionTokens: 50, totalTokens: 200 });
  assert.deepEqual(result2.detailedTokens, { inputTokens: 150, outputTokens: 50, reasoningOutputTokens: 10, cachedInputTokens: 20 });

  await session.close();
});

test('AC7: Cumulative snapshots settle once, and zero-sequence stale data is ignored', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-usage-snapshot', engineSessionKey: 'native-session-key' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 10 });
      r.send({
        kind: 'usage_snapshot', activationId: cmd.activationId, seq: 10,
        usage: { total: { input: 60, output: 11, reasoning: 5, cacheRead: 8 } },
      });
      r.send({
        kind: 'usage_snapshot', activationId: cmd.activationId, seq: 11,
        usage: { total: { input: 160, output: 42, reasoning: 15, cacheRead: 28 } },
      });
      r.send({
        kind: 'event', activationId: cmd.activationId,
        event: { kind: 'text_delta', text: 'stale', sessionId: 'sess-usage-snapshot', agentPath: [], seq: 0, receivedAt: Date.now() },
      });
      r.send({
        kind: 'turn_ended', activationId: cmd.activationId, seq: 0,
        outcome: { kind: 'completed' },
        usage: { total: { input: 900, output: 900, reasoning: 900, cacheRead: 900 } },
      });
      r.send({
        kind: 'event', activationId: cmd.activationId,
        event: { kind: 'text_delta', text: 'PONG', sessionId: 'sess-usage-snapshot', agentPath: [], seq: 11, receivedAt: Date.now() },
      });
      r.send({
        kind: 'turn_ended', activationId: cmd.activationId, seq: 12,
        outcome: { kind: 'completed' },
        usage: { total: { input: 160, output: 42, reasoning: 15, cacheRead: 28 } },
      });
    }
  });
  const session = await new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => runner })
    .startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const result = await session.run('continue').completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'PONG');
  assert.deepEqual(result.tokenUsage, { promptTokens: 160, completionTokens: 42, totalTokens: 202 });
  assert.deepEqual(result.detailedTokens, {
    inputTokens: 160, outputTokens: 42, reasoningOutputTokens: 15, cachedInputTokens: 28,
  });
  assert.equal(result.source, 'oar');
  assert.equal(result.sourceVersion, '0.59.1');
  await session.close();
});

test('AC4: Resumed sequence-zero opening activity is not attributed without native turn evidence', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({
        kind: 'ready', sessionId: 'sess-resumed-sequence-zero', engineSessionKey: 'native-sequence-zero-key',
        freshSession: false, usageBaseline: { total: { input: 100, output: 20 } },
      });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 0 });
      r.send({
        kind: 'event', activationId: cmd.activationId,
        event: { kind: 'text_delta', text: 'queued opening notification', sessionId: 'sess-resumed-sequence-zero', agentPath: [], seq: 0, receivedAt: Date.now() },
      });
      r.send({
        kind: 'usage_snapshot', activationId: cmd.activationId, seq: 0,
        usage: { total: { input: 900, output: 900 } },
      });
      r.send({
        kind: 'turn_ended', activationId: cmd.activationId, seq: 0,
        outcome: { kind: 'completed' }, usage: { total: { input: 900, output: 900 } },
      });
      r.send({
        kind: 'event', activationId: cmd.activationId,
        event: { kind: 'text_delta', text: 'PONG', sessionId: 'sess-resumed-sequence-zero', agentPath: [], seq: 1, receivedAt: Date.now() },
      });
      r.send({
        kind: 'turn_ended', activationId: cmd.activationId, seq: 2,
        outcome: { kind: 'completed' }, usage: { total: { input: 140, output: 30 } },
      });
    }
  });
  const session = await new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => runner })
    .startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory, resumeSessionKey: 'native-sequence-zero-key' });
  const result = await session.run('continue').completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'PONG');
  assert.deepEqual(result.tokenUsage, { promptTokens: 40, completionTokens: 10, totalTokens: 50 });
  await session.close();
});

test('AC7: Usage snapshots survive runner loss, while genuinely missing usage remains unavailable', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-partial-usage', engineSessionKey: 'native-partial-session' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 1 });
      r.send({
        kind: 'usage_snapshot', activationId: cmd.activationId, seq: 2,
        usage: { total: { input: 45, output: 12, reasoning: 4 } },
      });
      r.exit(1);
    }
  });
  const session = await new OarEngineAdapter({ runtimeId: 'pi', spawnProcess: () => runner })
    .startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const interrupted = await session.run('partial response').completion;
  assert.equal(interrupted.status, 'failed');
  assert.deepEqual(interrupted.tokenUsage, { promptTokens: 45, completionTokens: 12, totalTokens: 57 });
  assert.deepEqual(interrupted.detailedTokens, { inputTokens: 45, outputTokens: 12, reasoningOutputTokens: 4 });
  await session.close();

  const noUsageRunner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-no-usage', engineSessionKey: 'native-no-usage' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 4 });
      r.send({ kind: 'turn_ended', activationId: cmd.activationId, seq: 5, outcome: { kind: 'completed' }, usage: { total: null } });
    }
  });
  const noUsageSession = await new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => noUsageRunner })
    .startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const unavailable = await noUsageSession.run('no usage report').completion;
  assert.equal(unavailable.status, 'completed');
  assert.equal(unavailable.tokenUsage, undefined);
  assert.equal(unavailable.detailedTokens, undefined);
  await noUsageSession.close();
});

test('AC7: A resumed conversation reports only usage above its verified native-session baseline', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({
        kind: 'ready', sessionId: 'sess-resumed-usage', engineSessionKey: 'native-resumed-key',
        freshSession: false,
        usageBaseline: { total: { input: 700, output: 120, reasoning: 30, cacheRead: 80 } },
      });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 7 });
      r.send({
        kind: 'usage_snapshot', activationId: cmd.activationId, seq: 8,
        usage: { total: { input: 742, output: 134, reasoning: 34, cacheRead: 90 } },
      });
      r.send({
        kind: 'turn_ended', activationId: cmd.activationId, seq: 9,
        outcome: { kind: 'completed' },
        usage: { total: { input: 742, output: 134, reasoning: 34, cacheRead: 90 } },
      });
    }
  });
  const session = await new OarEngineAdapter({ runtimeId: 'pi', spawnProcess: () => runner })
    .startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory, resumeSessionKey: 'native-resumed-key' });
  const result = await session.run('continue').completion;
  assert.deepEqual(result.tokenUsage, { promptTokens: 42, completionTokens: 14, totalTokens: 56 });
  assert.deepEqual(result.detailedTokens, {
    inputTokens: 42, outputTokens: 14, reasoningOutputTokens: 4, cachedInputTokens: 10,
  });
  await session.close();
});

test('AC7: A resumed run without a native usage baseline keeps usage unavailable', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-resumed-no-baseline', engineSessionKey: 'native-no-baseline', freshSession: false });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_accepted', activationId: cmd.activationId, seq: 1 });
      r.send({
        kind: 'usage_snapshot', activationId: cmd.activationId, seq: 2,
        usage: { total: { input: 742, output: 134 } },
      });
      r.send({ kind: 'turn_ended', activationId: cmd.activationId, seq: 3, outcome: { kind: 'completed' } });
    }
  });
  const session = await new OarEngineAdapter({ runtimeId: 'codex', spawnProcess: () => runner })
    .startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory, resumeSessionKey: 'native-no-baseline' });
  const result = await session.run('continue').completion;
  assert.equal(result.tokenUsage, undefined);
  assert.equal(result.detailedTokens, undefined);
  await session.close();
});

test('AC4 (F1): Background or stale root turn_ended during admitted prompt neither settles nor contributes text', async () => {
  let promptCmd: any;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-interleave', engineSessionKey: 'sess-interleave' });
    } else if (cmd.op === 'prompt') {
      promptCmd = cmd;
      // 1. Runner accepts the prompt and binds spanId
      r.send({
        kind: 'prompt_accepted',
        activationId: cmd.activationId,
        seq: 1,
        spanId: 'admitted-span-1',
      });
      // 2. Injected interleaving: background root text delta with different spanId
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'stale background text',
          sessionId: 'sess-interleave',
          agentPath: [],
          spanId: 'background-stale-span-99',
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Injected interleaving: background root turn_ended with different spanId
      r.send({
        kind: 'turn_ended',
        spanId: 'background-stale-span-99',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Prompt with background interference');

  // Verify the turn is NOT settled by the background turn_ended
  let settledPrematurely = false;
  turn.completion.then(() => { settledPrematurely = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settledPrematurely, false, 'Admitted turn must not be settled by background root turn_ended');

  // Now emit the real admitted turn events
  runner.send({
    kind: 'event',
    activationId: promptCmd.activationId,
    event: {
      kind: 'text_delta',
      text: 'Admitted terminal answer.',
      sessionId: 'sess-interleave',
      agentPath: [],
      spanId: 'admitted-span-1',
      seq: 3,
      receivedAt: Date.now(),
    },
  });
  runner.send({
    kind: 'turn_ended',
    activationId: promptCmd.activationId,
    spanId: 'admitted-span-1',
    outcome: { kind: 'completed' },
  });

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Admitted terminal answer.');
  assert.ok(!result.text.includes('stale background text'), 'Stale text must not be in reply');

  await session.close();
});

test('AC5 (F6): Spawn failure (runner process emits error before ready) rejects startSession and cleans up resources', async () => {
  let killCalled = false;
  const runner = new FakeOarRunner();
  runner.killHandler = () => {
    killCalled = true;
    runner.exit(1);
  };

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => {
      // Runner emits spawn error (e.g. ENOENT / EACCES) before emitting ready
      queueMicrotask(() => {
        runner.emitError(new Error('spawn ENOENT'));
      });
      return runner;
    },
  });

  await assert.rejects(
    () => adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory }),
    (err: Error) => {
      assert.ok(err instanceof EngineStartError);
      assert.match(err.message, /Failed to spawn OAR runner: spawn ENOENT/);
      return true;
    },
  );

  assert.equal(killCalled, true, 'Spawn failure must trigger process cleanup');
});

test('AC6 (F3): Non-cooperative runner failure to exit preserves stop uncertainty and keeps recovery fenced', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-fence-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const journal = new WorkerRecoveryJournal(join(dir, 'journal'), 1);

  // Uncooperative runner that ignores dispose and ignore kill
  const uncooperativeRunner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-uncoop', engineSessionKey: 'sess-uncoop' });
    }
  });
  uncooperativeRunner.ignoreDispose = true;
  // Refuses to exit on kill
  uncooperativeRunner.killHandler = () => {
    // Does NOT call exit()
  };

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => uncooperativeRunner,
  });

  const input = new PassThrough();
  const output = new PassThrough();
  const workerWithIO = new EnvironmentWorker({
    environmentInstanceId: 'inst-1',
    engines: new Map<string, EngineAdapter>([['codex', adapter]]),
    input,
    output,
    recoveryJournal: journal,
  });

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/start', params: { engine: 'codex', agentId: 'scout', workingDirectory: oarTestWorkingDirectory } })}\n`);
  await new Promise<void>((resolve) => output.once('data', () => resolve()));

  // Worker shutdown with an uncooperative runner records no termination proof.
  await workerWithIO.shutdown();

  // Recovery journal MUST NOT record engineStopped: stop uncertainty is preserved!
  assert.equal(journal.snapshot().engineStopped, false, 'Recovery must remain fenced when process did not exit');
});

test('AC7 (F5): Synthetic absolute paths and credentials in tool input and output are redacted from progress events', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-privacy', engineSessionKey: 'sess-privacy' });
    } else if (cmd.op === 'prompt') {
      // 1. Tool call started containing host absolute path and bearer token
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_started',
          callId: 'call-priv-1',
          tool: 'read',
          input: '{"path":"/Users/user/secret-repo/config.json","token":"Bearer test-secret-token-token-12345"}',
          sessionId: 'sess-privacy',
          agentPath: [],
          seq: 1,
          receivedAt: Date.now(),
        },
      });
      // 2. Tool call ended containing Windows host path and secret auth key
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-priv-1',
          content: [{ type: 'text', text: 'Error in C:\\Users\\user\\project: authorization token=test-auth-key-key-98765 failed' }],
          result: 'failed',
          sessionId: 'sess-privacy',
          agentPath: [],
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Root answer
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'Clean final reply.',
          sessionId: 'sess-privacy',
          agentPath: [],
          seq: 3,
          receivedAt: Date.now(),
        },
      });
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'codex',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Privacy test prompt');

  const events: any[] = [];
  for await (const ev of turn.events) {
    events.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');

  const serializedEvents = JSON.stringify(events);

  // Strengthen F5 (non-blocking suggestion 1): positive presence assertions with redaction markers
  const toolCallEvent = events.find((e) => e.type === 'tool-call');
  assert.ok(toolCallEvent, 'tool-call event must be present on wire');
  assert.match(toolCallEvent.detail, /<redacted-(?:path|credential)>/, 'tool-call detail must contain redaction marker');

  const toolOutputEvent = events.find((e) => e.type === 'tool-output');
  assert.ok(toolOutputEvent, 'tool-output event must be present on wire');
  assert.match(toolOutputEvent.text, /<redacted-(?:path|credential)>/, 'tool-output text must contain redaction marker');

  // Assert absolute paths and credentials are scrubbed from events
  assert.ok(!serializedEvents.includes('/Users/user'), 'POSIX user directory must not cross wire');
  assert.ok(!serializedEvents.includes('C:\\Users\\user'), 'Windows user directory must not cross wire');
  assert.ok(!serializedEvents.includes('test-secret-token-token-12345'), 'Secret key must not cross wire');
  assert.ok(!serializedEvents.includes('test-auth-key-key-98765'), 'Auth token must not cross wire');

  await session.close();
});

test('Authority boundary (F8): MCP bridge authenticates caller, rejects unauthenticated requests, and preserves binding fence', async () => {
  let workspaceReadCalled = false;
  let bindingCurrent = true;

  const bridge = await createOarMcpBridge({
    remoteWorkspace: {
      binding: {
        projectId: 'auth-proj',
        environmentInstanceId: 'auth-env',
        bindingId: 'auth-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'auth-ws',
      },
      bindingFence: {
        generation: 1,
        isCurrent: () => bindingCurrent,
      },
      operations: ['read'],
      read: async () => {
        workspaceReadCalled = true;
        return {
          operationId: 'op-auth-read',
          projectId: 'auth-proj',
          environmentInstanceId: 'auth-env',
          bindingId: 'auth-bind',
          generation: 1,
          connectionEpoch: 1,
          workspaceId: 'auth-ws',
          operation: 'read',
          status: 'completed',
          content: 'SECRET_PROTECTED_DATA',
        };
      },
      search: async () => ({
        operationId: 'op-search',
        projectId: 'auth-proj',
        environmentInstanceId: 'auth-env',
        bindingId: 'auth-bind',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'auth-ws',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  assert.ok(bridge);
  assert.ok(bridge.mcpServer);
  assert.ok('type' in bridge.mcpServer && bridge.mcpServer.type === 'http');
  assert.ok(bridge.mcpServer.headers?.authorization, 'MCP server must configure authorization header for OAR client');

  const mcpUrl = bridge.mcpServer.url;
  const validAuthHeader = bridge.mcpServer.headers.authorization;

  try {
    // 1. Unauthenticated requests MUST return 401 Unauthorized
    const unauthInit = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthInit.status, 401, 'Unauthenticated initialize must return 401');

    const unauthList = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(unauthList.status, 401, 'Unauthenticated tools/list must return 401');
    const unauthListBody = await unauthList.json() as any;
    assert.equal(unauthListBody.error?.message, 'Unauthorized');

    const unauthCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(unauthCall.status, 401, 'Unauthenticated tools/call must return 401');
    assert.equal(workspaceReadCalled, false, 'Unauthenticated call must never invoke workspace callback');

    // 2. Request with forged or invalid authorization header MUST return 401
    const invalidAuthCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer forged-invalid-token' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(invalidAuthCall.status, 401, 'Forged authorization token must return 401');
    assert.equal(workspaceReadCalled, false, 'Forged call must never invoke workspace callback');

    // 3. Authenticated request with configured OAR credentials MUST succeed
    const authList = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: validAuthHeader },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    assert.equal(authList.status, 200, 'Authenticated tools/list must return 200');
    const authListBody = await authList.json() as any;
    assert.ok(authListBody.result?.tools?.some((t: any) => t.name === 'read'));

    const authCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: validAuthHeader },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(authCall.status, 200, 'Authenticated tools/call must return 200');
    const authCallBody = await authCall.json() as any;
    assert.equal(authCallBody.result?.isError, false);
    assert.equal(workspaceReadCalled, true, 'Authenticated call must invoke workspace callback');

    // 4. Stale binding fence MUST reject tool call even with valid authorization
    workspaceReadCalled = false;
    bindingCurrent = false; // Close / invalidate fence

    const staleFenceCall = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: validAuthHeader },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'file.txt' } },
      }),
    });
    assert.equal(staleFenceCall.status, 200);
    const staleFenceBody = await staleFenceCall.json() as any;
    assert.equal(staleFenceBody.result?.isError, true, 'Stale fence must return isError: true');
    assert.match(staleFenceBody.result?.content?.[0]?.text ?? '', /no longer available/);
    assert.equal(workspaceReadCalled, false, 'Stale fence must never invoke workspace callback');
  } finally {
    await bridge.close();
  }
});

// --- Pi Conformance Tests (AC6) ---

test('AC3 & AC4 (pi): Root turn completion persists correct terminal answer and filters commentary/reasoning/child events', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-root-pi', engineSessionKey: 'sess-root-pi' });
    } else if (cmd.op === 'prompt') {
      // 1. Tool call
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_started',
          callId: 'call-1',
          tool: 'read',
          input: '{"path":"file.txt"}',
          sessionId: 'sess-root-pi',
          agentPath: [],
          seq: 1,
          receivedAt: Date.now(),
        },
      });
      // 2. Tool output
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-1',
          content: [{ type: 'text', text: 'file content' }],
          result: 'ok',
          sessionId: 'sess-root-pi',
          agentPath: [],
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Private reasoning (MUST BE EXCLUDED)
      r.send({
        kind: 'event',
        event: {
          kind: 'reasoning',
          content: { kind: 'text', text: 'internal secret thoughts' },
          sessionId: 'sess-root-pi',
          agentPath: [],
          seq: 3,
          receivedAt: Date.now(),
        },
      });
      // 4. Subagent / child turn text (agentPath: ['subagent'], MUST BE EXCLUDED from root reply)
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'child subagent commentary',
          sessionId: 'sess-root-pi',
          agentPath: ['subagent'],
          seq: 4,
          receivedAt: Date.now(),
        },
      });
      // 5. Root assistant response text
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'The terminal answer.',
          sessionId: 'sess-root-pi',
          agentPath: [],
          seq: 5,
          receivedAt: Date.now(),
        },
      });
      // 6. Root turn ended
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
        usage: {
          total: { input: 120, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0 },
        },
      });
      // 7. Late runner event after turn ended (MUST BE IGNORED)
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'late leaked text',
          sessionId: 'sess-root-pi',
          agentPath: [],
          seq: 6,
          receivedAt: Date.now(),
        },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Hello');

  const observedEvents: any[] = [];
  for await (const ev of turn.events) {
    observedEvents.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'The terminal answer.');
  assert.equal(result.source, 'oar');

  // Assert events streamed
  assert.deepEqual(observedEvents, [
    { type: 'tool-call', name: 'read', detail: '{"path":"<redacted-host>"}' },
    { type: 'tool-output', text: 'file content' },
    { type: 'message', text: 'The terminal answer.', final: false },
  ]);

  // Assert reasoning and child commentary never leaked into result or events
  assert.ok(!observedEvents.some((e) => JSON.stringify(e).includes('internal secret thoughts')));
  assert.ok(!observedEvents.some((e) => JSON.stringify(e).includes('child subagent commentary')));
  assert.ok(!observedEvents.some((e) => JSON.stringify(e).includes('late leaked text')));
  assert.ok(!result.text.includes('internal secret thoughts'));
  assert.ok(!result.text.includes('child subagent commentary'));
  assert.ok(!result.text.includes('late leaked text'));

  // Assert truthful usage totals
  assert.equal(result.tokenUsage?.promptTokens, 120);
  assert.equal(result.tokenUsage?.completionTokens, 40);
  assert.equal(result.tokenUsage?.totalTokens, 160);
  assert.equal(result.detailedTokens?.reasoningOutputTokens, 10);
  assert.equal(result.detailedTokens?.cachedInputTokens, 20);

  await session.close();
});

test('AC5 (pi): Refused / busy prompt fails immediately without implicit queueing', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-busy-pi', engineSessionKey: 'sess-busy-pi' });
    } else if (cmd.op === 'prompt') {
      r.send({ kind: 'prompt_rejected', code: 'busy', reason: 'Session is currently running another turn' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Second prompt');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /OAR prompt rejected \(busy\)/);

  await session.close();
});

test('AC5 (pi): Empty successful output settles cleanly without hanging', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-empty-pi', engineSessionKey: 'sess-empty-pi' });
    } else if (cmd.op === 'prompt') {
      // Completed with no text_delta
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Silent turn');

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '');

  await session.close();
});

test('AC5 (pi): Empty error output settles with sanitized failure text', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-err-pi', engineSessionKey: 'sess-err-pi' });
    } else if (cmd.op === 'prompt') {
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'failed', failure: 'provider', reason: '' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Failing turn');

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.equal(result.message, 'OAR turn failed');

  await session.close();
});

test('AC5 (pi): Spawn or early-exit failure settles turn without hanging', async () => {
  let activeRunner: FakeOarRunner | undefined;
  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => {
      const r = new FakeOarRunner((cmd, runner) => {
        if (cmd.op === 'start') {
          runner.send({ kind: 'ready', sessionId: 'sess-exit-pi', engineSessionKey: 'sess-exit-pi' });
        }
      });
      activeRunner = r;
      return r;
    },
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Early exit turn');

  // Runner dies mid-turn
  activeRunner?.exit(1);

  const result = await turn.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.message : '', /outcome is uncertain/i);
  assert.equal(result.status === 'failed' ? result.outcomeCertainty : undefined, 'uncertain');

  await session.close();
});

test('AC6 (pi): Bounded abort and close preserve uncertainty and settle turns as interrupted', async () => {
  let abortReceived = false;
  let disposeReceived = false;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-int-pi', engineSessionKey: 'sess-int-pi' });
    } else if (cmd.op === 'prompt') {
      // Running indefinitely
    } else if (cmd.op === 'abort') {
      abortReceived = true;
      r.send({ kind: 'abort_result', activationId: cmd.activationId, accepted: true });
      r.send({ kind: 'turn_ended', outcome: { kind: 'aborted' } });
    } else if (cmd.op === 'dispose') {
      disposeReceived = true;
      r.send({ kind: 'disposed' });
      r.exit(0);
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Long run');

  const interrupted = await session.interrupt();
  assert.equal(interrupted, true);
  assert.equal(abortReceived, true);

  const result = await turn.completion;
  assert.equal(result.status, 'interrupted');

  await session.close();
  assert.equal(disposeReceived, true);
  assert.equal(runner.exitCode, 0);
});

test('AC5 (pi): Multiple events sharing a single record sequence are all processed without deduplication', async () => {
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-multi-seq-pi', engineSessionKey: 'sess-multi-seq-pi' });
    } else if (cmd.op === 'prompt') {
      // Frame containing multiple readings sharing seq 42
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-1',
          content: [{ type: 'text', text: 'finished tool' }],
          sessionId: 'sess-multi-seq-pi',
          agentPath: [],
          seq: 42,
          receivedAt: 100,
        },
      });
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'shared seq text',
          sessionId: 'sess-multi-seq-pi',
          agentPath: [],
          seq: 42,
          receivedAt: 100,
        },
      });
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Multi seq test');

  const events: any[] = [];
  for await (const ev of turn.events) {
    events.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'shared seq text');
  assert.deepEqual(events, [
    { type: 'tool-output', text: 'finished tool' },
    { type: 'message', text: 'shared seq text', final: false },
  ]);

  await session.close();
});

test('AC2 & Substrate (pi): Remote workspace tools are exposed over MCP bridge to OAR Pi session', async () => {
  let attachedMcpServers: readonly any[] | undefined;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      attachedMcpServers = cmd.options.mcpServers;
      r.send({ kind: 'ready', sessionId: 'sess-mcp-pi', engineSessionKey: 'sess-mcp-pi' });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({
    agentId: 'scout',
    workingDirectory: oarTestWorkingDirectory,
    remoteWorkspace: {
      binding: {
        projectId: 'proj-pi-1',
        environmentInstanceId: 'env-pi-1',
        bindingId: 'bind-pi-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-pi-1',
      },
      read: async (path) => ({
        operationId: 'op-1',
        projectId: 'proj-pi-1',
        environmentInstanceId: 'env-pi-1',
        bindingId: 'bind-pi-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-pi-1',
        operation: 'read',
        status: 'completed',
        content: `file content for ${path}`,
      }),
      search: async () => ({
        operationId: 'op-2',
        projectId: 'proj-pi-1',
        environmentInstanceId: 'env-pi-1',
        bindingId: 'bind-pi-1',
        generation: 1,
        connectionEpoch: 1,
        workspaceId: 'ws-pi-1',
        operation: 'search',
        status: 'completed',
      }),
      inspect: async () => ({ status: 'completed' }),
      cancel: async () => ({ accepted: true, status: 'cancelled' }),
    },
  });

  assert.ok(attachedMcpServers);
  assert.equal(attachedMcpServers.length, 1);
  assert.equal(attachedMcpServers[0].name, 'sprout_workspace');
  assert.equal(attachedMcpServers[0].type, 'http');
  assert.ok(attachedMcpServers[0].headers?.authorization, 'MCP server must configure authorization header for OAR');

  const authHeaders = {
    'Content-Type': 'application/json',
    authorization: attachedMcpServers[0].headers.authorization,
  };

  try {
    const mcpUrl = attachedMcpServers[0].url;
    const initRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const initJson = (await initRes.json()) as any;
    assert.equal(initJson.result?.serverInfo?.name, 'sprout_workspace');

    const listRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listJson = (await listRes.json()) as any;
    const toolNames = listJson.result?.tools?.map((t: any) => t.name);
    assert.ok(toolNames.includes('read'));

    const callRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: 'hello-pi.txt' } },
      }),
    });
    const callJson = (await callRes.json()) as any;
    assert.equal(callJson.result?.isError, false);
    assert.ok(callJson.result?.content?.[0]?.text?.includes('file content for hello-pi.txt'));
  } finally {
    await session.close();
  }
});

test('AC7 (pi): Usage attribution preserves deltas across multiple turns and redacts sensitive paths/credentials', async () => {
  let turnNumber = 0;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-usage-pi', engineSessionKey: 'sess-usage-pi' });
    } else if (cmd.op === 'prompt') {
      turnNumber++;
      if (turnNumber === 1) {
        r.send({
          kind: 'event',
          event: { kind: 'text_delta', text: 'turn 1 answer', sessionId: 'sess-usage-pi', agentPath: [], seq: 1, receivedAt: Date.now() },
        });
        r.send({
          kind: 'turn_ended',
          outcome: { kind: 'completed' },
          usage: {
            total: { input: 100, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 0 },
          },
        });
      } else {
        r.send({
          kind: 'event',
          event: { kind: 'text_delta', text: 'turn 2 answer', sessionId: 'sess-usage-pi', agentPath: [], seq: 2, receivedAt: Date.now() },
        });
        r.send({
          kind: 'turn_ended',
          outcome: { kind: 'completed' },
          usage: {
            total: { input: 250, output: 70, reasoning: 15, cacheRead: 30, cacheWrite: 0 },
          },
        });
      }
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });

  // Turn 1
  const turn1 = session.run('First');
  const result1 = await turn1.completion;
  assert.equal(result1.status, 'completed');
  assert.deepEqual(result1.tokenUsage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  assert.deepEqual(result1.detailedTokens, { inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, cachedInputTokens: 10 });

  // Turn 2: verify delta attribution, not cumulative sum
  const turn2 = session.run('Second');
  const result2 = await turn2.completion;
  assert.equal(result2.status, 'completed');
  assert.deepEqual(result2.tokenUsage, { promptTokens: 150, completionTokens: 50, totalTokens: 200 });
  assert.deepEqual(result2.detailedTokens, { inputTokens: 150, outputTokens: 50, reasoningOutputTokens: 10, cachedInputTokens: 20 });

  await session.close();
});

test('AC4 (F1) (pi): Background or stale root turn_ended during admitted prompt neither settles nor contributes text', async () => {
  let promptCmd: any;
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-interleave-pi', engineSessionKey: 'sess-interleave-pi' });
    } else if (cmd.op === 'prompt') {
      promptCmd = cmd;
      // 1. Runner accepts prompt with activationId
      r.send({
        kind: 'prompt_accepted',
        activationId: cmd.activationId,
        seq: 1,
      });
      // 2. Injected interleaving: background root text delta with different activationId/spanId
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'stale background text',
          sessionId: 'sess-interleave-pi',
          agentPath: [],
          spanId: 'background-stale-span-99',
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Injected interleaving: background root turn_ended with different activationId
      r.send({
        kind: 'turn_ended',
        activationId: 'background-stale-activation-99',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: oarTestWorkingDirectory });
  const turn = session.run('Prompt with background interference');

  // Verify the turn is NOT settled by the background turn_ended
  let settledPrematurely = false;
  turn.completion.then(() => {
    settledPrematurely = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settledPrematurely, false, 'Admitted turn must not be settled by background root turn_ended');

  // Now emit the real admitted turn events
  runner.send({
    kind: 'event',
    activationId: promptCmd.activationId,
    event: {
      kind: 'text_delta',
      text: 'Admitted terminal answer.',
      sessionId: 'sess-interleave-pi',
      agentPath: [],
      seq: 3,
      receivedAt: Date.now(),
    },
  });
  runner.send({
    kind: 'turn_ended',
    activationId: promptCmd.activationId,
    seq: 4,
    outcome: { kind: 'completed' },
  });

  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Admitted terminal answer.');
  assert.ok(!result.text.includes('stale background text'), 'Stale text must not be in reply');

  await session.close();
});

test('AC7 (F5) (pi): Synthetic absolute paths and credentials in tool input and output are redacted from progress events', async (t) => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'oar-privacy-pi-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const runner = new FakeOarRunner((cmd, r) => {
    if (cmd.op === 'start') {
      r.send({ kind: 'ready', sessionId: 'sess-privacy-pi', engineSessionKey: 'sess-privacy-pi' });
    } else if (cmd.op === 'prompt') {
      // 1. Tool call started containing host absolute path and bearer token
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_started',
          callId: 'call-priv-1',
          tool: 'read',
          input: '{"path":"/Users/user/secret-repo/config.json","token":"Bearer test-secret-token-token-12345"}',
          sessionId: 'sess-privacy-pi',
          agentPath: [],
          seq: 1,
          receivedAt: Date.now(),
        },
      });
      // 2. Tool call ended containing Windows host path and secret auth key
      r.send({
        kind: 'event',
        event: {
          kind: 'tool_call_ended',
          callId: 'call-priv-1',
          content: [
            {
              type: 'text',
              text: 'Error in C:\\Users\\user\\project: authorization token=test-auth-key-key-98765 failed',
            },
          ],
          result: 'failed',
          sessionId: 'sess-privacy-pi',
          agentPath: [],
          seq: 2,
          receivedAt: Date.now(),
        },
      });
      // 3. Root answer
      r.send({
        kind: 'event',
        event: {
          kind: 'text_delta',
          text: 'Clean final reply.',
          sessionId: 'sess-privacy-pi',
          agentPath: [],
          seq: 3,
          receivedAt: Date.now(),
        },
      });
      r.send({
        kind: 'turn_ended',
        outcome: { kind: 'completed' },
      });
    }
  });

  const adapter = new OarEngineAdapter({
    runtimeId: 'pi',
    spawnProcess: () => runner,
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory });
  const turn = session.run('Privacy test');

  const progressEvents: any[] = [];
  for await (const ev of turn.events) {
    progressEvents.push(ev);
  }

  const result = await turn.completion;
  assert.equal(result.status, 'completed');

  assert.equal(progressEvents.length, 3);
  assert.equal(progressEvents[0]?.type, 'tool-call');
  assert.match(progressEvents[0]?.detail ?? '', /<redacted-(?:path|credential)>/, 'Positive presence of redaction marker');
  assert.ok(
    !progressEvents[0]?.detail.includes('/Users/user/secret-repo'),
    'Host path must be redacted from tool call detail',
  );
  assert.ok(
    !progressEvents[0]?.detail.includes('test-secret-token-token-12345'),
    'Bearer token must be redacted from tool call detail',
  );

  assert.equal(progressEvents[1]?.type, 'tool-output');
  assert.match(progressEvents[1]?.text ?? '', /<redacted-(?:path|credential)>/, 'Positive presence of Windows redaction marker');
  assert.ok(
    !progressEvents[1]?.text.includes('C:\\Users\\user\\project'),
    'Windows host path must be redacted from tool output',
  );
  assert.ok(
    !progressEvents[1]?.text.includes('test-auth-key-key-98765'),
    'Secret auth key must be redacted from tool output',
  );

  await session.close();
});
