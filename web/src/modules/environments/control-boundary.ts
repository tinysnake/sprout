/**
 * The Environment control boundary.
 *
 * The Shell owns the connection fact; the Environment page owns the mutations.
 * This module is the single typed seam where the two meet, so a control action
 * either reaches a typed environment service immediately or is refused with a
 * typed reason. It deliberately keeps no queue: an unsettled connection never
 * retains an action for replay after reconnect, matching the #85 transport.
 */
import type { ConnectionPresentation } from '../../shell/connection.js';
import type { EnvironmentService } from './ports.js';

export type ControlRefusalKind = 'connection-unsettled' | 'authority-unavailable';

/** The typed, immediate refusal raised instead of queueing a control action. */
export class EnvironmentControlRefused extends Error {
  readonly kind: ControlRefusalKind;
  readonly connectionStatus: ConnectionPresentation['status'] | undefined;

  constructor(kind: ControlRefusalKind, message: string, connectionStatus?: ConnectionPresentation['status']) {
    super(message);
    this.name = 'EnvironmentControlRefused';
    this.kind = kind;
    this.connectionStatus = connectionStatus;
  }
}

export interface EnvironmentControlBoundary {
  /** True only when `run` would accept an action right now. */
  canControl(): boolean;
  /**
   * Runs one control action against the typed service, or throws
   * {@link EnvironmentControlRefused} without touching the service.
   */
  run<T>(action: (service: EnvironmentService) => Promise<T>): Promise<T>;
}

export interface EnvironmentControlBoundaryOptions {
  service(): EnvironmentService | undefined;
  presentation(): ConnectionPresentation;
}

export function createEnvironmentControlBoundary(
  options: EnvironmentControlBoundaryOptions
): EnvironmentControlBoundary {
  return {
    canControl() {
      return options.service() !== undefined && options.presentation().controlAvailable;
    },
    async run<T>(action: (service: EnvironmentService) => Promise<T>): Promise<T> {
      const service = options.service();
      if (service === undefined) {
        throw new EnvironmentControlRefused(
          'authority-unavailable',
          'No environment authority is configured for this page.'
        );
      }
      const presentation = options.presentation();
      if (!presentation.controlAvailable) {
        throw new EnvironmentControlRefused(
          'connection-unsettled',
          presentation.announce,
          presentation.status
        );
      }
      return action(service);
    },
  };
}

/**
 * Safely format a decisive refusal notice from a server refusal (such as typed
 * 409 error/code) or client control refusal. Raw status codes and bare error
 * strings are filtered so operator UI remains decisive and clean.
 */
export function formatRefusalNotice(error: unknown, fallback = 'Action could not be completed'): string {
  if (error instanceof EnvironmentControlRefused) {
    return error.message;
  }
  const err = error as { code?: string; message?: string; refusal?: string; status?: number } | undefined;
  const code = err?.code;
  const message = err?.refusal || err?.message;

  if (code === 'not-pending') {
    return message && message !== 'request could not be completed'
      ? `This enrollment is no longer pending (${code}): ${message}`
      : `This enrollment is no longer pending (${code}).`;
  }

  if (code && message && message !== 'request could not be completed') {
    return `Action refused (${code}): ${message}`;
  }

  if (code) {
    return `Action refused (${code}).`;
  }

  if (message && message !== 'request could not be completed') {
    return message;
  }

  return fallback;
}
