import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BindingGenerationRegistry } from './binding-generation.ts';

test('a staged binding catalog is invisible until publication and fenced after revocation', () => {
  const registry = new BindingGenerationRegistry();
  const first = registry.stage('agent/project/conversation');

  assert.equal(first.isCurrent(), false);
  first.publish();
  assert.equal(first.isCurrent(), true);

  first.revoke();
  assert.equal(first.isCurrent(), false);

  const second = registry.stage('agent/project/conversation');
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.isCurrent(), false);
  second.publish();
  assert.equal(second.isCurrent(), true);
  assert.equal(first.isCurrent(), false);
});

test('standalone activations sharing a scope publish in order without overlapping', async () => {
  const registry = new BindingGenerationRegistry();
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const order: string[] = [];
  const first = registry.withLock('agent/project/conversation', async () => {
    const staged = registry.stage('agent/project/conversation');
    staged.publish();
    order.push('first-published');
    markFirstStarted?.();
    await firstGate;
    staged.revoke();
    order.push('first-revoked');
  });
  const second = registry.withLock('agent/project/conversation', async () => {
    const staged = registry.stage('agent/project/conversation');
    staged.publish();
    order.push('second-published');
    assert.equal(staged.generation, 2);
    staged.revoke();
  });

  await firstStarted;
  assert.deepEqual(order, ['first-published']);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-published', 'first-revoked', 'second-published']);
});
