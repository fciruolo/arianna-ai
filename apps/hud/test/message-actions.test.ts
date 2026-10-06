import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_NOTE_BYTES } from '../src/lib/capture.ts';
import { MESSAGE_ABOVE_L2_TEXT, MESSAGE_EMPTY_TEXT, MESSAGE_TOO_LARGE_TEXT } from '../src/lib/italian.ts';
import {
  captureOutcome,
  isSaved,
  inboxNodeId,
  loadSaved,
  mergeSavedNotes,
  MESSAGE_GONE_TEXT,
  messageCapture,
  saveMessage,
  withSaved,
  type Fetcher,
} from '../src/lib/message-actions.ts';

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** A stand-in for the core: answers every request with the same status and body, and records them. */
function core(status: number, body: unknown, seen: Seen[] = []): Fetcher {
  return (url, init) => {
    seen.push({ url, init });
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
  };
}

const message = { id: '42', body: 'Comprare il pane\ne il latte', label: 'L1' as const };

test('the save request carries the message id, a title and the label, not the text', () => {
  assert.deepEqual(messageCapture(message), { capture: { messageId: '42', kind: 'note', title: 'Comprare il pane', from: 'L1' } });
});

test('the save request is refused before the core for L3, empty and too long messages', () => {
  assert.deepEqual(messageCapture({ ...message, label: 'L3' }), { error: MESSAGE_ABOVE_L2_TEXT });
  assert.deepEqual(messageCapture({ ...message, body: '   ' }), { error: MESSAGE_EMPTY_TEXT });
  assert.deepEqual(messageCapture({ ...message, body: 'x'.repeat(MAX_NOTE_BYTES + 1) }), { error: MESSAGE_TOO_LARGE_TEXT });
  assert.ok('capture' in messageCapture({ ...message, label: 'L2' }));
});

test('201 is a save, 409 means already saved: both end in "Salvato"', () => {
  const saved = captureOutcome(201, { path: 'kb/inbox/a.md', label: 'L2', organizing: true });
  assert.deepEqual(saved, { kind: 'saved', note: 'a.md' });
  assert.deepEqual(captureOutcome(201, {}), { kind: 'saved', note: null });
  assert.equal(isSaved(saved), true);
  const already = captureOutcome(409, { error: 'the message is already saved in the inbox', note: 'a.md' });
  assert.deepEqual(already, { kind: 'already', note: 'a.md' });
  assert.equal(isSaved(already), true);
  // A note above L2 is not named.
  assert.deepEqual(captureOutcome(409, { error: 'x', note: null }), { kind: 'already', note: null });
  assert.deepEqual(captureOutcome(409, null), { kind: 'already', note: null });
});

test('every 404 of a message save gets the same text, whatever the core says in English', () => {
  const missing = captureOutcome(404, { error: 'message not found' });
  assert.deepEqual(missing, { kind: 'failed', text: MESSAGE_GONE_TEXT });
  assert.equal(isSaved(missing), false);
  // No capture configured in the core: also 404, same text, no comparison with the English message.
  assert.deepEqual(captureOutcome(404, { error: 'not found' }), { kind: 'failed', text: MESSAGE_GONE_TEXT });
  assert.deepEqual(captureOutcome(404, {}), { kind: 'failed', text: MESSAGE_GONE_TEXT });
  assert.deepEqual(captureOutcome(404, { error: 'something else' }), { kind: 'failed', text: MESSAGE_GONE_TEXT });
});

test('other answers are failures with an Italian reason', () => {
  assert.deepEqual(captureOutcome(403, { error: 'kb/inbox is labeled L3: captures stop at L2' }), {
    kind: 'failed',
    text: 'La cartella kb/inbox è sopra Privato: la nota non è stata salvata.',
  });
  assert.deepEqual(captureOutcome(500, {}), { kind: 'failed', text: 'Errore del nucleo: riprova fra poco.' });
});

test('saveMessage posts JSON to /api/capture and reads the answer', async () => {
  const seen: Seen[] = [];
  const outcome = await saveMessage(message, core(201, { path: 'kb/inbox/a.md', label: 'L1' }, seen));
  assert.deepEqual(outcome, { kind: 'saved', note: 'a.md' });
  assert.equal(seen.length, 1);
  const request = seen.at(0);
  assert.equal(request?.url, '/api/capture');
  assert.equal(request.init?.method, 'POST');
  assert.deepEqual(request.init.headers, { 'content-type': 'application/json' });
  assert.equal(typeof request.init.body, 'string');
  assert.deepEqual(JSON.parse(request.init.body as string), { messageId: '42', kind: 'note', title: 'Comprare il pane', from: 'L1' });
});

test('saveMessage turns a 409 into "already saved", without throwing', async () => {
  assert.deepEqual(await saveMessage(message, core(409, { error: 'the message is already saved in the inbox', note: 'a.md' })), { kind: 'already', note: 'a.md' });
});

test('saveMessage does not call the core for an L3 message', async () => {
  const seen: Seen[] = [];
  assert.deepEqual(await saveMessage({ ...message, label: 'L3' }, core(201, {}, seen)), { kind: 'failed', text: MESSAGE_ABOVE_L2_TEXT });
  assert.equal(seen.length, 0);
});

test('saveMessage reports a core that does not answer', async () => {
  const down: Fetcher = () => Promise.reject(new TypeError('fetch failed'));
  assert.deepEqual(await saveMessage(message, down), { kind: 'failed', text: 'Il nucleo non risponde: controlla che sia avviato.' });
});

test('loadSaved reads the saved messages of a conversation, with the names the core gives, and its whole note', async () => {
  const seen: Seen[] = [];
  const state = await loadSaved('7', core(200, { messageIds: ['42', '43', 44], notes: { '42': 'a.md', '43': 3 }, conversation: true, conversationNote: 'kb/inbox/c.md' }, seen));
  assert.deepEqual([...state.messages], [['42', 'a.md'], ['43', null]]);
  assert.deepEqual(state.conversation, { saved: true, path: 'kb/inbox/c.md' });
  assert.equal(seen.length, 1);
  assert.equal(seen.at(0)?.url, '/api/conversations/7/saved');
  // An older core without `notes` nor `conversationNote`: the ids only, no path.
  const older = await loadSaved('7', core(200, { messageIds: ['42'], conversation: true }));
  assert.deepEqual([[...older.messages], older.conversation], [[['42', null]], { saved: true, path: null }]);
  // Saved but not named (above L2): no path; a path without `conversation: true` is not believed.
  assert.deepEqual((await loadSaved('7', core(200, { messageIds: [], conversation: true, conversationNote: null }))).conversation, { saved: true, path: null });
  assert.deepEqual((await loadSaved('7', core(200, { messageIds: [], conversationNote: 'kb/inbox/c.md' }))).conversation, { saved: false, path: null });
});

test('loadSaved says nothing saved when the core cannot say', async () => {
  for (const fetcher of [core(404, { error: 'not found' }), core(200, {}), () => Promise.reject(new TypeError('fetch failed'))] as Fetcher[]) {
    const state = await loadSaved('7', fetcher);
    assert.deepEqual([state.messages.size, state.conversation], [0, { saved: false, path: null }]);
  }
});

test('inboxNodeId gives the node of the graph from a path or a file name', () => {
  assert.equal(inboxNodeId('kb/inbox/2026-10-06-a.md'), 'inbox/2026-10-06-a.md');
  assert.equal(inboxNodeId('2026-10-06-a.md'), 'inbox/2026-10-06-a.md');
});

test('withSaved adds a message to a new map, keeping a known file name', () => {
  const before = new Map([['1', 'a.md']]);
  const after = withSaved(before, '2', 'b.md');
  assert.notEqual(after, before);
  assert.deepEqual([...after], [['1', 'a.md'], ['2', 'b.md']]);
  assert.deepEqual([...before], [['1', 'a.md']]);
  // A 409 above L2 has no name: the one already known stays.
  assert.equal(withSaved(before, '1', null).get('1'), 'a.md');
});

test('mergeSavedNotes adds the notes read and keeps the saves made while reading', () => {
  const current = new Map<string, string | null>([['5', 'nuova.md'], ['6', null]]);
  const merged = mergeSavedNotes(current, new Map([['3', null], ['5', 'vecchia.md'], ['6', 'sei.md']]), '7', '7');
  assert.deepEqual([...merged].sort(), [['3', null], ['5', 'nuova.md'], ['6', 'sei.md']]);
  assert.deepEqual([...current], [['5', 'nuova.md'], ['6', null]]);
});

test('mergeSavedNotes drops the answer for a conversation no longer open', () => {
  const current = new Map([['9', null]]);
  const merged = mergeSavedNotes(current, new Map([['3', null]]), '7', '8');
  assert.equal(merged, current);
  assert.equal(merged.has('3'), false);
});

test('the whole conversation (I-7, D-131): what the chat says after a save, and the note path', async () => {
  const { saveConversation } = await import('../src/lib/message-actions.ts');
  const reply = (status: number, body: unknown) => () => Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });
  assert.deepEqual(await saveConversation('c1', reply(201, { path: 'kb/inbox/a.md', replaced: false })), {
    ok: true,
    text: 'Conversazione salvata in kb/inbox/a.md',
    path: 'kb/inbox/a.md',
  });
  assert.deepEqual(await saveConversation('c1', reply(201, { path: 'kb/inbox/b.md', replaced: true })), { ok: true, text: 'Nota aggiornata in kb/inbox/b.md', path: 'kb/inbox/b.md' });
  const refused = await saveConversation('c1', reply(403, { error: 'kb/inbox is labeled L3: captures stop at L2' }));
  assert.equal(refused.ok, false);
});
