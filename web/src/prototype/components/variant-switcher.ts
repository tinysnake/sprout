export type VariantKey = 'A' | 'B' | 'C';

export interface VariantInfo {
  key: VariantKey;
  name: string;
  tagline: string;
}

export const VARIANTS: VariantInfo[] = [
  {
    key: 'A',
    name: 'Variant A: Feed & Operations Stream',
    tagline: 'Unified timeline & fast intervention stream',
  },
  {
    key: 'B',
    name: 'Variant B: Structured Workspace & Hub',
    tagline: 'Classical tabbed hierarchy & entity separation',
  },
  {
    key: 'C',
    name: 'Variant C: Task & Lease Deck',
    tagline: 'Work-first Kanban deck & floating touch dock',
  },
];

export function getActiveVariant(): VariantKey {
  const urlParams = new URLSearchParams(window.location.search);
  const v = urlParams.get('variant')?.toUpperCase();
  if (v === 'A' || v === 'B' || v === 'C') {
    return v;
  }
  return 'B'; // Default to B (Structured Hub)
}

export function setActiveVariant(variant: VariantKey, onVariantChange: () => void): void {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', variant);
  window.history.replaceState({}, '', url.toString());
  onVariantChange();
}

export function renderVariantSwitcher(
  current: VariantKey,
  onVariantChange: () => void
): HTMLElement {
  const currentIndex = VARIANTS.findIndex((v) => v.key === current);
  const currentInfo = VARIANTS[currentIndex] ?? VARIANTS[1]!;

  const switcherEl = document.createElement('div');
  switcherEl.className = 'proto-variant-floating-bar';
  switcherEl.innerHTML = `
    <button class="proto-switcher-arrow prev-variant-btn" aria-label="Previous variant">←</button>
    <div class="proto-switcher-label">
      <span class="proto-switcher-name">${currentInfo.name}</span>
      <span class="proto-switcher-tagline">${currentInfo.tagline}</span>
    </div>
    <button class="proto-switcher-arrow next-variant-btn" aria-label="Next variant">→</button>
  `;

  switcherEl.querySelector('.prev-variant-btn')?.addEventListener('click', () => {
    const prevIndex = (currentIndex - 1 + VARIANTS.length) % VARIANTS.length;
    setActiveVariant(VARIANTS[prevIndex]!.key, onVariantChange);
  });

  switcherEl.querySelector('.next-variant-btn')?.addEventListener('click', () => {
    const nextIndex = (currentIndex + 1) % VARIANTS.length;
    setActiveVariant(VARIANTS[nextIndex]!.key, onVariantChange);
  });

  return switcherEl;
}

export function attachVariantKeyboardShortcuts(onVariantChange: () => void): void {
  window.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }

    const current = getActiveVariant();
    const currentIndex = VARIANTS.findIndex((v) => v.key === current);

    if (ev.key === 'ArrowLeft') {
      const prevIndex = (currentIndex - 1 + VARIANTS.length) % VARIANTS.length;
      setActiveVariant(VARIANTS[prevIndex]!.key, onVariantChange);
    } else if (ev.key === 'ArrowRight') {
      const nextIndex = (currentIndex + 1) % VARIANTS.length;
      setActiveVariant(VARIANTS[nextIndex]!.key, onVariantChange);
    }
  });
}
