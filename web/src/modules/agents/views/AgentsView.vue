<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type {
  AgentFilter,
  AgentInstance,
  AgentRunAttributionRow,
  CreateAgentInput,
  ReconfigureAgentInput,
} from '../types.js';
import { AGENT_SERVICE } from '../types.js';
import {
  createAgentControlBoundary,
  AgentControlRefused,
} from '../control-boundary.js';
import { useShellConnection } from '../../../shell/use-shell-connection.js';
import { useAnnouncer } from '../../../primitives/announcer.js';
import FilterPillGroup from '../../../primitives/FilterPillGroup.vue';
import FilterPill from '../../../primitives/FilterPill.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import EmptyState from '../../../primitives/EmptyState.vue';
import AgentMasterList from '../components/AgentMasterList.vue';
import AgentDetail from '../components/AgentDetail.vue';
import CreateAgentDialog from '../components/CreateAgentDialog.vue';
import EditAgentDialog from '../components/EditAgentDialog.vue';
import EditInstructionsDialog from '../components/EditInstructionsDialog.vue';
import AddWorkOptionDialog from '../components/AddWorkOptionDialog.vue';
import ArchiveAgentDialog from '../components/ArchiveAgentDialog.vue';
import AgentGuideDialog from '../components/AgentGuideDialog.vue';
import MobileDetailHeader from '../../../shell/MobileDetailHeader.vue';

/**
 * The production Manage / Agents page (#91).
 *
 * The page's authority is injected by the bootstrap and, in deterministic
 * tests only, passed explicitly. A missing authority is an explicit
 * unavailable state; the route never constructs a fixture adapter of its own.
 * Every mutation goes through the typed control boundary, so an unsettled
 * connection refuses the action immediately instead of queueing it.
 */
const props = defineProps<{
  service?: import('../types.js').AgentManagementService;
}>();

const injectedService = inject<import('../types.js').AgentManagementService | undefined>(AGENT_SERVICE, undefined);
const activeService = computed(() => props.service ?? injectedService);
const hasAuthority = computed(() => activeService.value !== undefined);

const route = useRoute();
const router = useRouter();
const announcer = useAnnouncer();

// The Shell owns the connection fact; the page reads the same typed port so a
// control action is refused while the connection is unsettled rather than queued.
const presentation = useShellConnection().presentation;
const controlAvailable = computed(() => presentation.value.controlAvailable);
const controlsDisabled = computed(() => hasAuthority.value && !controlAvailable.value);

const controlBoundary = createAgentControlBoundary({
  service: () => activeService.value,
  presentation: () => presentation.value,
});

const agents = ref<AgentInstance[]>([]);
const attributions = ref<AgentRunAttributionRow[]>([]);
const activeFilter = ref<AgentFilter>('all');
const isLoading = ref(true);
const loadFailed = ref(false);

// Dialog state
const isCreateOpen = ref(false);
const isGuideOpen = ref(false);
const isEditOpen = ref(false);
const isEditInstructionsOpen = ref(false);
const isAddOptionOpen = ref(false);
const isArchiveOpen = ref(false);

// The last typed refusal per dialog, rendered inline and announced.
const createError = ref('');
const editError = ref('');
const instructionsError = ref('');
const addOptionError = ref('');
const archiveError = ref('');

async function loadData() {
  const service = activeService.value;
  if (service === undefined) {
    agents.value = [];
    attributions.value = [];
    isLoading.value = false;
    return;
  }
  isLoading.value = true;
  loadFailed.value = false;
  try {
    const [rows, runs] = await Promise.all([service.listAgents(), service.listRunAttributions()]);
    agents.value = [...rows];
    attributions.value = runs;
  } catch {
    // A failed read is an honest unavailable state, never fixture data.
    loadFailed.value = true;
  }
  isLoading.value = false;
}

onMounted(() => {
  loadData();
});

/** Runs one control action, or refuses it immediately through the typed boundary. */
async function runControl(action: (service: import('../types.js').AgentManagementService) => Promise<void>): Promise<boolean> {
  try {
    await controlBoundary.run(action);
    await loadData();
    return true;
  } catch (error) {
    if (error instanceof AgentControlRefused) {
      announcer.announce(error.message);
      return false;
    }
    throw error;
  }
}

// --- Filter counts and filtering ---

const allCount = computed(() => agents.value.length);
const activeCount = computed(() => agents.value.filter((a) => a.status === 'active').length);
const attentionCount = computed(
  () => agents.value.filter((a) => a.status === 'active' && a.trafficLight === 'yellow').length
);
const unavailableCount = computed(
  () => agents.value.filter((a) => a.status === 'active' && a.trafficLight === 'red').length
);
const archivedCount = computed(() => agents.value.filter((a) => a.status === 'archived').length);

const filteredAgents = computed(() => {
  const filter = activeFilter.value;
  return agents.value.filter((agent) => {
    if (filter === 'all') return true;
    if (filter === 'active') return agent.status === 'active';
    if (filter === 'archived') return agent.status === 'archived';
    if (agent.status !== 'active') return false;
    if (filter === 'attention') return agent.trafficLight === 'yellow';
    if (filter === 'unavailable') return agent.trafficLight === 'red';
    return true;
  });
});

// --- Selection and URL addressability ---

/** The record the URL names, or '' when the destination itself is addressed. */
const deepLinkId = computed(() =>
  typeof route.params['agentId'] === 'string' ? (route.params['agentId'] as string) : ''
);

const deepLinkMissing = computed(
  () => deepLinkId.value !== '' && !isLoading.value && !agents.value.some((a) => a.id === deepLinkId.value)
);

const selectedAgent = computed<AgentInstance | undefined>(() => {
  if (deepLinkId.value !== '') {
    return agents.value.find((a) => a.id === deepLinkId.value);
  }
  return (
    agents.value.find((a) => a.id === selectedId.value) ??
    filteredAgents.value[0] ??
    agents.value[0]
  );
});

const selectedId = ref<string>('');

function handleSelectAgent(id: string) {
  selectedId.value = id;
  // Push the route so phone drills down and the record is URL-addressable.
  router.push({ name: 'agent-detail', params: { agentId: id } });
}

watch(
  () => route.params['agentId'],
  (newId) => {
    if (typeof newId === 'string' && newId !== '') selectedId.value = newId;
  }
);

const isMobileDetailRoute = computed(() => !!route.params['agentId']);

// --- Control actions ---

async function handleCreate(input: CreateAgentInput) {
  createError.value = '';
  const done = await runControl((service) => service.createAgent(input));
  if (done) {
    isCreateOpen.value = false;
    announcer.announce(`Agent ${input.displayName} created.`);
  } else {
    createError.value = presentation.value.announce;
  }
}

async function handleEditIdentity(agent: AgentInstance, displayName: string) {
  editError.value = '';
  const input: ReconfigureAgentInput = { workOptions: currentOptionInputs(agent), displayName };
  const done = await runControl((service) => service.reconfigureAgent(agent.id, input));
  if (done) {
    isEditOpen.value = false;
    announcer.announce(`Agent ${displayName} updated as a new configuration version.`);
  } else {
    editError.value = presentation.value.announce;
  }
}

async function handleEditInstructions(agent: AgentInstance, instructions: string | null) {
  instructionsError.value = '';
  const input: ReconfigureAgentInput = {
    workOptions: currentOptionInputs(agent),
    instructions,
    reason: 'Standing instructions updated.',
  };
  const done = await runControl((service) => service.reconfigureAgent(agent.id, input));
  if (done) {
    isEditInstructionsOpen.value = false;
    announcer.announce('Standing instructions updated as a new configuration version.');
  } else {
    instructionsError.value = presentation.value.announce;
  }
}

async function handleAddOption(
  agent: AgentInstance,
  option: { engine: string; workModel: string; effort: string }
) {
  addOptionError.value = '';
  const input: ReconfigureAgentInput = {
    workOptions: [...currentOptionInputs(agent), option],
    reason: `Added ${option.engine} work option as priority ${agent.workOptions.length + 1}.`,
  };
  const done = await runControl((service) => service.reconfigureAgent(agent.id, input));
  if (done) {
    isAddOptionOpen.value = false;
    announcer.announce(`Work option added at priority ${agent.workOptions.length + 1}.`);
  } else {
    addOptionError.value = presentation.value.announce;
  }
}

async function handleMoveOption(agent: AgentInstance, from: number, to: number) {
  if (from < 0 || to < 0 || from >= agent.workOptions.length || to >= agent.workOptions.length) return;
  const reordered = [...agent.workOptions];
  const [moved] = reordered.splice(from, 1);
  if (moved === undefined) return;
  reordered.splice(to, 0, moved);
  const input: ReconfigureAgentInput = {
    workOptions: reordered.map((option) => ({
      id: option.id,
      engine: option.engine,
      workModel: option.workModel,
      effort: option.effort,
    })),
    reason: `Reordered work options: ${moved.engine} moved from priority ${from + 1} to priority ${to + 1}.`,
  };
  const done = await runControl((service) => service.reconfigureAgent(agent.id, input));
  if (done) {
    announcer.announce(`${moved.engine.toUpperCase()} moved to priority ${to + 1}.`);
  }
}

async function handleRemoveOption(agent: AgentInstance, optionId: string) {
  if (agent.workOptions.length <= 1) return; // minimum-one-option invariant (ADR-0008)
  const option = agent.workOptions.find((candidate) => candidate.id === optionId);
  const input: ReconfigureAgentInput = {
    workOptions: agent.workOptions
      .filter((candidate) => candidate.id !== optionId)
      .map((candidate) => ({
        id: candidate.id,
        engine: candidate.engine,
        workModel: candidate.workModel,
        effort: candidate.effort,
      })),
    reason: `Removed the ${option?.engine ?? 'selected'} work option.`,
  };
  const done = await runControl((service) => service.reconfigureAgent(agent.id, input));
  if (done) announcer.announce('Work option removed.');
}

async function handleArchive(agent: AgentInstance) {
  archiveError.value = '';
  try {
    await controlBoundary.run((service) => service.archiveAgent(agent.id));
  } catch (error) {
    if (error instanceof AgentControlRefused) {
      archiveError.value = error.message;
      announcer.announce(error.message);
      return;
    }
    // The backend's typed safety-guard refusal (ADR-0008) is the dialog's
    // inline error; the state is unchanged and the dialog stays open.
    archiveError.value = error instanceof Error ? error.message : 'The archive action was refused.';
    announcer.announce(archiveError.value);
    return;
  }
  isArchiveOpen.value = false;
  await loadData();
  announcer.announce(`Agent ${agent.displayName} archived. Nothing was deleted.`);
}

async function handleRestore(agent: AgentInstance) {
  const done = await runControl((service) => service.restoreAgent(agent.id));
  if (done) announcer.announce(`Agent ${agent.displayName} restored.`);
}

function currentOptionInputs(agent: AgentInstance) {
  return agent.workOptions.map((option) => ({
    id: option.id,
    engine: option.engine,
    workModel: option.workModel,
    effort: option.effort,
  }));
}
</script>

<template>
  <div class="view-container agents-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- Mobile Drill-Down Header (phone detail route) -->
    <MobileDetailHeader
      v-if="isMobileDetailRoute && selectedAgent"
      :title="selectedAgent.displayName"
      :traffic-light="selectedAgent.trafficLight"
      :back-to="{ name: 'agents' }"
      back-control-id="btn-back-to-agents"
      back-label="Back to Agents"
    />

    <!-- Standard Header & Filter Bar (desktop always; phone list mode only) -->
    <div
      class="agents-header-card p-4 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex-col gap-3"
      :class="isMobileDetailRoute ? 'hidden md:flex' : 'flex'"
    >
      <div class="agents-header-top-row flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
        <h2 class="text-sm sm:text-base font-bold text-[var(--text-primary)] flex items-center gap-2 truncate">
          <Icon name="agents" :size="18" />
          <span>Agents & Work Option Preferences</span>
        </h2>

        <div v-if="hasAuthority" class="flex items-center gap-2 shrink-0">
          <Button
            id="btn-create-agent"
            variant="primary"
            size="icon"
            class="create-agent-btn icon-only-btn"
            title="Create New Agent"
            aria-label="Create New Agent"
            :disabled="controlsDisabled"
            @click="isCreateOpen = true"
          >
            <Icon name="plus" :size="14" />
          </Button>

          <Button
            id="btn-agent-guide"
            variant="secondary"
            size="icon"
            class="agent-guide-btn icon-only-btn"
            title="Agent Architecture Guide"
            aria-label="Agent Architecture Guide"
            @click="isGuideOpen = true"
          >
            <Icon name="guide" :size="14" />
          </Button>
        </div>
      </div>

      <!-- Filter Row: the five status boxes; no search input (prototype decision) -->
      <FilterPillGroup aria-label="Filter agents by status and readiness">
        <FilterPill
          filter-key="all"
          label="All"
          :count="allCount"
          status="purple"
          :active="activeFilter === 'all'"
          @click="activeFilter = 'all'"
        />
        <FilterPill
          filter-key="active"
          label="Active"
          :count="activeCount"
          status="green"
          :active="activeFilter === 'active'"
          @click="activeFilter = 'active'"
        />
        <FilterPill
          filter-key="attention"
          label="Attention"
          :count="attentionCount"
          status="yellow"
          :active="activeFilter === 'attention'"
          @click="activeFilter = 'attention'"
        />
        <FilterPill
          filter-key="unavailable"
          label="Unavailable"
          :count="unavailableCount"
          status="red"
          :active="activeFilter === 'unavailable'"
          @click="activeFilter = 'unavailable'"
        />
        <FilterPill
          filter-key="archived"
          label="Archived"
          :count="archivedCount"
          status="neutral"
          :active="activeFilter === 'archived'"
          @click="activeFilter = 'archived'"
        />
      </FilterPillGroup>
    </div>

    <!-- Layout: desktop split vs phone drill-down -->
    <div class="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 w-full max-w-[1920px] mx-auto">
      <!-- No authority: the production route requires a typed adapter and never
           substitutes fixture facts for missing production wiring. -->
      <div v-if="!hasAuthority" class="agents-unavailable-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="agents"
          title="Agent Authority Unavailable"
          description="This page has no Agent service configured, so it cannot show or change live Agent identities."
        />
      </div>

      <!-- Loading State -->
      <div
        v-else-if="isLoading"
        class="agents-loading-state flex flex-col items-center justify-center p-12 text-center h-64 gap-3"
      >
        <Icon name="refresh" class="animate-spin text-[var(--accent-primary)]" :size="28" />
        <span class="text-sm font-semibold text-[var(--text-primary)]">Loading Agents & Work Options</span>
        <span class="text-xs text-[var(--text-muted)]">Reading durable identities and Environment compatibility facts...</span>
      </div>

      <!-- Failed load: honest unavailable, never fixture substitution -->
      <div v-else-if="loadFailed" class="agents-load-failed-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="alert"
          title="Agents Unavailable"
          description="The Agent identities could not be read. Retry when the connection is stable."
        >
          <Button variant="primary" size="sm" class="agents-retry-btn text-xs" :disabled="!controlAvailable" @click="loadData">
            <span>Retry</span>
          </Button>
        </EmptyState>
      </div>

      <!-- Missing deep link: never substitute another record for the requested id. -->
      <div v-else-if="deepLinkMissing" class="agents-not-found-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="alert"
          title="Agent Not Found"
          description="No Agent matches this URL. Choose an Agent from the list instead."
        >
          <Button
            variant="primary"
            size="sm"
            class="agents-not-found-return text-xs"
            @click="router.push({ name: 'agents' })"
          >
            <span>Back to Agents</span>
          </Button>
        </EmptyState>
      </div>

      <!-- Empty State: no Agents at all -->
      <div v-else-if="agents.length === 0" class="agents-empty-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="agents"
          title="No Agents Created"
          description="Create the first portable Agent identity to give it ordered work options and standing instructions."
        >
          <Button variant="primary" size="sm" class="mt-3" :disabled="controlsDisabled" @click="isCreateOpen = true">
            <Icon name="plus" :size="13" />
            <span>Create New Agent</span>
          </Button>
        </EmptyState>
      </div>

      <template v-else>
        <!-- Desktop 2-column split (md+) -->
        <div class="agents-split-layout hidden md:flex gap-4 h-full">
          <div class="agents-master-column w-80 lg:w-96 overflow-y-auto shrink-0 pr-1">
            <AgentMasterList
              :agents="filteredAgents"
              :selected-id="selectedAgent?.id"
              @select="handleSelectAgent"
            />
          </div>

          <div class="agents-detail-column flex-1 overflow-y-auto pl-1">
            <AgentDetail
              v-if="selectedAgent"
              :agent="selectedAgent"
              :attributions="attributions"
              :disabled="controlsDisabled"
              @edit="(agent) => (isEditOpen = true)"
              @edit-instructions="(agent) => (isEditInstructionsOpen = true)"
              @add-option="(agent) => (isAddOptionOpen = true)"
              @move-option="(payload) => handleMoveOption(payload.agent, payload.from, payload.to)"
              @remove-option="(payload) => handleRemoveOption(payload.agent, payload.optionId)"
              @archive="(agent) => ((archiveError = ''), (isArchiveOpen = true))"
              @restore="handleRestore"
            />
            <div v-else class="p-8 text-center text-xs text-[var(--text-muted)]">
              No Agent matches the active filter.
            </div>
          </div>
        </div>

        <!-- Phone: master list or drilled-down detail -->
        <div class="md:hidden">
          <div v-if="isMobileDetailRoute && selectedAgent" class="agents-mobile-detail-wrapper">
            <AgentDetail
              :agent="selectedAgent"
              :attributions="attributions"
              :disabled="controlsDisabled"
              @edit="(agent) => (isEditOpen = true)"
              @edit-instructions="(agent) => (isEditInstructionsOpen = true)"
              @add-option="(agent) => (isAddOptionOpen = true)"
              @move-option="(payload) => handleMoveOption(payload.agent, payload.from, payload.to)"
              @remove-option="(payload) => handleRemoveOption(payload.agent, payload.optionId)"
              @archive="(agent) => ((archiveError = ''), (isArchiveOpen = true))"
              @restore="handleRestore"
            />
          </div>

          <div v-else class="agents-master-list mobile-full">
            <AgentMasterList
              :agents="filteredAgents"
              :selected-id="selectedAgent?.id"
              @select="handleSelectAgent"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- Dialogs -->
    <CreateAgentDialog
      v-if="hasAuthority"
      :open="isCreateOpen"
      :error="createError"
      :disabled="controlsDisabled"
      @update:open="isCreateOpen = $event"
      @confirm="handleCreate"
    />

    <AgentGuideDialog :open="isGuideOpen" @update:open="isGuideOpen = $event" />

    <EditAgentDialog
      v-if="selectedAgent"
      :open="isEditOpen"
      :agent="selectedAgent"
      :error="editError"
      :disabled="controlsDisabled"
      @update:open="isEditOpen = $event"
      @confirm="(payload) => handleEditIdentity(selectedAgent!, payload.displayName)"
    />

    <EditInstructionsDialog
      v-if="selectedAgent"
      :open="isEditInstructionsOpen"
      :agent="selectedAgent"
      :error="instructionsError"
      :disabled="controlsDisabled"
      @update:open="isEditInstructionsOpen = $event"
      @confirm="(payload) => handleEditInstructions(selectedAgent!, payload.instructions)"
    />

    <AddWorkOptionDialog
      v-if="selectedAgent"
      :open="isAddOptionOpen"
      :agent="selectedAgent"
      :error="addOptionError"
      :disabled="controlsDisabled"
      @update:open="isAddOptionOpen = $event"
      @confirm="(payload) => handleAddOption(selectedAgent!, payload)"
    />

    <ArchiveAgentDialog
      v-if="selectedAgent"
      :open="isArchiveOpen"
      :agent="selectedAgent"
      :error="archiveError"
      :disabled="controlsDisabled"
      @update:open="isArchiveOpen = $event"
      @confirm="handleArchive"
    />
  </div>
</template>
