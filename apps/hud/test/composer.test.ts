import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRAFT_MAX,
  DRAFT_PREFIX,
  DRAFT_TTL_MS,
  draftKeeper,
  keepRefused,
  keepsDraft,
  loadDraft,
  modelDigit,
  modelForDigit,
  modelKeyText,
  nextEnabled,
  plusEntries,
  pruneDrafts,
  removeDraft,
  saveDraft,
  type DraftStorage,
  type PlusOptions,
} from '../src/lib/composer.ts';

const A = '0b9f6a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1c0a7b63-2d4e-4f60-9bac-1d2e3f4a5b6c';
const NOW = Date.UTC(2026, 9, 16, 12);

function memory(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function refusing(): DraftStorage {
  const fail = (): never => {
    throw new Error('blocked');
  };
  return { getItem: fail, setItem: fail, removeItem: fail, key: fail, get length(): number { return fail(); } };
}

test('a draft is kept per conversation and comes back for that one only (D-231)', () => {
  const storage = memory();
  saveDraft(storage, A, 'Ciao, domani alle 9', NOW);
  assert.equal(loadDraft(storage, A, NOW + 1000), 'Ciao, domani alle 9');
  assert.equal(loadDraft(storage, B, NOW + 1000), '');
  // Only the text and when: nothing else of the conversation.
  assert.deepEqual(JSON.parse(storage.map.get(DRAFT_PREFIX + A) ?? ''), { text: 'Ciao, domani alle 9', at: NOW });
});

test('an empty text, a sent message or an erased conversation removes the draft', () => {
  const storage = memory();
  saveDraft(storage, A, 'prima', NOW);
  saveDraft(storage, A, '   \n', NOW);
  assert.equal(storage.map.size, 0);
  saveDraft(storage, A, 'di nuovo', NOW);
  removeDraft(storage, A);
  assert.equal(loadDraft(storage, A, NOW), '');
});

test('a draft older than a week is gone, and removed on reading; one a moment younger stays', () => {
  const storage = memory();
  saveDraft(storage, A, 'vecchia', NOW);
  assert.equal(loadDraft(storage, A, NOW + DRAFT_TTL_MS), 'vecchia');
  assert.equal(loadDraft(storage, A, NOW + DRAFT_TTL_MS + 1), '');
  assert.equal(storage.map.size, 0);
});

test('a key that is not a conversation id is never written nor read', () => {
  const storage = memory();
  saveDraft(storage, 'incognito', 'testo', NOW);
  saveDraft(storage, '../altro', 'testo', NOW);
  assert.equal(storage.map.size, 0);
  storage.map.set(`${DRAFT_PREFIX}incognito`, JSON.stringify({ text: 'x', at: NOW }));
  assert.equal(loadDraft(storage, 'incognito', NOW), '');
});

test('a malformed value reads as no draft and is removed', () => {
  const storage = memory();
  for (const raw of ['non json', 'null', '"testo"', JSON.stringify({ text: 3, at: NOW }), JSON.stringify({ text: 'x' }), JSON.stringify({ text: 'x'.repeat(DRAFT_MAX + 1), at: NOW })]) {
    storage.map.set(DRAFT_PREFIX + A, raw);
    assert.equal(loadDraft(storage, A, NOW), '', raw);
    assert.equal(storage.map.has(DRAFT_PREFIX + A), false);
  }
});

test('a text longer than the field is cut to its limit', () => {
  const storage = memory();
  saveDraft(storage, A, 'a'.repeat(DRAFT_MAX + 50), NOW);
  assert.equal(loadDraft(storage, A, NOW).length, DRAFT_MAX);
});

test('pruning drops the old and malformed drafts of every conversation, and nothing else', () => {
  const storage = memory();
  saveDraft(storage, A, 'vecchia', NOW - DRAFT_TTL_MS - 1);
  saveDraft(storage, B, 'fresca', NOW - 1000);
  storage.map.set(`${DRAFT_PREFIX}non-un-id`, JSON.stringify({ text: 'x', at: NOW }));
  storage.map.set('arianna.layout', '{"sidebar":true}');
  assert.equal(pruneDrafts(storage, NOW), 2);
  assert.deepEqual([...storage.map.keys()].sort(), ['arianna.layout', DRAFT_PREFIX + B].sort());
});

test('a blocked or missing storage never throws: no draft, nothing kept', () => {
  assert.doesNotThrow(() => {
    saveDraft(refusing(), A, 'testo', NOW);
  });
  assert.equal(loadDraft(refusing(), A, NOW), '');
  assert.doesNotThrow(() => {
    removeDraft(refusing(), A);
  });
  assert.equal(pruneDrafts(refusing(), NOW), 0);
  assert.equal(loadDraft(undefined, A, NOW), '');
});

test('an incognito conversation keeps no draft (D-136); the others do', () => {
  assert.equal(keepsDraft({ incognito: true }), false);
  assert.equal(keepsDraft({ incognito: false }), true);
  assert.equal(keepsDraft({}), true);
});

const key = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test('on the Mac the model keys are Control and a digit; ⌘, ⌥ and Shift with it are not', () => {
  assert.equal(modelDigit(key('Digit1', { ctrlKey: true }), true), 1);
  assert.equal(modelDigit(key('Digit0', { ctrlKey: true }), true), 0);
  assert.equal(modelDigit(key('Numpad3', { ctrlKey: true }), true), 3);
  // ⌘1 switches the browser's tabs, ⌥5 types «~» on the Italian layout.
  assert.equal(modelDigit(key('Digit1', { metaKey: true }), true), undefined);
  assert.equal(modelDigit(key('Digit5', { altKey: true }), true), undefined);
  assert.equal(modelDigit(key('Digit1', { ctrlKey: true, shiftKey: true }), true), undefined);
  assert.equal(modelDigit(key('Digit1'), true), undefined);
  assert.equal(modelDigit(key('KeyK', { ctrlKey: true }), true), undefined);
  assert.equal(modelDigit(key('Digit1', { ctrlKey: true, isComposing: true }), true), undefined);
});

test('elsewhere the model keys are Alt+Shift and a digit; Ctrl or Alt alone are the browser’s', () => {
  assert.equal(modelDigit(key('Digit2', { altKey: true, shiftKey: true }), false), 2);
  assert.equal(modelDigit(key('Digit2', { ctrlKey: true }), false), undefined);
  assert.equal(modelDigit(key('Digit2', { altKey: true }), false), undefined);
  assert.equal(modelDigit(key('Digit2', { altKey: true, shiftKey: true, ctrlKey: true }), false), undefined);
  assert.equal(modelKeyText(2, false), 'Alt+Maiusc+2');
  assert.equal(modelKeyText(2, true), '⌃2');
});

test('a digit chooses only among the selector’s entries: 0 automatic, then its models in order', () => {
  const selectable = [{ model: 'claude-sonnet' }, { model: 'claude-opus' }];
  assert.deepEqual(modelForDigit(0, selectable), { model: null });
  assert.deepEqual(modelForDigit(1, selectable), { model: 'claude-sonnet' });
  assert.deepEqual(modelForDigit(2, selectable), { model: 'claude-opus' });
  assert.equal(modelForDigit(3, selectable), undefined);
  assert.equal(modelForDigit(1, []), undefined);
  assert.equal(modelForDigit(10, selectable), undefined);
  assert.equal(modelForDigit(-1, selectable), undefined);
});

const base: PlusOptions = { draft: '', mention: false, attachProject: null, session: false, save: false, mac: true };

test('the «+» menu always has the commands, and the rest only where it applies', () => {
  assert.deepEqual(plusEntries(base).map((entry) => entry.id), ['commands']);
  const all = plusEntries({ ...base, mention: true, attachProject: 'demo', session: true, save: true, saved: true });
  assert.deepEqual(all.map((entry) => entry.id), ['commands', 'mention', 'attach', 'session', 'save']);
  assert.equal(all.find((entry) => entry.id === 'save')?.text, 'Aggiorna in inbox');
  assert.equal(all.find((entry) => entry.id === 'attach')?.hint?.includes('demo'), true);
});

test('«/» and «@» from the menu only on an empty field: they never replace what is written', () => {
  const entries = plusEntries({ ...base, draft: 'una frase', mention: true });
  assert.equal(entries.find((entry) => entry.id === 'commands')?.disabled, true);
  assert.equal(entries.find((entry) => entry.id === 'mention')?.disabled, true);
  assert.equal(plusEntries({ ...base, draft: '  ', mention: true }).some((entry) => entry.disabled === true), false);
});

test('the models of the menu are the selector’s, with their keys and the chosen one checked', () => {
  const entries = plusEntries({
    ...base,
    selector: { autoText: 'automatico (router)', models: [{ model: 'claude-sonnet', text: 'Sonnet' }, { model: 'claude-opus', text: 'Opus' }], selected: 'claude-opus' },
  });
  const models = entries.filter((entry) => entry.action === 'model');
  assert.deepEqual(models.map((entry) => [entry.text, entry.keys, entry.checked]), [
    ['automatico (router)', '⌃0', false],
    ['Sonnet', '⌃1', false],
    ['Opus', '⌃2', true],
  ]);
  assert.equal(plusEntries(base).some((entry) => entry.action === 'model'), false);
});

test('beyond nine models the others are in the menu without a key', () => {
  const models = Array.from({ length: 11 }, (_, index) => ({ model: `m${String(index)}`, text: `M${String(index)}` }));
  const entries = plusEntries({ ...base, selector: { autoText: 'auto', models, selected: null } }).filter((entry) => entry.action === 'model');
  assert.equal(entries[9]?.keys, '⌃9');
  assert.equal(entries[10]?.keys, undefined);
  assert.equal(entries[0]?.checked, true);
});

test('the arrows skip the entries that cannot be chosen, and wrap', () => {
  const entries = plusEntries({ ...base, draft: 'testo', mention: true, save: true });
  // commands and mention are off: only «Salva in inbox» can be chosen.
  assert.equal(nextEnabled(entries, -1, 1), 2);
  assert.equal(nextEnabled(entries, 2, 1), 2);
  assert.equal(nextEnabled(entries, entries.length, -1), 2);
  const open = plusEntries({ ...base, mention: true, save: true });
  assert.equal(nextEnabled(open, 2, 1), 0);
  assert.equal(nextEnabled(open, 0, -1), 2);
  assert.equal(nextEnabled([], -1, 1), -1);
  assert.equal(nextEnabled(plusEntries({ ...base, draft: 'x' }), -1, 1), -1);
});

function manualTimers() {
  const queue: (() => void)[] = [];
  return {
    set: (run: () => void) => {
      queue.push(run);
      return queue.length;
    },
    clear: () => undefined,
    fire: () => {
      for (const run of queue.splice(0)) run();
    },
  };
}

test('the keeper gives each conversation its own text, through a switch and a reload', () => {
  const storage = memory();
  const keeper = draftKeeper(storage, () => NOW, manualTimers());
  assert.equal(keeper.open(A, true), '');
  keeper.write(A, 'testo di A');
  // Another conversation before the timer: the text of A is kept at once, never moved to B.
  assert.equal(keeper.open(B, true), '');
  assert.equal(loadDraft(storage, A, NOW), 'testo di A');
  assert.equal(loadDraft(storage, B, NOW), '');
  // A reload: a new keeper on the same storage.
  const again = draftKeeper(storage, () => NOW, manualTimers());
  assert.equal(again.open(A, true), 'testo di A');
});

test('the keeper writes after a pause, on flush, and removes the draft when the field is emptied', () => {
  const storage = memory();
  const timers = manualTimers();
  const keeper = draftKeeper(storage, () => NOW, timers);
  keeper.open(A, true);
  keeper.write(A, 'scrivo');
  assert.equal(storage.map.size, 0);
  timers.fire();
  assert.equal(loadDraft(storage, A, NOW), 'scrivo');
  keeper.write(A, '');
  keeper.flush();
  assert.equal(storage.map.size, 0);
});

test('opening a conversation never rewrites its draft, so a week counts from the last key', () => {
  const storage = memory();
  saveDraft(storage, A, 'vecchia', NOW - DRAFT_TTL_MS + 1000);
  const keeper = draftKeeper(storage, () => NOW, manualTimers());
  const text = keeper.open(A, true);
  keeper.write(A, text);
  keeper.flush();
  assert.equal((JSON.parse(storage.map.get(DRAFT_PREFIX + A) ?? '') as { at: number }).at, NOW - DRAFT_TTL_MS + 1000);
});

test('an incognito conversation writes nothing, and one found incognito later loses what it had; the others keep theirs', () => {
  const storage = memory();
  const keeper = draftKeeper(storage, () => NOW, manualTimers());
  keeper.open(A, true);
  keeper.write(A, 'di A');
  keeper.open(B, false);
  keeper.write(B, 'segreto');
  keeper.flush();
  assert.equal(loadDraft(storage, B, NOW), '');
  keeper.open(B, true);
  keeper.write(B, 'scritto prima di saperlo');
  keeper.flush();
  keeper.forget(B);
  keeper.write(B, 'ancora');
  keeper.flush();
  assert.equal(loadDraft(storage, B, NOW), '');
  assert.equal(loadDraft(storage, A, NOW), 'di A');
});

test('a refused message becomes the draft of its conversation, unless it has one or keeps none', () => {
  const storage = memory();
  assert.equal(keepRefused(storage, A, 'rifiutato', true, NOW), true);
  assert.equal(loadDraft(storage, A, NOW), 'rifiutato');
  assert.equal(keepRefused(storage, A, 'un altro', true, NOW), false);
  assert.equal(loadDraft(storage, A, NOW), 'rifiutato');
  assert.equal(keepRefused(storage, B, 'incognito', false, NOW), false);
  assert.equal(keepRefused(storage, B, '  ', true, NOW), false);
  assert.equal(keepRefused(refusing(), B, 'testo', true, NOW), false);
  assert.equal(loadDraft(storage, B, NOW), '');
});
