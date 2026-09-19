import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ThemeMode = 'dark' | 'light';

export interface ReturnContext {
  title: string;
  to: string;
}

export const useAppStore = defineStore('app', () => {
  const theme = ref<ThemeMode>('dark');
  const returnContext = ref<ReturnContext | null>(null);
  const operatorOnline = ref(true);

  function initTheme() {
    if (typeof document !== 'undefined') {
      const saved = localStorage.getItem('sprout-theme') as ThemeMode | null;
      if (saved === 'light' || saved === 'dark') {
        theme.value = saved;
      }
      document.documentElement.setAttribute('data-theme', theme.value);
    }
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
    operatorOnline,
    initTheme,
    setTheme,
    toggleTheme,
    setReturnContext,
    clearReturnContext,
  };
});
