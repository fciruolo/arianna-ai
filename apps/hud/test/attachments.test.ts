// Images and files attached in the chat (D-247): what the field takes, where,
// and what the user reads when it refuses. The same rules the core checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attachmentFileProblem,
  attachmentKind,
  attachmentPlaceProblem,
  attachmentsBody,
  attachmentSize,
  attachmentUrl,
  fittedSize,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_TEXT_BYTES,
  type AttachmentPlace,
} from '../src/lib/attachments.ts';
import { plusEntries, type PlusOptions } from '../src/lib/composer.ts';
import { errorText } from '../src/lib/italian.ts';
import { ApiError } from '../src/lib/api.ts';

const PRIVATE: AttachmentPlace = { mode: 'private', agent: null, incognito: false, secretary: false, origin: 'user', sideOf: null, archivedAt: null };

test('a private conversation with Arianna or the local model takes attachments', () => {
  assert.equal(attachmentPlaceProblem(PRIVATE), undefined);
  assert.equal(attachmentPlaceProblem({ ...PRIVATE, agent: 'local-chat' }), undefined);
  // A core that sends no optional field: the same.
  assert.equal(attachmentPlaceProblem({ mode: 'private', agent: null }), undefined);
});

test('a work conversation, a chat with Claude or ChatGPT, an incognito one or any other road refuses them, in Italian', () => {
  for (const agent of [null, 'claude', 'codex', 'coder']) {
    assert.match(attachmentPlaceProblem({ ...PRIVATE, mode: 'work', agent }) ?? '', /restano sul Mac.*Claude o ChatGPT/);
  }
  assert.match(attachmentPlaceProblem({ ...PRIVATE, incognito: true }) ?? '', /incognito/);
  for (const other of [{ secretary: true }, { sideOf: 'x' }, { origin: 'system' }, { agent: 'finanze' }]) {
    assert.match(attachmentPlaceProblem({ ...PRIVATE, ...other }) ?? '', /con Arianna o con il modello locale/, JSON.stringify(other));
  }
  assert.match(attachmentPlaceProblem({ ...PRIVATE, archivedAt: '2026-10-16T10:00:00Z' }) ?? '', /archiviata/);
});

test('the field takes PNG, JPEG, WebP and GIF images and .txt, .md, .csv, .json texts; never SVG', () => {
  assert.equal(attachmentKind({ name: 'image.png', type: 'image/png' }), 'image');
  assert.equal(attachmentKind({ name: 'foto.jpeg', type: 'image/jpeg' }), 'image');
  assert.equal(attachmentKind({ name: 'a.webp', type: 'image/webp' }), 'image');
  assert.equal(attachmentKind({ name: 'a.gif', type: 'image/gif' }), 'image');
  assert.equal(attachmentKind({ name: 'note.MD', type: '' }), 'text');
  assert.equal(attachmentKind({ name: 'spese.csv', type: 'text/csv' }), 'text');
  assert.equal(attachmentKind({ name: 'logo.svg', type: 'image/svg+xml' }), undefined);
  assert.equal(attachmentKind({ name: 'logo.txt', type: 'image/svg+xml' }), undefined);
  assert.equal(attachmentKind({ name: 'contratto.pdf', type: 'application/pdf' }), undefined);
  assert.equal(attachmentKind({ name: 'foto.heic', type: 'image/heic' }), undefined);
});

test('the field says why a file is refused: type, size, empty, too many', () => {
  assert.equal(attachmentFileProblem({ name: 'a.png', type: 'image/png', size: 10 }, 0), undefined);
  assert.match(attachmentFileProblem({ name: 'a.pdf', type: 'application/pdf', size: 10 }, 0) ?? '', /non si può allegare/);
  assert.match(attachmentFileProblem({ name: 'a.txt', type: 'text/plain', size: MAX_TEXT_BYTES + 1 }, 0) ?? '', /256 KiB/);
  assert.equal(attachmentFileProblem({ name: 'a.txt', type: 'text/plain', size: MAX_TEXT_BYTES }, 0), undefined);
  assert.match(attachmentFileProblem({ name: 'a.gif', type: 'image/gif', size: MAX_IMAGE_BYTES + 1 }, 0) ?? '', /10 MB/);
  // A large PNG is made smaller in the page before it leaves: not refused here.
  assert.equal(attachmentFileProblem({ name: 'a.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 }, 0), undefined);
  assert.match(attachmentFileProblem({ name: 'a.txt', type: 'text/plain', size: 0 }, 0) ?? '', /vuoto/);
  assert.match(attachmentFileProblem({ name: 'a.png', type: 'image/png', size: 10 }, MAX_ATTACHMENTS) ?? '', /Al massimo 4/);
});

test('a message of attachments alone gets a text; a written one stays as it is', () => {
  assert.equal(attachmentsBody('', ['schermata.png']), 'Allegato: schermata.png');
  assert.equal(attachmentsBody('  ', ['a.png', 'b.txt']), 'Allegati: a.png, b.txt');
  assert.equal(attachmentsBody('Cosa vedi?', ['a.png']), 'Cosa vedi?');
  assert.equal(attachmentsBody('', []), '');
});

test('an image larger than the side limit is made smaller keeping its shape', () => {
  assert.deepEqual(fittedSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fittedSize(4096, 2048), { width: MAX_IMAGE_SIDE, height: 1024 });
  assert.deepEqual(fittedSize(1000, 5000), { width: 410, height: MAX_IMAGE_SIDE });
  assert.deepEqual(fittedSize(0, 0), { width: 0, height: 0 });
});

test('the address and the size of an attachment', () => {
  assert.equal(attachmentUrl('3f1c2a4e-0000-4000-8000-000000000001'), '/api/attachments/3f1c2a4e-0000-4000-8000-000000000001');
  assert.equal(attachmentUrl('../x'), '/api/attachments/..%2Fx');
  assert.equal(attachmentSize(512), '512 B');
  assert.equal(attachmentSize(2048), '2 KB');
  assert.equal(attachmentSize(3_500_000), '3,3 MB');
});

const base: PlusOptions = { draft: '', mention: false, attachProject: null, session: false, save: false, mac: true };

test('«Allega file» in the «+» menu: on in a private chat, off with its reason elsewhere, absent without the option', () => {
  assert.equal(plusEntries(base).some((entry) => entry.id === 'file'), false);
  const on = plusEntries({ ...base, file: {} }).find((entry) => entry.id === 'file');
  assert.deepEqual([on?.action, on?.text, on?.disabled, on?.keys], ['file', 'Allega file', undefined, '⌘V']);
  assert.equal(plusEntries({ ...base, mac: false, file: {} }).find((entry) => entry.id === 'file')?.keys, 'Ctrl+V');
  const off = plusEntries({ ...base, file: { problem: 'no' } }).find((entry) => entry.id === 'file');
  assert.deepEqual([off?.disabled, off?.hint], [true, 'solo in una chat privata']);
});

test('the refusals of the core read in Italian', () => {
  assert.match(errorText(new ApiError(400, 'attachments go only in a private conversation: they never leave the Mac')), /conversazione privata/);
  assert.match(errorText(new ApiError(409, 'an attachment cannot wait in the queue: send it when the answer is done')), /non aspetta in coda/);
  assert.match(errorText(new ApiError(409, 'no local model reads images: assign the vision role in the settings')), /Guarda le immagini allegate/);
  assert.match(errorText(new ApiError(415, 'the file must be a PNG, JPEG, WebP or GIF image, or a .txt, .md, .csv or .json text')), /Si allegano solo/);
});
