import { computed, inject, ref, type InjectionKey } from 'vue';
import type { ChatService } from './types.ts';
import type { UnreadScopeCount } from '../../../../src/web/chat-read-router.ts';

/** One count-only snapshot shared by navigation, Feed, and conversation cards. */
export function createUnreadState(service: Pick<ChatService, 'listUnread' | 'markRead'>) {
  const scopes = ref<readonly UnreadScopeCount[]>([]);
  const available = ref(false);
  let revision = 0;
  let refreshing: Promise<void> | undefined;
  const acknowledged = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  async function refresh() {
    if (refreshing) return refreshing;
    const token = revision;
    refreshing = (async () => {
      try {
        const rows = await service.listUnread();
        if (token !== revision) return;
        if (!Array.isArray(rows) || rows.some((r) => typeof r.scopeId !== 'string' || typeof r.projectId !== 'string' || !Number.isSafeInteger(r.count) || r.count < 0)) throw new Error('Invalid unread counts');
        scopes.value = rows; available.value = true;
      } catch { if (token === revision) { scopes.value = []; available.value = false; } }
      finally { refreshing = undefined; }
    })();
    return refreshing;
  }
  async function markRead(scopeId: string, messageIds: readonly string[]) {
    if (!messageIds.length) return;
    const signature = JSON.stringify(messageIds);
    const current = pending.get(scopeId);
    if (current) { await current; return markRead(scopeId, messageIds); }
    if (acknowledged.get(scopeId) === signature) return;
    const receipt = (async () => {
      // Invalidate reads started before this receipt, even if they finish later.
      revision++;
      try {
        const row = await service.markRead(scopeId, messageIds);
        if (row.scopeId !== scopeId || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error('Invalid receipt');
        scopes.value = [...scopes.value.filter((s) => s.scopeId !== scopeId), row];
        acknowledged.set(scopeId, signature);
      } catch { /* Keep the durable count: a failed receipt must never clear a badge. */ }
      if (refreshing) await refreshing;
      await refresh();
    })();
    pending.set(scopeId, receipt);
    try { await receipt; } finally { if (pending.get(scopeId) === receipt) pending.delete(scopeId); }
  }
  return { scopes, available, total: computed(() => scopes.value.reduce((sum, scope) => sum + scope.count, 0)),
    count: (scopeId: string) => scopes.value.find((s) => s.scopeId === scopeId)?.count ?? 0,
    projectCount: (projectId: string) => scopes.value.filter((s) => s.projectId === projectId).reduce((sum, s) => sum + s.count, 0), refresh, markRead };
}
export const UNREAD_STATE: InjectionKey<ReturnType<typeof createUnreadState>> = Symbol('sprout.chat.unread');
export function useUnreadState() { return inject(UNREAD_STATE, null); }
