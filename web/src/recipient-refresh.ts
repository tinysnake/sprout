/**
 * Refresh direct-message recipients whenever their project boundary changes.
 *
 * The renderer replaces all checkboxes, so a selection from the old project
 * cannot be submitted for the newly selected project.
 */
export function refreshRecipientsOnProjectChange(
  projectSelect: EventTarget,
  renderRecipients: () => void,
): void {
  projectSelect.addEventListener('change', renderRecipients);
}
