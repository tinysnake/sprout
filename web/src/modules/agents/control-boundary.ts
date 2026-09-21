/**
 * The Agent control boundary.
 *
 * The Shell owns the connection fact; the Manage Agents page owns the
 * mutations. This module is the single typed seam where the two meet, so a
 * control action either reaches a typed Agent service immediately or is
 * refused with a typed reason. It deliberately keeps no queue: an unsettled
 * connection never retains an action for replay after reconnect, matching the
 * #85 transport and the Environment control boundary.
 */
import type { ConnectionPresentation } from '../../shell/connection.js';
import type { AgentManagementService } from './types.js';

export type AgentControlRefusalKind = 'connection-unsettled' | 'authority-unavailable';

/** The typed, immediate refusal raised instead of queueing a control action. */
export class AgentControlRefused extends Error {
  readonly kind: AgentControlRefusalKind;
  readonly connectionStatus: ConnectionPresentation['status'] | undefined;

  constructor(
    kind: AgentControlRefusalKind,
    message: string,
    connectionStatus?: ConnectionPresentation['status']
  ) {
    super(message);
    this.name = 'AgentControlRefused';
    this.kind = kind;
    this.connectionStatus = connectionStatus;
  }
}

export interface AgentControlBoundary {
  /** True only when `run` would accept an action right now. */
  canControl(): boolean;
  /**
   * Runs one control action against the typed service, or throws
   * {@link AgentControlRefused} without touching the service.
   */
  run<T>(action: (service: AgentManagementService) => Promise<T>): Promise<T>;
}

export interface AgentControlBoundaryOptions {
  service(): AgentManagementService | undefined;
  presentation(): ConnectionPresentation;
}

export function createAgentControlBoundary(
  options: AgentControlBoundaryOptions
): AgentControlBoundary {
  return {
    canControl() {
      return options.service() !== undefined && options.presentation().controlAvailable;
    },
    async run<T>(action: (service: AgentManagementService) => Promise<T>): Promise<T> {
      const service = options.service();
      if (service === undefined) {
        throw new AgentControlRefused(
          'authority-unavailable',
          'No Agent authority is configured for this page.'
        );
      }
      const presentation = options.presentation();
      if (!presentation.controlAvailable) {
        throw new AgentControlRefused(
          'connection-unsettled',
          presentation.announce,
          presentation.status
        );
      }
      return action(service);
    },
  };
}
