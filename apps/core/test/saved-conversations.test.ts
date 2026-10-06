// I-7 (D-131): a whole conversation in one note of kb/inbox, replaced by a second save.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { CaptureError, MAX_CAPTURE_BYTES } from '../src/capture.ts';
import { keptCaptureFields } from '../src/notes.ts';
import { conversationText, findConversationNote, saveConversation, type SavedLine } from '../src/saved-conversations.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const ID = '11111111-2222-4333-8444-555555555555';

function home(): string {
  const dir = join(scratch, randomUUID());
  mkdirSync(join(dir, 'kb'), { recursive: true });
  return dir;
}

const line = (role: SavedLine['role'], body: string, extra: Partial<SavedLine> = {}): SavedLine => ({ role, agent: null, label: 'L1', body, ...extra });
const LINES = [
  line('user', 'Traduci buongiorno.'),
  line('system', 'Arianna aggiunge traduttore'),
  line('assistant', 'Good morning.', { agent: 'traduttore' }),
  line('assistant', 'Fatto: «Good morning».'),
];

test('the text: who wrote each message, oldest first, never the lines of the system', () => {
  assert.equal(conversationText(LINES), '**Tu:** Traduci buongiorno.\n\n**traduttore:** Good morning.\n\n**Arianna:** Fatto: «Good morning».');
  assert.match(conversationText([line('assistant', 'Fatto.', { agent: 'coder' })]), /^\*\*Coder:\*\*/);
});

test('above the size of a note the oldest messages go, and the note says so', () => {
  const big = 'x'.repeat(MAX_CAPTURE_BYTES / 2);
  const text = conversationText([line('user', `vecchio ${big}`), line('user', `medio ${big}`), line('user', 'nuovo')]);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES);
  assert.match(text, /^\(Inizio tagliato/);
  assert.doesNotMatch(text, /vecchio/);
  assert.match(text, /nuovo$/);
  // One message alone above the limit: its end stays.
  // Just over the limit once the oldest goes: the warning still comes first.
  const edge = conversationText([line('user', 'vecchio'), line('user', 'z'.repeat(MAX_CAPTURE_BYTES - 20))]);
  assert.match(edge, /^\(Inizio tagliato/);
  assert.doesNotMatch(edge, /vecchio/);
  assert.ok(Buffer.byteLength(edge, 'utf8') <= MAX_CAPTURE_BYTES);
  const alone = conversationText([line('user', `${'y'.repeat(MAX_CAPTURE_BYTES)} fine`)]);
  assert.ok(Buffer.byteLength(alone, 'utf8') <= MAX_CAPTURE_BYTES);
  assert.match(alone, /fine$/);
});

test('saved once, then a second save replaces the same note; the label is the highest of the messages', () => {
  const dir = home();
  const first = saveConversation({ home: dir, rules: RULES, conversationId: ID, title: 'Traduzioni', lines: LINES, now: new Date(2026, 9, 6, 4, 0, 0) });
  assert.deepEqual([first.label, first.replaced], ['L2', false]);
  const raw = readFileSync(join(dir, first.path), 'utf8');
  assert.match(raw, /^source: conversation:11111111-2222-4333-8444-555555555555$/m);
  assert.match(raw, /^title: "Traduzioni"$/m);
  assert.doesNotMatch(raw, /Arianna aggiunge/);
  // The organizer keeps the source when it rewrites the note.
  assert.equal(keptCaptureFields(raw).source, `conversation:${ID}`);
  assert.equal(findConversationNote(dir, RULES, ID)?.path, first.path);

  const second = saveConversation({
    home: dir,
    rules: RULES,
    conversationId: ID,
    title: 'Traduzioni',
    lines: [...LINES, line('user', 'E buonanotte?')],
    now: new Date(2026, 9, 6, 4, 5, 0),
  });
  assert.equal(second.replaced, true);
  const notes = readdirSync(join(dir, 'kb', 'inbox'));
  assert.deepEqual(notes, [second.path.split('/').at(-1)]);
  assert.match(readFileSync(join(dir, second.path), 'utf8'), /E buonanotte\?/);
  // Another conversation: its own note.
  const other = saveConversation({ home: dir, rules: RULES, conversationId: randomUUID(), title: '\u{1F600}'.repeat(250), lines: LINES });
  assert.doesNotMatch(readFileSync(join(dir, other.path), 'utf8'), /\uFFFD/);
  assert.equal(other.replaced, false);
  assert.equal(readdirSync(join(dir, 'kb', 'inbox')).length, 2);
});

test('never: an empty conversation, a message above L2, a bad id', () => {
  const dir = home();
  assert.throws(() => saveConversation({ home: dir, rules: RULES, conversationId: ID, title: null, lines: [line('system', 'riga')] }), CaptureError);
  assert.throws(() => saveConversation({ home: dir, rules: RULES, conversationId: ID, title: null, lines: [line('user', 'chiave', { label: 'L3' })] }), /captures stop at L2/);
  assert.throws(() => saveConversation({ home: dir, rules: RULES, conversationId: 'x', title: null, lines: LINES }), /invalid source/);
  // A conversation that read L3: never saved, even with every message labeled lower.
  assert.throws(() => saveConversation({ home: dir, rules: RULES, conversationId: ID, title: null, lines: LINES, floor: 'L3' }), /captures stop at L2/);
  assert.equal(readdirSync(join(dir, 'kb')).includes('inbox') ? readdirSync(join(dir, 'kb', 'inbox')).length : 0, 0);
});
