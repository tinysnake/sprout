<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';

import { OPERATOR_SESSION } from './auth.js';

const session = inject(OPERATOR_SESSION);
const checking = ref(true);
const authenticated = ref(false);
const credential = ref('');
const error = ref<string | undefined>();
const signingIn = ref(false);

onMounted(async () => {
  if (session === undefined) {
    checking.value = false;
    authenticated.value = true;
    return;
  }
  try {
    await session.listSessions();
    authenticated.value = true;
  } catch {
    // A missing/expired browser session is the normal login state.
  } finally {
    checking.value = false;
  }
});

async function signIn(): Promise<void> {
  if (session === undefined || credential.value.trim() === '') return;
  signingIn.value = true;
  error.value = undefined;
  try {
    await session.signIn(credential.value);
    await session.listSessions();
    credential.value = '';
    authenticated.value = true;
  } catch {
    error.value = 'Operator authentication failed. Check the host-supplied credential.';
  } finally {
    signingIn.value = false;
  }
}
</script>

<template>
  <slot v-if="authenticated" />
  <main v-else class="auth-gate" aria-labelledby="auth-title">
    <section class="auth-card">
      <p class="auth-eyebrow">Sprout Operator Console</p>
      <h1 id="auth-title">Sign in to Sprout</h1>
      <p class="auth-copy">This local console requires the operator credential configured on the Sprout host.</p>
      <p v-if="checking" class="auth-status" role="status">Checking browser session…</p>
      <form v-else @submit.prevent="signIn">
        <label class="auth-label" for="operator-credential">Operator credential</label>
        <input
          id="operator-credential"
          v-model="credential"
          class="auth-input"
          type="password"
          autocomplete="current-password"
          autofocus
          required
        />
        <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
        <button class="auth-submit" type="submit" :disabled="signingIn">
          {{ signingIn ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.auth-gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-page, #0b1020);
  color: var(--text-primary, #f8fafc);
}

.auth-card {
  width: min(100%, 440px);
  padding: 32px;
  border: 1px solid var(--border-subtle, #334155);
  border-radius: 18px;
  background: var(--bg-surface, #111827);
  box-shadow: 0 18px 60px rgb(0 0 0 / 28%);
}

.auth-eyebrow {
  margin: 0 0 8px;
  color: var(--text-secondary, #94a3b8);
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.auth-card h1 { margin: 0; font-size: 28px; }
.auth-copy { color: var(--text-secondary, #cbd5e1); line-height: 1.5; }
.auth-label { display: block; margin: 24px 0 8px; font-weight: 600; }
.auth-input { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid #475569; border-radius: 8px; background: #0f172a; color: inherit; }
.auth-submit { width: 100%; margin-top: 16px; padding: 12px; border: 0; border-radius: 8px; background: #6366f1; color: white; font-weight: 700; cursor: pointer; }
.auth-submit:disabled { cursor: wait; opacity: .65; }
.auth-error { color: #fda4af; }
.auth-status { color: var(--text-secondary, #94a3b8); }
</style>
