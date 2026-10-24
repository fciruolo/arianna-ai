// The card of a folder of the Mac (D-314, I-22, tappa M1): the sentence and the command written by the core,
// three choices with their duration, «No», what the step had read before; the pending line and the title.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTION_TEXT } from '../src/lib/labels.ts';
import { afterText, MAC_CHOICE_TEXT, MAC_CHOICES, MAC_NO, macChoices, macRead } from '../src/lib/mac-approval.ts';
import { pendingAskText } from '../src/lib/pending-text.ts';

const DETAIL = {
  tool: 'mac.list',
  step: 1,
  folder: '/casa-finta/Documents/Foto-finte',
  place: '«Foto-finte» in Documenti',
  sentence: 'Arianna vuole vedere i file della cartella «Foto-finte» in Documenti.',
  command: 'ls ~/Documents/Foto-finte',
  after: [],
};

test('the card: the sentence and the command of the core, the folder the permission is for', () => {
  assert.deepEqual(macRead({ kind: 'mac', action: 'mac.read', detail: DETAIL }), {
    sentence: DETAIL.sentence,
    command: DETAIL.command,
    place: DETAIL.place,
    after: [],
  });
  assert.equal(ACTION_TEXT['mac.read'], 'Posso guardare in questa cartella?');
});

test('three choices, the narrowest first, and «No»', () => {
  assert.deepEqual(
    MAC_CHOICES.map((choice) => MAC_CHOICE_TEXT[choice]),
    ['Solo questa volta', 'Per tutta questa conversazione', 'Sempre'],
  );
  assert.equal(MAC_NO, 'No');
});

test('from the phone the card has no «Sempre»; on the Mac it has all three', () => {
  assert.deepEqual(macChoices(true), ['once', 'conversation']);
  assert.deepEqual(macChoices(false), ['once', 'conversation', 'always']);
});

test('a card asked after reading a page or a file says so; one asked after nothing says nothing', () => {
  const card = macRead({ kind: 'mac', action: 'mac.read', detail: { ...DETAIL, after: ['la pagina web example.com', 'il file nota-finta.txt', 3] } });
  assert.deepEqual(card?.after, ['la pagina web example.com', 'il file nota-finta.txt']);
  assert.equal(
    afterText(['la pagina web example.com', 'il file nota-finta.txt']),
    'Richiesta dopo aver letto: la pagina web example.com, il file nota-finta.txt. Controlla che sia davvero quello che vuoi.',
  );
  assert.equal(afterText([]), undefined);
});

test('a purged card, another kind or a card without the sentence is not a card of a folder', () => {
  assert.equal(macRead({ kind: 'mac', action: 'mac.read', detail: { purged: true } }), undefined);
  assert.equal(macRead({ kind: 'browser', action: 'mac.read', detail: DETAIL }), undefined);
  assert.equal(macRead({ kind: 'mac', action: 'mac.read', detail: { ...DETAIL, sentence: ' ' } }), undefined);
});

test('the line of «Attende te» names the folder, never a file', () => {
  assert.equal(pendingAskText({ kind: 'mac', action: 'mac.read', detail: DETAIL }), 'Guardare nella cartella «Foto-finte» in Documenti del Mac');
  assert.equal(pendingAskText({ kind: 'mac', action: 'mac.read', detail: { purged: true } }), 'Guardare in una cartella del Mac');
});
