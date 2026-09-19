<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import Dialog from '../primitives/Dialog.vue';

const route = useRoute();
const router = useRouter();

const selectedProjectId = ref('sprout-m2');
const activeTab = ref<'overview' | 'tasks' | 'chat'>('overview');
const activeChatChannel = ref('#general');
const isMobileChatDetailOpen = ref(false);

const selectedTask = ref<any>(null);
const isTaskDetailOpen = ref(false);
const activeTaskFilter = ref('all');
const taskViewMode = ref<'list' | 'detail'>('list');
const isLifecycleFoldExpanded = ref(true);

function openTaskDetail(task: any) {
  selectedTask.value = task;
  taskViewMode.value = 'detail';
}

function closeTaskDetail() {
  taskViewMode.value = 'list';
}

const selectedMember = ref<any>(null);
const isMemberDetailOpen = ref(false);

function openMemberDetail(member: any) {
  selectedMember.value = member;
  isMemberDetailOpen.value = true;
}

function navigateToTaskEnv() {
  isTaskDetailOpen.value = false;
  router.push('/manage/environments/env-ready');
}

function navigateToAgentsView() {
  isMemberDetailOpen.value = false;
  router.push('/manage/agents');
}

function syncTabFromRoute() {
  const tabParam = route.params.tab as string | undefined;
  if (tabParam === 'tasks' || tabParam === 'chat' || tabParam === 'overview') {
    activeTab.value = tabParam;
  } else if (route.path.endsWith('/tasks')) {
    activeTab.value = 'tasks';
  } else if (route.path.endsWith('/chat')) {
    activeTab.value = 'chat';
  } else {
    activeTab.value = 'overview';
  }
  if (activeTab.value !== 'chat') {
    isMobileChatDetailOpen.value = false;
  }
}

onMounted(() => {
  syncTabFromRoute();
});

watch(
  () => route.path,
  () => {
    syncTabFromRoute();
  }
);

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

const tasks = [
  {
    id: '101',
    title: 'Continuous Integration & Host Verification Pipeline',
    stage: 'Validation',
    stageVariant: 'warning' as const,
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
    stageVariant: 'danger' as const,
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
    runs: [
      { id: 'run-206', agent: 'Architect', engine: 'Codex', model: 'gpt-5-codex', duration: '5m 12s', tokens: '145,000', status: 'Interrupted' },
    ],
  },
  {
    id: '107',
    title: 'Accessibility Verification & Operator Surface Diagnostics',
    stage: 'Active',
    stageVariant: 'success' as const,
    lead: 'Foreman',
    host: 'Local Worker',
    version: 'v3',
    lifecycleSentence: 'Task active · Agent running · Lease held (Local Worker)',
    agentRunLifecycle: 'running',
    leaseLifecycle: 'held',
    goal: 'Verify operator control accessibility, focus trapping, Escape dismissal, and screen-reader semantics.',
    constraints: [
      'Follow Reka UI accessibility primitives for overlay focus trapping.',
      'Ensure keyboard and mobile touch event parity.',
    ],
    validationCriteria: [
      'All 14 production DOM tests pass including keyboard and touch assertion suites.',
    ],
    runs: [
      { id: 'run-208', agent: 'Foreman', engine: 'Pi', model: 'claude-3-7-sonnet', duration: '3m 45s', tokens: '89,400', status: 'Running' },
    ],
  },
  {
    id: '110',
    title: 'Multi-Platform Host Configuration & Capability Profiling',
    stage: 'Proposed',
    stageVariant: 'secondary' as const,
    lead: 'Researcher',
    host: 'Unassigned',
    version: 'v1',
    lifecycleSentence: 'Task proposed · Executes NO run · Holds NO lease',
    agentRunLifecycle: 'none',
    leaseLifecycle: 'clear',
    goal: 'Profile host engine readiness and granular capability permissions across macOS, Windows, and container platforms.',
    constraints: [
      'Proposals execute zero runs and hold no host leases until explicit Human Begin authority.',
    ],
    validationCriteria: [
      'Capability matrix matches host security profiles.',
    ],
    runs: [],
  },
  {
    id: '98',
    title: 'Durable Transactional Persistence & Event Store Verification',
    stage: 'Completed',
    stageVariant: 'info' as const,
    lead: 'Architect',
    host: 'Mac Studio M2 Max',
    version: 'v4',
    lifecycleSentence: 'Task completed · All verification runs green · Released lease',
    agentRunLifecycle: 'completed',
    leaseLifecycle: 'clear',
    goal: 'Verify SQLite ACID transactional consistency across multi-agent turns and worker lease transitions.',
    constraints: [
      'Atomic transactions for lease acquisition and release.',
    ],
    validationCriteria: [
      'WAL mode enabled and verification suite passes cleanly.',
    ],
    runs: [
      { id: 'run-198', agent: 'Architect', engine: 'Codex', model: 'gpt-5-codex', duration: '22m 10s', tokens: '580,200', status: 'Completed' },
    ],
  },
];

const filteredTasks = computed(() => {
  if (activeTaskFilter.value === 'all') return tasks;
  return tasks.filter((t) => t.stage === activeTaskFilter.value);
});

interface ChatScope {
  id: string;
  label: string;
  kind: 'channel' | 'working-group' | 'dm';
  lastSnippet: string;
  lastTime: string;
  unread: number;
}

const chatScopes = ref<ChatScope[]>([
  {
    id: '#general',
    label: '#general',
    kind: 'channel',
    lastSnippet: 'All 8 Reka UI accessible dialog checks pass...',
    lastTime: '10:11 AM',
    unread: 0,
  },
  {
    id: 'wg-frontend',
    label: 'wg-frontend',
    kind: 'working-group',
    lastSnippet: 'Vue 3.5 + Tailwind 4 responsive chat layout...',
    lastTime: '10:05 AM',
    unread: 1,
  },
  {
    id: 'wg-core',
    label: 'wg-core',
    kind: 'working-group',
    lastSnippet: 'Carrier TLS stream reconnect latency ~14ms...',
    lastTime: '09:48 AM',
    unread: 0,
  },
  {
    id: '@Programmer',
    label: '@Programmer',
    kind: 'dm',
    lastSnippet: 'Verified worker ports and host daemon checks.',
    lastTime: '10:08 AM',
    unread: 0,
  },
  {
    id: '@Architect',
    label: '@Architect',
    kind: 'dm',
    lastSnippet: 'Production workspace baseline confirmed.',
    lastTime: '10:04 AM',
    unread: 0,
  },
]);

const chatMessages = ref([
  {
    id: 'msg-1',
    author: 'Architect',
    role: 'System Architect',
    time: '10:04 AM',
    content: 'Inspecting operator services and environment readiness. Remote state stays behind EnvironmentService port.',
  },
  {
    id: 'msg-2',
    author: 'Programmer',
    role: 'Lead Implementer',
    time: '10:08 AM',
    content: 'Verified. Carrier connection stable and host daemons responsive.',
  },
  {
    id: 'msg-3',
    author: 'Foreman',
    role: 'Coordinator',
    time: '10:11 AM',
    content: 'All host security policies active. Host-local keys verified and carrier stream encrypted.',
  },
]);

const newMessage = ref('');

function selectChannel(channelId: string) {
  activeChatChannel.value = channelId;
  isMobileChatDetailOpen.value = true;
}

function sendMessage() {
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
      :class="{ 'hidden md:flex': activeTab === 'chat' && isMobileChatDetailOpen }"
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
            <Badge variant="success" class="shrink-0">Active</Badge>
          </div>
          <span class="text-[10px] sm:text-[11px] text-[var(--text-muted)] block truncate">
            {{ currentProject.desc }}
          </span>
        </div>
      </div>

      <!-- Action Buttons (Info & New Project) - strictly right-aligned, shrink-0, no wrapping on narrow screens -->
      <div class="flex items-center gap-1.5 shrink-0 ml-auto">
        <Button variant="secondary" size="icon" title="Project Information & Metadata" aria-label="Project Information & Metadata" class="h-8 w-8">
          <Icon name="info" :size="15" />
        </Button>
        <Button variant="secondary" size="icon" title="Create New Project" aria-label="Create New Project" class="h-8 w-8">
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
                <span class="text-[10px] text-[var(--accent-primary)] font-semibold">View →</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- 2. Tasks Tab (Prototype Operating Loop: List vs Dedicated Detail Drill-down) -->
      <div v-else-if="activeTab === 'tasks'" class="flex flex-col gap-4">
        <!-- 2.1 Dedicated Task Detail View (Matching prototype renderTaskDetailPage) -->
        <div v-if="taskViewMode === 'detail' && selectedTask" class="flex flex-col gap-4">
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
              <Button variant="secondary" size="sm" @click="navigateToTaskEnv">
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
              <select
                v-model="activeTaskFilter"
                class="px-2.5 py-1.5 rounded text-xs bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] cursor-pointer"
                aria-label="Filter tasks by status"
              >
                <option value="all">All Tasks ({{ tasks.length }})</option>
                <option value="Active">Active / Running</option>
                <option value="Validation">Validation Claims</option>
                <option value="Recovery">Recovery</option>
                <option value="Proposed">Proposed</option>
                <option value="Completed">Completed</option>
              </select>

              <Button variant="primary" size="sm">
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
                <span>Lead: @{{ task.lead }} · Host: {{ task.host }}</span>
                <span class="text-[var(--accent-primary)] font-semibold hover:underline">Inspect Task Details →</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- 3. Chat Tab (Responsive: Wide screen side-by-side, narrow screen drill-down with back button) -->
      <div v-else-if="activeTab === 'chat'" class="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden flex flex-col md:flex-row h-[750px] shadow-xs">
        <!-- Chat Channels Cards / List: Visible on Desktop, or on Mobile when NOT drilled down -->
        <div
          class="w-full md:w-72 lg:w-80 bg-[var(--bg-surface-elevated)] md:border-r border-[var(--border-subtle)] p-3 flex flex-col gap-2 shrink-0 overflow-y-auto"
          :class="isMobileChatDetailOpen ? 'hidden md:flex' : 'flex'"
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
              class="w-full text-left p-3 rounded-[var(--radius-sm)] border transition-all cursor-pointer select-none flex flex-col gap-1"
              :class="activeChatChannel === scope.id ? 'bg-[var(--bg-surface)] border-[var(--accent-primary)] shadow-xs ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]'"
              @click="selectChannel(scope.id)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 truncate">
                  <div class="p-1 rounded bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]">
                    <Icon :name="scope.kind === 'channel' ? 'chat' : scope.kind === 'working-group' ? 'project' : 'agents'" :size="14" />
                  </div>
                  <strong class="text-xs font-bold text-[var(--text-primary)] truncate">{{ scope.label }}</strong>
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
          :class="!isMobileChatDetailOpen ? 'hidden md:flex' : 'flex'"
        >
          <!-- Mobile-only Chat Back Header (Hidden on md+) -->
          <div class="md:hidden px-3 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-2">
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer py-1 px-2 rounded bg-[var(--accent-bg)] border border-[var(--accent-border)] min-h-[36px]"
              title="Return to Conversations List"
              aria-label="Return to Conversations List"
              @click="isMobileChatDetailOpen = false"
            >
              <Icon name="chevron-left" :size="16" />
              <span>Back to Chats</span>
            </button>
            <div class="flex items-center gap-1.5 truncate">
              <Icon name="chat" :size="14" class="text-[var(--accent-primary)]" />
              <strong class="text-xs text-[var(--text-primary)] truncate">{{ activeChatChannel }}</strong>
            </div>
          </div>

          <!-- Standard Channel Header (Always visible on Desktop) -->
          <div class="hidden md:flex px-4 py-3 border-b border-[var(--border-subtle)] items-center justify-between bg-[var(--bg-surface)]">
            <div class="flex items-center gap-2">
              <Icon name="chat" :size="16" class="text-[var(--accent-primary)]" />
              <strong class="text-xs font-bold text-[var(--text-primary)]">{{ activeChatChannel }}</strong>
              <span class="text-[10px] text-[var(--text-muted)]">Active multi-agent message timeline</span>
            </div>
            <Badge variant="secondary">3 Members Online</Badge>
          </div>

          <!-- Messages Scroll Area -->
          <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            <div
              v-for="msg in chatMessages"
              :key="msg.id"
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
      </div>
    </div>

    <!-- Task Detail Modal -->
    <Dialog
      v-if="selectedTask"
      :open="isTaskDetailOpen"
      :title="`Task #${selectedTask.id}: ${selectedTask.title}`"
      :description="`Lifecycle stage: ${selectedTask.stage} · Lead: @${selectedTask.lead}`"
      @update:open="isTaskDetailOpen = $event"
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
        <Button variant="secondary" size="sm" @click="isTaskDetailOpen = false">
          Close
        </Button>
        <Button variant="primary" size="sm" @click="navigateToTaskEnv">
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
