import type { WorkspaceSelection } from './access.ts';
import type { ProjectAccessService } from './access-service.ts';
import type { ProjectAuthority } from './authority-model.ts';
import type { CreateProjectInput, ProjectService } from './authority-service.ts';
import type { ProjectCreationStore } from './creation-store.ts';

export interface ProjectEnvironmentCreation {
  readonly environmentInstanceId: string;
  readonly selection: WorkspaceSelection;
}

export interface CreateProjectAggregateInput {
  readonly project: CreateProjectInput;
  readonly environments?: readonly ProjectEnvironmentCreation[];
}

/** Coordinates one atomic Project + selected memberships + workspace creation. */
export class ProjectCreationService {
  readonly #projects: ProjectService;
  readonly #access: ProjectAccessService;
  readonly #store: ProjectCreationStore;

  constructor(options: {
    readonly projects: ProjectService;
    readonly access: ProjectAccessService;
    readonly store: ProjectCreationStore;
  }) {
    this.#projects = options.projects;
    this.#access = options.access;
    this.#store = options.store;
  }

  async create(input: CreateProjectAggregateInput): Promise<ProjectAuthority> {
    const environments = input.environments ?? [];
    const environmentIds = new Set<string>();
    for (const environment of environments) {
      if (environmentIds.has(environment.environmentInstanceId)) {
        throw new Error('A Project can only have one initial workspace assignment per Environment.');
      }
      environmentIds.add(environment.environmentInstanceId);
    }

    const project = await this.#projects.prepareCreate(input.project);
    const prepared = await Promise.all(environments.map((environment) =>
      this.#access.prepareCreationAccess({
        projectId: project.id,
        environmentInstanceId: environment.environmentInstanceId,
        selection: environment.selection,
      }),
    ));
    await this.#projects.commitPreparedCreate(
      project,
      () => this.#store.create(project, prepared.map((entry) => entry.access)),
      () => prepared.forEach((entry) => entry.publish()),
    );
    return project;
  }
}
