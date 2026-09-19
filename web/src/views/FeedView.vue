<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.ts';
import Icon from '../primitives/Icon.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';
import FilterPillGroup from '../primitives/FilterPillGroup.vue';
import FilterPill from '../primitives/FilterPill.vue';
import Dialog from '../primitives/Dialog.vue';
import Button from '../primitives/Button.vue';

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
    lifecycleSentence: 'Task #101 active · Run running · Lease held continuously',
    attribution: '@Programmer',
    timestamp: '10s ago',
    targetPath: '/manage/environments/env-ready',
  },
]);

const selectedTask = ref<any>(null);
const isTaskDetailOpen = ref(false);

function openTaskDetail(task: any) {
  selectedTask.value = task;
  isTaskDetailOpen.value = true;
}

function navigateToTaskEnv() {
  if (selectedTask.value?.targetPath) {
    const target = selectedTask.value.targetPath;
    isTaskDetailOpen.value = false;
    handleNavigate(target);
  }
}

const activeTasks = ref([
  {
    id: '101',
    projectName: 'Sprout M2 Operator',
    title: 'Continuous Integration & Host Verification Pipeline',
    lead: 'Programmer',
    environment: 'Mac Studio M2 Max',
    engine: 'Pi (gemini-2.5-pro)',
    goal: 'Establish persistent host worker pipelines and verify carrier streaming.',
    targetPath: '/manage/environments/env-ready',
  },
  {
    id: '104',
    projectName: 'Sprout M2 Operator',
    title: 'Distributed Agent Orchestration & Safety Validation',
    lead: 'Architect',
    environment: 'Windows Workstation 01',
    engine: 'Codex (gpt-5-codex)',
    goal: 'Validate carrier disconnect recovery and operator force release procedures.',
    targetPath: '/manage/environments/env-recovery',
  },
  {
    id: '107',
    projectName: 'o7 Minesweeper',
    title: 'Accessibility Verification & Operator Surface Diagnostics',
    lead: 'Foreman',
    environment: 'Local Worker',
    engine: 'Pi (claude-3-7-sonnet)',
    goal: 'Verify operator control accessibility, focus trapping, and screen-reader semantics.',
    targetPath: '/manage/environments',
  },
]);

const activities = ref([
  {
    id: 'act-1',
    kind: 'envs',
    badgeKind: 'green' as const,
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
    badgeKind: 'blue' as const,
    title: '@Programmer sent message to #general',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Verified Reka UI AlertDialog focus trap and escape dismissal.',
    relativeTime: '2m ago',
    timestamp: '10:12:00',
    targetPath: '/project/chat',
  },
  {
    id: 'act-3',
    kind: 'envs',
    badgeKind: 'red' as const,
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
    badgeKind: 'purple' as const,
    title: 'Task #101 acquired exclusive lease',
    projectName: 'Sprout M2 Operator',
    subtitle: 'Acquired exclusive lease on Mac Studio M2 Max with guaranteed exclusivity.',
    relativeTime: '18m ago',
    timestamp: '09:56:00',
    targetPath: '/manage/environments/env-ready',
  },
  {
    id: 'act-5',
    kind: 'usage',
    badgeKind: 'yellow' as const,
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
  <div class="p-4 sm:p-6 w-full max-w-[1920px] mx-auto flex flex-col gap-6">
    <!-- 1. Top Header -->
    <div class="flex flex-col gap-2 border-b border-[var(--border-subtle)] pb-4">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <h2 class="text-base sm:text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Icon name="feed" :size="20" />
          <span>Operations Feed & Human Attention</span>
        </h2>
        <Badge variant="info">Cross-Project Landing Surface</Badge>
      </div>
      <p class="text-xs text-[var(--text-secondary)]">
        Central surface for cross-project discovery, urgent Human interventions, active work telemetry, and background collaboration history.
      </p>

      <!-- Top Scope Selector Dropdown -->
      <div class="mt-1">
        <div class="inline-flex items-center gap-2 p-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
          <span class="text-[var(--text-secondary)] pl-1">
            <Icon name="project" :size="15" />
          </span>
          <label for="feed-scope-select" class="text-xs text-[var(--text-muted)] font-semibold">Scope:</label>
          <select
            id="feed-scope-select"
            v-model="activeScope"
            class="bg-transparent text-xs text-[var(--text-primary)] font-medium border-0 cursor-pointer pr-4 focus:ring-0 focus:outline-none"
            aria-label="Select Project Scope"
          >
            <option value="all" class="bg-[var(--bg-surface)] text-[var(--text-primary)]">All Projects (Sprout Workspace)</option>
            <option value="sprout-m2" class="bg-[var(--bg-surface)] text-[var(--text-primary)]">Sprout M2 Operator</option>
            <option value="infra" class="bg-[var(--bg-surface)] text-[var(--text-primary)]">Infrastructure & Hosts</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 2. Split Board Layout (Adapted for Ultra-wide: 2-column split board on lg+) -->
    <div class="flex flex-col lg:flex-row gap-6 w-full">
      <!-- Left Column: Attention Queue & Live In-Flight Work -->
      <div class="flex-1 min-w-0 flex flex-col gap-6">
        <!-- Section 1: Prominent Human Attention Section -->
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2">
              <Icon name="alert" :size="18" class="text-[var(--yellow-attention)]" />
              <h3 class="text-sm font-bold text-[var(--text-primary)]">Human Attention Required</h3>
              <Badge variant="red">{{ actionRequiredCount }} Action</Badge>
            </div>
            <span class="text-[11px] text-[var(--text-muted)]">Discovery only; mutations happen on authoritative pages</span>
          </div>

          <!-- 4 Streamlined Urgency Pills using FilterPillGroup -->
          <FilterPillGroup label="Filter attention items by urgency">
            <FilterPill
              filter-key="all"
              label="All"
              :count="attentionItems.length"
              status="purple"
              :active="activeUrgency === 'all'"
              @click="activeUrgency = 'all'"
            />
            <FilterPill
              filter-key="action_required"
              label="Action Required"
              :count="actionRequiredCount"
              status="red"
              :active="activeUrgency === 'action_required'"
              @click="activeUrgency = 'action_required'"
            />
            <FilterPill
              filter-key="attention"
              label="Attention"
              :count="attentionCount"
              status="yellow"
              :active="activeUrgency === 'attention'"
              @click="activeUrgency = 'attention'"
            />
            <FilterPill
              filter-key="info"
              label="Info"
              :count="infoCount"
              status="neutral"
              :active="activeUrgency === 'info'"
              @click="activeUrgency = 'info'"
            />
          </FilterPillGroup>

          <!-- Attention Cards List -->
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-1">
            <button
              v-for="item in filteredAttentionItems"
              :key="item.id"
              type="button"
              class="text-left p-4 rounded-[var(--radius-md)] border bg-[var(--bg-surface)] flex flex-col justify-between gap-3 shadow-xs hover:border-[var(--border-strong)] transition-all cursor-pointer select-none"
              :class="item.severity === 'action_required' ? 'border-l-4 border-l-[var(--red-action)] border-[var(--border-subtle)]' : item.severity === 'attention' ? 'border-l-4 border-l-[var(--yellow-attention)] border-[var(--border-subtle)]' : 'border-l-4 border-l-[var(--purple-agent)] border-[var(--border-subtle)]'"
              @click="handleNavigate(item.targetPath)"
            >
              <div class="w-full">
                <div class="flex items-center justify-between gap-2 mb-2">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]">
                      <Icon :name="item.icon" :size="12" />
                      <span>{{ item.categoryName }}</span>
                    </span>
                    <Badge v-if="item.projectName" variant="info">{{ item.projectName }}</Badge>
                  </div>
                  <StatusDot :status="item.severity === 'action_required' ? 'red' : item.severity === 'attention' ? 'yellow' : 'blue'" size="sm" />
                </div>

                <strong class="text-xs sm:text-sm font-bold text-[var(--text-primary)] leading-tight block mb-1">
                  {{ item.title }}
                </strong>
                <div class="text-[11px] font-mono text-[var(--text-muted)] mb-2">
                  {{ item.lifecycleSentence }}
                </div>
                <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {{ item.summary }}
                </p>
              </div>

              <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 w-full text-[11px] text-[var(--text-muted)]">
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

        <!-- Section 2: Live In-Flight Work -->
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2">
              <Icon name="tasks" :size="18" />
              <h3 class="text-sm font-bold text-[var(--text-primary)]">Live In-Flight Work</h3>
              <Badge variant="info">{{ activeTasks.length }} Active</Badge>
            </div>
            <span class="text-[11px] text-[var(--text-muted)]">Active task leases held continuously</span>
          </div>

          <div class="grid grid-cols-1 xl:grid-cols-3 gap-3">
            <button
              v-for="task in activeTasks"
              :key="task.id"
              type="button"
              class="text-left p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-3 shadow-xs cursor-pointer select-none hover:border-[var(--border-strong)] transition-all"
              @click="openTaskDetail(task)"
            >
              <div>
                <div class="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div class="flex items-center gap-1.5 flex-wrap mb-1">
                      <Badge variant="info">{{ task.projectName }}</Badge>
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--purple-agent-bg)] text-[var(--purple-agent)] border border-[var(--purple-agent-border)]">
                        Task active · Lease held
                      </span>
                    </div>
                    <h4 class="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                      #{{ task.id }}: {{ task.title }}
                    </h4>
                  </div>
                  <StatusDot status="blue" size="sm" class="shrink-0 mt-1" />
                </div>

                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] text-xs flex flex-col gap-1 text-[var(--text-secondary)]">
                  <div class="flex justify-between flex-wrap gap-1 text-[11px]">
                    <span><strong>Lead:</strong> @{{ task.lead }} · <strong>Env:</strong> {{ task.environment }}</span>
                    <span class="font-mono text-[10px]">{{ task.engine }}</span>
                  </div>
                  <div class="text-[10px] text-[var(--text-muted)] mt-0.5 line-clamp-2">
                    Goal: {{ task.goal }}
                  </div>
                </div>
              </div>

              <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-end text-xs font-semibold text-[var(--accent-primary)]">
                <span>Inspect Task Details →</span>
              </div>
            </button>
          </div>
        </section>
      </div>

      <!-- Right Column: Recent Operational Activity Stream (Split Board on Large/Ultra-wide) -->
      <div class="w-full lg:w-[380px] xl:w-[440px] shrink-0 flex flex-col gap-4">
        <!-- Section 3: Recent Operational Activity Stream -->
        <section class="flex flex-col gap-3 sticky top-4">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2">
              <Icon name="lightning" :size="18" />
              <h3 class="text-sm font-bold text-[var(--text-primary)]">Recent Operational Activity</h3>
              <Badge variant="info">{{ activities.length }} Total</Badge>
            </div>
            <span class="text-[11px] text-[var(--text-muted)]">Audit log scoped</span>
          </div>

          <!-- 5 Streamlined Activity Filter Pills -->
          <FilterPillGroup label="Filter activity stream">
            <FilterPill
              filter-key="all"
              label="All"
              :count="activities.length"
              status="purple"
              :active="activeActivityFilter === 'all'"
              @click="activeActivityFilter = 'all'"
            />
            <FilterPill
              filter-key="tasks"
              label="Tasks"
              :count="1"
              status="neutral"
              :active="activeActivityFilter === 'tasks'"
              @click="activeActivityFilter = 'tasks'"
            />
            <FilterPill
              filter-key="messages"
              label="Chat"
              :count="1"
              status="green"
              :active="activeActivityFilter === 'messages'"
              @click="activeActivityFilter = 'messages'"
            />
            <FilterPill
              filter-key="envs"
              label="Envs"
              :count="2"
              status="yellow"
              :active="activeActivityFilter === 'envs'"
              @click="activeActivityFilter = 'envs'"
            />
            <FilterPill
              filter-key="usage"
              label="Usage"
              :count="1"
              status="neutral"
              :active="activeActivityFilter === 'usage'"
              @click="activeActivityFilter = 'usage'"
            />
          </FilterPillGroup>

          <!-- Activity List Items -->
          <div class="p-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-0.5 shadow-xs">
            <button
              v-for="act in filteredActivities"
              :key="act.id"
              type="button"
              class="text-left p-3 rounded flex items-center justify-between gap-3 hover:bg-[var(--bg-surface-elevated)] transition-colors cursor-pointer select-none"
              @click="handleNavigate(act.targetPath)"
            >
              <div class="flex items-center shrink-0">
                <StatusDot :status="act.badgeKind" size="sm" />
              </div>

              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <strong class="text-xs text-[var(--text-primary)]">{{ act.title }}</strong>
                  <Badge variant="info">{{ act.projectName }}</Badge>
                </div>
                <div class="text-[11px] text-[var(--text-secondary)] truncate mt-0.5">
                  {{ act.subtitle }}
                </div>
              </div>

              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[10px] text-[var(--text-muted)] font-mono">{{ act.relativeTime }}</span>
                <Icon name="chevron-right" :size="14" class="text-[var(--text-muted)]" />
              </div>
            </button>
          </div>
        </section>
      </div>
    </div>
    <!-- Task Detail Modal -->
    <Dialog
      v-if="selectedTask"
      :open="isTaskDetailOpen"
      :title="`Task #${selectedTask.id}: ${selectedTask.title}`"
      :description="`Project: ${selectedTask.projectName} · Lead: @${selectedTask.lead}`"
      @update:open="isTaskDetailOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <Badge variant="info">{{ selectedTask.projectName }}</Badge>
            <span class="font-mono text-[11px] text-[var(--text-muted)]">{{ selectedTask.engine }}</span>
          </div>
          <strong class="text-sm text-[var(--text-primary)]">#{{ selectedTask.id }}: {{ selectedTask.title }}</strong>
          <p class="text-xs text-[var(--text-secondary)]">Goal: {{ selectedTask.goal }}</p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Lead Agent</span>
            <strong class="text-[var(--text-primary)]">@{{ selectedTask.lead }}</strong>
          </div>
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex flex-col gap-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Environment</span>
            <strong class="text-[var(--text-primary)]">{{ selectedTask.environment }}</strong>
          </div>
        </div>

        <div class="p-3 rounded bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] flex flex-col gap-1">
          <strong class="text-xs font-bold flex items-center gap-1.5">
            <Icon name="shield" :size="14" />
            <span>Task-Held Exclusive Lease</span>
          </strong>
          <p class="text-[11px] text-[var(--text-secondary)]">
            Exclusive lease is held continuously on host {{ selectedTask.environment }} across turns and validation steps.
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
  </div>
</template>
