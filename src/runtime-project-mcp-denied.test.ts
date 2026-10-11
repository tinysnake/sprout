import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { HostPiEngineAdapter } from './engine/pi-host.ts';
import type { StartSessionRequest } from './engine/port.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import { connectRuntimeWorker, createRuntime, hostConfiguration, INSTANCE_ID, project, scriptedTurn } from './runtime-test-harness.ts';

test('Host-run Task refuses Project MCP startup when the enrolled Worker lacks MCP permission', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-denied-project-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const marker = join(workerRoot, 'repos', 'denied-mcp', 'unauthorized-mcp-started.txt');
  const model = 'provider/model-host';
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('should not run')] });
  let hostPiStarted = false;
  const hostPi = {
    id: 'pi', profileId: 'profile-denied-project-mcp', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-denied-project-mcp', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      hostPiStarted = true;
      return localEngine.startSession(request);
    },
  } as unknown as HostPiEngineAdapter;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      runtimeConfiguration: {
        agents: [{
          id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
          workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }],
        }],
        project: runtimeProject,
      },
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: '/synthetic/project-root',
    hostPi,
  });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Permission-denied MCP Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['agent-run', 'project-mcp'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, {
      capabilityPermissions: { 'agent-run': true, 'project-mcp': false },
    });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    await runtime.projectService.create({ id: 'denied-mcp-project', displayName: 'Denied MCP Project' });
    await runtime.projectService.addMembership('denied-mcp-project', { agentId: 'scout' });
    await runtime.projectService.updateContent('denied-mcp-project', { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    await runtime.projectAccess.grant({
      projectId: 'denied-mcp-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/denied-mcp' },
    });
    const serverScript = `
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      writeFileSync('unauthorized-mcp-started.txt', 'server launched');
      const input = createInterface({ input: process.stdin });
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      input.on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
        else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
      });
    `;
    writeFileSync(join(workerRoot, 'repos', 'denied-mcp', '.mcp.json'), JSON.stringify({
      mcpServers: { denied: { command: process.execPath, args: ['--input-type=module', '-e', serverScript] } },
    }));
    const task = await runtime.tasks.create({
      projectId: 'denied-mcp-project', title: 'Denied MCP Task', goal: 'Verify denied startup', assignedAgentId: 'scout',
    });
    await runtime.tasks.begin(task.id);
    const advanced = await runtime.tasks.advance(task.id, { prompt: 'Start Project MCP.' });
    const run = await runtime.orchestrator.waitFor(advanced.runId);
    assert.equal(run.status, 'failed');
    assert.equal(hostPiStarted, false, 'the denied MCP bridge refuses before Host Pi starts');
    assert.equal(existsSync(marker), false, 'a denied Worker capability never launches the configured server');
  } finally {
    await runtime.close();
  }
});

test('Host-run reports an actionable Worker dependency failure before Host Pi starts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-missing-project-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workerRoot = join(directory, 'worker-workspaces');
  const keyPath = join(directory, 'worker-key.pem');
  const marker = join(workerRoot, 'repos', 'missing-mcp', 'unauthorized-mcp-started.txt');
  const model = 'provider/model-host';
  const runtimeProject = { ...project(), memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }] };
  const localEngine = new ScriptedEngineAdapter({ turns: [scriptedTurn('should not run')] });
  let hostPiStarted = false;
  const hostPi = {
    id: 'pi', profileId: 'profile-missing-project-mcp', authorizedModel: model,
    capabilities: localEngine.capabilities,
    async readiness() {
      return { profileId: 'profile-missing-project-mcp', engine: 'pi', status: 'ready', installation: 'ready',
        authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4', observedAt: 1 };
    },
    async startSession(request: StartSessionRequest) {
      hostPiStarted = true;
      return localEngine.startSession(request);
    },
  } as unknown as HostPiEngineAdapter;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment',
      runtimeConfiguration: { agents: [{
        id: 'scout', name: 'scout', engine: 'pi', capability: 'agent-run', model, effort: 'medium',
        workOptions: [{ id: 'host-pi', engine: 'pi', workModel: model, effort: 'medium' }],
      }], project: runtimeProject },
      databasePath: join(directory, 'state.db'),
    }),
    projectRoot: '/synthetic/project-root',
    hostPi,
  });
  try {
    const identity = loadOrCreateWorkerIdentity(keyPath);
    const enrollment = await runtime.enrollments.requestEnrollment({
      environmentInstanceId: INSTANCE_ID, displayName: 'Missing dependency MCP Worker',
      publicKey: workerPublicKey(identity.privateKey), platform: 'macos', protocolVersion: '3.0',
      capabilityRequests: ['project-mcp'], engineFacts: [],
    });
    await runtime.enrollments.approve(enrollment.enrollment.id, { capabilityPermissions: { 'project-mcp': true } });
    await connectRuntimeWorker(runtime, enrollment.enrollment.id, keyPath, undefined, workerRoot);
    await runtime.projectService.create({ id: 'missing-mcp-project', displayName: 'Missing MCP Project' });
    await runtime.projectService.addMembership('missing-mcp-project', { agentId: 'scout' });
    await runtime.projectService.updateContent('missing-mcp-project', { mcpConfiguration: { format: 'claude-code-mcp-json-v1' } });
    await runtime.projectAccess.grant({
      projectId: 'missing-mcp-project', environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'relative', path: 'repos/missing-mcp' },
    });
    writeFileSync(join(workerRoot, 'repos', 'missing-mcp', '.mcp.json'), JSON.stringify({
      mcpServers: { missing: { command: 'sprout-ticket244-missing-mcp-fixture-command' } },
    }));
    const submitted = await runtime.orchestrator.submit({
      agentId: 'scout', projectId: 'missing-mcp-project', prompt: 'Use the selected Project MCP server.',
    });
    const run = await runtime.orchestrator.waitFor(submitted.id);
    assert.equal(run.status, 'failed');
    assert.match(run.failure ?? '', /dependency is missing on the Worker.*Install the server dependency on the assigned Environment/);
    assert.equal(hostPiStarted, false, 'Host Pi receives no session without a discovered tool catalog');
    assert.equal(existsSync(marker), false, 'an unavailable command is not launched');
    assert.equal(runtime.pool.leases().some(lease => lease.capability === 'project-mcp' && lease.state === 'active'), false,
      'a certain startup refusal releases its containing run lease');
  } finally {
    await runtime.close();
  }
});
