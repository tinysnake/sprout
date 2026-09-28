<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CapabilityKey, EnvironmentInstance } from '../types.js';
import StateBanner from '../../../primitives/StateBanner.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import StatusDot from '../../../primitives/StatusDot.vue';
import StatusPill from '../../../primitives/StatusPill.vue';
import Badge from '../../../primitives/Badge.vue';
import Card from '../../../primitives/Card.vue';
import Checkbox from '../../../primitives/Checkbox.vue';
import HealthDimensionsGrid from './HealthDimensionsGrid.vue';
import CapabilityPermissionsGrid from './CapabilityPermissionsGrid.vue';
import EngineReadinessGrid from './EngineReadinessGrid.vue';
import ActiveLeaseBox from './ActiveLeaseBox.vue';
import ReconcilingBox from './ReconcilingBox.vue';
import RecoveryAlertBox from './RecoveryAlertBox.vue';
import ForcedReleaseAuditBox from './ForcedReleaseAuditBox.vue';

const props = defineProps<{
  env: EnvironmentInstance;
  /** True while the connection is unsettled: every control action is refused. */
  disabled?: boolean;
  /** True only when the typed authority reaches a real Worker evidence port. */
  canReconcile?: boolean;
}>();

// A refreshed environment can be assembled over more than one reactive tick.
// Keep the previous detail snapshot mounted until that update has settled so
// optional fact-backed sections (notably protocol-mismatch guidance) are not
// removed for an intermediate render.
const displayedEnv = ref(props.env);
watch(
  () => props.env,
  async (incoming) => {
    // Keep the prior detail for one paint interval: the refreshed record's
    // fact-backed subsections may be populated immediately after replacement.
    await new Promise((resolve) => setTimeout(resolve, 16));
    if (props.env === incoming) displayedEnv.value = incoming;
  },
);

/**
 * Post-approval model authorization (#172).
 *
 * The configured target models come from the core-owned requirements, and the
 * boxes start checked for models the Human already authorized, so re-saving
 * re-stamps every current grant after a requirement-scope change instead of
 * silently dropping the ones the operator did not re-select.
 */
const configuredTargetModels = computed(() => {
  const list: { engine: string; model: string }[] = [];
  const add = (engine: string, model: string) => {
    if (!list.some((item) => item.engine === engine && item.model === model)) list.push({ engine, model });
  };
  for (const [engine, models] of Object.entries(displayedEnv.value.targetModelsByEngine ?? {})) {
    for (const model of models) add(engine, model);
  }
  for (const [engine, models] of Object.entries(displayedEnv.value.requirements?.modelsByEngine ?? {})) {
    for (const model of models) add(engine, model);
  }
  return list;
});

const selectedModelAuthorizations = ref<Record<string, boolean>>({});
watch(
  () => props.env,
  (env) => {
    const next: Record<string, boolean> = {};
    for (const [engine, details] of Object.entries(env.engineDetails ?? {})) {
      for (const auth of details.modelAuthorizations ?? []) next[`${engine}:${auth.model}`] = true;
    }
    selectedModelAuthorizations.value = next;
  },
  { immediate: true },
);

function handleAuthorizeModels(): void {
  const modelAuthorizations: Record<string, string[]> = {};
  for (const target of configuredTargetModels.value) {
    if (selectedModelAuthorizations.value[`${target.engine}:${target.model}`] === true) {
      (modelAuthorizations[target.engine] ??= []).push(target.model);
    }
  }
  emit('authorizeModels', { id: displayedEnv.value.id, modelAuthorizations });
}

const emit = defineEmits<{
  (e: 'probe', id: string): void;
  (e: 'togglePermission', cap: CapabilityKey): void;
  /**
   * Record the Human's model-authorization selection on the approved enrollment
   * (#172). This is the post-approval remedy for an Agent's new work model.
   */
  (e: 'authorizeModels', payload: { id: string; modelAuthorizations: Record<string, readonly string[]> }): void;
  (e: 'unbindWorkspace', payload: { projectId: string; envId: string }): void;
  (e: 'reconcile', id: string): void;
  (e: 'resume', taskId: string): void;
  (e: 'discard', taskId: string): void;
  (e: 'forceRelease', id: string): void;
  (e: 'archive', id: string): void;
  (e: 'restore', id: string): void;
  (e: 'unenroll', id: string): void;
  (e: 'resumeEnrollment', id: string): void;
  (e: 'registerReplacement'): void;
}>();

</script>

<template>
  <Card class="env-detail-card p-3.5 sm:p-4 flex flex-col gap-4 shadow-sm">
    <!-- 1. Prominent Traffic Light Summary Banner -->
    <StateBanner
      :traffic-light="displayedEnv.trafficLight"
      :reason="displayedEnv.trafficLightReason"
      :platform="displayedEnv.platform"
      :protocol-mismatch-detail="displayedEnv.protocolMismatchDetail"
      :is-archived="displayedEnv.enrollmentStatus === 'archived'"
      :is-pending="displayedEnv.enrollmentStatus === 'pending'"

    />

    <section
      v-if="displayedEnv.enrollmentStatus === 'revoked'"
      class="revoked-enrollment-panel rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 space-y-2"
      aria-label="Revoked enrollment"
    >
      <div>
        <h3 class="text-xs font-bold text-[var(--text-primary)]">Revoked enrollment</h3>
        <p class="text-xs text-[var(--text-muted)]">This identity is permanently revoked. Start a fresh enrollment to reset access; this record cannot be restored.</p>
      </div>
      <div class="revoked-decision-history space-y-1" aria-label="Decision history">
        <p v-for="(decision, index) in displayedEnv.decisions ?? []" :key="`${decision.kind}-${decision.at}-${index}`" class="text-[11px] text-[var(--text-secondary)]">
          {{ decision.kind }} · {{ decision.actor }} · {{ new Date(decision.at).toLocaleString() }}<span v-if="decision.reason"> — {{ decision.reason }}</span>
        </p>
        <p v-if="!displayedEnv.decisions?.length" class="text-[11px] text-[var(--text-muted)] italic">No enrollment decisions recorded.</p>
      </div>
      <Button variant="secondary" size="sm" class="revoked-reset-btn text-xs" :disabled="disabled" @click="emit('registerReplacement')">
        <Icon name="refresh" :size="13" />
        <span>Start fresh enrollment</span>
      </Button>
    </section>

    <!-- 2. 6 Independent Health Dimensions -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-[var(--text-primary)]">
          6 Independent Health Dimensions (Never collapsed into one boolean)
        </h3>
      </div>

      <!-- 1–4. Core Operational Status & Safety Dimensions -->
      <HealthDimensionsGrid :env="displayedEnv" />

      <!-- 5. Capability Permissions (Granular & Safety Guarded) -->
      <CapabilityPermissionsGrid
        :permissions="displayedEnv.capabilityPermissions"
        :disabled="disabled"
        @toggle="emit('togglePermission', $event)"
      />

      <!-- 6. Engine Harness Readiness (Host-Local Facts) -->
      <EngineReadinessGrid
        :readiness="displayedEnv.engineReadiness"
        :details="displayedEnv.engineDetails"
      />

      <!-- 7. Post-approval Human model authorization (#172) -->
      <div
        v-if="displayedEnv.enrollmentStatus === 'approved'"
        class="model-authorization-panel rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 space-y-2"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-xs sm:text-sm font-bold text-[var(--text-primary)]">Model Authorization (Human Entitlement)</h3>
          <span class="text-[10px] text-[var(--text-muted)]">Human Authorization Required</span>
        </div>
        <p class="text-[11px] text-[var(--text-secondary)]">
          When an Agent gains a work model after approval, its availability stays unknown until a Human records the
          model authorization here — no enrollment reset and no re-enrollment ceremony. Unselected models stay blocked;
          re-saving also re-stamps every model already authorized. Request a readiness probe afterwards so the
          Environment re-measures the current requirement revision.
        </p>
        <div v-if="configuredTargetModels.length === 0" class="text-xs text-[var(--text-muted)] italic py-1">
          No target models are configured for this environment's engines.
        </div>
        <template v-else>
          <div class="space-y-2">
            <div
              v-for="target in configuredTargetModels"
              :key="`${target.engine}:${target.model}`"
              class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)]/50"
            >
              <label :for="`env-auth-${target.engine}-${target.model}`" class="flex flex-col cursor-pointer select-none">
                <span class="text-xs font-medium text-[var(--text-primary)]">{{ target.model }}</span>
                <span class="text-[10px] text-[var(--text-muted)] uppercase font-semibold">Engine: {{ target.engine }}</span>
              </label>
              <Checkbox
                :id="`env-auth-${target.engine}-${target.model}`"
                v-model="selectedModelAuthorizations[`${target.engine}:${target.model}`]"
                class="min-h-[24px] min-w-[24px]"
                :aria-label="`Authorize model ${target.model} for ${target.engine}`"
              />
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            class="authorize-models-btn text-xs"
            :disabled="disabled"
            @click="handleAuthorizeModels"
          >
            <Icon name="key" :size="13" />
            <span>Record Model Authorization</span>
          </Button>
        </template>
      </div>
    </div>

    <!-- 3. Bound Project Workspaces (Workspace Readiness) -->
    <div class="flex flex-col gap-2 pt-3 border-t border-[var(--border-subtle)]">
      <h3 class="text-xs sm:text-sm font-bold text-[var(--text-primary)] flex items-center gap-1.5">
        <Icon name="folder" :size="15" />
        <span>Bound Project Workspaces (Persistent Host State)</span>
      </h3>

      <div class="bound-workspaces-list flex flex-col gap-1.5">
        <div
          v-for="ws in displayedEnv.boundWorkspaces"
          :key="ws.projectId"
          class="flex items-center justify-between p-2.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex-wrap gap-2"
        >
          <div>
            <strong class="text-xs font-bold text-[var(--text-primary)] block">{{ ws.projectDisplayName }}</strong>
            <div class="text-[11px] text-[var(--text-secondary)] font-mono mt-0.5">
              {{ ws.workspaceRoot }}/{{ ws.relativeWorkspacePath }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <StatusPill status="green" class="text-[10px]">PREPARED & READY</StatusPill>
            <Button
              variant="secondary"
              size="xs"
              class="unbind-env-btn text-[10px] h-6 px-2"
              :disabled="disabled"
              @click="emit('unbindWorkspace', { projectId: ws.projectId, envId: displayedEnv.id })"
            >
              Unbind
            </Button>
          </div>
        </div>

        <div v-if="displayedEnv.boundWorkspaces.length === 0" class="text-xs text-[var(--text-muted)] italic py-1">
          No projects currently bound to this environment instance.
        </div>
      </div>
    </div>

    <!-- 4. Active Lease, Recovery, and Force Release Resolution Area -->
    <ReconcilingBox
      v-if="displayedEnv.workSafety === 'reconciling'"
      :env="displayedEnv"
      :disabled="disabled"
      :can-reconcile="props.canReconcile === true"
      @reconcile="emit('reconcile', $event)"
    />
    <RecoveryAlertBox
      v-else-if="displayedEnv.workSafety === 'recovery'"
      :env="displayedEnv"
      :disabled="disabled"
      @resume="emit('resume', $event)"
      @discard="emit('discard', $event)"
      @force-release="emit('forceRelease', $event)"
    />
    <ActiveLeaseBox
      v-else-if="displayedEnv.activeLeaseHolder"
      :lease="displayedEnv.activeLeaseHolder"
    />
    <ForcedReleaseAuditBox
      v-else-if="displayedEnv.forcedReleaseRecord"
      :record="displayedEnv.forcedReleaseRecord"
    />

    <!-- 5. Interactive Operations Toolbar -->
    <div class="env-operations-toolbar flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-subtle)] flex-wrap">
      <Button
        v-if="displayedEnv.enrollmentStatus === 'pending'"
        variant="secondary"
        size="sm"
        class="resume-enroll-btn text-xs"
        :disabled="disabled"
        @click="emit('resumeEnrollment', displayedEnv.id)"
      >
        <Icon name="key" :size="13" />
        <span>Enrollment Ceremony</span>
      </Button>

      <Button
        variant="secondary"
        size="sm"
        class="run-probe-btn text-xs"
        :disabled="disabled"
        @click="emit('probe', displayedEnv.id)"
      >
        <Icon name="lightning" :size="13" />
        <span>Request Readiness Probe</span>
      </Button>

      <Button
        v-if="displayedEnv.enrollmentStatus === 'approved' && !displayedEnv.activeLeaseHolder && displayedEnv.workSafety === 'clear'"
        variant="secondary"
        size="sm"
        class="archive-env-btn text-xs"
        :disabled="disabled"
        @click="emit('archive', displayedEnv.id)"
      >
        <Icon name="archive" :size="13" />
        <span>Archive Instance</span>
      </Button>

      <Button
        v-if="displayedEnv.enrollmentStatus === 'archived'"
        variant="secondary"
        size="sm"
        class="restore-env-btn text-xs"
        :disabled="disabled"
        @click="emit('restore', displayedEnv.id)"
      >
        <Icon name="refresh" :size="13" />
        <span>Restore Instance</span>
      </Button>

      <Button
        v-if="displayedEnv.enrollmentStatus === 'approved' && !displayedEnv.activeLeaseHolder && displayedEnv.workSafety === 'clear'"
        variant="ghost"
        size="sm"
        class="unenroll-env-btn text-xs text-[var(--red-action)] hover:text-[var(--red-action)] hover:bg-[var(--red-action-bg)]"
        :disabled="disabled"
        @click="emit('unenroll', displayedEnv.id)"
      >
        <Icon name="trash" :size="13" />
        <span>Unenroll & Revoke</span>
      </Button>
    </div>

    <!-- 6. Recent Readiness Probes & Operational Event Log -->
    <div class="flex flex-col gap-1.5 pt-3 border-t border-[var(--border-subtle)]">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-bold text-[var(--text-primary)]">
          Recent Readiness Probes & Evidence Log
        </h4>
        <span class="text-[10px] text-[var(--text-muted)] font-mono">TLS/WSS Carrier Stream</span>
      </div>

      <div class="probe-history-stream flex flex-col gap-1.5 max-h-48 overflow-y-auto">
        <div
          v-for="(pr, idx) in displayedEnv.probeHistory"
          :key="idx"
          class="flex items-center justify-between p-2 rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[11px] gap-2"
        >
          <div class="flex items-center gap-1.5 min-w-0">
            <StatusDot :status="pr.protocolOk && pr.enginesOk ? 'green' : 'yellow'" size="sm" />
            <span class="font-mono text-[var(--text-muted)] shrink-0">{{ pr.timestamp }}</span>
            <span class="text-[var(--text-primary)] truncate">{{ pr.summary }}</span>
          </div>
          <Badge variant="secondary" class="text-[9px] shrink-0">
            {{ pr.latencyMs }}ms
          </Badge>
        </div>

        <div v-if="displayedEnv.probeHistory.length === 0" class="text-xs text-[var(--text-muted)] italic py-1">
          No probe records yet. Click 'Request Readiness Probe' above.
        </div>
      </div>
    </div>
  </Card>
</template>
