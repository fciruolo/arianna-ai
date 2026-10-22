// D-294: the texts that speak of the mouse or of the keys say something a finger can do.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETTINGS_INDEX } from '../src/lib/settings-index.ts';
import { COARSE_QUERY, coarsePointer, wikiEmptyText } from '../src/lib/touch-hints.ts';

/** Words of the mouse and of the keyboard that a finger cannot follow. */
const MOUSE = /clic destro|passa sopra|⌘|ctrl|trascina/i;

test('coarsePointer asks the query of the touch: variant, and is false outside a browser', () => {
  assert.equal(COARSE_QUERY, '(pointer: coarse)');
  const asked: string[] = [];
  assert.equal(
    coarsePointer((query) => {
      asked.push(query);
      return true;
    }),
    true,
  );
  assert.deepEqual(asked, ['(pointer: coarse)']);
  assert.equal(
    coarsePointer(() => false),
    false,
  );
  assert.equal(coarsePointer(), false);
});

test('the empty Wiki and the empty folder: the right click with the mouse, «+» and «⋯» with a finger', () => {
  for (const where of ['wiki', 'folder'] as const) {
    assert.match(wikiEmptyText(where, false), /clic destro/);
    const touch = wikiEmptyText(where, true);
    assert.doesNotMatch(touch, MOUSE);
    assert.match(touch, /«\+»/);
  }
  assert.match(wikiEmptyText('folder', true), /«⋯»/);
});

test('a section whose lead speaks of the mouse has a lead for a finger without it', () => {
  const items = SETTINGS_INDEX.flatMap((group) => group.items);
  const changelog = items.find((item) => item.id === 'changelog');
  assert.match(changelog?.lead ?? '', /Passa sopra/);
  assert.match(changelog?.touchLead ?? '', /^Cosa è cambiato a ogni versione\. Tocca/);
  for (const item of items) {
    if (item.touchLead !== undefined) assert.doesNotMatch(item.touchLead, MOUSE, item.id);
    if (/passa sopra|clic destro/i.test(item.lead)) assert.notEqual(item.touchLead, undefined, item.id);
  }
});
