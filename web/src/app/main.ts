import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { createAppRouter } from '../router/index.js';
import { ENVIRONMENT_SERVICE, type EnvironmentService } from '../modules/environments/ports.js';
import type { ShellConnectionSource } from '../shell/connection.js';
import { SHELL_CONNECTION_SOURCE } from '../shell/use-shell-connection.js';
import { ANNOUNCER_KEY, ANNOUNCER_MESSAGE_KEY, createAnnouncerChannel } from '../primitives/announcer.js';
import '../tokens/theme.css';

export interface SproutAppOptions {
  routerBase?: string;
  /**
   * The typed environment authority for `/manage/environments`.
   *
   * Production wiring supplies a real adapter here. Deterministic DOM tests
   * inject a fixture adapter explicitly. When it is omitted the route renders an
   * explicit unavailable state rather than defaulting to fixture facts, so a
   * production route can never expose fixture-backed behaviour.
   */
  environmentService?: EnvironmentService;
  /**
   * A page-owned connection source.
   *
   * When a page already owns a #85 transport it supplies it here so the Shell
   * reports what that transport observed; otherwise the Shell falls back to the
   * browser-level signal rather than claiming Sprout answered.
   */
  connectionSource?: ShellConnectionSource;
}

export function createSproutApp(options: SproutAppOptions = {}) {
  const app = createApp(App);
  const pinia = createPinia();
  const router = createAppRouter(options.routerBase);

  app.use(pinia);
  app.use(router);

  // The announcement channel is provided at the application level so the one
  // live region in the Shell and every destination route share it. Slot content
  // resolves in the parent's context, so a Shell-level `provide` would not
  // reach the router view.
  const announcerChannel = createAnnouncerChannel();
  app.provide(ANNOUNCER_KEY, announcerChannel.announcer);
  app.provide(ANNOUNCER_MESSAGE_KEY, announcerChannel.message);

  if (options.environmentService) {
    app.provide(ENVIRONMENT_SERVICE, options.environmentService);
  }
  if (options.connectionSource) {
    app.provide(SHELL_CONNECTION_SOURCE, options.connectionSource);
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
