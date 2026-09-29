import type { ConnectionPresentation } from '../../shell/connection.js';
import type { ProjectManagementService } from './types.js';

export type ProjectControlRefusalKind = 'connection-unsettled' | 'authority-unavailable';

export class ProjectControlRefused extends Error {
  readonly kind: ProjectControlRefusalKind;
  readonly connectionStatus: ConnectionPresentation['status'] | undefined;

  constructor(kind: ProjectControlRefusalKind, message: string, connectionStatus?: ConnectionPresentation['status']) {
    super(message);
    this.name = 'ProjectControlRefused';
    this.kind = kind;
    this.connectionStatus = connectionStatus;
  }
}

export interface ProjectControlBoundary {
  canControl(): boolean;
  run<T>(action: (service: ProjectManagementService) => Promise<T>): Promise<T>;
}

export function createProjectControlBoundary(options: {
  service(): ProjectManagementService | undefined;
  presentation(): ConnectionPresentation;
}): ProjectControlBoundary {
  return {
    canControl: () => options.service() !== undefined && options.presentation().controlAvailable,
    async run(action) {
      const service = options.service();
      if (service === undefined) {
        throw new ProjectControlRefused('authority-unavailable', 'No Project authority is configured for this page.');
      }
      const presentation = options.presentation();
      if (!presentation.controlAvailable) {
        throw new ProjectControlRefused('connection-unsettled', presentation.announce, presentation.status);
      }
      return action(service);
    },
  };
}
