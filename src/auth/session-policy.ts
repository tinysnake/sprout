/**
 * The bounded lifetime of one browser session.
 *
 * An absolute limit prevents a session from becoming permanent through activity;
 * an idle limit bounds a forgotten browser. Both limits are persisted with every
 * record so a future policy change cannot silently extend a live session.
 */
export const BROWSER_SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
export const BROWSER_SESSION_IDLE_LIFETIME_MS = 12 * 60 * 60 * 1_000;

export function absoluteSessionExpiry(createdAt: number): number {
  return createdAt + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS;
}

export function idleSessionExpiry(lastSeenAt: number, absoluteExpiresAt: number): number {
  return Math.min(lastSeenAt + BROWSER_SESSION_IDLE_LIFETIME_MS, absoluteExpiresAt);
}

export function sessionHasExpired(
  session: { readonly absoluteExpiresAt: number; readonly idleExpiresAt: number },
  now: number,
): boolean {
  return now >= session.absoluteExpiresAt || now >= session.idleExpiresAt;
}
