import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DOSSIER_INTRO, godDossier, read, section } from '../src/god/dossier.ts';
import { godDossierPart } from '../src/orchestrator/delegate.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function clone(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arianna-dossier-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

const HANDOFF = [
  '# Consegna fra conversazioni',
  '',
  'Aggiornato: oggi.',
  '',
  '**2026-10-11, 10:00: lavoro finto X unito in main come 0.9.0.** Prossimo: Y.',
  '',
  '**2026-10-10, 22:00: lavoro finto W.**',
  '',
  '## Dove siamo',
  '',
  '- **Fase 1A in corso:** task finti.',
  '- Altro.',
  '',
  '## In attesa dell\'utente',
  '',
  '| Cosa | Note |',
  '| --- | --- |',
  '| (storico) **Vecchia** | chiusa |',
  '| **Prova del lavoro X** | da provare nel browser |',
  '',
  '## Prossimi passi, in ordine',
  '',
  '1. Niente.',
].join('\n');

const DECISIONS = [
  '| Id | Data | Decisione | Motivo | Stato |',
  '| --- | --- | --- | --- | --- |',
  ...Array.from({ length: 12 }, (_, index) => `| D-${String(100 + index)} | 2026-10-0${String(index % 9)} | **Decisione finta ${String(index)}.** Testo lungo. | motivo | Accettata |`),
].join('\n');

test('the dossier takes the latest state, what waits for the user and the latest decisions', () => {
  const dir = clone({
    'docs/HANDOFF.md': HANDOFF,
    'docs/DECISIONS.md': DECISIONS,
    'docs/ROADMAP.md': '| Fase | Obiettivo | Ore | Criterio di uscita (manuale) |\n| --- | --- | --- | --- |\n| 0 Fondamenta | Repo | 1 | check verde |\n| **Totale** | | 9 | x |\n',
    'docs/PHASE-0-1-TASKS.md': '| Id | Task | Ore | Reali | Fatto quando |\n| --- | --- | --- | --- | --- |\n| 1.1 | Finito | 1 | 0,5 | x |\n| 1.2 | Aperto | 1 |  | x |\n| 1.3 | In corso | 1 | 2 finora | x |\n',
  });
  const text = godDossier(dir) ?? '';
  assert.ok(text.startsWith(DOSSIER_INTRO));
  assert.match(text, /lavoro finto X unito/);
  assert.match(text, /Fase 1A in corso/);
  assert.match(text, /Prova del lavoro X/);
  assert.doesNotMatch(text, /Vecchia/, 'closed rows marked "(storico)" stay out');
  // The last ten decisions, by title only.
  assert.match(text, /D-111 \(2026-10-02\): Decisione finta 11\./);
  assert.doesNotMatch(text, /D-101 /);
  assert.doesNotMatch(text, /Testo lungo/);
  assert.match(text, /0 Fondamenta: Repo \(uscita: check verde\)/);
  assert.doesNotMatch(text, /Totale/);
  // Open tasks: no real hours, or "finora".
  assert.match(text, /1\.2 Aperto/);
  assert.match(text, /1\.3 In corso/);
  assert.doesNotMatch(text, /1\.1 Finito/);
});

test('the dossier stays within its ceiling, and is absent without documents', () => {
  const dir = clone({ 'docs/HANDOFF.md': HANDOFF, 'docs/DECISIONS.md': DECISIONS });
  const short = godDossier(dir, 600) ?? '';
  assert.ok(short.length <= 600);
  assert.match(short, /lavoro finto X/, 'the first section first');
  assert.equal(godDossier(clone({})), undefined);
});

test('section reads a level-2 heading by the start of its title', () => {
  assert.deepEqual(section('## Uno\na\n## Due\nb\nc', 'due'), ['b', 'c']);
  assert.deepEqual(section('# Titolo\n', 'Uno'), []);
});

test('only a run on the container of Arianna\'s clones reads the dossier, at the project\'s label', () => {
  const dir = clone({ 'docs/HANDOFF.md': HANDOFF });
  const part = godDossierPart('arianna', dir, 'L1');
  assert.ok(part !== undefined);
  assert.equal(part.label, 'L1');
  assert.equal(part.source, 'god:dossier:arianna');
  assert.equal(godDossierPart('demo', dir, 'L1'), undefined);
  assert.equal(godDossierPart('arianna', '', 'L1'), undefined);
});

test('a link of the clone towards a file outside it is never read: the cloud writes the clones', () => {
  const outside = clone({ 'docs/HANDOFF.md': '**Nota privata finta: non deve uscire.**\n' });
  const dir = clone({});
  symlinkSync(join(outside, 'docs', 'HANDOFF.md'), join(dir, 'docs', 'HANDOFF.md'));
  assert.equal(read(dir, 'docs/HANDOFF.md'), undefined);
  assert.equal(godDossier(dir), undefined);
  // docs/ itself a link: the same.
  const other = clone({});
  rmSync(join(other, 'docs'), { recursive: true });
  symlinkSync(join(outside, 'docs'), join(other, 'docs'));
  assert.equal(godDossier(other), undefined);
  // A link that stays inside the clone is fine.
  writeFileSync(join(dir, 'docs', 'real.md'), '**Stato finto.**\n');
  symlinkSync(join(dir, 'docs', 'real.md'), join(dir, 'docs', 'DECISIONS.md'));
  assert.equal(read(dir, 'docs/DECISIONS.md'), '**Stato finto.**\n');
});
