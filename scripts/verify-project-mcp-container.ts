import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ContainerCarrier } from '../src/worker/container-carrier.ts';
import type { ContainerRuntime } from '../src/environment/container.ts';
import type { StartProjectMcpParams, CallProjectMcpToolParams } from '../src/worker/protocol.ts';
import { buildProjectMcpTools } from '../src/engine/pi-host-tools.ts';
import type { PiProjectMcpTool } from '../src/engine/pi-host-tools.ts';
import type { WorkerConnection } from '../src/worker/carrier.ts';

const execFileAsync = promisify(execFile);
const IMAGE = 'sprout/environment:latest';
const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
const containerName = `sprout-ticket244-mcp-${suffix}`;
const volumeName = `sprout-ticket244-mcp-data-${suffix}`;
const workerMarkerName = `sprout-ticket244-worker-${suffix}`;
const projectRoot = join(import.meta.dirname, '..');
const repoMount = `${projectRoot}:/sprout:ro`;
let containerCreated = false;
let connection: WorkerConnection | undefined;

class BoundedDockerRuntime implements ContainerRuntime {
  async available() {
    try {
      const { stdout } = await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
      return { available: true, detail: `Docker ${stdout.trim()}` };
    } catch {
      return { available: false, detail: 'Docker is unavailable' };
    }
  }

  async create(options: Parameters<ContainerRuntime['create']>[0]): Promise<void> {
    const args = ['run', '-d', '--name', options.name];
    for (const volume of options.volumes ?? []) args.push('-v', volume);
    for (const [key, value] of Object.entries(options.environment ?? {})) args.push('-e', `${key}=${value}`);
    args.push(options.image, 'sleep', 'infinity');
    await execFileAsync('docker', args, { timeout: 30_000 });
  }

  async exists(name: string): Promise<boolean> {
    const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'], { timeout: 20_000 });
    return stdout.split('\n').some(line => line.trim() === name);
  }

  async exec(name: string, command: readonly string[]) {
    try {
      const { stdout, stderr } = await execFileAsync('docker', ['exec', name, ...command], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  execProcess(name: string, command: readonly string[], options: { environment?: Record<string, string> } = {}): ChildProcess {
    const args = ['exec', '-i'];
    for (const [key, value] of Object.entries(options.environment ?? {})) args.push('-e', `${key}=${value}`);
    args.push(name, ...command);
    return spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async stop(name: string): Promise<void> {
    await execFileAsync('docker', ['stop', '--time', '3', name], { timeout: 15_000 });
  }

  async remove(name: string): Promise<void> {
    await execFileAsync('docker', ['rm', '-f', name], { timeout: 20_000 });
  }
}

function writeInside(runtime: BoundedDockerRuntime, target: string, contents: string): Promise<void> {
  const source = `const fs = require('node:fs'); const path = ${JSON.stringify(target)}; fs.mkdirSync(${JSON.stringify(dirname(target))}, { recursive: true }); fs.writeFileSync(path, ${JSON.stringify(contents)});`;
  return runtime.exec(containerName, ['node', '-e', source]).then(result => {
    if (result.code !== 0) throw new Error('could not prepare the disposable Worker volume');
  });
}

async function main(): Promise<void> {
  const runtime = new BoundedDockerRuntime();
  const availability = await runtime.available();
  if (!availability.available) throw new Error(availability.detail);
  if (await runtime.exists(containerName)) throw new Error('generated disposable container name already exists');
  await runtime.create({ name: containerName, image: IMAGE, volumes: [repoMount, `${volumeName}:/worker-root`] });
  containerCreated = true;
  const carrier = new ContainerCarrier({
    runtime: runtime as ContainerRuntime,
    containerName,
    workerEntryPath: '/sprout/scripts/project-mcp-container-worker.mjs',
    environmentInstanceId: `ticket244-${suffix}`,
    workingDirectory: '/worker-root',
    onLog: line => process.stderr.write(`Worker diagnostic: ${line}\n`),
  });
  connection = await carrier.start();
  const contexts = connection.contexts;
  const projectId = 'ticket244-origin-proof';
  const workspacePath = 'proof-project';
  const selected = await contexts.validateWorkspace({ projectId, environmentInstanceId: `ticket244-${suffix}`, kind: 'relative', path: workspacePath });
  const binding = {
    projectId, environmentInstanceId: `ticket244-${suffix}`, bindingId: `binding-${suffix}`,
    generation: 1, connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative' as const, path: workspacePath,
  };
  await contexts.attachWorkspaceBinding(binding);
  const workspaceRoot = `/worker-root/.sprout-workspaces/${workspacePath}`;
  const dependencyRoot = join(workspaceRoot, 'node_modules', 'mcp-worker-origin');
  await writeInside(runtime, join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'mcp-worker-origin', type: 'module', exports: './index.mjs' }));
  await writeInside(runtime, join(dependencyRoot, 'index.mjs'), "export const origin = 'worker-volume-dependency';\n");
  const serverScript = `
    import { origin } from 'mcp-worker-origin';
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    writeFileSync('/tmp/${workerMarkerName}', 'worker-only');
    const tools = [{ name: 'resolve-origin', description: 'Resolve a dependency from this Project workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
    const input = createInterface({ input: process.stdin });
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'disposable-origin-proof', version: '1' } } });
      else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: origin }] } });
    });
  `;
  const manifest = JSON.stringify({ mcpServers: {
    origin: { command: 'node', args: ['--input-type=module', '-e', serverScript] },
  } });
  await writeInside(runtime, join(workspaceRoot, '.mcp.json'), manifest);
  const processId = randomUUID();
  const lease = { leaseId: `lease-${suffix}`, holderKind: 'run' as const, holderId: `run-${suffix}`, runId: `run-${suffix}` };
  const start: StartProjectMcpParams = { ...binding, ...lease, processId, format: 'claude-code-mcp-json-v1' };
  const catalog = await contexts.startProjectMcp(start);
  assert.equal(catalog.status, 'ready');
  assert.equal(catalog.servers[0]?.tools.length, 1);
  const declaration = catalog.servers[0]?.tools[0];
  assert.ok(declaration);
  const toolName = `mcp_${basename(declaration.server)}_${declaration.name}`;
  const piTools: readonly PiProjectMcpTool[] = buildProjectMcpTools([{
    name: toolName, description: declaration.description, inputSchema: declaration.inputSchema,
  }], async (_operation, args) => {
    const call = args as { readonly name: string; readonly arguments: Record<string, unknown> };
    const input: CallProjectMcpToolParams = {
      ...binding, ...lease, processId, operationId: randomUUID(), toolId: declaration.id, arguments: call.arguments,
    };
    return contexts.callProjectMcpTool(input);
  });
  const tool = piTools[0];
  assert.ok(tool);
  const call = await tool.execute('typed-call', {});
  assert.equal(call.isError, false);
  assert.deepEqual(call.details, { processId, operationId: JSON.parse(call.content[0]!.text).operationId, status: 'completed', text: 'worker-volume-dependency' });
  const marker = await runtime.exec(containerName, ['test', '-f', `/tmp/${workerMarkerName}`]);
  assert.equal(marker.code, 0, 'the server process created its marker in the disposable container');
  assert.equal(existsSync(join('/tmp', workerMarkerName)), false, 'the server marker is absent from the Sprout host');
  const stopped = await contexts.stopProjectMcp({ ...binding, ...lease, processId });
  assert.equal(stopped.status, 'stopped');
  process.stdout.write('PASS: disposable container Worker resolved a workspace dependency and completed a typed Pi tool call; process marker stayed inside the container.\n');
}

try {
  await main();
} finally {
  await connection?.close();
  if (containerCreated) {
    await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 20_000 }).catch(() => undefined);
    await execFileAsync('docker', ['volume', 'rm', volumeName], { timeout: 20_000 }).catch(() => undefined);
  }
}
