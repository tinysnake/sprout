/**
 * The single authority for Shell navigation.
 *
 * The desktop sidebar, the phone bottom navigation, and the phone sub-navigation
 * are three renderings of one model, so a route change cannot leave them
 * disagreeing. It holds no domain state: counts and alert conditions arrive
 * through `NavigationIndicators`, which is a typed port with a neutral default
 * rather than a fixture or a hard-coded number.
 *
 * Decision record: ADR-0011 (Vue Router owns URL navigation, bounded Pinia state)
 * and the retained structural baseline `docs/research/production-web-structural-baseline.md`
 * §2.1 (three destinations, sidebar section grouping, phone bottom navigation,
 * nested Project/Manage sub-navigation).
 */
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router';

export type DestinationKey = 'feed' | 'project' | 'manage';
export type ProjectTabKey = 'overview' | 'tasks' | 'chat';
export type ManageTabKey = 'environments' | 'agents' | 'usage' | 'settings';
export type DestinationTabKey = ProjectTabKey | ManageTabKey;
export type IndicatorKind = 'attention' | 'active-work' | 'degraded';
export type IndicatorStatus = 'yellow' | 'blue' | 'red';

/** Bounded shell facts. Absent backend support reports zero, never a guessed value. */
export interface NavigationIndicators {
  readonly attention: number;
  readonly activeWork: number;
  readonly degradedEnvironments: number;
}

export const NO_NAVIGATION_INDICATORS: NavigationIndicators = Object.freeze({
  attention: 0,
  activeWork: 0,
  degradedEnvironments: 0,
});

export interface NavigationItem {
  readonly key: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly icon: string;
  readonly to: RouteLocationRaw;
  readonly indicator?: IndicatorKind;
}

export interface NavigationItemView extends NavigationItem {
  readonly current: boolean;
  readonly count: number;
  readonly alert: boolean;
  readonly indicatorStatus?: IndicatorStatus;
}

export interface NavigationSection {
  readonly label: string;
  readonly items: readonly NavigationItemView[];
}

export interface NavigationModel {
  readonly destination: DestinationKey;
  readonly tab?: DestinationTabKey;
  readonly drillDown: boolean;
  /** Desktop sidebar sections: Operations, Project, Manage. */
  readonly sections: readonly NavigationSection[];
  /** Phone root destinations: Feed, Project, Manage. */
  readonly primary: readonly NavigationItemView[];
  /** Phone sub-navigation for the active destination, without the return control. */
  readonly nested: readonly NavigationItemView[];
}

const INDICATOR_STATUS: Readonly<Record<IndicatorKind, IndicatorStatus>> = {
  attention: 'yellow',
  'active-work': 'blue',
  degraded: 'red',
};

export const FEED_ITEM: NavigationItem = {
  key: 'feed',
  label: 'Feed & Attention',
  shortLabel: 'Feed',
  icon: 'feed',
  to: { name: 'feed' },
  indicator: 'attention',
};

export const PROJECT_ITEM: NavigationItem = {
  key: 'project',
  label: 'Project',
  shortLabel: 'Project',
  icon: 'project',
  to: { name: 'project-overview' },
  indicator: 'active-work',
};

export const MANAGE_ITEM: NavigationItem = {
  key: 'manage',
  label: 'Manage',
  shortLabel: 'Manage',
  icon: 'manage',
  to: { name: 'environments' },
  indicator: 'degraded',
};

export const PROJECT_ITEMS: readonly NavigationItem[] = [
  { key: 'overview', label: 'Overview & Contract', shortLabel: 'Overview', icon: 'overview', to: { name: 'project-overview' } },
  { key: 'tasks', label: 'Tasks & Leases', shortLabel: 'Tasks', icon: 'tasks', to: { name: 'project-tasks' }, indicator: 'active-work' },
  { key: 'chat', label: 'Project Chat', shortLabel: 'Chat', icon: 'chat', to: { name: 'project-chat' } },
];

export const MANAGE_ITEMS: readonly NavigationItem[] = [
  { key: 'environments', label: 'Environments', shortLabel: 'Envs', icon: 'environments', to: { name: 'environments' }, indicator: 'degraded' },
  { key: 'agents', label: 'Agents', shortLabel: 'Agents', icon: 'agents', to: { name: 'agents' } },
  { key: 'usage', label: 'Usage & Costs', shortLabel: 'Usage', icon: 'usage', to: { name: 'usage' } },
  { key: 'settings', label: 'Settings', shortLabel: 'Settings', icon: 'settings', to: { name: 'settings' } },
];

/** Route params that mean "the operator opened one record", not "the destination root". */
const DETAIL_PARAMS: readonly string[] = ['id', 'taskId'];

export function destinationOf(route: RouteLocationNormalizedLoaded): DestinationKey {
  for (const record of route.matched) {
    const destination = record.meta['destination'];
    if (destination === 'feed' || destination === 'project' || destination === 'manage') return destination;
  }
  return 'feed';
}

export function tabOf(route: RouteLocationNormalizedLoaded): DestinationTabKey | undefined {
  for (const record of route.matched) {
    const tab = record.meta['tab'];
    if (typeof tab === 'string') return tab as DestinationTabKey;
  }
  return undefined;
}

export function isDrillDown(route: RouteLocationNormalizedLoaded): boolean {
  return DETAIL_PARAMS.some((key) => {
    const value = route.params[key];
    return typeof value === 'string' && value.length > 0;
  });
}

export function indicatorCount(indicators: NavigationIndicators, kind: IndicatorKind | undefined): number {
  if (kind === 'attention') return indicators.attention;
  if (kind === 'active-work') return indicators.activeWork;
  if (kind === 'degraded') return indicators.degradedEnvironments;
  return 0;
}

function toView(
  item: NavigationItem,
  options: { readonly current: boolean; readonly indicators: NavigationIndicators }
): NavigationItemView {
  const count = indicatorCount(options.indicators, item.indicator);
  const indicatorStatus = item.indicator === undefined ? undefined : INDICATOR_STATUS[item.indicator];
  // `degraded` is a condition, not a counted population; it renders as an alert
  // marker so a degraded host is visible without inventing an item count.
  const alert = item.indicator === 'degraded' && count > 0;
  return {
    ...item,
    current: options.current,
    count,
    alert,
    ...(indicatorStatus === undefined ? {} : { indicatorStatus }),
  };
}

export function projectItems(
  current: DestinationTabKey | undefined,
  indicators: NavigationIndicators
): readonly NavigationItemView[] {
  return PROJECT_ITEMS.map((item) => toView(item, { current: current === item.key, indicators }));
}

export function manageItems(
  current: DestinationTabKey | undefined,
  indicators: NavigationIndicators
): readonly NavigationItemView[] {
  return MANAGE_ITEMS.map((item) => toView(item, { current: current === item.key, indicators }));
}

/**
 * Builds the whole navigation model for one route.
 *
 * Both navigations and the phone return control read this, so the current
 * destination, its tab, and every badge stay consistent by construction.
 */
export function buildNavigation(
  route: RouteLocationNormalizedLoaded,
  indicators: NavigationIndicators = NO_NAVIGATION_INDICATORS
): NavigationModel {
  const destination = destinationOf(route);
  const tab = tabOf(route);
  const on = (key: DestinationKey): boolean => destination === key;

  const sections: NavigationSection[] = [
    { label: 'Operations', items: [toView(FEED_ITEM, { current: on('feed'), indicators })] },
    { label: 'Project', items: projectItems(tab, indicators) },
    { label: 'Manage', items: manageItems(tab, indicators) },
  ];

  const primary: NavigationItemView[] = [
    toView(FEED_ITEM, { current: on('feed'), indicators }),
    toView(PROJECT_ITEM, { current: on('project'), indicators }),
    toView(MANAGE_ITEM, { current: on('manage'), indicators }),
  ];

  const nestedSource = on('project') ? PROJECT_ITEMS : on('manage') ? MANAGE_ITEMS : [];
  const nested = nestedSource.map((item) => toView(item, { current: tab === item.key, indicators }));

  return {
    destination,
    ...(tab === undefined ? {} : { tab }),
    drillDown: isDrillDown(route),
    sections,
    primary,
    nested,
  };
}

/** The phone sub-navigation return control target: the root destinations surface. */
export const NAVIGATION_ROOT: RouteLocationRaw = { name: 'feed' };

/** Deep-link target for one record on an authoritative domain surface. */
export function environmentDetailTarget(id: string): RouteLocationRaw {
  return { name: 'environment-detail', params: { id } };
}
