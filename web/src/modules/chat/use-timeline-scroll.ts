import { onScopeDispose, ref, watch, type Ref } from 'vue';

/** Render-only bottom following. Selection changes invalidate all queued layout work. */
export function useTimelineScroll(
  selection: Readonly<Ref<string>>,
  entryIds: Readonly<Ref<readonly string[]>>,
  hasTarget: Readonly<Ref<boolean>>,
) {
  const viewport = ref<HTMLElement | null>(null);
  const content = ref<HTMLElement | null>(null);
  const hasNewEntries = ref(false);
  let following = true;
  let epoch = 0;
  let frame: number | undefined;
  let observer: ResizeObserver | undefined;
  let seen = new Set<string>();
  // Small tolerance for fractional pixels, not an entire message's height.
  const atBottom = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop <= 8;

  function cancelFrame() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }
  function alignBottom() {
    if (!following || frame !== undefined || !viewport.value) return;
    const token = epoch;
    const element = viewport.value;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (token !== epoch || element !== viewport.value || !following) return;
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
      // ResizeObserver also delivers after our own layout. An unchanged bottom
      // must not produce another write (or an animation-frame/scroll loop).
      if (Math.abs(element.scrollTop - bottom) > 1) element.scrollTop = bottom;
    });
  }
  function onScroll() {
    const element = viewport.value;
    if (!element) return;
    following = atBottom(element);
    if (following) hasNewEntries.value = false;
    else cancelFrame();
  }
  function jumpToLatest() {
    following = true;
    hasNewEntries.value = false;
    alignBottom();
  }
  watch([selection, viewport, content, hasTarget], () => {
    epoch++;
    cancelFrame();
    observer?.disconnect();
    following = !hasTarget.value;
    hasNewEntries.value = false;
    seen = new Set(entryIds.value);
    const element = viewport.value;
    const body = content.value;
    if (!element || !body) return;
    const token = epoch;
    // Observe real size changes, including image loads, code/font layout and
    // viewport changes from run bars. There is no timer or settling poll loop.
    observer = new ResizeObserver(() => { if (token === epoch) alignBottom(); });
    observer.observe(body);
    observer.observe(element);
    alignBottom();
  }, { flush: 'post' });
  watch(entryIds, (ids) => {
    const arrived = ids.some((id) => !seen.has(id));
    seen = new Set(ids);
    if (!arrived) return; // Replacing fetched records is not a new arrival.
    if (following) alignBottom();
    else hasNewEntries.value = true;
  }, { flush: 'post' });
  onScopeDispose(() => { epoch++; cancelFrame(); observer?.disconnect(); });
  return { viewport, content, hasNewEntries, onScroll, jumpToLatest };
}
