<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.ts';
import Icon from '../primitives/Icon.vue';

const router = useRouter();
const appStore = useAppStore();

const activeScope = ref('all');
const activeUrgency = ref<'all' | 'action_required' | 'attention' | 'info'>('all');
const activeActivityFilter = ref<'all' | 'tasks' | 'messages' | 'envs' | 'usage'>('all');

interface AttentionItem {
  id: string;
  severity: 'action_required' | 'attention' | 'info';
  category: string;
  categoryName: string;
  icon: string;
  title: string;
  projectName?: string;
  summary: string;
  lifecycleSentence: string;
  attribution: string;
  timestamp: string;
  targetPath: string;
}

const attentionItems = ref<AttentionItem[]>([
  {
    id: 'att-1',
    severity: 'action_required',
    category: 'task_recovery',
    categoryName: 'Lease Recovery',
    icon: 'alert',
    title: 'Windows Workstation 01 Offline · Lease Recovery Required',
    projectName: 'Sprout M2 Operator',
    summary: 'Carrier channel disconnected mid-turn during active Task #104 execution. Task lease locked in recovery.',
    lifecycleSentence: 'Task #104 · Run #206 interrupted · Lease locked in recovery',
    attribution: 'Host Worker daemon',
    timestamp: '14m ago',
    targetPath: '/manage/environments/env-recovery',
  },
  {
    id: 'att-2',
    severity: 'action_required',
    category: 'env_unhealthy',
    categoryName: 'Worker Health',
    icon: 'warning',
    title: 'Protocol Version Incompatible: Legacy Mac mini',
    projectName: 'Sprout M2 Operator',
    summary: 'Worker reports protocol v1.8 which is below the minimum required v2.0+. Automatic work admission refused.',
    lifecycleSentence: 'Enrollment approved · Protocol mismatch v1.8 < v2.0+ · Admission barred',
    attribution: 'System Overseer',
    timestamp: '1m ago',
    targetPath: '/manage/environments/env-incompatible',
  },
  {
    id: 'att-3',
    severity: 'attention',
    category: 'env_enrollment',
    categoryName: 'Worker Enrollment',
    icon: 'check',
    title: 'Pending Host Enrollment: MacBook Pro Operator Local',
    projectName: 'Sprout M2 Operator',
    summary: 'New worker instance requested enrollment over private transport. Operator approval required before admitting work.',
    lifecycleSentence: 'Identity verified · Capabilities declared · Awaiting operator approval',
    attribution: 'Bootstrap Service',
    timestamp: 'just now',
    targetPath: '/manage/environments/env-pending',
  },
  {
    id: 'att-4',
    severity: 'attention',
    category: 'env_unhealthy',
    categoryName: 'Worker Health',
    icon: 'server',
    title: 'Linux Container Node Engine Degraded: Codex Login Required',
    projectName: 'Sprout M2 Operator',
    summary: 'Codex engine CLI token has expired on container host. Pi and OpenCode engines remain operational.',
    lifecycleSentence: 'Carrier online · 3 of 4 engines ready · Codex authentication degraded',
    attribution: 'Health Monitor',
    timestamp: '45s ago',
    targetPath: '/manage/environments/env-degraded',
  },
  {
    id: 'att-5',
    severity: 'info',
    category: 'task_active',
    categoryName: 'Active Lease',
    icon: 'shield',
    title: 'Active Task-Held Lease on Mac Studio M2 Max',
    projectName: 'Sprout M2 Operator',
    summary: 'Task #101 holds exclusive lease across multi-run execution. Running lead @Programmer.',
    lifecycleSentence: 'Task #101 active · Run running · Lease held continuously (ADR-0005)',
    attribution: '@Programmer',
    timestamp: '10s ago',
    targetPath: '/manage/environments/env-ready',
  },
]);

const activeTasks = ref([
  {
    id: '101',
    projectName: 'Sprout M2 Operator',
    title: 'Refactor Environment State Manager into Decoupled Seams',
    lead: 'Programmer',
    environment: 'Mac Studio M2 Max',
    engine: 'Pi (gemini-2.5-pro)',
    goal: 'Establish typed remote-state ports and replace mutable StateManager with clean Vue modules.',
    targetPath: '/manage/environments/env-ready',
  },
  {
    id: '104',
    projectName: 'Sprout M2 Operator',
    title: 'Multi-Agent Simulation Validation & Host Porting',
    lead: 'Architect',
    environment: 'Windows Workstation 01',
    engine: 'Codex (gpt-5-codex)',
    goal: 'Validate host-local carrier disconnect, reconnect and 3-gate emergency Force Release.',
    targetPath: '/manage/environments/env-recovery',
  },
  {
    id: '107',
    projectName: 'o7 Minesweeper',
    title: 'Validate Reka UI Headless Accessible Overlays & Focus Trap',
    lead: 'Foreman',
    environment: 'Local Worker',
    engine: 'Pi (claude-3-7-sonnet)',
    goal: 'Prove keyboard focus trap, initial focus, and escape dismissal in dialogs.',
    targetPath: '/manage/environments',
  },
]);

const activities = ref([
  {
    id: 'act-1',
    kind: 'envs',
    badgeKind: 'green',
    title: 'Readiness probe passed on Mac Studio M2 Max',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Carrier probe confirmed protocol v2.1 & all 4 engines ready (14ms latency).',
    relativeTime: 'just now',
    timestamp: '10:14:00',
    targetPath: '/manage/environments/env-ready',
  },
  {
    id: 'act-2',
    kind: 'messages',
    badgeKind: 'blue',
    title: '@Programmer sent message to #general',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Verified Reka UI AlertDialog focus trap and escape dismissal.',
    relativeTime: '2m ago',
    timestamp: '10:12:00',
    targetPath: '/project',
  },
  {
    id: 'act-3',
    kind: 'envs',
    badgeKind: 'red',
    title: 'Windows Workstation 01 carrier disconnected',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Carrier heartbeat lost; task-held lease #104 automatically locked in recovery.',
    relativeTime: '14m ago',
    timestamp: '10:00:00',
    targetPath: '/manage/environments/env-recovery',
  },
  {
    id: 'act-4',
    kind: 'tasks',
    badgeKind: 'purple',
    title: 'Task #101 acquired exclusive lease',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Acquired exclusive lease on Mac Studio M2 Max under ADR-0005 guarantee.',
    relativeTime: '18m ago',
    timestamp: '09:56:00',
    targetPath: '/manage/environments/env-ready',
  },
  {
    id: 'act-5',
    kind: 'usage',
    badgeKind: 'yellow',
    title: 'Usage telemetry milestone: 1.14M tokens recorded',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Work-model runs (1.10M tokens) and Project routing attempts (42.6K tokens) tracked separately.',
    relativeTime: '25m ago',
    timestamp: '09:49:00',
    targetPath: '/manage/usage',
  },
]);

const filteredAttentionItems = computed(() => {
  let list = attentionItems.value;
  if (activeScope.value !== 'all') {
    if (activeScope.value === 'sprout-m2') {
      list = list.filter((i) => i.projectName === 'Sprout M2 Operator');
    } else if (activeScope.value === 'infra') {
      list = list.filter((i) => i.category.startsWith('env_'));
    }
  }
  if (activeUrgency.value === 'action_required') {
    return list.filter((i) => i.severity === 'action_required');
  }
  if (activeUrgency.value === 'attention') {
    return list.filter((i) => i.severity === 'attention');
  }
  if (activeUrgency.value === 'info') {
    return list.filter((i) => i.severity === 'info');
  }
  return list;
});

const actionRequiredCount = computed(
  () => attentionItems.value.filter((i) => i.severity === 'action_required').length
);
const attentionCount = computed(
  () => attentionItems.value.filter((i) => i.severity === 'attention').length
);
const infoCount = computed(
  () => attentionItems.value.filter((i) => i.severity === 'info').length
);

const filteredActivities = computed(() => {
  if (activeActivityFilter.value === 'all') return activities.value;
  return activities.value.filter((a) => a.kind === activeActivityFilter.value);
});

function handleNavigate(path: string) {
  appStore.setReturnContext({
    title: 'Back to Feed',
    to: '/feed',
  });
  router.push(path);
}
</script>

<template>
  <div class="view-container feed-view p-4 sm:p-6 max-w-6xl mx-auto flex flex-col gap-6">
    <!-- 1. Top Header -->
    <div class="view-header feed-header">
      <div class="view-header-title flex items-center justify-between gap-3 flex-wrap">
        <h2 class="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Icon name="feed" :size="20" />
          <span>Operations Feed & Human Attention</span>
        </h2>
        <span class="badge badge-info">Cross-Project Landing Surface</span>
      </div>
      <p class="text-xs text-[var(--text-secondary)] mt-1">
        Central surface for cross-project discovery, urgent Human interventions, active work telemetry, and background collaboration history.
      </p>

      <!-- Top Scope Selector Dropdown -->
      <div class="feed-scope-filter-bar mt-3">
        <div class="feed-scope-inner flex items-center gap-2 p-2 rounded-[var(--radius-sm)] bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] w-fit">
          <span class="feed-scope-icon text-[var(--text-secondary)]">
            <Icon name="project" :size="16" />
          </span>
          <label for="feed-scope-select" class="text-xs text-[var(--text-muted)] font-semibold">Scope:</label>
          <select
            id="feed-scope-select"
            v-model="activeScope"
            class="form-select feed-scope-select bg-transparent text-xs text-[var(--text-primary)] font-medium border-0 cursor-pointer focus:ring-0"
            aria-label="Select Project Scope"
          >
            <option value="all">All Projects (Sprout Workspace)</option>
            <option value="sprout-m2">Sprout M2 Operator</option>
            <option value="infra">Infrastructure & Hosts</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 2. Section 1: Prominent Human Attention Section -->
    <section class="feed-section attention-section flex flex-col gap-3">
      <div class="section-title-bar flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2">
          <Icon name="alert" :size="18" class="text-[var(--yellow-attention)]" />
          <h3 class="text-sm font-bold text-[var(--text-primary)]">Human Attention Required</h3>
          <span class="badge badge-red font-bold">{{ actionRequiredCount }} Action</span>
        </div>
        <span class="text-[11px] text-[var(--text-muted)]">Discovery only; mutations happen on authoritative pages</span>
      </div>

      <!-- 4 Streamlined Urgency Pills -->
      <div class="urgency-pills flex items-center gap-1.5 overflow-x-auto py-1" role="group" aria-label="Filter attention items">
        <button
          type="button"
          class="urgency-pill-btn flex-1 min-w-[75px]"
          :class="activeUrgency === 'all' ? 'active' : ''"
          :aria-pressed="activeUrgency === 'all'"
          title="All Attention Items"
          @click="activeUrgency = 'all'"
        >
          <span class="urgency-pill-top"><span class="status-dot purple"></span> {{ attentionItems.length }}</span>
          <span class="urgency-pill-bottom">All</span>
        </button>
        <button
          type="button"
          class="urgency-pill-btn flex-1 min-w-[75px]"
          :class="activeUrgency === 'action_required' ? 'active' : ''"
          :aria-pressed="activeUrgency === 'action_required'"
          title="Action Required"
          @click="activeUrgency = 'action_required'"
        >
          <span class="urgency-pill-top"><span class="status-dot red"></span> {{ actionRequiredCount }}</span>
          <span class="urgency-pill-bottom">Action Required</span>
        </button>
        <button
          type="button"
          class="urgency-pill-btn flex-1 min-w-[75px]"
          :class="activeUrgency === 'attention' ? 'active' : ''"
          :aria-pressed="activeUrgency === 'attention'"
          title="Attention Needed"
          @click="activeUrgency = 'attention'"
        >
          <span class="urgency-pill-top"><span class="status-dot yellow"></span> {{ attentionCount }}</span>
          <span class="urgency-pill-bottom">Attention</span>
        </button>
        <button
          type="button"
          class="urgency-pill-btn flex-1 min-w-[75px]"
          :class="activeUrgency === 'info' ? 'active' : ''"
          :aria-pressed="activeUrgency === 'info'"
          title="Informational Items"
          @click="activeUrgency = 'info'"
        >
          <span class="urgency-pill-top"><span class="status-dot blue"></span> {{ infoCount }}</span>
          <span class="urgency-pill-bottom">Info</span>
        </button>
      </div>

      <!-- Attention Cards List -->
      <div class="attention-cards-container grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          v-for="item in filteredAttentionItems"
          :key="item.id"
          type="button"
          class="attention-card text-left p-4 rounded-[var(--radius-md)] border bg-[var(--bg-surface)] flex flex-col justify-between gap-3 shadow-xs transition-all cursor-pointer select-none"
          :class="item.severity === 'action_required' ? 'severity-action-required border-l-4 border-l-[var(--red-action)]' : item.severity === 'attention' ? 'severity-attention border-l-4 border-l-[var(--yellow-attention)]' : 'severity-info border-l-4 border-l-[var(--purple-agent)]'"
          @click="handleNavigate(item.targetPath)"
        >
          <div class="w-full">
            <div class="attention-card-header flex items-center justify-between gap-2 mb-2">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="category-icon-pill flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]">
                  <Icon :name="item.icon" :size="12" />
                  <span>{{ item.categoryName }}</span>
                </span>
                <span v-if="item.projectName" class="badge badge-info text-[10px]">{{ item.projectName }}</span>
              </div>
              <span class="status-dot" :class="item.severity === 'action_required' ? 'red' : item.severity === 'attention' ? 'yellow' : 'blue'"></span>
            </div>

            <strong class="text-xs sm:text-sm font-bold text-[var(--text-primary)] leading-tight block mb-1">
              {{ item.title }}
            </strong>
            <div class="lifecycle-sentence text-[11px] font-mono text-[var(--text-muted)] mb-2">
              {{ item.lifecycleSentence }}
            </div>
            <p class="attention-card-summary text-xs text-[var(--text-secondary)] leading-relaxed">
              {{ item.summary }}
            </p>
          </div>

          <div class="attention-card-footer pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 w-full text-[11px] text-[var(--text-muted)]">
            <div class="flex items-center gap-1.5 font-mono text-[10px]">
              <span>{{ item.attribution }}</span>
              <span>•</span>
              <span>{{ item.timestamp }}</span>
            </div>
            <span class="text-xs font-semibold text-[var(--accent-primary)] hover:underline flex items-center gap-1">
              Inspect in Manage / Environments →
            </span>
          </div>
        </button>
      </div>
    </section>

    <!-- 3. Section 2: Live In-Flight Work -->
    <section class="feed-section active-work-section flex flex-col gap-3">
      <div class="section-title-bar flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2">
          <Icon name="tasks" :size="18" />
          <h3 class="text-sm font-bold text-[var(--text-primary)]">Live In-Flight Work</h3>
          <span class="badge badge-info">{{ activeTasks.length }} Active</span>
        </div>
        <span class="text-[11px] text-[var(--text-muted)]">Active Task leases held under ADR-0005</span>
      </div>

      <div class="active-tasks-grid grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          v-for="task in activeTasks"
          :key="task.id"
          type="button"
          class="card active-task-card text-left p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-3 shadow-xs cursor-pointer select-none hover:border-[var(--border-strong)] transition-all"
          @click="handleNavigate(task.targetPath)"
        >
          <div>
            <div class="flex items-start justify-between gap-2 mb-2">
              <div>
                <div class="flex items-center gap-1.5 flex-wrap mb-1">
                  <span class="badge badge-info text-[10px]">{{ task.projectName }}</span>
                  <span class="status-pill purple text-[10px]">Task active · Run running · Lease held</span>
                </div>
                <h4 class="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                  #{{ task.id }}: {{ task.title }}
                </h4>
              </div>
              <span class="status-dot pulsing blue shrink-0 mt-1" title="In Progress"></span>
            </div>

            <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] text-xs flex flex-col gap-1 text-[var(--text-secondary)]">
              <div class="flex justify-between flex-wrap gap-1 text-[11px]">
                <span><strong>Lead:</strong> @{{ task.lead }} · <strong>Env:</strong> {{ task.environment }}</span>
                <span class="font-mono">{{ task.engine }}</span>
              </div>
              <div class="text-[10px] text-[var(--text-muted)] mt-0.5 line-clamp-2">
                Goal: {{ task.goal }}
              </div>
            </div>
          </div>

          <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-end text-xs font-semibold text-[var(--accent-primary)]">
            <span>View Environment Lease →</span>
          </div>
        </button>
      </div>
    </section>

    <!-- 4. Section 3: Recent Operational Activity Stream -->
    <section class="feed-section activity-section flex flex-col gap-3">
      <div class="section-title-bar flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2">
          <Icon name="lightning" :size="18" />
          <h3 class="text-sm font-bold text-[var(--text-primary)]">Recent Operational Activity</h3>
          <span class="badge badge-info">{{ activities.length }} Total</span>
        </div>
        <span class="text-[11px] text-[var(--text-muted)]">Audit log scoped to project</span>
      </div>

      <!-- 5 Streamlined Activity Filter Pills -->
      <div class="activity-filter-pills flex items-center gap-1.5 overflow-x-auto py-1" role="group" aria-label="Filter activity stream">
        <button
          type="button"
          class="activity-filter-pill-btn flex-1 min-w-[65px]"
          :class="activeActivityFilter === 'all' ? 'active' : ''"
          :aria-pressed="activeActivityFilter === 'all'"
          @click="activeActivityFilter = 'all'"
        >
          <span class="urgency-pill-top"><span class="status-dot purple"></span> {{ activities.length }}</span>
          <span class="urgency-pill-bottom">All</span>
        </button>
        <button
          type="button"
          class="activity-filter-pill-btn flex-1 min-w-[65px]"
          :class="activeActivityFilter === 'tasks' ? 'active' : ''"
          :aria-pressed="activeActivityFilter === 'tasks'"
          @click="activeActivityFilter = 'tasks'"
        >
          <span class="urgency-pill-top"><span class="status-dot blue"></span> 1</span>
          <span class="urgency-pill-bottom">Tasks</span>
        </button>
        <button
          type="button"
          class="activity-filter-pill-btn flex-1 min-w-[65px]"
          :class="activeActivityFilter === 'messages' ? 'active' : ''"
          :aria-pressed="activeActivityFilter === 'messages'"
          @click="activeActivityFilter = 'messages'"
        >
          <span class="urgency-pill-top"><span class="status-dot green"></span> 1</span>
          <span class="urgency-pill-bottom">Chat</span>
        </button>
        <button
          type="button"
          class="activity-filter-pill-btn flex-1 min-w-[65px]"
          :class="activeActivityFilter === 'envs' ? 'active' : ''"
          :aria-pressed="activeActivityFilter === 'envs'"
          @click="activeActivityFilter = 'envs'"
        >
          <span class="urgency-pill-top"><span class="status-dot yellow"></span> 2</span>
          <span class="urgency-pill-bottom">Envs</span>
        </button>
        <button
          type="button"
          class="activity-filter-pill-btn flex-1 min-w-[65px]"
          :class="activeActivityFilter === 'usage' ? 'active' : ''"
          :aria-pressed="activeActivityFilter === 'usage'"
          @click="activeActivityFilter = 'usage'"
        >
          <span class="urgency-pill-top"><span class="status-dot neutral"></span> 1</span>
          <span class="urgency-pill-bottom">Usage</span>
        </button>
      </div>

      <!-- Activity List Items -->
      <div class="card p-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1">
        <button
          v-for="act in filteredActivities"
          :key="act.id"
          type="button"
          class="list-item list-item-interactive activity-feed-row text-left p-3 rounded flex items-center justify-between gap-3 hover:bg-[var(--bg-surface-elevated)] transition-colors cursor-pointer select-none"
          @click="handleNavigate(act.targetPath)"
        >
          <div class="list-item-leading flex items-center shrink-0">
            <span class="status-dot" :class="act.badgeKind"></span>
          </div>

          <div class="list-item-body flex-1 min-w-0">
            <div class="list-item-title flex items-center gap-1.5 flex-wrap">
              <strong class="text-xs text-[var(--text-primary)]">{{ act.title }}</strong>
              <span class="badge badge-info text-[9px]">{{ act.projectName }}</span>
            </div>
            <div class="list-item-subtitle text-[11px] text-[var(--text-secondary)] truncate mt-0.5">
              {{ act.subtitle }}
            </div>
          </div>

          <div class="list-item-trailing flex items-center gap-2 shrink-0">
            <span class="provenance-tag time text-[10px] text-[var(--text-muted)] font-mono">{{ act.relativeTime }}</span>
            <Icon name="chevron-right" :size="14" class="text-[var(--text-muted)]" />
          </div>
        </button>
      </div>
    </section>
  </div>
</template>
