<script setup lang="ts">
import EmptyState from '../primitives/EmptyState.vue';
import Button from '../primitives/Button.vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.js';

const router = useRouter();
const appStore = useAppStore();

function navigateToEnvironmentsWithContext() {
  appStore.setReturnContext({
    title: 'Back to Feed',
    to: '/feed',
  });
  router.push('/manage/environments/env-recovery');
}
</script>

<template>
  <div class="p-6 max-w-4xl mx-auto flex flex-col gap-6">
    <div class="border-b border-[var(--border-subtle)] pb-4">
      <h2 class="text-lg font-bold text-[var(--text-primary)]">Feed & Attention</h2>
      <p class="text-xs text-[var(--text-secondary)] mt-1">
        Operational discovery and triage landing surface (bounded shell destination).
      </p>
    </div>

    <!-- Deep link demonstration card -->
    <div class="p-4 rounded-[var(--radius-md)] border border-[var(--yellow-attention)] bg-[var(--yellow-attention-bg)] flex items-center justify-between gap-4 flex-wrap">
      <div>
        <strong class="text-xs font-bold text-[var(--text-primary)] block">Attention Required: Windows Host Offline</strong>
        <p class="text-xs text-[var(--text-secondary)] mt-0.5">
          Task #104 held in recovery on Windows Workstation 01. Click below to test the deep-link discovery and return context banner.
        </p>
      </div>
      <Button variant="warning" size="sm" @click="navigateToEnvironmentsWithContext">
        Inspect in Manage / Environments →
      </Button>
    </div>

    <EmptyState
      icon="feed"
      title="Feed destination bounded for Ticket #74"
      description="In accordance with ADR-0011 non-goals, Feed migration is scheduled for downstream tickets following Shell and Environments baseline validation."
    />
  </div>
</template>
