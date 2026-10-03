/** Date rows for a complete, chronologically ordered message list, independent of fetch chunks. */
export function messageDateSeparators(
  messages: readonly { readonly id: string; readonly createdAt: number }[],
  now: number,
): ReadonlyMap<string, string> {
  const today = new Date(now);
  const yesterday = new Date(now);
  // Calendar subtraction preserves Yesterday across 23- and 25-hour DST days.
  yesterday.setDate(yesterday.getDate() - 1);
  const todayKey = today.toDateString();
  const yesterdayKey = yesterday.toDateString();
  const separators = new Map<string, string>();
  let previousDay: string | undefined;
  for (const message of messages) {
    const date = new Date(message.createdAt);
    const day = date.toDateString();
    if (day !== previousDay) {
      separators.set(message.id, day === todayKey ? 'Today' : day === yesterdayKey ? 'Yesterday'
        : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
    }
    previousDay = day;
  }
  return separators;
}
