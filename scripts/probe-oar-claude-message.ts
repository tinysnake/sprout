import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRuntime, hostConfiguration, project, runtimePort, PROJECT_ID } from '../src/runtime-test-harness.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey, connectWorkerEnrollment } from '../src/worker/enrollment-connector.ts';
import { EnvironmentWorker } from '../src/worker/server.ts';
import { createEnvironmentWorkerEngines, lookupCommand, describeEnvironmentWorkerEngines } from '../src/worker/engine-selection.ts';
import { probeEnvironmentReadiness } from '../src/worker/readiness.ts';
import { OarEngineAdapter, type OarRunnerProcess } from '../src/engine/oar.ts';
import { redactSensitiveText } from '../src/environment/privacy.ts';
import type { StartSessionRequest } from '../src/engine/port.ts';

// Disposable, authenticated Environment-hosted composition. Credentials stay on the host.
const directory = mkdtempSync(join(tmpdir(), 'sprout-oar-claude-message-'));
const instanceId = 'claude-candidate-worker';
const marker = 'OAR_CLAUDE_MESSAGE_OK';
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let worker: EnvironmentWorker | undefined;
let connection: Awaited<ReturnType<typeof connectWorkerEnrollment>> | undefined;
let stage = 'prerequisites';
const children = new Set<ReturnType<typeof spawn>>();
const deadline = setTimeout(() => { for (const child of children) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} } process.exit(2); }, 150_000);
const facts: Record<string, unknown> = { evidenceClass: 'model-issued', mode: 'environment-hosted', oar: '0.59.1' };
try {
  assert.equal(process.platform, 'darwin');
  const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
  const model = settings.model;
  const effort = settings.effortLevel as NonNullable<StartSessionRequest['effort']>;
  assert.ok(typeof model === 'string' && model.length > 0);
  assert.ok(['low', 'medium', 'high', 'max', 'xhigh', 'minimal'].includes(effort));
  const hostFacts = {
    configuration: { environmentPlatform: 'macos' as const, piSessionDirectory: undefined, engineBinaries: {} },
    platform: process.platform,
    locate: (command: string, options: { preferWindowsExecutable: boolean }) => lookupCommand(command, process.platform, options.preferWindowsExecutable),
  };
  const configurations = describeEnvironmentWorkerEngines(hostFacts, { claude: true }).filter(configuration => configuration.engine === 'claude');
  // Observe normalized model events from the real supervised child in memory only.
  const observationAdapter = new OarEngineAdapter({ runtimeId: 'claude', binaryPath: configurations[0]!.binaryPath,
    spawnProcess: (command, args, options) => {
      const child = spawn(command, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      child.on('exit', () => children.delete(child));
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try { const message = JSON.parse(line); if (message.kind === 'event' && message.event.kind === 'model') facts.nativeModelMatchesRequested = message.event.model === model; } catch {}
        }
      });
      return child as unknown as OarRunnerProcess;
    },
  });
  const engines = createEnvironmentWorkerEngines({ ...hostFacts, locate: (command, options) => command === 'claude' ? hostFacts.locate(command, options) : undefined }, { claude: () => observationAdapter }, { claude: true });
  const adapter = engines.get('claude');
  assert.ok(adapter instanceof OarEngineAdapter);
  const observedStart = adapter.startSession.bind(adapter);
  adapter.startSession = async request => {
    facts.projectInstructionsReceived = request.instructions?.includes(marker) === true;
    facts.projectModelReceived = request.model === model;
    facts.projectEffortReceived = request.effort === effort;
    return observedStart(request);
  };
  const initial = await probeEnvironmentReadiness(configurations);
  facts.nonInferenceReadiness = initial.readiness.engines.map(fact => ({ version: fact.version, readiness: fact.readiness, modelAvailability: fact.modelAvailability }));
  assert.equal(initial.readiness.engines[0]?.readiness, 'ready');
  stage = 'runtime-create';
  runtime = await createRuntime({ configuration: hostConfiguration({ environmentSource: 'enrollment', engineId: 'claude', executionMode: 'environment-hosted', databasePath: join(directory, 'runtime.db'), workingDirectory: directory,
    runtimeConfiguration: { agents: [{ id: 'scout', name: 'Candidate agent', engine: 'claude', capability: 'agent-run', model, effort, workOptions: [{ id: 'claude-candidate', engine: 'claude', workModel: model, effort }] }],
      project: { ...project(), availableEnvironmentInstanceIds: [instanceId], rules: [`Reply with exactly ${marker}. Do not use tools.`], memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: 'Follow the Project reply rule.' }] } },
  }), projectRoot: directory });
  await runtime.projectService.create({ id: PROJECT_ID, displayName: 'Disposable Claude candidate Project',
    rules: [`Reply with exactly ${marker}. Do not use tools.`],
    agentMemberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: 'Follow the Project reply rule.' }] });
  stage = 'enrollment';
  const identityPath = join(directory, 'worker-identity.pem');
  const identity = loadOrCreateWorkerIdentity(identityPath);
  const enrollment = await runtime.enrollments.requestEnrollment({ environmentInstanceId: instanceId, displayName: 'Disposable Claude candidate Worker', publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3', capabilityRequests: ['agent-run'], engineFacts: [{ engine: 'claude', installed: true, authenticated: true, models: [] }] });
  // The bounded task authorizes use of the existing model; entitlement stays unknown.
  await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'agent-run': true }, modelAuthorizations: { claude: [model] } });
  connection = await connectWorkerEnrollment({ target: { enrollmentId: enrollment.enrollment.id, host: '127.0.0.1', port: await runtimePort(runtime), claimSecret: undefined, identityKeyPath: identityPath }, protocolVersion: '3', engineFacts: [{ engine: 'claude', installed: true, authenticated: true, models: [] }] });
  let current = initial;
  worker = new EnvironmentWorker({ environmentInstanceId: instanceId, engines, input: connection.stream, output: connection.stream, workspaceRoot: directory,
    readiness: () => current.readiness,
    readinessProbe: async params => { current = await probeEnvironmentReadiness(configurations, { ...(params.requirements !== undefined ? { requirements: params.requirements } : {}) }); return current; },
  });
  stage = 'admission';
  let decision;
  const admissionDeadline = Date.now() + 20_000;
  do {
    await runtime.refreshEnvironmentCatalog();
    decision = await runtime.orchestrator.evaluateOptionAdmission('scout', instanceId);
    if (decision.ok) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < admissionDeadline);
  if (!decision?.ok) throw new Error(`Admission refused: ${decision?.reason}`);
  stage = 'message';
  mkdirSync(join(directory, 'candidate-project'));
  await runtime.projectAccess.grant({ projectId: PROJECT_ID, environmentInstanceId: instanceId,
    selection: { kind: 'relative', path: 'candidate-project' } });
  const delivered = await runtime.collaboration.deliver({ scopeId: `channel-${PROJECT_ID}`, author: { id: 'operator', kind: 'human' }, body: '@scout Follow the Project rule and answer now.', deliveryKey: 'oar-claude-candidate-message', awaitReply: true });
  assert.equal(delivered.admittedRunIds.length, 1);
  const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
  facts.runStatus = run.status;
  if (run.status !== 'completed') facts.runFailure = redactSensitiveText(JSON.stringify({ result: run.result, failure: run.failure }));
  const messages = await runtime.collaboration.listMessages();
  const replies = messages.filter(message => message.author.kind === 'agent' && message.inReplyTo === delivered.message.id);
  facts.replyCount = replies.length;
  facts.finalAnswerMatches = run.result?.status === 'completed' && run.result.text.trim() === marker;
  facts.projectedAnswerMatches = replies[0]?.body.trim() === marker;
  facts.realProgressCount = run.events.filter(event => event.type === 'message' && !event.final).length;
  const persisted = await runtime.stores.runs.get(run.id);
  facts.persistedRunMatches = persisted?.result?.status === 'completed' && persisted.result.text.trim() === marker;
  facts.tokenUsagePresent = run.result?.status === 'completed' && run.result.tokenUsage !== undefined;
  facts.detailedUsagePresent = run.result?.status === 'completed' && run.result.detailedTokens !== undefined;
  await runtime.collaboration.reconcile();
  facts.replyCountAfterReconcile = (await runtime.collaboration.listMessages()).filter(message => message.author.kind === 'agent' && message.inReplyTo === delivered.message.id).length;
  console.log(JSON.stringify(facts));
  assert.equal(run.status, 'completed');
  assert.ok(facts.finalAnswerMatches && facts.projectedAnswerMatches && facts.persistedRunMatches);
  assert.equal(facts.replyCount, 1); assert.equal(facts.replyCountAfterReconcile, 1);
  assert.ok(Number(facts.realProgressCount) > 0);
  assert.ok(facts.projectInstructionsReceived && facts.projectModelReceived && facts.projectEffortReceived && facts.nativeModelMatchesRequested);
} catch (error) {
  console.log(JSON.stringify({ ...facts, stage, failure: redactSensitiveText(error instanceof Error ? error.message : String(error)) }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await worker?.shutdown(); connection?.close(); await runtime?.close();
  rmSync(directory, { recursive: true, force: true });
}
