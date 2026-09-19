<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';
import StatusPill from '../primitives/StatusPill.vue';
import Foldable from '../primitives/Foldable.vue';
import Dialog from '../primitives/Dialog.vue';

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
const isMobileAgentDetailOpen = ref(false);
const isCreateAgentOpen = ref(false);
const isAgentGuideOpen = ref(false);
const isAddOptionOpen = ref(false);

const draggedOptionIndex = ref<number | null>(null);
const dragOverOptionIndex = ref<number | null>(null);

const newOptionEngine = ref('Pi');
const newOptionModel = ref('claude-3-7-sonnet');
const newOptionEffort = ref('medium');

function handleDragStart(index: number, e: DragEvent) {
  draggedOptionIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }
}

function handleDragOver(index: number, e: DragEvent) {
  e.preventDefault();
  dragOverOptionIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

function handleDragLeave(index: number) {
  if (dragOverOptionIndex.value === index) {
    dragOverOptionIndex.value = null;
  }
}

function handleDrop(targetIndex: number, e: DragEvent) {
  e.preventDefault();
  if (draggedOptionIndex.value !== null && draggedOptionIndex.value !== targetIndex) {
    moveOption(draggedOptionIndex.value, targetIndex);
  }
  draggedOptionIndex.value = null;
  dragOverOptionIndex.value = null;
}

function handleDragEnd() {
  draggedOptionIndex.value = null;
  dragOverOptionIndex.value = null;
}

function moveOption(fromIndex: number, toIndex: number) {
  if (!selectedAgent.value) return;
  const options = selectedAgent.value.workOptions;
  if (fromIndex < 0 || fromIndex >= options.length || toIndex < 0 || toIndex >= options.length) return;
  const [moved] = options.splice(fromIndex, 1);
  options.splice(toIndex, 0, moved);
  options.forEach((opt, idx) => {
    opt.priority = idx + 1;
  });
  if (options.length > 0) {
    selectedAgent.value.trafficLightReason = `Ready: Priority 1 option (${options[0].engine.toUpperCase()} · ${options[0].model} · ${options[0].effort}) ready on online host(s) · ${options.length - 1} fallback(s) configured`;
  }
}

function deleteOption(index: number) {
  if (!selectedAgent.value || selectedAgent.value.workOptions.length <= 1) return;
  selectedAgent.value.workOptions.splice(index, 1);
  selectedAgent.value.workOptions.forEach((opt, idx) => {
    opt.priority = idx + 1;
  });
  if (selectedAgent.value.workOptions.length > 0) {
    const p1 = selectedAgent.value.workOptions[0];
    selectedAgent.value.trafficLightReason = `Ready: Priority 1 option (${p1.engine.toUpperCase()} · ${p1.model} · ${p1.effort}) ready on online host(s) · ${selectedAgent.value.workOptions.length - 1} fallback(s) configured`;
  }
}

function handleAddOption() {
  if (!selectedAgent.value) return;
  const newPriority = selectedAgent.value.workOptions.length + 1;
  selectedAgent.value.workOptions.push({
    priority: newPriority,
    engine: newOptionEngine.value,
    model: newOptionModel.value.trim() || 'default-model',
    effort: newOptionEffort.value,
    isConfigured: true,
  });
  isAddOptionOpen.value = false;
  newOptionModel.value = 'claude-3-7-sonnet';
}

const newAgentName = ref('');
const newAgentRole = ref('');
const newAgentEngine = ref('Pi');
const newAgentModel = ref('gemini-2.5-pro');

function handleCreateAgent() {
  if (!newAgentName.value.trim()) return;
  const newId = `agent-${newAgentName.value.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  agents.value.push({
    id: newId,
    displayName: newAgentName.value.trim(),
    role: newAgentRole.value.trim() || 'Specialist Engineer',
    status: 'active',
    trafficLight: 'green',
    trafficLightReason: `Ready: Priority 1 option (${newAgentEngine.value.toUpperCase()} · ${newAgentModel.value}) ready on host(s)`,
    description: `Agent persona configured for ${newAgentRole.value.trim() || 'task execution'}.`,
    standingInstructions: 'Verify work thoroughly and preserve zero uncommitted host state.',
    privateMemoryCount: 0,
    workOptions: [
      { priority: 1, engine: newAgentEngine.value, model: newAgentModel.value, effort: 'high', isConfigured: true },
    ],
    compatibility: [
      { host: 'Mac Studio M2 Max', eligible: true, reason: 'Engine authenticated · Protocol v2.1' },
      { host: 'Windows Workstation 01', eligible: true, reason: 'Engine ready' },
    ],
  });
  selectedAgentId.value = newId;
  newAgentName.value = '';
  newAgentRole.value = '';
  isCreateAgentOpen.value = false;
}

function selectAgent(id: string) {
  selectedAgentId.value = id;
  isMobileAgentDetailOpen.value = true;
}

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
    trafficLightReason: 'Archived Agent · Preserved attribution, private memory, and session slots',
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
    <!-- Header Card -->
    <div class="p-4 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <h2 class="text-sm sm:text-base font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Icon name="agents" :size="18" />
          <span>Agents & Worker Personas</span>
        </h2>
        <div class="flex items-center gap-2">
          <Button
            variant="primary"
            size="icon"
            title="Create New Agent"
            aria-label="Create New Agent"
            class="create-agent-btn"
            @click="isCreateAgentOpen = true"
          >
            <Icon name="plus" :size="14" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            title="Agent Architecture Guide"
            aria-label="Agent Architecture Guide"
            class="agent-guide-btn"
            @click="isAgentGuideOpen = true"
          >
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
        <!-- Master Card List (Fixed width 320px-384px; hidden on mobile when drilled down) -->
        <div
          class="w-full md:w-80 lg:w-96 shrink-0 flex flex-col gap-2.5 overflow-y-auto pr-1"
          :class="isMobileAgentDetailOpen ? 'hidden md:flex' : 'flex'"
        >
          <button
            v-for="agent in filteredAgents"
            :key="agent.id"
            type="button"
            class="text-left w-full p-3 rounded-[var(--radius-md)] border transition-all cursor-pointer select-none flex flex-col gap-2"
            :class="agent.id === selectedAgentId ? 'bg-[var(--bg-surface-elevated)] border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)] shadow-xs' : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]'"
            @click="selectAgent(agent.id)"
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
          </button>
        </div>

        <!-- Detail Column (Fluid flex-1; hidden on mobile when viewing list) -->
        <div
          v-if="selectedAgent"
          class="flex-1 overflow-y-auto pl-1"
          :class="!isMobileAgentDetailOpen ? 'hidden md:block' : 'block'"
        >
          <!-- Mobile-only Back to Agents Header (Hidden on md+) -->
          <div class="md:hidden px-3 py-2.5 mb-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-2">
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer py-1 px-2.5 rounded bg-[var(--accent-bg)] border border-[var(--accent-border)] min-h-[36px]"
              title="Return to Agent List"
              aria-label="Return to Agent List"
              @click="isMobileAgentDetailOpen = false"
            >
              <Icon name="chevron-left" :size="16" />
              <span>Back to Agents</span>
            </button>
            <div class="flex items-center gap-1.5 truncate">
              <StatusDot :status="selectedAgent.trafficLight" size="sm" />
              <strong class="text-xs text-[var(--text-primary)] truncate">@{{ selectedAgent.displayName }}</strong>
            </div>
          </div>
          <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 shadow-xs">
            <!-- Prototype Traffic Light Summary Banner -->
            <div
              class="env-traffic-light-banner p-3.5 rounded-[var(--radius-sm)] border flex flex-col gap-2"
              :class="selectedAgent.trafficLight === 'green' ? 'bg-[var(--green-ready-bg)] border-[var(--green-ready)]' : selectedAgent.trafficLight === 'yellow' ? 'bg-[var(--yellow-attention-bg)] border-[var(--yellow-attention)]' : selectedAgent.trafficLight === 'red' ? 'bg-[var(--red-action-bg)] border-[var(--red-action)]' : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)]'"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <StatusDot :status="selectedAgent.trafficLight" size="sm" />
                  <strong class="text-xs uppercase tracking-wider font-bold text-[var(--text-primary)]">
                    {{ selectedAgent.trafficLight === 'green' ? 'Ready' : selectedAgent.trafficLight === 'yellow' ? 'Attention / Degraded' : selectedAgent.trafficLight === 'red' ? 'Action Required' : 'Archived' }}
                  </strong>
                </div>
                <span class="text-[11px] text-[var(--text-secondary)] font-mono">
                  {{ selectedAgent.status === 'active' ? 'v1 · Active' : 'Archived' }}
                </span>
              </div>
              <p class="text-xs text-[var(--text-primary)] leading-relaxed">
                {{ selectedAgent.trafficLightReason }}
              </p>
            </div>

            <!-- Identity Banner -->
            <div class="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold flex items-center justify-center text-base">
                  {{ selectedAgent.displayName[0] }}
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <h3 class="text-base font-bold text-[var(--text-primary)]">@{{ selectedAgent.displayName }}</h3>
                    <code class="text-[10px] text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] px-1.5 py-0.5 rounded font-mono">{{ selectedAgent.id }}</code>
                    <StatusPill :status="selectedAgent.trafficLight">{{ selectedAgent.status.toUpperCase() }}</StatusPill>
                  </div>
                  <span class="text-xs text-[var(--text-secondary)] font-medium block mt-0.5">{{ selectedAgent.role }}</span>
                  <p class="text-xs text-[var(--text-muted)] mt-1">{{ selectedAgent.description }}</p>
                </div>
              </div>
            </div>

            <!-- Core Dimensions Grid (Prototype dimensions-2x2-grid) -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between">
                <div>
                  <span class="text-xs font-semibold text-[var(--text-primary)] block">Stable Identity</span>
                  <span class="text-[10px] text-[var(--text-muted)] font-mono"><code>{{ selectedAgent.id }}</code></span>
                </div>
                <Badge variant="secondary">@{{ selectedAgent.displayName }}</Badge>
              </div>

              <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between">
                <div>
                  <span class="text-xs font-semibold text-[var(--text-primary)] block">Private Memory</span>
                  <span class="text-[10px] text-[var(--text-muted)]">Preserved across projects</span>
                </div>
                <Badge variant="info">{{ selectedAgent.privateMemoryCount }} entries</Badge>
              </div>
            </div>

            <!-- Standing Instructions -->
            <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex flex-col gap-1">
              <strong class="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">Standing Instructions</strong>
              <p class="text-[var(--text-primary)] leading-relaxed">{{ selectedAgent.standingInstructions }}</p>
            </div>

            <!-- Ordered Work Options (Execution Preferences) with Drag-and-Drop Reorder -->
            <div class="flex flex-col gap-2.5">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold block">
                    Ordered Execution Preferences (Work Options)
                  </strong>
                  <p class="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Drag to reorder priority. Evaluated at run admission in top-to-bottom order.
                  </p>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-[10px] text-[var(--text-muted)]">Minimum 1 option guard</span>
                  <Button
                    v-if="selectedAgent.status === 'active'"
                    variant="secondary"
                    size="xs"
                    class="add-option-btn"
                    @click="isAddOptionOpen = true"
                  >
                    <Icon name="plus" :size="12" />
                    <span>Add Option</span>
                  </Button>
                </div>
              </div>

              <!-- Draggable Options List -->
              <div class="agent-options-drag-list flex flex-col gap-2">
                <div
                  v-for="(opt, idx) in selectedAgent.workOptions"
                  :key="opt.engine + opt.model + idx"
                  class="agent-option-row p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-3 transition-all select-none"
                  :class="[
                    draggedOptionIndex === idx ? 'opacity-40 border-dashed border-[var(--accent-primary)] bg-[var(--bg-surface)]' : '',
                    dragOverOptionIndex === idx ? 'border-t-2 border-t-[var(--accent-primary)] bg-[var(--accent-bg)]' : '',
                    selectedAgent.status === 'active' ? 'cursor-grab active:cursor-grabbing' : ''
                  ]"
                  :draggable="selectedAgent.status === 'active'"
                  :data-index="idx"
                  @dragstart="handleDragStart(idx, $event)"
                  @dragover="handleDragOver(idx, $event)"
                  @dragleave="handleDragLeave(idx)"
                  @drop="handleDrop(idx, $event)"
                  @dragend="handleDragEnd"
                  @keydown.up.prevent="moveOption(idx, idx - 1)"
                  @keydown.down.prevent="moveOption(idx, idx + 1)"
                >
                  <!-- Left: Drag handle + option info -->
                  <div class="agent-option-info flex items-center gap-2.5 min-w-0 flex-wrap flex-1">
                    <div
                      v-if="selectedAgent.status === 'active'"
                      class="drag-handle-wrap cursor-grab active:cursor-grabbing p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors"
                      tabindex="0"
                      role="button"
                      :title="`Drag or press Up/Down arrows to reorder priority for ${opt.engine}`"
                      :aria-label="`Reorder priority for ${opt.engine} option`"
                      @keydown.up.prevent="moveOption(idx, idx - 1)"
                      @keydown.down.prevent="moveOption(idx, idx + 1)"
                    >
                      <Icon name="grip-vertical" :size="14" />
                    </div>

                    <Badge :variant="idx === 0 ? 'info' : 'secondary'" class="text-[10px] font-bold shrink-0">
                      Priority {{ idx + 1 }}{{ idx === 0 ? ' (Primary)' : ' (Fallback)' }}
                    </Badge>

                    <strong class="text-xs font-bold text-[var(--text-primary)]">{{ opt.engine.toUpperCase() }}</strong>

                    <span class="text-xs text-[var(--text-secondary)] font-mono truncate">
                      Model: <code class="text-[var(--accent-primary)]">{{ opt.model }}</code>
                    </span>

                    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--purple-agent-bg)] text-[var(--purple-agent)] border border-[var(--purple-agent-border)] shrink-0">
                      Effort: {{ opt.effort }}
                    </span>

                    <Badge :variant="opt.isConfigured ? 'success' : 'danger'" class="text-[10px] shrink-0">
                      {{ opt.isConfigured ? 'Configured & Ready' : 'Missing' }}
                    </Badge>
                  </div>

                  <!-- Right: Action buttons (Up/Down for touch & accessibility + Delete) -->
                  <div v-if="selectedAgent.status === 'active'" class="agent-option-actions flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="xs"
                      class="move-opt-up-btn h-7 w-7 p-0 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      :disabled="idx === 0"
                      title="Move priority up"
                      :aria-label="`Move ${opt.engine} priority up`"
                      @click.stop="moveOption(idx, idx - 1)"
                    >
                      <Icon name="arrow-up" :size="12" />
                    </Button>

                    <Button
                      variant="ghost"
                      size="xs"
                      class="move-opt-down-btn h-7 w-7 p-0 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      :disabled="idx === selectedAgent.workOptions.length - 1"
                      title="Move priority down"
                      :aria-label="`Move ${opt.engine} priority down`"
                      @click.stop="moveOption(idx, idx + 1)"
                    >
                      <Icon name="arrow-down" :size="12" />
                    </Button>

                    <Button
                      variant="ghost"
                      size="xs"
                      class="delete-opt-btn h-7 w-7 p-0 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--red-action)]"
                      :disabled="selectedAgent.workOptions.length <= 1"
                      :title="selectedAgent.workOptions.length <= 1 ? 'An Agent must have at least one work option' : 'Remove Option'"
                      aria-label="Remove Option"
                      @click.stop="deleteOption(idx)"
                    >
                      <Icon name="trash" :size="12" />
                    </Button>
                  </div>
                </div>

                <div v-if="selectedAgent.workOptions.length === 0" class="text-xs text-[var(--text-muted)] italic py-2 text-center">
                  No work options configured for this persona.
                </div>
              </div>

              <!-- Pre-Acceptance Fallback & No-Replay Guarantee Card -->
              <div class="agent-fallback-box p-3 rounded-[var(--radius-sm)] border border-[var(--accent-border)] bg-[var(--bg-surface-elevated)] flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                <div class="flex items-center gap-1.5 text-[var(--accent-primary)] font-bold">
                  <Icon name="shield" :size="14" />
                  <span>Pre-Acceptance Fallback & No-Silent-Replay Guarantee</span>
                </div>
                <p class="leading-relaxed">
                  1. <strong>Pre-Acceptance Fallback</strong>: At run admission, Sprout takes the first configured option permitted and authenticated on the target host.
                </p>
                <p class="leading-relaxed">
                  2. <strong>No Silent Replay</strong>: Once an engine accepts the run, any later failure reports directly. Sprout <em>never</em> silently replays work through lower-priority options because tools may have caused irreversible side effects.
                </p>
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
            <Foldable title="Attribution & Historical Contribution Trace" subtext="Non-destructive historical attribution">
              <p class="text-[11px] text-[var(--text-secondary)] py-1">
                Completed 42 runs across Project Sprout M2. Historical runs retain persistent attribution even if this persona is subsequently archived.
              </p>
            </Foldable>
          </div>
        </div>
      </div>
    </div>
    <!-- Create Agent Modal -->
    <Dialog
      :open="isCreateAgentOpen"
      title="Create Global Agent Definition"
      description="Agent identity is portable across Projects and Environments with ordered work options."
      @update:open="isCreateAgentOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="flex flex-col gap-1">
          <label for="new-agent-name" class="font-bold text-[var(--text-primary)]">Display Name *</label>
          <input
            id="new-agent-name"
            v-model="newAgentName"
            type="text"
            placeholder="e.g. Quality Engineer, Security Analyst"
            class="px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="new-agent-role" class="font-bold text-[var(--text-primary)]">Role & Responsibilities</label>
          <input
            id="new-agent-role"
            v-model="newAgentRole"
            type="text"
            placeholder="e.g. End-to-end integration testing and regression analysis"
            class="px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
          />
        </div>

        <div class="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <div class="flex flex-col gap-1">
            <label for="new-agent-engine" class="font-bold text-[var(--text-primary)]">Engine</label>
            <select
              id="new-agent-engine"
              v-model="newAgentEngine"
              class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
            >
              <option value="Pi">Pi</option>
              <option value="Codex">Codex</option>
              <option value="agy">agy</option>
              <option value="opencode">opencode</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="new-agent-model" class="font-bold text-[var(--text-primary)]">Work Model</label>
            <input
              id="new-agent-model"
              v-model="newAgentModel"
              type="text"
              class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
            />
          </div>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" class="cancel-create-agent-btn" @click="isCreateAgentOpen = false">
          Cancel
        </Button>
        <Button variant="primary" size="sm" class="confirm-create-agent-btn" :disabled="!newAgentName.trim()" @click="handleCreateAgent">
          Create Agent
        </Button>
      </template>
    </Dialog>

    <!-- Agent Guide Modal -->
    <Dialog
      :open="isAgentGuideOpen"
      title="Agent Identity & Work Options Architecture"
      description="Portable Multi-Agent Personas and Pre-Acceptance Execution Policies"
      @update:open="isAgentGuideOpen = $event"
    >
      <div class="space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed max-h-[60vh] overflow-y-auto pr-1">
        <div>
          <strong class="text-[var(--text-primary)] block mb-0.5">1. Portable Identity Independent of Project & Environment</strong>
          <p>An Agent is created independently of any Project or Environment. It requires a stable ID, display name, and ordered work options. Private memory persists across project assignments.</p>
        </div>
        <div>
          <strong class="text-[var(--text-primary)] block mb-0.5">2. Ordered Execution Preferences (Work Options)</strong>
          <p>Each option specifies an execution engine (Codex, Pi, agy, opencode) and work model with effort parameter.</p>
        </div>
        <div>
          <strong class="text-[var(--text-primary)] block mb-0.5">3. Pre-Acceptance Fallback vs No-Silent-Replay</strong>
          <p>At run admission, Sprout evaluates available engines on the target host. Fallback occurs strictly before an engine accepts work. Once accepted, later failures report directly without silent replay.</p>
        </div>
        <div>
          <strong class="text-[var(--text-primary)] block mb-0.5">4. Historical Attribution & Archiving</strong>
          <p>Archiving an Agent safely stops new run admission while permanently preserving historical task attributions and collaboration records.</p>
        </div>
      </div>

      <template #footer>
        <Button variant="primary" size="sm" class="close-agent-guide-btn" @click="isAgentGuideOpen = false">
          Close Guide
        </Button>
      </template>
    </Dialog>

    <!-- Add Work Option Modal -->
    <Dialog
      :open="isAddOptionOpen"
      :title="`Add Work Option (Priority ${selectedAgent ? selectedAgent.workOptions.length + 1 : 1})`"
      description="Configure an execution fallback option. Sprout evaluates options in priority order at run admission."
      @update:open="isAddOptionOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="flex flex-col gap-1">
          <label for="add-opt-engine" class="font-bold text-[var(--text-primary)]">Engine *</label>
          <select
            id="add-opt-engine"
            v-model="newOptionEngine"
            class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
          >
            <option value="Pi">Pi</option>
            <option value="Codex">Codex</option>
            <option value="agy">agy</option>
            <option value="opencode">opencode</option>
          </select>
        </div>

        <div class="flex flex-col gap-1">
          <label for="add-opt-model" class="font-bold text-[var(--text-primary)]">Work Model *</label>
          <input
            id="add-opt-model"
            v-model="newOptionModel"
            type="text"
            placeholder="e.g. claude-3-7-sonnet"
            class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="add-opt-effort" class="font-bold text-[var(--text-primary)]">Reasoning Effort</label>
          <select
            id="add-opt-effort"
            v-model="newOptionEffort"
            class="px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
          >
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
            <option value="default">default</option>
          </select>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" class="cancel-add-option-btn" @click="isAddOptionOpen = false">
          Cancel
        </Button>
        <Button variant="primary" size="sm" class="confirm-add-option-btn" :disabled="!newOptionModel.trim()" @click="handleAddOption">
          Add Option
        </Button>
      </template>
    </Dialog>
  </div>
</template>
