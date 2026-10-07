import { onScopeDispose, ref, watch, type Ref } from 'vue';

// Display only: command guards, admission checks and the shared announcer
// observe raw state. A continuous unresolved interval of five seconds is
// needed for each mounted notice; resolution hides it immediately.
export const CONNECTION_NOTICE_DELAY_MS = 5000;

export function useConnectionNotice(resolved: Readonly<Ref<boolean>>) {
  const visible = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(resolved, (isResolved) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (isResolved) {
      visible.value = false;
    } else {
      timer = setTimeout(() => {
        visible.value = true;
        timer = undefined;
      }, CONNECTION_NOTICE_DELAY_MS);
    }
  }, { immediate: true });
  onScopeDispose(() => { if (timer !== undefined) clearTimeout(timer); });
  return visible;
}
