// «Su di te» (D-114): the words and the checks of the page, and its entry in the index.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factErrorText, factProblems, formOf, LEVEL_TEXT, MAX_FACT_TEXT, saveKind, type UserFact } from '../src/lib/profile.ts';
import { resolveSection, SETTINGS_INDEX } from '../src/lib/settings-index.ts';

const fact = (label: 'L1' | 'L2'): UserFact => ({ id: 'f1', topic: 'città', text: 'Borgo Finto', label, createdAt: '', updatedAt: '' });

test('the page says «Solo in casa» and «Condivisibile», never L1 or L2', () => {
  assert.deepEqual(LEVEL_TEXT, { L2: 'Solo in casa', L1: 'Condivisibile' });
});

test('«Su di te» is an entry of the settings, saved at once: only «Condivisibile» asks, inside the section', () => {
  const chosen = resolveSection('su-di-te');
  assert.equal(chosen.explicit, true);
  assert.equal(chosen.item.id, 'about-you');
  assert.equal(chosen.item.behaviour, 'now');
  assert.notEqual(chosen.item.privacy, true);
  assert.ok(SETTINGS_INDEX.some((group) => group.items.some((item) => item.id === 'about-you')));
});

test('factProblems: topic and text are needed, within their limits', () => {
  assert.deepEqual(factProblems({ topic: 'lavoro', text: 'Sviluppatore finto', shared: false }), {});
  const empty = factProblems({ topic: ' ', text: '', shared: false });
  assert.ok(empty.topic !== undefined && empty.text !== undefined);
  assert.ok(factProblems({ topic: 'x', text: 'a'.repeat(MAX_FACT_TEXT + 1), shared: true }).text !== undefined);
});

test('saveKind: only «Solo in casa» → «Condivisibile» asks for confirmation', () => {
  assert.equal(saveKind(fact('L2'), { ...formOf(fact('L2')), shared: true }), 'share');
  assert.equal(saveKind(fact('L2'), formOf(fact('L2'))), 'save');
  assert.equal(saveKind(fact('L1'), { ...formOf(fact('L1')), shared: false }), 'save');
  assert.equal(saveKind(null, { topic: 'a', text: 'b', shared: true }), 'save');
});

test('factErrorText: the refusals of the core in Italian, on the right field, without the text', () => {
  assert.deepEqual(factErrorText('invalid: text looks like personal data or a secret (iban): not saved', 400), { field: 'text', text: 'Il testo sembra contenere un IBAN: non salvato.' });
  assert.deepEqual(factErrorText('invalid: topic holds a value of the vault: not saved', 400), { field: 'topic', text: 'L’argomento contiene un valore del vault: non salvato.' });
  assert.equal(factErrorText('conflict: another fact has this topic', 409).field, 'topic');
  assert.equal(factErrorText('expired: the confirmation expired: prepare the change again', 410).text, 'La conferma è scaduta: salva di nuovo.');
  assert.equal(factErrorText('something else', 500).text, 'Non salvato: riprova.');
});
