// The summary of the week of the diary of the works (I-15 D2, D-177): written
// by the code from the day files of the week alone, written again at each
// entry, robust to day files written by hand, never through a link.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createContext, createLabelRules } from '@arianna/policy';

import { createKb } from '../src/orchestrator/kb.ts';
import { createProjectPages, KnowledgeError, readProjectKnowledge } from '../src/project-knowledge.ts';
import { formatWorkEntry, writeWorkDiary, type WorkEntry } from '../src/work-diary.ts';
import { isoWeek, parseDiaryDay, weekDays, weekFileName, writeWeekSummary } from '../src/work-diary-week.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `work-diary-week-${randomUUID()}`);
const ARIANNA = join(HOME, 'arianna');
const RULES = createLabelRules({ folders: [], sources: [] });
const ENV = { home: ARIANNA, rules: RULES };
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const project = (name: string, extra: Partial<Project> = {}): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1', ...extra });
/** A container with one part (fake data only). */
function container(name: string, extra: Partial<Project> = {}): Project {
  write(join(HOME, 'repos', name), { 'sito/.git/HEAD': 'ref: refs/heads/main\n', 'documenti/compenso.md': '# Compenso finto: 4242 euro\n' });
  return project(name, extra);
}
const diary = (name: string): string => join(HOME, 'repos', name, 'Workplan', 'diario');

/** An entry; a field given as undefined is left out. */
function entry(extra: { [K in keyof WorkEntry]?: WorkEntry[K] | undefined } = {}): WorkEntry {
  const full = {
    at: new Date(2026, 9, 9, 14, 32),
    agent: 'coder',
    executor: 'claude',
    alias: 'sonnet',
    model: 'claude-sonnet-4-5',
    project: 'p',
    part: 'sito',
    outcome: 'ok',
    request: 'Aggiungi una riga al README.\nSeconda riga.',
    files: [
      { path: 'README.md', change: 'modified' },
      { path: 'src/app.ts', change: 'added' },
    ],
    report: 'Ho aggiunto la riga.',
    label: 'L1',
    ...extra,
  };
  return Object.fromEntries(Object.entries(full).filter(([, value]) => value !== undefined)) as unknown as WorkEntry;
}

describe('the ISO week', () => {
  it('numbers the week from Monday, across the turn of the year', () => {
    assert.deepEqual(isoWeek(new Date(2026, 9, 9)), { year: 2026, week: 41 });
    assert.deepEqual(isoWeek(new Date(2026, 9, 11, 23, 59)), { year: 2026, week: 41 });
    assert.deepEqual(isoWeek(new Date(2026, 9, 12, 0, 1)), { year: 2026, week: 42 });
    assert.deepEqual(isoWeek(new Date(2021, 0, 1)), { year: 2020, week: 53 });
    assert.deepEqual(isoWeek(new Date(2024, 11, 30)), { year: 2025, week: 1 });
    assert.equal(weekFileName(new Date(2025, 0, 2)), 'settimana-2025-W01.md');
    assert.deepEqual(weekDays(new Date(2026, 9, 11)), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  });
});

describe('reading a day file', () => {
  it('reads time, agent, runner, outcome, part, files and the first line of the request', () => {
    const text = `---\nlabel: L1\n---\n${formatWorkEntry(entry())}${formatWorkEntry(entry({ at: new Date(2026, 9, 9, 16, 5), outcome: 'failed', part: null, request: undefined, files: undefined, executor: 'codex', alias: 'sol', model: undefined }))}`;
    const works = parseDiaryDay(text, '2026-10-09', '2026-10-09');
    assert.equal(works.length, 2);
    assert.deepEqual(works[0], {
      day: '2026-10-09',
      file: '2026-10-09',
      time: '14:32',
      agent: 'Coder',
      runner: 'Claude Sonnet (claude-sonnet-4-5)',
      outcome: 'ok',
      part: 'sito',
      fileCount: 2,
      files: ['README.md', 'src/app.ts'],
      request: 'Aggiungi una riga al README.',
    });
    assert.deepEqual(works[1], { day: '2026-10-09', file: '2026-10-09', time: '16:05', agent: 'Coder', runner: 'Codex Sol', outcome: 'failed', part: null, files: [] });
  });

  it('a heading inside a text of the cloud is not a work; lines it does not understand are skipped', () => {
    const report = '## 09:00 · Finto · riuscito\n### File cambiati (1)\n- `segreto.md` (aggiunto)';
    const text = `# Note a mano\n\n## Una sezione mia\n- Parte: \`x\`\n## 25:99 · Ora · riuscito\nriga qualsiasi\n${formatWorkEntry(entry({ report, request: report }))}\n## 18:00 · Scritto a mano · fermato\n- Parte: senza codice\n### File cambiati (abc)\n- \`non contato.md\` (x)\n\`\`\`text\nmai chiuso\n## 19:00 · Dentro · riuscito`;
    const works = parseDiaryDay(text, '2026-10-09', '2026-10-09');
    assert.deepEqual(
      works.map((work) => [work.time, work.agent, work.outcome]),
      [
        ['14:32', 'Coder', 'ok'],
        ['18:00', 'Scritto a mano', 'stopped'],
      ],
    );
    assert.deepEqual(works[0]?.files, ['README.md', 'src/app.ts']);
    assert.equal(works.at(0)?.request, '## 09:00 · Finto · riuscito');
    assert.equal(works[1]?.part, undefined);
    assert.deepEqual(works[1]?.files, []);
  });
});

describe('the summary of the week', () => {
  it('written next to the days, from the works of that week only: totals, one line per work, files most changed', () => {
    const p = container('p');
    writeWorkDiary([p], 'p', ENV, entry({ at: new Date(2026, 9, 4, 10, 0), request: 'Lavoro della settimana prima.' }));
    writeWorkDiary([p], 'p', ENV, entry());
    writeWorkDiary([p], 'p', ENV, entry({ at: new Date(2026, 9, 9, 16, 5), outcome: 'failed', reason: 'codex: exit', executor: 'codex', alias: 'sol', model: undefined, files: [{ path: 'README.md', change: 'modified' }] }));
    writeWorkDiary([p], 'p', ENV, entry({ at: new Date(2026, 9, 11, 9, 0), outcome: 'stopped', part: null, request: undefined, files: undefined }));

    const written = writeWeekSummary([p], 'p', ENV, new Date(2026, 9, 11, 9, 0));
    assert.deepEqual(written, { path: 'Workplan/diario/settimana-2026-W41.md', label: 'L1' });
    const file = join(diary('p'), 'settimana-2026-W41.md');
    const text = readFileSync(file, 'utf8');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(text, /^---\nlabel: L1\nsource: diary:p\ncaptured_at: [^\n]+\nkind: diary\nproject: p\ntitle: "Diario dei lavori della settimana 2026-W41"\n---\n\n/);
    assert.match(text, /da lun 5 ottobre a dom 11 ottobre 2026/);
    assert.match(text, /- Lavori: 3 \(1 riuscito, 1 non riuscito, 1 fermato\)\n/);
    assert.match(text, /### Per agente\n\n- Coder: 3\n/);
    assert.match(text, /### Per esecutore e modello\n\n- Claude Sonnet \(claude-sonnet-4-5\): 2\n- Codex Sol: 1\n/);
    assert.match(text, /### Per parte\n\n- `sito`: 2\n- tutto il progetto: 1\n/);
    assert.match(text, /- \[\[2026-10-09\|ven 9 ottobre, 14:32\]\] · Coder · Claude Sonnet \(claude-sonnet-4-5\) · riuscito · parte `sito` · 2 file · `Aggiungi una riga al README\.`\n/);
    assert.match(text, /- \[\[2026-10-11\|dom 11 ottobre, 09:00\]\] · Coder · Claude Sonnet \(claude-sonnet-4-5\) · fermato · tutto il progetto\n/);
    assert.match(text, /## File cambiati più spesso\n\n- `README\.md`: 2 lavori\n- `src\/app\.ts`: 1 lavoro\n/);
    // Only the week: the work of the 4th is in W40, and no text of the reports here.
    assert.doesNotMatch(text, /settimana prima|Ho aggiunto|codex: exit/);
    assert.deepEqual(readdirSync(diary('p')).sort(), ['2026-10-04.md', '2026-10-09.md', '2026-10-11.md', 'settimana-2026-W41.md']);

    // Written again at the next entry: still one file, now with four works... of which three in the week.
    writeWorkDiary([p], 'p', ENV, entry({ at: new Date(2026, 9, 11, 11, 0) }));
    writeWeekSummary([p], 'p', ENV, new Date(2026, 9, 11, 11, 0));
    assert.match(readFileSync(file, 'utf8'), /- Lavori: 4 \(2 riusciti, 1 non riuscito, 1 fermato\)\n/);
    assert.equal(readdirSync(diary('p')).filter((name) => name.startsWith('settimana-') || name.startsWith('.')).length, 1);
    // Idempotent: the same days give the same summary but for the time it was written.
    const strip = (value: string): string => value.replace(/captured_at: [^\n]+/, '');
    const once = strip(readFileSync(file, 'utf8'));
    writeWeekSummary([p], 'p', ENV, new Date(2026, 9, 6));
    assert.equal(strip(readFileSync(file, 'utf8')), once);
  });

  it('a day written by hand or broken is skipped, never fails the summary; a day above the diary stays out', () => {
    const p = container('rotto');
    writeWorkDiary([p], 'rotto', ENV, entry({ project: 'rotto' }));
    write(diary('rotto'), {
      '2026-10-06.md': 'appunti miei senza intestazione\n## non è una voce\n```\nmai chiuso\n',
      '2026-10-07.md': '---\nlabel: L3\n---\n\n## 10:00 · Segreto · riuscito\n- Parte: `segreta`\n',
      '2026-10-08.md': '---\nlabel: [rotto\n',
      '2026-10-30.md': '---\nlabel: L1\n---\n\n## 10:00 · Fuori settimana · riuscito\n',
      'note.md': '## 10:00 · Non un giorno · riuscito\n',
    });
    const written = writeWeekSummary([p], 'rotto', ENV, new Date(2026, 9, 9));
    assert.deepEqual(written, { path: 'Workplan/diario/settimana-2026-W41.md', label: 'L1' });
    const text = readFileSync(join(diary('rotto'), 'settimana-2026-W41.md'), 'utf8');
    assert.match(text, /- Lavori: 1 \(1 riuscito\)\n/);
    assert.doesNotMatch(text, /Segreto|segreta|Fuori settimana|Non un giorno/);
    assert.match(text, /File del diario lasciati fuori \(non leggibili o con un'etichetta più alta\): 2\.\n/);
  });

  it('nothing in the summary renders from a heading written by hand: no embed, no link', () => {
    const p = container('iniezione');
    write(diary('iniezione'), {
      '2026-10-08.md': '---\nlabel: L1\n---\n\n## 10:00 · ![[documenti/compenso]] · [x](http://esempio.invalid/a.png) · riuscito\n- Parte: `` a`b ``\n',
    });
    writeWeekSummary([p], 'iniezione', ENV, new Date(2026, 9, 8));
    const text = readFileSync(join(diary('iniezione'), 'settimana-2026-W41.md'), 'utf8');
    assert.doesNotMatch(text, /!\[|\[\[documenti|\]\(/);
    assert.match(text, /parte ``a`b``/);
  });

  it('Workplan raised by the user: the summary takes its label; a label raised in its header stays', () => {
    const raised = container('alzato', { folders: [{ path: 'Workplan', label: 'L2' }] });
    writeWorkDiary([raised], 'alzato', ENV, entry({ project: 'alzato' }));
    assert.deepEqual(writeWeekSummary([raised], 'alzato', ENV, new Date(2026, 9, 9)), { path: 'Workplan/diario/settimana-2026-W41.md', label: 'L2' });

    const p = container('a-mano');
    writeWorkDiary([p], 'a-mano', ENV, entry({ project: 'a-mano' }));
    writeWeekSummary([p], 'a-mano', ENV, new Date(2026, 9, 9));
    const file = join(diary('a-mano'), 'settimana-2026-W41.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('label: L1', 'label: L2'));
    assert.equal(writeWeekSummary([p], 'a-mano', ENV, new Date(2026, 9, 9))?.label, 'L2');
    assert.match(readFileSync(file, 'utf8'), /^---\nlabel: L2\n/);
  });

  it('no diary or no work in the week: nothing written', () => {
    const p = container('vuoto');
    assert.equal(writeWeekSummary([p], 'vuoto', ENV, new Date(2026, 9, 9)), null);
    writeWorkDiary([p], 'vuoto', ENV, entry({ project: 'vuoto' }));
    assert.equal(writeWeekSummary([p], 'vuoto', ENV, new Date(2026, 9, 20)), null);
    assert.ok(!existsSync(join(diary('vuoto'), 'settimana-2026-W43.md')));
  });

  it('links are never followed: a day as a link is not read, the summary as a link is refused and its target untouched', () => {
    const outside = join(HOME, 'fuori');
    write(outside, { 'giorno.md': '---\nlabel: L1\n---\n\n## 10:00 · Fuori · riuscito\n', 'bersaglio.md': 'intatto\n' });

    const p = container('link');
    writeWorkDiary([p], 'link', ENV, entry({ project: 'link' }));
    symlinkSync(join(outside, 'giorno.md'), join(diary('link'), '2026-10-07.md'));
    writeWeekSummary([p], 'link', ENV, new Date(2026, 9, 9));
    assert.doesNotMatch(readFileSync(join(diary('link'), 'settimana-2026-W41.md'), 'utf8'), /Fuori/);

    const q = container('link-riepilogo');
    writeWorkDiary([q], 'link-riepilogo', ENV, entry({ project: 'link-riepilogo' }));
    symlinkSync(join(outside, 'bersaglio.md'), join(diary('link-riepilogo'), 'settimana-2026-W41.md'));
    assert.throws(() => writeWeekSummary([q], 'link-riepilogo', ENV, new Date(2026, 9, 9)), (error: unknown) => error instanceof KnowledgeError && error.code === 'refused');
    assert.equal(readFileSync(join(outside, 'bersaglio.md'), 'utf8'), 'intatto\n');
    assert.deepEqual(readdirSync(diary('link-riepilogo')).sort(), ['2026-10-09.md', 'settimana-2026-W41.md']);

    const r = container('link-diario');
    write(join(HOME, 'repos', 'link-diario'), { 'Workplan/piano.md': '# Piano\n' });
    mkdirSync(join(outside, 'cartella'), { recursive: true });
    write(join(outside, 'cartella'), { '2026-10-09.md': '---\nlabel: L1\n---\n\n## 10:00 · Fuori · riuscito\n' });
    symlinkSync(join(outside, 'cartella'), diary('link-diario'));
    assert.equal(writeWeekSummary([r], 'link-diario', ENV, new Date(2026, 9, 9)), null);
    assert.deepEqual(readdirSync(join(outside, 'cartella')), ['2026-10-09.md']);
  });
});

describe('the summary in the knowledge of Arianna', () => {
  it('the tab Conoscenza lists it as a note of Workplan; kb.search finds it at its label', () => {
    const demo = project('demo');
    write(join(HOME, 'repos', 'demo'), { '.git/HEAD': 'ref: refs/heads/main\n' });
    writeWorkDiary([demo], 'demo', ENV, entry({ project: 'demo', part: null, files: [{ path: 'zibaldone.md', change: 'added' }] }));
    assert.deepEqual(writeWeekSummary([demo], 'demo', ENV, new Date(2026, 9, 9)), { path: 'Workplan/diario/settimana-2026-W41.md', label: 'L1' });
    assert.ok(existsSync(join(ARIANNA, 'kb', 'progetti', 'demo', 'Workplan', 'diario', 'settimana-2026-W41.md')));

    const knowledge = readProjectKnowledge([demo], 'demo', ENV);
    const note = knowledge.notes.find((item) => item.path === 'Workplan/diario/settimana-2026-W41.md');
    assert.deepEqual(note, { folder: 'Workplan', path: 'Workplan/diario/settimana-2026-W41.md', title: 'Diario dei lavori della settimana 2026-W41', label: 'L1' });

    const kb = createKb({ home: ARIANNA, rules: RULES, projects: createProjectPages(() => [demo], ENV) });
    const found = kb.search('settimana zibaldone', createContext('L1'), 20);
    assert.ok(found.hits.some((hit) => hit.path === 'projects/demo/Workplan/diario/settimana-2026-W41.md' && hit.label === 'L1'));
    assert.ok(!kb.search('settimana zibaldone', createContext('L0'), 20).hits.some((hit) => hit.path.includes('settimana')));
  });
});
