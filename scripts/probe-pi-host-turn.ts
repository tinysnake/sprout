/**
 * Bounded baseline turn through the production Host Pi adapter, with no
 * remote workspace attached: does model output flow at all on this host?
 *
 * Emits sanitized facts only — counts, booleans and token totals, never the
 * prompt, model text, endpoints, headers or credentials.
 *
 * Usage: node scripts/probe-pi-host-turn.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createProductionHostPiAdapter } from '../src/engine/pi-host.ts';

function report(facts: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

const root = await mkdtemp(join(tmpdir(), 'sprout-pi-turn-baseline-'));
try {
  const pi = createProductionHostPiAdapter(
    { ...process.env, SPROUT_HOST_PI_PROVIDER: 'magpie', SPROUT_HOST_PI_MODEL: 'codex/gpt-6.1-sol' },
    {
      providerRoot: resolve(process.cwd(), '..', 'pi-extensions', 'pi-magpie'),
      runnerRoot: join(root, 'engine-runner'),
    },
  );
  if (!pi) {
    report({ outcome: 'blocked', reason: 'host-pi-profile-unconfigured' });
    process.exitCode = 2;
  } else {
    const readiness = await pi.readiness(true);
    if (readiness.status !== 'ready') {
      report({ outcome: 'blocked', reason: 'host-pi-readiness-unavailable', installation: readiness.installation,
        authentication: readiness.authentication, modelAvailability: readiness.modelAvailability,
        adapterControls: readiness.adapterControls });
      process.exitCode = 2;
    } else {
      const session = await pi.startSession({
        agentId: 'turn-baseline',
        workingDirectory: process.cwd(),
        model: pi.authorizedModel,
        effort: 'medium',
      });
      const turn = session.run('Reply with exactly the word PONG and nothing else.');
      const eventTypes: string[] = [];
      let messageEvents = 0;
      let sawPong = false;
      for await (const event of turn.events) {
        eventTypes.push(event.type);
        if (event.type === 'message') {
          messageEvents += 1;
          sawPong ||= event.text.includes('PONG');
        }
      }
      const result = await turn.completion;
      const completed = result.status === 'completed';
      // turn-facts are emitted after the terminal session event; give the child
      // stdout a beat to flush before reading them.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const turnFacts = (session as unknown as { turnFacts?: () => readonly Record<string, unknown>[] }).turnFacts?.() ?? [];
      report({
        outcome: completed ? 'baseline-turn-completed' : `baseline-turn-${result.status}`,
        piVersion: readiness.version ?? 'unknown',
        status: result.status,
        eventTypes,
        messageEvents,
        streamedPong: sawPong,
        exactPong: completed && result.text.trim() === 'PONG',
        textLength: completed ? result.text.length : 0,
        promptTokens: completed ? result.tokenUsage?.promptTokens ?? 0 : 0,
        completionTokens: completed ? result.tokenUsage?.completionTokens ?? 0 : 0,
        engineTurnDurationMs: completed ? result.engineTurnDurationMs ?? 0 : 0,
        turnFacts,
        hostProfileId: pi.profileId,
      });
      if (!completed || result.text.trim() !== 'PONG') process.exitCode = 1;
      await session.close();
    }
  }
} catch (error) {
  report({
    outcome: 'blocked', reason: 'bounded-baseline-failed',
    errorType: error instanceof Error ? error.name : 'unknown',
    errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
  });
  process.exitCode = 2;
} finally {
  await rm(root, { recursive: true, force: true });
}
