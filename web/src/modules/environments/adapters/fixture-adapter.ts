import type { EnvironmentService } from '../ports.ts';
import type {
  CapabilityKey,
  EnvironmentInstance,
  ForceReleaseParams,
  ProbeRecord,
} from '../types.ts';

export function createInitialFixtures(): EnvironmentInstance[] {
  return [
    {
      id: 'env-ready',
      displayName: 'Mac Studio M2 Max',
      platform: 'macos',
      trafficLight: 'green',
      trafficLightReason: 'All capabilities permitted · Engines authenticated · Lease held by Task #101',
      enrollmentStatus: 'approved',
      connectionState: 'online',
      connectionAgeSec: 10,
      lastConfirmedTime: '10s ago',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'held',
      activeLeaseHolder: {
        holderId: '101',
        holderKind: 'task',
        taskTitle: 'Refactor Environment State Manager',
        projectId: 'sprout-m2',
        leadAgentName: 'Programmer',
        acquiredAt: '2026-09-19 10:14:02',
      },
      capabilityPermissions: {
        fileReadWrite: true,
        processExecution: true,
        networkAccess: true,
        guiAutomation: true,
      },
      engineReadiness: {
        codex: 'ready',
        pi: 'ready',
        agy: 'ready',
        opencode: 'ready',
      },
      engineDetails: {
        codex: { version: 'v0.9.4', authStatus: 'authenticated', modelAvailability: 'gpt-5-codex, claude-3-7-sonnet' },
        pi: { version: 'v1.4.0', authStatus: 'authenticated', modelAvailability: 'gemini-2.5-pro, claude-3-5-sonnet' },
        agy: { version: 'v0.6.2', authStatus: 'authenticated', modelAvailability: 'antigravity-deep-code' },
        opencode: { version: 'v1.0.1', authStatus: 'authenticated', modelAvailability: 'local-qwen-coder-32b' },
      },
      probeHistory: [
        {
          timestamp: '10:14:00',
          latencyMs: 14,
          protocolOk: true,
          enginesOk: true,
          summary: 'Live carrier probe confirmed protocol v2.1 & all 4 engines ready',
        },
        {
          timestamp: '10:09:00',
          latencyMs: 18,
          protocolOk: true,
          enginesOk: true,
          summary: 'Routine heartbeat verification passed',
        },
      ],
      boundWorkspaces: [
        {
          projectId: 'sprout-m2',
          projectDisplayName: 'Sprout M2 Operator',
          workspaceRoot: 'sprout-workspace',
          relativeWorkspacePath: 'repos/sprout',
          status: 'Prepared & Ready',
        },
      ],
    },
    {
      id: 'env-recovery',
      displayName: 'Windows Workstation 01',
      platform: 'windows',
      trafficLight: 'red',
      trafficLightReason: 'Worker offline for 14 minutes · Lease recovery required (interrupted run #206)',
      enrollmentStatus: 'approved',
      connectionState: 'offline',
      connectionAgeSec: 840,
      lastConfirmedTime: '14m ago',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'recovery',
      activeLeaseHolder: {
        holderId: '104',
        holderKind: 'task',
        taskTitle: 'Multi-Agent Simulation Validation',
        projectId: 'sprout-m2',
        leadAgentName: 'Architect',
        acquiredAt: '2026-09-19 09:30:15',
      },
      capabilityPermissions: {
        fileReadWrite: true,
        processExecution: true,
        networkAccess: false,
        guiAutomation: false,
      },
      engineReadiness: {
        codex: 'ready',
        pi: 'ready',
        agy: 'missing',
        opencode: 'unknown',
      },
      engineDetails: {
        codex: { version: 'v0.9.4', authStatus: 'active' },
        pi: { version: 'v1.4.0', authStatus: 'active' },
        agy: { version: 'uninstalled', authStatus: 'missing', notes: 'CLI binary not detected on Windows PATH' },
      },
      leaseRecovery: {
        cause: 'Worker carrier lost mid-turn during active Agent run #206.',
        interruptedRunId: 'run-206',
        interruptedRunAgent: 'Architect',
        unresolvedFacts: [
          'Worker process unreachable over carrier overlay (host reboot suspected)',
          'Engine process status unverified on host',
          'Task scratch context directory not yet recycled',
        ],
      },
      probeHistory: [
        {
          timestamp: '09:45:00',
          latencyMs: 999,
          protocolOk: false,
          enginesOk: false,
          summary: 'Probe failed: Connection timeout over carrier overlay',
        },
      ],
      boundWorkspaces: [
        {
          projectId: 'sprout-m2',
          projectDisplayName: 'Sprout M2 Operator',
          workspaceRoot: 'sprout-win-workspace',
          relativeWorkspacePath: 'work/sprout',
          status: 'Prepared & Ready',
        },
      ],
    },
    {
      id: 'env-pending',
      displayName: 'MacBook Pro Operator Local',
      platform: 'macos',
      trafficLight: 'yellow',
      trafficLightReason: 'Pending enrollment approval by operator · Worker identity verified',
      enrollmentStatus: 'pending',
      connectionState: 'reconnecting',
      connectionAgeSec: 2,
      lastConfirmedTime: 'just now',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'clear',
      capabilityPermissions: {
        fileReadWrite: true,
        processExecution: false,
        networkAccess: false,
        guiAutomation: false,
      },
      engineReadiness: {
        codex: 'ready',
        pi: 'ready',
        agy: 'ready',
        opencode: 'ready',
      },
      probeHistory: [],
      boundWorkspaces: [],
    },
    {
      id: 'env-degraded',
      displayName: 'Linux Container Node',
      platform: 'container',
      trafficLight: 'yellow',
      trafficLightReason: 'Degraded · Codex engine login required · GUI automation unavailable',
      enrollmentStatus: 'approved',
      connectionState: 'online',
      connectionAgeSec: 45,
      lastConfirmedTime: '45s ago',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'clear',
      capabilityPermissions: {
        fileReadWrite: true,
        processExecution: true,
        networkAccess: true,
        guiAutomation: false,
      },
      engineReadiness: {
        codex: 'login-required',
        pi: 'ready',
        agy: 'missing',
        opencode: 'ready',
      },
      engineDetails: {
        codex: { version: 'v0.9.4', authStatus: 'login-required', notes: 'Operator token expired; run codex login on host' },
        pi: { version: 'v1.4.0', authStatus: 'active' },
        agy: { version: 'uninstalled', authStatus: 'missing' },
        opencode: { version: 'v1.0.1', authStatus: 'active' },
      },
      probeHistory: [
        {
          timestamp: '10:12:00',
          latencyMs: 32,
          protocolOk: true,
          enginesOk: false,
          summary: 'Degraded engine state detected: Codex login required',
        },
      ],
      boundWorkspaces: [
        {
          projectId: 'sprout-m2',
          projectDisplayName: 'Sprout M2 Operator',
          workspaceRoot: 'container-mount',
          relativeWorkspacePath: 'shared/sprout',
          status: 'Prepared & Ready',
        },
      ],
    },
    {
      id: 'env-incompatible',
      displayName: 'Legacy Mac mini',
      platform: 'macos',
      trafficLight: 'red',
      trafficLightReason: 'Protocol incompatible: worker protocol v1.8 is below required v2.0+',
      enrollmentStatus: 'approved',
      connectionState: 'online',
      connectionAgeSec: 60,
      lastConfirmedTime: '1m ago',
      protocolVersion: 'v1.8',
      protocolCompatibility: 'incompatible',
      protocolMismatchDetail: 'Worker running protocol v1.8. Minimum supported protocol is v2.0. Please upgrade sprout-worker binary on host machine.',
      workSafety: 'clear',
      capabilityPermissions: {
        fileReadWrite: false,
        processExecution: false,
        networkAccess: false,
        guiAutomation: false,
      },
      engineReadiness: {
        codex: 'unknown',
        pi: 'unknown',
        agy: 'unknown',
        opencode: 'unknown',
      },
      probeHistory: [],
      boundWorkspaces: [],
    },
    {
      id: 'env-archived',
      displayName: 'Old Windows Server 2022',
      platform: 'windows',
      trafficLight: 'yellow',
      trafficLightReason: 'Archived Instance · Worker identity preserved · New work admission barred',
      enrollmentStatus: 'archived',
      connectionState: 'offline',
      connectionAgeSec: 259200,
      lastConfirmedTime: '3d ago',
      protocolVersion: 'v2.0',
      protocolCompatibility: 'compatible',
      workSafety: 'clear',
      capabilityPermissions: {
        fileReadWrite: false,
        processExecution: false,
        networkAccess: false,
        guiAutomation: false,
      },
      engineReadiness: {
        codex: 'missing',
        pi: 'missing',
        agy: 'missing',
        opencode: 'missing',
      },
      probeHistory: [],
      boundWorkspaces: [],
    },
  ];
}

export class FixtureEnvironmentService implements EnvironmentService {
  private instances: EnvironmentInstance[];

  constructor(initialData?: EnvironmentInstance[]) {
    this.instances = initialData ?? createInitialFixtures();
  }

  async listEnvironments(): Promise<EnvironmentInstance[]> {
    return JSON.parse(JSON.stringify(this.instances));
  }

  async getEnvironment(id: string): Promise<EnvironmentInstance | undefined> {
    const found = this.instances.find((e) => e.id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  }

  async approveEnrollment(id: string): Promise<void> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    env.enrollmentStatus = 'approved';
    env.connectionState = 'online';
    env.trafficLight = 'green';
    env.trafficLightReason = 'Approved by operator · All health checks passed';
  }

  async triggerProbe(id: string): Promise<ProbeRecord> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    const record: ProbeRecord = {
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      latencyMs: Math.floor(Math.random() * 20) + 10,
      protocolOk: env.protocolCompatibility === 'compatible',
      enginesOk: env.engineReadiness.codex === 'ready' && env.engineReadiness.pi === 'ready',
      summary: `Readiness probe completed in ${Math.floor(Math.random() * 20) + 10}ms: Protocol ${env.protocolVersion} (${env.protocolCompatibility})`,
    };
    env.probeHistory.unshift(record);
    env.lastConfirmedTime = 'just now';
    env.connectionAgeSec = 0;
    return record;
  }

  async togglePermission(id: string, cap: CapabilityKey): Promise<void> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    env.capabilityPermissions[cap] = !env.capabilityPermissions[cap];
  }

  async unbindWorkspace(projectId: string, envId: string): Promise<void> {
    const env = this.instances.find((e) => e.id === envId);
    if (!env) throw new Error(`Environment ${envId} not found`);
    env.boundWorkspaces = env.boundWorkspaces.filter((w) => w.projectId !== projectId);
  }

  async reconcileEvidence(id: string): Promise<void> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    if (env.leaseRecovery) {
      env.leaseRecovery.reconciledEvidence = {
        retainedEventsCount: 4,
        engineStoppedProof: true,
      };
      env.trafficLightReason = 'Evidence reconciled (4 events, engine stopped proof) · Ready for Human recovery decision';
    }
    env.workSafety = 'recovery';
  }

  async resumeRecovery(taskId: string): Promise<void> {
    const env = this.instances.find((e) => e.activeLeaseHolder?.holderId === taskId || e.leaseRecovery);
    if (!env) return;
    env.workSafety = 'held';
    env.leaseRecovery = undefined;
    env.trafficLight = 'green';
    env.trafficLightReason = `Task #${taskId} resumed on host · Lease held exclusively`;
  }

  async discardRecovery(taskId: string): Promise<void> {
    const env = this.instances.find((e) => e.activeLeaseHolder?.holderId === taskId || e.leaseRecovery);
    if (!env) return;
    env.workSafety = 'clear';
    env.activeLeaseHolder = undefined;
    env.leaseRecovery = undefined;
    env.trafficLight = 'green';
    env.trafficLightReason = `Task #${taskId} discarded and scratch context recycled · Environment clear`;
  }

  async forceRelease(params: ForceReleaseParams): Promise<void> {
    const env = this.instances.find((e) => e.id === params.environmentId);
    if (!env) throw new Error(`Environment ${params.environmentId} not found`);
    if (!params.acknowledgedRisks || params.reason.trim() === '') {
      throw new Error('Force release requires risk acknowledgement and operator reason.');
    }
    env.workSafety = 'clear';
    env.activeLeaseHolder = undefined;
    env.leaseRecovery = undefined;
    env.trafficLight = 'green';
    env.trafficLightReason = `Force Released by Operator (${params.reason}) · Reassignable`;
    env.forcedReleaseRecord = {
      actor: 'Operator (Human Override)',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reason: params.reason,
    };
  }

  async archiveEnvironment(id: string): Promise<void> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    env.enrollmentStatus = 'archived';
    env.trafficLight = 'yellow';
    env.trafficLightReason = 'Archived Instance · Worker identity preserved · New work admission barred';
  }

  async restoreEnvironment(id: string): Promise<void> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    env.enrollmentStatus = 'approved';
    env.trafficLight = 'green';
    env.trafficLightReason = 'Restored from archive · Instance ready';
  }

  async unenrollEnvironment(id: string): Promise<void> {
    const env = this.instances.find((e) => e.id === id);
    if (!env) throw new Error(`Environment ${id} not found`);
    env.enrollmentStatus = 'revoked';
    env.connectionState = 'offline';
    env.trafficLight = 'red';
    env.trafficLightReason = 'Identity key revoked by operator · Reconnection permanently barred';
  }
}
