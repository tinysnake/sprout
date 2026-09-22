/**
 * Shell navigation model: route identity, current marking, indicators, and the
 * single source both navigations and the return control read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import {
  buildNavigation,
  destinationOf,
  environmentDetailTarget,
  isDrillDown,
  NO_NAVIGATION_INDICATORS,
  tabOf,
  type NavigationIndicators,
} from './navigation.ts';

/** Minimal route stand-in: the model reads meta, params, and matched only. */
function routeOf(
  path: string,
  options: { destination?: string; tab?: string; params?: Record<string, string> } = {}
): RouteLocationNormalizedLoaded {
  const meta: Record<string, unknown> = {};
  if (options.destination) meta['destination'] = options.destination;
  if (options.tab) meta['tab'] = options.tab;
  return {
    path,
    params: options.params ?? {},
    meta,
    matched: [{ meta }],
  } as unknown as RouteLocationNormalizedLoaded;
}

const INDICATORS: NavigationIndicators = { attention: 4, activeWork: 3, degradedEnvironments: 2 };

test('destination and tab come from the matched route record', () => {
  assert.equal(destinationOf(routeOf('/feed', { destination: 'feed' })), 'feed');
  assert.equal(destinationOf(routeOf('/project/tasks', { destination: 'project', tab: 'tasks' })), 'project');
  assert.equal(destinationOf(routeOf('/manage/usage', { destination: 'manage', tab: 'usage' })), 'manage');
  assert.equal(tabOf(routeOf('/project/chat', { destination: 'project', tab: 'chat' })), 'chat');
  assert.equal(tabOf(routeOf('/feed', { destination: 'feed' })), undefined);
});

test('an unmatched route reports the Feed destination rather than an undefined shell', () => {
  assert.equal(destinationOf(routeOf('/nowhere')), 'feed');
});

test('a route with a record parameter is a drill-down; a destination root is not', () => {
  assert.equal(isDrillDown(routeOf('/manage/environments/env-ready', { destination: 'manage', params: { id: 'env-ready' } })), true);
  assert.equal(isDrillDown(routeOf('/project/tasks/101', { destination: 'project', tab: 'tasks', params: { taskId: '101' } })), true);
  assert.equal(isDrillDown(routeOf('/manage/environments', { destination: 'manage' })), false);
  assert.equal(isDrillDown(routeOf('/project/tasks', { destination: 'project', tab: 'tasks' })), false);
});

test('the sidebar always groups the three destinations as Operations, Project, and Manage', () => {
  const model = buildNavigation(routeOf('/feed', { destination: 'feed' }));
  assert.deepEqual(model.sections.map((s) => s.label), ['Operations', 'Project', 'Manage']);
  assert.equal(model.sections[0]?.items.length, 1);
  assert.equal(model.sections[1]?.items.length, 3);
  assert.equal(model.sections[2]?.items.length, 4);
});

test('exactly one item is current per navigation surface', () => {
  const model = buildNavigation(routeOf('/project/chat', { destination: 'project', tab: 'chat' }));

  const primaryCurrent = model.primary.filter((item) => item.current);
  assert.equal(primaryCurrent.length, 1);
  assert.equal(primaryCurrent[0]?.key, 'project');

  const nestedCurrent = model.nested.filter((item) => item.current);
  assert.equal(nestedCurrent.length, 1);
  assert.equal(nestedCurrent[0]?.key, 'chat');
});

test('each navigation surface marks exactly one entry current', () => {
  for (const [path, destination, tab] of [
    ['/feed', 'feed', undefined],
    ['/project/tasks', 'project', 'tasks'],
    ['/manage/settings', 'manage', 'settings'],
  ] as const) {
    const model = buildNavigation(routeOf(path, { destination, ...(tab ? { tab } : {}) }));

    // The sidebar's Project and Manage sections hold the nested entries, so it
    // marks the active tab; it is still exactly one current entry overall.
    const sidebarCurrent = model.sections.flatMap((s) => s.items).filter((i) => i.current);
    assert.equal(sidebarCurrent.length, 1, `sidebar marks one entry on ${path}`);
    assert.equal(sidebarCurrent[0]?.key, tab ?? destination, `sidebar marks ${tab ?? destination} on ${path}`);

    const phoneCurrent = model.primary.filter((i) => i.current);
    assert.equal(phoneCurrent.length, 1, `phone marks one destination on ${path}`);
    assert.equal(phoneCurrent[0]?.key, destination, `phone marks ${destination} on ${path}`);
  }
});

test('indicators reach every surface that renders them, and degrade to zero without a source', () => {
  const withoutSource = buildNavigation(routeOf('/feed', { destination: 'feed' }));
  const feed = withoutSource.primary.find((i) => i.key === 'feed');
  assert.equal(feed?.count, 0);
  assert.equal(feed?.alert, false);
  assert.deepEqual(NO_NAVIGATION_INDICATORS, { attention: 0, activeWork: 0, degradedEnvironments: 0 });

  const withSource = buildNavigation(routeOf('/project/tasks', { destination: 'project', tab: 'tasks' }), INDICATORS);
  const attention = withSource.primary.find((i) => i.key === 'feed');
  const activeWork = withSource.primary.find((i) => i.key === 'project');
  const degraded = withSource.primary.find((i) => i.key === 'manage');
  assert.equal(attention?.count, 4);
  assert.equal(attention?.indicatorStatus, 'yellow');
  assert.equal(activeWork?.count, 3);
  assert.equal(activeWork?.indicatorStatus, 'blue');
  // A degraded environment is a condition, not a counted population, so it
  // renders as an alert marker instead of a fabricated item count.
  assert.equal(degraded?.count, 2);
  assert.equal(degraded?.alert, true);
  assert.equal(degraded?.indicatorStatus, 'red');
});

test('the nested navigation is the active destination only, and empty at the Feed', () => {
  assert.equal(buildNavigation(routeOf('/feed', { destination: 'feed' })).nested.length, 0);
  assert.deepEqual(
    buildNavigation(routeOf('/project/overview', { destination: 'project', tab: 'overview' })).nested.map((i) => i.key),
    ['overview', 'tasks', 'chat']
  );
  assert.deepEqual(
    buildNavigation(routeOf('/manage/agents', { destination: 'manage', tab: 'agents' })).nested.map((i) => i.key),
    ['environments', 'agents', 'usage', 'settings']
  );
});

test('drill-down is reported so a page can compose the phone detail header', () => {
  const detail = buildNavigation(
    routeOf('/manage/environments/env-recovery', { destination: 'manage', tab: 'environments', params: { id: 'env-recovery' } })
  );
  assert.equal(detail.drillDown, true);
  assert.equal(detail.destination, 'manage');
  assert.equal(detail.tab, 'environments');
  assert.equal(buildNavigation(routeOf('/manage/environments', { destination: 'manage', tab: 'environments' })).drillDown, false);
});

test('navigation targets are named routes, so a URL change cannot silently break a link', () => {
  const model = buildNavigation(routeOf('/feed', { destination: 'feed' }));
  const everything = [...model.sections.flatMap((s) => s.items), ...model.primary, ...buildNavigation(routeOf('/manage/usage', { destination: 'manage', tab: 'usage' })).nested];
  assert.ok(everything.length >= 8);
  for (const item of everything) {
    assert.equal(typeof item.to, 'object', `${item.key} uses a named target`);
    assert.ok('name' in (item.to as Record<string, unknown>), `${item.key} has a route name`);
  }
  assert.deepEqual(environmentDetailTarget('env-ready'), { name: 'environment-detail', params: { id: 'env-ready' } });
});
