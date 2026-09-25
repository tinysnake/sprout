<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, inject, nextTick } from 'vue';
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';
import Input from '../../../primitives/Input.vue';
import Checkbox from '../../../primitives/Checkbox.vue';
import Icon from '../../../primitives/Icon.vue';
import Badge from '../../../primitives/Badge.vue';
import StatusDot from '../../../primitives/StatusDot.vue';
import { useAnnouncer } from '../../../primitives/announcer.js';
import { ENVIRONMENT_SERVICE, type EnvironmentService } from '../ports.js';
import type { EnvironmentInstance } from '../types.js';

const props = defineProps<{
  open: boolean;
  service?: EnvironmentService;
  initialEnrollmentId?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'enrolled', enrollmentId: string): void;
}>();

const injectedService = inject<EnvironmentService | undefined>(ENVIRONMENT_SERVICE, undefined);
const activeService = computed(() => props.service ?? injectedService);
const announcer = useAnnouncer();

// Ceremony phases: 'create' | 'active' | 'review' | 'approved'
const phase = ref<'create' | 'active' | 'review' | 'approved'>('create');

// Creation form fields
const displayName = ref('');
const environmentInstanceId = ref('');
const platform = ref('macos');
const formError = ref('');
const isSubmitting = ref(false);

// Active enrollment ceremony facts
const activeEnv = ref<EnvironmentInstance | undefined>(undefined);
const bootstrapCommand = ref('');
const claimSecret = ref<string | undefined>(undefined);
const claimExpiresAt = ref<number | undefined>(undefined);
const secretCopied = ref(false);
const commandCopied = ref(false);
const stateNotice = ref('');

// Human permission selection in review phase
const selectedPermissions = ref<Record<string, boolean>>({});

// Polling timer
let pollTimer: ReturnType<typeof setInterval> | null = null;
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

// Derived states for the 8 distinct lifecycle conditions
const isExpired = computed(() => {
  if (!activeEnv.value?.claim) return false;
  return now.value >= activeEnv.value.claim.expiresAt && activeEnv.value.claim.consumedAt === undefined && !isClaimed.value;
});

const isConsumed = computed(() => {
  return activeEnv.value?.claim?.consumedAt !== undefined;
});

const isClaimed = computed(() => {
  const digest = activeEnv.value?.identityDigest;
  return typeof digest === 'string' && digest.length > 0;
});

const isCancelled = computed(() => {
  const decisions = activeEnv.value?.decisions ?? [];
  return (
    activeEnv.value?.enrollmentStatus === 'revoked' &&
    decisions.some((d) => d.kind === 'cancelled' || d.reason.toLowerCase().includes('cancel'))
  );
});

const isDuplicateRefused = computed(() => {
  const decisions = activeEnv.value?.decisions ?? [];
  const attempt = activeEnv.value?.connectionAttempt;
  return (
    decisions.some((d) => d.kind === 'duplicate-new-key-refused') ||
    attempt?.outcome === 'duplicate-new-key-refused'
  );
});

const isClaimOrProofFailed = computed(() => {
  const decisions = activeEnv.value?.decisions ?? [];
  const attempt = activeEnv.value?.connectionAttempt;
  return (
    attempt?.outcome === 'incompatible' ||
    decisions.some((d) => d.reason.toLowerCase().includes('proof') || d.reason.toLowerCase().includes('refused'))
  );
});

const isRevoked = computed(() => {
  return activeEnv.value?.enrollmentStatus === 'revoked' && !isCancelled.value;
});

const isApproved = computed(() => {
  return activeEnv.value?.enrollmentStatus === 'approved';
});

const isConnectionWait = computed(() => {
  return (
    activeEnv.value?.enrollmentStatus === 'pending' &&
    !isClaimed.value &&
    !isExpired.value &&
    !isConsumed.value &&
    !isCancelled.value &&
    !isRevoked.value &&
    !isDuplicateRefused.value
  );
});

// Capabilities requested by worker
const requestedCapabilitiesList = computed(() => {
  if (!activeEnv.value) return [];
  if (activeEnv.value.requestedCapabilities && activeEnv.value.requestedCapabilities.length > 0) {
    return activeEnv.value.requestedCapabilities;
  }
  return Object.keys(activeEnv.value.capabilityPermissions);
});

// Engine readiness entries
const engineFactsList = computed(() => {
  if (!activeEnv.value?.engineReadiness) return [];
  return Object.entries(activeEnv.value.engineReadiness).map(([engine, readiness]) => {
    const details = activeEnv.value?.engineDetails?.[engine];
    return {
      engine,
      readiness,
      installed: details?.installed ?? (readiness !== 'missing'),
      authenticated: details?.authStatus === 'authenticated' || details?.authenticated === true,
      models: details?.models ?? [],
      version: details?.version,
    };
  });
});

function initForm() {
  const stamp = Date.now().toString(36);
  displayName.value = 'macOS Host';
  environmentInstanceId.value = `env-macos-${stamp}`;
  platform.value = 'macos';
  formError.value = '';
  isSubmitting.value = false;
  bootstrapCommand.value = '';
  claimSecret.value = undefined;
  claimExpiresAt.value = undefined;
  secretCopied.value = false;
  commandCopied.value = false;
  stateNotice.value = '';
  selectedPermissions.value = {};
}

async function loadExisting(id: string) {
  const service = activeService.value;
  if (!service) return;
  try {
    const env = await service.getEnvironment(id);
    if (env) {
      activeEnv.value = env;
      updatePermissionsFromEnv(env);
      if (env.enrollmentStatus === 'approved') {
        phase.value = 'approved';
      } else if (env.enrollmentStatus === 'pending' && env.identityDigest && env.identityDigest.length > 0) {
        phase.value = 'review';
      } else {
        phase.value = 'active';
      }
    }
  } catch (err) {
    console.error('Failed to load environment for registration', err);
  }
}

function updatePermissionsFromEnv(env: EnvironmentInstance) {
  const perms: Record<string, boolean> = {};
  const caps = env.requestedCapabilities ?? Object.keys(env.capabilityPermissions);
  for (const cap of caps) {
    perms[cap] = env.capabilityPermissions[cap] ?? true;
  }
  selectedPermissions.value = perms;
}

async function handleCreatePending() {
  if (!displayName.value.trim()) {
    formError.value = 'Display name is required';
    return;
  }
  const service = activeService.value;
  if (!service) {
    formError.value = 'Environment service is unavailable';
    return;
  }
  isSubmitting.value = true;
  formError.value = '';
  try {
    const result = await service.requestEnrollment({
      displayName: displayName.value.trim(),
      environmentInstanceId: environmentInstanceId.value.trim() || `env-${Date.now().toString(36)}`,
      platform: platform.value,
    });
    activeEnv.value = result.enrollment;
    bootstrapCommand.value = result.bootstrapCommand;
    claimSecret.value = result.claimSecret;
    claimExpiresAt.value = result.claimExpiresAt;
    updatePermissionsFromEnv(result.enrollment);
    phase.value = 'active';
    announcer.announce('Pending enrollment created. Bootstrap command and one-use secret are ready.');
  } catch (err: any) {
    formError.value = err?.message || 'Failed to create pending enrollment';
    announcer.announce(`Enrollment creation failed: ${formError.value}`);
  } finally {
    isSubmitting.value = false;
  }
}

async function handleCopyCommand() {
  if (!bootstrapCommand.value) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(bootstrapCommand.value);
    }
    commandCopied.value = true;
    announcer.announce('Bootstrap command copied to clipboard');
    setTimeout(() => {
      commandCopied.value = false;
    }, 2000);
  } catch {
    commandCopied.value = true;
    setTimeout(() => {
      commandCopied.value = false;
    }, 2000);
  }
}

async function handleCopySecret() {
  if (!claimSecret.value) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(claimSecret.value);
    }
    secretCopied.value = true;
    announcer.announce('One-use claim secret copied to clipboard');
    setTimeout(() => {
      secretCopied.value = false;
    }, 2000);
  } catch {
    secretCopied.value = true;
    setTimeout(() => {
      secretCopied.value = false;
    }, 2000);
  }
}

async function handleRegenerateSecret() {
  if (!activeEnv.value || !activeService.value) return;
  try {
    const res = await activeService.value.regenerateClaimSecret(activeEnv.value.id);
    claimSecret.value = res.claimSecret;
    claimExpiresAt.value = res.claimExpiresAt;
    secretCopied.value = false;
    stateNotice.value = 'Fresh one-use claim secret generated. Worker enrollment expiration window has been reset.';
    announcer.announce('Fresh one-use claim secret generated. Worker enrollment expiration window has been reset.');
    await pollStatus();
  } catch (err: any) {
    stateNotice.value = err?.message || 'Failed to regenerate secret';
    announcer.announce(`Failed to regenerate secret: ${stateNotice.value}`);
  }
}

async function handleCancelEnrollment() {
  if (!activeEnv.value || !activeService.value) return;
  try {
    await activeService.value.cancelEnrollment(activeEnv.value.id, 'Cancelled by operator in registration ceremony');
    stateNotice.value = 'Pending enrollment has been cancelled by operator.';
    announcer.announce('Pending enrollment has been cancelled by operator.');
    await pollStatus();
  } catch (err: any) {
    stateNotice.value = err?.message || 'Failed to cancel enrollment';
    announcer.announce(`Failed to cancel enrollment: ${stateNotice.value}`);
  }
}

async function handleApprove() {
  if (!activeEnv.value || !activeService.value) return;
  try {
    await activeService.value.approveEnrollment(activeEnv.value.id, selectedPermissions.value);
    phase.value = 'approved';
    announcer.announce('Worker enrollment approved with selected permissions.');
    emit('enrolled', activeEnv.value.id);
  } catch (err: any) {
    stateNotice.value = err?.message || 'Approval failed';
    announcer.announce(`Approval failed: ${stateNotice.value}`);
  }
}

function handleDone() {
  if (activeEnv.value) {
    emit('enrolled', activeEnv.value.id);
  }
  emit('update:open', false);
}

async function pollStatus() {
  if (!activeEnv.value || !activeService.value) return;
  try {
    const updated = await activeService.value.getEnvironment(activeEnv.value.id);
    if (updated) {
      activeEnv.value = updated;
      if (updated.enrollmentStatus === 'approved') {
        phase.value = 'approved';
      } else if (updated.enrollmentStatus === 'pending' && updated.identityDigest && updated.identityDigest.length > 0 && phase.value !== 'approved') {
        if (phase.value !== 'review') {
          phase.value = 'review';
          updatePermissionsFromEnv(updated);
          announcer.announce('Worker identity verified. Review host facts and capabilities before approving enrollment.');
        }
      }
    }
  } catch (err) {
    console.error('Polling error', err);
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      now.value = Date.now();
      clockTimer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
      if (typeof (clockTimer as any)?.unref === 'function') {
        (clockTimer as any).unref();
      }

      if (props.initialEnrollmentId) {
        await loadExisting(props.initialEnrollmentId);
      } else {
        initForm();
        phase.value = 'create';
        await nextTick();
        const input = document.getElementById('register-host-name');
        input?.focus();
      }

      pollTimer = setInterval(pollStatus, 1500);
      if (typeof (pollTimer as any)?.unref === 'function') {
        (pollTimer as any).unref();
      }
    } else {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <Dialog
    :open="open"
    title="Register New Host Environment"
    description="Production enrollment ceremony for host worker execution"
    class="register-host-dialog max-w-2xl w-full p-0 overflow-hidden"
    @update:open="(val) => emit('update:open', val)"
  >
    <div class="enrollment-ceremony-container p-4 sm:p-6 space-y-5 max-h-[80vh] overflow-y-auto">
      <!-- Live Region for Accessibility -->
      <div
        id="register-host-live-region"
        class="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ stateNotice }}
      </div>

      <!-- PHASE 1: CREATE PENDING ENROLLMENT -->
      <div v-if="phase === 'create'" class="space-y-4">
        <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
          Create a short-lived identity-free pending enrollment. The pending record survives browser reload and provides a public bootstrap command with a separate one-use secret.
        </p>

        <div class="space-y-3">
          <div>
            <label for="register-host-name" class="block text-xs font-semibold text-[var(--text-primary)] mb-1">
              Host Display Name <span class="text-[var(--red-action)]">*</span>
            </label>
            <Input
              id="register-host-name"
              v-model="displayName"
              placeholder="e.g. Mac Studio M2 Max"
              class="w-full text-xs min-h-[44px]"
              @keydown.enter="handleCreatePending"
            />
          </div>

          <div>
            <label for="register-host-id" class="block text-xs font-semibold text-[var(--text-primary)] mb-1">
              Environment Instance ID
            </label>
            <Input
              id="register-host-id"
              v-model="environmentInstanceId"
              placeholder="e.g. env-macos-1"
              class="w-full text-xs min-h-[44px] font-mono text-[11px]"
            />
            <p class="text-[10px] text-[var(--text-muted)] mt-1">
              Opaque identifier for this environment instance in the execution catalog.
            </p>
          </div>

          <div>
            <label for="register-host-platform" class="block text-xs font-semibold text-[var(--text-primary)] mb-1">
              Platform Target
            </label>
            <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between">
              <div class="flex items-center gap-2">
                <Icon name="terminal" :size="16" />
                <span class="text-xs font-medium text-[var(--text-primary)]">macOS (LaunchAgent User Session)</span>
              </div>
              <Badge variant="neutral" class="text-[10px]">E3 Supported</Badge>
            </div>
          </div>

          <div v-if="formError" class="p-3 rounded bg-[var(--red-action-bg)] border border-[var(--red-action-border)] text-xs text-[var(--red-action)]">
            {{ formError }}
          </div>
        </div>
      </div>

      <!-- PHASE 2: ACTIVE PENDING CEREMONY (WAITING FOR CLAIM / OBSERVING STATES) -->
      <div v-else-if="phase === 'active'" class="space-y-4">
        <!-- 1. Distinct State Banners (Acceptance Criterion 3) -->
        <div v-if="isCancelled" class="p-3.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] space-y-1">
          <div class="flex items-center gap-2 text-[var(--text-muted)] font-semibold text-xs">
            <Icon name="alert" :size="15" />
            <span>Cancelled Pending Enrollment</span>
          </div>
          <p class="text-xs text-[var(--text-secondary)]">
            Pending enrollment has been cancelled by operator.
          </p>
        </div>

        <div v-else-if="isRevoked" class="p-3.5 rounded bg-[var(--red-action-bg)] border border-[var(--red-action-border)] space-y-1">
          <div class="flex items-center gap-2 text-[var(--red-action)] font-semibold text-xs">
            <Icon name="trash" :size="15" />
            <span>Revoked Identity</span>
          </div>
          <p class="text-xs text-[var(--red-action)]">
            This environment enrollment is revoked. Host worker connections are barred.
          </p>
        </div>

        <div v-else-if="isDuplicateRefused" class="p-3.5 rounded bg-[var(--red-action-bg)] border border-[var(--red-action-border)] space-y-1">
          <div class="flex items-center gap-2 text-[var(--red-action)] font-semibold text-xs">
            <Icon name="alert" :size="15" />
            <span>Duplicate Identity Refused</span>
          </div>
          <p class="text-xs text-[var(--red-action)]">
            Duplicate worker identity refused: A different worker key cannot replace an existing binding without an explicit reset.
          </p>
        </div>

        <div v-else-if="isClaimOrProofFailed" class="p-3.5 rounded bg-[var(--red-action-bg)] border border-[var(--red-action-border)] space-y-1">
          <div class="flex items-center gap-2 text-[var(--red-action)] font-semibold text-xs">
            <Icon name="alert" :size="15" />
            <span>Claim / Proof Failure</span>
          </div>
          <p class="text-xs text-[var(--red-action)]">
            Host worker claim or identity proof failed. The worker connection was refused.
          </p>
        </div>

        <div v-else-if="isConsumed && !isClaimed" class="p-3.5 rounded bg-[var(--yellow-warning-bg)] border border-[var(--yellow-warning-border)] space-y-1">
          <div class="flex items-center gap-2 text-[var(--yellow-warning)] font-semibold text-xs">
            <Icon name="alert" :size="15" />
            <span>Already-Consumed Claim</span>
          </div>
          <p class="text-xs text-[var(--yellow-warning)]">
            The one-use claim secret has already been consumed and cannot be reused.
          </p>
        </div>

        <div v-else-if="isExpired" class="p-3.5 rounded bg-[var(--yellow-warning-bg)] border border-[var(--yellow-warning-border)] space-y-2">
          <div class="flex items-center gap-2 text-[var(--yellow-warning)] font-semibold text-xs">
            <Icon name="clock" :size="15" />
            <span>Enrollment Claim Expired</span>
          </div>
          <p class="text-xs text-[var(--yellow-warning)]">
            The one-use enrollment claim secret has expired. Worker enrollment is blocked until a fresh secret is generated.
          </p>
          <Button
            variant="secondary"
            size="sm"
            class="regenerate-secret-btn min-h-[44px]"
            @click="handleRegenerateSecret"
          >
            <Icon name="refresh" :size="14" />
            <span>Regenerate Secret (Unused Secret Regeneration)</span>
          </Button>
        </div>

        <div v-else-if="isConnectionWait" class="p-3.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] space-y-1">
          <div class="flex items-center gap-2 text-[var(--accent-primary)] font-semibold text-xs">
            <Icon name="refresh" class="animate-spin" :size="15" />
            <span>Connection Wait</span>
          </div>
          <p class="text-xs text-[var(--text-secondary)]">
            Waiting for host worker to connect and prove identity...
          </p>
        </div>

        <!-- 2. Public Bootstrap Command (Copyable public command) -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-[var(--text-primary)]">
              Bootstrap Command (Public)
            </label>
            <Badge variant="neutral" class="text-[10px]">No Secrets Contained</Badge>
          </div>
          <p class="text-[11px] text-[var(--text-secondary)]">
            Execute this command in your operator terminal on the target macOS host. It contains only the Sprout endpoint and pending enrollment ID.
          </p>
          <div class="relative group">
            <pre
              id="bootstrap-command-text"
              class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--text-primary)] overflow-x-auto break-all pr-24"
            >{{ bootstrapCommand }}</pre>
            <Button
              id="btn-copy-command"
              variant="secondary"
              size="sm"
              class="absolute right-2 top-2 text-[11px] min-h-[36px]"
              aria-label="Copy bootstrap command"
              @click="handleCopyCommand"
            >
              <Icon :name="commandCopied ? 'check' : 'copy'" :size="12" />
              <span>{{ commandCopied ? 'Copied!' : 'Copy Command' }}</span>
            </Button>
          </div>
        </div>

        <!-- 3. One-Use Secret (Visually and Semantically Separate) -->
        <div class="p-4 rounded-lg bg-[var(--bg-surface-elevated)] border border-[var(--accent-primary)]/30 space-y-2.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Icon name="key" class="text-[var(--accent-primary)]" :size="15" />
              <span class="text-xs font-bold text-[var(--text-primary)]">One-Use Host Claim Secret</span>
            </div>
            <Badge variant="warning" class="text-[10px]">Stdin Only · Never in Argv</Badge>
          </div>

          <p class="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            The one-use secret is visually and semantically separate. It is never embedded in command text, URLs, browser history, logs, or diagnostics. When prompted by <code class="font-mono text-[10px] bg-[var(--bg-surface)] px-1 py-0.5 rounded">sprout worker enroll</code>, paste this secret into stdin.
          </p>

          <div v-if="claimSecret" class="flex items-center gap-2 flex-wrap sm:flex-nowrap">
            <div
              id="claim-secret-value"
              class="flex-1 p-2.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono text-xs text-[var(--accent-primary)] tracking-wider overflow-x-auto select-all"
            >
              {{ claimSecret }}
            </div>
            <Button
              id="btn-copy-secret"
              variant="primary"
              size="sm"
              class="shrink-0 min-h-[44px]"
              aria-label="Copy one-use secret"
              @click="handleCopySecret"
            >
              <Icon :name="secretCopied ? 'check' : 'copy'" :size="14" />
              <span>{{ secretCopied ? 'Copied!' : 'Copy Secret' }}</span>
            </Button>
          </div>
          <div v-else class="text-xs text-[var(--text-muted)] italic">
            Secret was presented upon creation and is not retained in cleartext. If you have not copied it, regenerate a fresh secret.
          </div>

          <div class="flex items-center justify-between text-[10px] text-[var(--text-muted)] pt-1">
            <span v-if="claimExpiresAt">
              Expires at: {{ new Date(claimExpiresAt).toLocaleTimeString() }}
            </span>
            <span v-else>Short-lived one-use credential</span>

            <Button
              v-if="!isApproved && !isCancelled && !isRevoked"
              variant="ghost"
              size="sm"
              class="text-[11px] h-7 p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              @click="handleRegenerateSecret"
            >
              <Icon name="refresh" :size="12" />
              <span>Regenerate Secret</span>
            </Button>
          </div>
        </div>

        <div v-if="stateNotice" class="text-xs text-[var(--accent-primary)] bg-[var(--accent-primary)]/10 p-2 rounded">
          {{ stateNotice }}
        </div>
      </div>

      <!-- PHASE 3: REVIEW CLAIMED WORKER FACTS & APPROVE PERMISSIONS -->
      <div v-else-if="phase === 'review'" class="space-y-4">
        <div class="p-3.5 rounded bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20 space-y-1">
          <div class="flex items-center gap-2 text-[var(--accent-primary)] font-semibold text-xs">
            <Icon name="check" :size="15" />
            <span>Worker Identity Verified</span>
          </div>
          <p class="text-xs text-[var(--text-secondary)]">
            Worker claimed enrollment and proved host key possession. Review platform facts, engine status, and grant capability permissions before explicit Human approval.
          </p>
        </div>

        <!-- Real Platform & Protocol Facts -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] space-y-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Platform</span>
            <div class="flex items-center gap-2">
              <Icon name="terminal" :size="14" />
              <span class="font-medium text-[var(--text-primary)]">{{ activeEnv?.platform || 'macos' }}</span>
            </div>
          </div>

          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] space-y-1">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Worker Protocol</span>
            <div class="flex items-center gap-2">
              <StatusDot :variant="activeEnv?.protocolCompatibility === 'incompatible' ? 'red' : 'green'" size="sm" />
              <span class="font-mono text-[11px] text-[var(--text-primary)]">{{ activeEnv?.protocolVersion || 'v2.1' }}</span>
              <span class="text-[10px] text-[var(--text-muted)]">({{ activeEnv?.protocolCompatibility || 'compatible' }})</span>
            </div>
          </div>

          <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] space-y-1 sm:col-span-2">
            <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Worker Identity Digest</span>
            <div class="font-mono text-[11px] text-[var(--text-secondary)] truncate">
              {{ activeEnv?.identityDigest || 'Pending verification' }}
            </div>
            <p class="text-[10px] text-[var(--text-muted)]">
              Host-generated public key digest. Private key never leaves the environment host.
            </p>
          </div>
        </div>

        <!-- Engine Facts & Readiness Provenance -->
        <div class="space-y-2">
          <span class="text-xs font-semibold text-[var(--text-primary)]">Discovered Engines & Readiness</span>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div
              v-for="item in engineFactsList"
              :key="item.engine"
              class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs flex flex-col gap-1"
            >
              <div class="flex items-center justify-between">
                <span class="font-semibold capitalize text-[var(--text-primary)]">{{ item.engine }}</span>
                <Badge :variant="item.readiness === 'ready' ? 'success' : item.readiness === 'login-required' ? 'warning' : 'neutral'" class="text-[10px]">
                  {{ item.readiness }}
                </Badge>
              </div>
              <div class="text-[11px] text-[var(--text-muted)]">
                {{ item.installed ? 'Installed' : 'Missing' }} · {{ item.authenticated ? 'Authenticated' : 'No credentials' }}
              </div>
              <div v-if="item.models.length > 0" class="text-[10px] text-[var(--text-secondary)] truncate">
                Models: {{ item.models.join(', ') }}
              </div>
            </div>
          </div>
        </div>

        <!-- Capability Permissions Selection -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-[var(--text-primary)]">Requested Capabilities & Permissions</span>
            <span class="text-[10px] text-[var(--text-muted)]">Human Selection Required</span>
          </div>
          <p class="text-[11px] text-[var(--text-secondary)]">
            Approval records only the Human-selected permissions and never creates engine login, Project access, or model readiness by implication.
          </p>

          <div class="space-y-2 p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)]">
            <div
              v-for="cap in requestedCapabilitiesList"
              :key="cap"
              class="flex items-center justify-between p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)]/50"
            >
              <label :for="`perm-${cap}`" class="text-xs font-medium text-[var(--text-primary)] cursor-pointer select-none">
                {{ cap }}
              </label>
              <Checkbox
                :id="`perm-${cap}`"
                v-model="selectedPermissions[cap]"
                class="min-h-[24px] min-w-[24px]"
              />
            </div>
          </div>
        </div>

        <div v-if="stateNotice" class="text-xs text-[var(--red-action)] bg-[var(--red-action-bg)] p-2 rounded">
          {{ stateNotice }}
        </div>
      </div>

      <!-- PHASE 4: APPROVED STATE -->
      <div v-else-if="phase === 'approved'" class="text-center py-6 space-y-3">
        <div class="w-12 h-12 rounded-full bg-[var(--green-healthy)]/20 text-[var(--green-healthy)] flex items-center justify-center mx-auto">
          <Icon name="check" :size="24" />
        </div>
        <h3 class="text-sm font-bold text-[var(--text-primary)]">Environment Enrolled Successfully</h3>
        <p class="text-xs text-[var(--text-secondary)] max-w-sm mx-auto">
          The host environment has been approved by the operator and registered into the execution catalog.
        </p>
      </div>
    </div>

    <!-- FOOTER ACTIONS -->
    <template #footer>
      <div class="flex items-center justify-between w-full flex-wrap gap-2">
        <div>
          <Button
            v-if="phase === 'active' || phase === 'review'"
            variant="ghost"
            size="sm"
            class="cancel-enroll-btn text-xs text-[var(--red-action)] hover:text-[var(--red-action)] hover:bg-[var(--red-action-bg)] min-h-[44px]"
            @click="handleCancelEnrollment"
          >
            <Icon name="trash" :size="13" />
            <span>Cancel Pending Enrollment</span>
          </Button>
        </div>

        <div class="flex items-center gap-2 ml-auto">
          <Button
            v-if="phase === 'create'"
            variant="secondary"
            size="sm"
            class="min-h-[44px]"
            @click="emit('update:open', false)"
          >
            Cancel
          </Button>
          <Button
            v-if="phase === 'create'"
            id="btn-submit-registration"
            variant="primary"
            size="sm"
            class="min-h-[44px]"
            :disabled="isSubmitting"
            @click="handleCreatePending"
          >
            <Icon v-if="isSubmitting" name="refresh" class="animate-spin" :size="13" />
            <span>{{ isSubmitting ? 'Creating...' : 'Begin Registration' }}</span>
          </Button>

          <Button
            v-if="phase === 'active'"
            variant="secondary"
            size="sm"
            class="min-h-[44px]"
            @click="emit('update:open', false)"
          >
            Close Dialog (Keep Pending)
          </Button>

          <Button
            v-if="phase === 'review'"
            id="btn-approve-enrollment"
            variant="primary"
            size="sm"
            class="min-h-[44px]"
            @click="handleApprove"
          >
            <Icon name="check" :size="14" />
            <span>Approve Worker & Permissions</span>
          </Button>

          <Button
            v-if="phase === 'approved'"
            id="btn-done-enrollment"
            variant="primary"
            size="sm"
            class="min-h-[44px]"
            @click="handleDone"
          >
            Done
          </Button>
        </div>
      </div>
    </template>
  </Dialog>
</template>
