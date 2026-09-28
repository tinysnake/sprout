/**
 * LIVE verification for Ticket #159 on a real Windows Environment host.
 *
 * This is deliberately separate from `scripts/verify-ticket-159.ts`, which is a
 * local, synthetic HTTP + SQLite integration check. This script drives the real
 * production Web surface and a real host reached over the operator's existing
 * SSH channel, then observes the durable catalog projection on the review
 * instance.
 *
 * Journey:
 *   1. Start a review instance of this repository (ephemeral DB, explicit port).
 *   2. Create an enrollment through the Web API with NO capabilityRequests.
 *   3. Claim it from the host over SSH and enroll the Worker with a one-use secret.
 *   4. Approve in the Web flow with an explicit capability selection.
 *   5. Start the Worker on the host and wait for the accepted connection.
 *   6. Observe the durable catalog projection: eligible === true.
 *   7. Confirm the negative case: a denied `agent-run` permission refuses admission.
 *
 * No host, network, user, or path material is stored in this file. Everything
 * identifying is supplied at run time through the environment:
 *
 *   SPROUT_LIVE_SSH          required  ssh target (e.g. a `~/.ssh/config` alias)
 *   SPROUT_LIVE_WORKER_DIR   required  remote directory containing `bin/sprout`
 *   SPROUT_LIVE_CORE_HOST    required  address the remote Worker can reach the core at
 *   SPROUT_LIVE_PORT         optional  fixed review-instance port; when omitted the
 *                                      server binds an ephemeral port and advertises it
 *   SPROUT_LIVE_TARGET_LABEL optional  privacy-safe transcript label (default
 *                                      `<remote-host>`; pass `<E8-host>` for the E8 run)
 *   SPROUT_LIVE_ENGINE       optional  required engine (default "pi")
 *   SPROUT_LIVE_MODEL        optional  required provider-scoped model id
 *
 * The script also attests the target's role from the host itself: it reads the
 * host-reported OS version, build, product type, architecture, and PowerShell
 * version over the same SSH channel, and reports the `sprout worker` process as
 * the host reports it. The attestation is printed under the run-time target
 * label (for the E8 run, `<E8-host>`) so a reader can tie the successful run to
 * the documented E8 Windows host without retaining the alias, address,
 * username, or path.
 *
 * Privilege note: a successful run starts a short-lived plaintext WebSocket to
 * the review instance. Use only on a trusted private channel, as the operator
 * already does for the enrollment-to-run journey.
 */
import { exec, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSproutRuntime } from '../src/runtime.ts';
import { parseHostConfiguration } from '../src/host-config.ts';
import { admissionRefusal, projectCatalogEntry } from '../src/environment/catalog.ts';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (see the header of this script)`);
  }
  return value;
}

function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout: String(stdout), stderr: String(stderr) });
        reject(error);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

const SSH = requiredEnv('SPROUT_LIVE_SSH');
const REMOTE_DIR = requiredEnv('SPROUT_LIVE_WORKER_DIR');
const CORE_HOST = requiredEnv('SPROUT_LIVE_CORE_HOST');
const PORT = process.env['SPROUT_LIVE_PORT'] !== undefined && process.env['SPROUT_LIVE_PORT'] !== ''
  ? Number(process.env['SPROUT_LIVE_PORT'])
  : 0;
const TARGET_LABEL = process.env['SPROUT_LIVE_TARGET_LABEL'] ?? '<remote-host>';
const ENGINE = process.env['SPROUT_LIVE_ENGINE'] ?? 'pi';
const MODEL = process.env['SPROUT_LIVE_MODEL'] ?? 'example/model';
const CREDENTIAL = 'live-verification-operator-credential';
const DB_DIR = mkdtempSync(join(tmpdir(), 'sprout-verify-159-live-'));
const DB_PATH = join(DB_DIR, 'review.db');
const INSTANCE_ID = 'web-enrolled-windows-host';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ssh = (remote: string) => `ssh -T -o BatchMode=yes ${SSH} ${remote}`;
const remoteWorker = (args: string) => `cd ${REMOTE_DIR} && node bin/sprout worker ${args}`;

interface HostAttestation {
  readonly isWindows: boolean;
  readonly osVersion: string;
  readonly osBuild: string;
  readonly osProductType: number;
  readonly osArchitecture: string;
  readonly psVersion: string;
  readonly workerProcessRole: string;
  readonly workerProcessCount: number;
}

/**
 * Query the host, over the operator's SSH channel, for evidence of its own
 * identity and role. Nothing here is trusted from the local side: the OS facts
 * and the `sprout worker` process are what the host reports about itself.
 */
async function hostAttestation(): Promise<HostAttestation> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$os = Get-CimInstance Win32_OperatingSystem',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'sprout') -and ($_.CommandLine -match 'worker') })",
    '$worker = $procs | Select-Object -First 1',
    "$role = 'none'",
    "if ($worker) { if ($worker.CommandLine -match 'worker start') { $role = 'worker-start' } elseif ($worker.CommandLine -match 'worker enroll') { $role = 'worker-enroll' } else { $role = 'worker-other' } }",
    "$isWindows = [System.Environment]::OSVersion.Platform -eq 'Win32NT'",
    '[ordered]@{',
    '  isWindows = $isWindows',
    '  osVersion = [string]$os.Version',
    '  osBuild = [string]$os.BuildNumber',
    '  osProductType = [int]$os.ProductType',
    '  osArchitecture = [string]$env:PROCESSOR_ARCHITECTURE',
    '  psVersion = [string]$PSVersionTable.PSVersion',
    '  workerProcessRole = $role',
    '  workerProcessCount = @($procs).Count',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execAsync(ssh(`"powershell -NoProfile -EncodedCommand ${encoded}"`));
  const json = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{')).pop();
  if (json === undefined) throw new Error(`host attestation returned no JSON: ${stdout.trim()}`);
  return JSON.parse(json) as HostAttestation;
}

function describeAttestation(attestation: HostAttestation): string {
  const platform = attestation.isWindows ? 'windows' : 'container';
  return `platform=${platform} osVersion=${attestation.osVersion} build=${attestation.osBuild} productType=${attestation.osProductType} arch=${attestation.osArchitecture} ps=${attestation.psVersion} workerProcessRole=${attestation.workerProcessRole} workerProcessCount=${attestation.workerProcessCount}`;
}

async function run(): Promise<void> {
  console.log(`1. Starting the review instance on ${PORT === 0 ? 'an ephemeral port' : `port ${PORT}`}`);
  const configuration = parseHostConfiguration({
    SPROUT_PORT: String(PORT),
    SPROUT_BIND_HOST: '0.0.0.0',
    SPROUT_ALLOW_INSECURE_WORKER_CONNECTIONS: 'true',
    SPROUT_DATABASE: DB_PATH,
    SPROUT_OPERATOR_CREDENTIAL: CREDENTIAL,
    SPROUT_ENGINE: ENGINE,
    SPROUT_RUNTIME_CONFIG: JSON.stringify({
      agents: [
        { id: 'agent-scout', name: 'Scout', engine: ENGINE, capability: 'agent-run', model: MODEL, workingDirectory: '.' },
      ],
    }),
  }, { projectRoot: process.cwd() });

  const runtime = await createSproutRuntime({ configuration, projectRoot: process.cwd() });
  const { port: boundPort } = await runtime.api.listen(configuration.port, configuration.bindHost);
  await runtime.reconcile();
  const base = `http://127.0.0.1:${boundPort}`;
  let workerProcess: ReturnType<typeof spawn> | undefined;

  try {
    const host = await hostAttestation();
    const platform = host.isWindows ? 'windows' : 'container';
    console.log(`1a. Host-role attestation [${TARGET_LABEL}]: ${describeAttestation(host)}`);

    console.log('2. Signing in through the Web surface');
    const authRes = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: CREDENTIAL }),
    });
    if (!authRes.ok) throw new Error(`authentication failed: ${authRes.status}`);
    const cookie = authRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    const csrf = ((await authRes.json()) as { csrfToken: string }).csrfToken;

    console.log('3. Web creation WITHOUT capabilityRequests');
    const createRes = await fetch(`${base}/api/environments/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrf },
      body: JSON.stringify({ environmentInstanceId: INSTANCE_ID, displayName: 'Web-enrolled Windows host', platform }),
    });
    if (!createRes.ok) throw new Error(`creation failed: ${createRes.status} ${await createRes.text()}`);
    const created = (await createRes.json()) as {
      enrollment: { id: string; capabilityRequests: string[]; capabilityPermissions: Record<string, boolean> };
      claim: { secret: string };
    };
    if (created.enrollment.capabilityRequests.length !== 1 || created.enrollment.capabilityRequests[0] !== 'agent-run') {
      throw new Error(`expected default ['agent-run'], got ${JSON.stringify(created.enrollment.capabilityRequests)}`);
    }
    if (created.enrollment.capabilityPermissions['agent-run'] !== false) {
      throw new Error('expected agent-run to start denied (no auto-grant)');
    }
    console.log(`   created ${created.enrollment.id}; requests=${JSON.stringify(created.enrollment.capabilityRequests)}; permissions=${JSON.stringify(created.enrollment.capabilityPermissions)}`);

    console.log('4. Claiming the enrollment and enrolling the Worker over the operator SSH channel');
    await execAsync(ssh(`"${remoteWorker('reset --yes')}"`)).catch(() => undefined);
    let enrollOutput = '';
    try {
      const result = await execAsync(
        `echo "${created.claim.secret}" | ${ssh(`"${remoteWorker(`enroll ws://${CORE_HOST}:${boundPort} ${created.enrollment.id}`)}"`)}`,
      );
      enrollOutput = result.stdout + result.stderr;
    } catch (error) {
      const candidate = error as { status?: number; stdout?: string; stderr?: string };
      if (candidate.status === 5 || candidate.stdout?.includes('Identity proven')) {
        enrollOutput = (candidate.stdout ?? '') + (candidate.stderr ?? '');
      } else {
        throw error;
      }
    }
    console.log(`   enroll output: ${enrollOutput.trim().split('\n').filter((line) => line.trim() !== '').join(' | ')}`);

    console.log('5. Approving with an explicit capability + model selection');
    const approveRes = await fetch(`${base}/api/environments/enrollments/${created.enrollment.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-sprout-csrf': csrf },
      body: JSON.stringify({
        capabilityPermissions: { 'agent-run': true },
        modelAuthorizations: { [ENGINE]: [MODEL] },
      }),
    });
    if (!approveRes.ok) throw new Error(`approval failed: ${approveRes.status} ${await approveRes.text()}`);
    const approved = (await approveRes.json()) as { enrollment: { status: string; capabilityPermissions: Record<string, boolean> } };
    if (approved.enrollment.capabilityPermissions['agent-run'] !== true) {
      throw new Error('expected the approved agent-run permission to be true');
    }
    console.log(`   approved status=${approved.enrollment.status}; permissions=${JSON.stringify(approved.enrollment.capabilityPermissions)}`);

    console.log('6. Starting the Worker on the host and waiting for the accepted connection');
    workerProcess = spawn('ssh', ['-T', '-o', 'BatchMode=yes', SSH, remoteWorker('start --foreground')]);
    let connected = false;
    workerProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('Connected to Sprout')) connected = true;
      process.stdout.write(`   [worker] ${text.trim()}\n`);
    });
    workerProcess.stderr?.on('data', (chunk: Buffer) => process.stdout.write(`   [worker stderr] ${chunk.toString().trim()}\n`));
    for (let i = 0; i < 30 && !connected; i += 1) await wait(1000);
    if (!connected) throw new Error('the Worker never reported an accepted connection');

    const connectedHost = await hostAttestation();
    console.log(`6a. Host-role attestation after connect [${TARGET_LABEL}]: ${describeAttestation(connectedHost)}`);
    if (connectedHost.workerProcessRole !== 'worker-start') {
      throw new Error(`expected the host to report a running worker-start process, got ${connectedHost.workerProcessRole}`);
    }

    console.log('7. Observing the durable catalog projection');
    let entry = runtime.environmentCatalog.entries().find((candidate) => candidate.instanceId === INSTANCE_ID);
    for (let i = 0; i < 30; i += 1) {
      await runtime.refreshEnvironmentCatalog();
      entry = runtime.environmentCatalog.entries().find((candidate) => candidate.instanceId === INSTANCE_ID);
      console.log(`   poll ${i + 1}: entry=${entry !== undefined} eligible=${entry?.eligible}`);
      if (entry?.eligible === true) break;
      await wait(1000);
    }
    if (entry === undefined) throw new Error('the catalog has no entry for the enrolled instance');
    if (entry.eligible !== true) throw new Error(`expected eligible === true, got ${JSON.stringify(admissionRefusal(entry))}`);
    if (entry.definition.platform !== platform) {
      throw new Error(`host-attested platform ${platform} does not match catalog platform ${entry.definition.platform}`);
    }
    console.log(`   platform=${entry.definition.platform} (host-attested) epoch=${entry.currentEpoch} connection=${entry.readiness.readiness.connection.state} compatibility=${entry.readiness.readiness.compatibility.state}`);
    console.log(`   engines=${JSON.stringify(entry.readiness.readiness.engines.map((engine) => ({ engine: engine.engine, required: engine.required, models: engine.models.state })))}`);
    console.log(`   admission=${JSON.stringify(admissionRefusal(entry))}`);
    console.log('   PASS: live catalog projection reports eligible === true');

    console.log('8. Negative case: a denied agent-run permission must refuse admission');
    const requirements = entry.observed?.requirements;
    const denied = projectCatalogEntry({
      enrollment: { ...entry.enrollment, capabilityPermissions: { ...entry.enrollment.capabilityPermissions, 'agent-run': false } },
      observed: entry.observed,
      workSafety: 'clear',
      currentEpoch: entry.currentEpoch,
      requiredEngines: [ENGINE],
      ...(requirements !== undefined ? { requirements } : {}),
      supportedProtocol: { minMajor: 2, maxMajor: 3 },
      now: Date.now(),
    });
    const deniedRefusal = admissionRefusal(denied);
    if (denied.eligible !== false || deniedRefusal.ok !== false || deniedRefusal.reason !== 'permission-incomplete') {
      throw new Error(`expected permission-incomplete, got ${JSON.stringify(deniedRefusal)}`);
    }
    console.log(`   PASS: denied agent-run refuses admission with ${deniedRefusal.reason}`);
    console.log('LIVE VERIFICATION PASSED');
  } finally {
    workerProcess?.kill('SIGTERM');
    await wait(500);
    await execAsync(ssh(`"${remoteWorker('stop')}"`)).catch(() => undefined);
    await execAsync(ssh(`"${remoteWorker('reset --yes')}"`)).catch(() => undefined);
    await runtime.close();
    rmSync(DB_DIR, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`LIVE VERIFICATION FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
