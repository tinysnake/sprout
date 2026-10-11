// Separate reporter: TAP remains the source of pass/fail output. Execution-order
// events are streamed to a private file so the parent can inspect them on kill.
// Completed test results additionally stream into the durable per-run observation
// file (SPROUT_TEST_OBS_FILE) as they happen, so evidence survives an external
// kill of the wrapper. Observation must never break the run: writes are best-effort.
import { appendFileSync } from 'node:fs';
import { displayPath, testResultRecord } from './test-observation-store.ts';

const obsFile = process.env.SPROUT_TEST_OBS_FILE ?? null;
const runId = process.env.SPROUT_TEST_OBS_RUN_ID ?? null;

const known = new Map();
const key = (data) => `${data.entryFile ?? data.file ?? ''}:${data.testId}`;
const fullName = (data) => {
  const path = [data.name];
  let parentId = data.parentId;
  for (let depth = 0; parentId; depth += 1) {
    const ancestor = known.get(`${data.entryFile ?? data.file ?? ''}:${parentId}`);
    if (!ancestor || depth > 50) break;
    path.unshift(ancestor.name);
    parentId = ancestor.parentId;
  }
  return path.join(' > ');
};

const CLASSIFICATIONS = new Set([
  'testTimeoutFailure', 'testCodeFailure', 'cancellation', 'hookFailure',
  'uncaughtException', 'unhandledRejection',
]);

export default async function* progress(source) {
  for await (const event of source) {
    if (event.type === 'test:dequeue' || event.type === 'test:complete') {
      const { entryFile, file, line, name, nesting, parentId, testId, type } = event.data;
      yield `${JSON.stringify({ event: event.type, entryFile, file, line, name, nesting, parentId, testId, type })}\n`;
    }
    if (event.data) known.set(key(event.data), { name: event.data.name, parentId: event.data.parentId });
    if (obsFile === null || runId === null) continue;
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    // Leaf tests only: suites and the file pseudo-test (no entryFile) are excluded.
    if (data.details?.type !== 'test' || !data.entryFile) continue;
    const failure = data.details?.error ?? null;
    const failureType = failure?.failureType;
    const outcome = event.type === 'test:fail'
      ? (failureType === 'cancellation' ? 'cancelled' : 'fail')
      : (data.todo ? 'todo' : (data.skip !== undefined ? 'skip' : 'pass'));
    try {
      appendFileSync(obsFile, `${JSON.stringify(testResultRecord({
        runId,
        file: displayPath(data.file ?? data.entryFile),
        name: fullName(data),
        outcome,
        durationMs: data.details?.duration_ms ?? null,
        classification: event.type === 'test:fail' && failureType !== undefined && CLASSIFICATIONS.has(failureType)
          ? failureType : null,
      }))}\n`, { mode: 0o600 });
    } catch { /* Observation must not break the run. */ }
  }
}
