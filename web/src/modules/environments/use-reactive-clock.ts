import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue';

/**
 * Provides a reactive millisecond timestamp that updates periodically (for
 * general elapsed time) AND schedules a precise timer directly at the target
 * expiry timestamp so the transition happens exactly at expiry without lingering.
 */
export function useReactiveClock(targetExpiresAt?: () => number | undefined): Ref<number> {
  const now = ref(Date.now());
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearExpiryTimer() {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  }

  function scheduleExpiry(target: number | undefined) {
    clearExpiryTimer();
    if (target === undefined || typeof target !== 'number' || !Number.isFinite(target)) return;
    const delay = target - Date.now();
    if (delay <= 0) {
      now.value = Date.now();
      return;
    }
    // Schedule exact tick at expiry (+ 1ms to ensure Date.now() >= target)
    expiryTimer = setTimeout(() => {
      now.value = Date.now();
      expiryTimer = null;
    }, delay + 1);
    if (typeof (expiryTimer as any)?.unref === 'function') {
      (expiryTimer as any).unref();
    }
  }

  onMounted(() => {
    now.value = Date.now();
    intervalTimer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
    if (typeof (intervalTimer as any)?.unref === 'function') {
      (intervalTimer as any).unref();
    }

    if (targetExpiresAt) {
      scheduleExpiry(targetExpiresAt());
    }
  });

  if (targetExpiresAt) {
    watch(targetExpiresAt, (newTarget) => {
      scheduleExpiry(newTarget);
    });
  }

  onUnmounted(() => {
    if (intervalTimer) clearInterval(intervalTimer);
    clearExpiryTimer();
  });

  return now;
}
