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
