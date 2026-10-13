// The documents of a client (I-16 tappa C2, D-171), the pure part: what a
// file may be (extension confirmed by its bytes), the line of the morning
// message with client and type only. Invented data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expiryLine, formatOf, longDay } from '../src/client-documents.ts';
import { reminderText } from '../src/reminders.ts';

const PDF = Buffer.from('%PDF-1.7\nfinto');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('finto')]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('finto docx')]);

test('a file is what its extension says, confirmed by its first bytes', () => {
  assert.deepEqual(formatOf('Contratto 2026.PDF', PDF), { extension: 'pdf', type: 'application/pdf', preview: true });
  assert.deepEqual(formatOf('vetrina.png', PNG), { extension: 'png', type: 'image/png', preview: true });
  assert.equal(formatOf('ordine.docx', ZIP)?.preview, false);
  assert.equal(formatOf('note.txt', Buffer.from('ciao, è testo'))?.type, 'text/plain');
  // Refused: a name with no known extension, bytes that say otherwise, text with a NUL or not UTF-8, an HTML page.
  assert.equal(formatOf('contratto', PDF), undefined);
  assert.equal(formatOf('contratto.pdf', PNG), undefined);
  assert.equal(formatOf('finto.png', PDF), undefined);
  assert.equal(formatOf('note.txt', Buffer.from([0x61, 0x00, 0x62])), undefined);
  assert.equal(formatOf('note.txt', Buffer.from([0xff, 0xfe, 0x41])), undefined);
  assert.equal(formatOf('pagina.html', Buffer.from('<script>alert(1)</script>')), undefined);
  assert.equal(formatOf('immagine.svg', Buffer.from('<svg/>')), undefined);
  assert.equal(formatOf('finto.webp', Buffer.from('RIFF0000WAVEfmt ')), undefined);
});

test('the line of the morning: client and type, never the name of the file', () => {
  assert.equal(longDay('2026-12-31'), '31 dicembre 2026');
  assert.equal(expiryLine('contract', null, 'Pasticceria Finta Rossi Srl', '2026-12-31'), 'Il contratto di Pasticceria Finta Rossi Srl scade il 31 dicembre 2026.');
  assert.equal(expiryLine('nda', null, 'Bianchi Spa', '2026-11-05'), 'L’NDA di Bianchi Spa scade il 5 novembre 2026.');
  assert.equal(expiryLine('other', 'polizza', 'Bianchi Spa', '2026-11-05'), 'Il documento «polizza» di Bianchi Spa scade il 5 novembre 2026.');
  const text = reminderText('morning', '2026-12-01', [], [], [], ['Il contratto di Rossi scade il 31 dicembre 2026.']);
  assert.match(text ?? '', /Documenti dei clienti in scadenza:\n- Il contratto di Rossi scade il 31 dicembre 2026\./);
  // Only in the morning.
  assert.equal(reminderText('evening', '2026-12-01', [], [], [], ['Il contratto di Rossi scade il 31 dicembre 2026.']), undefined);
});
