<script setup lang="ts">
import { ref, computed } from 'vue';
import SubNav, { type SubNavItem } from '../primitives/SubNav.vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';
import StatusPill from '../primitives/StatusPill.vue';
import Foldable from '../primitives/Foldable.vue';

const manageSubNavItems: SubNavItem[] = [
  { to: '/manage/environments', label: 'Environments', icon: 'environments' },
  { to: '/manage/agents', label: 'Agents', icon: 'agents' },
  { to: '/manage/usage', label: 'Usage & Costs', icon: 'usage' },
  { to: '/manage/settings', label: 'Settings', icon: 'settings' },
];

type AgentFilter = 'all' | 'active' | 'attention' | 'unavailable' | 'archived';

interface AgentWorkOption {
  priority: number;
  engine: string;
  model: string;
  effort: string;
  isConfigured: boolean;
}

interface AgentItem {
  id: string;
  displayName: string;
  role: string;
  status: 'active' | 'archived';
  trafficLight: 'green' | 'yellow' | 'red' | 'neutral';
  trafficLightReason: string;
  description: string;
  standingInstructions: string;
  privateMemoryCount: number;
  workOptions: AgentWorkOption[];
  compatibility: Array<{ host: string; eligible: boolean; reason: string }>;
}

const activeFilter = ref<AgentFilter>('all');
const selectedAgentId = ref('agent-prog');

const agents = ref<AgentItem[]>([
  {
    id: 'agent-prog',
    displayName: 'Programmer',
    role: 'Lead Implementation Engineer',
    status: 'active',
    trafficLight: 'green',
    trafficLightReason: 'Ready: Priority 1 option (PI · gemini-2.5-pro · high) ready on online host(s) · 2 fallbacks configured',
    description: 'Expert coding agent specializing in TypeScript, Vue, Node.js, and architecture seams.',
    standingInstructions: 'Always verify tests before claiming completion. Preserve strict privacy boundaries and zero sensitive host data.',
    privateMemoryCount: 14,
    workOptions: [
      { priority: 1, engine: 'Pi', model: 'gemini-2.5-pro', effort: 'high', isConfigured: true },
      { priority: 2, engine: 'Codex', model: 'gpt-5-codex', effort: 'medium', isConfigured: true },
      { priority: 3, engine: 'agy', model: 'antigravity-deep-code', effort: 'low', isConfigured: true },
    ],
    compatibility: [
      { host: 'Mac Studio M2 Max', eligible: true, reason: 'Eligible · Pi & Codex authenticated · 14ms latency' },
      { host: 'Linux Container Node', eligible: true, reason: 'Eligible via Pi fallback · Codex token degraded' },
      { host: 'Windows Workstation 01', eligible: false, reason: 'Ineligible · Host offline for 14m' },
    ],
  },
  {
    id: 'agent-arch',
    displayName: 'Architect',
    role: 'System & Seams Architect',
    status: 'active',
    trafficLight: 'yellow',
    trafficLightReason: 'Attention: Priority 1 option unavailable on Windows host; fallback option active at run admission',
    description: 'Lead domain modeling and ADR steward. Protects deep-module boundaries and invariant contracts.',
    standingInstructions: 'Ensure all changes reference CONTEXT.md glossary terms and adhere to ADR authority guidelines.',
    privateMemoryCount: 22,
    workOptions: [
      { priority: 1, engine: 'Codex', model: 'gpt-5-codex', effort: 'high', isConfigured: true },
      { priority: 2, engine: 'Pi', model: 'claude-3-7-sonnet', effort: 'high', isConfigured: true },
    ],
    compatibility: [
      { host: 'Mac Studio M2 Max', eligible: true, reason: 'Eligible · Codex & Pi authenticated' },
      { host: 'Windows Workstation 01', eligible: false, reason: 'Ineligible · Lease recovery required' },
    ],
  },
  {
    id: 'agent-fore',
    displayName: 'Foreman',
    role: 'Run Orchestrator & Coordinator',
    status: 'active',
    trafficLight: 'green',
    trafficLightReason: 'Ready: Priority 1 option (PI · claude-3-7-sonnet) authenticated and ready',
    description: 'Autonomous execution supervisor. Manages task delegation, progress tracking, and validation reviews.',
    standingInstructions: 'Maintain accurate run state tracking and reconcile uncommitted work on restart.',
    privateMemoryCount: 8,
    workOptions: [
      { priority: 1, engine: 'Pi', model: 'claude-3-7-sonnet', effort: 'medium', isConfigured: true },
      { priority: 2, engine: 'OpenCode', model: 'local-qwen-32b', effort: 'low', isConfigured: true },
    ],
    compatibility: [
      { host: 'Mac Studio M2 Max', eligible: true, reason: 'Eligible · All engines authenticated' },
      { host: 'Linux Container Node', eligible: true, reason: 'Eligible · Local OpenCode active' },
    ],
  },
  {
    id: 'agent-novice',
    displayName: 'Junior QA Tester',
    role: 'Automated Smoke & Regression Bot',
    status: 'active',
    trafficLight: 'red',
    trafficLightReason: 'Action Required: All configured work options are missing on current environments',
    description: 'End-to-end user journey test runner requiring local GUI automation capabilities.',
    standingInstructions: 'Report regression diffs immediately with screenshot evidence.',
    privateMemoryCount: 2,
    workOptions: [
      { priority: 1, engine: 'agy', model: 'agy-gui-vision', effort: 'high', isConfigured: false },
    ],
    compatibility: [
      { host: 'Mac Studio M2 Max', eligible: false, reason: 'Ineligible · agy-gui-vision model missing' },
      { host: 'Linux Container Node', eligible: false, reason: 'Ineligible · GUI automation unavailable' },
    ],
  },
  {
    id: 'agent-old',
    displayName: 'Legacy Code Migrator',
    role: 'Historical M1 Migration Helper',
    status: 'archived',
    trafficLight: 'neutral',
    trafficLightReason: 'Archived Agent · Preserved attribution, private memory, and session slots (ADR-0008)',
    description: 'M1 to M2 transition utility agent, now cleanly retired without deleting historic activity.',
    standingInstructions: 'Archived persona; does not accept new task work.',
    privateMemoryCount: 19,
    workOptions: [],
    compatibility: [],
  },
]);

const allCount = computed(() => agents.value.length);
const activeCount = computed(() => agents.value.filter((a) => a.status === 'active').length);
const attentionCount = computed(() => agents.value.filter((a) => a.trafficLight === 'yellow').length);
const unavailableCount = computed(() => agents.value.filter((a) => a.trafficLight === 'red').length);
const archivedCount = computed(() => agents.value.filter((a) => a.status === 'archived').length);

const filteredAgents = computed(() => {
  if (activeFilter.value === 'active') return agents.value.filter((a) => a.status === 'active');
  if (activeFilter.value === 'attention') return agents.value.filter((a) => a.trafficLight === 'yellow');
  if (activeFilter.value === 'unavailable') return agents.value.filter((a) => a.trafficLight === 'red');
  if (activeFilter.value === 'archived') return agents.value.filter((a) => a.status === 'archived');
  return agents.value;
});

const selectedAgent = computed(() => {
  return agents.value.find((a) => a.id === selectedAgentId.value) ?? filteredAgents.value[0] ?? agents.value[0];
});
</script>

<template>
  <div class="agents-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- Sub navigation -->
    <SubNav :items="manageSubNavItems" />

    <!-- Header Card -->
    <div class="p-4 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <h2 class="text-sm sm:text-base font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Icon name="agents" :size="18" />
          <span>Agents & Worker Personas (ADR-0008)</span>
        </h2>
        <div class="flex items-center gap-2">
          <Button variant="primary" size="icon" title="Create New Agent">
            <Icon name="plus" :size="14" />
          </Button>
          <Button variant="secondary" size="icon" title="Agent Architecture Guide">
            <Icon name="guide" :size="14" />
          </Button>
        </div>
      </div>

      <!-- Filter Row -->
      <div class="flex items-center gap-1.5 overflow-x-auto py-1" role="group" aria-label="Filter agents">
        <button
          type="button"
          class="flex flex-col items-center justify-center p-2 rounded-[var(--radius-sm)] border text-center transition-all cursor-pointer flex-1 min-w-[70px]"
          :class="activeFilter === 'all' ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--text-primary)] font-bold ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)]'"
          @click="activeFilter = 'all'"
        >
          <span class="flex items-center gap-1 text-xs font-semibold">
            <StatusDot status="purple" size="sm" /> {{ allCount }}
          </span>
          <span class="text-[11px] mt-0.5">All</span>
        </button>
        <button
          type="button"
          class="flex flex-col items-center justify-center p-2 rounded-[var(--radius-sm)] border text-center transition-all cursor-pointer flex-1 min-w-[70px]"
          :class="activeFilter === 'active' ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--text-primary)] font-bold ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)]'"
          @click="activeFilter = 'active'"
        >
          <span class="flex items-center gap-1 text-xs font-semibold">
            <StatusDot status="green" size="sm" /> {{ activeCount }}
          </span>
          <span class="text-[11px] mt-0.5">Active</span>
        </button>
        <button
          type="button"
          class="flex flex-col items-center justify-center p-2 rounded-[var(--radius-sm)] border text-center transition-all cursor-pointer flex-1 min-w-[70px]"
          :class="activeFilter === 'attention' ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--text-primary)] font-bold ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)]'"
          @click="activeFilter = 'attention'"
        >
          <span class="flex items-center gap-1 text-xs font-semibold">
            <StatusDot status="yellow" size="sm" /> {{ attentionCount }}
          </span>
          <span class="text-[11px] mt-0.5">Attention</span>
        </button>
        <button
          type="button"
          class="flex flex-col items-center justify-center p-2 rounded-[var(--radius-sm)] border text-center transition-all cursor-pointer flex-1 min-w-[70px]"
          :class="activeFilter === 'unavailable' ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--text-primary)] font-bold ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)]'"
          @click="activeFilter = 'unavailable'"
        >
          <span class="flex items-center gap-1 text-xs font-semibold">
            <StatusDot status="red" size="sm" /> {{ unavailableCount }}
          </span>
          <span class="text-[11px] mt-0.5">Unavailable</span>
        </button>
        <button
          type="button"
          class="flex flex-col items-center justify-center p-2 rounded-[var(--radius-sm)] border text-center transition-all cursor-pointer flex-1 min-w-[70px]"
          :class="activeFilter === 'archived' ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--text-primary)] font-bold ring-1 ring-[var(--accent-primary)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)]'"
          @click="activeFilter = 'archived'"
        >
          <span class="flex items-center gap-1 text-xs font-semibold">
            <StatusDot status="neutral" size="sm" /> {{ archivedCount }}
          </span>
          <span class="text-[11px] mt-0.5">Archived</span>
        </button>
      </div>
    </div>

    <!-- Master / Detail Body (Ultra-wide screen adapted) -->
    <div class="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 w-full max-w-[1920px] mx-auto">
      <div class="flex flex-col md:flex-row gap-4 h-full">
        <!-- Master Card List (Fixed width 320px-384px) -->
        <div class="w-full md:w-80 lg:w-96 shrink-0 flex flex-col gap-2.5 overflow-y-auto pr-1">
          <div
            v-for="agent in filteredAgents"
            :key="agent.id"
            class="p-3 rounded-[var(--radius-md)] border transition-all cursor-pointer select-none flex flex-col gap-2"
            :class="agent.id === selectedAgentId ? 'bg-[var(--bg-surface-elevated)] border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)] shadow-xs' : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]'"
            @click="selectedAgentId = agent.id"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-xs">
                  {{ agent.displayName[0] }}
                </div>
                <div>
                  <strong class="text-xs font-bold text-[var(--text-primary)] block">@{{ agent.displayName }}</strong>
                  <span class="text-[10px] text-[var(--text-muted)] block">{{ agent.role }}</span>
                </div>
              </div>
              <StatusDot :status="agent.trafficLight" size="sm" />
            </div>

            <p class="text-xs text-[var(--text-secondary)] line-clamp-2 leading-tight">
              {{ agent.trafficLightReason }}
            </p>

            <div class="flex items-center gap-1 flex-wrap pt-1 border-t border-[var(--border-subtle)]">
              <Badge v-for="opt in agent.workOptions" :key="opt.priority" variant="secondary">
                {{ opt.engine.toUpperCase() }}
              </Badge>
              <Badge v-if="agent.status === 'archived'" variant="neutral">ARCHIVED</Badge>
            </div>
          </div>
        </div>

        <!-- Detail Column (Fluid flex-1) -->
        <div v-if="selectedAgent" class="flex-1 overflow-y-auto pl-1">
          <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-5 shadow-xs">
            <!-- Identity Banner -->
            <div class="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-base">
                  {{ selectedAgent.displayName[0] }}
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <h3 class="text-base font-bold text-[var(--text-primary)]">@{{ selectedAgent.displayName }}</h3>
                    <StatusPill :status="selectedAgent.trafficLight">{{ selectedAgent.status.toUpperCase() }}</StatusPill>
                  </div>
                  <span class="text-xs text-[var(--text-secondary)] font-medium block mt-0.5">{{ selectedAgent.role }}</span>
                  <span class="text-[10px] text-[var(--text-muted)] font-mono">Private memory: {{ selectedAgent.privateMemoryCount }} entries retained</span>
                </div>
              </div>
            </div>

            <!-- Standing Instructions -->
            <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex flex-col gap-1">
              <strong class="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Standing Instructions (ADR-0008)</strong>
              <p class="text-[var(--text-primary)] leading-relaxed">{{ selectedAgent.standingInstructions }}</p>
            </div>

            <!-- Ordered Work Options (Grid on wide screens) -->
            <div class="flex flex-col gap-2.5">
              <div class="flex items-center justify-between">
                <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold">
                  Ordered Work Options (Priority & Fallbacks)
                </strong>
                <span class="text-[10px] text-[var(--text-muted)]">Minimum 1 option guard</span>
              </div>

              <div class="grid grid-cols-1 xl:grid-cols-3 gap-2.5">
                <div
                  v-for="opt in selectedAgent.workOptions"
                  :key="opt.priority"
                  class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex flex-col justify-between gap-2"
                >
                  <div class="flex items-center justify-between">
                    <span class="w-5 h-5 rounded-full bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold text-[10px] flex items-center justify-center">
                      {{ opt.priority }}
                    </span>
                    <Badge :variant="opt.isConfigured ? 'success' : 'danger'">
                      {{ opt.isConfigured ? 'Configured' : 'Missing' }}
                    </Badge>
                  </div>
                  <div>
                    <strong class="text-xs font-bold text-[var(--text-primary)] block">{{ opt.engine.toUpperCase() }}</strong>
                    <span class="text-xs text-[var(--text-secondary)] font-mono">{{ opt.model }}</span>
                  </div>
                  <div class="text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
                    Effort: {{ opt.effort }}
                  </div>
                </div>

                <div v-if="selectedAgent.workOptions.length === 0" class="text-xs text-[var(--text-muted)] italic py-1 col-span-3">
                  No work options configured for this archived persona.
                </div>
              </div>
            </div>

            <!-- Environment Compatibility Breakdown (Grid on wide screens) -->
            <div class="flex flex-col gap-2.5">
              <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold">
                Host Compatibility & Ineligibility Reasons
              </strong>
              <div class="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
                <div
                  v-for="c in selectedAgent.compatibility"
                  :key="c.host"
                  class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between text-xs gap-2"
                >
                  <strong class="text-[var(--text-primary)] text-xs">{{ c.host }}</strong>
                  <span class="text-[11px]" :class="c.eligible ? 'text-[var(--green-ready)]' : 'text-[var(--yellow-attention)]'">
                    {{ c.reason }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Historical Attribution Foldable -->
            <Foldable title="Attribution & Historical Contribution Trace" subtext="ADR-0008 Non-destructive provenance">
              <p class="text-[11px] text-[var(--text-secondary)] py-1">
                Completed 42 runs across Project Sprout M2. Historical runs retain persistent attribution even if this persona is subsequently archived.
              </p>
            </Foldable>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
