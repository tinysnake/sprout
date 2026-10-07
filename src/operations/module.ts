import { randomUUID } from 'node:crypto';
import { PRODUCT_VERSIONS } from './versions.ts';
import type { OperatorSessionService } from '../auth/service.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';

import type { EnvironmentRecoveryService } from '../environment/recovery-service.ts';
import { DiagnosticsService, diagnosticSubject, type OperationalStore } from './service.ts';
import { feedTarget, type FeedTarget } from '../web/feed.ts';
import type { AgentRun } from '../run/model.ts';
import type { Task } from '../task/model.ts';
import type { HostPiReadiness } from '../engine/pi-host.ts';
import { type ExecutionStrategy } from '../execution-mode.ts';
import { fact, projectEngines, projectDiagnosticCorrelation, diagnosticIdentity, isDiagnosticTarget, type DiagnosticEvent, type DiagnosticCorrelation, type EventKind, type EventState, type OperatorSettings, type WebDiagnostic } from './contract.ts';

export { PRODUCT_VERSIONS } from './versions.ts';

/** Read-only observation: never probes engines, admits work, or releases leases. */
export class OperatorDiagnostics {
  private readonly journal: DiagnosticsService;
  private pending: Promise<void> = Promise.resolve();
  private readonly options: {
    readonly store: OperationalStore;
    readonly schema: number | null;
    readonly auth: OperatorSessionService;
    readonly enrollments: Pick<EnvironmentEnrollmentService, 'list' | 'readiness'>;
    readonly recovery: Pick<EnvironmentRecoveryService, 'list'>;
    readonly executionStrategy: ExecutionStrategy;
    readonly hostPiReadiness?: () => Promise<HostPiReadiness | undefined>;
    readonly connected?: (instanceId: string) => boolean;
    readonly run?: (id: string) => Promise<Pick<AgentRun, 'id' | 'projectId' | 'agentId'> | undefined>;
    readonly task?: (id: string) => Promise<Pick<Task, 'id' | 'projectId'> | undefined>;
  };
  constructor(options: OperatorDiagnostics['options']) {
    this.options = options;
    this.journal = new DiagnosticsService(options.store);
  }
  async start(): Promise<void> { await this.journal.transition(randomUUID(), 'startup', 'ready', Date.now()); }
  /** Serialize observations so older snapshots cannot overwrite newer ones. */
  capture(): Promise<void> {
    const next = this.pending.then(async () => { await this.snapshot(true); });
    this.pending = next.catch(() => undefined);
    return next;
  }
  async settings(currentSessionId: string): Promise<OperatorSettings> {
    const sessions = await this.options.auth.listSessions(currentSessionId);
    if (!sessions.some(s => s.current)) throw new Error('authenticated session required');
    const hostPi = await this.options.hostPiReadiness?.();
    return { versions: PRODUCT_VERSIONS, executionMode: this.options.executionStrategy.mode,
      ...(hostPi === undefined ? { hostPi: { status: 'not-configured' as const } } : { hostPi: {
        status: hostPi.status,
        installation: hostPi.installation,
        authentication: hostPi.authentication,
        modelAvailability: hostPi.modelAvailability,
        adapterControls: hostPi.adapterControls,
        ...(hostPi.version !== undefined ? { version: hostPi.version } : {}),
      } }),
      session: { authenticated: true, activeCount: sessions.length },
      access: { boundary: 'private-network-and-authentication', publicInternetSupported: false },
      responsibilities: { web: ['sessions', 'enrollment', 'recovery', 'diagnostics'], hostLocal: ['credentials', 'engine-login', 'service', 'network', 'backup', 'upgrade'] } };
  }
  async export(): Promise<WebDiagnostic> {
    await this.capture();
    return { format: 1, scope: 'web', versions: PRODUCT_VERSIONS, schema: this.options.schema, service: 'running', data: 'accessible', environments: await this.snapshot(false), events: await this.correlatedEvents() };
  }
  /** Rejoin durable source keys at read time; the journal retains no rich records. */
  private async correlatedEvents(): Promise<readonly DiagnosticEvent[]> {
    const identities = new Map<string, { correlation: DiagnosticCorrelation; target?: FeedTarget }>();
    for (const recovery of await this.options.recovery.list()) {
      const correlation = projectDiagnosticCorrelation({
        runId: recovery.runId ?? (recovery.holderKind === 'run' ? recovery.holderId : undefined),
        taskId: recovery.taskId ?? (recovery.holderKind === 'task' ? recovery.holderId : undefined),
      });
      if (!correlation) continue;
      let target: FeedTarget | undefined;
      const task = correlation.taskId ? await this.options.task?.(correlation.taskId) : undefined;
      const run = correlation.runId ? await this.options.run?.(correlation.runId) : undefined;
      const candidate = task && task.id === correlation.taskId && diagnosticIdentity(task.projectId)
        ? feedTarget({ surface: 'project-task-detail', projectId: task.projectId, taskId: task.id })
        : run && run.id === correlation.runId
          ? diagnosticIdentity(run.projectId)
            ? feedTarget({ surface: 'project-chat', projectId: run.projectId, runId: run.id })
            : run.projectId === undefined && diagnosticIdentity(run.agentId)
              ? feedTarget({ surface: 'agent-detail', agentId: run.agentId })
              : undefined
          : undefined;
      if (candidate && isDiagnosticTarget(candidate)) target = candidate;
      for (const [index] of recovery.decisions.entries()) {
        identities.set(diagnosticSubject(`recovery:${recovery.id}:${index}`), { correlation, ...(target ? { target } : {}) });
      }
    }
    return (await this.journal.events()).map(event => ({
      sequence: event.sequence, subject: event.subject, kind: event.kind, state: event.state, at: event.at,
      ...identities.get(event.subject),
    }));
  }
  private async snapshot(record: boolean): Promise<WebDiagnostic['environments']> {
    const environments: WebDiagnostic['environments'][number][] = [];
    for (const enrollment of await this.options.enrollments.list()) {
      if (record) for (const [index, decision] of enrollment.decisions.entries()) {
        await this.journal.transition(`enrollment:${enrollment.id}:${index}`, 'enrollment', decision.kind, decision.at);
      }
      const assembled = await this.options.enrollments.readiness(enrollment.id);
      const r = assembled.readiness;
      const connected = this.options.connected?.(enrollment.environmentInstanceId);
      const observedConnection = fact(r.connection.state, ['never-connected', 'online', 'reconnecting', 'offline'], 'never-connected');
      // A historical observation is not a live accepted Worker, but it proves
      // this Environment has connected before. Restart must not relabel it new.
      const connection = connected === true ? 'online' : connected === false && assembled.currentObservation !== undefined ? 'offline' : observedConnection;
      const compatibility = assembled.connectionAttempt?.outcome === 'incompatible' ? 'incompatible' : fact(r.compatibility.state, ['unknown', 'compatible', 'incompatible'], 'unknown');
      if (record) {
        await this.journal.transition(enrollment.id, 'connection', connection, Date.now());
        await this.journal.transition(enrollment.id, 'compatibility', compatibility, Date.now());
      }
      environments.push({ subject: diagnosticSubject(enrollment.id), enrollment: fact(enrollment.status, ['pending', 'approved', 'revoked', 'archived'], 'pending'), connection, compatibility,
        worker: connection === 'online' ? 'connected' : 'not-connected', reachability: connection === 'online' ? 'reachable' : 'unknown', engines: projectEngines(r.engines), workSafety: fact(r.workSafety.state, ['clear', 'held', 'reconciling', 'recovery'], 'recovery') });
    }
    if (record) for (const recovery of await this.options.recovery.list()) for (const [index, decision] of recovery.decisions.entries()) {
      const kind: EventKind = decision.kind === 'interrupted' ? 'interruption' : decision.kind === 'released' || decision.kind === 'force-released' ? 'release' : 'recovery';
      await this.journal.transition(`recovery:${recovery.id}:${index}`, kind, decision.kind as EventState, decision.at);
    }
    return environments;
  }
}
