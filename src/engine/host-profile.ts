import type { EngineAdapter } from './port.ts';

export interface HostEngineReadiness {
  readonly profileId: string;
  readonly engine: string;
  readonly status: 'ready' | 'unavailable' | 'unknown';
  readonly installation: 'ready' | 'missing' | 'unsupported' | 'unknown';
  readonly authentication: 'ready' | 'not-ready' | 'unknown';
  readonly modelAvailability: 'available' | 'unavailable' | 'unknown';
  readonly adapterControls: 'ready' | 'unavailable' | 'unknown';
  readonly version?: string;
  readonly observedAt: number;
}

/** A local Engine profile admitted by Host-run's shared RunOrchestrator path. */
export interface HostRunEngineAdapter extends EngineAdapter {
  readonly profileId: string;
  readonly authorizedModel: string;
  readiness(force?: boolean): Promise<HostEngineReadiness>;
  supportsEffort(effort: string): boolean;
}

export function hostRunEffortSupported(host: HostRunEngineAdapter, effort: string): boolean {
  if (typeof host.supportsEffort === 'function') return host.supportsEffort(effort);
  return host.id === 'pi' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort);
}
