import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { canSaveToInbox, commandError, MAX_NOTE_BYTES, MAX_NOTE_TITLE, messageNote, noteTitle, parseNoteCommand, savedText } from '../src/lib/capture.ts';
import { errorText, MESSAGE_ABOVE_L2_TEXT, MESSAGE_EMPTY_TEXT, MESSAGE_TOO_LARGE_TEXT } from '../src/lib/italian.ts';

test('a draft starting with /nota becomes a note', () => {
  assert.deepEqual(parseNoteCommand('/nota comprare il pane'), { text: 'comprare il pane', kind: 'note' });
  assert.deepEqual(parseNoteCommand('  /nota\nprima riga\nseconda  '), { text: 'prima riga\nseconda', kind: 'note' });
  // Empty: still a note, so that the core refuses it and nothing reaches Arianna.
  assert.deepEqual(parseNoteCommand('/nota'), { text: '', kind: 'note' });
});

test('an ordinary message is not a note', () => {
  assert.equal(parseNoteCommand('comprare il pane'), undefined);
  assert.equal(parseNoteCommand('/notare qualcosa'), undefined);
  assert.equal(parseNoteCommand('ricorda /nota x'), undefined);
});

test('/nota is recognized in any case', () => {
  assert.deepEqual(parseNoteCommand('/NOTA x'), { text: 'x', kind: 'note' });
  assert.deepEqual(parseNoteCommand('/Nota x'), { text: 'x', kind: 'note' });
  assert.equal(commandError('/Nota x'), undefined);
});

test('an unknown command is not sent, ordinary messages and paths are', () => {
  assert.equal(commandError('/note comprare il pane'), 'Comando sconosciuto: /note. Per salvare una nota scrivi /nota seguito dal testo.');
  assert.match(commandError('  /aiuto') ?? '', /^Comando sconosciuto: \/aiuto\./);
  assert.equal(commandError('/nota comprare il pane'), undefined);
  assert.equal(commandError('comprare il pane'), undefined);
  assert.equal(commandError('/etc/hosts non si apre'), undefined);
  assert.equal(commandError('/ 2 fa 3'), undefined);
});

test('a note that is only an http(s) address is a link', () => {
  assert.deepEqual(parseNoteCommand('/nota https://example.org/a?b=1'), { text: 'https://example.org/a?b=1', kind: 'link', url: 'https://example.org/a?b=1' });
  assert.deepEqual(parseNoteCommand('/nota http://example.org'), { text: 'http://example.org', kind: 'link', url: 'http://example.org' });
});

test('other addresses or a link with words stay notes', () => {
  assert.deepEqual(parseNoteCommand('/nota javascript:alert(1)'), { text: 'javascript:alert(1)', kind: 'note' });
  assert.deepEqual(parseNoteCommand('/nota file:///etc/passwd'), { text: 'file:///etc/passwd', kind: 'note' });
  assert.deepEqual(parseNoteCommand('/nota leggere https://example.org'), { text: 'leggere https://example.org', kind: 'note' });
});

test('the notice names path and label', () => {
  assert.equal(savedText({ path: 'kb/inbox/2026-10-05-081244-pane.md', label: 'L2' }), 'Nota salvata in kb/inbox/2026-10-05-081244-pane.md (L2)');
});

test('the refusals of the capture are shown in Italian, unknown ones generically', () => {
  assert.equal(errorText(new ApiError(400, 'text is empty')), 'La nota è vuota.');
  assert.equal(errorText(new ApiError(413, 'text is longer than 64 KiB')), 'La nota supera 64 KiB.');
  assert.equal(errorText(new ApiError(403, 'kb/inbox is labeled L3: captures stop at L2')), 'La cartella kb/inbox è sopra L2: la nota non è stata salvata.');
  assert.equal(errorText(new ApiError(503, 'there is no kb/ folder')), 'Manca la cartella kb/: la nota non è stata salvata.');
  assert.equal(errorText(new ApiError(400, 'something else')), 'Richiesta non valida.');
});

test('noteTitle: the first line with text, one line, no control characters, at most 80 characters', () => {
  assert.equal(noteTitle('Comprare il pane\nseconda riga'), 'Comprare il pane');
  assert.equal(noteTitle('\n\n   \r\n  Titolo  vero \t qui\naltro'), 'Titolo vero qui');
  assert.equal(noteTitle('a\u0000b\u202Ec\u0007d'), 'a b c d');
  assert.equal(noteTitle('prima\u2028seconda'), 'prima');
  assert.equal(noteTitle('   \n\t'), undefined);
  const long = noteTitle('parola '.repeat(30));
  assert.ok(long !== undefined && Array.from(long).length <= MAX_NOTE_TITLE && long.endsWith('…'));
  // Cut by characters, not UTF-16 units: an emoji is never split.
  assert.equal(noteTitle('😀'.repeat(100)), `${'😀'.repeat(79)}…`);
  assert.equal(noteTitle('x'.repeat(80)), 'x'.repeat(80));
});

test('messageNote: the text as it is, kind note, a title and the label; over 64 KiB an Italian error and nothing to send', () => {
  assert.deepEqual(messageNote('## Riunione\n\ndettagli', 'L2'), { note: { text: '## Riunione\n\ndettagli', kind: 'note', title: '## Riunione', from: 'L2' } });
  const full = 'è'.repeat(MAX_NOTE_BYTES / 2);
  assert.deepEqual(messageNote(full, 'L1'), { note: { text: full, kind: 'note', title: `${'è'.repeat(79)}…`, from: 'L1' } });
  // 'è' is two bytes in UTF-8: one more character goes over the limit.
  assert.deepEqual(messageNote(`${full}è`, 'L2'), { error: MESSAGE_TOO_LARGE_TEXT });
  assert.deepEqual(messageNote('  \n ', 'L2'), { error: MESSAGE_EMPTY_TEXT });
});

test('an L3 message is not saved in the inbox: no button, and an Italian error if asked anyway', () => {
  for (const label of ['L0', 'L1', 'L2'] as const) assert.equal(canSaveToInbox(label), true, label);
  assert.equal(canSaveToInbox('L3'), false);
  assert.deepEqual(messageNote('Codice del conto', 'L3'), { error: MESSAGE_ABOVE_L2_TEXT });
});
