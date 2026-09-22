<script setup lang="ts">
import { ref, computed, onMounted, watch, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { EnvironmentFilter, EnvironmentInstance, ForceReleaseParams } from '../types.js';
import { ENVIRONMENT_SERVICE, type EnvironmentService } from '../ports.js';
import {
  createEnvironmentControlBoundary,
  EnvironmentControlRefused,
} from '../control-boundary.js';
import { useShellConnection } from '../../../shell/use-shell-connection.js';
import { useAnnouncer } from '../../../primitives/announcer.js';
import FilterPillGroup from '../../../primitives/FilterPillGroup.vue';
import FilterPill from '../../../primitives/FilterPill.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import EmptyState from '../../../primitives/EmptyState.vue';
import EnvironmentMasterList from '../components/EnvironmentMasterList.vue';
import EnvironmentDetail from '../components/EnvironmentDetail.vue';
import ForceReleaseDialog from '../components/ForceReleaseDialog.vue';
import BootstrapGuideDialog from '../components/BootstrapGuideDialog.vue';
import RegisterHostDialog from '../components/RegisterHostDialog.vue';
import MobileDetailHeader from '../../../shell/MobileDetailHeader.vue';

/**
 * The page's authority is injected by the bootstrap and, in deterministic tests
 * only, passed explicitly. A missing authority is an explicit unavailable state;
 * the route never constructs a fixture adapter of its own.
 */
const props = defineProps<{
  service?: EnvironmentService;
}>();

const injectedService = inject<EnvironmentService | undefined>(ENVIRONMENT_SERVICE, undefined);
const activeService = computed(() => props.service ?? injectedService);
const hasAuthority = computed(() => activeService.value !== undefined);

const route = useRoute();
const router = useRouter();
const announcer = useAnnouncer();

// The Shell owns the connection fact; the page reads the same typed port so a
// control action is refused while the connection is unsettled rather than queued.
const presentation = useShellConnection().presentation;
const controlAvailable = computed(() => presentation.value.controlAvailable);
/** True while an authority exists but the connection cannot carry a control action. */
const controlsDisabled = computed(() => hasAuthority.value && !controlAvailable.value);

const controlBoundary = createEnvironmentControlBoundary({
  service: () => activeService.value,
  presentation: () => presentation.value,
});

/** Runs a control action, or refuses it immediately through the typed boundary. */
async function runControl<T>(action: (service: EnvironmentService) => Promise<T>): Promise<void> {
  try {
    await controlBoundary.run(action);
    await loadData();
  } catch (error) {
    if (error instanceof EnvironmentControlRefused) {
      announcer.announce(error.message);
      return;
    }
    throw error;
  }
}

const environments = ref<EnvironmentInstance[]>([]);
const activeFilter = ref<EnvironmentFilter>('all');
const selectedId = ref<string>('env-ready');
const isLoading = ref(true);

const isForceReleaseOpen = ref(false);
const isGuideOpen = ref(false);
const isRegisterOpen = ref(false);

async function loadData() {
  const service = activeService.value;
  if (service === undefined) {
    environments.value = [];
    isLoading.value = false;
    return;
  }
  isLoading.value = true;
  environments.value = await service.listEnvironments();
  if (route.params.id && typeof route.params.id === 'string') {
    selectedId.value = route.params.id;
  } else if (!selectedId.value || !environments.value.some((e) => e.id === selectedId.value)) {
    selectedId.value = environments.value[0]?.id ?? '';
  }
  isLoading.value = false;
}

onMounted(() => {
  loadData();
});

watch(
  () => route.params.id,
  (newId) => {
    if (newId && typeof newId === 'string') {
      selectedId.value = newId;
    }
  }
);

// Filter counts
const allCount = computed(() => environments.value.length);
const readyCount = computed(
  () => environments.value.filter((e) => e.trafficLight === 'green' && e.enrollmentStatus === 'approved').length
);
const attentionCount = computed(
  () => environments.value.filter((e) => e.trafficLight === 'yellow' && e.enrollmentStatus !== 'archived').length
);
const actionRequiredCount = computed(
  () => environments.value.filter((e) => e.trafficLight === 'red').length
);
const archivedCount = computed(
  () => environments.value.filter((e) => e.enrollmentStatus === 'archived').length
);

// Filtered environments
const filteredEnvironments = computed(() => {
  const f = activeFilter.value;
  return environments.value.filter((e) => {
    if (f === 'ready') return e.trafficLight === 'green' && e.enrollmentStatus === 'approved';
    if (f === 'attention') return e.trafficLight === 'yellow' && e.enrollmentStatus !== 'archived';
    if (f === 'action-required') return e.trafficLight === 'red';
    if (f === 'archived') return e.enrollmentStatus === 'archived';
    return true;
  });
});

/** The record the URL names, or '' when the destination itself is addressed. */
const deepLinkId = computed(() =>
  typeof route.params['id'] === 'string' ? (route.params['id'] as string) : ''
);

/**
 * A deep link to an id that does not exist. It is never satisfied by another
 * record: the page renders an explicit not-found state instead of substituting
 * the first environment and risking a mutation against the wrong record.
 */
const deepLinkMissing = computed(
  () => deepLinkId.value !== '' && !environments.value.some((e) => e.id === deepLinkId.value)
);

const selectedEnv = computed(() => {
  if (deepLinkId.value !== '') {
    return environments.value.find((e) => e.id === deepLinkId.value);
  }
  return (
    environments.value.find((e) => e.id === selectedId.value) ??
    filteredEnvironments.value[0] ??
    environments.value[0]
  );
});

// Mobile drill-down detection: route contains :id
const isMobileDetailRoute = computed(() => !!route.params.id);

function handleSelectEnvironment(id: string) {
  selectedId.value = id;
  // Push route so phone drills down and the record is URL-addressable.
  router.push({ name: 'environment-detail', params: { id } });
}

async function handleApprove(id: string) {
  await runControl((service) => service.approveEnrollment(id));
}

async function handleProbe(id: string) {
  await runControl((service) => service.triggerProbe(id));
}

async function handleTogglePermission(cap: any) {
  const env = selectedEnv.value;
  if (!env) return;
  await runControl((service) => service.togglePermission(env.id, cap));
}

async function handleUnbindWorkspace(payload: { projectId: string; envId: string }) {
  await runControl((service) => service.unbindWorkspace(payload.projectId, payload.envId));
}

async function handleReconcile(id: string) {
  await runControl((service) => service.reconcileEvidence(id));
}

async function handleResume(taskId: string) {
  await runControl((service) => service.resumeRecovery(taskId));
}

async function handleDiscard(taskId: string) {
  await runControl((service) => service.discardRecovery(taskId));
}

function handleOpenForceRelease(_id: string) {
  isForceReleaseOpen.value = true;
}

async function handleConfirmForceRelease(params: ForceReleaseParams) {
  try {
    await controlBoundary.run((service) => service.forceRelease(params));
  } catch (error) {
    if (error instanceof EnvironmentControlRefused) {
      isForceReleaseOpen.value = false;
      announcer.announce(error.message);
      return;
    }
    throw error;
  }
  isForceReleaseOpen.value = false;
  await loadData();
}

async function handleArchive(id: string) {
  await runControl((service) => service.archiveEnvironment(id));
}

async function handleRestore(id: string) {
  await runControl((service) => service.restoreEnvironment(id));
}

async function handleUnenroll(id: string) {
  if (
    controlAvailable.value &&
    confirm(`Revoke identity key for ${selectedEnv.value?.displayName}? Worker will be barred from reconnecting.`)
  ) {
    await runControl((service) => service.unenrollEnvironment(id));
  }
}

/**
 * Retained settlement evidence is a Worker fact (ADR-0009). The page offers the
 * reconcile action only when the injected authority really reaches a Worker
 * evidence port; production never does, so its reconciling box renders
 * read-only with an explicit not-synchronized state instead of a button.
 */
const canReconcileEvidence = computed(() => activeService.value?.supportsEvidenceReconciliation === true);
</script>

<template>
  <div class="view-container environments-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- Mobile Drill-Down Header (when active on small screens) -->
    <MobileDetailHeader
      v-if="isMobileDetailRoute && selectedEnv"
      :title="selectedEnv.displayName"
      :traffic-light="selectedEnv.trafficLight"
      :back-to="{ name: 'environments' }"
      back-control-id="btn-back-to-envs"
      back-label="Back to Environments"
    />

    <!-- Standard Header & Filter Bar (always shown on desktop, shown on mobile when not drilled down) -->
    <div
      class="envs-header-card p-4 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex-col gap-3"
      :class="isMobileDetailRoute ? 'hidden md:flex' : 'flex'"
    >
      <div class="envs-header-top-row flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
        <h2 class="text-sm sm:text-base font-bold text-[var(--text-primary)] flex items-center gap-2 truncate">
          <Icon name="environments" :size="18" />
          <span>Environments & Host Infrastructure</span>
        </h2>

        <div v-if="hasAuthority" class="flex items-center gap-2 shrink-0">
          <Button
            id="btn-register-host"
            variant="primary"
            size="icon"
            class="register-host-btn icon-only-btn"
            title="Register New Host"
            aria-label="Register New Host"
            @click="isRegisterOpen = true"
          >
            <Icon name="plus" :size="14" />
          </Button>

          <Button
            id="btn-host-guide"
            variant="secondary"
            size="icon"
            class="host-guide-btn icon-only-btn"
            title="Host Bootstrap Guide"
            aria-label="Host Bootstrap Guide"
            @click="isGuideOpen = true"
          >
            <Icon name="guide" :size="14" />
          </Button>
        </div>
      </div>

      <!-- Filter Row: Modeled after Attention Urgency Pills -->
      <FilterPillGroup>
        <FilterPill
          filter-key="all"
          label="All"
          :count="allCount"
          status="purple"
          :active="activeFilter === 'all'"
          @click="activeFilter = 'all'"
        />
        <FilterPill
          filter-key="ready"
          label="Ready"
          :count="readyCount"
          status="green"
          :active="activeFilter === 'ready'"
          @click="activeFilter = 'ready'"
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
          filter-key="action-required"
          label="Action Required"
          :count="actionRequiredCount"
          status="red"
          :active="activeFilter === 'action-required'"
          @click="activeFilter = 'action-required'"
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

    <!-- Layout: Desktop 2-Column Split vs Mobile Drill-down -->
    <div class="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4">
      <!-- No authority: the production route requires a typed adapter and never
           substitutes fixture facts for missing production wiring. -->
      <div v-if="!hasAuthority" class="envs-unavailable-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="environments"
          title="Environment Authority Unavailable"
          description="This page has no environment service configured, so it cannot show or change live host facts."
        />
      </div>

      <!-- Loading State -->
      <div v-else-if="isLoading" class="envs-loading-state flex flex-col items-center justify-center p-12 text-center h-64 gap-3">
        <Icon name="refresh" class="animate-spin text-[var(--accent-primary)]" :size="28" />
        <span class="text-sm font-semibold text-[var(--text-primary)]">Loading Environments & Host States</span>
        <span class="text-xs text-[var(--text-muted)]">Querying local daemons and carrier overlay status...</span>
      </div>

      <!-- Missing deep link: never substitute another record for the requested id. -->
      <div v-else-if="deepLinkMissing" class="envs-not-found-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="alert"
          title="Environment Not Found"
          description="No environment matches this URL. Choose an environment from the list instead."
        >
          <Button
            variant="primary"
            size="sm"
            class="envs-not-found-return text-xs"
            @click="router.push({ name: 'environments' })"
          >
            <span>Back to Environments</span>
          </Button>
        </EmptyState>
      </div>

      <!-- Empty State: No environments enrolled at all -->
      <div v-else-if="environments.length === 0" class="envs-empty-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="environments"
          title="No Environments Enrolled"
          description="No host environments are currently enrolled. Connect a worker or register a new host to begin dispatching agent tasks."
        >
          <Button variant="primary" size="sm" class="mt-3" :disabled="controlsDisabled" @click="isRegisterOpen = true">
            <Icon name="plus" :size="13" />
            <span>Register New Host</span>
          </Button>
        </EmptyState>
      </div>

      <template v-else>
        <!-- Desktop 2-Column Split Layout (md+) -->
        <div class="envs-split-layout hidden md:flex gap-4 h-full">
          <!-- Left Master Column (fixed width ~340px) -->
          <div class="envs-master-column w-80 lg:w-96 overflow-y-auto shrink-0 pr-1">
            <EnvironmentMasterList
              :environments="filteredEnvironments"
              :selected-id="selectedId"
              :disabled="controlsDisabled"
              :can-control="controlAvailable"
              @select="handleSelectEnvironment"
              @probe="handleProbe"
            />
          </div>

          <!-- Right Detail Column (flex 1) -->
          <div class="envs-detail-column flex-1 overflow-y-auto pl-1">
            <EnvironmentDetail
              v-if="selectedEnv"
              :env="selectedEnv"
              :disabled="controlsDisabled"
              :can-reconcile="canReconcileEvidence"
              @approve="handleApprove"
              @probe="handleProbe"
              @toggle-permission="handleTogglePermission"
              @unbind-workspace="handleUnbindWorkspace"
              @reconcile="handleReconcile"
              @resume="handleResume"
              @discard="handleDiscard"
              @force-release="handleOpenForceRelease"
              @archive="handleArchive"
              @restore="handleRestore"
              @unenroll="handleUnenroll"
            />
            <div v-else class="p-8 text-center text-xs text-[var(--text-muted)]">
              No environment matches the active filter.
            </div>
          </div>
        </div>

        <!-- Mobile View (below md): either Master List or Detail View -->
        <div class="md:hidden">
          <!-- Mobile Drill-down Detail View -->
          <div v-if="isMobileDetailRoute && selectedEnv" class="envs-mobile-detail-wrapper">
            <EnvironmentDetail
              :env="selectedEnv"
              :disabled="controlsDisabled"
              :can-reconcile="canReconcileEvidence"
              @approve="handleApprove"
              @probe="handleProbe"
              @toggle-permission="handleTogglePermission"
              @unbind-workspace="handleUnbindWorkspace"
              @reconcile="handleReconcile"
              @resume="handleResume"
              @discard="handleDiscard"
              @force-release="handleOpenForceRelease"
              @archive="handleArchive"
              @restore="handleRestore"
              @unenroll="handleUnenroll"
            />
          </div>

          <!-- Mobile Master List View -->
          <div v-else class="envs-master-list mobile-full">
            <EnvironmentMasterList
              :environments="filteredEnvironments"
              :selected-id="selectedId"
              :disabled="controlsDisabled"
              :can-control="controlAvailable"
              @select="handleSelectEnvironment"
              @probe="handleProbe"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- Modals -->
    <ForceReleaseDialog
      v-if="hasAuthority && selectedEnv"
      :open="isForceReleaseOpen"
      :env="selectedEnv"
      :disabled="controlsDisabled"
      @update:open="isForceReleaseOpen = $event"
      @confirm="handleConfirmForceRelease"
    />

    <BootstrapGuideDialog
      :open="isGuideOpen"
      @update:open="isGuideOpen = $event"
    />

    <RegisterHostDialog
      :open="isRegisterOpen"
      @update:open="isRegisterOpen = $event"
    />
  </div>
</template>
