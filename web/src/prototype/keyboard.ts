/**
 * Give custom drill-down controls the same activation contract as native
 * buttons. Preventing the browser default keeps Enter and Space from firing a
 * second click on native buttons while still making role=button cards work in
 * DOM and assistive-technology clients.
 */
export function activateOnKeyboard(element: HTMLElement, activate: () => void): void {
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (element.tagName === 'BUTTON' && (element as HTMLButtonElement).disabled) return;

    // A drill-down card may contain a separate native probe/action button.
    // That child owns its keyboard event and must not also open the card.
    if (
      element.tagName !== 'BUTTON' &&
      (event.target as HTMLElement | null)?.closest?.('button, a, input, select, textarea')
    ) {
      return;
    }

    event.preventDefault();
    activate();
  });
}
