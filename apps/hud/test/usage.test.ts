import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveSection } from '../src/lib/settings-index.ts';
import {
  averageText,
  bytesText,
  difficultyText,
  exitText,
  isEmpty,
  kindText,
  localityText,
  modelTitle,
  outcomeText,
  secondsText,
  sinceText,
  tokensText,
  type UsageReport,
} from '../src/lib/usage.ts';

test('«Consumi» is a section of the settings at /impostazioni/consumi (D-093)', () => {
  const chosen = resolveSection('consumi');
  assert.equal(chosen.item.id, 'usage');
  assert.equal(chosen.item.behaviour, 'read');
});

test('a model reads as executor and model, with the names the chat already uses', () => {
  assert.equal(modelTitle({ executor: 'claude', model: 'sonnet' }), 'Claude Code · Claude Sonnet');
  assert.equal(modelTitle({ executor: 'local', model: 'qwen3.8-27b-4bit' }), 'modello locale · qwen3.8-27b-4bit');
  assert.equal(modelTitle({ executor: 'codex', model: null }), 'Codex');
  assert.equal(modelTitle({ executor: 'unassigned', model: null }), 'Deleghe non ancora assegnate');
  assert.equal(localityText(null), '');
  assert.equal(localityText('local'), 'sul Mac');
});

test('kinds, difficulties and destinations in Italian; an unknown one stays as it is', () => {
  assert.equal(kindText('conversation'), 'Conversazioni');
  assert.equal(kindText('finance'), 'Finanze');
  assert.equal(kindText('altro'), 'altro');
  assert.equal(difficultyText('hard'), 'Difficile');
  assert.equal(exitText({ targetKind: 'executor', target: 'claude' }), 'Claude Code');
  assert.equal(exitText({ targetKind: 'web', target: 'web-search' }), 'Ricerca sul web');
  assert.equal(exitText({ targetKind: 'link', target: 'link-click' }), 'Link scaricati da te');
  assert.equal(exitText({ targetKind: 'link', target: 'link-list' }), 'Link dei siti approvati');
});

test('times, sizes, tokens and outcomes as the table shows them', () => {
  assert.equal(secondsText(42.4), '42 s');
  assert.equal(secondsText(125), '2 min 5 s');
  assert.equal(secondsText(4800), '1 h 20 min');
  assert.equal(averageText({ runs: 0, seconds: 0 }), '—');
  assert.equal(averageText({ runs: 4, seconds: 40 }), '10 s');
  assert.equal(bytesText(0), '0 B');
  assert.equal(bytesText(640), '640 B');
  assert.equal(bytesText(1250), '1,3 kB');
  assert.equal(bytesText(3_400_000), '3,4 MB');
  assert.equal(tokensText({ tokensIn: null, tokensOut: null }), '—');
  assert.equal(tokensText({ tokensIn: 15000, tokensOut: 300 }), '15.000 → 300');
  assert.equal(outcomeText({ ok: 9, failed: 1, stopped: 2, running: 0 }), '9 ok · 1 fallito · 2 fermati');
  assert.equal(outcomeText({ ok: 0, failed: 3, stopped: 0, running: 1 }), '0 ok · 3 falliti · 1 in corso');
});

const EMPTY: UsageReport = {
  period: 'today',
  since: '2026-10-13T22:00:00.000Z',
  totals: { runs: 0, steps: 0, seconds: 0, delegations: 0, cloudExits: 0, blocked: 0, failures: 0, advice: 0 },
  models: [],
  agents: [],
  kinds: [],
  difficulties: [],
  exits: [],
  failures: [],
};

test('a period with nothing says so; a blocked exit alone is not nothing', () => {
  assert.equal(isEmpty(EMPTY), true);
  assert.equal(isEmpty({ ...EMPTY, exits: [{ targetKind: 'executor', target: 'claude', locality: 'cloud', allowed: 0, blocked: 1, bytes: 0 }] }), false);
  assert.equal(sinceText(EMPTY), 'da mezzanotte');
  assert.match(sinceText({ period: '7d', since: '2026-10-07T10:00:00.000Z' }), /^dal 7 ottobre$/);
});
