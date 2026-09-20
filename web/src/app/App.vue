<script setup lang="ts">
/**
 * The application root: one Shell frame around whichever destination route is
 * active. Bounded cross-page state (theme, return context) lives in Pinia; the
 * destination itself owns its remote facts and local interaction state.
 */
import { RouterView } from 'vue-router';
import AppShell from '../shell/AppShell.vue';
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>
</template>
