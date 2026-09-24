import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { createAppRouter } from '../router/index.js';
import { ENVIRONMENT_SERVICE, type EnvironmentService } from '../modules/environments/ports.js';
import { createEnvironmentEnrollmentBrowserAdapter } from '../adapters/environment-api.js';
import { ProductionEnvironmentService } from '../modules/environments/adapters/production-adapter.js';
import { AGENT_SERVICE, type AgentManagementService } from '../modules/agents/types.js';
import { createAgentBrowserAdapter } from '../adapters/agent-api.js';
import { ProductionAgentService } from '../modules/agents/adapters/production-adapter.js';
import { createBrowserTransport } from '../transport/browser-transport.js';
import { createOperatorSessionBrowserAdapter } from '../adapters/operator-session-api.js';
import { OPERATOR_SESSION } from './auth.js';
import type { RunView } from '../../../src/web/views.ts';
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
   * The typed Agent authority for `/manage/agents` (#91).
   *
   * Production wiring supplies a real adapter here. Deterministic DOM tests
   * inject a fixture adapter explicitly. When it is omitted the route renders an
   * explicit unavailable state rather than defaulting to fixture facts, so a
   * production route can never expose fixture-backed behaviour.
   */
  agentService?: AgentManagementService;
  /**
   * A page-owned connection source.
   *
   * When a page already owns a #85 transport it supplies it here so the Shell
   * reports what that transport observed; otherwise the Shell falls back to the
   * browser-level signal rather than claiming Sprout answered.
   */
  connectionSource?: ShellConnectionSource;
  operatorSession?: ReturnType<typeof createOperatorSessionBrowserAdapter>;
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
  if (options.agentService) {
    app.provide(AGENT_SERVICE, options.agentService);
  }
  if (options.connectionSource) {
    app.provide(SHELL_CONNECTION_SOURCE, options.connectionSource);
  }
  if (options.operatorSession) {
    app.provide(OPERATOR_SESSION, options.operatorSession);
  }

  return { app, pinia, router };
}

// Auto-mount in browser when #app is found (unless manual mount in test)
if (typeof window !== 'undefined' && !(window as unknown as Record<string, unknown>).__SPROUT_TEST_MANUAL_MOUNT__) {
  const mountEl = document.getElementById('app');
  if (mountEl) {
    // The production bootstrap wires the real typed Environment adapter over the
    // shared #85 transport. Deterministic tests never run this branch (they set
    // __SPROUT_TEST_MANUAL_MOUNT__ and inject a fixture explicitly), so a fixture
    // can never become the production authority. The transport reports the
    // connection fact the Shell and the control boundary read.
    const transport = createBrowserTransport();
    const operatorSession = createOperatorSessionBrowserAdapter(transport);
    const environmentService = new ProductionEnvironmentService(
      createEnvironmentEnrollmentBrowserAdapter(transport),
    );
    // The typed Agent authority (#91): the durable identities and the
    // Environment-facts compatibility projection arrive through the #90 wire
    // adapter over the same shared transport; the run history read supplies
    // the attribution foldable. No fixture is involved.
    const agentService = new ProductionAgentService(
      createAgentBrowserAdapter(transport),
      () =>
        transport
          .request<{ readonly runs: readonly RunView[] }>('/api/runs')
          .then((body) => body.runs),
    );
    const { app, router } = createSproutApp({
      environmentService,
      agentService,
      connectionSource: transport,
      operatorSession,
    });
    router.isReady().then(() => {
      app.mount(mountEl);
    });
  }
}
