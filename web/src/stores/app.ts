/**
 * Bounded cross-page state: presentation theme plus the Deep-link return context.
 *
 * It owns no domain facts. Authoritative Project, Task, Message, Environment,
 * Agent, and Usage facts arrive through typed ports and transport adapters; the
 * prototype StateManager is deliberately not migrated (ADR-0011).
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ThemeMode = 'dark' | 'light';

export interface ReturnContext {
  /** Visible return control label, for example `Back to Feed`. */
  title: string;
  /** Route to restore, for example `/feed?scope=minesweeper`. */
  to: string;
}

export const useAppStore = defineStore('app', () => {
  const theme = ref<ThemeMode>('dark');
  const returnContext = ref<ReturnContext | null>(null);

  function initTheme() {
    if (typeof document === 'undefined') return;
    const saved = localStorage.getItem('sprout-theme') as ThemeMode | null;
    if (saved === 'light' || saved === 'dark') {
      theme.value = saved;
    }
    document.documentElement.setAttribute('data-theme', theme.value);
  }

  function setTheme(newTheme: ThemeMode) {
    theme.value = newTheme;
    if (typeof document !== 'undefined') {
      localStorage.setItem('sprout-theme', newTheme);
      document.documentElement.setAttribute('data-theme', newTheme);
    }
  }

  function toggleTheme() {
    setTheme(theme.value === 'dark' ? 'light' : 'dark');
  }

  function setReturnContext(ctx: ReturnContext | null) {
    returnContext.value = ctx;
  }

  function clearReturnContext() {
    returnContext.value = null;
  }

  return {
    theme,
    returnContext,
    initTheme,
    setTheme,
    toggleTheme,
    setReturnContext,
    clearReturnContext,
  };
});
