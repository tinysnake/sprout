/**
 * One-off: post this agent's "test" Message to the project-u5ufkuax chat channel.
 *
 * Uses SqliteCollaborationStore.postMessage directly (the same durable write the
 * coordinator uses) against the live preview database. No wake plan: this is a
 * plain unaddressed test post with no run admission, matching the previous
 * agent-authored test post. The raw DatabaseSync handle avoids running global
 * migrations against the database the live backend already owns.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { SqliteCollaborationStore } from '../../src/collaboration/sqlite-store.ts';

const db = new DatabaseSync('.preview-data/working/sprout.db');
const store = new SqliteCollaborationStore({ db });

const projectId = process.argv[2] ?? 'project-u5ufkuax';
const agentId = process.argv[3] ?? 'agent-bc1c43kd';
const deliveryKey = `${agentId}-channel-${projectId}-test-v1`;
const now = Date.now();
const id = `msg-test${now.toString(36)}-${randomBytes(4).toString('hex')}`;

const result = await store.postMessage({
  message: {
    id,
    projectId,
    channel: 'project',
    author: { id: agentId, kind: 'agent' },
    body: 'test',
    recipients: [],
    deliveryKey,
    createdAt: now,
  },
  plan: { messageId: id, decisions: [], observations: [] },
  now,
});

console.log(
  JSON.stringify(
    {
      duplicate: result.duplicate,
      messageId: result.message.id,
      channel: result.message.channel,
      author: `${result.message.author.id} (${result.message.author.kind})`,
      body: result.message.body,
      wakes: result.wakes.length,
      createdAt: new Date(result.message.createdAt).toISOString(),
    },
    null,
    2,
  ),
);
db.close();
