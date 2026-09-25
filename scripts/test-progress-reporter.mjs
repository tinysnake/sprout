// Separate reporter: TAP remains the source of pass/fail output. Execution-order
// events are streamed to a private file so the parent can inspect them on kill.
export default async function* progress(source) {
  for await (const event of source) {
    if (event.type !== 'test:dequeue' && event.type !== 'test:complete') continue;
    const { entryFile, file, line, name, nesting, parentId, testId, type } = event.data;
    yield `${JSON.stringify({ event: event.type, entryFile, file, line, name, nesting, parentId, testId, type })}\n`;
  }
}
