import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { commandError, parseNoteCommand, savedText } from '../src/lib/capture.ts';
import { errorText } from '../src/lib/italian.ts';

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
