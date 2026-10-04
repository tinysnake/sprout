import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

/** Keep the phone frame above an overlay keyboard without changing desktop or pinch zoom. */
export function useVisualViewport() {
  const root = ref<HTMLElement | null>(null);
  const height = ref<number>();
  const viewportStyle = computed(() => height.value === undefined ? undefined : { height: `${height.value}px` });
  let viewport: VisualViewport | null = null;
  let frame: number | undefined;
  let geometry = '';
  let mounted = false;
  let element: HTMLElement | null = null;

  function schedule() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(async () => {
      frame = undefined;
      if (!mounted) return;
      const phone = window.innerWidth < 768 || window.matchMedia?.('(pointer: coarse)').matches;
      // A zoomed visual viewport is not the keyboard's available layout height.
      height.value = phone && viewport?.scale === 1 ? viewport.height : undefined;
      await nextTick();
      if (!mounted || height.value === undefined || !viewport) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.value?.contains(active)
        || !active.matches('.chat-composer input, .chat-composer textarea')) return;
      const rect = active.getBoundingClientRect();
      if (rect.top < viewport.offsetTop || rect.bottom > viewport.offsetTop + viewport.height) {
        active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    });
  }

  function onViewportChange() {
    // Duplicate resize/scroll deliveries must not scroll again or start a frame loop.
    const next = `${window.innerWidth}|${viewport?.height}|${viewport?.offsetTop}|${viewport?.scale}`;
    if (next === geometry) return;
    geometry = next;
    schedule();
  }

  onMounted(() => {
    mounted = true;
    viewport = window.visualViewport;
    if (!viewport) return; // Keep the existing CSS frame on older browsers.
    viewport.addEventListener('resize', onViewportChange);
    viewport.addEventListener('scroll', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    element = root.value;
    element?.addEventListener('focusin', schedule);
    onViewportChange();
  });
  onUnmounted(() => {
    mounted = false;
    viewport?.removeEventListener('resize', onViewportChange);
    viewport?.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('resize', onViewportChange);
    element?.removeEventListener('focusin', schedule);
    element = null;
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  return { root, viewportStyle };
}
