// «Pronta per i dati veri» (D-192): the answer of the core checked, and its texts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { missingText, parseReadiness, READINESS_IDS, READINESS_TEXT, readinessRows, terminalText, whenText, type ReadinessReport } from '../src/lib/installation.ts';

const NOW = new Date(2026, 9, 13, 11, 0);
const at = (day: number, hour: number, minute: number): string => new Date(2026, 9, day, hour, minute).toISOString();

test('the answer of the core: null before the first check, undefined when unexpected', () => {
  assert.equal(parseReadiness({ readiness: null }), null);
  for (const bad of [null, {}, { readiness: 3 }, { readiness: { ready: 'yes', checkedAt: at(13, 10, 12), checks: [], terminal: null } }, { readiness: { ready: true, checkedAt: 'ieri', checks: [], terminal: null } }, { readiness: { ready: true, checkedAt: at(13, 10, 12), checks: [{ id: 'models', ok: 1 }], terminal: null } }, { readiness: { ready: true, checkedAt: at(13, 10, 12), checks: [], terminal: { at: 'x', ok: true } } }]) {
    assert.equal(parseReadiness(bad), undefined, JSON.stringify(bad));
  }
});

test('ready only when every check and the terminal passed, whatever the core says', () => {
  const terminal = { at: at(12, 18, 40), ok: true };
  const report = (ready: boolean, checks: { id: string; ok: boolean }[], last: typeof terminal | null) => parseReadiness({ readiness: { ready, checkedAt: at(13, 10, 12), checks, terminal: last } });
  assert.equal(report(true, [{ id: 'models', ok: true }], terminal)?.ready, true);
  assert.equal(report(true, [{ id: 'models', ok: false }], terminal)?.ready, false);
  assert.equal(report(true, [{ id: 'models', ok: true }], null)?.ready, false);
  assert.equal(report(true, [{ id: 'models', ok: true }], { ...terminal, ok: false })?.ready, false);
  // An id the page does not know is never hidden: it counts under «Altri controlli».
  const unknown = report(true, [{ id: 'brand-new', ok: false }], terminal);
  assert.deepEqual(unknown?.checks, [{ id: 'other', ok: false }]);
  assert.equal(unknown.ready, false);
});

test('every check has a name, a line when it passes and what to do, with no word of code but the commands', () => {
  for (const id of READINESS_IDS) {
    const text = READINESS_TEXT[id];
    assert.ok(text.title.length > 0 && text.ok.length > 0 && text.fix.length > 0, id);
    assert.doesNotMatch(`${text.title} ${text.ok} ${text.fix}`, /nucleo|core|\bL[0-3]\b|database\.|\.ts\b/i, id);
  }
});

test('when, in the words of the page', () => {
  assert.equal(whenText(at(13, 10, 12), NOW), 'oggi alle 10:12');
  assert.equal(whenText(at(12, 18, 2), NOW), 'ieri alle 18:02');
  assert.equal(whenText(at(3, 9, 5), NOW), 'il 3 ottobre alle 09:05');
  assert.equal(whenText(new Date(2025, 11, 31, 23, 0).toISOString(), NOW), 'il 31 dicembre 2025 alle 23:00');
});

test('the terminal: never run, passed, not passed', () => {
  assert.match(terminalText(null, NOW), /non l’ha ancora fatto.*pnpm arianna:doctor/);
  assert.equal(terminalText({ at: at(12, 18, 40), ok: true }, NOW), 'Lo controlla solo il Terminale: ultimo esito a posto, ieri alle 18:40.');
  assert.match(terminalText({ at: at(12, 18, 40), ok: false }, NOW), /non era a posto/);
});

test('rows: what is missing first, the terminal last among them; what passed apart', () => {
  const report: ReadinessReport = {
    ready: false,
    checkedAt: at(13, 10, 12),
    checks: [
      { id: 'passwords', ok: false },
      { id: 'folders', ok: true },
      { id: 'models', ok: false },
    ],
    terminal: null,
  };
  const { missing, passed } = readinessRows(report, NOW);
  assert.deepEqual(
    missing.map((row) => [row.key, row.tone]),
    [
      ['passwords', 'missing'],
      ['models', 'missing'],
      ['terminal', 'terminal'],
    ],
  );
  assert.equal(missing[0]?.text, READINESS_TEXT.passwords.fix);
  assert.deepEqual(
    passed.map((row) => [row.key, row.text]),
    [['folders', READINESS_TEXT.folders.ok]],
  );
  const done = readinessRows({ ...report, checks: [{ id: 'folders', ok: true }], terminal: { at: at(12, 18, 40), ok: true } }, NOW);
  assert.deepEqual(done.missing, []);
  assert.deepEqual(
    done.passed.map((row) => row.key),
    ['folders', 'terminal'],
  );
  assert.equal(missingText(1), 'Manca 1 cosa');
  assert.equal(missingText(3), 'Mancano 3 cose');
});
