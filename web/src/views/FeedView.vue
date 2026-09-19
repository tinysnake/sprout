<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.ts';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';
import StatusPill from '../primitives/StatusPill.vue';

const router = useRouter();
const appStore = useAppStore();

const activeScope = ref('all');
const activeUrgency = ref<'all' | 'action_required' | 'attention' | 'info'>('all');

interface AttentionItem {
  id: string;
  severity: 'red' | 'yellow' | 'info';
  category: string;
  icon: string;
  title: string;
  summary: string;
  lifecycleSentence: string;
  actor: string;
  timeAgo: string;
  targetPath: string;
  targetLabel: string;
}

const attentionItems = ref<AttentionItem[]>([
  {
    id: 'att-1',
    severity: 'red',
    category: 'Recovery',
    icon: 'alert',
    title: 'Windows Workstation 01 Offline · Lease Recovery Required',
    summary: 'Carrier channel disconnected mid-turn during active Task #104 execution. Task lease locked in recovery.',
    lifecycleSentence: 'Task #104 · Run #206 interrupted · Lease locked in recovery',
    actor: 'Host Worker daemon',
    timeAgo: '14m ago',
    targetPath: '/manage/environments/env-recovery',
    targetLabel: 'Inspect in Manage / Environments →',
  },
  {
    id: 'att-2',
    severity: 'red',
    category: 'Compatibility',
    icon: 'warning',
    title: 'Protocol Version Incompatible: Legacy Mac mini',
    summary: 'Worker reports protocol v1.8 which is below the minimum required v2.0+. Automatic work admission refused.',
    lifecycleSentence: 'Enrollment approved · Protocol mismatch v1.8 < v2.0+ · Admission barred',
    actor: 'System Overseer',
    timeAgo: '1m ago',
    targetPath: '/manage/environments/env-incompatible',
    targetLabel: 'View Protocol Guidance →',
  },
  {
    id: 'att-3',
    severity: 'yellow',
    category: 'Enrollment',
    icon: 'check',
    title: 'Pending Host Enrollment: MacBook Pro Operator Local',
    summary: 'New worker instance requested enrollment over private transport. Operator approval required before admitting work.',
    lifecycleSentence: 'Identity verified · Capabilities declared · Awaiting operator approval',
    actor: 'Bootstrap Service',
    timeAgo: 'just now',
    targetPath: '/manage/environments/env-pending',
    targetLabel: 'Review Enrollment →',
  },
  {
    id: 'att-4',
    severity: 'yellow',
    category: 'Degraded',
    icon: 'server',
    title: 'Linux Container Node Engine Degraded: Codex Login Required',
    summary: 'Codex engine CLI token has expired on container host. Pi and OpenCode engines remain operational.',
    lifecycleSentence: 'Carrier online · 3 of 4 engines ready · Codex authentication degraded',
    actor: 'Health Monitor',
    timeAgo: '45s ago',
    targetPath: '/manage/environments/env-degraded',
    targetLabel: 'Inspect Engine Status →',
  },
  {
    id: 'att-5',
    severity: 'info',
    category: 'Active Lease',
    icon: 'shield',
    title: 'Active Task-Held Lease on Mac Studio M2 Max',
    summary: 'Task #101 holds exclusive lease across multi-run execution. Running lead @Programmer.',
    lifecycleSentence: 'Task #101 active · Run running · Lease held continuously (ADR-0005)',
    actor: '@Programmer',
    timeAgo: '10s ago',
    targetPath: '/manage/environments/env-ready',
    targetLabel: 'Inspect Active Lease →',
  },
]);

const activeWorkTasks = ref([
  {
    id: 'task-101',
    number: '101',
    title: 'Refactor Environment State Manager into Decoupled Seams',
    status: 'Running',
    statusVariant: 'success' as const,
    lead: 'Programmer',
    environment: 'Mac Studio M2 Max',
    duration: '12m 40s',
    progress: 'Run 2 of 3 executing',
    targetPath: '/manage/environments/env-ready',
  },
  {
    id: 'task-104',
    number: '104',
    title: 'Multi-Agent Simulation Validation & Host Porting',
    status: 'Recovery',
    statusVariant: 'danger' as const,
    lead: 'Architect',
    environment: 'Windows Workstation 01',
    duration: '32m 10s',
    progress: 'Interrupted run #206 pending recovery decision',
    targetPath: '/manage/environments/env-recovery',
  },
  {
    id: 'task-107',
    number: '107',
    title: 'Validate Reka UI Headless Accessible Overlays & Focus Trap',
    status: 'Validation',
    statusVariant: 'warning' as const,
    lead: 'Foreman',
    environment: 'Local Worker',
    duration: '5m 12s',
    progress: 'Human validation required: review test results',
    targetPath: '/manage/environments',
  },
]);

const recentActivity = ref([
  {
    id: 'act-1',
    icon: 'lightning',
    time: 'just now',
    text: 'Readiness probe completed on Mac Studio M2 Max (14ms latency, all engines authenticated).',
    category: 'environments',
  },
  {
    id: 'act-2',
    icon: 'chat',
    time: '2m ago',
    text: '@Programmer completed turn 4 in #general: "Verified Reka UI dialog keyboard focus management."',
    category: 'messages',
  },
  {
    id: 'act-3',
    icon: 'alert',
    time: '14m ago',
    text: 'Carrier heartbeat lost for Windows Workstation 01; task-held lease automatically locked in recovery.',
    category: 'environments',
  },
  {
    id: 'act-4',
    icon: 'tasks',
    time: '18m ago',
    text: 'Task #101 acquired exclusive lease on Mac Studio M2 Max under ADR-0005 guarantee.',
    category: 'tasks',
  },
]);

const filteredAttentionItems = computed(() => {
  if (activeUrgency.value === 'all') return attentionItems.value;
  if (activeUrgency.value === 'action_required') {
    return attentionItems.value.filter((i) => i.severity === 'red');
  }
  if (activeUrgency.value === 'attention') {
    return attentionItems.value.filter((i) => i.severity === 'yellow');
  }
  return attentionItems.value.filter((i) => i.severity === 'info');
});

const actionCount = computed(() => attentionItems.value.filter((i) => i.severity === 'red').length);
const attentionCount = computed(() => attentionItems.value.filter((i) => i.severity === 'yellow').length);
const infoCount = computed(() => attentionItems.value.filter((i) => i.severity === 'info').length);

function navigateTo(path: string) {
  appStore.setReturnContext({
    title: 'Back to Feed',
    to: '/feed',
  });
  router.push(path);
}
</script>

<template>
  <div class="feed-view p-4 sm:p-6 max-w-6xl mx-auto flex flex-col gap-6">
    <!-- Header Area -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
      <div>
        <h2 class="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Icon name="feed" :size="20" />
          <span>Operations Feed & Human Attention</span>
        </h2>
        <p class="text-xs text-[var(--text-secondary)] mt-1">
          Central cross-project surface for operational discovery, urgent Human triage, and active work telemetry.
        </p>
      </div>

      <!-- Scope Selector -->
      <div class="flex items-center gap-2">
        <label for="feed-scope-select" class="text-xs text-[var(--text-muted)] font-medium">Scope:</label>
        <select
          id="feed-scope-select"
          v-model="activeScope"
          class="h-8 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2.5 text-xs text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] cursor-pointer"
        >
          <option value="all">All Projects (Sprout Workspace)</option>
          <option value="sprout-m2">Project: Sprout M2 Operator</option>
          <option value="minesweeper">Project: o7 Minesweeper</option>
          <option value="infra">Infrastructure & Hosts</option>
        </select>
      </div>
    </div>

    <!-- Section 1: Human Attention Section -->
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-2">
          <span>Human Attention Required</span>
          <span class="px-1.5 py-0.2 rounded-full text-[10px] bg-[var(--red-action-bg)] text-[var(--red-action)] font-bold">
            {{ actionCount }}
          </span>
        </h3>

        <!-- Urgency Pills Filter -->
        <div class="flex items-center gap-1.5" role="group" aria-label="Filter attention items">
          <button
            type="button"
            class="px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer"
            :class="activeUrgency === 'all' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold border border-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'"
            @click="activeUrgency = 'all'"
          >
            All ({{ attentionItems.length }})
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer"
            :class="activeUrgency === 'action_required' ? 'bg-[var(--red-action-bg)] text-[var(--red-action)] font-bold border border-[var(--red-action)]' : 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'"
            @click="activeUrgency = 'action_required'"
          >
            Action Required ({{ actionCount }})
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer"
            :class="activeUrgency === 'attention' ? 'bg-[var(--yellow-attention-bg)] text-[var(--yellow-attention)] font-bold border border-[var(--yellow-attention)]' : 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'"
            @click="activeUrgency = 'attention'"
          >
            Attention ({{ attentionCount }})
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer"
            :class="activeUrgency === 'info' ? 'bg-[var(--purple-agent-bg)] text-[var(--purple-agent)] font-bold border border-[var(--purple-agent)]' : 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'"
            @click="activeUrgency = 'info'"
          >
            Info ({{ infoCount }})
          </button>
        </div>
      </div>

      <!-- Attention Cards Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div
          v-for="item in filteredAttentionItems"
          :key="item.id"
          class="p-4 rounded-[var(--radius-md)] border bg-[var(--bg-surface)] flex flex-col justify-between gap-3 shadow-xs transition-all hover:border-[var(--border-strong)]"
          :class="item.severity === 'red' ? 'border-l-4 border-l-[var(--red-action)] border-[var(--border-subtle)]' : item.severity === 'yellow' ? 'border-l-4 border-l-[var(--yellow-attention)] border-[var(--border-subtle)]' : 'border-l-4 border-l-[var(--purple-agent)] border-[var(--border-subtle)]'"
        >
          <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" :class="item.severity === 'red' ? 'bg-[var(--red-action-bg)] text-[var(--red-action)]' : item.severity === 'yellow' ? 'bg-[var(--yellow-attention-bg)] text-[var(--yellow-attention)]' : 'bg-[var(--purple-agent-bg)] text-[var(--purple-agent)]'">
                {{ item.category }}
              </span>
              <span class="text-[10px] text-[var(--text-muted)] font-mono">{{ item.timeAgo }}</span>
            </div>
            <h4 class="text-xs sm:text-sm font-bold text-[var(--text-primary)] mb-1">
              {{ item.title }}
            </h4>
            <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
              {{ item.summary }}
            </p>
          </div>

          <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 flex-wrap">
            <span class="text-[10px] text-[var(--text-muted)] font-mono truncate">
              {{ item.lifecycleSentence }}
            </span>
            <Button
              variant="secondary"
              size="xs"
              class="text-[11px] font-semibold"
              @click="navigateTo(item.targetPath)"
            >
              {{ item.targetLabel }}
            </Button>
          </div>
        </div>
      </div>
    </section>

    <!-- Section 2: Live In-Flight Work -->
    <section class="flex flex-col gap-3">
      <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-2">
        <Icon name="tasks" :size="14" />
        <span>Live In-Flight Work Telemetry</span>
      </h3>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div
          v-for="task in activeWorkTasks"
          :key="task.id"
          class="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-2.5"
        >
          <div>
            <div class="flex items-center justify-between gap-2 mb-1">
              <span class="text-xs font-bold text-[var(--text-primary)]">Task #{{ task.number }}</span>
              <Badge :variant="task.statusVariant">
                {{ task.status }}
              </Badge>
            </div>
            <h5 class="text-xs font-semibold text-[var(--text-primary)] line-clamp-2 mb-1">
              {{ task.title }}
            </h5>
            <p class="text-[11px] text-[var(--text-muted)]">
              Lead: <strong class="text-[var(--text-secondary)]">@{{ task.lead }}</strong> · {{ task.environment }}
            </p>
          </div>

          <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[10px]">
            <span class="text-[var(--text-muted)] font-mono">{{ task.duration }}</span>
            <Button
              variant="ghost"
              size="xs"
              class="text-[10px] text-[var(--accent-primary)] hover:underline"
              @click="navigateTo(task.targetPath)"
            >
              Inspect →
            </Button>
          </div>
        </div>
      </div>
    </section>

    <!-- Section 3: Recent Operational Activity Stream -->
    <section class="flex flex-col gap-2.5">
      <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-2">
        <Icon name="lightning" :size="14" />
        <span>Recent Operational Activity</span>
      </h3>

      <div class="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-2">
        <div
          v-for="act in recentActivity"
          :key="act.id"
          class="flex items-start gap-2.5 py-1.5 border-b border-[var(--border-subtle)] last:border-0 text-xs"
        >
          <div class="p-1 rounded bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] mt-0.5">
            <Icon :name="act.icon" :size="13" />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[var(--text-primary)] text-xs leading-normal">
              {{ act.text }}
            </p>
          </div>
          <span class="text-[10px] text-[var(--text-muted)] font-mono shrink-0 whitespace-nowrap">
            {{ act.time }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>
