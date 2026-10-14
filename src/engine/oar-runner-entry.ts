import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Session } from '@botiverse/oar';
import type { Event, SessionUsage } from '@botiverse/oar';
import { assertSupportedNodeVersion } from './oar-node-support.ts';
import { assertOarRuntimePolicy } from './oar-runtime-policy.ts';
import type { RunnerCommand, RunnerMessage } from './oar-runner-protocol.ts';

function send(message: RunnerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let session: Session | undefined;
let activeActivationId: string | undefined;
let activeSpanId: string | undefined;
let pendingPromptEvents: Event[] | undefined;
let isSessionNotFoundError: (error: unknown) => boolean = () => false;

function sendSessionEvent(event: Event, activationId: string | undefined): void {
  send({ kind: 'event', event, ...(activationId !== undefined ? { activationId } : {}) });

  if (activationId !== undefined && event.kind === 'usage') {
    try {
      const usage = session?.usage().value;
      if (usage?.total !== null && usage?.total !== undefined) {
        send({ kind: 'usage_snapshot', activationId, seq: event.seq, usage });
      }
    } catch {
      // Usage is optional telemetry; an unavailable snapshot stays unavailable.
    }
  }

  if (event.kind === 'turn_ended' && (!event.agentPath || event.agentPath.length === 0)) {
    try {
      const usage = session?.usage().value;
      send({
        kind: 'turn_ended',
        ...(activationId !== undefined ? { activationId } : {}),
        spanId: event.spanId,
        seq: event.seq,
        outcome: event.outcome,
        ...(usage !== undefined ? { usage } : {}),
      });
    } catch {
      send({
        kind: 'turn_ended',
        ...(activationId !== undefined ? { activationId } : {}),
        spanId: event.spanId,
        seq: event.seq,
        outcome: event.outcome,
      });
    }
    if (activationId !== undefined && activeActivationId === activationId) {
      activeActivationId = undefined;
      activeSpanId = undefined;
    }
  }
}

async function handleCommand(command: RunnerCommand): Promise<void> {
  try {
    switch (command.op) {
      case 'start': {
        assertSupportedNodeVersion();
        assertOarRuntimePolicy(command.runtimeId, command.options, command.hostPolicy?.pi);
        if (command.runtimeId === 'pi') {
          process.env.OAR_PI_AGENT_DIR = command.hostPolicy!.pi!.agentDir;
        }

        if (command.hostPolicy?.sandbox) {
          process.env.OAR_CODEX_SANDBOX = command.hostPolicy.sandbox;
        }

        const oar = await import('@botiverse/oar');
        isSessionNotFoundError = (error) => error instanceof oar.SessionNotFoundError;
        const runtime = oar.defaultRuntimes.require(command.runtimeId);
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

        activeSession.events((event) => {
          if (pendingPromptEvents !== undefined) {
            pendingPromptEvents.push(event);
            return;
          }
          sendSessionEvent(event, activeActivationId);
        });

        let usageBaseline: SessionUsage | null | undefined;
        try {
          usageBaseline = activeSession.usage().value;
        } catch {
          // A resumed session without a readable baseline must report usage as unavailable.
        }
        // OAR Session.id is runtime-native: the Codex thread id or Pi session
        // manager id. It is the value SessionOptions.resume expects and belongs
        // in Sprout's durable session-key slot.
        send({
          kind: 'ready',
          sessionId: activeSession.id,
          engineSessionKey: activeSession.id,
          freshSession: command.options.resume === undefined,
          ...(usageBaseline !== undefined ? { usageBaseline } : {}),
        });
        break;
      }

      case 'prompt': {
        if (!session) {
          send({ kind: 'error', message: 'No active session for prompt', stage: 'prompt' });
          return;
        }
        activeActivationId = undefined;
        activeSpanId = undefined;
        pendingPromptEvents = [];
        const outcome = await session.prompt(command.input, { inputId: command.activationId });
        const queuedEvents = pendingPromptEvents;
        pendingPromptEvents = undefined;
        if (outcome.kind === 'rejected') {
          for (const event of queuedEvents ?? []) sendSessionEvent(event, undefined);
          send({
            kind: 'prompt_rejected',
            activationId: command.activationId,
            code: outcome.code,
            reason: outcome.reason,
          });
        } else {
          const nativeBody = (outcome.response?.body as any)?.native;
          const turnId = nativeBody?.turn?.id;
          if (typeof turnId === 'string') activeSpanId = turnId;
          activeActivationId = command.activationId;
          send({
            kind: 'prompt_accepted',
            activationId: command.activationId,
            seq: outcome.seq,
            ...(activeSpanId !== undefined ? { spanId: activeSpanId } : {}),
          });
          for (const event of queuedEvents ?? []) sendSessionEvent(event, activeActivationId);
        }
        break;
      }

      case 'abort': {
        if (session) {
          const outcome = await session.abort();
          send({ kind: 'abort_result', activationId: command.activationId, accepted: outcome.kind === 'accepted' });
        } else {
          send({ kind: 'abort_result', activationId: command.activationId, accepted: false });
        }
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
    if (command.op === 'prompt') {
      const queuedEvents = pendingPromptEvents;
      pendingPromptEvents = undefined;
      activeActivationId = undefined;
      activeSpanId = undefined;
      for (const event of queuedEvents ?? []) sendSessionEvent(event, undefined);
    }
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stage: command.op,
      ...(command.op === 'start' && isSessionNotFoundError(error) ? { code: 'session_not_found' } : {}),
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
