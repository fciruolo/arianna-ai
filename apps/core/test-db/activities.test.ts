// Saved activity lines (D-083): saved where they are published, at least the
// label of the task, capped per task, append-only, deleted by the purge, read
// by the chat through the API with the protections of the other routes.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { countConversationActivities, listTaskActivities } from '../src/activities.ts';
import { archiveConversation, createConversation, postUserMessage, purgeConversation } from '../src/conversations.ts';
import { startLiveFeed } from '../src/live.ts';
import { Secret } from '@arianna/vault';

import { activitiesSaved, activityChannel, MAX_SAVED_ACTIVITIES, postActivity } from '../src/reply.ts';
import { startApiServer } from '../src/server/http.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

async function chatTask(mode: 'private' | 'work' = 'private'): Promise<{ conversationId: string; taskId: string }> {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode });
  const { task } = await postUserMessage(sql, conversation.id, 'Cerca le fatture finte di settembre');
  return { conversationId: conversation.id, taskId: task.id };
}

/** The task is no longer at work: the purge may run. */
async function settle(taskId: string): Promise<void> {
  const { owner } = db();
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${taskId}`}`;
  await owner`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'domanda per l''utente' WHERE id = ${taskId}`;
}

/** The saved lines of a task, once the saves in flight are done (they run after the notice). */
async function lines(taskId: string): Promise<{ step: number; kind: string; detail: string; label: string }[]> {
  await activitiesSaved();
  const rows = await db().owner<{ step: number; kind: string; detail: string; label: string }[]>`
    SELECT step, kind, detail, label::text FROM task_activities WHERE task_id = ${taskId} ORDER BY id`;
  return [...rows];
}

test('postActivity saves what it shows, with the effective label of the task, and still notifies', async () => {
  const { sql, schema } = db();
  const { conversationId, taskId } = await chatTask();
  const heard: string[] = [];
  const listener = await sql.listen(activityChannel(schema), (payload) => heard.push(payload));
  try {
    const post = (step: number, kind: Parameters<typeof postActivity>[1]['kind'], detail: string): Promise<void> =>
      postActivity(sql, { conversationId, taskId, step, kind, detail });
    await post(1, 'thinking', '');
    await post(1, 'search', '  fatture\n settembre ');
    await post(1, 'search', 'fatture settembre');
    await post(2, 'read', 'kb/fatture/2026-09.md');
    await post(3, 'tool', 'Grep');
    // Another conversation's id: shown nowhere else, saved nowhere.
    const other = await chatTask();
    await postActivity(sql, { conversationId: other.conversationId, taskId, step: 4, kind: 'error', detail: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(heard.length, 6);
  } finally {
    await listener.unlisten();
  }
  assert.deepEqual(await lines(taskId), [
    { step: 1, kind: 'search', detail: 'fatture settembre', label: 'L2' },
    { step: 2, kind: 'read', detail: 'kb/fatture/2026-09.md', label: 'L2' },
    { step: 3, kind: 'tool', detail: 'Grep', label: 'L2' },
  ]);
  const work = await chatTask('work');
  await postActivity(sql, { conversationId: work.conversationId, taskId: work.taskId, step: 1, kind: 'plan', detail: 'tre passi' });
  assert.deepEqual(await lines(work.taskId), [{ step: 1, kind: 'plan', detail: 'tre passi', label: 'L1' }]);
});

test('a line with a value revealed by the vault is neither notified nor saved', async () => {
  const { sql, schema } = db();
  const { conversationId, taskId } = await chatTask();
  const secret = new Secret('vault://test-activity-token', `tok-${String(Date.now())}-finto-segreto`);
  const heard: string[] = [];
  const listener = await sql.listen(activityChannel(schema), (payload) => heard.push(payload));
  try {
    await assert.rejects(
      postActivity(sql, { conversationId, taskId, step: 1, kind: 'search', detail: `cerca ${secret.reveal()}` }),
      /vault:\/\/test-activity-token/,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await listener.unlisten();
  }
  assert.deepEqual(heard, []);
  assert.deepEqual(await lines(taskId), []);
});

test('a line is never below the label of its task, nor above the clearance of its conversation', async () => {
  const { sql } = db();
  const secret = await chatTask('private');
  const insert = (taskId: string, label: string): Promise<unknown> =>
    sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${taskId}, 1, 'read', 'kb/a.md', ${label}::privacy_label)`;
  await assert.rejects(insert(secret.taskId, 'L1'), /below the effective label/);
  await assert.rejects(insert(secret.taskId, 'L0'), /below the effective label/);
  await insert(secret.taskId, 'L2');
  await assert.rejects(insert(secret.taskId, 'L3'), /above the clearance/);
  const work = await chatTask('work');
  await assert.rejects(insert(work.taskId, 'L0'), /below the effective label/);
  await assert.rejects(insert(work.taskId, 'L2'), /above the clearance/);
  await insert(work.taskId, 'L1');
  // Only kinds from the closed list, never "thinking", short details without control characters.
  await assert.rejects(sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${work.taskId}, 1, 'thinking', '', 'L1')`, /check/);
  await assert.rejects(sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${work.taskId}, 1, 'read', ${'x'.repeat(301)}, 'L1')`, /check/);
  await assert.rejects(sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${work.taskId}, 1, 'read', ${'a\nb'}, 'L1')`, /check/);
  // A task without a conversation saves nothing.
  const [card] = await db().owner<{ id: string }[]>`INSERT INTO tasks (title, assignee) VALUES ('carta', 'arianna') RETURNING id::text`;
  await assert.rejects(insert(card?.id ?? '', 'L2'), /has no conversation/);
});

test('at most 200 lines per task: past the cap the line is shown, not saved', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId } = await chatTask();
  await owner`
    INSERT INTO task_activities (task_id, step, kind, detail, label)
    SELECT ${taskId}, n, 'read', 'kb/' || n || '.md', 'L2' FROM generate_series(1, ${MAX_SAVED_ACTIVITIES - 1}) n`;
  await postActivity(sql, { conversationId, taskId, step: 900, kind: 'tool', detail: 'Read' });
  await postActivity(sql, { conversationId, taskId, step: 901, kind: 'tool', detail: 'Edit' });
  const saved = await lines(taskId);
  assert.equal(saved.length, MAX_SAVED_ACTIVITIES);
  assert.equal(saved.at(-1)?.detail, 'Read');
  await assert.rejects(sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${taskId}, 1, 'read', 'x', 'L2')`, /200 lines/);
});

test('task_activities is append-only, for the core and for the owner', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId } = await chatTask();
  await postActivity(sql, { conversationId, taskId, step: 1, kind: 'read', detail: 'kb/a.md' });
  await assert.rejects(sql`UPDATE task_activities SET detail = 'altro' WHERE task_id = ${taskId}`, /permission denied/);
  await assert.rejects(sql`DELETE FROM task_activities WHERE task_id = ${taskId}`, /permission denied/);
  await assert.rejects(owner`UPDATE task_activities SET detail = 'altro' WHERE task_id = ${taskId}`, /append-only/);
  await assert.rejects(owner`DELETE FROM task_activities WHERE task_id = ${taskId}`, /append-only/);
  assert.equal((await lines(taskId)).length, 1);
});

test('the purge deletes the lines of the conversation, and none can be added afterwards', async () => {
  const { sql } = db();
  const gone = await chatTask();
  const kept = await chatTask();
  await postActivity(sql, { conversationId: gone.conversationId, taskId: gone.taskId, step: 1, kind: 'search', detail: 'fatture' });
  await postActivity(sql, { conversationId: kept.conversationId, taskId: kept.taskId, step: 1, kind: 'search', detail: 'contratti' });
  assert.equal((await lines(gone.taskId)).length, 1);
  await settle(gone.taskId);
  await archiveConversation(sql, gone.conversationId, true);
  await purgeConversation(sql, gone.conversationId);
  assert.deepEqual(await lines(gone.taskId), []);
  assert.equal((await lines(kept.taskId)).length, 1);
  await assert.rejects(
    sql`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${gone.taskId}, 2, 'read', 'x', 'L2')`,
    /was deleted/,
  );
  await postActivity(sql, { conversationId: gone.conversationId, taskId: gone.taskId, step: 2, kind: 'read', detail: 'x' });
  assert.deepEqual(await lines(gone.taskId), []);
  assert.equal(await listTaskActivities(sql, gone.taskId), undefined);
  assert.deepEqual(await countConversationActivities(sql, gone.conversationId), {});
});

interface HttpReply {
  status: number;
  body: Record<string, unknown>;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${String(port)}${path}`, { method: 'GET', agent: false, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // A refusal may have no JSON body.
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('GET /api/tasks/:id/activities and the counts: lines within the clearance, the protections of every route', async () => {
  const { sql, owner } = db();
  const { conversationId, taskId } = await chatTask();
  await postActivity(sql, { conversationId, taskId, step: 1, kind: 'search', detail: 'fatture' });
  await postActivity(sql, { conversationId, taskId, step: 2, kind: 'delegate', detail: 'coder · claude/sonnet' });
  await activitiesSaved();
  // A line above the clearance of the conversation (written below the guards, as only a bug could): never read.
  await owner`ALTER TABLE task_activities DISABLE TRIGGER task_activities_guard`;
  try {
    await owner`INSERT INTO task_activities (task_id, step, kind, detail, label) VALUES (${taskId}, 3, 'read', 'segreto', 'L3')`;
  } finally {
    await owner`ALTER TABLE task_activities ENABLE TRIGGER task_activities_guard`;
  }

  const live = await startLiveFeed(sql);
  const server = await startApiServer({ sql, live, host: '127.0.0.1', port: 0 });
  try {
    const reply = await get(server.port, `/api/tasks/${taskId}/activities`);
    assert.equal(reply.status, 200);
    const read = reply.body.activities as { step: number; kind: string; detail: string; label: string; at: string }[];
    assert.deepEqual(
      read.map(({ step, kind, detail, label }) => ({ step, kind, detail, label })),
      [
        { step: 1, kind: 'search', detail: 'fatture', label: 'L2' },
        { step: 2, kind: 'delegate', detail: 'coder · claude/sonnet', label: 'L2' },
      ],
    );
    assert.ok(read.every((line) => !Number.isNaN(Date.parse(line.at))));
    const counts = await get(server.port, `/api/conversations/${conversationId}/activity-counts`);
    assert.deepEqual(counts.body, { counts: { [taskId]: 2 } });

    assert.equal((await get(server.port, '/api/tasks/not-a-uuid/activities')).status, 404);
    assert.equal((await get(server.port, '/api/tasks/00000000-0000-0000-0000-000000000000/activities')).status, 404);
    assert.equal((await get(server.port, '/api/conversations/00000000-0000-0000-0000-000000000000/activity-counts')).status, 404);
    // DNS rebinding: a foreign Host is refused, as on every route.
    const rebinding = await get(server.port, `/api/tasks/${taskId}/activities`, { host: `evil.example:${String(server.port)}` });
    assert.equal(rebinding.status, 403);
  } finally {
    await server.close();
    await live.close();
  }
});
