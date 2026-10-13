// «Nuova sessione» of the Designer (I-20, D-185): the same conversation, the old session never resumed, a summary once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatError, createConversation, loadConversation } from '../src/conversations.ts';
import { designerSessionParts, openMockup, startDesignerSession } from '../src/designer-session.ts';
import type { Delegation } from '../src/orchestrator/delegations.ts';
import { directChatHistory, directChatSession } from '../src/orchestrator/delegate.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const DESIGNER = { name: 'designer', modes: ['work' as const], project: true };
const PROJECTS = ['demo'];

/** A message of the user and the Designer's answer, with the task and the delegation that answered it. */
async function exchange(conversationId: string, asked: string, answered: string, sessionRef: string): Promise<string> {
  const { sql } = db();
  await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversationId}, 'user', 'L1', ${asked})`;
  const [task] = await sql<{ id: string }[]>`INSERT INTO tasks (title, conversation_id, assignee, label, clearance) VALUES ('t', ${conversationId}, 'designer', 'L1', 'L1') RETURNING id::text`;
  assert.ok(task !== undefined);
  const [message] = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, agent, task_id) VALUES (${conversationId}, 'assistant', 'L1', ${answered}, 'designer', ${task.id}) RETURNING id::text`;
  const [delegation] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, repo, status, executor, result, result_label, session_ref, message_id, ended_at)
    VALUES (${task.id}, 1, 'designer', ${asked}, 'L1', 'demo', 'ok', 'claude', ${answered}, 'L1', ${sessionRef}, ${message?.id ?? null}, now())
    RETURNING id::text`;
  return delegation?.id ?? '';
}

/** The delegation of the next message: only what the queries read. */
async function nextDelegation(conversationId: string): Promise<Delegation> {
  const { sql } = db();
  const [task] = await sql<{ id: string }[]>`INSERT INTO tasks (title, conversation_id, assignee, label, clearance) VALUES ('n', ${conversationId}, 'designer', 'L1', 'L1') RETURNING id::text`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, repo, status) VALUES (${task?.id ?? ''}, 1, 'designer', 'nuovo', 'L1', 'demo', 'running') RETURNING id::text`;
  return { id: row?.id ?? '', taskId: task?.id ?? '', step: 1, agent: 'designer', brief: 'nuovo', label: 'L1', repo: 'demo' } as Delegation;
}

test('a new session: the old one is never resumed, the summary comes once, the conversation stays whole', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: DESIGNER });
  await exchange(conversation.id, 'Fammi una landing azzurra', 'Ho scritto mockups/landing-1.html.', 'session-old');
  const before = await nextDelegation(conversation.id);
  assert.equal(await directChatSession(sql, conversation.id, before), 'session-old');

  const started = await startDesignerSession(sql, conversation.id, 'mockups/landing-1.html');
  assert.ok(started.directSessionAt !== null);
  const first = await nextDelegation(conversation.id);
  assert.equal(await directChatSession(sql, conversation.id, first), undefined, 'the session from before the line is not resumed');
  assert.deepEqual(await directChatHistory(sql, conversation.id, first), [], 'nor told again exchange by exchange');
  const parts = await designerSessionParts(sql, conversation.id, first.id);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.label, 'L0');
  const summary = parts.map((part) => part.text).join('\n');
  assert.match(summary, /Mockup open in the Studio: mockups\/landing-1\.html/);
  assert.match(summary, /Fammi una landing azzurra/);
  assert.match(summary, /Ho scritto mockups\/landing-1\.html\./);

  // The first answer after the line opens the new session: it is resumed, the summary is not given again.
  await exchange(conversation.id, 'Titolo più grande', 'Fatto in landing-2.', 'session-new');
  const second = await nextDelegation(conversation.id);
  assert.equal(await directChatSession(sql, conversation.id, second), 'session-new');
  assert.deepEqual(await designerSessionParts(sql, conversation.id, second.id), []);
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversation.id}`;
  assert.equal(count?.n, 4, 'every message stays in the conversation');
});

test('without a new session nothing changes; refused off a direct chat with the Designer', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: DESIGNER });
  const delegation = await nextDelegation(conversation.id);
  assert.deepEqual(await designerSessionParts(sql, conversation.id, delegation.id), []);
  assert.equal((await loadConversation(sql, conversation.id))?.directSessionAt, null);
  const coder = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: { name: 'coder', modes: ['work'], project: true } });
  await assert.rejects(startDesignerSession(sql, coder.id), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  const plain = await createConversation(sql, { mode: 'work', projects: PROJECTS });
  await assert.rejects(startDesignerSession(sql, plain.id), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
});

test('the database keeps a session on agent conversations only, forward only, with a checked mockup', async () => {
  const { sql } = db();
  const plain = await createConversation(sql, { mode: 'work', projects: PROJECTS });
  await assert.rejects(sql`UPDATE conversations SET direct_session_at = now() WHERE id = ${plain.id}`, /conversations_direct_session/);
  const conversation = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: DESIGNER });
  await startDesignerSession(sql, conversation.id);
  await assert.rejects(sql`UPDATE conversations SET direct_session_at = direct_session_at - interval '1 hour' WHERE id = ${conversation.id}`, /only goes forward/);
  await assert.rejects(sql`UPDATE conversations SET direct_session_open = '../segreto.html' WHERE id = ${conversation.id}`, /conversations_direct_session_open/);
});

test('the mockup named by the page: a relative .html path, never one that climbs', () => {
  assert.equal(openMockup('docs/mockups/studio-2.html'), 'docs/mockups/studio-2.html');
  assert.equal(openMockup(undefined), undefined);
  for (const bad of ['../segreto.html', 'mockups/../../x.html', 'mockups/a.txt', 42, 'a\nb.html', '/etc/x.html']) {
    assert.throws(() => openMockup(bad), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  }
});
