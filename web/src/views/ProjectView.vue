<script setup lang="ts">
import EmptyState from '../primitives/EmptyState.vue';
</script>

<template>
  <div class="p-6 max-w-4xl mx-auto flex flex-col gap-6">
    <div class="border-b border-[var(--border-subtle)] pb-4">
      <h2 class="text-lg font-bold text-[var(--text-primary)]">Project Multi-View</h2>
      <p class="text-xs text-[var(--text-secondary)] mt-1">
        Overview, Tasks, and Scoped Chat (bounded shell destination).
      </p>
    </div>

    <EmptyState
      icon="project"
      title="Project destination bounded for Ticket #74"
      description="In accordance with ADR-0011 non-goals, Project multi-view migration is scheduled for downstream tickets following Shell and Environments baseline validation."
    />
  </div>
</template>
