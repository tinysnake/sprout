import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { createAppRouter } from '../router/index.js';
import type { EnvironmentService } from '../modules/environments/ports.js';
import '../tokens/theme.css';

export function createSproutApp(options: { routerBase?: string; environmentService?: EnvironmentService } = {}) {
  const app = createApp(App);
  const pinia = createPinia();
  const router = createAppRouter(options.routerBase);

  app.use(pinia);
  app.use(router);

  if (options.environmentService) {
    app.provide('environmentService', options.environmentService);
  }

  return { app, pinia, router };
}

// Auto-mount in browser when #app is found (unless manual mount in test)
if (typeof window !== 'undefined' && !(window as unknown as Record<string, unknown>).__SPROUT_TEST_MANUAL_MOUNT__) {
  const mountEl = document.getElementById('app');
  if (mountEl) {
    const { app, router } = createSproutApp();
    router.isReady().then(() => {
      app.mount(mountEl);
    });
  }
}
