// Notifications of the web chat (I-1) against PostgreSQL: the conversation of
// a task, and the gateway on channel push for the fixed sentences.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { createContext } from '@arianna/policy';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { passGateway } from '../src/gateway.ts';
import { conversationOfTask } from '../src/notifications.ts';
import { PUSH_TEXTS, type PushKind } from '../src/voice/push.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

test('conversationOfTask: the conversation of a task; null for an unknown task', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Riassumi la nota finta');
  assert.equal(await conversationOfTask(db().sql, task.id), conversation.id);
  assert.equal(await conversationOfTask(db().sql, randomUUID()), null);
});

test('the push channel lets out each fixed sentence, L0, and logs it', async () => {
  for (const [kind, text] of Object.entries(PUSH_TEXTS) as [PushKind, string][]) {
    const decision = await passGateway(db().sql, [{ value: text, label: 'L0', source: `${kind}:push` }], createContext('L0'), { kind: 'channel', id: 'push' });
    assert.equal(decision.decision, 'allow', kind);
  }
  const rows = await db().sql<{ decision: string }[]>`SELECT decision FROM gateway_log WHERE target = 'push' ORDER BY id DESC LIMIT 4`;
  assert.deepEqual(rows.map(({ decision }) => decision), ['allow', 'allow', 'allow', 'allow']);
});

test('the push channel blocks L2: a private text never reaches the push service', async () => {
  const decision = await passGateway(db().sql, [{ value: 'Arianna ha risposto: il preventivo finto è pronto', label: 'L2', source: 'reply:push' }], createContext('L2'), { kind: 'channel', id: 'push' });
  assert.equal(decision.decision, 'block');
});
