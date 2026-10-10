import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canErase, DELETE_NOTE_TEXT, DELETE_PROJECT_NOTE_TEXT, ERASE_CONVERSATION_TEXT, ERASE_QUESTION, eraseFailedText } from '../src/lib/erase.ts';

// "Elimina" for good (D-157): when the button is offered, and what the confirmations say.

test('a conversation of the list can be erased; the secretary, Telegram and an incognito one cannot', () => {
  assert.equal(canErase({ telegram: false }), true);
  assert.equal(canErase({ telegram: false, secretary: false, incognito: false }), true);
  assert.equal(canErase({ telegram: true }), false);
  assert.equal(canErase({ telegram: false, secretary: true }), false);
  assert.equal(canErase({ telegram: false, incognito: true }), false);
});

test('every confirmation asks the same question and says it cannot be undone', () => {
  assert.equal(ERASE_QUESTION, 'Eliminare per sempre?');
  assert.match(ERASE_CONVERSATION_TEXT, /Non si può annullare/);
  assert.match(ERASE_CONVERSATION_TEXT, /registro/);
  assert.match(ERASE_CONVERSATION_TEXT, /card/);
  assert.match(DELETE_NOTE_TEXT, /non si recupera/);
  assert.match(DELETE_PROJECT_NOTE_TEXT, /non si recupera/);
});

test('a refused erase says why in words', () => {
  assert.match(eraseFailedText(409), /riprova/);
  assert.match(eraseFailedText(404), /non c’è più/);
  assert.match(eraseFailedText(undefined), /Non è stato possibile/);
  assert.match(eraseFailedText(500), /Non è stato possibile/);
});
