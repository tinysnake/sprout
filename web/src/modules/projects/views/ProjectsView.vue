<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ProjectAuthorityView, ProjectEnvironmentCreationInput, ProjectMembershipView, WorkspaceSelectionInput } from '../../../adapters/project-api.js';
import { BrowserRequestError } from '../../../transport/browser-transport.js';
import { useAnnouncer } from '../../../primitives/announcer.js';
import { useShellConnection } from '../../../shell/use-shell-connection.js';
import Badge from '../../../primitives/Badge.vue';
import Button from '../../../primitives/Button.vue';
import Dialog from '../../../primitives/Dialog.vue';
import EmptyState from '../../../primitives/EmptyState.vue';
import Icon from '../../../primitives/Icon.vue';
import { createProjectControlBoundary, ProjectControlRefused } from '../control-boundary.js';
import { PROJECT_SERVICE, type ProjectManagementService, type ProjectOverviewData } from '../types.js';

/**
 * Production Project Overview (#94). Project identity and resources come only
 * through the injected Project module port. Its fixture adapter is injected by
 * deterministic tests; this route never constructs one or falls back to it.
 */
const props = defineProps<{ service?: ProjectManagementService }>();
const injected = inject<ProjectManagementService | undefined>(PROJECT_SERVICE, undefined);
const service = computed(() => props.service ?? injected);
const hasAuthority = computed(() => service.value !== undefined);
const route = useRoute();
const router = useRouter();
const announcer = useAnnouncer();
const presentation = useShellConnection().presentation;

const boundary = createProjectControlBoundary({
  service: () => service.value,
  presentation: () => presentation.value,
});
const controlsDisabled = computed(() => !boundary.canControl());

const projects = ref<ProjectAuthorityView[]>([]);
const creationOptions = ref<{ agents: ProjectOverviewData['agents']; environments: ProjectOverviewData['environments'] }>();
const creationOptionsError = ref('');
const isLoadingCreationOptions = ref(true);
const overview = ref<ProjectOverviewData>();
const selectedProjectId = ref('');
const isLoadingProjects = ref(true);
const isLoadingOverview = ref(false);
const loadError = ref('');
const missingProject = ref(false);
const actionError = ref('');
let loadGeneration = 0;

type DialogKind = 'create' | 'edit' | 'add-member' | 'edit-member' | 'add-environment' | 'edit-workspace' | 'info' | 'archive' | 'restore' | 'end-member' | 'end-access';
const dialog = ref<DialogKind | null>(null);
const editingMemberId = ref('');
const editingEnvironmentId = ref('');
const formError = ref('');
const projectName = ref('');
const projectGoal = ref('');
const projectRules = ref('');
const projectCompletionGuidance = ref('');
const wakePolicy = ref('explicit-only');
const routingIntervalSeconds = ref(30);
const selectedCreateAgentIds = ref<string[]>([]);
const selectedCreateEnvironmentIds = ref<string[]>([]);
const creationWorkspaceKinds = ref<Record<string, 'default' | 'relative'>>({});
const creationWorkspacePaths = ref<Record<string, string>>({});
const selectedAgentId = ref('');
const responsibilities = ref('');
const collaborationInstructions = ref('');
const selectedEnvironmentId = ref('');
const workspaceKind = ref<'default' | 'relative'>('default');
const workspacePath = ref('');
const submitting = ref(false);

const currentProject = computed(() => overview.value?.project);
const currentContent = computed(() => {
  const project = currentProject.value;
  return project?.content.versions.find((version) => version.version === project.content.currentVersion);
});
const memberships = computed<readonly ProjectMembershipView[]>(() => currentContent.value?.memberships ?? []);
const currentAccess = computed(() => overview.value?.access.filter((entry) => entry.status === 'active') ?? []);
const activeAgentMemberships = computed(() => memberships.value.filter((member) =>
  member.memberKind === 'agent' &&
  member.endedAt === undefined &&
  overview.value?.agents.some((agent) => agent.id === member.memberId && agent.status === 'active'),
));
const activeAgents = computed(() => overview.value?.agents.filter((agent) => agent.status === 'active') ?? []);
const activeEnvironments = computed(() => overview.value?.environments.filter((environment) => environment.enrollmentStatus === 'approved') ?? []);
const createableAgents = computed(() => creationOptions.value?.agents.filter((agent) => agent.status === 'active') ?? []);
const createableEnvironments = computed(() => creationOptions.value?.environments.filter((environment) => environment.enrollmentStatus === 'approved') ?? []);
const unassignedAgents = computed(() => activeAgents.value.filter((agent) => !memberships.value.some((member) => member.memberId === agent.id && member.endedAt === undefined)));
const unassignedEnvironments = computed(() => activeEnvironments.value.filter((environment) => !currentAccess.value.some((entry) => entry.environmentInstanceId === environment.id)));
const projectArchived = computed(() => currentProject.value?.status === 'archived');
const displayNameFor = (member: ProjectMembershipView) => member.memberKind === 'human'
  ? 'You'
  : overview.value?.agents.find((agent) => agent.id === member.memberId)?.displayName ?? member.memberId;
const linkedAgentFor = (member: ProjectMembershipView) => overview.value?.agents.find((agent) => agent.id === member.memberId);
const environmentFor = (id: string) => overview.value?.environments.find((environment) => environment.id === id);

const accessPrerequisite = computed(() => currentAccess.value.some((entry) =>
  entry.current !== undefined && environmentFor(entry.environmentInstanceId)?.enrollmentStatus === 'approved'));
const compatiblePrerequisite = computed(() => overview.value?.compatibility.some((result) => result.available === true) ?? false);
const compatibilityUnknown = computed(() => overview.value?.compatibility.some((result) => result.available === undefined) ?? false);
const readiness = computed<'ready' | 'incomplete' | 'warning' | 'archived'>(() => {
  if (projectArchived.value) return 'archived';
  if (activeAgentMemberships.value.length === 0 || !accessPrerequisite.value) return 'incomplete';
  if (!compatiblePrerequisite.value) return 'warning';
  return 'ready';
});
const readinessLabel = computed(() => ({
  ready: 'Task-begin prerequisites met',
  incomplete: 'Resources incomplete',
  warning: 'Compatibility needs attention',
  archived: 'Archived · read-only',
}[readiness.value]));

function projectFromRoute(): string {
  return typeof route.query.project === 'string' ? route.query.project : '';
}

async function loadSelected(id: string, generation = loadGeneration) {
  const currentService = service.value;
  if (!currentService || id === '') {
    overview.value = undefined;
    isLoadingOverview.value = false;
    return;
  }
  isLoadingOverview.value = true;
  loadError.value = '';
  missingProject.value = false;
  try {
    const snapshot = await currentService.loadOverview(id);
    if (generation !== loadGeneration || id !== selectedProjectId.value) return;
    overview.value = snapshot;
  } catch {
    if (generation !== loadGeneration) return;
    overview.value = undefined;
    missingProject.value = !projects.value.some((project) => project.id === id);
    loadError.value = missingProject.value ? '' : 'The Project Overview could not be loaded. Retry to request current authority facts.';
  } finally {
    if (generation === loadGeneration) isLoadingOverview.value = false;
  }
}

async function loadIndex(preferredId = selectedProjectId.value) {
  const currentService = service.value;
  if (!currentService) {
    projects.value = [];
    overview.value = undefined;
    isLoadingProjects.value = false;
    return;
  }
  const generation = ++loadGeneration;
  isLoadingProjects.value = true;
  loadError.value = '';
  missingProject.value = false;
  try {
    const rows = await currentService.listProjects();
    if (generation !== loadGeneration) return;
    projects.value = [...rows];
    const routeId = projectFromRoute();
    const desired = routeId || preferredId;
    if (desired !== '' && !rows.some((project) => project.id === desired)) {
      selectedProjectId.value = desired;
      overview.value = undefined;
      missingProject.value = true;
    } else {
      const selected = desired || rows.find((project) => project.status === 'active')?.id || rows[0]?.id || '';
      selectedProjectId.value = selected;
      if (!routeId && selected !== '') {
        void router.replace({ name: 'project-overview', query: { ...route.query, project: selected } });
      }
      await loadSelected(selected, generation);
    }
  } catch {
    if (generation === loadGeneration) {
      projects.value = [];
      overview.value = undefined;
      loadError.value = 'Project authority is unreachable. No sample Project data is being shown.';
    }
  } finally {
    if (generation === loadGeneration) isLoadingProjects.value = false;
  }
}

onMounted(() => { void loadIndex(); void loadCreationOptions(); });

async function loadCreationOptions() {
  const currentService = service.value;
  if (!currentService) {
    isLoadingCreationOptions.value = false;
    return;
  }
  isLoadingCreationOptions.value = true;
  creationOptionsError.value = '';
  try {
    creationOptions.value = await currentService.loadCreationOptions();
  } catch {
    creationOptions.value = undefined;
    creationOptionsError.value = 'Available Agent and Environment choices could not be loaded. Project creation remains available without selected resources.';
  } finally {
    isLoadingCreationOptions.value = false;
  }
}

watch(() => route.query.project, (value) => {
  const id = typeof value === 'string' ? value : '';
  if (id !== '' && projects.value.length > 0 && (id !== selectedProjectId.value || overview.value?.project.id !== id)) {
    selectedProjectId.value = id;
    void loadSelected(id, loadGeneration);
  }
});

function selectProject(id: string) {
  selectedProjectId.value = id;
  void router.replace({ name: 'project-overview', query: { ...route.query, project: id } });
}

async function refreshSelected() {
  await loadIndex(selectedProjectId.value);
}

function userMessage(error: unknown): string {
  if (error instanceof ProjectControlRefused) return error.message;
  if (error instanceof BrowserRequestError && error.message !== '') return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return 'The Project change was refused; no further action was taken.';
}

async function runControl(action: (service: ProjectManagementService) => Promise<unknown>, success: string): Promise<boolean> {
  submitting.value = true;
  formError.value = '';
  actionError.value = '';
  try {
    await boundary.run(action);
    await refreshSelected();
    announcer.announce(success);
    return true;
  } catch (error) {
    formError.value = userMessage(error);
    actionError.value = userMessage(error);
    announcer.announce(userMessage(error));
    return false;
  } finally {
    submitting.value = false;
  }
}

function openDialog(kind: DialogKind, memberId = '', environmentId = '') {
  formError.value = '';
  actionError.value = '';
  editingMemberId.value = memberId;
  editingEnvironmentId.value = environmentId;
  const project = currentProject.value;
  const content = currentContent.value;
  if (kind === 'create') {
    projectName.value = '';
    projectGoal.value = '';
    projectRules.value = '';
    projectCompletionGuidance.value = '';
    wakePolicy.value = 'explicit-only';
    routingIntervalSeconds.value = 30;
    selectedCreateAgentIds.value = [];
    selectedCreateEnvironmentIds.value = [];
    creationWorkspaceKinds.value = {};
    creationWorkspacePaths.value = {};
  } else if (kind === 'edit' && project && content) {
    projectName.value = project.displayName;
    projectGoal.value = content.goal;
    projectRules.value = content.rules.join('\n');
    projectCompletionGuidance.value = content.completionGuidance;
    wakePolicy.value = content.wakePolicy;
    routingIntervalSeconds.value = content.routingIntervalMs / 1000;
  } else if (kind === 'add-member') {
    selectedAgentId.value = unassignedAgents.value[0]?.id ?? '';
    responsibilities.value = '';
    collaborationInstructions.value = '';
  } else if (kind === 'edit-member') {
    const membership = memberships.value.find((entry) => entry.memberId === memberId);
    responsibilities.value = membership?.responsibilities.join(', ') ?? '';
    collaborationInstructions.value = membership?.collaborationInstructions ?? '';
  } else if (kind === 'add-environment' || kind === 'edit-workspace') {
    selectedEnvironmentId.value = kind === 'edit-workspace' ? environmentId : unassignedEnvironments.value[0]?.id ?? '';
    const selectedAccess = overview.value?.access.find((entry) => entry.environmentInstanceId === environmentId);
    workspaceKind.value = selectedAccess?.current?.kind === 'relative' ? 'relative' : 'default';
    workspacePath.value = selectedAccess?.current?.path ?? '';
  }
  dialog.value = kind;
}

function parseRules(value: string): string[] {
  return value.split('\n').map((entry) => entry.trim()).filter(Boolean);
}

function setCreationWorkspaceKind(environmentId: string, value: string) {
  if (value === 'default' || value === 'relative') {
    creationWorkspaceKinds.value = { ...creationWorkspaceKinds.value, [environmentId]: value };
  }
}

function setCreationWorkspacePath(environmentId: string, value: string) {
  creationWorkspacePaths.value = { ...creationWorkspacePaths.value, [environmentId]: value };
}

function relativeWorkspaceSelection(value: string): WorkspaceSelectionInput | undefined {
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    return undefined;
  }
  return { kind: 'relative', path };
}

async function submitProject() {
  const name = projectName.value.trim();
  if (!name) { formError.value = 'Project display name is required.'; return; }
  const intervalMs = Math.round(routingIntervalSeconds.value * 1000);
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) {
    formError.value = 'Routing interval must be between 1 and 3600 seconds.';
    return;
  }
  if (dialog.value === 'create') {
    const goal = projectGoal.value.trim();
    const rules = parseRules(projectRules.value);
    const environmentAssignments: ProjectEnvironmentCreationInput[] = [];
    for (const environmentInstanceId of selectedCreateEnvironmentIds.value) {
      const kind = creationWorkspaceKinds.value[environmentInstanceId] ?? 'default';
      const workspace = kind === 'default'
        ? { kind: 'default' as const }
        : relativeWorkspaceSelection(creationWorkspacePaths.value[environmentInstanceId] ?? '');
      if (workspace === undefined) {
        formError.value = `Enter a normalized workspace location relative to the Worker root for ${environmentFor(environmentInstanceId)?.displayName ?? 'the selected Environment'}.`;
        return;
      }
      environmentAssignments.push({ environmentInstanceId, workspace });
    }
    submitting.value = true;
    formError.value = '';
    try {
      const created = await boundary.run((authority) => authority.createProject({
        displayName: name,
        // Goal and rules are always submitted explicitly, blank included:
        // an omitted field would let authority restore the template's goal
        // guidance and suggested rules, so the operator could not create a
        // Project with these fields cleared (F4).
        goal,
        rules,
        wakePolicy: wakePolicy.value,
        routingIntervalMs: intervalMs,
        agentMemberships: selectedCreateAgentIds.value.map((agentId) => ({ agentId })),
        environmentAssignments,
      }));
      dialog.value = null;
      selectedProjectId.value = created.id;
      await router.replace({ name: 'project-overview', query: { ...route.query, project: created.id } });
      await loadIndex(created.id);
      announcer.announce('Project created. Add Agents and Environment workspaces when ready.');
    } catch (error) {
      formError.value = userMessage(error);
      announcer.announce(formError.value);
    } finally {
      submitting.value = false;
    }
    return;
  }
  const saved = await runControl((authority) => authority.updateProjectContent(currentProject.value!.id, {
    displayName: name,
    goal: projectGoal.value.trim() || null,
    completionGuidance: projectCompletionGuidance.value.trim(),
    rules: parseRules(projectRules.value),
    wakePolicy: wakePolicy.value,
    routingIntervalMs: intervalMs,
  }), 'Project identity and contract updated as a new version.');
  if (saved) dialog.value = null;
}

async function submitMembership() {
  const project = currentProject.value;
  if (!project) return;
  const duties = responsibilities.value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const input = { responsibilities: duties, collaborationInstructions: collaborationInstructions.value.trim() };
  const saved = dialog.value === 'edit-member'
    ? await runControl((authority) => authority.updateProjectMembership(project.id, editingMemberId.value, input), 'Project membership updated.')
    : await runControl((authority) => authority.addProjectMembership(project.id, { agentId: selectedAgentId.value, ...input }), 'Agent added to this Project.');
  if (saved) dialog.value = null;
}

function selectedWorkspace(): WorkspaceSelectionInput | undefined {
  if (workspaceKind.value === 'default') return { kind: 'default' };
  const selection = relativeWorkspaceSelection(workspacePath.value);
  if (selection === undefined) {
    formError.value = 'Enter a normalized path relative to the Worker workspace root, or choose the default workspace.';
    return undefined;
  }
  return selection;
}

async function submitWorkspace() {
  const project = currentProject.value;
  const selection = selectedWorkspace();
  if (!project || !selection || !selectedEnvironmentId.value) return;
  const saved = dialog.value === 'edit-workspace'
    ? await runControl((authority) => authority.changeProjectWorkspace(project.id, selectedEnvironmentId.value, selection), 'Project workspace changed; the previous workspace remains preserved.')
    : await runControl((authority) => authority.grantProjectAccess(project.id, selectedEnvironmentId.value, selection), 'Environment access and Project workspace assigned.');
  if (saved) dialog.value = null;
}

async function confirmDialogAction() {
  const project = currentProject.value;
  if (!project) return;
  let done = false;
  if (dialog.value === 'archive') done = await runControl((authority) => authority.archiveProject(project.id), 'Project archived. History and host-local workspaces are preserved.');
  else if (dialog.value === 'restore') done = await runControl((authority) => authority.restoreProject(project.id), 'Project restored after the authority safety check.');
  else if (dialog.value === 'end-member') done = await runControl((authority) => authority.endProjectMembership(project.id, editingMemberId.value), 'Project membership ended; historical attribution is preserved.');
  else if (dialog.value === 'end-access') done = await runControl((authority) => authority.endProjectAccess(project.id, editingEnvironmentId.value), 'Environment access ended; workspace files and binding history are preserved.');
  if (done) dialog.value = null;
}

const closeDialog = () => { if (!submitting.value) dialog.value = null; };
</script>

<template>
  <main class="projects-overview-view flex h-full min-h-0 flex-col bg-[var(--bg-app)]">
    <header class="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-3 sm:px-5">
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[var(--accent-bg)] text-[var(--accent-primary)]"><Icon name="folder" :size="18" /></span>
        <div class="min-w-0 flex-1">
          <label for="project-selector" class="sr-only">Select Project</label>
          <select id="project-selector" class="project-dropdown-select max-w-full truncate rounded bg-transparent py-1 text-sm font-bold text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :value="selectedProjectId" :disabled="isLoadingProjects || projects.length === 0" @change="selectProject(($event.target as HTMLSelectElement).value)">
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.displayName }}{{ project.status === 'archived' ? ' (Archived)' : '' }}</option>
          </select>
          <span class="block truncate text-[10px] text-[var(--text-muted)]">{{ currentProject?.id ?? 'Project authority' }}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="icon" class="project-info-btn min-h-[44px] min-w-[44px]" title="Project Information & Metadata" aria-label="Project Information & Metadata" :disabled="!currentProject" @click="openDialog('info')"><Icon name="info" :size="16" /></Button>
        <Button variant="secondary" size="icon" class="new-project-btn min-h-[44px] min-w-[44px]" title="Create New Project" aria-label="Create New Project" :disabled="controlsDisabled" @click="openDialog('create')"><Icon name="plus" :size="16" /></Button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6">
      <div v-if="actionError" class="mb-4 rounded border border-[var(--yellow-attention)] bg-[var(--bg-surface)] p-3 text-xs text-[var(--text-primary)]" role="alert">{{ actionError }}</div>
      <section v-if="!hasAuthority" class="mx-auto max-w-3xl" data-state="unavailable">
        <EmptyState icon="alert" title="Project Authority Unavailable" description="This page needs the production Project, Agent, Environment, workspace, and wake-policy ports. No fixture data is used here." />
      </section>
      <section v-else-if="isLoadingProjects" class="mx-auto max-w-5xl" aria-busy="true" data-state="loading">
        <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-sm text-[var(--text-secondary)]">Loading Project authority…</div>
      </section>
      <section v-else-if="loadError && !currentProject" class="mx-auto max-w-3xl" data-state="failure">
        <EmptyState icon="alert" title="Project authority unavailable" :description="loadError"><Button variant="secondary" size="md" @click="loadIndex()">Retry</Button></EmptyState>
      </section>
      <section v-else-if="projects.length === 0" class="mx-auto max-w-3xl" data-state="empty">
        <EmptyState icon="folder" title="No Projects yet" description="Create a Project to establish a durable collaboration boundary. Agents and Environments can be assigned now or later.">
          <Button variant="primary" size="md" class="min-h-[44px]" :disabled="controlsDisabled" @click="openDialog('create')"><Icon name="plus" :size="14" />Create Project</Button>
        </EmptyState>
      </section>
      <section v-else-if="missingProject" class="mx-auto max-w-3xl" data-state="not-found">
        <EmptyState icon="alert" title="Project not found" description="The selected Project is not in current authority. Choose a Project from the selector; no other Project is substituted."><Button variant="secondary" size="md" @click="selectProject(projects[0]!.id)">Select first Project</Button></EmptyState>
      </section>
      <section v-else-if="isLoadingOverview" class="mx-auto max-w-5xl" aria-busy="true" data-state="loading">
        <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-sm text-[var(--text-secondary)]">Loading {{ selectedProjectId }}…</div>
      </section>
      <section v-else-if="loadError" class="mx-auto max-w-3xl" data-state="failure">
        <EmptyState icon="alert" title="Project details unavailable" :description="loadError"><Button variant="secondary" size="md" @click="loadSelected(selectedProjectId)">Retry</Button></EmptyState>
      </section>
      <section v-else-if="currentProject && currentContent" class="mx-auto w-full max-w-[1440px]" :data-state="readiness">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="break-words text-xl font-bold text-[var(--text-primary)] sm:text-2xl">{{ currentProject.displayName }}</h1>
            <p class="mt-1 text-xs text-[var(--text-secondary)]">Project Overview · content v{{ currentProject.content.currentVersion }}</p>
          </div>
          <Badge :variant="readiness === 'ready' ? 'success' : readiness === 'warning' ? 'warning' : readiness === 'archived' ? 'secondary' : 'danger'" class="min-h-[30px] px-2">{{ readinessLabel }}</Badge>
        </div>

        <div v-if="readiness !== 'ready'" class="mb-4 flex items-start gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs text-[var(--text-secondary)]" :data-prerequisite-state="readiness">
          <Icon :name="readiness === 'incomplete' ? 'alert' : 'info'" :size="15" class="mt-0.5 shrink-0 text-[var(--yellow-attention)]" />
          <div>
            <strong class="text-[var(--text-primary)]">{{ readiness === 'archived' ? 'Archived Projects are read-only.' : readiness === 'incomplete' ? 'This Project is complete, but missing Task-begin prerequisites.' : 'The core resources are present, but compatibility is not confirmed.' }}</strong>
            <ul v-if="readiness !== 'archived'" class="mt-1 list-inside list-disc">
              <li v-if="activeAgentMemberships.length === 0">Add or restore an active Agent and ensure it has an active Project membership.</li>
              <li v-if="!accessPrerequisite">Grant Environment access and assign a Project workspace.</li>
              <li v-if="activeAgentMemberships.length > 0 && accessPrerequisite && !compatiblePrerequisite">A current compatible Agent work option must be available on an assigned Environment<span v-if="compatibilityUnknown">; some compatibility facts are still unknown.</span>.</li>
            </ul>
            <p v-else class="mt-1">Restore this Project to change content or resources. History and host-local workspaces remain preserved.</p>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <!-- Original prototype order: Contract first and full-width. -->
          <article class="project-contract-card rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs xl:col-span-2">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
              <div class="flex items-center gap-2"><Icon name="overview" :size="16" class="text-[var(--accent-primary)]" /><h2 class="text-sm font-bold text-[var(--text-primary)]">Project Contract &amp; Purpose</h2></div>
              <div class="flex items-center gap-2">
                <Badge :variant="projectArchived ? 'secondary' : 'success'">{{ projectArchived ? 'Archived' : 'Active' }}</Badge>
                <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="projectArchived || controlsDisabled" @click="openDialog('edit')"><Icon name="edit" :size="14" />Edit Project</Button>
              </div>
            </div>
            <div class="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
              <div class="md:col-span-2">
                <h3 class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Project Goal</h3>
                <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-primary)]">{{ currentContent.goal || 'No explicit goal defined.' }}</p>
              </div>
              <div>
                <h3 class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Project Rules ({{ currentContent.rules.length }})</h3>
                <ul v-if="currentContent.rules.length" class="mt-1 list-inside list-disc space-y-1 text-xs text-[var(--text-secondary)]"><li v-for="(rule, index) in currentContent.rules" :key="`${index}-${rule}`" class="break-words">{{ rule }}</li></ul>
                <p v-else class="mt-1 text-xs text-[var(--text-muted)]">No additional rules.</p>
              </div>
              <div>
                <h3 class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Completion &amp; Validation Guidance</h3>
                <p class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--text-secondary)]">{{ currentContent.completionGuidance || 'No additional completion guidance.' }}</p>
              </div>
              <div class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3 md:col-span-2">
                <div class="min-w-0">
                  <h3 class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Wake Routing Policy</h3>
                  <p class="mt-1 text-xs text-[var(--text-primary)]">{{ currentContent.wakePolicy === 'wake-model-assisted' ? `Wake-model-assisted · ${Math.round(currentContent.routingIntervalMs / 1000)}s bounded window` : 'Explicit-only · no model evaluation for unaddressed messages' }}</p>
                  <p class="mt-1 text-[10px] text-[var(--text-muted)]">Policy changes affect future incoming messages only.</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button v-if="!projectArchived" variant="secondary" size="sm" class="min-h-[44px]" :disabled="controlsDisabled" @click="openDialog('edit')">Change wake policy</Button>
                  <Button v-if="!projectArchived" variant="danger" size="sm" class="min-h-[44px]" :disabled="controlsDisabled" @click="openDialog('archive')"><Icon name="archive" :size="14" />Archive Project</Button>
                  <Button v-else variant="primary" size="sm" class="min-h-[44px]" :disabled="controlsDisabled" @click="openDialog('restore')"><Icon name="refresh" :size="14" />Restore Project</Button>
                </div>
              </div>
            </div>
          </article>

          <!-- Memberships follow Contract in the prototype's overview order. -->
          <article class="project-memberships-card rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs">
            <div class="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
              <div><h2 class="text-sm font-bold text-[var(--text-primary)]">Project Memberships</h2><p class="mt-0.5 text-[10px] text-[var(--text-secondary)]">{{ activeAgentMemberships.length }} active Agent(s) · Human membership is retained</p></div>
              <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="projectArchived || controlsDisabled" @click="openDialog('add-member')"><Icon name="plus" :size="14" /><span class="hidden sm:inline">Add Agent</span><span class="sm:hidden">Add</span></Button>
            </div>
            <div v-if="memberships.length" class="divide-y divide-[var(--border-subtle)]">
              <div v-for="member in memberships" :key="`${member.memberId}-${member.startedAt}`" class="flex min-w-0 items-start gap-3 px-4 py-3" :class="member.endedAt !== undefined ? 'opacity-70' : ''">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs font-bold text-[var(--accent-primary)]">{{ member.memberKind === 'human' ? 'H' : displayNameFor(member).slice(0, 1).toUpperCase() }}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5"><strong class="break-words text-xs text-[var(--text-primary)]">{{ displayNameFor(member) }}</strong><Badge variant="secondary">{{ member.memberKind === 'human' ? 'Human' : 'Agent' }}</Badge><Badge :variant="member.endedAt === undefined ? 'success' : 'secondary'">{{ member.endedAt === undefined ? 'Active membership' : 'Ended membership' }}</Badge><Badge v-if="member.memberKind === 'agent' && linkedAgentFor(member) && linkedAgentFor(member)?.status !== 'active'" variant="warning">Global Agent archived</Badge><Badge v-else-if="member.memberKind === 'agent' && !linkedAgentFor(member)" variant="danger">Agent unavailable</Badge></div>
                  <p class="mt-1 break-words text-[11px] text-[var(--text-secondary)]"><strong>Responsibilities:</strong> {{ member.responsibilities.join(', ') || 'General collaboration' }}</p>
                  <p v-if="member.collaborationInstructions" class="mt-1 whitespace-pre-wrap break-words text-[11px] italic text-[var(--text-muted)]">{{ member.collaborationInstructions }}</p>
                  <p v-if="member.memberKind === 'agent' && member.endedAt === undefined && linkedAgentFor(member)?.status !== 'active'" class="mt-1 text-[10px] text-[var(--yellow-attention)]">Restore this global Agent before it can participate in new Project work.</p>
                  <p v-if="member.endedReason" class="mt-1 text-[10px] text-[var(--text-muted)]">History retained · {{ member.endedReason }}</p>
                </div>
                <div v-if="member.memberKind === 'agent' && !projectArchived" class="flex shrink-0 flex-wrap justify-end gap-1">
                  <template v-if="member.endedAt === undefined">
                    <Button variant="ghost" size="icon" class="min-h-[44px] min-w-[44px]" :aria-label="`Edit ${displayNameFor(member)} membership`" :disabled="controlsDisabled" @click="openDialog('edit-member', member.memberId)"><Icon name="edit" :size="14" /></Button>
                    <Button variant="ghost" size="icon" class="min-h-[44px] min-w-[44px] text-[var(--red-action)]" :aria-label="`End ${displayNameFor(member)} membership`" :disabled="controlsDisabled" @click="openDialog('end-member', member.memberId)"><Icon name="close" :size="14" /></Button>
                  </template>
                  <Button v-else variant="secondary" size="sm" class="min-h-[44px]" :disabled="controlsDisabled" @click="selectedAgentId = member.memberId; responsibilities = member.responsibilities.join(', '); collaborationInstructions = member.collaborationInstructions; void submitMembership()">Restore</Button>
                </div>
              </div>
            </div>
            <p v-else class="p-4 text-xs text-[var(--text-muted)]">No membership facts were returned for this Project.</p>
            <div v-if="memberships.length > 0" class="border-t border-[var(--border-subtle)] px-4 py-2"><details class="text-[11px] text-[var(--text-secondary)]"><summary class="min-h-[36px] cursor-pointer py-2 font-semibold">Membership history details</summary><ul class="space-y-1 pb-2"><li v-for="member in memberships" :key="`history-${member.memberId}-${member.startedAt}`" class="break-words">{{ displayNameFor(member) }} · started {{ new Date(member.startedAt).toLocaleString() }}<span v-if="member.endedAt"> · ended {{ new Date(member.endedAt).toLocaleString() }}</span></li></ul></details></div>
          </article>

          <!-- Environment access and persistent workspaces are one authority. -->
          <article class="project-workspaces-card rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs">
            <div class="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
              <div><h2 class="text-sm font-bold text-[var(--text-primary)]">Bound Workspaces &amp; Host Environments</h2><p class="mt-0.5 text-[10px] text-[var(--text-secondary)]">{{ currentAccess.length }} active Environment access binding(s)</p></div>
              <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="projectArchived || controlsDisabled || unassignedEnvironments.length === 0" @click="openDialog('add-environment')"><Icon name="plus" :size="14" /><span class="hidden sm:inline">Assign Environment</span><span class="sm:hidden">Assign</span></Button>
            </div>
            <div v-if="overview.access.length" class="space-y-2 p-3 sm:p-4">
              <div v-for="entry in overview.access" :key="`${entry.environmentInstanceId}-${entry.startedAt}`" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5"><Icon name="environments" :size="14" class="text-[var(--accent-primary)]" /><strong class="break-words text-xs text-[var(--text-primary)]">{{ environmentFor(entry.environmentInstanceId)?.displayName ?? entry.environmentInstanceId }}</strong><Badge :variant="entry.status === 'active' ? 'success' : 'secondary'">{{ entry.status === 'active' ? environmentFor(entry.environmentInstanceId)?.trafficLightReason ?? 'Active access' : 'Access ended' }}</Badge></div>
                    <p class="mt-1 break-all font-mono text-[11px] text-[var(--text-secondary)]">{{ entry.current ? entry.current.kind === 'relative' ? entry.current.path : 'Worker-managed default workspace' : 'No current workspace binding' }}</p>
                    <p class="mt-1 text-[10px] text-[var(--text-muted)]">{{ environmentFor(entry.environmentInstanceId)?.platform ?? 'Environment status unavailable' }} · Workspace files stay on the Environment host.</p>
                  </div>
                  <div v-if="entry.status === 'active' && !projectArchived" class="flex shrink-0 flex-wrap gap-1">
                    <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="controlsDisabled" @click="openDialog('edit-workspace', '', entry.environmentInstanceId)">Change workspace</Button>
                    <Button variant="ghost" size="icon" class="min-h-[44px] min-w-[44px] text-[var(--red-action)]" :aria-label="`End access to ${environmentFor(entry.environmentInstanceId)?.displayName ?? entry.environmentInstanceId}`" :disabled="controlsDisabled" @click="openDialog('end-access', '', entry.environmentInstanceId)"><Icon name="close" :size="14" /></Button>
                  </div>
                </div>
                <details v-if="entry.history.length > 0" class="mt-2 border-t border-[var(--border-subtle)] pt-1 text-[10px] text-[var(--text-secondary)]">
                  <summary class="min-h-[36px] cursor-pointer py-2 font-semibold">Workspace binding history ({{ entry.history.length }})</summary>
                  <ol class="space-y-1 pb-1"><li v-for="binding in entry.history" :key="binding.bindingId" class="break-all">{{ binding.kind === 'relative' ? binding.path : 'Worker-managed default' }} · bound {{ new Date(binding.boundAt).toLocaleString() }}<span v-if="binding.unboundAt"> · ended {{ new Date(binding.unboundAt).toLocaleString() }}</span></li></ol>
                </details>
              </div>
            </div>
            <p v-else class="p-4 text-xs text-[var(--text-muted)]">No Environment is assigned. A Project may remain complete without one; Task begin requires an Environment with a Project workspace.</p>
            <p v-if="projectArchived" class="border-t border-[var(--border-subtle)] px-4 py-3 text-[11px] text-[var(--text-muted)]">Archived Projects retain Environment access and host-local workspaces; no cleanup or reassignment occurs.</p>
          </article>
        </div>
      </section>
    </div>

    <Dialog v-if="dialog === 'create' || dialog === 'edit'" :open="true" :title="dialog === 'create' ? 'Create New Project' : `Edit Project Contract (${currentProject?.displayName ?? ''})`" description="Projects are portable identity records. Goals and resources may be absent; template defaults remain editable." @update:open="closeDialog">
      <div class="flex flex-col gap-3 text-xs">
        <div v-if="dialog === 'create'" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-2 text-[var(--text-secondary)]">Derived from the immutable <strong>General collaboration</strong> template. Goal and rules are saved exactly as entered; leaving them blank creates the Project without them. Selected Agents and Environment workspaces are submitted together with the Project.</div>
        <label class="flex flex-col gap-1 font-semibold">Project Display Name *<input v-model="projectName" maxlength="120" required class="project-name-input min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]" /></label>
        <label class="flex flex-col gap-1 font-semibold">Project Goal <textarea v-model="projectGoal" rows="3" class="project-goal-input rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-[var(--text-primary)]" /></label>
        <label class="flex flex-col gap-1 font-semibold">Project Rules <span class="font-normal text-[var(--text-muted)]">One rule per line; this may be empty.</span><textarea v-model="projectRules" rows="4" class="project-rules-input rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-[var(--text-primary)]" /></label>
        <label class="flex flex-col gap-1 font-semibold">Wake Routing Policy<select v-model="wakePolicy" class="project-wake-policy min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]"><option value="explicit-only">Explicit-only</option><option value="wake-model-assisted">Wake-model-assisted</option></select></label>
        <label class="flex flex-col gap-1 font-semibold">Routing Interval (seconds)<input v-model.number="routingIntervalSeconds" type="number" min="1" max="3600" step="0.1" class="project-routing-interval-input min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]" /><span class="font-normal text-[var(--text-muted)]">Used as the bounded wake window when wake-model-assisted routing is selected.</span></label>
        <label v-if="dialog === 'edit'" class="flex flex-col gap-1 font-semibold">Completion Guidance<textarea v-model="projectCompletionGuidance" rows="3" class="project-completion-guidance-input rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-[var(--text-primary)]" /></label>
        <fieldset v-if="dialog === 'create'" class="rounded border border-[var(--border-subtle)] p-3">
          <legend class="px-1 font-bold">Project Agents</legend>
          <p v-if="isLoadingCreationOptions" class="py-2 text-[var(--text-muted)]" aria-busy="true">Loading active Agents…</p>
          <p v-else-if="creationOptionsError" class="py-2 text-[var(--text-secondary)]">{{ creationOptionsError }}</p>
          <p v-else-if="createableAgents.length === 0" class="py-2 text-[var(--text-secondary)]">No active Agent is available. You can add one later.</p>
          <label v-for="agent in createableAgents" :key="agent.id" class="flex min-h-[44px] items-center gap-2 py-1 text-[var(--text-primary)]"><input v-model="selectedCreateAgentIds" type="checkbox" :value="agent.id" class="min-h-5 min-w-5" /><span>{{ agent.displayName }}</span></label>
        </fieldset>
        <fieldset v-if="dialog === 'create'" class="rounded border border-[var(--border-subtle)] p-3">
          <legend class="px-1 font-bold">Environment Workspaces</legend>
          <p class="pb-1 text-[var(--text-muted)]">Choose the default workspace or a Worker-root-relative location for each Environment. All bindings are recorded with the Project.</p>
          <p v-if="isLoadingCreationOptions" class="py-2 text-[var(--text-muted)]" aria-busy="true">Loading approved Environments…</p>
          <p v-else-if="createableEnvironments.length === 0" class="py-2 text-[var(--text-secondary)]">No approved Environment is available. You can assign one later.</p>
          <div v-for="environment in createableEnvironments" :key="environment.id" class="py-1">
            <label class="flex min-h-[44px] items-center gap-2 text-[var(--text-primary)]"><input v-model="selectedCreateEnvironmentIds" type="checkbox" :value="environment.id" class="min-h-5 min-w-5" /><span>{{ environment.displayName }} <span class="text-[var(--text-muted)]">{{ environment.platform }}</span></span></label>
            <div v-if="selectedCreateEnvironmentIds.includes(environment.id)" class="ml-7 flex flex-col gap-2 pb-2">
              <label class="flex flex-col gap-1 font-semibold">Workspace for {{ environment.displayName }}<select :aria-label="`Workspace for ${environment.displayName}`" class="project-create-workspace-kind min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]" :value="creationWorkspaceKinds[environment.id] ?? 'default'" @change="setCreationWorkspaceKind(environment.id, ($event.target as HTMLSelectElement).value)"><option value="default">Worker-managed default</option><option value="relative">Existing relative location</option></select></label>
              <label v-if="creationWorkspaceKinds[environment.id] === 'relative'" class="flex flex-col gap-1 font-semibold">Relative Workspace Directory<input :aria-label="`Relative workspace directory for ${environment.displayName}`" class="project-create-workspace-path min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 font-mono text-[var(--text-primary)]" autocomplete="off" placeholder="repos/project" :value="creationWorkspacePaths[environment.id] ?? ''" @input="setCreationWorkspacePath(environment.id, ($event.target as HTMLInputElement).value)" /><span class="font-normal text-[var(--text-muted)]">Relative to the host-configured Worker workspace root. Absolute paths are refused.</span></label>
            </div>
          </div>
        </fieldset>
        <p v-if="formError" role="alert" class="text-[var(--red-action)]">{{ formError }}</p>
      </div>
      <template #footer><Button variant="secondary" size="md" class="cancel-new-project-btn" :disabled="submitting" @click="closeDialog">Cancel</Button><Button variant="primary" size="md" class="min-h-[44px]" :disabled="submitting || (dialog === 'create' && isLoadingCreationOptions) || !projectName.trim() || controlsDisabled" @click="submitProject">{{ dialog === 'create' ? 'Create Project' : 'Save Project' }}</Button></template>
    </Dialog>

    <Dialog v-if="dialog === 'add-member' || dialog === 'edit-member'" :open="true" :title="dialog === 'add-member' ? 'Add Global Agent to Project' : 'Edit Project Membership'" description="Membership-specific responsibilities and collaboration instructions are versioned Project content." @update:open="closeDialog">
      <div class="flex flex-col gap-3 text-xs">
        <label v-if="dialog === 'add-member'" class="flex flex-col gap-1 font-semibold">Active Global Agent<select v-model="selectedAgentId" class="min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]"><option v-for="agent in unassignedAgents" :key="agent.id" :value="agent.id">{{ agent.displayName }} · {{ agent.trafficLightReason }}</option></select></label>
        <p v-if="dialog === 'add-member' && unassignedAgents.length === 0" class="text-[var(--text-secondary)]">Every active Agent is already a member, or no active Agent exists. Create or restore an Agent in Manage → Agents first.</p>
        <label class="flex flex-col gap-1 font-semibold">Responsibilities <span class="font-normal text-[var(--text-muted)]">Separate entries with commas.</span><input v-model="responsibilities" class="min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]" /></label>
        <label class="flex flex-col gap-1 font-semibold">Collaboration Instructions<textarea v-model="collaborationInstructions" rows="3" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-[var(--text-primary)]" /></label>
        <p v-if="formError" role="alert" class="text-[var(--red-action)]">{{ formError }}</p>
      </div>
      <template #footer><Button variant="secondary" size="md" :disabled="submitting" @click="closeDialog">Cancel</Button><Button variant="primary" size="md" class="min-h-[44px]" :disabled="submitting || controlsDisabled || (dialog === 'add-member' && !selectedAgentId)" @click="submitMembership">{{ dialog === 'add-member' ? 'Add Agent Member' : 'Save Membership' }}</Button></template>
    </Dialog>

    <Dialog v-if="dialog === 'add-environment' || dialog === 'edit-workspace'" :open="true" :title="dialog === 'add-environment' ? 'Assign Environment & Prepare Workspace' : 'Change Project Workspace'" description="Only a Worker-root-relative location or its managed default crosses this authority boundary; workspace files are never moved or deleted." @update:open="closeDialog">
      <div class="flex flex-col gap-3 text-xs">
        <label v-if="dialog === 'add-environment'" class="flex flex-col gap-1 font-semibold">Enrolled Environment<select v-model="selectedEnvironmentId" class="min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]"><option v-for="environment in unassignedEnvironments" :key="environment.id" :value="environment.id">{{ environment.displayName }} · {{ environment.platform }} · {{ environment.trafficLightReason }}</option></select></label>
        <p v-if="dialog === 'add-environment' && unassignedEnvironments.length === 0" class="text-[var(--text-secondary)]">No other approved Environment is available to assign.</p>
        <label class="flex flex-col gap-1 font-semibold">Workspace Selection<select v-model="workspaceKind" class="min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 text-[var(--text-primary)]"><option value="default">Worker-managed default workspace</option><option value="relative">Existing relative location</option></select></label>
        <label v-if="workspaceKind === 'relative'" class="flex flex-col gap-1 font-semibold">Relative Workspace Directory<input v-model="workspacePath" autocomplete="off" placeholder="repos/project" class="min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 font-mono text-[var(--text-primary)]" /><span class="font-normal text-[var(--text-muted)]">Relative to the host-configured Worker workspace root. Absolute paths are not accepted.</span></label>
        <p v-if="formError" role="alert" class="text-[var(--red-action)]">{{ formError }}</p>
      </div>
      <template #footer><Button variant="secondary" size="md" :disabled="submitting" @click="closeDialog">Cancel</Button><Button variant="primary" size="md" class="min-h-[44px]" :disabled="submitting || controlsDisabled || !selectedEnvironmentId || (dialog === 'add-environment' && unassignedEnvironments.length === 0)" @click="submitWorkspace">{{ dialog === 'add-environment' ? 'Grant Access & Prepare' : 'Change Workspace' }}</Button></template>
    </Dialog>

    <Dialog v-if="dialog === 'info' && currentProject" :open="true" title="Project Information & Metadata" description="Portable Project identity and retained template/content history." @update:open="closeDialog">
      <dl class="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-2 break-words text-xs"><dt class="text-[var(--text-muted)]">Stable Project ID</dt><dd class="font-mono text-[var(--text-primary)]">{{ currentProject.id }}</dd><dt class="text-[var(--text-muted)]">Template</dt><dd class="text-[var(--text-primary)]">{{ currentProject.template.templateName }} v{{ currentProject.template.templateVersion }}</dd><dt class="text-[var(--text-muted)]">Created</dt><dd class="text-[var(--text-primary)]">{{ new Date(currentProject.createdAt).toLocaleString() }}</dd><dt class="text-[var(--text-muted)]">Updated</dt><dd class="text-[var(--text-primary)]">{{ new Date(currentProject.updatedAt).toLocaleString() }}</dd><dt class="text-[var(--text-muted)]">Content versions</dt><dd class="text-[var(--text-primary)]">{{ currentProject.content.versions.length }} retained · current v{{ currentProject.content.currentVersion }}</dd><dt v-if="currentProject.archivedAt" class="text-[var(--text-muted)]">Archived</dt><dd v-if="currentProject.archivedAt" class="text-[var(--text-primary)]">{{ new Date(currentProject.archivedAt).toLocaleString() }} · {{ currentProject.archivedReason }}</dd><dt v-if="currentProject.restoredAt" class="text-[var(--text-muted)]">Restored</dt><dd v-if="currentProject.restoredAt" class="text-[var(--text-primary)]">{{ new Date(currentProject.restoredAt).toLocaleString() }}</dd></dl>
      <details class="mt-4 text-xs text-[var(--text-secondary)]"><summary class="min-h-[40px] cursor-pointer py-2 font-semibold">Content change history</summary><ol class="space-y-2 pb-2"><li v-for="version in currentProject.content.versions" :key="version.version" class="rounded border border-[var(--border-subtle)] p-2">v{{ version.version }} · {{ new Date(version.at).toLocaleString() }}<p class="mt-1 break-words">{{ version.reason }}</p></li></ol></details>
      <template #footer><Button variant="secondary" size="md" class="close-project-info-btn" @click="closeDialog">Close</Button></template>
    </Dialog>

    <Dialog v-if="dialog === 'archive' || dialog === 'restore' || dialog === 'end-member' || dialog === 'end-access'" :open="true" :title="dialog === 'archive' ? 'Archive Project Safely' : dialog === 'restore' ? 'Restore Project' : dialog === 'end-member' ? 'End Project Membership' : 'End Environment Access'" :description="dialog === 'archive' ? 'The authority refuses archival while active work, unfinished Tasks, or held/recovering leases still depend on this Project.' : 'This is a non-destructive change. Historical facts and host-local workspaces remain preserved.'" @update:open="closeDialog">
      <div class="space-y-3 text-xs text-[var(--text-secondary)]"><p v-if="dialog === 'archive'">Archiving makes this Project read-only. It does not delete Project history, memberships, Environment access, or any host-local Project workspace.</p><p v-else-if="dialog === 'restore'">Restore rechecks the authority's current safety conditions. Existing memberships and workspace bindings are not recreated or moved.</p><p v-else-if="dialog === 'end-member'">End this Agent's membership non-destructively. Past Messages, runs, and attribution remain. Any active work dependency can refuse the change.</p><p v-else>End access to this Environment. Project workspace files stay on the host and all old workspace bindings remain in history. Active work can refuse the change.</p><p v-if="formError" role="alert" class="text-[var(--red-action)]">{{ formError }}</p></div>
      <template #footer><Button variant="secondary" size="md" :disabled="submitting" @click="closeDialog">Cancel</Button><Button :variant="dialog === 'archive' || dialog === 'end-member' || dialog === 'end-access' ? 'danger' : 'primary'" size="md" class="min-h-[44px]" :disabled="submitting || controlsDisabled" @click="confirmDialogAction">{{ dialog === 'archive' ? 'Archive Project' : dialog === 'restore' ? 'Restore Project' : dialog === 'end-member' ? 'End Membership' : 'End Access' }}</Button></template>
    </Dialog>
  </main>
</template>
