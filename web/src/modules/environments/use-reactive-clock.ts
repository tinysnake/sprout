import { ref, onMounted, onUnmounted, type Ref } from 'vue';

/**
 * Provides a reactive millisecond timestamp that updates periodically
 * so computed expiry and timeout checks re-evaluate automatically.
 */
export function useReactiveClock(intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  onMounted(() => {
    now.value = Date.now();
    timer = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
    if (typeof (timer as any)?.unref === 'function') {
      (timer as any).unref();
    }
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return now;
}
