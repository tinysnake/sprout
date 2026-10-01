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
import { PROJECT_SERVICE, type ProjectManagementService } from '../modules/projects/types.js';
import { ProductionProjectService } from '../modules/projects/adapters/production-adapter.js';
import { CHAT_SERVICE, type ChatService } from '../modules/chat/types.js';
import { ProductionChatService } from '../modules/chat/adapters/production-adapter.js';
import { createConversationBrowserAdapter } from '../adapters/conversation-api.js';
import { createMessageBrowserAdapter } from '../adapters/message-api.js';
import { createRoutingBrowserAdapter } from '../adapters/routing-api.js';
import { createRunBrowserAdapter } from '../adapters/run-api.js';
import { createTaskBrowserAdapter, type TaskBrowserAdapter } from '../adapters/task-api.js';
import { createFeedBrowserAdapter, type FeedBrowserAdapter } from '../adapters/feed-api.js';
import { FEED_API } from '../views/feed-port.js';
import { TASKS_API } from '../modules/tasks/types.js';
import { createProjectAccessBrowserAdapter, createProjectBrowserAdapter } from '../adapters/project-api.js';
import { createBrowserTransport } from '../transport/browser-transport.js';
import { createOperatorSessionBrowserAdapter } from '../adapters/operator-session-api.js';
import { createOperatorBrowserAdapter } from '../adapters/operator-api.js';
import { SETTINGS_SERVICE, type SettingsService } from '../modules/settings/ports.js';
import { ProductionSettingsService } from '../modules/settings/adapters/production-adapter.js';
import { OPERATOR_SESSION } from './auth.js';
import { USAGE_SERVICE, type UsageManagementService } from '../modules/usage/types.js';
import { createUsageBrowserAdapter } from '../adapters/usage-api.js';
import { ProductionUsageService } from '../modules/usage/adapters/production-adapter.js';
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
  /** The typed Project Overview authority; production and tests inject it explicitly. */
  projectService?: ProjectManagementService;
  /** Production Task proposal, run-history, lease, and control authority. */
  taskService?: TaskBrowserAdapter;
  /** Production read-only Attention, in-flight work, scope, and activity authority. */
  feedService?: FeedBrowserAdapter;
  /** Production Chat authority; tests inject a fixture explicitly, never by default. */
  chatService?: ChatService;
  /** Production Usage authority; tests inject a fixture explicitly, never by default. */
  usageService?: UsageManagementService;
  /**
   * A page-owned connection source.
   *
   * When a page already owns a #85 transport it supplies it here so the Shell
   * reports what that transport observed; otherwise the Shell falls back to the
   * browser-level signal rather than claiming Sprout answered.
   */
  connectionSource?: ShellConnectionSource;
  operatorSession?: ReturnType<typeof createOperatorSessionBrowserAdapter>;
  settingsService?: SettingsService;
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
  if (options.projectService) {
    app.provide(PROJECT_SERVICE, options.projectService);
  }
  if (options.taskService) {
    app.provide(TASKS_API, options.taskService);
  }
  if (options.feedService) {
    app.provide(FEED_API, options.feedService);
  }
  if (options.chatService) {
    app.provide(CHAT_SERVICE, options.chatService);
  }
  if (options.usageService) {
    app.provide(USAGE_SERVICE, options.usageService);
  }
  if (options.connectionSource) {
    app.provide(SHELL_CONNECTION_SOURCE, options.connectionSource);
  }
  if (options.operatorSession) {
    app.provide(OPERATOR_SESSION, options.operatorSession);
  }
  if (options.settingsService) {
    app.provide(SETTINGS_SERVICE, options.settingsService);
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
    const agentAdapter = createAgentBrowserAdapter(transport);
    const agentService = new ProductionAgentService(
      agentAdapter,
      () =>
        transport
          .request<{ readonly runs: readonly RunView[] }>('/api/runs')
          .then((body) => body.runs),
    );
    const projectService = new ProductionProjectService({
      projects: createProjectBrowserAdapter(transport),
      access: createProjectAccessBrowserAdapter(transport),
      agents: agentService,
      environments: environmentService,
    });
    const taskService = createTaskBrowserAdapter(transport);
    const feedService = createFeedBrowserAdapter(transport);
    const chatService = new ProductionChatService({
      conversations: createConversationBrowserAdapter(transport),
      messages: createMessageBrowserAdapter(transport),
      routing: createRoutingBrowserAdapter(transport),
      runs: createRunBrowserAdapter(transport),
    });
    const operatorApi = createOperatorBrowserAdapter(transport);
    const settingsService = new ProductionSettingsService(
      operatorApi,
      operatorSession,
      transport,
    );
    const usageAdapter = createUsageBrowserAdapter(transport);
    const usageService = new ProductionUsageService(usageAdapter);
    const { app, router } = createSproutApp({
      environmentService,
      agentService,
      projectService,
      taskService,
      feedService,
      chatService,
      usageService,
      connectionSource: transport,
      operatorSession,
      settingsService,
    });
    router.isReady().then(() => {
      app.mount(mountEl);
    });
  }
}
