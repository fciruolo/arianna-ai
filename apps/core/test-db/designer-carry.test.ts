// «Riparti» of the Designer (I-20, D-185): a new conversation on the same project from a summary of the old one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatError, createConversation } from '../src/conversations.ts';
import { createDesignerCarry, designerCarryParts, openMockup } from '../src/designer-carry.ts';
import { carryOf } from '../src/god/carry.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const DESIGNER = { name: 'designer', modes: ['work' as const], project: true };
const PROJECTS = ['demo'];

async function designerChat(): Promise<string> {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: DESIGNER });
  await sql`UPDATE conversations SET model = 'luna' WHERE id = ${conversation.id}`;
  await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'user', 'L1', 'Fammi una landing azzurra')`;
  await sql`INSERT INTO messages (conversation_id, role, label, body, agent) VALUES (${conversation.id}, 'assistant', 'L1', 'Ho scritto mockups/landing-1.html.', 'designer')`;
  await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversation.id}, 'user', 'L1', 'Titolo più grande')`;
  return conversation.id;
}

test('a new conversation with the Designer, same project and model, with the summary for its first session', async () => {
  const { sql } = db();
  const from = await designerChat();
  const next = await createDesignerCarry(sql, { from, open: 'mockups/landing-1.html', projects: PROJECTS, agent: DESIGNER });
  assert.notEqual(next.id, from);
  assert.equal(next.agent, 'designer');
  assert.equal(next.workspace, 'demo');
  assert.equal(next.model, 'luna');
  assert.match(next.title ?? '', /^Ripresa:/);
  const carry = await carryOf(sql, next.id);
  assert.ok(carry !== undefined);
  assert.equal(carry.from, from);
  assert.match(carry.body, /Mockup open in the Studio: mockups\/landing-1\.html/);
  assert.match(carry.body, /- Fammi una landing azzurra\n- Titolo più grande/);
  assert.match(carry.body, /Ho scritto mockups\/landing-1\.html\./);
  const parts = await designerCarryParts(sql, next.id);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.label, 'L0');
  assert.match(parts.map((part) => part.text).join('\n'), /lighter session/);
  assert.deepEqual(await designerCarryParts(sql, from), [], 'the old conversation carries nothing');
});

// Data above Interno cannot be in a work conversation at all (the database refuses the message), so it is not tried here.
test('refused: not a chat with the Designer, an empty one', async () => {
  const { sql } = db();
  const other = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: { name: 'coder', modes: ['work'], project: true } });
  await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${other.id}, 'user', 'L1', 'ciao')`;
  await assert.rejects(createDesignerCarry(sql, { from: other.id, projects: PROJECTS, agent: DESIGNER }), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  const empty = await createConversation(sql, { mode: 'work', project: 'demo', projects: PROJECTS, agent: DESIGNER });
  await assert.rejects(createDesignerCarry(sql, { from: empty.id, projects: PROJECTS, agent: DESIGNER }), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
});

test('the mockup named by the page: a relative .html path, never one that climbs', () => {
  assert.equal(openMockup('docs/mockups/studio-2.html'), 'docs/mockups/studio-2.html');
  assert.equal(openMockup(undefined), undefined);
  for (const bad of ['../segreto.html', 'mockups/../../x.html', 'mockups/a.txt', 42, 'a\nb.html']) {
    assert.throws(() => openMockup(bad), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
  }
});
