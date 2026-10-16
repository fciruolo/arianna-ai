// «Cosa è cambiato» (D-233): the words of each change, the kind and its link, the days and the filter.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHANGE_GROUPS, changeDays, changeText, dayTitle, groupCounts, groupOf, sectionOfArea, sinceText, themeName, type Change, type ChangeArea, type ChangesReport } from '../src/lib/changes.ts';
import { resolveSection } from '../src/lib/settings-index.ts';

const NOW = new Date(2026, 9, 16, 18, 0, 0);

test('every kind of change has words, an icon and a section of the settings that exists', () => {
  const areas: ChangeArea[] = ['arianna', 'role', 'model', 'executor', 'cloud-model', 'cloud-name', 'binary', 'skills', 'design', 'agents-catalog', 'agent', 'project', 'theme', 'character'];
  for (const area of areas) {
    const { slug } = sectionOfArea(area);
    assert.equal(resolveSection(slug).explicit, true, `${area} → ${slug}`);
    for (const [from, to] of [
      [null, 'x1'],
      ['x1', null],
      ['x1', 'x2'],
    ] as const) {
      const text = changeText({ area, id: 'orchestrator', from, to });
      assert.ok(text.title.length > 0);
      assert.doesNotMatch(text.title, /undefined|null/);
      assert.doesNotMatch(text.detail ?? '', /undefined|null/);
    }
  }
  assert.equal(resolveSection('cosa-e-cambiato').item.id, 'changes');
  assert.equal(CHANGE_GROUPS.length, new Set(CHANGE_GROUPS.map((group) => group.id)).size);
});

test('the words say what happened, in plain Italian', () => {
  assert.deepEqual(changeText({ area: 'role', id: 'orchestrator', from: 'qwen-a', to: 'qwen-b' }), { title: 'Nuovo modello per «Ragiona e risponde in chat»', detail: 'qwen-a → qwen-b' });
  assert.equal(changeText({ area: 'model', id: 'qwen-b', from: 'in-catalog', to: 'on-disk' }).title, 'Modello sul Mac: qwen-b');
  assert.equal(changeText({ area: 'model', id: 'qwen-b', from: null, to: 'in-catalog' }).title, 'Modello nuovo nel catalogo: qwen-b');
  assert.equal(changeText({ area: 'executor', id: 'codex', from: null, to: 'on' }).title, 'Codex acceso');
  assert.equal(changeText({ area: 'executor', id: 'claude', from: 'on', to: null }).title, 'Claude Code spento');
  assert.deepEqual(changeText({ area: 'binary', id: 'claude', from: '2.1.288', to: '2.1.300' }), { title: 'Claude Code aggiornato alla 2.1.300', detail: 'prima 2.1.288' });
  assert.deepEqual(changeText({ area: 'skills', id: 'anthropics/skills', from: 'aaaaaaa', to: 'bbbbbbb' }), {
    title: 'Skill di anthropics/skills: nuova versione in uso',
    detail: 'versione bbbbbbb, prima versione aaaaaaa',
  });
  assert.equal(changeText({ area: 'skills', id: 'anthropics/skills', from: null, to: '-' }).detail, 'nessuna versione in uso');
  assert.deepEqual(changeText({ area: 'project', id: 'demo', from: 'L1', to: 'L0' }), { title: 'Progetto demo: etichetta cambiata', detail: 'Interno → Pubblico' });
  assert.equal(changeText({ area: 'arianna', id: 'arianna', from: '0.120.0', to: '0.121.0' }).title, 'Arianna aggiornata alla 0.121.0');
  assert.equal(groupOf('agents-catalog').id, 'agents');
  assert.equal(sectionOfArea('agents-catalog').href, '/impostazioni/catalogo-agenti');
  assert.equal(sectionOfArea('binary').href, '/impostazioni/claude-e-codex');
});

function report(entries: { at: Date; changes: Change[]; more?: number }[]): ChangesReport {
  return { since: new Date(2026, 9, 1, 9, 5).toISOString(), truncated: false, entries: entries.map((entry, index) => ({ id: String(100 - index), at: entry.at.toISOString(), changes: entry.changes, more: entry.more ?? 0 })) };
}

test('the rows go by local day, most recent first, and the filter keeps one kind', () => {
  const data = report([
    { at: new Date(2026, 9, 16, 9, 30), changes: [{ area: 'theme', id: 'theme', from: 'base', to: 'halloween' }, { area: 'model', id: 'qwen', from: null, to: 'on-disk' }] },
    { at: new Date(2026, 9, 16, 8, 0), changes: [{ area: 'executor', id: 'claude', from: null, to: 'on' }] },
    { at: new Date(2026, 9, 15, 22, 0), changes: [{ area: 'role', id: 'extractor', from: 'a', to: 'b' }], more: 4 },
    { at: new Date(2026, 9, 14, 12, 0), changes: [{ area: 'project', id: 'demo', from: null, to: 'L1' }] },
  ]);
  const all = changeDays(data, null, NOW);
  assert.deepEqual(
    all.map((day) => [day.title, day.rows.length, day.more]),
    [
      ['Oggi', 3, 0],
      ['Ieri', 1, 4],
      ['mercoledì 14 ottobre', 1, 0],
    ],
  );
  const models = changeDays(data, 'models', NOW);
  assert.deepEqual(
    models.map((day) => day.rows.map((row) => row.area)),
    [['model'], ['role']],
  );
  // The changes left out by the core belong to no kind: only the whole list counts them.
  assert.equal(models[1]?.more, 0);
  assert.deepEqual(groupCounts(data), { models: 2, cloud: 1, skills: 0, agents: 0, projects: 1, appearance: 1, arianna: 0 });
});

test('the days and «Osservo da»', () => {
  assert.equal(dayTitle(new Date(2025, 11, 31, 10), NOW), 'mercoledì 31 dicembre 2025');
  assert.equal(sinceText(report([]), NOW), 'Osservo i cambiamenti da giovedì 1 ottobre, alle 09:05.');
  assert.match(sinceText({ since: null, entries: [], truncated: false }, NOW), /non ha ancora/);
});

test('a theme by the name the user sees, never its id in the code', () => {
  assert.equal(themeName('corsia'), 'Scrubs');
  assert.equal(themeName('ufficio'), 'The Office');
  assert.equal(themeName('springfield'), 'I Simpson');
  assert.equal(themeName('quahog'), 'I Griffin');
  assert.equal(themeName('langley'), 'American Dad');
  assert.equal(themeName('fox-river'), 'Prison Break');
  assert.equal(themeName('planet-express'), 'Futurama');
  assert.equal(themeName('pasadena'), 'The Big Bang Theory');
  assert.equal(themeName('base'), 'Base');
  assert.equal(themeName('halloween'), 'halloween');
  assert.deepEqual(changeText({ area: 'theme', id: 'theme', from: 'base', to: 'corsia' }), { title: 'Tema cambiato: Scrubs', detail: 'prima Base' });
  assert.deepEqual(changeText({ area: 'theme', id: 'theme', from: 'corsia', to: 'ufficio' }), { title: 'Tema cambiato: The Office', detail: 'prima Scrubs' });
});
