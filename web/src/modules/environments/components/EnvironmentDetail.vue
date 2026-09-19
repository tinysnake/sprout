<script setup lang="ts">
import type { CapabilityKey, EnvironmentInstance } from '../types.js';
import StateBanner from '../../../primitives/StateBanner.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import StatusDot from '../../../primitives/StatusDot.vue';
import StatusPill from '../../../primitives/StatusPill.vue';
import Badge from '../../../primitives/Badge.vue';
import Card from '../../../primitives/Card.vue';
import HealthDimensionsGrid from './HealthDimensionsGrid.vue';
import CapabilityPermissionsGrid from './CapabilityPermissionsGrid.vue';
import EngineReadinessGrid from './EngineReadinessGrid.vue';
import ActiveLeaseBox from './ActiveLeaseBox.vue';
import ReconcilingBox from './ReconcilingBox.vue';
import RecoveryAlertBox from './RecoveryAlertBox.vue';
import ForcedReleaseAuditBox from './ForcedReleaseAuditBox.vue';

defineProps<{
  env: EnvironmentInstance;
}>();

const emit = defineEmits<{
  (e: 'approve', id: string): void;
  (e: 'probe', id: string): void;
  (e: 'togglePermission', cap: CapabilityKey): void;
  (e: 'unbindWorkspace', payload: { projectId: string; envId: string }): void;
  (e: 'reconcile', id: string): void;
  (e: 'resume', taskId: string): void;
  (e: 'discard', taskId: string): void;
  (e: 'forceRelease', id: string): void;
  (e: 'archive', id: string): void;
  (e: 'restore', id: string): void;
  (e: 'unenroll', id: string): void;
}>();
</script>

<template>
  <Card class="env-detail-card p-3.5 sm:p-4 flex flex-col gap-4 shadow-sm">
    <!-- 1. Prominent Traffic Light Summary Banner -->
    <StateBanner
      :traffic-light="env.trafficLight"
      :reason="env.trafficLightReason"
      :platform="env.platform"
      :protocol-mismatch-detail="env.protocolMismatchDetail"
      :is-archived="env.enrollmentStatus === 'archived'"
    />

    <!-- 2. 6 Independent Health Dimensions -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-[var(--text-primary)]">
          6 Independent Health Dimensions (Never collapsed into one boolean)
        </h3>
      </div>

      <!-- 1–4. Core Operational Status & Safety Dimensions -->
      <HealthDimensionsGrid :env="env" @approve="emit('approve', $event)" />

      <!-- 5. Capability Permissions (Granular & Safety Guarded) -->
      <CapabilityPermissionsGrid
        :permissions="env.capabilityPermissions"
        @toggle="emit('togglePermission', $event)"
      />

      <!-- 6. Engine Harness Readiness (Host-Local Facts) -->
      <EngineReadinessGrid
        :readiness="env.engineReadiness"
        :details="env.engineDetails"
      />
    </div>

    <!-- 3. Bound Project Workspaces (Workspace Readiness) -->
    <div class="flex flex-col gap-2 pt-3 border-t border-[var(--border-subtle)]">
      <h3 class="text-xs sm:text-sm font-bold text-[var(--text-primary)] flex items-center gap-1.5">
        <Icon name="folder" :size="15" />
        <span>Bound Project Workspaces (Persistent Host State)</span>
      </h3>

      <div class="bound-workspaces-list flex flex-col gap-1.5">
        <div
          v-for="ws in env.boundWorkspaces"
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
              @click="emit('unbindWorkspace', { projectId: ws.projectId, envId: env.id })"
            >
              Unbind
            </Button>
          </div>
        </div>

        <div v-if="env.boundWorkspaces.length === 0" class="text-xs text-[var(--text-muted)] italic py-1">
          No projects currently bound to this environment instance.
        </div>
      </div>
    </div>

    <!-- 4. Active Lease, Recovery, and Force Release Resolution Area -->
    <ReconcilingBox
      v-if="env.workSafety === 'reconciling'"
      :env="env"
      @reconcile="emit('reconcile', $event)"
    />
    <RecoveryAlertBox
      v-else-if="env.workSafety === 'recovery'"
      :env="env"
      @resume="emit('resume', $event)"
      @discard="emit('discard', $event)"
      @force-release="emit('forceRelease', $event)"
    />
    <ActiveLeaseBox
      v-else-if="env.activeLeaseHolder"
      :lease="env.activeLeaseHolder"
    />
    <ForcedReleaseAuditBox
      v-else-if="env.forcedReleaseRecord"
      :record="env.forcedReleaseRecord"
    />

    <!-- 5. Interactive Operations Toolbar -->
    <div class="env-operations-toolbar flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-subtle)] flex-wrap">
      <Button
        v-if="env.enrollmentStatus === 'pending'"
        variant="primary"
        size="sm"
        class="approve-enroll-btn text-xs"
        @click="emit('approve', env.id)"
      >
        <Icon name="check" :size="13" />
        <span>Approve Enrollment (Human Action)</span>
      </Button>

      <Button
        variant="secondary"
        size="sm"
        class="run-probe-btn text-xs"
        @click="emit('probe', env.id)"
      >
        <Icon name="lightning" :size="13" />
        <span>Request Readiness Probe</span>
      </Button>

      <Button
        v-if="env.enrollmentStatus === 'approved' && !env.activeLeaseHolder && env.workSafety === 'clear'"
        variant="secondary"
        size="sm"
        class="archive-env-btn text-xs"
        @click="emit('archive', env.id)"
      >
        <Icon name="archive" :size="13" />
        <span>Archive Instance</span>
      </Button>

      <Button
        v-if="env.enrollmentStatus === 'archived'"
        variant="secondary"
        size="sm"
        class="restore-env-btn text-xs"
        @click="emit('restore', env.id)"
      >
        <Icon name="refresh" :size="13" />
        <span>Restore Instance</span>
      </Button>

      <Button
        v-if="env.enrollmentStatus === 'approved' && !env.activeLeaseHolder && env.workSafety === 'clear'"
        variant="ghost"
        size="sm"
        class="unenroll-env-btn text-xs text-[var(--red-action)] hover:text-[var(--red-action)] hover:bg-[var(--red-action-bg)]"
        @click="emit('unenroll', env.id)"
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
          v-for="(pr, idx) in env.probeHistory"
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

        <div v-if="env.probeHistory.length === 0" class="text-xs text-[var(--text-muted)] italic py-1">
          No probe records yet. Click 'Request Readiness Probe' above.
        </div>
      </div>
    </div>
  </Card>
</template>
