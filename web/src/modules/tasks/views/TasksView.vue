<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { TaskActor, TaskBlockerResponsibility, TaskContent, TaskControlEvent } from '../../../../../src/task/model.ts';
import type { TaskProposal, TaskProposalContent, TaskContentVersion } from '../../../../../src/task/proposal-model.ts';
import type { TaskView, TaskWithRunsView, TaskRunLinkView } from '../../../../../src/web/views.ts';
import { useAnnouncer } from '../../../primitives/announcer.ts';
import { useShellConnection } from '../../../shell/use-shell-connection.ts';
import Badge from '../../../primitives/Badge.vue';
import Button from '../../../primitives/Button.vue';
import ChatDialog from '../../chat/views/ChatDialog.vue';
import TaskRunAudit from '../components/TaskRunAudit.vue';
import EmptyState from '../../../primitives/EmptyState.vue';
import Icon from '../../../primitives/Icon.vue';
import type { ProjectManagementService, ProjectOverviewData } from '../../projects/types.ts';
import { PROJECT_SERVICE } from '../../projects/types.ts';
import type { TaskBrowserAdapter } from '../../../adapters/task-api.ts';
import { TASKS_API } from '../types.ts';

const props = defineProps<{
  api?: TaskBrowserAdapter;
  projectService?: ProjectManagementService;
}>();
const route = useRoute();
const router = useRouter();
const announcer = useAnnouncer();
const presentation = useShellConnection().presentation;
const injectApi = inject(TASKS_API, undefined);
const injectProjectService = inject(PROJECT_SERVICE, undefined);
const api = computed(() => props.api ?? injectApi);
const projectService = computed(() => props.projectService ?? injectProjectService);

const projects = ref<Awaited<ReturnType<ProjectManagementService['listProjects']>>>([]);
const selectedProjectId = ref('');
const overview = ref<ProjectOverviewData>();
const proposals = ref<readonly TaskProposal[]>([]);
const tasks = ref<readonly TaskView[]>([]);
const selectedTask = ref<TaskWithRunsView>();
const selectedProposal = ref<TaskProposal>();
const selectedProposalVersion = ref<TaskContentVersion>();
const loading = ref(true);
const detailLoading = ref(false);
const submitting = ref(false);
const pageError = ref('');
const detailError = ref('');
const actionError = ref<{ readonly code?: string; readonly message: string }>();
const filter = ref<'all' | 'proposed' | 'active' | 'validation' | 'blocked' | 'recovery' | 'completed'>('all');
const lifecycleExpanded = ref(true);
const detailHeading = ref<HTMLElement>();
const proposalFormOpen = ref(false);
const proposalTrigger = ref<HTMLButtonElement>();
const proposalEditOpen = ref(false);
const beginOpen = ref(false);
const taskEditOpen = ref(false);
const blockerOpen = ref(false);
const proposalTitle = ref('');
const proposalGoal = ref('');
const proposalConstraints = ref('');
const proposalCriteria = ref('');
const proposalReason = ref('');
const beginEnvironmentId = ref('');
const beginLeadKey = ref('');
const controlReason = ref('');
const advanceTargetId = ref('');
const stopRunId = ref('');
const stopActiveRunId = ref('');
const taskTitle = ref('');
const taskGoal = ref('');
const taskConstraints = ref('');
const taskCriteria = ref('');
const taskLeadKey = ref('');
const taskRevisionReason = ref('');
const blockerReason = ref('');
const blockerAction = ref('');
const blockerResponsibleKind = ref<TaskBlockerResponsibility['kind']>('external-condition');
const blockerResponsibleMemberKey = ref('');
const blockerResponsibleValue = ref('');
const completionOutcome = ref('');
const completionEvidence = ref('');
const completionChanges = ref('');
const completionLimitations = ref('');
const completionDisposition = ref<'complete' | 'continue'>('complete');
let loadGeneration = 0;
let detailGeneration = 0;
let focusSelectedRecord = false;

const selectedProject = computed(() => projects.value.find((project) => project.id === selectedProjectId.value));
const projectArchived = computed(() => selectedProject.value?.status === 'archived');
const openTaskId = computed(() => typeof route.params['taskId'] === 'string' ? route.params['taskId'] : '');
const openProposalId = computed(() => typeof route.params['proposalId'] === 'string' ? route.params['proposalId'] : '');
const hasDetail = computed(() => openTaskId.value !== '' || openProposalId.value !== '');
const canControl = computed(() => Boolean(api.value && projectService.value && presentation.value.controlAvailable && !submitting.value));
const currentProjectMembers = computed(() => {
  const project = overview.value?.project;
  const version = project?.content.versions.find((entry) => entry.version === project.content.currentVersion);
  return version?.memberships.filter((member) => member.endedAt === undefined) ?? [];
});
const currentHuman = computed(() => currentProjectMembers.value.find((member) => member.memberKind === 'human'));
const activeProjectAgents = computed(() => {
  const activeIds = new Set(overview.value?.agents.filter((agent) => agent.status === 'active').map((agent) => agent.id) ?? []);
  return currentProjectMembers.value.filter((member) => member.memberKind === 'agent' && activeIds.has(member.memberId));
});
const filteredEntries = computed(() => {
  const proposalEntries = proposals.value
    .filter((proposal) => proposal.status !== 'begun')
    .map((proposal) => ({ kind: 'proposal' as const, proposal }));
  const taskEntries = tasks.value.map((task) => ({ kind: 'task' as const, task }));
  const entries = [...proposalEntries, ...taskEntries];
  return entries.filter((entry) => {
    if (filter.value === 'all') return true;
    const stage = entry.kind === 'proposal' ? proposalStage(entry.proposal) : taskStage(entry.task);
    if (filter.value === 'proposed') return stage === 'Proposed' || stage === 'Rejected' || stage === 'Withdrawn';
    if (filter.value === 'active') return stage.startsWith('Active') || stage === 'Task pause requested' || stage === 'Paused';
    if (filter.value === 'validation') return stage === 'Awaiting validation';
    if (filter.value === 'blocked') return stage === 'Blocked';
    if (filter.value === 'recovery') return stage === 'Recovery';
    return stage === 'Completed' || stage === 'Cancelled' || stage === 'Rejected' || stage === 'Withdrawn';
  });
});
const environmentOptions = computed(() => {
  const snapshot = overview.value;
  if (!snapshot) return [];
  const activeIds = new Set(activeProjectAgents.value.map((member) => member.memberId));
  return snapshot.access
    .filter((entry) => entry.status === 'active' && entry.current !== undefined)
    .map((entry) => {
      const environment = snapshot.environments.find((row) => row.environmentInstanceId === entry.environmentInstanceId || row.id === entry.environmentInstanceId);
      const compatibility = snapshot.compatibility.filter((row) => row.environmentInstanceId === entry.environmentInstanceId && activeIds.has(row.agentId));
      const compatibleAgentIds = compatibility.filter((row) => row.available === true).map((row) => row.agentId);
      // The overall traffic light includes unrelated engines and stale probes.
      // Use independent safety/connectivity facts and per-Agent compatibility;
      // begin admission still owns the authoritative eligibility and lease gates.
      const unavailableReason = !environment
        ? 'Environment facts are unavailable'
        : environment.enrollmentStatus !== 'approved'
          ? 'Environment is not approved'
          : environment.workSafety !== 'clear'
            ? 'Environment is held for existing work or recovery'
            : environment.connectionState !== 'online'
              ? 'Environment Worker is not online'
              : environment.protocolCompatibility !== 'compatible'
                ? 'Worker protocol compatibility is not confirmed'
                : environment.capabilityPermissions['agent-run'] !== true
                  ? 'Agent run capability is not granted'
                  : environment.trafficLight === 'red'
                    ? environment.trafficLightReason || 'Environment readiness is blocked'
                    : compatibleAgentIds.length === 0
                      ? compatibility.length === 0 || compatibility.some((row) => row.available === undefined)
                        ? 'Agent compatibility has not been confirmed. Refresh Project resources.'
                        : compatibility.find((row) => row.unavailableReason)?.unavailableReason || 'No compatible Project Agent is currently available'
                      : '';
      return {
        id: entry.environmentInstanceId,
        name: environment?.displayName ?? 'Environment',
        enabled: unavailableReason === '',
        unavailableReason,
        compatibleAgentIds,
      };
    });
});
const beginLeadOptions = computed(() => {
  const environment = environmentOptions.value.find((entry) => entry.id === beginEnvironmentId.value);
  const agents = activeProjectAgents.value.filter((member) => environment?.compatibleAgentIds.includes(member.memberId));
  return [
    ...(currentHuman.value ? [{ key: actorKey({ memberId: currentHuman.value.memberId, memberKind: 'human' }), label: 'You · Human Task lead' }] : []),
    ...agents.map((member) => ({ key: actorKey({ memberId: member.memberId, memberKind: 'agent' }), label: agentName(member.memberId) })),
  ];
});
const beginSelectionReady = computed(() => environmentOptions.value.some((entry) => entry.id === beginEnvironmentId.value && entry.enabled)
  && beginLeadOptions.value.some((entry) => entry.key === beginLeadKey.value));
const filters = ['all', 'proposed', 'active', 'validation', 'blocked', 'recovery', 'completed'] as const;
const taskLeadOptions = computed(() => [
  ...(currentHuman.value ? [{ key: actorKey({ memberId: currentHuman.value.memberId, memberKind: 'human' }), label: 'You · Human Task lead' }] : []),
  ...activeProjectAgents.value.map((member) => ({ key: actorKey({ memberId: member.memberId, memberKind: 'agent' }), label: agentName(member.memberId) })),
]);
const advanceAgents = computed(() => {
  const task = selectedTask.value?.task;
  if (!task?.environmentInstanceId) return [];
  const eligible = new Set(overview.value?.compatibility
    .filter((row) => row.environmentInstanceId === task.environmentInstanceId && row.available === true)
    .map((row) => row.agentId) ?? []);
  return activeProjectAgents.value.filter((member) => eligible.has(member.memberId));
});
const blockerResponsibleMembers = computed(() => blockerResponsibleKind.value === 'human'
  ? currentProjectMembers.value.filter((member) => member.memberKind === 'human')
  : blockerResponsibleKind.value === 'agent' ? activeProjectAgents.value : []);
const blockerResponsibilityReady = computed(() => {
  if (blockerResponsibleKind.value === 'human' || blockerResponsibleKind.value === 'agent') {
    const actor = actorFromKey(blockerResponsibleMemberKey.value);
    return Boolean(actor && actor.memberKind === blockerResponsibleKind.value);
  }
  return blockerResponsibleValue.value.trim().length > 0;
});
const selectedTaskEnvironmentId = computed(() => {
  const instanceId = selectedTask.value?.task.environmentInstanceId;
  return instanceId === undefined
    ? undefined
    : overview.value?.environments.find((environment) => environment.environmentInstanceId === instanceId)?.id;
});
const proposalCurrent = computed(() => selectedProposalVersion.value);
const taskContent = computed<TaskContent | undefined>(() => {
  const task = selectedTask.value?.task;
  if (!task) return undefined;
  const revised = [...(task.controlHistory ?? [])].reverse().find((event) => event.action === 'content-revised');
  if (revised?.action === 'content-revised') return revised.content;
  return {
    title: task.title,
    goal: task.goal,
    constraints: task.constraints,
    validationCriteria: task.admission?.validationCriteria ?? [],
    lead: task.admission?.lead ?? { memberId: task.assignedAgentId ?? '', memberKind: 'agent' },
  };
});
const taskContentVersion = computed(() => {
  const task = selectedTask.value?.task;
  if (!task) return 0;
  const revised = [...(task.controlHistory ?? [])].reverse().find((event) => event.action === 'content-revised');
  return revised?.action === 'content-revised' ? revised.contentVersion : task.admission?.contentVersion ?? 1;
});
const selectedCompletionClaim = computed(() => {
  const task = selectedTask.value?.task;
  if (!task) return undefined;
  return task.completionClaims?.find((claim) => claim.id === task.pendingCompletionClaimId)
    ?? task.completionClaims?.at(-1);
});
const canSubmitCompletionClaim = computed(() => {
  const task = selectedTask.value?.task;
  return Boolean(task && !terminalTask.value && taskContent.value?.lead.memberKind === 'human'
    && task.environmentLifecycleState === 'idle' && task.activeRunId === undefined
    && task.pendingCompletionClaimId === undefined);
});
const actionReasonRequired = computed(() => controlReason.value.trim().length === 0);
const taskCanAdvance = computed(() => {
  const task = selectedTask.value?.task;
  return Boolean(task && task.environmentLifecycleState === 'idle' && task.activeRunId === undefined
    && task.pauseState === undefined && task.blocker === undefined && !task.pendingCompletionClaimId);
});
const terminalTask = computed(() => selectedTask.value ? isTerminal(selectedTask.value.task) : false);
const selectedProposalIsHumanProposed = computed(() => {
  const proposal = selectedProposal.value;
  return Boolean(proposal && currentHuman.value && proposal.proposer.memberKind === 'human' && proposal.proposer.memberId === currentHuman.value.memberId);
});

function canStopSubordinateRun(run: TaskRunLinkView): boolean {
  const task = selectedTask.value?.task;
  const lead = taskContent.value?.lead;
  return Boolean(task && task.environmentLifecycleState === 'running' && lead?.memberKind === 'human'
    && currentHuman.value?.memberId === lead.memberId && run.runId === task.activeRunId
    && run.actor?.memberKind === lead.memberKind && run.actor.memberId === lead.memberId);
}
async function stopSubordinateRun(run: TaskRunLinkView): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  if (!currentApi || !task || stopRunId.value !== run.runId || actionReasonRequired.value) return;
  const stopped = await perform('Task lead stop requested. The Task and its Environment lease remain active.', async () => {
    await currentApi.stopSubordinate(task.id, { runId: run.runId, reason: controlReason.value.trim() });
  });
  if (stopped) stopRunId.value = '';
}
function actorKey(actor: TaskActor): string { return JSON.stringify(actor); }
function actorFromKey(value: string): TaskActor | undefined {
  try {
    const parsed = JSON.parse(value) as TaskActor;
    return parsed && typeof parsed.memberId === 'string' && (parsed.memberKind === 'human' || parsed.memberKind === 'agent') ? parsed : undefined;
  } catch { return undefined; }
}
function agentName(id: string): string {
  return overview.value?.agents.find((agent) => agent.id === id)?.displayName ?? 'Project Agent';
}
function actorName(actor: TaskActor | { readonly memberId: string; readonly memberKind: string } | undefined): string {
  if (!actor) return 'Unknown actor';
  if (actor.memberKind === 'human') return 'You';
  if (actor.memberKind === 'system') return 'Sprout';
  return agentName(actor.memberId);
}
function blockerResponsibleName(responsible: TaskBlockerResponsibility): string {
  if (responsible.kind === 'recovery') return `Recovery mechanism · ${responsible.mechanism}`;
  if (responsible.kind === 'external-condition') return `External condition · ${responsible.condition}`;
  return actorName({ memberId: responsible.memberId, memberKind: responsible.kind });
}
function proposalStage(proposal: TaskProposal): string {
  if (proposal.status === 'proposed') return 'Proposed';
  if (proposal.status === 'rejected') return 'Rejected';
  if (proposal.status === 'withdrawn') return 'Withdrawn';
  return 'Begun';
}
function taskStage(task: TaskView): string {
  if (task.environmentLifecycleState === 'recovery') return 'Recovery';
  if (task.environmentLifecycleState === 'ending') return 'Ending';
  if (task.environmentLifecycleState === 'beginning') return 'Beginning';
  if (task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded') {
    return task.endDisposition === 'completed' || task.status === 'done' ? 'Completed' : 'Cancelled';
  }
  if (task.status === 'done') return 'Completed';
  if (task.status === 'cancelled') return 'Cancelled';
  if (task.pauseState === 'requested') return 'Task pause requested';
  if (task.pauseState === 'paused') return 'Paused';
  if (task.environmentLifecycleState === 'awaiting-validation' || task.pendingCompletionClaimId !== undefined) return 'Awaiting validation';
  if (task.blocker !== undefined || task.status === 'blocked' || task.environmentLifecycleState === 'blocked') return 'Blocked';
  if (task.activeRunId !== undefined) return 'Active · run running';
  if (task.environmentLifecycleState === 'idle' || task.environmentLifecycleState === 'running') return 'Active · run idle';
  if (task.forcedRelease) return 'Cancelled';
  return task.status;
}
function taskRunState(task: TaskView): string {
  if (task.activeRunId !== undefined) return 'running';
  const latest = selectedTask.value?.runs.at(-1);
  return latest?.summary?.status ?? 'none';
}
function leaseState(task: TaskView): string {
  if (task.environmentLifecycleState === 'beginning') return 'acquiring';
  if (task.environmentLifecycleState === 'ending') return 'releasing';
  if (task.environmentLifecycleState === 'recovery') return 'recovering';
  if (task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded' || task.environmentLeaseId === undefined) return 'released';
  return 'held';
}
function lifecycleSentence(task: TaskView): string {
  const stage = taskStage(task);
  const run = task.activeRunId === undefined ? 'No active Agent run' : 'Agent run running';
  const lease = leaseState(task);
  if (stage === 'Proposed') return 'Task proposed · No active Agent run · No Environment lease';
  return `Task ${stage.toLowerCase()} · ${run} · Lease ${lease}`;
}
function isTerminal(task: TaskView): boolean {
  return ['done', 'cancelled', 'failed'].includes(task.status)
    || task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded';
}
function badgeVariant(stage: string): 'success' | 'warning' | 'danger' | 'secondary' | 'purple' {
  if (stage === 'Recovery' || stage === 'Blocked') return 'danger';
  if (stage === 'Proposed' || stage === 'Awaiting validation' || stage === 'Task pause requested' || stage === 'Paused') return 'warning';
  if (stage.startsWith('Active')) return 'success';
  if (stage === 'Completed' || stage === 'Cancelled' || stage === 'Rejected' || stage === 'Withdrawn') return 'secondary';
  return 'purple';
}
function formatTime(at: number | undefined): string {
  if (at === undefined) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}
function actionLabel(event: TaskControlEvent): string {
  const labels: Record<string, string> = {
    'content-revised': 'Task content revised', 'pause-requested': 'Pause requested', paused: 'Task paused',
    'interrupt-requested': 'Interrupt requested', resumed: 'Task resumed', 'subordinate-run-stop-requested': 'Run stop requested',
    'blocker-raised': 'Blocker recorded', 'blocker-cleared': 'Blocker cleared', 'completion-claimed': 'Completion claim submitted',
    'validation-accepted': 'Completion claim accepted', 'validation-corrected': 'Correction requested',
    'end-requested': 'Safe end requested', 'recovery-requested': 'Recovery action requested',
  };
  return labels[event.action] ?? 'Task updated';
}
function splitLines(value: string): string[] { return value.split('\n').map((line) => line.trim()).filter(Boolean); }
function fillProposalForm(content?: TaskProposalContent): void {
  proposalTitle.value = content?.title ?? '';
  proposalGoal.value = content?.goal ?? '';
  proposalConstraints.value = content?.constraints.join('\n') ?? '';
  proposalCriteria.value = content?.validationCriteria.join('\n') ?? '';
  proposalReason.value = '';
}
function openTaskEditor(): void {
  const content = taskContent.value;
  if (!content) return;
  taskTitle.value = content.title;
  taskGoal.value = content.goal;
  taskConstraints.value = content.constraints.join('\n');
  taskCriteria.value = content.validationCriteria.join('\n');
  taskLeadKey.value = actorKey(content.lead);
  taskRevisionReason.value = '';
  taskEditOpen.value = true;
}
function requestFailure(error: unknown): { readonly status?: number; readonly code?: string; readonly message?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (typeof value.status !== 'number' && typeof value.code !== 'string') return undefined;
  return {
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
}
function errorState(error: unknown): { readonly code?: string; readonly message: string } {
  const failure = requestFailure(error);
  if (failure) {
    if (failure.status === 409) {
      if (failure.code === 'advance-conflict') return { code: failure.code, message: 'Another Task action changed this Task before the advance completed. Review the refreshed state before trying again.' };
      if (failure.code === 'environment-recovering') return { code: failure.code, message: 'The Environment is recovering. Task advancement is held until recovery is resolved.' };
      if (failure.code === 'pause-retry-required') return { code: failure.code, message: 'Task advancement is still gated. The Human must retry or cancel the pause request, then refresh the Task before trying again.' };
      if (failure.code === 'lifecycle-conflict') return { code: failure.code, message: 'This Task changed before the action completed. Review its refreshed lifecycle before trying again.' };
      if (failure.code === 'terminal-task') return { code: failure.code, message: failure.message || 'This terminal Task’s blocker is historical.' };
      if (failure.code === 'stale-proposal') return { code: failure.code, message: 'This proposal changed before the decision completed. Review its current version before trying again.' };
      if (failure.code === 'project-read-only') return { code: failure.code, message: 'This Project is read-only. Refresh its current state before trying another Task action.' };
      if (failure.code === 'agent-read-only') return { code: failure.code, message: 'This Agent no longer has writable Project access. Refresh the current membership before retrying this Task action.' };
      if (failure.code === 'proposal-closed') return { code: failure.code, message: 'This proposal is no longer open. Review its refreshed status before trying again.' };
      if (failure.code === 'lead-ineligible') return { code: failure.code, message: 'The selected Task lead is no longer eligible for this Environment. Refresh the Task and choose a current lead.' };
      if (failure.code === 'environment-unavailable') return { code: failure.code, message: 'The Environment could not be reserved. The proposal remains unbegun; refresh Project resources and choose an available Environment.' };
      if (failure.code === 'environment-ineligible') return { code: failure.code, message: 'The selected Environment is no longer available to this Project. Refresh the available Environment facts before beginning.' };
      if (failure.code === 'no-compatible-agent') return { code: failure.code, message: 'No current Project Agent can work in the selected Environment. Review Project resources before beginning.' };
      if (failure.code === 'target-ineligible') return { code: failure.code, message: 'The selected Agent is no longer eligible for this Task Environment. Refresh and choose an eligible Project Agent.' };
      if (failure.code === 'not-awaiting-recovery') return { code: failure.code, message: 'This Task is no longer awaiting recovery. Review its refreshed lifecycle before choosing another action.' };
      if (failure.code === 'lease-cannot-resume') return { code: failure.code, message: 'The Task Environment lease could not be resumed. Keep the Task in recovery and review the current recovery facts.' };
      return { ...(failure.code ? { code: failure.code } : {}), message: 'Sprout refused this Task action. Review the refreshed state before trying again.' };
    }
    return { ...(failure.code ? { code: failure.code } : {}), message: failure.message || 'The Task request could not be completed.' };
  }
  return { message: error instanceof Error && error.message ? error.message : 'The Task action could not be completed.' };
}

async function loadSnapshot(projectId: string, generation: number): Promise<void> {
  const currentApi = api.value;
  const currentProjects = projectService.value;
  if (!currentApi || !currentProjects || projectId === '') return;
  try {
    const [snapshot, proposalRows, taskRows] = await Promise.all([
      currentProjects.loadOverview(projectId),
      currentApi.listProposals(projectId),
      currentApi.listTasks(projectId),
    ]);
    if (generation !== loadGeneration || projectId !== selectedProjectId.value) return;
    overview.value = snapshot;
    proposals.value = proposalRows;
    tasks.value = taskRows;
    pageError.value = '';
    await loadSelectedRecord(projectId);
  } catch (error) {
    if (generation !== loadGeneration) return;
    overview.value = undefined;
    proposals.value = [];
    tasks.value = [];
    pageError.value = errorState(error).message;
  }
}

async function loadSelectedRecord(projectId: string): Promise<void> {
  const currentApi = api.value;
  const generation = ++detailGeneration;
  selectedTask.value = undefined;
  selectedProposal.value = undefined;
  selectedProposalVersion.value = undefined;
  detailError.value = '';
  if (!currentApi || (!openTaskId.value && !openProposalId.value)) {
    detailLoading.value = false;
    return;
  }
  detailLoading.value = true;
  try {
    if (openTaskId.value) {
      const detail = await currentApi.getTask(openTaskId.value);
      if (generation !== detailGeneration) return;
      if (detail.task.projectId !== projectId) throw new Error('This Task belongs to a different Project.');
      selectedTask.value = detail;
    } else {
      const proposal = await currentApi.getProposal(openProposalId.value);
      if (generation !== detailGeneration) return;
      if (proposal.projectId !== projectId) throw new Error('This proposal belongs to a different Project.');
      const contentVersion = await currentApi.getContentVersion(proposal.id, proposal.currentContentVersion);
      if (generation !== detailGeneration) return;
      selectedProposal.value = proposal;
      selectedProposalVersion.value = contentVersion;
    }
  } catch (error) {
    if (generation === detailGeneration) detailError.value = errorState(error).message;
  } finally {
    if (generation === detailGeneration) {
      detailLoading.value = false;
      await nextTick();
      if (focusSelectedRecord && detailHeading.value) {
        detailHeading.value.focus({ preventScroll: true });
        focusSelectedRecord = false;
      }
    }
  }
}

async function selectProject(projectId: string): Promise<void> {
  selectedProjectId.value = projectId;
  await router.replace({ name: 'project-tasks', query: { ...route.query, project: projectId } });
  const generation = ++loadGeneration;
  loading.value = true;
  await loadSnapshot(projectId, generation);
  loading.value = false;
}

async function loadIndex(): Promise<void> {
  const currentApi = api.value;
  const currentProjects = projectService.value;
  if (!currentApi || !currentProjects) {
    pageError.value = 'Task and Project authority are unavailable. No sample Task data is shown.';
    loading.value = false;
    return;
  }
  const generation = ++loadGeneration;
  loading.value = true;
  pageError.value = '';
  try {
    const rows = await currentProjects.listProjects();
    if (generation !== loadGeneration) return;
    projects.value = rows;
    let requested = typeof route.query['project'] === 'string' ? route.query['project'] : '';
    if (!requested && openTaskId.value) requested = (await currentApi.getTask(openTaskId.value)).task.projectId;
    if (!requested && openProposalId.value) requested = (await currentApi.getProposal(openProposalId.value)).projectId;
    const projectId = requested || rows.find((project) => project.status === 'active')?.id || rows[0]?.id || '';
    if (projectId && !rows.some((project) => project.id === projectId)) {
      selectedProjectId.value = projectId;
      pageError.value = 'The selected Project is unavailable. Choose a current Project to continue.';
      return;
    }
    selectedProjectId.value = projectId;
    if (!projectId) {
      overview.value = undefined;
      proposals.value = [];
      tasks.value = [];
      return;
    }
    if (typeof route.query['project'] !== 'string') {
      await router.replace({ name: hasDetail.value ? (openTaskId.value ? 'project-task-detail' : 'project-task-proposal') : 'project-tasks', ...(hasDetail.value ? { params: openTaskId.value ? { taskId: openTaskId.value } : { proposalId: openProposalId.value } } : {}), query: { ...route.query, project: projectId } });
    }
    await loadSnapshot(projectId, generation);
  } catch (error) {
    if (generation === loadGeneration) pageError.value = errorState(error).message;
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

async function refresh(): Promise<void> {
  if (!selectedProjectId.value) return loadIndex();
  const generation = ++loadGeneration;
  loading.value = true;
  await loadSnapshot(selectedProjectId.value, generation);
  loading.value = false;
}

function taskTarget(task: TaskView): void {
  void router.push({ name: 'project-task-detail', params: { taskId: task.id }, query: { ...route.query, project: selectedProjectId.value } });
}
function proposalTarget(proposal: TaskProposal): void {
  void router.push({ name: 'project-task-proposal', params: { proposalId: proposal.id }, query: { ...route.query, project: selectedProjectId.value } });
}
function returnToList(): void {
  void router.push({ name: 'project-tasks', query: { ...route.query, project: selectedProjectId.value } });
}
function beginProposalForm(event: MouseEvent): void {
  proposalTrigger.value = event.currentTarget as HTMLButtonElement;
  fillProposalForm();
  proposalFormOpen.value = true;
  proposalEditOpen.value = false;
  void nextTick(() => document.querySelector<HTMLInputElement>('.chat-dialog-backdrop input')?.focus());
  announcer.announce('Task proposal form opened.');
}
function setProposalFormOpen(open: boolean): void {
  proposalFormOpen.value = open;
  if (!open) void nextTick(() => void nextTick(() => proposalTrigger.value?.focus()));
}
function openProposalEditor(): void {
  fillProposalForm(proposalCurrent.value);
  proposalEditOpen.value = true;
  beginOpen.value = false;
}
function openBeginPanel(): void {
  const first = environmentOptions.value.find((entry) => entry.enabled);
  beginEnvironmentId.value = first?.id ?? '';
  beginLeadKey.value = beginLeadOptions.value[0]?.key ?? '';
  beginOpen.value = true;
  proposalEditOpen.value = false;
}

async function submitProposal(): Promise<void> {
  const currentApi = api.value;
  if (!currentApi || !selectedProjectId.value) return;
  const content: TaskProposalContent = {
    title: proposalTitle.value.trim(), goal: proposalGoal.value.trim(),
    constraints: splitLines(proposalConstraints.value), validationCriteria: splitLines(proposalCriteria.value),
  };
  let created: TaskProposal | undefined;
  const saved = await perform('Task proposal created.', async () => {
    const validated = await currentApi.validateProposal(selectedProjectId.value, content);
    created = await currentApi.propose(selectedProjectId.value, validated);
  });
  if (saved && created) {
    proposalFormOpen.value = false;
    fillProposalForm();
    filter.value = 'proposed';
    await router.push({ name: 'project-task-proposal', params: { proposalId: created.id }, query: { ...route.query, project: selectedProjectId.value } });
  }
}
async function submitProposalRevision(): Promise<void> {
  const currentApi = api.value;
  const proposal = selectedProposal.value;
  if (!currentApi || !proposal) return;
  const content = {
    title: proposalTitle.value.trim(), goal: proposalGoal.value.trim(),
    constraints: splitLines(proposalConstraints.value), validationCriteria: splitLines(proposalCriteria.value),
  };
  const saved = await perform('Proposal revision saved.', async () => {
    const validated = await currentApi.validateProposal(proposal.projectId, content);
    await currentApi.reviseProposal(proposal.id, { ...validated, expectedRevision: proposal.revision, reason: proposalReason.value.trim() });
  });
  if (saved) proposalEditOpen.value = false;
}
async function decideProposal(action: 'reject' | 'withdraw'): Promise<void> {
  const currentApi = api.value;
  const proposal = selectedProposal.value;
  if (!currentApi || !proposal) return;
  await perform(action === 'reject' ? 'Proposal rejected.' : 'Proposal withdrawn.', async () => {
    const decision = { expectedRevision: proposal.revision, reason: proposalReason.value.trim() };
    if (action === 'reject') await currentApi.rejectProposal(proposal.id, decision);
    else await currentApi.withdrawProposal(proposal.id, decision);
  });
}
async function approveAndBegin(): Promise<void> {
  const currentApi = api.value;
  const proposal = selectedProposal.value;
  const lead = actorFromKey(beginLeadKey.value);
  if (!currentApi || !proposal || !lead || !beginSelectionReady.value) return;
  const saved = await perform('Task approved and begin requested.', async () => {
    await currentApi.beginProposal(proposal.id, {
      expectedRevision: proposal.revision,
      environmentInstanceId: beginEnvironmentId.value,
      lead,
    });
  });
  if (saved) beginOpen.value = false;
}
async function advanceTask(): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  if (!currentApi || !task || !advanceTargetId.value) return;
  const saved = await perform('Task lead advance requested.', async () => {
    await currentApi.advance(task.id, { targetAgentId: advanceTargetId.value, reason: controlReason.value.trim() });
  });
  if (saved) advanceTargetId.value = '';
}
async function reviseTask(): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  const lead = actorFromKey(taskLeadKey.value);
  if (!currentApi || !task || !lead) return;
  const saved = await perform('Task content version saved.', async () => {
    await currentApi.reviseTaskContent(task.id, {
      expectedContentVersion: taskContentVersion.value,
      content: {
        title: taskTitle.value.trim(), goal: taskGoal.value.trim(), constraints: splitLines(taskConstraints.value),
        validationCriteria: splitLines(taskCriteria.value), lead,
      },
      reason: taskRevisionReason.value.trim(),
    });
  });
  if (saved) taskEditOpen.value = false;
}
async function taskControl(action: 'pause' | 'interrupt' | 'resume' | 'clear-blocker' | 'end' | 'discard'): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  if (!currentApi || !task) return;
  await perform('Task control saved.', async () => {
    if (action === 'pause') await currentApi.pause(task.id, controlReason.value.trim());
    else if (action === 'interrupt') await currentApi.interrupt(task.id, controlReason.value.trim());
    else if (action === 'resume') await currentApi.resume(task.id, controlReason.value.trim());
    else if (action === 'clear-blocker') await currentApi.clearBlocker(task.id, controlReason.value.trim());
    else if (action === 'end') await currentApi.end(task.id, controlReason.value.trim());
    else await currentApi.discard(task.id, controlReason.value.trim());
  });
}
async function stopActiveRun(): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  const runId = stopActiveRunId.value;
  if (!currentApi || !task || !runId || task.activeRunId !== runId
    || task.pauseState === 'requested' || actionReasonRequired.value) return;
  const reason = controlReason.value.trim();
  const stopped = await perform('Active Agent run stopped. The unfinished Task remains paused with its Environment lease held.', async () => {
    await currentApi.pause(task.id, reason);
    await currentApi.interrupt(task.id, reason);
  });
  if (stopped) stopActiveRunId.value = '';
}
async function addBlocker(): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  const lead = taskContent.value?.lead;
  if (!currentApi || !task || !lead) return;
  let responsible: TaskBlockerResponsibility;
  if (blockerResponsibleKind.value === 'human' || blockerResponsibleKind.value === 'agent') {
    const actor = actorFromKey(blockerResponsibleMemberKey.value);
    if (!actor || actor.memberKind !== blockerResponsibleKind.value) return;
    responsible = { kind: blockerResponsibleKind.value, memberId: actor.memberId };
  } else if (blockerResponsibleKind.value === 'recovery') {
    if (!blockerResponsibleValue.value.trim()) return;
    responsible = { kind: 'recovery', mechanism: blockerResponsibleValue.value.trim() };
  } else {
    if (!blockerResponsibleValue.value.trim()) return;
    responsible = { kind: 'external-condition', condition: blockerResponsibleValue.value.trim() };
  }
  const saved = await perform('Task blocker recorded.', async () => {
    await currentApi.raiseBlocker(task.id, {
      reason: blockerReason.value.trim(),
      requiredAction: blockerAction.value.trim(),
      responsible,
      nextAdvancer: lead,
    });
  });
  if (saved) {
    blockerOpen.value = false;
    blockerReason.value = '';
    blockerAction.value = '';
    blockerResponsibleKind.value = 'external-condition';
    blockerResponsibleMemberKey.value = '';
    blockerResponsibleValue.value = '';
  }
}
async function submitCompletionClaim(): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  if (!currentApi || !task || !canSubmitCompletionClaim.value) return;
  const saved = await perform('Task completion claim submitted.', async () => {
    await currentApi.submitCompletionClaim(task.id, {
      outcomeSummary: completionOutcome.value.trim(),
      validationEvidence: splitLines(completionEvidence.value),
      durableChanges: splitLines(completionChanges.value),
      limitations: splitLines(completionLimitations.value),
      recommendedDisposition: completionDisposition.value,
    });
  });
  if (saved) {
    completionOutcome.value = '';
    completionEvidence.value = '';
    completionChanges.value = '';
    completionLimitations.value = '';
    completionDisposition.value = 'complete';
  }
}
async function validateClaim(decision: 'accept' | 'correct'): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  const claim = selectedCompletionClaim.value;
  if (!currentApi || !task || !claim) return;
  await perform(decision === 'accept' ? 'Completion accepted; safe Task end started.' : 'Correction requested; the Task lease remains held.', async () => {
    await currentApi.validate(task.id, { claimId: claim.id, decision, reason: controlReason.value.trim() });
  });
}
async function recoverTask(action: 'resume' | 'discard'): Promise<void> {
  const currentApi = api.value;
  const task = selectedTask.value?.task;
  if (!currentApi || !task) return;
  await perform(action === 'resume' ? 'Task recovery resume requested.' : 'Task discard requested through recovery.', async () => {
    await currentApi.recover(task.id, { action, reason: controlReason.value.trim() });
  });
}
async function perform(success: string, action: () => Promise<unknown>): Promise<boolean> {
  if (!canControl.value) {
    actionError.value = { message: presentation.value.announce || 'Task controls are unavailable while the connection is unsettled.' };
    return false;
  }
  submitting.value = true;
  actionError.value = undefined;
  try {
    await action();
    controlReason.value = '';
    proposalReason.value = '';
    taskRevisionReason.value = '';
    await refresh();
    announcer.announce(success);
    return true;
  } catch (error) {
    actionError.value = errorState(error);
    const failure = requestFailure(error);
    if (failure?.status === 409) await refresh();
    announcer.announce(actionError.value.message);
    return false;
  } finally {
    submitting.value = false;
  }
}

watch(() => route.meta['tab'], (tab) => {
  if (tab === 'tasks') announcer.announce('Project tasks view.');
}, { immediate: true });
watch(() => route.query['project'], (value) => {
  const id = typeof value === 'string' ? value : '';
  if (id && projects.value.length && id !== selectedProjectId.value) void selectProject(id);
});
watch(() => [openTaskId.value, openProposalId.value, selectedProjectId.value] as const, ([taskId, proposalId, projectId]) => {
  if (projectId && (taskId || proposalId)) void loadSelectedRecord(projectId);
  else {
    selectedTask.value = undefined;
    selectedProposal.value = undefined;
    selectedProposalVersion.value = undefined;
    detailError.value = '';
  }
});
watch(() => [openTaskId.value, openProposalId.value] as const, async ([taskId, proposalId]) => {
  stopRunId.value = '';
  stopActiveRunId.value = '';
  if (!taskId && !proposalId) return;
  focusSelectedRecord = true;
  await nextTick();
  detailHeading.value?.focus({ preventScroll: true });
  announcer.announce(taskId ? 'Task details opened.' : 'Task proposal details opened.');
});
watch(beginEnvironmentId, () => {
  if (!beginLeadOptions.value.some((entry) => entry.key === beginLeadKey.value)) beginLeadKey.value = beginLeadOptions.value[0]?.key ?? '';
});
onMounted(() => { void loadIndex(); });
</script>

<template>
  <div class="project-tasks-view relative flex h-full min-h-0 flex-col bg-[var(--bg-app)]">
    <div class="w-full max-w-[1920px] mx-auto p-4 sm:p-6 flex h-full min-h-0 flex-col gap-4">
      <header class="shrink-0 border-b border-[var(--border-subtle)] pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-lg sm:text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Icon name="tasks" :size="20" /> Project Tasks & Operating Loop
          </h1>
          <p class="text-xs text-[var(--text-secondary)] mt-1">Human authorized work, bounded Task lead runs, and safe Environment lease recovery.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label for="task-project-select" class="sr-only">Project</label>
          <select id="task-project-select" class="min-h-[44px] min-w-[12rem] max-w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)]" :value="selectedProjectId" :disabled="loading || projects.length === 0" @change="selectProject(($event.target as HTMLSelectElement).value)">
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.displayName }}{{ project.status === 'archived' ? ' · archived' : '' }}</option>
          </select>
          <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="loading" aria-label="Refresh Task facts" @click="refresh"><Icon name="refresh" :size="14" /><span>Refresh</span></Button>
          <Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || projectArchived" @click="beginProposalForm"><Icon name="plus" :size="14" /><span>Propose Task</span></Button>
        </div>
      </header>

        <ChatDialog :open="proposalFormOpen" @update:open="setProposalFormOpen" title="Propose a Task" description="A proposal creates no Agent run and holds no Environment lease. Human approval is required before begin.">
          <form class="grid grid-cols-1 gap-3" @submit.prevent="submitProposal">
            <label class="flex flex-col gap-1 text-xs">Title<input v-model="proposalTitle" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label>
            <label class="flex flex-col gap-1 text-xs">Goal<textarea v-model="proposalGoal" class="min-h-24 rounded border bg-[var(--bg-surface)] p-3 text-sm" required /></label>
            <label class="flex flex-col gap-1 text-xs">Constraints, one per line<textarea v-model="proposalConstraints" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
            <label class="flex flex-col gap-1 text-xs">Validation criteria, one per line<textarea v-model="proposalCriteria" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
            <div class="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" class="min-h-[44px]" @click="setProposalFormOpen(false)">Cancel</Button><Button type="submit" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || !proposalTitle.trim() || !proposalGoal.trim()">Save proposal</Button></div>
          </form>
        </ChatDialog>

      <div v-if="actionError" class="rounded border border-[var(--red-action-border)] bg-[var(--red-action-bg)] p-3 text-sm text-[var(--text-primary)]" role="alert" :data-conflict-code="actionError.code">
        <strong class="block">Task action needs attention</strong>
        <span>{{ actionError.message }}</span>
      </div>
      <div v-if="pageError" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-4 text-sm text-[var(--text-primary)]" role="alert">
        <p>{{ pageError }}</p>
        <Button variant="secondary" size="sm" class="mt-3 min-h-[44px]" @click="loadIndex">Retry loading Project Tasks</Button>
      </div>
      <div v-else-if="loading" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-sm text-[var(--text-secondary)]" role="status" aria-live="polite">Loading Project Tasks and current lifecycle facts…</div>
      <EmptyState v-else-if="projects.length === 0" icon="project" title="No Projects yet" description="Create or select a Project before proposing or beginning Task work." />
      <div v-else class="grid flex-1 min-h-[520px] grid-rows-[minmax(0,1fr)] grid-cols-1 lg:grid-cols-[minmax(17rem,0.85fr)_minmax(0,2fr)] gap-4 min-w-0 overflow-hidden" data-task-layout="split">
        <aside class="flex flex-col min-h-0 min-w-0 overflow-hidden" :class="hasDetail ? 'hidden lg:flex' : 'flex'" aria-label="Project Task list">
          <div class="shrink-0 pb-3 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-bold">Tasks and proposals</h2>
              <span class="text-xs text-[var(--text-muted)]">{{ filteredEntries.length }} shown</span>
            </div>
            <label for="task-status-filter" class="sr-only">Filter Project Tasks</label>
            <select id="task-status-filter" v-model="filter" class="min-h-[44px] w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-sm capitalize text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">
              <option v-for="choice in filters" :key="choice" :value="choice">{{ choice === 'validation' ? 'Awaiting validation' : choice }}</option>
            </select>
          </div>
          <div v-if="filteredEntries.length" class="flex flex-1 min-h-0 flex-col gap-2 overflow-y-auto">
            <button v-for="entry in filteredEntries" :key="entry.kind === 'task' ? `task:${entry.task.id}` : `proposal:${entry.proposal.id}`" type="button" :data-record-kind="entry.kind" :data-record-id="entry.kind === 'task' ? entry.task.id : entry.proposal.id" class="w-full min-h-[88px] rounded border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :class="((entry.kind === 'task' && openTaskId === entry.task.id) || (entry.kind === 'proposal' && openProposalId === entry.proposal.id)) ? 'border-[var(--accent-primary)] bg-[var(--accent-bg)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-elevated)]'" @click="entry.kind === 'task' ? taskTarget(entry.task) : proposalTarget(entry.proposal)">
              <template v-if="entry.kind === 'task'">
                <div class="flex items-center justify-between gap-2"><Badge :variant="badgeVariant(taskStage(entry.task))">{{ taskStage(entry.task) }}</Badge><span class="text-[10px] text-[var(--text-muted)]">v{{ entry.task.admission?.contentVersion ?? 1 }}</span></div>
                <strong class="block mt-2 text-sm text-[var(--text-primary)]">{{ entry.task.title }}</strong>
                <span class="block mt-1 text-[11px] text-[var(--text-secondary)]">{{ lifecycleSentence(entry.task) }}</span>
              </template>
              <template v-else>
                <div class="flex items-center justify-between gap-2"><Badge :variant="badgeVariant(proposalStage(entry.proposal))">{{ proposalStage(entry.proposal) }}</Badge><span class="text-[10px] text-[var(--text-muted)]">v{{ entry.proposal.currentContentVersion }}</span></div>
                <strong class="block mt-2 text-sm text-[var(--text-primary)]">{{ entry.proposal.versions.find((version) => version.version === entry.proposal.currentContentVersion)?.title ?? 'Untitled proposal' }}</strong>
                <span class="block mt-1 text-[11px] text-[var(--text-secondary)]">{{ entry.proposal.status === 'proposed' ? 'No Agent run · No Environment lease' : `Proposal ${entry.proposal.status}` }}</span>
              </template>
            </button>
          </div>
          <EmptyState v-else icon="tasks" title="No Tasks in this view" description="Change the filter or propose a Task to start a Human reviewed work path." class="m-4" />
        </aside>

        <section v-if="hasDetail" class="min-w-0 min-h-0 flex flex-col gap-4 overflow-y-auto [&>*]:shrink-0" aria-label="Selected Task details">
          <div v-if="detailLoading" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-sm" role="status">Loading selected Task facts…</div>
          <div v-else-if="detailError" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-4" role="alert">
            <div class="flex flex-wrap items-center justify-between gap-3"><p>{{ detailError }}</p><Button variant="secondary" size="sm" class="min-h-[44px]" @click="loadSelectedRecord(selectedProjectId)">Retry</Button></div>
          </div>
          <template v-else-if="selectedProposal">
            <div class="flex items-center gap-3 border-b border-[var(--border-subtle)] pb-3">
              <Button variant="ghost" size="sm" class="min-h-[44px] lg:hidden" @click="returnToList"><Icon name="chevron-left" :size="16" />Back to Tasks</Button>
              <div class="min-w-0 flex-1"><Badge :variant="badgeVariant(proposalStage(selectedProposal))">{{ proposalStage(selectedProposal) }}</Badge><h2 ref="detailHeading" tabindex="-1" class="mt-1 text-lg font-bold focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">{{ proposalCurrent?.title }}</h2></div>
              <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="loading" @click="refresh">Refresh</Button>
            </div>
            <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-3">
              <h3 class="font-bold">Proposed Task · Content version {{ selectedProposal.currentContentVersion }}</h3>
              <p class="text-sm whitespace-pre-wrap">{{ proposalCurrent?.goal }}</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Constraints</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in proposalCurrent?.constraints" :key="item">{{ item }}</li><li v-if="!proposalCurrent?.constraints.length" class="list-none text-[var(--text-muted)]">None declared</li></ul></div>
                <div><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Validation criteria</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in proposalCurrent?.validationCriteria" :key="item">{{ item }}</li><li v-if="!proposalCurrent?.validationCriteria.length" class="list-none text-[var(--text-muted)]">None declared</li></ul></div>
              </div>
              <div class="border-t border-[var(--border-subtle)] pt-3"><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Content history</h4><ol class="mt-2 flex flex-col gap-2"><li v-for="version in selectedProposal.versions" :key="version.version" class="rounded bg-[var(--bg-surface-elevated)] p-2 text-xs"><strong>Version {{ version.version }}</strong> · {{ actorName(version.actor) }} · {{ formatTime(version.at) }}<p v-if="version.reason" class="mt-1 text-[var(--text-secondary)]">{{ version.reason }}</p></li></ol></div>
            </section>
            <section v-if="selectedProposal.status === 'proposed'" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-3">
              <div><h3 class="font-bold">Human authorization</h3><p class="text-xs text-[var(--text-secondary)] mt-1">Approve and begin binds the selected content version to one Environment lease. A proposal itself has no run and holds no lease.</p></div>
              <div class="flex flex-wrap gap-2"><Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl || projectArchived" @click="openProposalEditor">Revise proposal</Button><Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || projectArchived" @click="openBeginPanel">Approve & Begin</Button><Button v-if="selectedProposalIsHumanProposed" variant="ghost" size="sm" class="min-h-[44px]" :disabled="!canControl || projectArchived || !proposalReason.trim()" @click="decideProposal('withdraw')">Withdraw</Button><Button variant="ghost" size="sm" class="min-h-[44px] text-[var(--red-action)]" :disabled="!canControl || projectArchived || !proposalReason.trim()" @click="decideProposal('reject')">Reject</Button></div>
              <label class="flex flex-col gap-1 text-xs">Decision reason<input v-model="proposalReason" class="min-h-[44px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-sm" required /></label>
              <form v-if="beginOpen" class="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[var(--border-subtle)] pt-3" @submit.prevent="approveAndBegin">
                <label class="flex flex-col gap-1 text-xs">Environment instance<select id="begin-environment" v-model="beginEnvironmentId" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3" required><option value="" disabled>Select Environment</option><option v-for="environment in environmentOptions" :key="environment.id" :value="environment.id" :disabled="!environment.enabled">{{ environment.name }}{{ environment.enabled ? '' : ` · ${environment.unavailableReason}` }}</option></select></label>
                <label class="flex flex-col gap-1 text-xs">Task lead<select id="begin-lead" v-model="beginLeadKey" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3" required><option v-for="lead in beginLeadOptions" :key="lead.key" :value="lead.key">{{ lead.label }}</option></select></label>
                <p data-lead-guidance class="sm:col-span-2 text-xs text-[var(--text-secondary)]">{{ beginEnvironmentId ? 'Choose yourself or a compatible Project Agent as Task lead. An Agent lead receives an initial run after begin; a Human lead does not.' : 'Select an available Environment to see eligible Agent leads. A Task lead may be you or a compatible Project Agent.' }}</p>
                <p v-if="!environmentOptions.some((environment) => environment.enabled)" data-begin-guidance class="sm:col-span-2 text-xs text-[var(--text-muted)]">No available Environment with a compatible Agent is confirmed. {{ environmentOptions.map((environment) => `${environment.name}: ${environment.unavailableReason}`).join('; ') || 'Assign an Environment and workspace in Project resources.' }} Review Project resources before beginning this proposal.</p>
                <div class="sm:col-span-2 flex flex-wrap gap-2"><Button type="submit" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || !beginSelectionReady">Confirm approve and begin</Button><Button type="button" variant="ghost" size="sm" class="min-h-[44px]" @click="beginOpen = false">Cancel</Button></div>
              </form>
              <form v-if="proposalEditOpen" class="grid grid-cols-1 gap-3 border-t border-[var(--border-subtle)] pt-3" @submit.prevent="submitProposalRevision">
                <h4 class="font-bold">Revise proposed content</h4>
                <label class="flex flex-col gap-1 text-xs">Title<input v-model="proposalTitle" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label>
                <label class="flex flex-col gap-1 text-xs">Goal<textarea v-model="proposalGoal" class="min-h-24 rounded border bg-[var(--bg-surface)] p-3 text-sm" required /></label>
                <label class="flex flex-col gap-1 text-xs">Constraints, one per line<textarea v-model="proposalConstraints" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
                <label class="flex flex-col gap-1 text-xs">Validation criteria, one per line<textarea v-model="proposalCriteria" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
                <label class="flex flex-col gap-1 text-xs">Revision reason<input v-model="proposalReason" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label>
                <div class="flex flex-wrap gap-2"><Button type="submit" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || !proposalReason.trim()">Save revision</Button><Button type="button" variant="ghost" size="sm" class="min-h-[44px]" @click="proposalEditOpen = false">Cancel</Button></div>
              </form>
            </section>
            <section v-else class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 text-sm">This proposal is {{ selectedProposal.status }} and cannot be approved again.</section>
          </template>

          <template v-else-if="selectedTask">
            <div class="flex items-center gap-3 border-b border-[var(--border-subtle)] pb-3">
              <Button variant="ghost" size="sm" class="min-h-[44px] lg:hidden" @click="returnToList"><Icon name="chevron-left" :size="16" />Back to Tasks</Button>
              <div class="min-w-0 flex-1"><Badge :variant="badgeVariant(taskStage(selectedTask.task))">{{ taskStage(selectedTask.task) }}</Badge><h2 ref="detailHeading" tabindex="-1" class="mt-1 text-lg font-bold focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">{{ selectedTask.task.title }}</h2><nav class="mt-2 flex flex-wrap gap-2" aria-label="Task authorities"><RouterLink data-task-authority="project" :to="{ name: 'project-overview', query: { project: selectedTask.task.projectId } }" class="min-h-[44px] inline-flex items-center rounded border border-[var(--border-subtle)] px-3 text-xs text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">Project overview</RouterLink><RouterLink v-if="taskContent?.lead.memberKind === 'agent'" data-task-authority="agent" :to="{ name: 'agent-detail', params: { agentId: taskContent.lead.memberId } }" class="min-h-[44px] inline-flex items-center rounded border border-[var(--border-subtle)] px-3 text-xs text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">Agent {{ agentName(taskContent.lead.memberId) }}</RouterLink><RouterLink v-if="selectedTaskEnvironmentId" data-task-authority="environment" :to="{ name: 'environment-detail', params: { id: selectedTaskEnvironmentId } }" class="min-h-[44px] inline-flex items-center rounded border border-[var(--border-subtle)] px-3 text-xs text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">Environment {{ overview?.environments.find((environment) => environment.id === selectedTaskEnvironmentId)?.displayName ?? 'details' }}</RouterLink></nav></div>
              <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="loading" @click="refresh">Refresh</Button>
            </div>
            <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
              <button type="button" class="w-full min-h-[48px] p-3 flex items-center justify-between gap-2 text-left" :aria-expanded="lifecycleExpanded" @click="lifecycleExpanded = !lifecycleExpanded"><span class="font-mono text-xs sm:text-sm">{{ lifecycleSentence(selectedTask.task) }}</span><Icon :name="lifecycleExpanded ? 'chevron-down' : 'chevron-right'" :size="15" /></button>
              <div v-if="lifecycleExpanded" class="border-t border-[var(--border-subtle)] p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Task lifecycle</span><strong>{{ taskStage(selectedTask.task) }}</strong></div>
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Agent run lifecycle</span><strong>{{ taskRunState(selectedTask.task) }}</strong></div>
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Task lease</span><strong>{{ leaseState(selectedTask.task) }}{{ selectedTask.task.environmentInstanceId ? ` · ${overview?.environments.find((environment) => environment.environmentInstanceId === selectedTask.task.environmentInstanceId)?.displayName ?? 'Environment'}` : '' }}</strong></div>
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Task context</span><strong>{{ selectedTask.task.taskContextState }}</strong></div>
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Content version</span><strong>v{{ taskContentVersion }}</strong></div>
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Task lead</span><strong>{{ actorName(taskContent?.lead) }}</strong></div>
                <div class="rounded bg-[var(--bg-surface-elevated)] p-2"><span class="block text-[var(--text-muted)]">Created</span><strong>{{ formatTime(selectedTask.task.createdAt) }}</strong></div>
              </div>
            </section>

            <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-bold">Task content · version {{ taskContentVersion }}</h3><Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl || terminalTask || selectedTask.task.environmentLifecycleState === 'ending'" @click="openTaskEditor">Revise content</Button></div>
              <p class="text-sm whitespace-pre-wrap">{{ taskContent?.goal }}</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Constraints</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in taskContent?.constraints" :key="item">{{ item }}</li><li v-if="!taskContent?.constraints.length" class="list-none text-[var(--text-muted)]">None declared</li></ul></div>
                <div><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Validation criteria</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in taskContent?.validationCriteria" :key="item">{{ item }}</li><li v-if="!taskContent?.validationCriteria.length" class="list-none text-[var(--text-muted)]">None declared</li></ul></div>
              </div>
              <div v-if="taskEditOpen" class="border-t border-[var(--border-subtle)] pt-3 flex flex-col gap-3">
                <h4 class="font-bold">Create a new Task content version</h4>
                <label class="flex flex-col gap-1 text-xs">Title<input v-model="taskTitle" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label>
                <label class="flex flex-col gap-1 text-xs">Goal<textarea v-model="taskGoal" class="min-h-24 rounded border bg-[var(--bg-surface)] p-3 text-sm" required /></label>
                <label class="flex flex-col gap-1 text-xs">Constraints, one per line<textarea v-model="taskConstraints" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
                <label class="flex flex-col gap-1 text-xs">Validation criteria, one per line<textarea v-model="taskCriteria" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
                <label class="flex flex-col gap-1 text-xs">Task lead<select v-model="taskLeadKey" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3"><option v-for="lead in taskLeadOptions" :key="lead.key" :value="lead.key">{{ lead.label }}</option></select></label>
                <label class="flex flex-col gap-1 text-xs">Revision reason<input v-model="taskRevisionReason" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label>
                <div class="flex flex-wrap gap-2"><Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || !taskRevisionReason.trim()" @click="reviseTask">Save content version</Button><Button variant="ghost" size="sm" class="min-h-[44px]" @click="taskEditOpen = false">Cancel</Button></div>
              </div>
              <ol v-if="selectedTask.task.controlHistory?.some((event) => event.action === 'content-revised')" class="border-t border-[var(--border-subtle)] pt-3 flex flex-col gap-2" aria-label="Task content version history">
                <li v-for="event in selectedTask.task.controlHistory.filter((event) => event.action === 'content-revised')" :key="event.contentVersion" class="rounded bg-[var(--bg-surface-elevated)] p-2 text-xs"><strong>Version {{ event.contentVersion }}</strong> · {{ actorName(event.actor) }} · {{ formatTime(event.at) }}<p class="mt-1 text-[var(--text-secondary)]">{{ event.reason }}</p></li>
              </ol>
            </section>

            <section v-if="canSubmitCompletionClaim" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-3">
              <div><h3 class="font-bold">Submit Task completion claim</h3><p class="mt-1 text-xs text-[var(--text-secondary)]">The Human Task lead can report the outcome and evidence for the current content version. A separate validation decision is still required.</p></div>
              <label class="flex flex-col gap-1 text-xs">Outcome summary<textarea v-model="completionOutcome" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" required /></label>
              <label class="flex flex-col gap-1 text-xs">Validation evidence, one per line<textarea v-model="completionEvidence" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" required /></label>
              <label class="flex flex-col gap-1 text-xs">Durable changes, one per line<textarea v-model="completionChanges" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
              <label class="flex flex-col gap-1 text-xs">Known limitations, one per line<textarea v-model="completionLimitations" class="min-h-20 rounded border bg-[var(--bg-surface)] p-3 text-sm" /></label>
              <label class="flex flex-col gap-1 text-xs">Recommended disposition<select v-model="completionDisposition" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3"><option value="complete">Complete</option><option value="continue">Continue</option></select></label>
              <div><Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || !completionOutcome.trim() || !completionEvidence.trim()" @click="submitCompletionClaim">Submit completion claim</Button></div>
            </section>

            <section v-if="selectedCompletionClaim" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-bold">Completion claim · {{ selectedCompletionClaim.recommendedDisposition }}</h3><Badge :variant="selectedTask.task.pendingCompletionClaimId ? 'warning' : 'secondary'">{{ selectedTask.task.pendingCompletionClaimId ? 'Awaiting validation' : 'Reviewed claim' }}</Badge></div>
              <p class="text-sm">{{ selectedCompletionClaim.outcomeSummary }}</p>
              <p class="text-xs text-[var(--text-muted)]">Submitted by {{ actorName(selectedCompletionClaim.actor) }} · Task content v{{ selectedCompletionClaim.contentVersion }} · {{ formatTime(selectedCompletionClaim.at) }}</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm"><div><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Validation evidence</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in selectedCompletionClaim.validationEvidence" :key="item">{{ item }}</li></ul></div><div><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Durable changes</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in selectedCompletionClaim.durableChanges" :key="item">{{ item }}</li><li v-if="!selectedCompletionClaim.durableChanges.length" class="list-none text-[var(--text-muted)]">None reported</li></ul></div><div class="md:col-span-2"><h4 class="text-xs font-bold uppercase text-[var(--text-muted)]">Known limitations</h4><ul class="mt-2 list-disc pl-5"><li v-for="item in selectedCompletionClaim.limitations" :key="item">{{ item }}</li><li v-if="!selectedCompletionClaim.limitations.length" class="list-none text-[var(--text-muted)]">None reported</li></ul></div></div>
              <div v-if="selectedTask.task.pendingCompletionClaimId" class="border-t border-[var(--border-subtle)] pt-3 flex flex-col gap-3"><label class="flex flex-col gap-1 text-xs">Validation reason<input v-model="controlReason" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label><div class="flex flex-wrap gap-2"><Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="validateClaim('accept')">Accept and safely end Task</Button><Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="validateClaim('correct')">Request correction</Button></div></div>
            </section>

            <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5 flex flex-col gap-3">
              <div><h3 class="font-bold">Human Task controls</h3><p class="text-xs text-[var(--text-secondary)] mt-1">Each command is sent once. Refresh shows the latest Task and lease facts before another decision.</p></div>
              <label class="flex flex-col gap-1 text-xs">Reason for this action<input v-model="controlReason" :aria-describedby="actionReasonRequired ? 'task-control-reason-hint' : undefined" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" /></label>
              <p v-if="actionReasonRequired" id="task-control-reason-hint" class="text-xs text-[var(--text-secondary)]" role="status">Enter a reason to enable actions that require one.</p>
              <div class="flex flex-wrap gap-2">
                <template v-if="selectedTask.task.environmentLifecycleState === 'running' && selectedTask.task.activeRunId && selectedTask.task.pauseState !== 'requested'">
                  <Button v-if="stopActiveRunId !== selectedTask.task.activeRunId" data-action="stop-active-run" variant="ghost" size="sm" class="min-h-[44px] text-[var(--red-action)]" :disabled="!canControl || actionReasonRequired" @click="stopActiveRunId = selectedTask.task.activeRunId!">Stop active run</Button>
                  <div v-else class="flex flex-col items-start gap-2" role="group" aria-label="Confirm stop for active Agent run">
                    <p class="text-xs text-[var(--text-secondary)]">This settles the active Agent run as stopped. The Task remains unfinished and paused, and its Environment lease stays held. Resume the Task to admit another run.</p>
                    <div class="flex flex-wrap gap-2"><Button variant="ghost" size="sm" class="min-h-[44px] text-[var(--red-action)]" :disabled="!canControl || actionReasonRequired" @click="stopActiveRun">Confirm stop active run</Button><Button variant="ghost" size="sm" class="min-h-[44px]" @click="stopActiveRunId = ''">Cancel stop</Button></div>
                  </div>
                </template>
                <Button v-if="selectedTask.task.activeRunId && selectedTask.task.pauseState !== 'requested'" variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="taskControl('pause')">Pause Task</Button>
                <Button v-if="selectedTask.task.pauseState === 'requested' && selectedTask.task.activeRunId" variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="taskControl('interrupt')">Interrupt active run</Button>
                <Button v-if="!terminalTask && selectedTask.task.pauseState === 'paused' && !selectedTask.task.activeRunId" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="taskControl('resume')">Resume Task</Button>
                <label v-if="taskCanAdvance" class="flex flex-col gap-1 text-xs">Next Agent<select id="advance-target-agent" v-model="advanceTargetId" aria-label="Next Agent" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3"><option value="" disabled>Select a Project Agent</option><option v-for="agent in advanceAgents" :key="agent.memberId" :value="agent.memberId">{{ agentName(agent.memberId) }}</option></select></label>
                <Button v-if="taskCanAdvance" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired || !advanceTargetId || !advanceAgents.length" @click="advanceTask">Advance Task lead work</Button>
                <Button v-if="selectedTask.task.blocker && !terminalTask && !selectedTask.task.activeRunId" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="taskControl('clear-blocker')">Clear blocker</Button>
                <Button v-if="!selectedTask.task.blocker && !terminalTask && !selectedTask.task.activeRunId && selectedTask.task.environmentLifecycleState === 'idle'" variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl" @click="blockerOpen = !blockerOpen">Record blocker</Button>
                <Button v-if="!terminalTask && selectedTask.task.environmentLifecycleState !== 'ending' && selectedTask.task.environmentLifecycleState !== 'recovery' && !selectedTask.task.activeRunId" variant="ghost" size="sm" class="min-h-[44px] text-[var(--red-action)]" :disabled="!canControl || actionReasonRequired" @click="taskControl('discard')">Discard Task</Button>
                <Button v-if="selectedTask.task.environmentLifecycleState === 'ending' || (selectedTask.task.environmentLifecycleState === 'recovery' && selectedTask.task.endDisposition)" variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="taskControl('end')">Retry safe Task end</Button>
                <template v-else-if="selectedTask.task.environmentLifecycleState === 'recovery'"><Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="recoverTask('resume')">Resume Task recovery</Button><Button variant="ghost" size="sm" class="min-h-[44px] text-[var(--red-action)]" :disabled="!canControl || actionReasonRequired" @click="recoverTask('discard')">Discard through recovery</Button></template>
                <Button v-if="terminalTask" variant="secondary" size="sm" class="min-h-[44px]" disabled>Task ended</Button>
              </div>
              <div v-if="blockerOpen" class="border-t border-[var(--border-subtle)] pt-3 flex flex-col gap-3"><h4 class="font-bold">Record a routable blocker</h4><label class="flex flex-col gap-1 text-xs">Blocker reason<input v-model="blockerReason" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label><label class="flex flex-col gap-1 text-xs">Required next action<input v-model="blockerAction" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label><label class="flex flex-col gap-1 text-xs">Responsible kind<select id="blocker-responsible-kind" v-model="blockerResponsibleKind" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3"><option value="human">Human</option><option value="agent">Agent</option><option value="recovery">Recovery mechanism</option><option value="external-condition">External condition</option></select></label><label v-if="blockerResponsibleKind === 'human' || blockerResponsibleKind === 'agent'" class="flex flex-col gap-1 text-xs">Responsible Human or Agent<select id="blocker-responsible-member" v-model="blockerResponsibleMemberKey" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3"><option value="" disabled>Select a current Project member</option><option v-for="member in blockerResponsibleMembers" :key="`${member.memberKind}:${member.memberId}`" :value="actorKey({ memberId: member.memberId, memberKind: member.memberKind })">{{ member.memberKind === 'human' ? 'You' : agentName(member.memberId) }}</option></select></label><label v-else class="flex flex-col gap-1 text-xs">{{ blockerResponsibleKind === 'recovery' ? 'Recovery mechanism' : 'External condition' }}<input v-model="blockerResponsibleValue" class="min-h-[44px] rounded border bg-[var(--bg-surface)] px-3 text-sm" required /></label><div class="flex flex-wrap gap-2"><Button variant="primary" size="sm" class="min-h-[44px]" :disabled="!canControl || !blockerReason.trim() || !blockerAction.trim() || !blockerResponsibilityReady" @click="addBlocker">Save blocker</Button><Button variant="ghost" size="sm" class="min-h-[44px]" @click="blockerOpen = false">Cancel</Button></div></div>
            </section>

            <section v-if="selectedTask.task.blocker" class="rounded border border-[var(--red-action-border)] bg-[var(--bg-surface)] p-4 sm:p-5"><h3 class="font-bold">Task blocker</h3><p class="mt-2 text-sm">{{ selectedTask.task.blocker.reason }}</p><p class="mt-1 text-xs text-[var(--text-secondary)]">Required action: {{ selectedTask.task.blocker.requiredAction }}</p><p class="mt-1 text-xs text-[var(--text-muted)]">Responsible: {{ blockerResponsibleName(selectedTask.task.blocker.responsible) }} · Next advancer: {{ actorName(selectedTask.task.blocker.nextAdvancer) }}</p></section>
            <section v-if="selectedTask.task.environmentLifecycleState === 'recovery'" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-4 sm:p-5" role="status"><h3 class="font-bold">Environment recovery holds the Task lease</h3><p class="mt-2 text-sm">No new run is admitted while this Task remains in recovery. Resume or discard uses the current recovery authority for the same Environment instance.</p><p v-if="selectedTask.task.forcedRelease" class="mt-2 text-xs text-[var(--text-secondary)]">The recorded disposition says cleanup proof was not established.</p></section>

            <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
              <h3 class="font-bold">Run timeline</h3>
              <p class="text-xs text-[var(--text-secondary)] mt-1">Autonomous execution audit · Expand a run to inspect its activity and final result.</p>
              <ol v-if="selectedTask.runs.length" class="mt-3 flex flex-col gap-2"><li v-for="run in selectedTask.runs" :key="run.runId" class="rounded bg-[var(--bg-surface-elevated)] p-3 text-sm"><RouterLink :to="{ name: 'agent-detail', params: { agentId: run.agentId }, query: { run: run.runId } }" :data-task-run-target="run.runId" class="min-h-[44px] flex flex-wrap items-center justify-between gap-2 rounded focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"><strong>Run {{ run.sequence }} · {{ run.summary?.status ?? (run.runId === selectedTask.task.activeRunId ? 'running' : 'queued') }}</strong><span class="text-xs text-[var(--text-muted)]">{{ actorName({ memberId: run.agentId, memberKind: 'agent' }) }} · {{ formatTime(run.linkedAt) }}</span></RouterLink><div class="mt-1 text-xs text-[var(--text-secondary)]">Task content {{ run.contentVersion ? `v${run.contentVersion}` : 'version unavailable' }}{{ run.requestedAt ? ` · requested ${formatTime(run.requestedAt)}` : '' }}</div><div v-if="canStopSubordinateRun(run)" class="mt-2"><Button v-if="stopRunId !== run.runId" data-action="stop-subordinate" variant="secondary" size="sm" class="min-h-[44px]" :disabled="!canControl" @click="stopRunId = run.runId">Stop run</Button><div v-else class="flex flex-col items-start gap-2" role="group" :aria-label="`Confirm stop for Run ${run.sequence}`"><p class="text-xs text-[var(--text-secondary)]">This stops the subordinate Agent run. The Task and its Environment lease stay active.</p><div class="flex flex-wrap gap-2"><Button variant="ghost" size="sm" class="min-h-[44px]" :disabled="!canControl || actionReasonRequired" @click="stopSubordinateRun(run)">Confirm stop run</Button><Button variant="ghost" size="sm" class="min-h-[44px]" @click="stopRunId = ''">Cancel</Button></div></div></div><TaskRunAudit :run-id="run.runId" /></li></ol>
              <p v-else class="mt-3 text-sm text-[var(--text-muted)]">No Agent runs have been admitted.</p>
            </section>
            <section v-if="selectedTask.task.controlHistory?.length" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5"><h3 class="font-bold">Task decision timeline</h3><ol class="mt-3 flex flex-col gap-2"><li v-for="(event, index) in selectedTask.task.controlHistory" :key="`${event.at}:${event.action}:${index}`" class="rounded bg-[var(--bg-surface-elevated)] p-3 text-xs"><div class="flex flex-wrap justify-between gap-2"><strong>{{ actionLabel(event) }}</strong><span>{{ actorName(event.actor) }} · {{ formatTime(event.at) }}</span></div><p v-if="'reason' in event" class="mt-1 text-[var(--text-secondary)]">{{ event.reason }}</p></li></ol></section>
          </template>
          <EmptyState v-else icon="tasks" title="Select a Task or proposal" description="Choose a record from the list to review its content, lifecycle, evidence, and permitted Human controls." />
        </section>
      </div>


    </div>
  </div>
</template>
