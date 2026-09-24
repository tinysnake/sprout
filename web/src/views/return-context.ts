/**
 * Return context for cross-destination navigation.
 *
 * A Feed card or a Project action that sends the operator to another
 * authoritative surface records where they came from, so the destination is
 * never a dead end. The route is resolved to a full path at record time, so a
 * plain page refresh cannot lose it.
 */
import type { Router, RouteLocationRaw } from 'vue-router';
import { useAppStore } from '../stores/app.js';

export function setReturnToFeed(router: Router, destinationName?: string): void {
  const label = destinationName ? `Back to Feed` : 'Back to Feed';
  useAppStore().setReturnContext({
    title: label,
    to: router.resolve({ name: 'feed' }).fullPath,
  });
}

export function setReturnToDestination(
  router: Router,
  target: RouteLocationRaw,
  title: string
): void {
  useAppStore().setReturnContext({ title, to: router.resolve(target).fullPath });
}

export function clearReturnContext(): void {
  useAppStore().clearReturnContext();
}
