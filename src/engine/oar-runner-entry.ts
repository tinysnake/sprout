import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Session } from '@botiverse/oar';
import { assertSupportedNodeVersion } from './oar-node-support.ts';
import { assertOarRuntimePolicy } from './oar-runtime-policy.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';

function send(message: RunnerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let session: Session | undefined;
let activeActivationId: string | undefined;
let activeSpanId: string | undefined;

async function handleCommand(command: RunnerCommand): Promise<void> {
  try {
    switch (command.op) {
      case 'start': {
        assertSupportedNodeVersion();
        assertOarRuntimePolicy(command.runtimeId);

        if (command.hostPolicy?.sandbox) {
          process.env.OAR_CODEX_SANDBOX = command.hostPolicy.sandbox;
        }

        const { defaultRuntimes } = await import('@botiverse/oar');
        const runtime = defaultRuntimes.require(command.runtimeId);
        if (typeof runtime.installation !== 'function') {
          send({
            kind: 'error',
            message: `Runtime ${command.runtimeId} does not provide an installation probe`,
            stage: 'installation',
          });
          return;
        }
        const installation = command.binaryPath === undefined
          ? await runtime.installation()
          : {
              kind: 'available' as const,
              via: 'executable' as const,
              command: command.binaryPath,
              version: (await promisify(execFile)(command.binaryPath, ['--version'], {
                timeout: 10_000, maxBuffer: 4096,
              })).stdout.trim(),
            };
        if (installation.kind !== 'available') {
          send({
            kind: 'error',
            message: `Runtime ${command.runtimeId} is not available`,
            stage: 'installation',
          });
          return;
        }

        const sessionOptions = {
          ...command.options,
          ...(command.hostPolicy?.sandbox
            ? {
                launchArgs: [
                  ...(command.options.launchArgs ?? []),
                  '-c',
                  `sandbox_mode="${command.hostPolicy.sandbox}"`,
                ],
              }
            : {}),
        };

        const activeSession = await runtime.session(installation, sessionOptions);
        session = activeSession;

        activeSession.events((ev) => {
          send({ kind: 'event', event: ev });
          if (ev.kind === 'turn_ended' && (!ev.agentPath || ev.agentPath.length === 0)) {
            try {
              const usage = activeSession.usage().value;
              send({
                kind: 'turn_ended',
                activationId: activeActivationId,
                spanId: ev.spanId ?? activeSpanId,
                outcome: ev.outcome,
                usage,
              });
            } catch {
              send({
                kind: 'turn_ended',
                activationId: activeActivationId,
                spanId: ev.spanId ?? activeSpanId,
                outcome: ev.outcome,
              });
            }
          }
        });

        send({
          kind: 'ready',
          sessionId: activeSession.id,
          engineSessionKey: activeSession.id,
        });
        break;
      }

      case 'prompt': {
        if (!session) {
          send({ kind: 'error', message: 'No active session for prompt', stage: 'prompt' });
          return;
        }
        activeActivationId = command.activationId;
        activeSpanId = undefined;
        const outcome = await session.prompt(command.input, { inputId: command.activationId });
        if (outcome.kind === 'rejected') {
          activeActivationId = undefined;
          send({
            kind: 'prompt_rejected',
            activationId: command.activationId,
            code: outcome.code,
            reason: outcome.reason,
          });
        } else {
          const nativeBody = (outcome.response?.body as any)?.native;
          const turnId = nativeBody?.turn?.id;
          if (typeof turnId === 'string') {
            activeSpanId = turnId;
          }
          send({
            kind: 'prompt_accepted',
            activationId: command.activationId,
            seq: outcome.seq,
            ...(activeSpanId !== undefined ? { spanId: activeSpanId } : {}),
          });
        }
        break;
      }

      case 'abort': {
        if (session) {
          await session.abort();
        }
        send({ kind: 'abort_delivered' });
        break;
      }

      case 'dispose': {
        if (session) {
          await session.dispose();
          session = undefined;
        }
        send({ kind: 'disposed' });
        process.exit(0);
      }
    }
  } catch (error) {
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stage: command.op,
    });
  }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const command = JSON.parse(trimmed) as RunnerCommand;
    void handleCommand(command);
  } catch (error) {
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stage: 'parse',
    });
  }
});
