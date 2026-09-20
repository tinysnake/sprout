/**
 * The production route hierarchy: Feed, Project, and Manage destinations with
 * URL-addressable detail and history-backed drill-down.
 *
 * Destinations are parent records so `route.meta.destination` and
 * `route.meta.tab` identify where the operator is for the Shell's navigation,
 * the phone sub-navigation, and the return control alike. Detail records use a
 * real path parameter, so refresh, browser back/forward, and a pasted deep link
 * all restore the same context.
 *
 * Decision record: ADR-0011 (Vue Router owns URL-addressable navigation and
 * browser history); retained structural baseline
 * `docs/research/production-web-structural-baseline.md` §2.1–§2.5.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import EnvironmentsView from '../modules/environments/views/EnvironmentsView.vue';
import FeedView from '../views/FeedView.vue';
import ProjectView from '../views/ProjectView.vue';
import AgentsView from '../views/AgentsView.vue';
import UsageView from '../views/UsageView.vue';
import SettingsView from '../views/SettingsView.vue';

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: { name: 'feed' },
  },
  {
    path: '/feed',
    name: 'feed',
    component: FeedView,
    meta: { destination: 'feed' },
  },
  {
    path: '/project',
    redirect: { name: 'project-overview' },
    meta: { destination: 'project' },
    children: [
      {
        path: 'overview',
        name: 'project-overview',
        component: ProjectView,
        meta: { destination: 'project', tab: 'overview' },
      },
      {
        path: 'tasks',
        name: 'project-tasks',
        component: ProjectView,
        meta: { destination: 'project', tab: 'tasks' },
      },
      {
        path: 'tasks/:taskId',
        name: 'project-task-detail',
        component: ProjectView,
        meta: { destination: 'project', tab: 'tasks' },
      },
      {
        path: 'chat',
        name: 'project-chat',
        component: ProjectView,
        meta: { destination: 'project', tab: 'chat' },
      },
      {
        path: 'chat/:scopeId',
        name: 'project-chat-scope',
        component: ProjectView,
        meta: { destination: 'project', tab: 'chat' },
      },
    ],
  },
  {
    path: '/manage',
    redirect: { name: 'environments' },
    meta: { destination: 'manage' },
    children: [
      {
        path: 'environments',
        name: 'environments',
        component: EnvironmentsView,
        meta: { destination: 'manage', tab: 'environments' },
      },
      {
        path: 'environments/:id',
        name: 'environment-detail',
        component: EnvironmentsView,
        meta: { destination: 'manage', tab: 'environments' },
      },
      {
        path: 'agents',
        name: 'agents',
        component: AgentsView,
        meta: { destination: 'manage', tab: 'agents' },
      },
      {
        path: 'agents/:agentId',
        name: 'agent-detail',
        component: AgentsView,
        meta: { destination: 'manage', tab: 'agents' },
      },
      {
        path: 'usage',
        name: 'usage',
        component: UsageView,
        meta: { destination: 'manage', tab: 'usage' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: SettingsView,
        meta: { destination: 'manage', tab: 'settings' },
      },
    ],
  },
  {
    // An unknown URL is a navigation mistake, not a broken page: return the
    // operator to the Feed rather than rendering an error route.
    path: '/:pathMatch(.*)*',
    redirect: { name: 'feed' },
  },
];

export function createAppRouter(basePath?: string) {
  const base =
    basePath ??
    (typeof window !== 'undefined' && window.location.pathname.startsWith('/app')
      ? '/app/'
      : '/');

  return createRouter({
    history: createWebHistory(base),
    routes,
  });
}
