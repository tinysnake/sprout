<script setup lang="ts">
/**
 * The Project destination: Overview, Tasks, and Chat sub-views behind one
 * URL-addressable route tree.
 *
 * The active sub-view and any open Task or Chat scope come from the route, so a
 * deep link, a refresh, and browser Back/Forward all restore the same Project
 * context. Local interaction state (an open dialog, an expanded foldable) stays
 * local to this module; authoritative facts will arrive through typed module
 * ports as those Tickets land.
 */
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAnnouncer } from '../primitives/announcer.ts';
import { setReturnToDestination } from './return-context.ts';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import Card from '../primitives/Card.vue';
import ClampedText from '../primitives/ClampedText.vue';
import EmptyState from '../primitives/EmptyState.vue';
import Dialog from '../primitives/Dialog.vue';

const route = useRoute();
const router = useRouter();
const announcer = useAnnouncer();

const selectedProjectId = ref('sprout-m2');
/**
 * The scope shown for the unscoped `/project/chat` entry. An open scope always
 * comes from the route instead, so this never shadows a deep-linked record.
 */
const defaultChatChannel = ref('#general');

const selectedTask = ref<any>(null);
const activeTaskFilter = ref('all');
const isLifecycleFoldExpanded = ref(true);

const isProjectInfoOpen = ref(false);
const isNewProjectOpen = ref(false);
const isProposeTaskOpen = ref(false);
const isChatInfoOpen = ref(false);

const newProjName = ref('');
const newProjDesc = ref('');
const newProjPolicy = ref('explicit-only');

/** The sub-view is the route's tab, not a component-owned mode flag. */
const activeTab = computed<'overview' | 'tasks' | 'chat'>(() => {
  const tab = route.meta['tab'];
  return tab === 'tasks' || tab === 'chat' ? tab : 'overview';
});

/** An open Task record is route-addressed, so it survives refresh and Back. */
const openTaskId = computed(() =>
  typeof route.params['taskId'] === 'string' ? (route.params['taskId'] as string) : ''
);

/** An open Chat scope is route-addressed for the same reason. */
const openChatScopeId = computed(() =>
  typeof route.params['scopeId'] === 'string' ? (route.params['scopeId'] as string) : ''
);

watch(openChatScopeId, (scopeId) => {
  // Only an existing scope may become the default against which the unscoped
  // chat list resolves: an unknown route id must never be adopted as if it
  // named a real conversation.
  if (scopeId && chatScopes.some((scope) => scope.id === scopeId)) defaultChatChannel.value = scopeId;
});

watch(
  () => route.meta['tab'],
  () => {
    announcer.announce(`Project ${activeTab.value} view.`);
  },
  // Immediate, because arriving from another destination mounts this component
  // at the new tab rather than changing the tab of a mounted one. Without it a
  // Feed-to-Project jump would land silently.
  { immediate: true }
);

function handleCreateProject() {
  if (!newProjName.value.trim()) return;
  const name = newProjName.value.trim();
  const newId = `proj-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  projects.push({
    id: newId,
    name,
    desc: newProjDesc.value.trim() || 'Multi-agent project collaboration workspace',
    status: 'Active',
  });
  selectedProjectId.value = newId;
  newProjName.value = '';
  newProjDesc.value = '';
  isNewProjectOpen.value = false;
  announcer.announce(`Project ${name} created.`);
}

const newProposalTitle = ref('');
const newProposalGoal = ref('');
const newProposalLead = ref('Programmer');
const newProposalHost = ref('Mac Studio M2 Max');

function handleProposeTask() {
  if (!newProposalTitle.value.trim()) return;
  const newId = String(tasks.length + 101);
  tasks.unshift({
    id: newId,
    title: newProposalTitle.value.trim(),
    stage: 'Proposed',
    stageVariant: 'secondary' as const,
    lead: newProposalLead.value,
    host: newProposalHost.value,
    version: 'v1',
    lifecycleSentence: 'Task proposed · Executes NO run · Holds NO lease',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'clear',
    goal: newProposalGoal.value.trim() || 'Execute proposed project task goals with verification.',
    constraints: ['Proposals execute zero runs until explicit Human Begin authority.'],
    validationCriteria: ['Verification suite passes with zero uncommitted artifacts.'],
    runs: [],
  });
  newProposalTitle.value = '';
  newProposalGoal.value = '';
  isProposeTaskOpen.value = false;
  announcer.announce(`Task #${newId} proposed. It holds no lease and starts no run.`);
}

/** Opening a Task is a route change, so the record is deep-linkable. */
function openTaskDetail(task: { id: string }) {
  router.push({ name: 'project-task-detail', params: { taskId: task.id } });
}

function closeTaskDetail() {
  router.push({ name: 'project-tasks' });
}

const selectedMember = ref<any>(null);
const isMemberDetailOpen = ref(false);

function openMemberDetail(member: any) {
  selectedMember.value = member;
  isMemberDetailOpen.value = true;
}

/**
 * Leaving Project for another authoritative surface keeps the operator oriented:
 * the return control names where they came from, so Project is never a dead end.
 */
function navigateToEnvironments() {
  isMemberDetailOpen.value = false;
  setReturnToDestination(router, { name: 'project-tasks' }, 'Back to Project Tasks');
  router.push({ name: 'environments' });
}

function navigateToAgentsView() {
  isMemberDetailOpen.value = false;
  setReturnToDestination(router, { name: 'project-overview' }, 'Back to Project');
  router.push({ name: 'agents' });
}

const projects = [
  { id: 'sprout-m2', name: 'Sprout M2 Operator', desc: 'Local multi-agent collaboration and environment-scheduling platform', status: 'Active' },
  { id: 'minesweeper', name: 'o7 Minesweeper Game', desc: 'Deterministic puzzle game testbed with agent validation harnesses', status: 'Active' },
  { id: 'tooling', name: 'Dev Pipeline Tooling', desc: 'Host orchestration, carrier overlay, and verification CLI', status: 'Maintenance' },
];

const currentProject = computed(() => projects.find((p) => p.id === selectedProjectId.value) ?? projects[0]);

const projectMembers = [
  { id: 'agent-prog', name: 'Programmer', role: 'Lead Implementation Engineer', engine: 'Pi / Gemini 2.5', status: 'Active' },
  { id: 'agent-arch', name: 'Architect', role: 'System & Seams Architect', engine: 'Codex / GPT-5', status: 'Active' },
  { id: 'agent-fore', name: 'Foreman', role: 'Run Orchestrator & Coordinator', engine: 'Pi / Claude 3.7', status: 'Active' },
  { id: 'agent-res', name: 'Researcher', role: 'Primary Source & Baseline Analyst', engine: 'agy / DeepCode', status: 'Active' },
];

const boundWorkspaces = [
  { root: 'sprout-workspace', relPath: 'repos/sprout', host: 'Mac Studio M2 Max', status: 'Prepared & Ready' },
  { root: 'sprout-win-workspace', relPath: 'work/sprout', host: 'Windows Workstation 01', status: 'Lease Recovery' },
];

interface ProjectTask {
  id: string;
  title: string;
  stage: string;
  stageVariant: 'secondary' | 'success' | 'warning' | 'danger';
  lead: string;
  host: string;
  version: string;
  lifecycleSentence: string;
  agentRunLifecycle: string;
  leaseLifecycle: string;
  goal: string;
  constraints: string[];
  validationCriteria: string[];
  completionClaim: {
    outcomeSummary: string;
    validationEvidence: string;
    durableChanges: string[];
    recommendedDisposition: string;
  } | null;
  runs: { id: string; agent: string; engine: string; model: string; duration: string; tokens: string; status: string }[];
}

const tasks: ProjectTask[] = [
  {
    id: '101',
    title: 'Continuous Integration & Host Verification Pipeline',
    stage: 'Validation',
    stageVariant: 'warning',
    lead: 'Programmer',
    host: 'Mac Studio M2 Max',
    version: 'v2',
    lifecycleSentence: 'Task awaiting validation · No active Agent run · Lease held (Mac Studio M2 Max)',
    agentRunLifecycle: 'completed',
    leaseLifecycle: 'held',
    goal: 'Construct host validation pipelines and verify carrier streaming with local engine readiness.',
    constraints: [
      'Preserve host paths and private credentials strictly local to the worker host.',
      'Guarantee continuous exclusive Task lease holding from task begin to human validation.',
    ],
    validationCriteria: [
      'Automated runner passes verification checks with zero uncommitted artifacts.',
      'Carrier stream reports protocol compatibility and active heartbeat.',
    ],
    completionClaim: {
      outcomeSummary: 'CI and host verification pipelines constructed and operational across all enrolled worker hosts.',
      validationEvidence: '14 verification checks passing with 100% success.',
      durableChanges: ['repos/sprout/worker.go', 'repos/sprout/carrier.ts'],
      recommendedDisposition: 'completed',
    },
    runs: [
      { id: 'run-204', agent: 'Programmer', engine: 'Pi', model: 'gemini-2.5-pro', duration: '14m 20s', tokens: '412,000', status: 'Completed' },
      { id: 'run-203', agent: 'Programmer', engine: 'Pi', model: 'gemini-2.5-pro', duration: '8m 10s', tokens: '277,120', status: 'Completed' },
    ],
  },
  {
    id: '104',
    title: 'Distributed Agent Orchestration & Safety Validation',
    stage: 'Recovery',
    stageVariant: 'danger',
    lead: 'Architect',
    host: 'Windows Workstation 01',
    version: 'v1',
    lifecycleSentence: 'Task recovery · Interrupted run #206 · Lease recovering (Windows Workstation 01)',
    agentRunLifecycle: 'interrupted',
    leaseLifecycle: 'recovering',
    goal: 'Validate carrier disconnect recovery and operator force release procedures across partitioned workers.',
    constraints: [
      'No silent replay of uncommitted work.',
      'Operator force release must require explicit typed confirmation and reason.',
    ],
    validationCriteria: [
      'Worker carrier reconnect produces reconciled settlement evidence.',
      'Force release audit record is durably preserved.',
    ],
    completionClaim: null,
    runs: [
      { id: 'run-206', agent: 'Architect', engine: 'Codex', model: 'gpt-5-codex', duration: 'interrupted', tokens: 'n/a', status: 'Interrupted' },
    ],
  },
  {
    id: '107',
    title: 'Accessibility Verification & Operator Surface Diagnostics',
    stage: 'Active',
    stageVariant: 'success',
    lead: 'Foreman',
    host: 'Local Worker',
    version: 'v1',
    lifecycleSentence: 'Task active · Run running · Lease held (Local Worker)',
    agentRunLifecycle: 'running',
    leaseLifecycle: 'held',
    goal: 'Verify operator control accessibility, focus trapping, and screen-reader semantics.',
    constraints: ['Touch targets stay at or above the 44px floor.'],
    validationCriteria: ['Keyboard-only navigation completes every journey.'],
    completionClaim: null,
    runs: [
      { id: 'run-207', agent: 'Foreman', engine: 'Pi', model: 'claude-3-7-sonnet', duration: 'running', tokens: 'streaming', status: 'Running' },
    ],
  },
];

const TASK_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'proposed', label: 'Proposed' },
  { key: 'active', label: 'Active' },
  { key: 'validation', label: 'Awaiting Validation' },
  { key: 'recovery', label: 'Recovery' },
] as const;

const filteredTasks = computed(() => {
  if (activeTaskFilter.value === 'all') return tasks;
  return tasks.filter((t) => t.stage.toLowerCase() === activeTaskFilter.value);
});

/** The open record resolves from the route id, never from a parallel selection ref. */
const routeTask = computed(() => (openTaskId.value ? tasks.find((t) => t.id === openTaskId.value) : undefined));

/**
 * A deep link to a Task id that does not exist. It is never satisfied by
 * another record: the view renders an explicit not-found state instead of
 * silently falling back to the list under a URL that names a missing Task.
 */
const missingTaskId = computed(() => openTaskId.value !== '' && routeTask.value === undefined);

watch(
  routeTask,
  (task) => {
    selectedTask.value = task ?? null;
  },
  { immediate: true }
);

/**
 * A Chat scope's kind is a typed discriminator. The icon and the human label
 * both resolve from it, so a channel, a working group, and a direct message can
 * never be rendered with each other's semantics.
 */
type ChatScopeKind = 'channel' | 'working-group' | 'direct-message';

const CHAT_SCOPE_ICONS: Record<ChatScopeKind, string> = {
  channel: 'chat',
  'working-group': 'project',
  'direct-message': 'agents',
};

interface ChatScope {
  id: string;
  label: string;
  kind: ChatScopeKind;
  kindLabel: string;
  lastSnippet: string;
  lastTime: string;
  unread: number;
  readOnlyReason: string;
}

const chatScopes: ChatScope[] = [
  {
    id: '#general',
    label: '#general',
    kind: 'channel',
    kindLabel: 'Project channel',
    lastSnippet: 'All accessible dialog checks pass on both viewports.',
    lastTime: '10:11 AM',
    unread: 0,
    readOnlyReason: '',
  },
  {
    id: 'wg-frontend',
    label: 'wg-frontend',
    kind: 'working-group',
    kindLabel: 'Working group',
    lastSnippet: 'Focus ring contrast measured at 5.1:1.',
    lastTime: '09:48 AM',
    unread: 2,
    readOnlyReason: '',
  },
  {
    id: 'dm-architect',
    label: '@Architect',
    kind: 'direct-message',
    kindLabel: 'Direct message',
    lastSnippet: 'Lease recovery evidence attached.',
    lastTime: '09:20 AM',
    unread: 0,
    readOnlyReason: '',
  },
];

/** The scope the URL names, or undefined when that id does not exist. */
const openChatScope = computed(() => chatScopes.find((s) => s.id === openChatScopeId.value));

/**
 * A deep link to a Chat scope that does not exist. It is never satisfied by
 * another scope: the view renders an explicit not-found state instead of
 * substituting the first scope and allowing a mutation under the wrong URL.
 */
const missingChatScope = computed(() => openChatScopeId.value !== '' && openChatScope.value === undefined);

/**
 * The scope whose conversation is rendered. When the route names a scope, only
 * that record resolves; the `#general` fallback applies solely to the
 * unscoped `/project/chat` entry, never to a missing nested detail deep link.
 */
const activeScope = computed(() => {
  if (openChatScopeId.value !== '') return openChatScope.value;
  return chatScopes.find((s) => s.id === defaultChatChannel.value) ?? chatScopes[0];
});

/** The scope id rendered in headers and the composer. Display-only. */
const activeChatChannel = computed(() => activeScope.value?.id ?? defaultChatChannel.value);

const chatMessages = ref([
  {
    id: 'msg-1',
    author: 'Programmer',
    role: 'Agent',
    time: '10:11 AM',
    content: 'Host verification pipeline is green across all enrolled workers.',
  },
  {
    id: 'msg-2',
    author: 'Operator',
    role: 'Human Operator',
    time: '10:12 AM',
    content: 'Confirm the lease stays held through validation.',
  },
]);

const newMessage = ref('');

/** Opening a Chat scope is a route change, so the conversation is deep-linkable. */
function selectChannel(channelId: string) {
  router.push({ name: 'project-chat-scope', params: { scopeId: channelId } });
}

function closeChatScope() {
  router.push({ name: 'project-chat' });
}

function sendMessage() {
  // The shared conversation may only be mutated from an existing scope. A URL
  // naming a missing scope offers no composer, and this guard keeps the
  // invariant even if a send is ever dispatched from another path.
  if (missingChatScope.value) return;
  if (!newMessage.value.trim()) return;
  chatMessages.value.push({
    id: `msg-${Date.now()}`,
    author: 'Operator',
    role: 'Human Operator',
    time: 'Just now',
    content: newMessage.value.trim(),
  });
  newMessage.value = '';
}
</script>
<template>
  <div class="project-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- 1. Top Project Header & Selector -->
    <div
      class="px-3 sm:px-4 py-3 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 flex-nowrap"
      :class="{ 'hidden md:flex': activeTab === 'chat' && openChatScopeId }"
    >
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <div class="p-1.5 sm:p-2 rounded bg-[var(--accent-bg)] text-[var(--accent-primary)] shrink-0">
          <Icon name="folder" :size="18" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-nowrap">
            <select
              v-model="selectedProjectId"
              class="font-bold text-xs sm:text-sm text-[var(--text-primary)] bg-transparent border-0 focus:ring-0 cursor-pointer pr-3 truncate max-w-[150px] sm:max-w-none"
              aria-label="Select Project"
            >
              <option v-for="p in projects" :key="p.id" :value="p.id" class="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                {{ p.name }}
              </option>
            </select>
          </div>
          <span class="text-[10px] sm:text-[11px] text-[var(--text-muted)] block truncate">
            {{ currentProject.desc }}
          </span>
        </div>
      </div>

      <!-- Action Buttons (Info & New Project) - strictly right-aligned, shrink-0, no wrapping on narrow screens -->
      <div class="flex items-center gap-1.5 shrink-0 ml-auto">
        <Button
          variant="secondary"
          size="icon"
          title="Project Information & Metadata"
          aria-label="Project Information & Metadata"
          class="project-info-btn h-8 w-8"
          @click="isProjectInfoOpen = true"
        >
          <Icon name="info" :size="15" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          title="Create New Project"
          aria-label="Create New Project"
          class="new-project-btn h-8 w-8"
          @click="isNewProjectOpen = true"
        >
          <Icon name="plus" :size="15" />
        </Button>
      </div>
    </div>

    <!-- 2. Main Content Area (Fluid width, ultra-wide screen adapted) -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-6 w-full max-w-[1920px] mx-auto min-h-0">
      <!-- 1. Overview Tab -->
      <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Left 2 Columns on Wide Screens: Contract & Workspaces -->
        <div class="lg:col-span-2 flex flex-col gap-6">
          <!-- Goal & Collaboration Contract -->
          <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center justify-between">
              <span>Project Collaboration Agreement (AGENTS.md)</span>
              <span class="text-[10px] text-[var(--text-secondary)] font-mono">Wake policy: Explicit + Mentions</span>
            </h3>
            <p class="text-xs text-[var(--text-primary)] leading-relaxed">
              Strict multi-agent boundaries: all worker turns must record verifiable evidence before advancing task lifecycle.
              No uncommitted code without passing test suites.
            </p>
            <div class="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] pt-2 border-t border-[var(--border-subtle)]">
              <Icon name="shield" :size="14" class="text-[var(--green-ready)]" />
              <span>Host permissions verified · Task-held leases guaranteed exclusive</span>
            </div>
          </div>

          <!-- Bound Workspaces -->
          <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <div class="flex items-center justify-between">
              <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">Bound Host Workspaces</h3>
              <Badge variant="secondary">{{ boundWorkspaces.length }} Active Bindings</Badge>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div
                v-for="ws in boundWorkspaces"
                :key="ws.root"
                class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col justify-between gap-2"
              >
                <div>
                  <div class="flex items-center justify-between gap-2 mb-1">
                    <strong class="text-xs text-[var(--text-primary)] font-mono">{{ ws.root }}</strong>
                    <Badge :variant="ws.status === 'Prepared & Ready' ? 'success' : 'danger'">{{ ws.status }}</Badge>
                  </div>
                  <span class="text-[11px] text-[var(--text-muted)] font-mono block truncate">{{ ws.relPath }}</span>
                </div>
                <div class="text-[10px] text-[var(--text-secondary)] pt-1 border-t border-[var(--border-subtle)]">
                  Host: {{ ws.host }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right 1 Column on Wide Screens: Memberships -->
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs h-fit">
          <div class="flex items-center justify-between">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">Active Memberships</h3>
            <Badge variant="info">{{ projectMembers.length }} Agents</Badge>
          </div>
          <div class="flex flex-col gap-2">
            <button
              v-for="m in projectMembers"
              :key="m.id"
              type="button"
              class="w-full text-left p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] transition-all cursor-pointer flex items-center justify-between gap-2"
              @click="openMemberDetail(m)"
            >
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-xs">
                  {{ m.name[0] }}
                </div>
                <div>
                  <strong class="text-xs text-[var(--text-primary)] block">@{{ m.name }}</strong>
                  <span class="text-[10px] text-[var(--text-muted)] block">{{ m.role }}</span>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Badge variant="secondary" class="font-mono text-[9px]">{{ m.engine }}</Badge>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- 2. Tasks Tab (Prototype Operating Loop: List vs Dedicated Detail Drill-down) -->
      <div v-else-if="activeTab === 'tasks'" class="flex flex-col gap-4">
        <!-- Missing Task deep link: never satisfied by the list or another record. -->
        <div v-if="missingTaskId" class="tasks-not-found-state flex items-center justify-center p-8 h-full">
          <EmptyState
            icon="alert"
            title="Task Not Found"
            description="No task matches this URL. Choose a task from the list instead."
          >
            <Button
              variant="primary"
              size="sm"
              class="tasks-not-found-return text-xs"
              @click="closeTaskDetail"
            >
              <span>Back to Tasks List</span>
            </Button>
          </EmptyState>
        </div>

        <!-- 2.1 Dedicated Task Detail View (Matching prototype renderTaskDetailPage) -->
        <div v-else-if="selectedTask" class="flex flex-col gap-4">
          <!-- Back Navigation Bar -->
          <div class="flex items-center justify-between gap-3 p-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex-wrap shadow-xs">
            <button
              type="button"
              class="back-to-tasks-btn flex items-center gap-1.5 px-3 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer min-h-[36px]"
              @click="closeTaskDetail"
            >
              <Icon name="chevron-left" :size="16" />
              <span>Back to Tasks List</span>
            </button>
            <div class="flex items-center gap-2">
              <Badge :variant="selectedTask.stageVariant">{{ selectedTask.stage.toUpperCase() }}</Badge>
              <span class="text-xs font-mono font-bold text-[var(--text-primary)]">#{{ selectedTask.id }}: {{ selectedTask.title }}</span>
            </div>
          </div>

          <!-- 3-Lifecycle Disambiguation Box (Matching prototype .lifecycle-disambiguation-box) -->
          <div class="lifecycle-disambiguation-box rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden shadow-xs">
            <div
              class="lifecycle-fold-header flex items-center justify-between p-3 bg-[var(--bg-surface-elevated)] border-l-4 border-l-[var(--accent-primary)] cursor-pointer select-none"
              role="button"
              tabindex="0"
              @click="isLifecycleFoldExpanded = !isLifecycleFoldExpanded"
              @keydown.enter="isLifecycleFoldExpanded = !isLifecycleFoldExpanded"
              @keydown.space.prevent="isLifecycleFoldExpanded = !isLifecycleFoldExpanded"
            >
              <div class="flex items-center gap-2 font-mono text-xs font-semibold text-[var(--text-primary)]">
                <Icon name="settings" :size="14" />
                <span>{{ selectedTask.lifecycleSentence }}</span>
              </div>
              <Icon
                name="chevron-right"
                :size="14"
                class="transition-transform duration-150 text-[var(--text-muted)]"
                :class="{ 'rotate-90': isLifecycleFoldExpanded }"
              />
            </div>

            <div v-if="isLifecycleFoldExpanded" class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <div class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[var(--text-muted)] font-semibold">Task Lifecycle:</span>
                <Badge :variant="selectedTask.stageVariant">{{ selectedTask.stage }}</Badge>
              </div>
              <div class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[var(--text-muted)] font-semibold">Agent Run Lifecycle:</span>
                <Badge variant="purple">{{ selectedTask.agentRunLifecycle }}</Badge>
              </div>
              <div class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[var(--text-muted)] font-semibold">Task Lease State:</span>
                <Badge variant="success">{{ selectedTask.leaseLifecycle }} ({{ selectedTask.host }})</Badge>
              </div>
              <div class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[var(--text-muted)] font-semibold">Content Version:</span>
                <span class="font-mono font-bold">{{ selectedTask.version }}</span>
              </div>
              <div class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[var(--text-muted)] font-semibold">Task Lead Agent:</span>
                <span class="font-bold text-[var(--accent-primary)]">@{{ selectedTask.lead }}</span>
              </div>
              <div class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[var(--text-muted)] font-semibold">Assigned Host:</span>
                <span class="font-semibold">{{ selectedTask.host }}</span>
              </div>
            </div>
          </div>

          <!-- Operating Stage Card (Matching prototype .operating-stage-card) -->
          <div class="operating-stage-card p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <div class="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2.5">
              <div class="flex items-center gap-2">
                <Icon name="tasks" :size="16" class="text-[var(--accent-primary)]" />
                <h4 class="text-sm font-bold text-[var(--text-primary)]">Task Operating Stage & Specification</h4>
              </div>
              <span class="text-xs font-mono text-[var(--text-muted)]">{{ selectedTask.version }}</span>
            </div>

            <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
              <strong class="text-xs text-[var(--text-primary)] font-semibold">Task Goal:</strong>
              <p class="leading-relaxed">{{ selectedTask.goal }}</p>
            </div>

            <!-- Constraints & Validation Criteria -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1">
                <strong class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Operational Constraints</strong>
                <ul class="list-disc list-inside space-y-1 text-[var(--text-secondary)]">
                  <li v-for="c in selectedTask.constraints" :key="c">{{ c }}</li>
                </ul>
              </div>
              <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1">
                <strong class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Validation Criteria</strong>
                <ul class="list-disc list-inside space-y-1 text-[var(--text-secondary)]">
                  <li v-for="v in selectedTask.validationCriteria" :key="v">{{ v }}</li>
                </ul>
              </div>
            </div>

            <!-- Pending Completion Claim (If present) -->
            <div v-if="selectedTask.completionClaim" class="p-3 rounded bg-[var(--green-ready-bg)] border border-[var(--green-ready)] flex flex-col gap-2 text-xs">
              <div class="flex items-center justify-between">
                <strong class="text-xs font-bold text-[var(--green-ready)] flex items-center gap-1.5">
                  <Icon name="check" :size="14" />
                  <span>Completion Claim Submitted for Human Validation</span>
                </strong>
                <Badge variant="success">{{ selectedTask.completionClaim.recommendedDisposition.toUpperCase() }}</Badge>
              </div>
              <p class="text-[var(--text-primary)] leading-relaxed">{{ selectedTask.completionClaim.outcomeSummary }}</p>
              <div class="p-2 rounded bg-[var(--bg-surface)] font-mono text-[11px] text-[var(--text-secondary)]">
                Evidence: {{ selectedTask.completionClaim.validationEvidence }}
              </div>
              <div class="flex items-center justify-end gap-2 pt-2 border-t border-[var(--green-ready)]/30">
                <Button variant="secondary" size="xs">Require Correction</Button>
                <Button variant="primary" size="xs">Accept & Authorize Safe Task End</Button>
              </div>
            </div>

            <!-- Stage Actions -->
            <div class="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)] flex-wrap">
              <Button variant="secondary" size="sm" @click="navigateToEnvironments">
                <Icon name="environments" :size="13" />
                <span>Inspect Host Environment</span>
              </Button>
            </div>
          </div>

          <!-- Nested Agent Runs Timeline (Matching prototype .runs-card) -->
          <div class="runs-card p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <div class="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2.5">
              <div class="flex items-center gap-2">
                <Icon name="lightning" :size="16" class="text-[var(--accent-primary)]" />
                <h4 class="text-sm font-bold text-[var(--text-primary)]">Nested Agent Runs Timeline</h4>
              </div>
              <span class="text-xs text-[var(--text-muted)]">{{ selectedTask.runs.length }} Sequential Run(s) coordinated under Task-held Lease</span>
            </div>

            <div class="flex flex-col gap-2">
              <div
                v-for="run in selectedTask.runs"
                :key="run.id"
                class="p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex flex-col gap-2 text-xs"
              >
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-bold text-[var(--accent-primary)]">{{ run.id }}</span>
                    <strong class="text-[var(--text-primary)]">@{{ run.agent }}</strong>
                    <Badge :variant="run.status === 'Completed' ? 'success' : 'purple'">{{ run.status }}</Badge>
                  </div>
                  <span class="text-[11px] text-[var(--text-muted)] font-mono">{{ run.duration }} · {{ run.tokens }} toks</span>
                </div>
                <div class="text-[11px] text-[var(--text-secondary)] font-mono flex items-center gap-2">
                  <span>Engine: {{ run.engine }}</span>
                  <span>·</span>
                  <span>Model: {{ run.model }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 2.2 Standard Task List Grid (When no task is drilled into) -->
        <div v-else class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h3 class="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                <Icon name="tasks" :size="18" />
                <span>Project Tasks & Operating Loop</span>
              </h3>
              <p class="text-xs text-[var(--text-secondary)] mt-0.5">
                Click any task card to drill down into its full operating controls and run execution timeline.
              </p>
            </div>

            <div class="flex items-center gap-2">
              <div class="flex items-center gap-1.5 overflow-x-auto py-1" role="group" aria-label="Filter tasks by stage">
                <button
                  v-for="f in TASK_FILTERS"
                  :key="f.key"
                  type="button"
                  class="task-filter-pill px-2.5 py-1.5 rounded-[var(--radius-sm)] border text-xs font-semibold cursor-pointer min-h-[36px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
                  :class="activeTaskFilter === f.key ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--primary-text,var(--text-primary))] font-bold ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'"
                  :data-task-filter="f.key"
                  :aria-pressed="activeTaskFilter === f.key"
                  @click="activeTaskFilter = f.key"
                >
                  {{ f.label }}
                </button>
              </div>

              <Button variant="primary" size="sm" class="propose-task-btn" @click="isProposeTaskOpen = true">
                <Icon name="plus" :size="14" />
                <span>Propose Task</span>
              </Button>
            </div>
          </div>

          <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <button
              v-for="task in filteredTasks"
              :key="task.id"
              type="button"
              class="text-left w-full p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface-elevated)] transition-all flex flex-col justify-between gap-3 shadow-xs cursor-pointer select-none"
              @click="openTaskDetail(task)"
            >
              <div>
                <div class="flex items-center justify-between gap-2 mb-1.5">
                  <div class="flex items-center gap-2">
                    <Badge :variant="task.stageVariant">{{ task.stage.toUpperCase() }}</Badge>
                    <span class="text-xs font-mono font-bold text-[var(--text-muted)]">#{{ task.id }}</span>
                  </div>
                  <span class="text-[11px] font-mono text-[var(--text-muted)]">{{ task.version }}</span>
                </div>
                <h4 class="text-sm font-bold text-[var(--text-primary)] mb-1">
                  {{ task.title }}
                </h4>
                <p class="text-xs text-[var(--text-secondary)] font-mono">
                  {{ task.lifecycleSentence }}
                </p>
              </div>

              <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs text-[var(--text-muted)]">
                <span>Lead: @{{ task.lead }}</span>
                <span>Host: {{ task.host }}</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- 3. Chat Tab (Responsive: Wide screen side-by-side, narrow screen drill-down with back button) -->
      <div v-else-if="activeTab === 'chat'" class="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden flex flex-col md:flex-row h-[750px] shadow-xs">
        <!-- Missing Chat scope deep link: never substitute another scope or offer
             its composer, so no message can be written under the wrong URL. -->
        <div v-if="missingChatScope" class="chat-not-found-state w-full flex items-center justify-center p-8 h-full">
          <EmptyState
            icon="alert"
            title="Conversation Not Found"
            description="No conversation matches this URL. Choose a conversation from the list instead."
          >
            <Button
              variant="primary"
              size="sm"
              class="chat-not-found-return text-xs"
              @click="closeChatScope"
            >
              <span>Back to Conversations</span>
            </Button>
          </EmptyState>
        </div>

        <!-- Chat Channels Cards / List: Visible on Desktop, or on Mobile when NOT drilled down -->
        <template v-else>
        <div
          class="w-full md:w-72 lg:w-80 bg-[var(--bg-surface-elevated)] md:border-r border-[var(--border-subtle)] p-3 flex flex-col gap-2 shrink-0 overflow-y-auto"
          :class="openChatScopeId ? 'hidden md:flex' : 'flex'"
        >
          <div class="flex items-center justify-between px-2 mb-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] tracking-wider">Conversations & Groups</span>
            <span class="text-[10px] text-[var(--text-muted)]">{{ chatScopes.length }} Active</span>
          </div>

          <!-- Chat Scope Cards List -->
          <div class="flex flex-col gap-1.5">
            <button
              v-for="scope in chatScopes"
              :key="scope.id"
              type="button"
              :data-scope-id="scope.id"
              :data-scope-kind="scope.kind"
              class="w-full text-left p-3 rounded-[var(--radius-sm)] border transition-all cursor-pointer select-none flex flex-col gap-1"
              :class="activeChatChannel === scope.id ? 'bg-[var(--bg-surface)] border-[var(--accent-primary)] shadow-xs ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]'"
              @click="selectChannel(scope.id)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 truncate">
                  <div class="p-1 rounded bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]">
                    <Icon :name="CHAT_SCOPE_ICONS[scope.kind]" :size="14" />
                  </div>
                  <strong class="text-xs font-bold text-[var(--text-primary)] truncate">{{ scope.label }}</strong>
                  <span class="text-[9px] uppercase tracking-wider text-[var(--text-muted)] shrink-0">{{ scope.kindLabel }}</span>
                </div>
                <span class="text-[10px] text-[var(--text-muted)] font-mono shrink-0">{{ scope.lastTime }}</span>
              </div>

              <p class="text-[11px] text-[var(--text-secondary)] truncate pl-7">
                {{ scope.lastSnippet }}
              </p>

              <div v-if="scope.unread > 0" class="flex justify-end pt-0.5">
                <span class="px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-[var(--accent-primary)] text-[var(--text-inverse)]">
                  {{ scope.unread }} new
                </span>
              </div>
            </button>
          </div>
        </div>

        <!-- Chat Timeline & Composer: Visible on Desktop, or on Mobile when drilled down -->
        <div
          class="flex-1 flex flex-col justify-between h-full bg-[var(--bg-surface)] min-w-0"
          :class="!openChatScopeId ? 'hidden md:flex' : 'flex'"
        >
          <!-- Mobile-only Chat Back Header (Hidden on md+) -->
          <div class="md:hidden px-3 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-2">
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer py-1 px-2 rounded bg-[var(--accent-bg)] border border-[var(--accent-border)] min-h-[36px]"
              title="Return to Conversations List"
              aria-label="Return to Conversations List"
              @click="closeChatScope"
            >
              <Icon name="chevron-left" :size="16" />
              <span>Back to Chats</span>
            </button>
            <div class="flex items-center gap-2 truncate">
              <div class="flex items-center gap-1.5 truncate">
                <Icon :name="activeScope ? CHAT_SCOPE_ICONS[activeScope.kind] : 'chat'" :size="14" class="text-[var(--accent-primary)]" />
                <strong class="text-xs text-[var(--text-primary)] truncate">{{ activeScope?.label ?? activeChatChannel }}</strong>
                <span v-if="activeScope" class="text-[9px] uppercase tracking-wider text-[var(--text-muted)] shrink-0">{{ activeScope.kindLabel }}</span>
              </div>
              <Button
                variant="secondary"
                size="icon"
                title="Conversation Information"
                aria-label="Conversation Information"
                class="chat-info-btn h-7 w-7 shrink-0"
                @click="isChatInfoOpen = true"
              >
                <Icon name="info" :size="13" />
              </Button>
            </div>
          </div>

          <!-- Standard Channel Header (Always visible on Desktop) -->
          <div class="hidden md:flex px-4 py-3 border-b border-[var(--border-subtle)] items-center justify-between bg-[var(--bg-surface)]">
            <div class="flex items-center gap-2">
              <Icon :name="activeScope ? CHAT_SCOPE_ICONS[activeScope.kind] : 'chat'" :size="16" class="text-[var(--accent-primary)]" />
              <strong class="text-xs font-bold text-[var(--text-primary)]">{{ activeScope?.label ?? activeChatChannel }}</strong>
              <span v-if="activeScope" class="text-[10px] text-[var(--text-muted)]">{{ activeScope.kindLabel }}</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary">3 Members Online</Badge>
              <Button
                variant="secondary"
                size="icon"
                title="Conversation Information & Routing Policy"
                aria-label="Conversation Information & Routing Policy"
                class="chat-info-btn h-7 w-7"
                @click="isChatInfoOpen = true"
              >
                <Icon name="info" :size="14" />
              </Button>
            </div>
          </div>

          <!-- Messages Scroll Area -->
          <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            <div
              v-for="msg in chatMessages"
              :key="msg.id"
              :data-message-id="msg.id"
              class="flex items-start gap-3"
            >
              <div class="w-8 h-8 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-xs shrink-0">
                {{ msg.author[0] }}
              </div>
              <div class="flex flex-col gap-1 min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <strong class="text-xs font-bold text-[var(--text-primary)]">@{{ msg.author }}</strong>
                  <span class="text-[10px] text-[var(--text-muted)]">{{ msg.role }}</span>
                  <span class="text-[10px] text-[var(--text-muted)] ml-auto font-mono">{{ msg.time }}</span>
                </div>
                <div class="p-3 rounded-lg bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] leading-relaxed">
                  {{ msg.content }}
                </div>
              </div>
            </div>
          </div>

          <!-- Composer Bar -->
          <div class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center gap-2">
            <input
              v-model="newMessage"
              type="text"
              :placeholder="`Send message to ${activeChatChannel} (@mention supported)...`"
              class="flex-1 px-3 py-2 text-xs rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)]"
              @keydown.enter="sendMessage"
            />
            <Button variant="primary" size="sm" @click="sendMessage">
              Send
            </Button>
          </div>
        </div>
        </template>
      </div>
    </div>

    <!-- 1. Project Information & Metadata Modal -->
    <Dialog
      :open="isProjectInfoOpen"
      :title="`${currentProject.name} — Information & Metadata`"
      description="Project Identity, Workspace Bindings, and Agreement Policy"
      @update:open="isProjectInfoOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <strong class="text-sm font-bold text-[var(--text-primary)]">{{ currentProject.name }}</strong>
            <Badge variant="success">{{ currentProject.status }}</Badge>
          </div>
          <span class="font-mono text-[11px] text-[var(--text-muted)]">ID: <code>{{ currentProject.id }}</code></span>
          <p class="text-xs text-[var(--text-primary)] mt-1">{{ currentProject.desc }}</p>
        </div>

        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-2">
          <strong class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Bound Host Workspaces ({{ boundWorkspaces.length }})</strong>
          <div class="flex flex-col gap-1.5">
            <div
              v-for="ws in boundWorkspaces"
              :key="ws.root"
              class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11px]"
            >
              <span class="font-mono font-bold text-[var(--text-primary)]">{{ ws.root }}</span>
              <span class="text-[var(--text-muted)]">{{ ws.host }}</span>
            </div>
          </div>
        </div>

        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5">
          <strong class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Wake Routing Policy</strong>
          <p class="text-[var(--text-primary)]">Strict multi-agent boundaries: all worker turns must record verifiable evidence before advancing task lifecycle.</p>
        </div>
      </div>

      <template #footer>
        <Button variant="primary" size="sm" class="close-project-info-btn" @click="isProjectInfoOpen = false">
          Close
        </Button>
      </template>
    </Dialog>

    <!-- 2. Create New Project Modal -->
    <Dialog
      :open="isNewProjectOpen"
      title="Create New Project Workspace"
      description="Define a new multi-agent project workspace with agreement rules and bound environments."
      @update:open="isNewProjectOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="flex flex-col gap-1">
          <label for="new-proj-name" class="font-bold text-[var(--text-primary)]">Project Name *</label>
          <input
            id="new-proj-name"
            v-model="newProjName"
            type="text"
            placeholder="e.g. Distributed Analytics Service"
            class="px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="new-proj-desc" class="font-bold text-[var(--text-primary)]">Purpose & Scope</label>
          <input
            id="new-proj-desc"
            v-model="newProjDesc"
            type="text"
            placeholder="e.g. Real-time telemetry ingestion and multi-node coordination pipeline"
            class="px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="new-proj-policy" class="font-bold text-[var(--text-primary)]">Wake Policy</label>
          <select
            id="new-proj-policy"
            v-model="newProjPolicy"
            class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
          >
            <option value="explicit-only">Explicit Mentions Only</option>
            <option value="wake-model-assisted">Wake-Model Assisted (30s window)</option>
          </select>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" class="cancel-new-project-btn" @click="isNewProjectOpen = false">
          Cancel
        </Button>
        <Button variant="primary" size="sm" :disabled="!newProjName.trim()" @click="handleCreateProject">
          Create Project
        </Button>
      </template>
    </Dialog>

    <!-- 3. Propose Task Modal -->
    <Dialog
      :open="isProposeTaskOpen"
      title="Propose Project Task"
      description="Propose a new task to be assigned and approved by Human authority before execution."
      @update:open="isProposeTaskOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="flex flex-col gap-1">
          <label for="new-task-title" class="font-bold text-[var(--text-primary)]">Task Title *</label>
          <input
            id="new-task-title"
            v-model="newProposalTitle"
            type="text"
            placeholder="e.g. Setup Carrier Heartbeat Health Probe"
            class="px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="new-task-goal" class="font-bold text-[var(--text-primary)]">Task Goal & Specification</label>
          <textarea
            id="new-task-goal"
            v-model="newProposalGoal"
            rows="3"
            placeholder="Detailed description of objective, constraints, and success criteria..."
            class="px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
          ></textarea>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div class="flex flex-col gap-1">
            <label for="new-task-lead" class="font-bold text-[var(--text-primary)]">Lead Agent</label>
            <select
              id="new-task-lead"
              v-model="newProposalLead"
              class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
            >
              <option v-for="m in projectMembers" :key="m.id" :value="m.name">@{{ m.name }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="new-task-host" class="font-bold text-[var(--text-primary)]">Target Host</label>
            <select
              id="new-task-host"
              v-model="newProposalHost"
              class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
            >
              <option value="Mac Studio M2 Max">Mac Studio M2 Max</option>
              <option value="Windows Workstation 01">Windows Workstation 01</option>
              <option value="Local Worker">Local Worker</option>
            </select>
          </div>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" @click="isProposeTaskOpen = false">
          Cancel
        </Button>
        <Button variant="primary" size="sm" :disabled="!newProposalTitle.trim()" @click="handleProposeTask">
          Submit Proposal
        </Button>
      </template>
    </Dialog>

    <!-- 4. Conversation Information Modal -->
    <Dialog
      :open="isChatInfoOpen"
      :title="`Conversation Details — ${activeChatChannel}`"
      description="Channel Membership, Routing Policy, and Delivery Guarantees"
      @update:open="isChatInfoOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <strong class="text-sm font-bold text-[var(--text-primary)]">{{ activeChatChannel }}</strong>
            <Badge variant="info">{{ activeChatChannel.startsWith('@') ? 'Direct Message' : activeChatChannel.startsWith('wg-') ? 'Working Group' : 'Project Channel' }}</Badge>
          </div>
          <span class="text-[11px] text-[var(--text-muted)]">Project: <code>{{ currentProject.name }}</code></span>
          <p class="text-xs text-[var(--text-primary)] mt-0.5">
            {{ activeChatChannel === '#general' ? 'Main broadcast channel for all project agents and human operators.' : activeChatChannel.startsWith('wg-') ? 'Focused working group collaboration stream.' : 'Direct 1-on-1 agent conversation.' }}
          </p>
        </div>

        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-2">
          <strong class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Active Participants</strong>
          <div class="flex items-center gap-2 flex-wrap">
            <span v-for="m in projectMembers" :key="m.id" class="px-2 py-1 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11px] font-semibold text-[var(--text-primary)]">
              @{{ m.name }}
            </span>
          </div>
        </div>

        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5">
          <strong class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Routing & Delivery Semantics</strong>
          <p class="text-[var(--text-secondary)]">Mentions strictly wake declared recipients. Unaddressed messages follow project wake policy. All messages are durably recorded in SQLite.</p>
        </div>
      </div>

      <template #footer>
        <Button variant="primary" size="sm" class="close-chat-info-btn" @click="isChatInfoOpen = false">
          Close
        </Button>
      </template>
    </Dialog>
    <Dialog
      v-if="false"
      :open="false"
      title=""
      @update:open="() => {}"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="font-bold text-[var(--text-primary)]">Execution Lifecycle</span>
            <Badge :variant="selectedTask.stageVariant ?? 'info'">{{ selectedTask.stage.toUpperCase() }}</Badge>
          </div>
          <p class="text-[var(--text-primary)] font-mono text-[11px]">{{ selectedTask.lifecycleSentence }}</p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Lead Agent</span>
            <strong class="text-[var(--text-primary)]">@{{ selectedTask.lead }}</strong>
          </div>
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Assigned Host</span>
            <strong class="text-[var(--text-primary)]">{{ selectedTask.host }}</strong>
          </div>
        </div>

        <div class="p-3 rounded bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] flex flex-col gap-1">
          <strong class="text-xs font-bold flex items-center gap-1.5">
            <Icon name="shield" :size="14" />
            <span>Task-Held Exclusive Lease Active</span>
          </strong>
          <p class="text-[11px] text-[var(--text-secondary)]">
            Lease is held continuously across runs, human validation, and pauses. No automatic timeout.
          </p>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" @click="() => {}">
          Close
        </Button>
        <Button variant="primary" size="sm" @click="navigateToEnvironments">
          <Icon name="environments" :size="13" />
          <span>Inspect Host Environment</span>
        </Button>
      </template>
    </Dialog>

    <!-- Agent Member Detail Modal -->
    <Dialog
      v-if="selectedMember"
      :open="isMemberDetailOpen"
      :title="`@${selectedMember.name} — ${selectedMember.role}`"
      description="Active Project Member & Worker Persona"
      @update:open="isMemberDetailOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="flex items-center gap-3 p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
          <div class="w-10 h-10 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-sm">
            {{ selectedMember.name[0] }}
          </div>
          <div>
            <strong class="text-sm text-[var(--text-primary)] block">@{{ selectedMember.name }}</strong>
            <span class="text-xs text-[var(--text-muted)]">{{ selectedMember.role }} · <span class="font-mono">{{ selectedMember.engine }}</span></span>
          </div>
        </div>

        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5">
          <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Membership Responsibilities</span>
          <p class="text-[var(--text-primary)]">
            Assigned to collaborate in project channels, accept task assignments, and execute runs on authorized host environments.
          </p>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" @click="isMemberDetailOpen = false">
          Close
        </Button>
        <Button variant="primary" size="sm" @click="navigateToAgentsView">
          <Icon name="agents" :size="13" />
          <span>Manage Agent Personas</span>
        </Button>
      </template>
    </Dialog>
  </div>
</template>
