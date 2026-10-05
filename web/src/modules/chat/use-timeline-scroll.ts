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
  let currentSelection = selection.value;
  let frame: number | undefined;
  let observer: ResizeObserver | undefined;
  let seen = new Set<string>();
  let pendingScroll: { element: HTMLElement; top: number } | undefined;
  let scrollExpiry: number | undefined;
  function clearPendingScroll() {
    pendingScroll = undefined;
    if (scrollExpiry !== undefined) cancelAnimationFrame(scrollExpiry);
    scrollExpiry = undefined;
  }
  /** Native script scroll events are trusted too. Mark before writing, then
   * retain only a changed, clamped position. Multiple writes may coalesce into
   * one native event, so track the latest position rather than an event count. */
  function scrollProgrammatically(write: (element: HTMLElement) => void) {
    const element = viewport.value;
    if (!element) return;
    const previous = pendingScroll;
    const before = element.scrollTop;
    pendingScroll = { element, top: before };
    write(element);
    if (element.scrollTop === before) { pendingScroll = previous; return; }
    clearPendingScroll();
    pendingScroll = { element, top: element.scrollTop };
    // Scroll delivery precedes animation callbacks in the rendering cycle.
    // Allow a second frame for delayed delivery, but never leave stale state.
    scrollExpiry = requestAnimationFrame(() => {
      scrollExpiry = requestAnimationFrame(clearPendingScroll);
    });
  }
  function consumeProgrammaticScroll() {
    const pending = pendingScroll;
    clearPendingScroll();
    return !!pending && pending.element === viewport.value && pending.top === pending.element.scrollTop;
  }
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
      if (Math.abs(element.scrollTop - bottom) > 1) scrollProgrammatically((element) => { element.scrollTop = bottom; });
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
  /** Mark ids as already-seen history (older-page prepends) so the arrival
   *  watcher below never treats backward paging as a live arrival. */
  function noteHistory(ids: readonly string[]) {
    for (const id of ids) seen.add(id);
  }
  watch([selection, viewport, content, hasTarget], ([selected]) => {
    if (selected !== currentSelection) {
      currentSelection = selected;
      clearPendingScroll();
    }
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
  onScopeDispose(() => { epoch++; cancelFrame(); clearPendingScroll(); observer?.disconnect(); });
  return { viewport, content, hasNewEntries, onScroll, jumpToLatest, noteHistory, scrollProgrammatically, consumeProgrammaticScroll };
}
