import { onScopeDispose, ref, watch, type Ref } from 'vue';

// Display only: command guards and the shared announcer observe raw connection
// state. A continuous degraded interval of five seconds is needed for each
// mounted notice; recovery hides it immediately and cancels the pending timer.
export const CONNECTION_NOTICE_DELAY_MS = 5000;

export function useConnectionNotice(controlAvailable: Readonly<Ref<boolean>>) {
  const visible = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(controlAvailable, (available) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (available) {
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
