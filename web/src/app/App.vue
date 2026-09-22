<script setup lang="ts">
/**
 * The application root: one Shell frame around whichever destination route is
 * active. Bounded cross-page state (theme, return context) lives in Pinia; the
 * destination itself owns its remote facts and local interaction state.
 */
import { RouterView } from 'vue-router';
import AppShell from '../shell/AppShell.vue';
import AuthGate from './AuthGate.vue';
import { OPERATOR_SESSION } from './auth.js';
import { inject } from 'vue';

const operatorSession = inject(OPERATOR_SESSION);
</script>

<template>
  <AuthGate v-if="operatorSession !== undefined">
    <AppShell>
      <RouterView />
    </AppShell>
  </AuthGate>
  <AppShell v-else>
    <RouterView />
  </AppShell>
</template>
