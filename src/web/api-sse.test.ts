import { definition, instance, projects } from './api-harness.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { createRunApi } from './api.ts';

import { withServer, waitForTerminal, sseRunEvents, readSseUntil } from './api-harness.ts';

test('SSE Last-Event-ID replays only later run snapshots', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'first stream run' }),
    });
    const { id: firstId } = await first.json() as { id: string };
    await waitForTerminal(base, firstId);

    const initial = await fetch(`${base}/api/events`);
    const initialReader = initial.body?.getReader();
    assert.ok(initialReader);
    let initialText = '';
    while (!initialText.includes('"status":"completed"')) {
      const chunk = await initialReader.read();
      if (chunk.done) break;
      initialText += new TextDecoder().decode(chunk.value);
    }
    const cursor = [...initialText.matchAll(/^id: ([^\n]+)$/gm)].at(-1)?.[1];
    assert.ok(cursor, 'the initial durable snapshot has an SSE cursor');
    await initialReader.cancel();

    const resumed = await fetch(`${base}/api/events`, { headers: { 'last-event-id': cursor } });
    const reader = resumed.body?.getReader();
    assert.ok(reader);
    const second = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'second stream run' }),
    });
    const { id: secondId } = await second.json() as { id: string };

    let received = '';
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !received.includes(secondId)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.match(received, new RegExp(secondId));
    assert.equal(received.includes(firstId), false, 'a durable snapshot before the cursor is not replayed');
  });
});

test('an SSE durable cursor remains a replay boundary after an API restart', async () => {
  const store = new InMemoryRunStore();
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const first = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [{ events: [{ type: 'message', text: 'first', final: true }], result: { status: 'completed', text: 'first' } }],
    })]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
  });
  const firstApi = createRunApi({ orchestrator: first, agents: registry });
  let secondApi: ReturnType<typeof createRunApi> | undefined;
  try {
    const { port: firstPort } = await firstApi.listen(0);
    const submitted = await fetch(`http://127.0.0.1:${firstPort}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'first durable snapshot' }),
    });
    const { id: firstId } = await submitted.json() as { id: string };
    await first.waitFor(firstId);

    const initial = await fetch(`http://127.0.0.1:${firstPort}/api/events`);
    const initialReader = initial.body?.getReader();
    assert.ok(initialReader);
    let initialText = '';
    while (!initialText.includes('"status":"completed"')) {
      const chunk = await initialReader.read();
      if (chunk.done) break;
      initialText += new TextDecoder().decode(chunk.value);
    }
    const cursor = [...initialText.matchAll(/^id: ([^\n]+)$/gm)].at(-1)?.[1];
    assert.match(cursor ?? '', /^v2:[1-9][0-9]*:[a-f0-9]{64}$/);
    await initialReader.cancel();
    await firstApi.close();

    const second = new RunOrchestrator({
      engines: new Map([['scripted', new ScriptedEngineAdapter({
        turns: [{ events: [{ type: 'message', text: 'second', final: true }], result: { status: 'completed', text: 'second' } }],
      })]]),
      agents: registry,
      projects,
      pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
      store,
    });
    secondApi = createRunApi({ orchestrator: second, agents: registry });
    const { port: secondPort } = await secondApi.listen(0);
    const resumed = await fetch(`http://127.0.0.1:${secondPort}/api/events`, {
      headers: { 'last-event-id': cursor! },
    });
    const reader = resumed.body?.getReader();
    assert.ok(reader);
    const secondSubmitted = await fetch(`http://127.0.0.1:${secondPort}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'second durable snapshot' }),
    });
    const { id: secondId } = await secondSubmitted.json() as { id: string };
    let replayed = '';
    while (!replayed.includes(secondId)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      replayed += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.match(replayed, new RegExp(secondId));
    assert.equal(replayed.includes(firstId), false, 'the consumed durable snapshot is not replayed after restart');
  } finally {
    await secondApi?.close();
    await firstApi.close().catch(() => undefined);
  }
});

test('a legacy v1 cursor safely rehydrates after replay-order migration', async () => {
  await withServer(async (base) => {
    const submitted = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'legacy cursor boundary' }),
    });
    const { id } = await submitted.json() as { id: string };
    await waitForTerminal(base, id);

    const initial = await fetch(`${base}/api/events`);
    const initialReader = initial.body?.getReader();
    assert.ok(initialReader);
    const initialText = await readSseUntil(initialReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === id && event.run.status === 'completed'),
    );
    const currentCursor = sseRunEvents(initialText).find(
      (event) => event.run.id === id && event.run.status === 'completed',
    )?.cursor;
    assert.match(currentCursor ?? '', /^v2:[1-9][0-9]*:[a-f0-9]{64}$/);
    await initialReader.cancel();

    const legacyCursor = currentCursor!.replace(/^v2:[1-9][0-9]*:/, 'v1:');
    const resumed = await fetch(`${base}/api/events`, { headers: { 'last-event-id': legacyCursor } });
    const resumedReader = resumed.body?.getReader();
    assert.ok(resumedReader);
    const replayed = await readSseUntil(resumedReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === id && event.run.status === 'completed'),
    );
    await resumedReader.cancel();
    assert.equal(
      sseRunEvents(replayed).filter((event) => event.run.id === id && event.run.status === 'completed').length,
      1,
      'an untrusted pre-sequence boundary safely rehydrates the current durable snapshot once',
    );
  });
});

test('an older durable cursor replays every newer snapshot once after a multi-run restart', async () => {
  const store = new InMemoryRunStore();
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  let now = 1_000;
  const first = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [
        { events: [{ type: 'message', text: 'older', final: true }], result: { status: 'completed', text: 'older' } },
        { events: [{ type: 'message', text: 'newer', final: true }], result: { status: 'completed', text: 'newer' } },
      ],
    })]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
    clock: { now: () => now },
  });
  const firstApi = createRunApi({ orchestrator: first, agents: registry });
  let restartedApi: ReturnType<typeof createRunApi> | undefined;
  try {
    const { port: firstPort } = await firstApi.listen(0);
    const olderSubmitted = await fetch(`http://127.0.0.1:${firstPort}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-scout', prompt: 'older' }),
    });
    const { id: olderId } = await olderSubmitted.json() as { id: string };
    await first.waitFor(olderId);
    now = 2_000;
    const newerSubmitted = await fetch(`http://127.0.0.1:${firstPort}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-scout', prompt: 'newer' }),
    });
    const { id: newerId } = await newerSubmitted.json() as { id: string };
    await first.waitFor(newerId);

    const initial = await fetch(`http://127.0.0.1:${firstPort}/api/events`);
    const initialReader = initial.body?.getReader();
    assert.ok(initialReader);
    const initialText = await readSseUntil(initialReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === newerId && event.run.status === 'completed'),
    );
    const olderCursor = sseRunEvents(initialText).find(
      (event) => event.run.id === olderId && event.run.status === 'completed',
    )?.cursor;
    assert.match(olderCursor ?? '', /^v2:[1-9][0-9]*:[a-f0-9]{64}$/);
    const newerCursor = sseRunEvents(initialText).find(
      (event) => event.run.id === newerId && event.run.status === 'completed',
    )?.cursor;
    assert.match(newerCursor ?? '', /^v2:[1-9][0-9]*:[a-f0-9]{64}$/);
    await initialReader.cancel();
    await firstApi.close();

    now = 3_000;
    const restarted = new RunOrchestrator({
      engines: new Map([['scripted', new ScriptedEngineAdapter({
        turns: [{ events: [{ type: 'message', text: 'future', final: true }], result: { status: 'completed', text: 'future' } }],
      })]]),
      agents: registry,
      projects,
      pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
      store,
      clock: { now: () => now },
    });
    restartedApi = createRunApi({ orchestrator: restarted, agents: registry });
    const { port: restartedPort } = await restartedApi.listen(0);
    const resumed = await fetch(`http://127.0.0.1:${restartedPort}/api/events`, {
      headers: { 'last-event-id': olderCursor! },
    });
    const resumedReader = resumed.body?.getReader();
    assert.ok(resumedReader);
    const afterNewest = await fetch(`http://127.0.0.1:${restartedPort}/api/events`, {
      headers: { 'last-event-id': newerCursor! },
    });
    const afterNewestReader = afterNewest.body?.getReader();
    assert.ok(afterNewestReader);
    const futureSubmitted = await fetch(`http://127.0.0.1:${restartedPort}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-scout', prompt: 'future' }),
    });
    const { id: futureId } = await futureSubmitted.json() as { id: string };
    const resumedText = await readSseUntil(resumedReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === futureId && event.run.status === 'completed'),
    );
    await resumedReader.cancel();
    const afterNewestText = await readSseUntil(afterNewestReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === futureId && event.run.status === 'completed'),
    );
    await afterNewestReader.cancel();

    const events = sseRunEvents(resumedText);
    assert.equal(events.filter((event) => event.run.id === olderId).length, 0, 'the consumed older snapshot is not replayed');
    assert.equal(
      events.filter((event) => event.run.id === newerId && event.run.status === 'completed').length,
      1,
      'the newer durable snapshot is replayed exactly once',
    );
    const futureEvents = events.filter((event) => event.run.id === futureId);
    assert.deepEqual(
      futureEvents.map((event) => event.run.status),
      ['running', 'running', 'completed'],
      'each future snapshot is delivered once after the replay boundary',
    );
    assert.equal(
      new Set(futureEvents.map((event) => event.cursor)).size,
      futureEvents.length,
      'no future durable cursor is delivered twice',
    );
    const newestCursorEvents = sseRunEvents(afterNewestText);
    assert.equal(
      newestCursorEvents.some((event) => event.run.id === olderId || event.run.id === newerId),
      false,
      'the newest cursor does not replay either already-consumed durable snapshot',
    );
    assert.equal(
      newestCursorEvents.filter((event) => event.run.id === futureId).length,
      futureEvents.length,
      'the newest cursor still receives every future snapshot exactly once',
    );
  } finally {
    await restartedApi?.close();
    await firstApi.close().catch(() => undefined);
  }
});

test('a live cursor replays a later same-time run after restart even when stable ids reverse arrival order', async () => {
  const store = new InMemoryRunStore();
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const runIds = ['run-b', 'run-a'];
  let leaseId = 0;
  const first = new RunOrchestrator({
    engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [
        { events: [{ type: 'message', text: 'b', final: true }], result: { status: 'completed', text: 'b' } },
        { events: [{ type: 'message', text: 'a', final: true }], result: { status: 'completed', text: 'a' } },
      ],
    })]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
    clock: { now: () => 1_000 },
    ids: {
      run: () => runIds.shift()!,
      lease: () => `lease-${++leaseId}`,
      message: () => 'unused-message',
      task: () => 'unused-task',
    },
  });
  const firstApi = createRunApi({ orchestrator: first, agents: registry });
  let restartedApi: ReturnType<typeof createRunApi> | undefined;
  try {
    const { port: firstPort } = await firstApi.listen(0);
    const live = await fetch(`http://127.0.0.1:${firstPort}/api/events`);
    const liveReader = live.body?.getReader();
    assert.ok(liveReader);

    const bSubmitted = await fetch(`http://127.0.0.1:${firstPort}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-scout', prompt: 'b' }),
    });
    const { id: bId } = await bSubmitted.json() as { id: string };
    assert.equal(bId, 'run-b');
    await first.waitFor(bId);
    const liveText = await readSseUntil(liveReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === bId && event.run.status === 'completed'),
    );
    const bCursor = sseRunEvents(liveText).find(
      (event) => event.run.id === bId && event.run.status === 'completed',
    )?.cursor;
    assert.match(bCursor ?? '', /^v2:[1-9][0-9]*:[a-f0-9]{64}$/);
    await liveReader.cancel();

    const aSubmitted = await fetch(`http://127.0.0.1:${firstPort}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-scout', prompt: 'a' }),
    });
    const { id: aId } = await aSubmitted.json() as { id: string };
    assert.equal(aId, 'run-a');
    await first.waitFor(aId);
    await firstApi.close();

    const restarted = new RunOrchestrator({
      engines: new Map([['scripted', new ScriptedEngineAdapter({
        turns: [{ events: [{ type: 'message', text: 'future', final: true }], result: { status: 'completed', text: 'future' } }],
      })]]),
      agents: registry,
      projects,
      pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
      store,
      clock: { now: () => 2_000 },
      ids: {
        run: () => 'run-future',
        lease: () => `restart-lease-${++leaseId}`,
        message: () => 'unused-message',
        task: () => 'unused-task',
      },
    });
    restartedApi = createRunApi({ orchestrator: restarted, agents: registry });
    const { port: restartedPort } = await restartedApi.listen(0);
    const resumed = await fetch(`http://127.0.0.1:${restartedPort}/api/events`, {
      headers: { 'last-event-id': bCursor! },
    });
    const resumedReader = resumed.body?.getReader();
    assert.ok(resumedReader);
    const futureSubmitted = await fetch(`http://127.0.0.1:${restartedPort}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent-scout', prompt: 'future' }),
    });
    const { id: futureId } = await futureSubmitted.json() as { id: string };
    const resumedText = await readSseUntil(resumedReader, (text) =>
      sseRunEvents(text).some((event) => event.run.id === futureId && event.run.status === 'completed'),
    );
    await resumedReader.cancel();

    const events = sseRunEvents(resumedText);
    assert.equal(events.filter((event) => event.run.id === bId).length, 0, 'the consumed run-b snapshot is not replayed');
    assert.equal(
      events.filter((event) => event.run.id === aId && event.run.status === 'completed').length,
      1,
      'the disconnected run-a snapshot is replayed exactly once despite sorting before run-b',
    );
    const futureEvents = events.filter((event) => event.run.id === futureId);
    assert.deepEqual(futureEvents.map((event) => event.run.status), ['running', 'running', 'completed']);
    assert.equal(new Set(futureEvents.map((event) => event.cursor)).size, futureEvents.length);
  } finally {
    await restartedApi?.close();
    await firstApi.close().catch(() => undefined);
  }
});

test('an out-of-range SSE cursor rehydrates current and later durable snapshots', async () => {
  await withServer(async (base) => {
    const firstSubmitted = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'cursor boundary' }),
    });
    const { id: firstId } = await firstSubmitted.json() as { id: string };
    await waitForTerminal(base, firstId);

    const initial = await fetch(`${base}/api/events`);
    const initialReader = initial.body?.getReader();
    assert.ok(initialReader);
    let initialText = '';
    while (!initialText.includes(firstId)) {
      const chunk = await initialReader.read();
      if (chunk.done) break;
      initialText += new TextDecoder().decode(chunk.value);
    }
    const cursor = [...initialText.matchAll(/^id: ([^\n]+)$/gm)].at(-1)?.[1];
    assert.ok(cursor);
    await initialReader.cancel();
    const beyondLogCursor = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`;

    const resumed = await fetch(`${base}/api/events`, { headers: { 'last-event-id': beyondLogCursor } });
    const reader = resumed.body?.getReader();
    assert.ok(reader);
    const secondSubmitted = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'future after cursor boundary' }),
    });
    const { id: secondId } = await secondSubmitted.json() as { id: string };
    let replayed = '';
    while (!replayed.includes(secondId)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      replayed += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.match(replayed, new RegExp(firstId), 'the safe replay boundary includes current durable state');
    assert.match(replayed, new RegExp(secondId), 'later durable state is not suppressed');
  });
});
