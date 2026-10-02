import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Secret } from '@arianna/vault';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import type { Sql } from '../src/db/client.ts';
import { appendEvent } from '../src/events.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { createBotApi } from '../src/telegram/api.ts';
import { ensureTelegramState, startTelegram, type TelegramChannel } from '../src/telegram/channel.ts';
import { TEXTS } from '../src/telegram/texts.ts';
import { createTask, loadTask, moveTask } from '../src/tasks.ts';
import { buttonPress, eventually, privateMessage, startFakeTelegram, type FakeTelegram } from '../test/support/fake-telegram.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

// One hook sets everything up: the database must exist before the channel starts.
let database: TestDatabase | undefined;
function db(): TestDatabase {
  if (database === undefined) throw new Error('the test database is not ready');
  return database;
}
const CHAT = 424242;
const STRANGER = 999;
// A made-up IBAN with a valid checksum: the scanner must flag it.
const FAKE_IBAN = 'IT60X0542811101000000123456';
const token = new Secret('vault://telegram-bot-token', '1234567:fake-token-for-tests-only-0000');

let fake: FakeTelegram;
let live: LiveFeed;
let channel: TelegramChannel;

async function start(): Promise<TelegramChannel> {
  return startTelegram({
    sql: db().sql,
    api: createBotApi({ token, baseUrl: fake.url }),
    chats: [CHAT],
    live,
    pollSeconds: 1,
    retryMs: 20,
    maxAttempts: 3,
    onError: () => undefined,
  });
}

before(async () => {
  database = await createTestDatabase();
  fake = await startFakeTelegram();
  live = await startLiveFeed(db().sql);
  channel = await start();
});
after(async () => {
  await channel.close();
  await live.close();
  await fake.close();
  await database?.close();
});

function sentTexts(): string[] {
  return fake.sent().map((call) => String(call.body.text));
}

async function telegramMessages(sql: Sql) {
  return sql<{ body: string; label: string; channel: string; taskId: string }[]>`
    SELECT body, label, channel, task_id::text AS "taskId" FROM messages
    WHERE conversation_id = ${channel.conversationId} AND role = 'user' ORDER BY messages.id`;
}

/** A task waiting for an approval, as the engine leaves it (engine.ts, outcome `approval`). */
async function waitingApproval(
  sql: Sql,
  options: { conversationId: string; title: string; label: 'L1' | 'L2'; kind: 'action' | 'declassify'; detail: Record<string, string> },
): Promise<{ taskId: string; approvalId: string }> {
  return sql.begin(async (tx) => {
    const task = await createTask(tx, {
      title: options.title,
      conversationId: options.conversationId,
      label: options.label,
      clearance: options.label,
      effectiveLabel: options.label,
      assignee: 'arianna',
      status: 'ready',
    });
    await moveTask(tx, task.id, 'running');
    const [row] =
      options.kind === 'declassify'
        ? await tx<{ id: string }[]>`
            INSERT INTO approvals (task_id, kind, action, detail, label)
            VALUES (${task.id}, 'declassify', 'declassify',
              ${tx.json({ ...options.detail, from: 'L2', to: 'L1' })} || jsonb_build_object('sha256', encode(sha256(convert_to(${options.detail.text ?? ''}, 'UTF8')), 'hex')),
              'L2')
            RETURNING id::text`
        : await tx<{ id: string }[]>`
            INSERT INTO approvals (task_id, kind, action, detail, label)
            VALUES (${task.id}, 'action', 'send_external', ${tx.json(options.detail)}, ${options.label}::privacy_label)
            RETURNING id::text`;
    if (row === undefined) throw new Error('no approval');
    await moveTask(tx, task.id, 'waiting_user', { reason: 'approval needed', cause: 'approval', approvalId: row.id });
    await appendEvent(tx, { kind: 'approval.requested', taskId: task.id, label: 'L0', payload: { approvalId: row.id, action: options.kind === 'declassify' ? 'declassify' : 'send_external' } });
    return { taskId: task.id, approvalId: row.id };
  });
}

test('the bot is bound to one work conversation, created once', async () => {
  const [conversation] = await db().sql<{ mode: string; clearance: string }[]>`
    SELECT mode, clearance FROM conversations WHERE id = ${channel.conversationId}`;
  assert.deepEqual(conversation, { mode: 'work', clearance: 'L1' });
  assert.equal((await ensureTelegramState(db().sql)).conversationId, channel.conversationId);
  // The database refuses a private conversation and a change of conversation.
  const own = await createConversation(db().sql, { mode: 'private' });
  await assert.rejects(db().sql`UPDATE telegram_state SET conversation_id = ${own.id}`, /cannot change/);
  await assert.rejects(db().sql`INSERT INTO telegram_state (id, conversation_id) VALUES (true, ${own.id})`, /work conversation only/);
  await assert.rejects(db().sql`UPDATE telegram_state SET event_cursor = 0`, /cannot go back/);
});

test('a message from the user starts a task in the work conversation, labeled L1, once', async () => {
  const updateId = fake.push(privateMessage(CHAT, 'Controlla il sito finto'));
  const [message] = await eventually(async () => {
    const rows = await telegramMessages(db().sql);
    return rows.length > 0 ? rows : undefined;
  });
  assert.deepEqual([message?.body, message?.label, message?.channel], ['Controlla il sito finto', 'L1', 'telegram']);
  const task = await loadTask(db().sql, message?.taskId ?? '');
  assert.deepEqual([task?.clearance, task?.effectiveLabel, task?.assignee], ['L1', 'L1', 'arianna']);
  const [state] = await db().sql<{ offset: number }[]>`SELECT update_offset::int AS offset FROM telegram_state`;
  assert.equal(state?.offset, updateId + 1);

  // A restart asks from the saved offset: the message is not written twice.
  await channel.close();
  channel = await start();
  await eventually(() => fake.calls.filter((call) => call.method === 'getUpdates' && call.body.offset === updateId + 1).length >= 2);
  assert.equal((await telegramMessages(db().sql)).length, 1);
});

test('strangers, groups and forwarded messages are ignored without a trace of who wrote', async () => {
  const before = (await telegramMessages(db().sql)).length;
  const sent = fake.sent().length;
  fake.push(privateMessage(STRANGER, 'ciao bot'));
  fake.push({ message: { message_id: 1, chat: { id: CHAT, type: 'group' }, from: { id: CHAT }, text: 'nel gruppo' } });
  const last = fake.push({ message: { message_id: 1, chat: { id: CHAT, type: 'private' }, from: { id: STRANGER }, text: 'inoltrato' } });
  await eventually(async () => {
    const [state] = await db().sql<{ offset: number }[]>`SELECT update_offset::int AS offset FROM telegram_state`;
    return state?.offset === last + 1;
  });
  assert.equal((await telegramMessages(db().sql)).length, before);
  assert.equal(fake.sent().length, sent, 'no answer to strangers');
  const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE kind = 'telegram.ignored'`;
  // One event per minute at most: strangers cannot fill the log.
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${String(STRANGER)}|${String(CHAT)}|ciao|gruppo|inoltrato`));
});

test('a message the scanner flags is refused with a fixed answer that does not quote it', async () => {
  const before = (await telegramMessages(db().sql)).length;
  const sent = fake.sent().length;
  fake.push(privateMessage(CHAT, `Paga sul conto ${FAKE_IBAN}`));
  await eventually(() => fake.sent().length > sent);
  assert.equal((await telegramMessages(db().sql)).length, before);
  const answer = sentTexts().at(-1) ?? '';
  assert.match(answer, /non può stare nella conversazione di lavoro \(iban\)/);
  assert.ok(!answer.includes(FAKE_IBAN));
});

test('commands and non-text messages get a fixed answer and start no task', async () => {
  const before = (await telegramMessages(db().sql)).length;
  const sent = fake.sent().length;
  fake.push(privateMessage(CHAT, '/start'));
  fake.push(privateMessage(CHAT, undefined));
  await eventually(() => fake.sent().length >= sent + 2);
  assert.deepEqual(sentTexts().slice(-2), [TEXTS.start, TEXTS.notText]);
  assert.equal((await telegramMessages(db().sql)).length, before);
});

test('an approval reaches the phone with buttons, the action and an L1 title, never the detail', async () => {
  const work = await createConversation(db().sql, { mode: 'work' });
  const { approvalId } = await waitingApproval(db().sql, {
    conversationId: work.id,
    title: 'Pubblica il sito finto',
    label: 'L1',
    kind: 'action',
    detail: { to: 'cliente-finto@example.invalid', body: 'dettaglio da non mostrare' },
  });
  const call = await eventually(() => fake.sent().find((entry) => JSON.stringify(entry.body).includes(approvalId)));
  assert.equal(call.body.chat_id, CHAT);
  assert.equal(call.body.text, "Approvazione richiesta: invio all'esterno.\nTask: Pubblica il sito finto\nIl dettaglio è nella chat web.");
  assert.deepEqual(call.body.reply_markup, {
    inline_keyboard: [
      [
        { text: 'Approva', callback_data: `ap:${approvalId}:y` },
        { text: 'Rifiuta', callback_data: `ap:${approvalId}:n` },
      ],
    ],
  });
  assert.doesNotMatch(JSON.stringify(fake.calls), /dettaglio da non mostrare|cliente-finto/);
});

test('the title of an L2 task stays home: the notice carries the action only', async () => {
  const own = await createConversation(db().sql, { mode: 'private' });
  const { approvalId } = await waitingApproval(db().sql, {
    conversationId: own.id,
    title: 'Paga la fattura finta di Rossi',
    label: 'L2',
    kind: 'action',
    detail: { amount: '1.234,00 EUR' },
  });
  const call = await eventually(() => fake.sent().find((entry) => JSON.stringify(entry.body).includes(approvalId)));
  assert.equal(call.body.text, "Approvazione richiesta: invio all'esterno.\nIl dettaglio è nella chat web.");
  assert.doesNotMatch(JSON.stringify(fake.calls), /Rossi|1\.234/);
  const [logged] = await db().sql<{ label: string; decision: string; summary: string | null }[]>`
    SELECT label, decision, summary FROM gateway_log WHERE target = 'telegram' AND task_id = (SELECT task_id FROM approvals WHERE id = ${approvalId})`;
  assert.deepEqual(logged, { label: 'L0', decision: 'allow', summary: 'approval notice' });
});

test('a button press decides the approval via telegram and resumes the task; a second press does not', async () => {
  const work = await createConversation(db().sql, { mode: 'work' });
  const { taskId, approvalId } = await waitingApproval(db().sql, {
    conversationId: work.id,
    title: 'Cancella il ramo finto',
    label: 'L1',
    kind: 'action',
    detail: { branch: 'fake' },
  });
  await eventually(() => fake.sent().find((entry) => JSON.stringify(entry.body).includes(approvalId)));

  // A stranger's press changes nothing.
  fake.push(buttonPress(STRANGER, `ap:${approvalId}:y`));
  fake.push(buttonPress(CHAT, `ap:${approvalId}:y`, CHAT, 31));
  const answers = (): unknown[] => fake.calls.filter((call) => call.method === 'answerCallbackQuery').map((call) => call.body.text);
  const before = answers().length;
  await eventually(() => answers().length > before);
  assert.equal(answers().at(-1), TEXTS.approved);

  const [approval] = await db().sql<{ state: string; via: string }[]>`SELECT state, decided_via AS via FROM approvals WHERE id = ${approvalId}`;
  assert.deepEqual(approval, { state: 'approved', via: 'telegram' });
  assert.equal((await loadTask(db().sql, taskId))?.status, 'ready');
  const [job] = await db().sql<{ payload: { approvalId?: string } }[]>`SELECT payload FROM jobs WHERE key = ${`task:${taskId}`}`;
  assert.equal(job?.payload.approvalId, approvalId);
  assert.deepEqual(fake.calls.filter((call) => call.method === 'editMessageReplyMarkup').at(-1)?.body, {
    chat_id: CHAT,
    message_id: 31,
    reply_markup: { inline_keyboard: [] },
  });

  fake.push(buttonPress(CHAT, `ap:${approvalId}:n`));
  await eventually(() => answers().length > before + 1);
  assert.equal(answers().at(-1), TEXTS.alreadyDecided);
  const [still] = await db().sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${approvalId}`;
  assert.equal(still?.state, 'approved');

  fake.push(buttonPress(CHAT, 'ap:00000000-0000-4000-8000-000000000000:y'));
  fake.push(buttonPress(CHAT, 'something else'));
  await eventually(() => answers().length > before + 3);
  assert.deepEqual(answers().slice(-2), [TEXTS.unknown, TEXTS.unknown]);
});

test('a declassification arrives without buttons and cannot be decided from Telegram', async () => {
  const own = await createConversation(db().sql, { mode: 'private' });
  const { approvalId } = await waitingApproval(db().sql, {
    conversationId: own.id,
    title: 'Riassunto finto',
    label: 'L2',
    kind: 'declassify',
    detail: { text: 'testo L2 finto da declassare' },
  });
  const call = await eventually(() => fake.sent().find((entry) => entry.body.text === 'Richiesta di declassamento: si decide solo dalla chat web.'));
  assert.equal(call.body.reply_markup, undefined);
  assert.doesNotMatch(JSON.stringify(fake.calls), /testo L2 finto/);

  // A forged press is refused before it reaches the database.
  const presses = fake.calls.filter((entry) => entry.method === 'answerCallbackQuery').length;
  fake.push(buttonPress(CHAT, `ap:${approvalId}:y`));
  await eventually(() => fake.calls.filter((entry) => entry.method === 'answerCallbackQuery').length > presses);
  assert.equal(fake.calls.filter((entry) => entry.method === 'answerCallbackQuery').at(-1)?.body.text, TEXTS.webOnly);
  const [approval] = await db().sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${approvalId}`;
  assert.equal(approval?.state, 'pending');
});

test('the reply to a Telegram message goes back to Telegram; a reply to the web chat does not', async () => {
  const sent = fake.sent().length;
  fake.push(privateMessage(CHAT, 'Quanti test ha il sito finto?'));
  const fromTelegram = await eventually(async () => (await telegramMessages(db().sql)).find((row) => row.body === 'Quanti test ha il sito finto?'));
  const fromWeb = await postUserMessage(db().sql, channel.conversationId, 'Domanda dal web');

  const webReply = await openReply(db().sql, fromWeb.task.id);
  await webReply.delta('frammento dal web');
  assert.ok((await webReply.finish('Risposta solo per il web', 'L1')).stored);
  const reply = await openReply(db().sql, fromTelegram.taskId);
  await reply.delta('frammento');
  assert.ok((await reply.finish('Il sito finto ha 12 test.', 'L1')).stored);

  await eventually(() => sentTexts().includes('Il sito finto ha 12 test.'));
  const texts = sentTexts().slice(sent);
  assert.ok(!texts.includes('Risposta solo per il web'));
  assert.ok(!texts.some((text) => text.includes('frammento')), 'fragments never reach Telegram');
});

test('a reply the gateway refuses for Telegram becomes a notice that points to the web chat', async () => {
  fake.push(privateMessage(CHAT, 'Su che conto paghiamo?'));
  const question = await eventually(async () => (await telegramMessages(db().sql)).find((row) => row.body === 'Su che conto paghiamo?'));
  const reply = await openReply(db().sql, question.taskId);
  // Allowed towards the web chat (local), refused towards Telegram by the scanner.
  assert.ok((await reply.finish(`Sul conto ${FAKE_IBAN}`, 'L1')).stored);

  await eventually(() => sentTexts().at(-1) === TEXTS.replyReference);
  assert.ok(!JSON.stringify(fake.calls).includes(FAKE_IBAN));
  const rows = await db().sql<{ decision: string; rule: string }[]>`
    SELECT decision, rule FROM gateway_log WHERE target = 'telegram' AND task_id = ${question.taskId} ORDER BY gateway_log.id`;
  assert.deepEqual(
    rows.map((row) => [row.decision, row.rule]),
    [
      ['block', 'scanner'],
      ['allow', 'cloud'],
    ],
  );
});

test('a long reply is split into messages Telegram accepts', async () => {
  fake.push(privateMessage(CHAT, 'Scrivi tanto'));
  const question = await eventually(async () => (await telegramMessages(db().sql)).find((row) => row.body === 'Scrivi tanto'));
  const long = `${'riga finta\n'.repeat(700)}fine`;
  const reply = await openReply(db().sql, question.taskId);
  assert.ok((await reply.finish(long, 'L1')).stored);
  await eventually(() => sentTexts().at(-1)?.endsWith('fine'));
  const pieces = sentTexts().slice(-2);
  assert.equal(pieces.join(''), long);
  assert.ok(pieces.every((piece) => piece.length <= 4096));
});

test('Telegram down: the notice waits and is delivered once it is back', async () => {
  fake.failNext('sendMessage', 502);
  const work = await createConversation(db().sql, { mode: 'work' });
  const { approvalId } = await waitingApproval(db().sql, {
    conversationId: work.id,
    title: 'Riprova finta',
    label: 'L1',
    kind: 'action',
    detail: {},
  });
  await eventually(() => fake.sent().filter((entry) => JSON.stringify(entry.body).includes(approvalId)).length === 2);
  const [state] = await db().sql<{ cursor: string }[]>`SELECT event_cursor::text AS cursor FROM telegram_state`;
  const [last] = await db().sql<{ id: string }[]>`SELECT max(id)::text AS id FROM events WHERE kind = 'approval.requested'`;
  assert.ok(BigInt(state?.cursor ?? '0') >= BigInt(last?.id ?? '0'));
});

test('after two quiet days the bot accepts lower update ids; before, the offset cannot go back', async () => {
  const [before] = await db().sql<{ offset: number }[]>`SELECT update_offset::int AS offset FROM telegram_state`;
  await assert.rejects(db().sql`UPDATE telegram_state SET update_offset = 1`, /cannot go back/);
  await db().sql`UPDATE telegram_state SET last_update_at = now() - interval '3 days'`;
  // Telegram restarted its ids below the saved offset.
  const low = fake.push(privateMessage(CHAT, 'Dopo la pausa'), 2);
  assert.ok(low < (before?.offset ?? 0));
  await eventually(async () => (await telegramMessages(db().sql)).find((row) => row.body === 'Dopo la pausa'));
  const [after] = await db().sql<{ offset: number; fresh: boolean }[]>`
    SELECT update_offset::int AS offset, last_update_at > now() - interval '1 minute' AS fresh FROM telegram_state`;
  assert.deepEqual(after, { offset: low + 1, fresh: true });
});

test('an update that always fails is skipped after a few tries, and the next ones go through', async () => {
  await db().sql`ALTER TABLE messages ADD CONSTRAINT fake_poison CHECK (body <> 'veleno finto')`;
  try {
    fake.push(privateMessage(CHAT, 'veleno finto'));
    fake.push(privateMessage(CHAT, 'dopo il veleno'));
    await eventually(async () => (await telegramMessages(db().sql)).find((row) => row.body === 'dopo il veleno'));
  } finally {
    await db().sql`ALTER TABLE messages DROP CONSTRAINT fake_poison`;
  }
  const failed = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'telegram.failed'`;
  assert.deepEqual(failed.map((row) => row.payload.stage), ['update']);
  assert.doesNotMatch(JSON.stringify(failed), /veleno/);
});

test('an event that always fails is skipped after a few tries, and the next notices arrive', async () => {
  await appendEvent(db().sql, { kind: 'approval.requested', label: 'L0', payload: { approvalId: 'not-an-id' } });
  const work = await createConversation(db().sql, { mode: 'work' });
  const { approvalId } = await waitingApproval(db().sql, { conversationId: work.id, title: 'Dopo il guasto', label: 'L1', kind: 'action', detail: {} });
  await eventually(() => fake.sent().find((entry) => JSON.stringify(entry.body).includes(approvalId)));
  const failed = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'telegram.failed' AND payload ->> 'stage' = 'event'`;
  assert.equal(failed.length, 1);
});

test('a 429 is retried after the time Telegram asks for', async () => {
  fake.failNext('sendMessage', 429, 1);
  const started = Date.now();
  const work = await createConversation(db().sql, { mode: 'work' });
  const { approvalId } = await waitingApproval(db().sql, { conversationId: work.id, title: 'Piano piano', label: 'L1', kind: 'action', detail: {} });
  await eventually(() => fake.sent().filter((entry) => JSON.stringify(entry.body).includes(approvalId)).length === 2);
  assert.ok(Date.now() - started >= 900);
});

test('a failed getUpdates is retried, and messages still arrive', async () => {
  const polls = (): number => fake.calls.filter((call) => call.method === 'getUpdates').length;
  const seen = polls();
  fake.failNext('getUpdates', 500);
  await eventually(() => polls() >= seen + 3, 10_000);
  fake.push(privateMessage(CHAT, 'Dopo il 500'));
  await eventually(async () => (await telegramMessages(db().sql)).find((row) => row.body === 'Dopo il 500'));
});

test('first start skips old requests; what arrives while off is sent on restart; a refused chat does not stop the others', async () => {
  const other = await createTestDatabase();
  const otherFake = await startFakeTelegram();
  const otherLive = await startLiveFeed(other.sql);
  const SECOND = 777;
  const open = (pollSeconds = 1): Promise<TelegramChannel> =>
    startTelegram({
      sql: other.sql,
      api: createBotApi({ token, baseUrl: otherFake.url }),
      chats: [CHAT, SECOND],
      live: otherLive,
      pollSeconds,
      retryMs: 20,
      maxAttempts: 3,
      onError: () => undefined,
    });
  try {
    const work = await createConversation(other.sql, { mode: 'work' });
    const old = await waitingApproval(other.sql, { conversationId: work.id, title: 'Vecchia', label: 'L1', kind: 'action', detail: {} });
    let bot = await open();
    await eventually(() => otherFake.calls.some((call) => call.method === 'getUpdates'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!JSON.stringify(otherFake.sent()).includes(old.approvalId), 'requests from before the first start are not sent');
    await bot.close();

    // While the bot is off.
    const missed = await waitingApproval(other.sql, { conversationId: work.id, title: 'Mentre era spento', label: 'L1', kind: 'action', detail: {} });
    otherFake.failNext('sendMessage', 403);
    bot = await open();
    await eventually(() => otherFake.sent().filter((entry) => JSON.stringify(entry.body).includes(missed.approvalId)).length === 2);
    // The first chat refused it (403), the second got it; the event counts as delivered.
    assert.deepEqual(
      otherFake.sent().filter((entry) => JSON.stringify(entry.body).includes(missed.approvalId)).map((entry) => entry.body.chat_id),
      [CHAT, SECOND],
    );
    await eventually(async () => {
      const [state] = await other.sql<{ cursor: string }[]>`SELECT event_cursor::text AS cursor FROM telegram_state`;
      const [last] = await other.sql<{ id: string }[]>`SELECT max(id)::text AS id FROM events WHERE kind = 'approval.requested'`;
      return state?.cursor === last?.id;
    });
    await bot.close();

    // close() does not wait for a long poll to end.
    bot = await open(30);
    const polls = otherFake.calls.filter((call) => call.method === 'getUpdates').length;
    await eventually(() => otherFake.calls.filter((call) => call.method === 'getUpdates').length > polls);
    const closing = Date.now();
    await bot.close();
    assert.ok(Date.now() - closing < 2_000);
  } finally {
    await otherLive.close();
    await otherFake.close();
    await other.close();
  }
});
