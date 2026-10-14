import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { OarEngineAdapter, OAR_CLAUDE_DISALLOWED_TOOLS, type OarRunnerProcess } from './oar.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';
import { createEnvironmentWorkerEngines, describeEnvironmentWorkerEngines } from '../worker/engine-selection.ts';
import { probeEnvironmentReadiness } from '../worker/readiness.ts';

class Runner extends EventEmitter implements OarRunnerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly commands: RunnerCommand[] = [];
  constructor() {
    super();
    this.stdin.on('data', chunk => {
      const command = JSON.parse(String(chunk)) as RunnerCommand;
      this.commands.push(command);
      if (command.op === 'start') this.send({ kind: 'ready', sessionId: 'claude-session', engineSessionKey: 'claude-session' });
      if (command.op === 'dispose') this.kill();
    });
  }
  send(message: RunnerMessage): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean { this.exitCode = 0; this.emit('exit', 0, null); return true; }
}

// Risk: candidate registration must not enable the replacement before acceptance.
test('Claude candidate is macOS only, uses the shared adapter, and stays out of default selection', () => {
  const facts = {
    configuration: { environmentPlatform: 'macos' as const, engineBinaries: {}, piSessionDirectory: undefined },
    platform: 'darwin' as const,
    locate: (command: string) => command === 'claude' ? '/synthetic/bin/claude' : undefined,
  };
  assert.deepEqual(describeEnvironmentWorkerEngines(facts), []);
  const selected = createEnvironmentWorkerEngines(facts, {}, { claude: true });
  assert.ok(selected.get('claude') instanceof OarEngineAdapter);
  assert.equal(selected.get('claude')?.capabilities.standingInstructions, 'out-of-band');
  assert.deepEqual(describeEnvironmentWorkerEngines({ ...facts, platform: 'linux' }, { claude: true }), []);
});

// Risk: commentary or another assistant message must not become the durable final answer.
test('Claude streams all root progress but settles only the last root message with per-run cache usage', async () => {
  const runner = new Runner();
  const adapter = new OarEngineAdapter({ runtimeId: 'claude', binaryPath: '/synthetic/bin/claude', spawnProcess: () => runner });
  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp', instructions: 'PROJECT_RULE', model: 'authorized-model', effort: 'low' });
  const start = runner.commands[0];
  assert.ok(start?.op === 'start');
  assert.equal(start.binaryPath, '/synthetic/bin/claude');
  assert.equal(start.options.appendSystemPrompt, 'PROJECT_RULE');
  assert.equal(start.options.model, 'authorized-model');
  assert.equal(start.options.effort, 'low');
  assert.deepEqual(start.options.disallowedTools, [...OAR_CLAUDE_DISALLOWED_TOOLS]);
  for (const [turnIndex, total] of [[0, 10], [1, 25]] as const) {
    const turn = session.run('question');
    const eventsPromise = (async () => { const events = []; for await (const event of turn.events) events.push(event); return events; })();
    const prompt = runner.commands.at(-1);
    assert.ok(prompt?.op === 'prompt');
    runner.send({ kind: 'prompt_accepted', activationId: prompt.activationId, seq: 0 });
    for (const [messageId, text] of [['commentary', 'Checking now.'], ['answer', 'FINAL_'], ['answer', 'ANSWER']] as const) {
      runner.send({ kind: 'event', activationId: prompt.activationId, event: { kind: 'text_delta', sessionId: 'claude-session', agentPath: [], seq: 1, receivedAt: 1, messageId, text } });
    }
    runner.send({ kind: 'turn_ended', activationId: prompt.activationId, seq: 2, outcome: { kind: 'completed' }, usage: { total: { input: total, output: total, cacheRead: total, cacheWrite: total } } });
    const result = await turn.completion;
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.equal(result.text, 'FINAL_ANSWER');
      assert.equal(result.detailedTokens?.cacheWriteInputTokens, turnIndex === 0 ? 10 : 15);
      assert.equal(result.detailedTokens?.cachedInputTokens, turnIndex === 0 ? 10 : 15);
    }
    assert.equal((await eventsPromise).filter(event => event.type === 'message').length, 3);
  }
  await session.close();
});

// Risk: adding the candidate must not silently grant unproved Host-run isolation.
test('Claude refuses remote authority before spawning a runner', async () => {
  let spawns = 0;
  const adapter = new OarEngineAdapter({ runtimeId: 'claude', spawnProcess: () => { spawns++; return new Runner(); } });
  await assert.rejects(adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp', remoteProjectMcp: {
    binding: { projectId: 'project', environmentInstanceId: 'worker', bindingId: 'binding', generation: 1, connectionEpoch: 1, workspaceId: 'workspace' },
    tools: [], call: async () => { throw new Error('unreachable'); }, close: async () => 'stopped',
  } }), /Host-run authority is unproved/);
  assert.equal(spawns, 0);
});

// Risk: local auth output can expose host paths and account data or falsely imply model entitlement.
test('Claude readiness reports only measured non-inference auth facts and fails closed on unsupported or malformed output', async () => {
  for (const scenario of ['ready', 'logged-out', 'malformed', 'old', 'node-old'] as const) {
    const calls: string[][] = [];
    const options = {
      nodeVersion: scenario === 'node-old' ? '22.0.0' : '24.0.0',
      requirements: { revision: 'requirement-1', modelsByEngine: { claude: ['authorized-model'] } },
      commandRunner: { run: async (_binary: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === '--version') return { stdout: `${scenario === 'old' ? '2.1.100' : '2.1.294'} (Claude Code)`, exitCode: 0 };
        return { stdout: JSON.stringify({ loggedIn: scenario !== 'logged-out', authMethod: scenario === 'malformed' ? 'unexpected' : 'oauth_token', email: 'synthetic-account', configDirectory: '/synthetic/private/config', token: 'SYNTHETIC_SECRET' }), exitCode: scenario === 'logged-out' ? 1 : 0 };
      } },
    };
    const result = await probeEnvironmentReadiness([{ engine: 'claude', binaryPath: '/synthetic/bin/claude' }], options);
    const fact = result.readiness.engines[0];
    assert.equal(fact?.readiness, scenario === 'ready' ? 'ready' : scenario === 'logged-out' ? 'login-required' : 'unknown');
    assert.equal(fact?.modelAvailability, 'unknown');
    const wire = JSON.stringify(result);
    for (const privateValue of ['synthetic-account', '/synthetic/private/config', 'SYNTHETIC_SECRET']) assert.ok(!wire.includes(privateValue));
    if (scenario === 'old' || scenario === 'node-old') assert.ok(!calls.some(args => args[0] === 'auth'));
    if (scenario === 'ready') {
      assert.equal(fact?.source, 'claude-auth-status');
      assert.equal(fact?.requirementRevision, 'requirement-1');
      assert.deepEqual(calls, [['--version'], ['auth', 'status', '--json']]);
    }
  }
});
