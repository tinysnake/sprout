/**
 * Shell connection presentation: the operator-visible meaning of each transport
 * state, including whether control actions are available.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShellConnectionController, describeConnection, OFFLINE_CONNECTION } from './connection.ts';
import type { BrowserTransportState } from '../transport/browser-transport.ts';

function state(connection: BrowserTransportState['connection'], loading = false): BrowserTransportState {
  return { status: loading ? 'loading' : connection, connection, loading };
}

test('every transport state carries text, so connection status is never colour-only', () => {
  for (const connection of ['online', 'reconnecting', 'stale', 'offline'] as const) {
    const presentation = describeConnection(state(connection));
    assert.ok(presentation.label.length > 0, `${connection} has a visible label`);
    assert.ok(presentation.announce.length > presentation.label.length, `${connection} announcement explains the state`);
  }
});

test('only a connected shell offers control actions', () => {
  assert.equal(describeConnection(state('online')).controlAvailable, true);
  assert.equal(describeConnection(state('reconnecting')).controlAvailable, false);
  assert.equal(describeConnection(state('stale')).controlAvailable, false);
  assert.equal(describeConnection(state('offline')).controlAvailable, false);
});

test('an in-flight read leaves connection presentation, announcement and control unchanged', () => {
  for (const connection of ['online', 'reconnecting', 'stale', 'offline'] as const) {
    assert.deepEqual(describeConnection(state(connection, true)), describeConnection(state(connection)));
  }
});

test('offline says facts are cached and actions are not queued', () => {
  const offline = describeConnection(state('offline'));
  assert.equal(offline.status, 'red');
  assert.match(offline.announce, /cached/i);
  assert.match(offline.announce, /queued/i);
  assert.equal(describeConnection(state('offline', true)).label, 'Offline', 'an in-flight retry cannot mask a known offline state');
});

test('a subscriber observes the current state immediately and every later change', () => {
  const controller = createShellConnectionController(OFFLINE_CONNECTION);
  const seen: string[] = [];
  const unsubscribe = controller.subscribeState((next) => seen.push(next.connection));
  assert.deepEqual(seen, ['offline'], 'the observer is told the current state at once');

  controller.set(state('reconnecting'));
  controller.set(state('online'));
  assert.deepEqual(seen, ['offline', 'reconnecting', 'online']);

  unsubscribe();
  controller.set(state('offline'));
  assert.deepEqual(seen, ['offline', 'reconnecting', 'online'], 'an unsubscribed observer stops receiving');
});
