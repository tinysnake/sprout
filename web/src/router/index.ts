import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import EnvironmentsView from '../modules/environments/views/EnvironmentsView.vue';
import FeedView from '../views/FeedView.vue';
import ProjectView from '../views/ProjectView.vue';
import AgentsPlaceholder from '../views/AgentsPlaceholder.vue';
import UsagePlaceholder from '../views/UsagePlaceholder.vue';
import SettingsPlaceholder from '../views/SettingsPlaceholder.vue';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/manage/environments',
  },
  {
    path: '/feed',
    name: 'feed',
    component: FeedView,
  },
  {
    path: '/project',
    name: 'project',
    component: ProjectView,
  },
  {
    path: '/manage',
    redirect: '/manage/environments',
  },
  {
    path: '/manage/environments',
    name: 'environments',
    component: EnvironmentsView,
  },
  {
    path: '/manage/environments/:id',
    name: 'environment-detail',
    component: EnvironmentsView,
  },
  {
    path: '/manage/agents',
    name: 'agents',
    component: AgentsPlaceholder,
  },
  {
    path: '/manage/usage',
    name: 'usage',
    component: UsagePlaceholder,
  },
  {
    path: '/manage/settings',
    name: 'settings',
    component: SettingsPlaceholder,
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
