// The knowledge of a project (I-11, D-145, tappa P2): the labels of the
// management folders and of their notes, "+ Conoscenza", the search of
// Arianna, and the Coder kept out of a single-git container with private notes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createContext, createLabelRules } from '@arianna/policy';

import { listPageIds } from '../src/knowledge.ts';
import { createKb, KbError } from '../src/orchestrator/kb.ts';
import { createProjectPages, knowledgeRules, KnowledgeError, privateKnowledge, readProjectKnowledge, writeProjectNote } from '../src/project-knowledge.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `knowledge-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto-test');
const ONE = join(HOME, 'repos', 'un-git');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// A container with two git parts and its management folders (fake data only).
write(BOX, {
  'Workplan/piano.md': '---\ntitle: Piano di maggio\n---\n\nRilascio del portale clienti a fine mese.\n',
  'Workplan/compensi.md': '---\nlabel: L2\ntitle: Compensi\n---\n\nPreventivo finto per il portale clienti: 1000 euro.\n',
  'Workplan/abbassata.md': '---\nlabel: L0\n---\n\nUna nota che vorrebbe scendere: resta Interna, portale clienti.\n',
  'IM/riunione.md': '# Riunione\n\nIl portale clienti va in prova.\n',
  'documenti/contratto.md': '# Contratto finto\n\nCliente Rossi Srl, portale clienti.\n',
  'documenti/schema.png': 'non un testo\n',
  'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n',
  'progetto-test-admin/src/a.ts': 'x\n',
  'progetto-test-client/.git/HEAD': 'ref: refs/heads/main\n',
});
const OUTSIDE = join(HOME, 'fuori');
write(OUTSIDE, { 'segreto.md': '---\nlabel: L0\n---\nfuori dal progetto, portale clienti\n' });
symlinkSync(join(OUTSIDE, 'segreto.md'), join(BOX, 'Workplan', 'collegata.md'));
symlinkSync(OUTSIDE, join(BOX, 'Workplan', 'cartella-collegata'));

const box: Project = { name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' };
const PROJECTS = [box];
const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const ENV = { home: ARIANNA, rules: createLabelRules({ folders: [{ path: 'kb/work', label: 'L1' }], sources: [] }) };

describe('labels of folders and notes', () => {
  it('Workplan and IM Interne, documenti Privata; a header raises, never lowers; links are not notes', () => {
    const knowledge = readProjectKnowledge(PROJECTS, 'progetto-test', ENV);
    assert.deepEqual(knowledge.folders.map(({ path, label }) => [path, label]), [['documenti', 'L2'], ['IM', 'L1'], ['Workplan', 'L1']]);
    assert.deepEqual(
      knowledge.notes.map(({ path, label, title }) => [path, label, title]),
      [
        ['documenti/contratto.md', 'L2', 'contratto'],
        ['IM/riunione.md', 'L1', 'riunione'],
        ['Workplan/abbassata.md', 'L1', 'abbassata'],
        ['Workplan/compensi.md', 'L2', 'Compensi'],
        ['Workplan/piano.md', 'L1', 'Piano di maggio'],
      ],
    );
  });

  it('the label the user gave a folder counts, also when it lowers it; the header of a note still raises', () => {
    const relabeled: Project = { ...box, folders: [{ path: 'documenti', label: 'L1' }, { path: 'Workplan', label: 'L3' }] };
    const knowledge = readProjectKnowledge([relabeled], 'progetto-test', ENV);
    const labels = Object.fromEntries(knowledge.notes.map(({ path, label }) => [path, label]));
    assert.equal(labels['documenti/contratto.md'], 'L1');
    assert.equal(labels['Workplan/piano.md'], 'L3');
    assert.equal(labels['Workplan/abbassata.md'], 'L3');
  });

  it('a project that is not approved is not read', () => {
    assert.throws(() => readProjectKnowledge(PROJECTS, 'altro', ENV), (error) => error instanceof KnowledgeError && error.code === 'not-found');
  });
});

describe('"+ Conoscenza"', () => {
  const NOW = new Date(2026, 9, 9, 10, 30, 0);
  const note = (extra: Partial<Parameters<typeof writeProjectNote>[3]> = {}) =>
    writeProjectNote(PROJECTS, 'progetto-test', ENV, { folder: 'Workplan', title: 'Nuova milestone', text: 'Consegna finta il 20.', label: 'L1', id: randomUUID(), now: NOW, ...extra });

  it('writes the header from the code; the text cannot change the label; never over a file', () => {
    const first = note({ text: '---\nlabel: L0\n---\nprovo a scendere' });
    assert.deepEqual(first, { path: 'Workplan/2026-10-09-103000-nuova-milestone.md', label: 'L1' });
    const content = readFileSync(join(BOX, first.path), 'utf8');
    assert.match(content, /^---\nlabel: L1\nsource: capture:hud:[0-9a-f-]+\ncaptured_at: 2026-10-09T10:30:00[+-]\d\d:\d\d\nkind: note\nproject: progetto-test\ntitle: "Nuova milestone"\n---\n\n---\nlabel: L0/);
    const second = note();
    assert.equal(second.path, 'Workplan/2026-10-09-103000-nuova-milestone-2.md');
    const listed = readProjectKnowledge(PROJECTS, 'progetto-test', ENV).notes.find((item) => item.path === first.path);
    assert.equal(listed?.label, 'L1');
  });

  it('the user may raise the label of a note, never put it below its folder', () => {
    assert.equal(note({ folder: 'Workplan', label: 'L3', title: 'Fattura' }).label, 'L3');
    assert.throws(() => note({ folder: 'documenti', label: 'L1' }), (error) => error instanceof KnowledgeError && error.code === 'invalid' && /cannot be lower/.test(error.message));
  });

  it('refuses a folder that is not a management folder: a part, a path, a hidden one', () => {
    for (const folder of ['progetto-test-admin', '../fuori', 'Workplan/sotto', '.git', 'mancante']) {
      assert.throws(() => note({ folder }), (error) => error instanceof KnowledgeError && error.code === 'invalid', folder);
    }
  });

  it('refuses a note through a symbolic link: a folder that became a link writes nothing', () => {
    const linked = join(HOME, 'repos', 'collegato');
    write(linked, { 'IM/.keep': '' });
    write(join(HOME, 'altrove'), { 'x.md': 'x\n' });
    rmSync(join(linked, 'IM'), { recursive: true });
    symlinkSync(join(HOME, 'altrove'), join(linked, 'IM'));
    const project: Project = { name: 'collegato', path: 'repos/collegato', absolute: linked, label: 'L1', folders: [{ path: 'IM', label: 'L1' }] };
    assert.throws(() => writeProjectNote([project], 'collegato', ENV, { folder: 'IM', title: 'Nota', text: 'testo', label: 'L1', id: 'x1', now: NOW }));
    assert.deepEqual(readdirSync(join(HOME, 'altrove')), ['x.md']);
  });

  it('refuses an empty text, a title on more lines, a label that is not one', () => {
    assert.throws(() => note({ text: '   ' }), KnowledgeError);
    assert.throws(() => note({ title: 'uno\ndue' }), KnowledgeError);
    assert.throws(() => note({ label: 'L9' as 'L1' }), KnowledgeError);
  });
});

describe('the search of Arianna (kb.search, kb.read)', () => {
  const kbHome = join(HOME, 'arianna');
  write(kbHome, { 'kb/work/portale.md': '# Portale\n\nIl portale clienti in kb.\n' });
  const rules = createLabelRules({ folders: [{ path: 'kb/work', label: 'L1' }], sources: [] });
  const kb = createKb({ home: kbHome, rules, projects: createProjectPages(() => PROJECTS, ENV) });

  it('finds the notes of the projects with their effective label; a work conversation does not see the private ones', () => {
    const work = kb.search('portale clienti', createContext('L1'), 20);
    const paths = work.hits.map((hit) => hit.path);
    assert.ok(paths.includes('projects/progetto-test/Workplan/piano.md'));
    assert.ok(paths.includes('projects/progetto-test/IM/riunione.md'));
    assert.ok(paths.includes('kb/work/portale.md'));
    assert.ok(!paths.some((path) => path.includes('compensi') || path.includes('contratto') || path.includes('collegata')));
    assert.ok(work.hits.every((hit) => hit.label === 'L1'));
    assert.equal(work.skippedAbove, true);

    const personal = kb.search('portale clienti', createContext('L2'), 20);
    const labels = Object.fromEntries(personal.hits.map((hit) => [hit.path, hit.label]));
    assert.equal(labels['projects/progetto-test/Workplan/compensi.md'], 'L2');
    assert.equal(labels['projects/progetto-test/documenti/contratto.md'], 'L2');
    assert.equal(labels['projects/progetto-test/Workplan/abbassata.md'], 'L1');
  });

  it('reads a note within the clearance; above it, a link or a path out of the folders is refused', () => {
    assert.equal(kb.read('projects/progetto-test/Workplan/piano.md', createContext('L1')).label, 'L1');
    assert.throws(() => kb.read('projects/progetto-test/Workplan/compensi.md', createContext('L1')), (error) => error instanceof KbError && error.code === 'above-clearance');
    assert.throws(() => kb.read('projects/progetto-test/documenti/contratto.md', createContext('L1')), (error) => error instanceof KbError && error.code === 'above-clearance');
    assert.equal(kb.read('projects/progetto-test/documenti/contratto.md', createContext('L2')).label, 'L2');
    assert.throws(() => kb.read('projects/progetto-test/Workplan/collegata.md', createContext('L2')), (error) => error instanceof KbError && error.code === 'not-found');
    assert.throws(() => kb.read('projects/progetto-test/progetto-test-admin/src/a.md', createContext('L2')), KbError);
    assert.throws(() => kb.read('projects/progetto-test/Workplan/../../fuori/segreto.md', createContext('L2')), KbError);
    assert.throws(() => kb.read('projects/altro/Workplan/piano.md', createContext('L1')), (error) => error instanceof KbError && error.code === 'above-clearance');
  });

  it('a note found by the search is read with the same path, also in a folder with brackets in its name', () => {
    write(BOX, { 'IM (2024)/verbale.MD': '# Verbale\n\nportale clienti, verbale finto.\n' });
    const hit = kb.search('verbale', createContext('L2'), 20).hits.find((item) => item.path.includes('verbale'));
    assert.equal(hit?.path, 'projects/progetto-test/IM (2024)/verbale.MD');
    assert.equal(kb.read(hit.path, createContext('L2')).label, 'L2');
    rmSync(join(BOX, 'IM (2024)'), { recursive: true });
  });

  it('kb.write never writes in a project: only kb/inbox', () => {
    assert.throws(() => kb.write('projects/progetto-test/Workplan/nuova.md', 'testo', 'L1', 'task:x'), (error) => error instanceof KbError && error.code === 'invalid-path');
  });
});

describe('a container that is one git (D-145)', () => {
  write(ONE, { '.git/HEAD': 'ref: refs/heads/main\n', 'src/a.ts': 'x\n', 'Workplan/piano.md': 'piano\n' });
  const one: Project = { name: 'un-git', path: 'repos/un-git', absolute: ONE, label: 'L1' };

  it('only notes up to Interno: the Coder may open it', () => {
    assert.deepEqual(privateKnowledge(one), []);
  });

  it('a private note in its management folders keeps the Coder out, also inside Workplan by its header', () => {
    write(ONE, { 'Workplan/compenso.md': '---\nlabel: L2\n---\nfinto\n' });
    assert.deepEqual(privateKnowledge(one), ['Workplan/compenso.md']);
    rmSync(join(ONE, 'Workplan', 'compenso.md'));
    write(ONE, { 'documenti/contratto.txt': 'finto\n' });
    assert.deepEqual(privateKnowledge(one), ['documenti/contratto.txt']);
    // A choice of [[project.folder]] is for kb/progetti: it never lowers a folder inside the repository (D-145, point 8).
    assert.deepEqual(privateKnowledge({ ...one, folders: [{ path: 'documenti', label: 'L1' }] }), ['documenti/contratto.txt']);
    rmSync(join(ONE, 'documenti'), { recursive: true });
  });

  it('a hidden note counts, and a folder too deep to look into keeps the Coder out (what is not seen is not L1)', () => {
    write(ONE, { 'Workplan/.bozza.md': '---\nlabel: L3\n---\nfinto\n', 'Workplan/.DS_Store': 'x' });
    assert.deepEqual(privateKnowledge(one), ['Workplan/.bozza.md']);
    rmSync(join(ONE, 'Workplan', '.bozza.md'));
    write(ONE, { 'Workplan/a/b/c/d/e/f/g/nota.md': 'profonda\n' });
    assert.deepEqual(privateKnowledge(one), ['Workplan/a/b/c/d/e/f']);
    rmSync(join(ONE, 'Workplan', 'a'), { recursive: true });
    // Two folders differing only by case (a case-sensitive disk): one rule, the higher label; no exception.
    const rules = knowledgeRules([
      { path: 'Docs', label: 'L1', defaultLabel: 'L2', chosen: true },
      { path: 'docs', label: 'L3', defaultLabel: 'L2', chosen: true },
    ]);
    assert.deepEqual(rules.folders, [{ path: 'Docs', label: 'L3' }]);
  });
});

describe('a project that is one git keeps its notes in kb/progetti/<project> (D-145)', () => {
  const DEMO = join(HOME, 'repos', 'demo');
  write(DEMO, { '.git/HEAD': 'ref: refs/heads/main\n', 'index.html': '<h1>demo</h1>\n' });
  const demo: Project = { name: 'demo', path: 'repos/demo', absolute: DEMO, label: 'L1' };
  const NOW = new Date(2026, 9, 9, 11, 0, 0);
  const note = (folder: string, label: 'L0' | 'L1' | 'L2' | 'L3', project: Project = demo) =>
    writeProjectNote([project], project.name, ENV, { folder, title: 'Appunto', text: 'Il sito demo usa colori finti.', label, id: randomUUID(), now: NOW });

  it('without notes: no folder, nothing created by reading, where it would go', () => {
    const knowledge = readProjectKnowledge([demo], 'demo', ENV);
    assert.deepEqual([knowledge.inKb, knowledge.where, knowledge.folders, knowledge.notes], [true, 'kb/progetti/demo', [], []]);
    assert.equal(existsSync(join(ARIANNA, 'kb', 'progetti')), false);
  });

  it('"+ Conoscenza" creates kb/progetti/demo/<folder>, never in the repository; labels by name; search finds it', () => {
    assert.equal(note('Workplan', 'L1').label, 'L1');
    assert.ok(existsSync(join(ARIANNA, 'kb', 'progetti', 'demo', 'Workplan')));
    assert.ok(!existsSync(join(DEMO, 'Workplan')));
    // A new folder that is not Workplan nor IM is Privata: an Interna note in it is refused, a Privata one goes.
    assert.throws(() => note('Clienti', 'L1'), (error) => error instanceof KnowledgeError && /cannot be lower/.test(error.message));
    assert.equal(note('Clienti', 'L2').label, 'L2');
    const knowledge = readProjectKnowledge([demo], 'demo', ENV);
    assert.deepEqual(knowledge.folders.map(({ path, label }) => [path, label]), [['Clienti', 'L2'], ['Workplan', 'L1']]);
    assert.deepEqual(knowledge.notes.map(({ label }) => label), ['L2', 'L1']);
    const kb = createKb({ home: ARIANNA, rules: ENV.rules, projects: createProjectPages(() => [demo], ENV) });
    const work = kb.search('colori finti', createContext('L1'), 20).hits.map((hit) => hit.path);
    assert.deepEqual(work, ['projects/demo/Workplan/2026-10-09-110000-appunto.md'], 'kb/progetti is not searched again as kb/ with another label');
    assert.equal(kb.read('projects/demo/Clienti/2026-10-09-110000-appunto.md', createContext('L2')).label, 'L2');
    // The notes outside the repository never keep the Coder out.
    assert.deepEqual(privateKnowledge(demo), []);
    // The graph and the search of the chat list kb/ without kb/progetti: those notes are the projects', never twice.
    assert.ok(!listPageIds(join(ARIANNA, 'kb')).some((id) => id.startsWith('progetti/')));
    // Read as a page of kb/ it never takes the lower label of the project's folder: labels.toml, L2 without a rule.
    assert.equal(kb.read('kb/progetti/demo/Workplan/2026-10-09-110000-appunto.md', createContext('L2')).label, 'L2');
    assert.throws(() => kb.read('kb/progetti/demo/Workplan/2026-10-09-110000-appunto.md', createContext('L1')), KbError);
  });

  it('a rule of labels.toml over kb/progetti only raises; the user lowering a folder by the settings counts', () => {
    const strict = { ...ENV, rules: createLabelRules({ folders: [{ path: 'kb/progetti', label: 'L3' }], sources: [] }) };
    assert.deepEqual(readProjectKnowledge([demo], 'demo', strict).folders.map(({ label }) => label), ['L3', 'L3']);
    const lowered: Project = { ...demo, folders: [{ path: 'Clienti', label: 'L1' }] };
    assert.equal(readProjectKnowledge([lowered], 'demo', ENV).folders[0]?.label, 'L1');
  });

  it('refuses a folder name that is a path or hidden, and kb/progetti/<project> through a link', () => {
    for (const folder of ['../fuori', 'a/b', '.nascosta', '']) assert.throws(() => note(folder, 'L2'), KnowledgeError, folder);
    const other: Project = { name: 'altro-git', path: 'repos/altro-git', absolute: join(HOME, 'repos', 'altro-git'), label: 'L1' };
    write(other.absolute, { '.git/HEAD': 'x\n' });
    write(join(HOME, 'altrove-kb'), { 'x.md': 'x\n' });
    symlinkSync(join(HOME, 'altrove-kb'), join(ARIANNA, 'kb', 'progetti', 'altro-git'));
    assert.throws(() => note('Workplan', 'L2', other), (error) => error instanceof KnowledgeError && error.code === 'refused');
    assert.throws(() => readProjectKnowledge([other], 'altro-git', ENV), KnowledgeError);
    assert.deepEqual(readdirSync(join(HOME, 'altrove-kb')), ['x.md']);
  });
});

it('kb/progetti that is a link: nothing read nor written through it (D-145)', () => {
  const home = join(HOME, 'arianna-link');
  write(home, { 'kb/work/x.md': 'x\n' });
  write(join(HOME, 'altrove-progetti'), { 'demo/Workplan/x.md': 'x\n' });
  symlinkSync(join(HOME, 'altrove-progetti'), join(home, 'kb', 'progetti'));
  const env = { home, rules: createLabelRules({ folders: [], sources: [] }) };
  const demo: Project = { name: 'demo', path: 'repos/demo', absolute: join(HOME, 'repos', 'demo'), label: 'L1' };
  assert.throws(() => readProjectKnowledge([demo], 'demo', env), (error) => error instanceof KnowledgeError && error.code === 'refused');
  assert.throws(() => writeProjectNote([demo], 'demo', env, { folder: 'Workplan', title: 'X', text: 'x', label: 'L2', id: 'l1' }), KnowledgeError);
  assert.deepEqual(readdirSync(join(HOME, 'altrove-progetti', 'demo', 'Workplan')), ['x.md']);
  assert.deepEqual(createProjectPages(() => [demo], env).list(), []);
});

describe('a container without management folders (D-145)', () => {
  const EMPTY = join(HOME, 'repos', 'vuoto');
  write(EMPTY, { 'vuoto-sito/.git/HEAD': 'x\n', 'vuoto-sito/a.ts': 'x\n' });
  const empty: Project = { name: 'vuoto', path: 'repos/vuoto', absolute: EMPTY, label: 'L1' };

  it('a new folder is created in the container, never a part nor a folder that exists as something else', () => {
    assert.deepEqual(readProjectKnowledge([empty], 'vuoto', ENV).folders, []);
    const written = writeProjectNote([empty], 'vuoto', ENV, { folder: 'IM', title: 'Chiamata', text: 'Chiamata finta.', label: 'L1', id: 'n1' });
    assert.equal(written.path.startsWith('IM/'), true);
    assert.ok(existsSync(join(EMPTY, written.path)));
    for (const folder of ['vuoto-sito', 'VUOTO-SITO', 'node_modules', 'im']) {
      assert.throws(() => writeProjectNote([empty], 'vuoto', ENV, { folder, title: 'X', text: 'x', label: 'L3', id: 'n2' }), KnowledgeError, folder);
    }
    assert.deepEqual(readdirSync(join(EMPTY, 'vuoto-sito')).sort(), ['.git', 'a.ts']);
    assert.ok(!existsSync(join(EMPTY, 'node_modules')), 'a refused folder is never created');
  });
});
