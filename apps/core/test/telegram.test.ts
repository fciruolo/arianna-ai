import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createContext } from '@arianna/policy';
import { Secret } from '@arianna/vault';

import type { Sql } from '../src/db/client.ts';
import { createBotApi, TelegramApiError, type BotApi } from '../src/telegram/api.ts';
import { isCleared, MAX_MESSAGE_UNITS, passToTelegram, splitCleared, type ClearedText } from '../src/telegram/outgoing.ts';
import { approvalNotice, isWebOnly, scannerRefusal, TEXTS } from '../src/telegram/texts.ts';
import { decodeDecision, encodeDecision, isAllowed, parseUpdates, type Update } from '../src/telegram/updates.ts';
import { buttonPress, privateMessage, startFakeTelegram, type FakeTelegram } from './support/fake-telegram.ts';

const CHAT = 424242;
const APPROVAL = '6f1c2a9e-0b7d-4c3e-9a51-2d8f4e6b7c10';
// Not a real token: shaped so that only the client's own check accepts it.
const FAKE_TOKEN = '1234567:fake-token-for-tests-only-0000';

// passGateway writes one row per decision: here the log is a no-op.
const noLog = (() => Promise.resolve([])) as unknown as Sql;

async function cleared(text: string): Promise<ClearedText> {
  const passed = await passToTelegram(noLog, [{ text, label: 'L0', source: 'test' }], createContext('L1', 'L0'));
  assert.ok(passed.ok);
  const [first] = passed.texts;
  assert.ok(first !== undefined);
  return first;
}

test('updates keep only checked fields, and drop entries without a valid id', () => {
  const updates = parseUpdates([
    { update_id: 1, ...privateMessage(CHAT, 'ciao') },
    { update_id: 2, ...privateMessage(CHAT, undefined) },
    { update_id: 3, ...buttonPress(CHAT, `ap:${APPROVAL}:y`) },
    { update_id: 4, edited_message: { chat: { id: CHAT } } },
    { update_id: -1, ...privateMessage(CHAT, 'negative') },
    { update_id: '5', ...privateMessage(CHAT, 'string id') },
    null,
    'junk',
    { update_id: 6, message: { chat: { id: 'x' } }, callback_query: { id: '', from: { id: CHAT } } },
  ]);
  assert.deepEqual(
    updates.map((update) => [update.kind, update.updateId]),
    [
      ['message', 1],
      ['message', 2],
      ['callback', 3],
      ['other', 4],
      ['other', 6],
    ],
  );
  assert.deepEqual(updates[0], { kind: 'message', updateId: 1, chatId: CHAT, chatType: 'private', fromId: CHAT, text: 'ciao' });
  assert.equal((updates[1] as Extract<Update, { kind: 'message' }>).text, undefined);
  const press = updates[2] as Extract<Update, { kind: 'callback' }>;
  assert.deepEqual([press.fromId, press.chatId, press.messageId, press.data], [CHAT, CHAT, 7, `ap:${APPROVAL}:y`]);
});

test('only listed private chats, written by their own user, are allowed', () => {
  const [mine, group, other, forwarded, press, pressElsewhere, stranger] = parseUpdates([
    { update_id: 1, ...privateMessage(CHAT, 'a') },
    { update_id: 2, message: { chat: { id: CHAT, type: 'group' }, from: { id: CHAT }, text: 'b' } },
    { update_id: 3, ...privateMessage(999, 'c') },
    { update_id: 4, message: { chat: { id: CHAT, type: 'private' }, from: { id: 999 }, text: 'd' } },
    { update_id: 5, ...buttonPress(CHAT, 'x') },
    { update_id: 6, ...buttonPress(CHAT, 'x', -100123) },
    { update_id: 7, ...buttonPress(999, 'x') },
  ]);
  const verdicts = [mine, group, other, forwarded, press, pressElsewhere, stranger].map((update) => {
    assert.ok(update !== undefined);
    return isAllowed(update, [CHAT]);
  });
  assert.deepEqual(verdicts, [true, false, false, false, true, false, false]);
  assert.equal(isAllowed({ kind: 'other', updateId: 1 }, [CHAT]), false);
});

test('button data carries an approval id and a choice, nothing else', () => {
  const yes = encodeDecision(APPROVAL, 'approved');
  assert.equal(yes, `ap:${APPROVAL}:y`);
  assert.ok(Buffer.byteLength(yes) <= 64);
  assert.deepEqual(decodeDecision(yes), { approvalId: APPROVAL, state: 'approved' });
  assert.deepEqual(decodeDecision(encodeDecision(APPROVAL.toUpperCase(), 'rejected')), { approvalId: APPROVAL, state: 'rejected' });
  for (const data of [undefined, '', `ap:${APPROVAL}:x`, `ap:${APPROVAL}`, `ap:${APPROVAL}:y:extra`, 'ap:------------------------------------:y', `ap:${APPROVAL.toUpperCase()}:y`]) {
    assert.equal(decodeDecision(data), undefined, String(data));
  }
  assert.throws(() => encodeDecision('not-an-id', 'approved'));
});

test('an approval notice names the action and the title, never anything else', () => {
  const notice = approvalNotice('action', 'send_external', 'Manda il preventivo finto\nTask: falso');
  assert.equal(notice, "Approvazione richiesta: invio all'esterno.\nTask: Manda il preventivo finto Task: falso\nIl dettaglio è nella chat web.");
  assert.equal(approvalNotice('action', 'payment'), 'Approvazione richiesta: pagamento.\nIl dettaglio è nella chat web.');
  assert.equal(approvalNotice('workspace', 'dirty-workspace'), 'Approvazione richiesta: il Coder lavorerebbe in una cartella con modifiche non committate.\nIl dettaglio è nella chat web.');
  assert.equal(approvalNotice('budget', 'budget'), 'Approvazione richiesta: budget per un modello che costa oltre il piano.\nIl dettaglio è nella chat web.');
  // A commitment of the secretary (D-144): neither its text nor a button, the web chat only.
  assert.equal(approvalNotice('commitment', 'commitment.add'), 'La segretaria aspetta una conferma: si dà solo dalla chat web.');
  // A plan and the choice of an executor (D-159): no detail, no button, the web chat only.
  assert.equal(approvalNotice('plan', 'task.plan', 'Landing'), 'Arianna propone un piano di card: si approva solo dalla chat web.\nTask: Landing');
  assert.equal(approvalNotice('executor', 'card.executor'), 'Un lavoro di un agente aspetta che tu scelga chi lo fa (Claude, ChatGPT o modello locale): si sceglie solo dalla chat web.');
  assert.deepEqual(['declassify', 'commitment', 'plan', 'executor'].map(isWebOnly), [true, true, true, true]);
  assert.deepEqual(['action', 'workspace', 'budget', 'setting'].map(isWebOnly), [false, false, false, false]);
  // A name outside the closed list is not quoted.
  assert.doesNotMatch(approvalNotice('budget', 'raise the cap to 1.000 EUR'), /1\.000|cap/);
  assert.match(approvalNotice('declassify', 'declassify', 'Titolo'), /^Richiesta di declassamento: si decide solo dalla chat web\.\nTask: Titolo$/);
  assert.match(scannerRefusal(['iban', 'tax-code']), /\(iban, tax-code\)/);
});

test('long texts are split for Telegram without breaking characters, and stay cleared', async () => {
  const text = `${'a'.repeat(MAX_MESSAGE_UNITS - 1)}😀${'b'.repeat(10)}\n${'c'.repeat(3000)}`;
  const pieces = splitCleared(await cleared(text));
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.every((piece) => isCleared(piece) && piece.text.length <= MAX_MESSAGE_UNITS));
  assert.equal(pieces.map((piece) => piece.text).join(''), text);
  assert.ok(pieces.every((piece) => !/^[\uDC00-\uDFFF]/.test(piece.text)));
  // A break at a newline in the second half of a piece is preferred.
  const lines = splitCleared(await cleared(`${'x'.repeat(3000)}\n${'y'.repeat(3000)}`));
  assert.deepEqual(lines.map((piece) => piece.text.length), [3001, 3000]);
  assert.deepEqual(splitCleared(await cleared('short')).map((piece) => piece.text), ['short']);
  assert.throws(() => splitCleared({ text: 'forged' }), /did not pass the gateway/);
});

test('the gateway decides what is cleared: L2, a dirty scan or a contaminated context are not', async () => {
  const l2 = await passToTelegram(noLog, [{ text: 'fattura finta', label: 'L2', source: 'test' }], createContext('L2', 'L2'));
  assert.ok(!l2.ok);
  assert.equal(l2.decision.next, 'notify-reference');
  const iban = await passToTelegram(noLog, [{ text: 'IBAN IT60X0542811101000000123456', label: 'L1', source: 'test' }], createContext('L1', 'L1'));
  assert.ok(!iban.ok);
  assert.equal(iban.decision.rule, 'scanner');
  const fine = await passToTelegram(noLog, [{ text: 'Fatto.', label: 'L1', source: 'test' }], createContext('L1', 'L1'));
  assert.ok(fine.ok);
});

let fake: FakeTelegram;
let api: BotApi;
const token = new Secret('vault://telegram-bot-token', FAKE_TOKEN);

before(async () => {
  fake = await startFakeTelegram();
  api = createBotApi({ token, baseUrl: fake.url });
});
after(async () => {
  await fake.close();
});

test('the client reveals the token only in the path, and sends only cleared text', async () => {
  const id = await api.sendMessage(CHAT, await cleared('Ciao'), [[{ text: await cleared('Approva'), data: `ap:${APPROVAL}:y` }]]);
  assert.equal(typeof id, 'number');
  const call = fake.calls.at(-1);
  assert.ok(call);
  assert.equal(call.token, FAKE_TOKEN);
  assert.equal(call.method, 'sendMessage');
  assert.deepEqual(call.body, {
    chat_id: CHAT,
    text: 'Ciao',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: 'Approva', callback_data: `ap:${APPROVAL}:y` }]] },
  });
  assert.doesNotMatch(JSON.stringify(call.body), /fake-token/);

  const before = fake.calls.length;
  await assert.rejects(api.sendMessage(CHAT, { text: 'forged' }), /did not pass the gateway/);
  await assert.rejects(api.sendMessage(CHAT, await cleared('ok'), [[{ text: { text: 'forged' }, data: 'x' }]]), /did not pass the gateway/);
  await assert.rejects(api.answerCallbackQuery('cb', { text: 'forged' }), /did not pass the gateway/);
  assert.equal(fake.calls.length, before, 'nothing reached Telegram');
});

test('errors carry method and status only, never the token or the body', async () => {
  fake.failNext('sendMessage', 400);
  const error = await api.sendMessage(CHAT, await cleared('testo da non citare')).catch((caught: unknown) => caught);
  assert.ok(error instanceof TelegramApiError);
  assert.equal(error.status, 400);
  assert.equal(error.transient, false);
  assert.doesNotMatch(`${error.message} ${String(error.stack)}`, /fake-token|testo da non citare/);

  fake.failNext('getUpdates', 429, 3);
  const limited = await api.getUpdates(0, 0).catch((caught: unknown) => caught);
  assert.ok(limited instanceof TelegramApiError);
  assert.deepEqual([limited.status, limited.retryAfter, limited.transient], [429, 3, true]);

  const unreachable = createBotApi({ token, baseUrl: 'http://127.0.0.1:1' });
  const down = await unreachable.getUpdates(0, 0).catch((caught: unknown) => caught);
  assert.ok(down instanceof TelegramApiError);
  assert.deepEqual([down.status, down.transient], [0, true]);
  assert.doesNotMatch(down.message, /fake-token/);
});

test('long polling asks only for messages and button presses, and returns raw updates', async () => {
  fake.push(privateMessage(CHAT, 'hello'));
  const raw = await api.getUpdates(0, 1);
  assert.equal(raw.length, 1);
  const call = fake.calls.filter((entry) => entry.method === 'getUpdates').at(-1);
  assert.deepEqual(call?.body, { offset: 0, timeout: 1, allowed_updates: ['message', 'callback_query'] });
  assert.deepEqual(await api.getUpdates(2, 0), []);
});

test('the client refuses plain http off loopback and a value that is not a bot token', () => {
  assert.throws(() => createBotApi({ token, baseUrl: 'http://api.telegram.org' }), /must be https/);
  assert.throws(() => createBotApi({ token, baseUrl: 'http://localhost:1' }), /must be https/);
  assert.throws(() => createBotApi({ token: new Secret('vault://not-a-token', '123/../../x?y') }), /vault:\/\/not-a-token is not a bot token/);
  assert.doesNotThrow(() => createBotApi({ token }));
  assert.equal(TEXTS.approve, 'Approva');
});
