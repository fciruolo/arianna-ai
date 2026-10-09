// The diary of the works (I-15, D-147): entries written by the code in
// Workplan/diario of the project's knowledge, with the label of the work or of
// the folder Workplan when higher, never through a link, found by the search.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createContext, createLabelRules } from '@arianna/policy';

import { createKb } from '../src/orchestrator/kb.ts';
import { createProjectPages, KnowledgeError, readProjectKnowledge } from '../src/project-knowledge.ts';
import { DIARY_MAX_BYTES, formatWorkEntry, writeWorkDiary, type WorkEntry } from '../src/work-diary.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `work-diary-${randomUUID()}`);
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
// One git: the notes go to kb/progetti/<name>, never into the code (D-145).
write(join(HOME, 'repos', 'demo'), { '.git/HEAD': 'ref: refs/heads/main\n', 'README.md': '# Demo\n' });
// A container with a part and a private folder (fake data only).
write(join(HOME, 'repos', 'cantiere'), {
  'cantiere-sito/.git/HEAD': 'ref: refs/heads/main\n',
  'documenti/compenso.md': '# Compenso finto: 4242 euro\n',
});
const project = (name: string, extra: Partial<Project> = {}): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1', ...extra });
const DEMO = project('demo');
const CANTIERE = project('cantiere');

const AT = new Date(2026, 9, 9, 14, 32, 5);
/** An entry; a field given as undefined is left out. */
function entry(extra: { [K in keyof WorkEntry]?: WorkEntry[K] | undefined } = {}): WorkEntry {
  const full = {
    at: AT,
    agent: 'coder',
    executor: 'claude',
    alias: 'sonnet',
    model: 'claude-sonnet-4-5',
    project: 'demo',
    part: null,
    outcome: 'ok',
    request: 'Aggiungi una riga al README.',
    files: [
      { path: 'README.md', change: 'modified' },
      { path: 'docs/nuovo.md', change: 'renamed', from: 'docs/vecchio.md' },
    ],
    commit: 'a1b2c3d4e5f6',
    report: 'Ho aggiunto la riga.',
    conversationUrl: 'http://127.0.0.1:7420/c/0b7c1f9e-2d3a-4c5b-8e6f-7a8b9c0d1e2f',
    label: 'L1',
    ...extra,
  };
  return Object.fromEntries(Object.entries(full).filter(([, value]) => value !== undefined)) as unknown as WorkEntry;
}

describe('the entry', () => {
  it('says time, who on what, part, outcome, request, files, commit, report and the link', () => {
    const text = formatWorkEntry(entry());
    assert.match(text, /^\n## 14:32 · Coder · Claude Sonnet \(claude-sonnet-4-5\) · riuscito\n/);
    assert.match(text, /- Parte: tutto il progetto\n/);
    assert.match(text, /- Commit: `a1b2c3d4e5f6`\n/);
    assert.match(text, /- Conversazione: \[apri in Arianna\]\(http:\/\/127\.0\.0\.1:7420\/c\/0b7c1f9e-2d3a-4c5b-8e6f-7a8b9c0d1e2f\)\n/);
    assert.match(text, /### Richiesta\n\n```text\nAggiungi una riga al README\.\n```\n/);
    assert.match(text, /- `README\.md` \(modificato\)\n- `docs\/nuovo\.md` \(rinominato da `docs\/vecchio\.md`\)\n/);
    assert.match(text, /### Riassunto di Coder\n\n```text\nHo aggiunto la riga\.\n```\n/);
  });

  it('a request that did not leave is not written; a failed or stopped work says why', () => {
    const failed = formatWorkEntry(entry({ outcome: 'failed', reason: 'il gateway ha fermato la richiesta', request: undefined, files: undefined, report: undefined, commit: undefined }));
    assert.match(failed, /· non riuscito\n/);
    assert.match(failed, /- Esito: non riuscito \(il gateway ha fermato la richiesta\)\n/);
    assert.match(failed, /Non è uscita/);
    assert.match(failed, /### File cambiati\n\nNon letti\./);
    assert.doesNotMatch(failed, /Riassunto|Commit/);
    assert.match(formatWorkEntry(entry({ outcome: 'stopped', reason: 'limite di tempo del compito' })), /· fermato\n/);
  });

  it('the text of the cloud never renders: no fence of it closes the block, no link or embed outside it', () => {
    const report = 'Fatto.\n```\n![](http://esempio.invalid/x.png)\n````\n![[documenti/compenso]]';
    const text = formatWorkEntry(entry({ report, request: 'una `riga`' }));
    assert.match(text, /`````text\nFatto\.\n```\n!\[\]\(http:\/\/esempio\.invalid\/x\.png\)\n````\n!\[\[documenti\/compenso\]\]\n`````/);
    // Everything of the report sits inside the five-backtick fence.
    const outside = text.replace(/`````text\n[\s\S]*?\n`````/, '');
    assert.doesNotMatch(outside, /esempio\.invalid|compenso/);
    // A link that is not the chat's address is left out.
    assert.doesNotMatch(formatWorkEntry(entry({ conversationUrl: 'https://esempio.invalid/c/x' })), /Conversazione/);
  });
});

describe('the diary file', () => {
  it('one git: kb/progetti/<name>/Workplan/diario/<day>.md, created with the header of the code, then appended', () => {
    const first = writeWorkDiary([DEMO], 'demo', ENV, entry());
    assert.deepEqual(first, { path: 'Workplan/diario/2026-10-09.md', label: 'L1' });
    const file = join(ARIANNA, 'kb', 'progetti', 'demo', 'Workplan', 'diario', '2026-10-09.md');
    const second = writeWorkDiary([DEMO], 'demo', ENV, entry({ at: new Date(2026, 9, 9, 15, 0), executor: 'codex', alias: 'sol', model: undefined, outcome: 'failed', reason: 'codex: exit' }));
    assert.equal(second.path, first.path);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^---\nlabel: L1\nsource: diary:demo\ncaptured_at: 2026-10-09T14:32:05[+-]\d\d:\d\d\nkind: diary\nproject: demo\ntitle: "Diario dei lavori del 2026-10-09"\n---\n\n/);
    assert.match(text, /## 14:32 · Coder · Claude Sonnet[^\n]*· riuscito[\s\S]*## 15:00 · Coder · Codex Sol · non riuscito/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Never in the code of the project.
    assert.ok(!existsSync(join(HOME, 'repos', 'demo', 'Workplan')));
  });

  it('a container: in its Workplan, created when missing, never in a part', () => {
    const written = writeWorkDiary([CANTIERE], 'cantiere', ENV, entry({ project: 'cantiere', part: 'cantiere-sito' }));
    assert.deepEqual(written, { path: 'Workplan/diario/2026-10-09.md', label: 'L1' });
    assert.ok(lstatSync(join(HOME, 'repos', 'cantiere', 'Workplan', 'diario', '2026-10-09.md')).isFile());
    assert.match(readFileSync(join(HOME, 'repos', 'cantiere', 'Workplan', 'diario', '2026-10-09.md'), 'utf8'), /- Parte: `cantiere-sito`/);
    assert.deepEqual(readdirSync(join(HOME, 'repos', 'cantiere', 'cantiere-sito')), ['.git']);
  });

  it('an existing workplan keeps its letter case', () => {
    write(join(HOME, 'repos', 'minuscolo'), { 'parte/.git/HEAD': 'x\n', 'workplan/piano.md': '# Piano\n' });
    const written = writeWorkDiary([project('minuscolo')], 'minuscolo', ENV, entry());
    assert.equal(written.path, 'workplan/diario/2026-10-09.md');
    assert.deepEqual(readdirSync(join(HOME, 'repos', 'minuscolo')).sort(), ['parte', 'workplan']);
  });

  it('Workplan raised by the user: the entry takes the label of the folder, in a file of its own label', () => {
    const raised = project('alzato', { folders: [{ path: 'Workplan', label: 'L2' }] });
    write(join(HOME, 'repos', 'alzato'), { 'parte/.git/HEAD': 'x\n', 'Workplan/piano.md': '# Piano\n' });
    assert.deepEqual(writeWorkDiary([raised], 'alzato', ENV, entry()), { path: 'Workplan/diario/2026-10-09.md', label: 'L2' });
    assert.match(readFileSync(join(HOME, 'repos', 'alzato', 'Workplan', 'diario', '2026-10-09.md'), 'utf8'), /^---\nlabel: L2\n/);
    // Lowered again to L0: an L0 entry never goes in the L2 file, nor makes it lower.
    const lowered = { ...raised, folders: [{ path: 'Workplan', label: 'L0' as const }] };
    assert.deepEqual(writeWorkDiary([lowered], 'alzato', ENV, entry({ label: 'L0' })), { path: 'Workplan/diario/2026-10-09-2.md', label: 'L0' });
    assert.match(readFileSync(join(HOME, 'repos', 'alzato', 'Workplan', 'diario', '2026-10-09.md'), 'utf8'), /^---\nlabel: L2\n/);
  });

  it('a work above L1 never has an entry: nothing of it went to the cloud', () => {
    for (const label of ['L2', 'L3'] as const) {
      assert.throws(() => writeWorkDiary([DEMO], 'demo', ENV, entry({ label, at: new Date(2026, 9, 10) })), (error: unknown) => error instanceof KnowledgeError && error.code === 'refused');
    }
    assert.ok(!existsSync(join(ARIANNA, 'kb', 'progetti', 'demo', 'Workplan', 'diario', '2026-10-10.md')));
  });

  it('a full day file: the next entry goes to the next file of the day', () => {
    write(join(HOME, 'repos', 'pieno'), { 'parte/.git/HEAD': 'x\n' });
    const pieno = project('pieno');
    writeWorkDiary([pieno], 'pieno', ENV, entry());
    const file = join(HOME, 'repos', 'pieno', 'Workplan', 'diario', '2026-10-09.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}${'x'.repeat(DIARY_MAX_BYTES)}`);
    assert.equal(writeWorkDiary([pieno], 'pieno', ENV, entry()).path, 'Workplan/diario/2026-10-09-2.md');
  });

  it('links are refused, never followed: the day file, the diary folder, Workplan, kb/progetti/<name>', () => {
    const outside = join(HOME, 'fuori');
    write(outside, { 'bersaglio.md': '---\nlabel: L1\n---\n' });
    mkdirSync(join(outside, 'cartella'), { recursive: true });
    const refused = (error: unknown): boolean => error instanceof KnowledgeError && (error.code === 'refused' || error.code === 'invalid');

    write(join(HOME, 'repos', 'link-file'), { 'parte/.git/HEAD': 'x\n' });
    mkdirSync(join(HOME, 'repos', 'link-file', 'Workplan', 'diario'), { recursive: true });
    symlinkSync(join(outside, 'bersaglio.md'), join(HOME, 'repos', 'link-file', 'Workplan', 'diario', '2026-10-09.md'));
    assert.throws(() => writeWorkDiary([project('link-file')], 'link-file', ENV, entry()), refused);

    write(join(HOME, 'repos', 'link-diario'), { 'parte/.git/HEAD': 'x\n', 'Workplan/piano.md': '# Piano\n' });
    symlinkSync(join(outside, 'cartella'), join(HOME, 'repos', 'link-diario', 'Workplan', 'diario'));
    assert.throws(() => writeWorkDiary([project('link-diario')], 'link-diario', ENV, entry()), refused);

    write(join(HOME, 'repos', 'link-workplan'), { 'parte/.git/HEAD': 'x\n' });
    symlinkSync(join(outside, 'cartella'), join(HOME, 'repos', 'link-workplan', 'Workplan'));
    assert.throws(() => writeWorkDiary([project('link-workplan')], 'link-workplan', ENV, entry()), refused);

    write(join(HOME, 'repos', 'link-kb'), { '.git/HEAD': 'x\n' });
    mkdirSync(join(ARIANNA, 'kb', 'progetti'), { recursive: true });
    symlinkSync(join(outside, 'cartella'), join(ARIANNA, 'kb', 'progetti', 'link-kb'));
    assert.throws(() => writeWorkDiary([project('link-kb')], 'link-kb', ENV, entry()), refused);

    assert.equal(readFileSync(join(outside, 'bersaglio.md'), 'utf8'), '---\nlabel: L1\n---\n');
    assert.deepEqual(readdirSync(join(outside, 'cartella')), []);
  });

  it('a part named Workplan is code: the diary is not written there', () => {
    write(join(HOME, 'repos', 'parte-workplan'), { 'Workplan/.git/HEAD': 'x\n' });
    assert.throws(() => writeWorkDiary([project('parte-workplan')], 'parte-workplan', ENV, entry()), KnowledgeError);
    assert.deepEqual(readdirSync(join(HOME, 'repos', 'parte-workplan', 'Workplan')), ['.git']);
  });
});

describe('the diary in the knowledge of Arianna', () => {
  it('the tab Conoscenza lists the day file as a note of Workplan; kb.search finds it at its label', () => {
    const knowledge = readProjectKnowledge([DEMO], 'demo', ENV);
    const note = knowledge.notes.find((item) => item.path === 'Workplan/diario/2026-10-09.md');
    assert.deepEqual(note, { folder: 'Workplan', path: 'Workplan/diario/2026-10-09.md', title: 'Diario dei lavori del 2026-10-09', label: 'L1' });

    const kb = createKb({ home: ARIANNA, rules: RULES, projects: createProjectPages(() => [DEMO], ENV) });
    const found = kb.search('Aggiungi riga README', createContext('L1'), 20);
    assert.ok(found.hits.some((hit) => hit.path === 'projects/demo/Workplan/diario/2026-10-09.md' && hit.label === 'L1'));
    // Below its label the search does not show it.
    const below = kb.search('Aggiungi riga README', createContext('L0'), 20);
    assert.ok(!below.hits.some((hit) => hit.path.includes('diario')));
    assert.equal(below.skippedAbove, true);
  });
});
