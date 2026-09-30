/** Diagnostics have no free-text, identifier, path, model or log slots. */
export const EVENT_STATES = {
  startup: ['ready'], migration: ['initialized', 'unchanged', 'migrated'],
  enrollment: ['requested', 'approved', 'revoked', 'reset', 'archived', 'restored', 'duplicate-same-key', 'identity-claimed', 'duplicate-new-key-refused', 'cancelled', 'secret-regenerated', 'capability-requests-amended', 'models-authorized'],
  connection: ['never-connected', 'online', 'reconnecting', 'offline'],
  compatibility: ['unknown', 'compatible', 'incompatible'],
  interruption: ['interrupted'],
  recovery: ['reconnect-observed', 'evidence-synchronized', 'resumed', 'discarded'],
  release: ['released', 'force-released'],
} as const;
export type EventKind = keyof typeof EVENT_STATES;
export type EventState = typeof EVENT_STATES[EventKind][number];
export interface OperationalEvent { readonly sequence: number; readonly subject: string; readonly kind: EventKind; readonly state: EventState; readonly at: number }
export interface DiagnosticEngine { readonly engine: 'pi' | 'codex'; readonly readiness: 'ready' | 'login-required' | 'missing' | 'unknown' }
export interface DiagnosticVersions { readonly sprout: string; readonly web: string; readonly worker: string; readonly workerProtocol: { readonly minMajor: number; readonly maxMajor: number } }
export interface HostDiagnosticInput {
  readonly schema?: number | null;
  readonly service?: 'running' | 'stopped' | 'failed' | 'unknown';
  readonly data?: 'accessible' | 'unavailable' | 'unknown';
  readonly worker?: 'not-enrolled' | 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'pending-approval' | 'incompatible' | 'revoked' | 'local-configuration-failure' | 'unknown';
  readonly reachability?: 'reachable' | 'unreachable' | 'unknown';
  readonly engines?: readonly DiagnosticEngine[];
}
export interface HostDiagnostic extends Required<HostDiagnosticInput> { readonly format: 1; readonly scope: 'host-local' }
export interface HostDiagnosticExport extends HostDiagnostic { readonly versions: DiagnosticVersions }
export function fact<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T { return allowed.includes(value as T) ? value as T : fallback; }
export function projectEngines(engines: readonly { readonly engine: string; readonly readiness: string }[] = []): readonly DiagnosticEngine[] {
  return engines.filter(e => e.engine === 'pi' || e.engine === 'codex').map(e => ({ engine: e.engine as 'pi' | 'codex', readiness: fact(e.readiness, ['ready', 'login-required', 'missing', 'unknown'], 'unknown') }));
}
/** Caller supplies observations, not logs. Unknown is never reported healthy. */
export function projectHostDiagnostic(input: HostDiagnosticInput): HostDiagnostic {
  return { format: 1, scope: 'host-local', schema: Number.isSafeInteger(input.schema) && input.schema! >= 0 ? input.schema! : null,
    service: fact(input.service, ['running', 'stopped', 'failed', 'unknown'], 'unknown'),
    data: fact(input.data, ['accessible', 'unavailable', 'unknown'], 'unknown'),
    worker: fact(input.worker, ['not-enrolled', 'stopped', 'connecting', 'connected', 'reconnecting', 'pending-approval', 'incompatible', 'revoked', 'local-configuration-failure', 'unknown'], 'unknown'),
    reachability: fact(input.reachability, ['reachable', 'unreachable', 'unknown'], 'unknown'), engines: projectEngines(input.engines) };
}
export interface WebDiagnostic {
  readonly format: 1; readonly scope: 'web'; readonly versions: DiagnosticVersions;
  readonly schema: number | null; readonly service: 'running'; readonly data: 'accessible';
  readonly environments: readonly { readonly subject: string; readonly enrollment: 'pending' | 'approved' | 'revoked' | 'archived'; readonly connection: 'never-connected' | 'online' | 'reconnecting' | 'offline'; readonly compatibility: 'unknown' | 'compatible' | 'incompatible'; readonly worker: 'connected' | 'not-connected'; readonly reachability: 'reachable' | 'unknown'; readonly engines: readonly DiagnosticEngine[]; readonly workSafety: 'clear' | 'held' | 'reconciling' | 'recovery' }[];
  readonly events: readonly OperationalEvent[];
}
/** Installed versions/ranges only: not negotiated Worker compatibility, schema support
 * limits, or migration safety-copy existence/retention. Those must not be inferred. */
export interface OperatorSettings {
  readonly versions: DiagnosticVersions;
  readonly session: { readonly authenticated: true; readonly activeCount: number };
  readonly access: { readonly boundary: 'private-network-and-authentication'; readonly publicInternetSupported: false };
  readonly responsibilities: { readonly web: readonly ['sessions', 'enrollment', 'recovery', 'diagnostics']; readonly hostLocal: readonly ['credentials', 'engine-login', 'service', 'network', 'backup', 'upgrade'] };
}
