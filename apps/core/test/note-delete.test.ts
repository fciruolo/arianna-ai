// "Elimina" of a note (D-157): the notes of kb/ (Pensieri and Conoscenza) and
// those of a project go from the disk for good; nothing else is ever reached.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseLabelRules, resolveHome, type Project } from '@arianna/config';

import { buildKnowledgeGraph } from '../src/knowledge.ts';
import { DELETED_LINK, deleteKbPage } from '../src/note-delete.ts';
import { NoteError } from '../src/notes.ts';
import { unlinkPlainFile } from '../src/plain-file.ts';
import { deleteProjectNote, KnowledgeError, readProjectKnowledge } from '../src/project-knowledge.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `note-delete-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules('[[folder]]\npath = "kb/segreti"\nlabel = "L3"\n');

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A home with kb/ (fake notes), a documents folder of development, and a file outside kb/. */
function home(): string {
  const dir = join(scratch, randomUUID());
  write(dir, {
    'kb/inbox/2026-10-05-0812-pane.md': '---\nlabel: L2\nstatus: new\n---\n\nComprare il pane finto.\n',
    'kb/inbox/2026-10-05-0900-spesa.md':
      '---\nlabel: L2\nstatus: organized\ntitle: "Spesa"\n---\n\n## Riassunto\n\nVedi [[inbox/2026-10-05-0812-pane]] e [[inbox/2026-10-05-0812-pane|il pane]].\n\nAnche [[altro/idea]].\n',
    'kb/altro/idea.md': '---\ntitle: Idea finta\n---\n\nUn’idea finta, collegata a [[inbox/2026-10-05-0812-pane]].\n',
    'kb/segreti/chiave.md': '# Segreto finto\n',
    'docs/SPEC.md': '# Documento di sviluppo finto\n',
    'fuori.md': '# Fuori da kb\n',
  });
  return dir;
}

function refused(error: unknown): boolean {
  return (error instanceof NoteError || error instanceof KnowledgeError) && error.code === 'not-found';
}

describe('a note of kb/', () => {
  it('a thought of the inbox goes from the disk and from the graph; the links to it in the inbox become words', () => {
    const dir = home();
    assert.ok(buildKnowledgeGraph(dir, RULES).nodes.some((node) => node.id === 'inbox/2026-10-05-0812-pane.md'));
    const deleted = deleteKbPage(dir, RULES, 'inbox/2026-10-05-0812-pane.md');
    assert.deepEqual(deleted, { where: 'inbox', path: 'kb/inbox/2026-10-05-0812-pane.md' });
    assert.equal(existsSync(join(dir, 'kb', 'inbox', '2026-10-05-0812-pane.md')), false);
    const graph = buildKnowledgeGraph(dir, RULES);
    assert.ok(!graph.nodes.some((node) => node.id === 'inbox/2026-10-05-0812-pane.md'));
    assert.ok(!graph.edges.some((edge) => edge.source.includes('pane') || edge.target.includes('pane')));
    const spesa = readFileSync(join(dir, 'kb', 'inbox', '2026-10-05-0900-spesa.md'), 'utf8');
    assert.ok(!spesa.includes('pane'));
    assert.equal(spesa.split(DELETED_LINK).length - 1, 2);
    // A link to another page stays; a page outside the inbox is the user's own text, left as it is.
    assert.ok(spesa.includes('[[altro/idea]]'));
    assert.ok(readFileSync(join(dir, 'kb', 'altro', 'idea.md'), 'utf8').includes('[[inbox/2026-10-05-0812-pane]]'));
  });

  it('another page of the Conoscenza goes too', () => {
    const dir = home();
    assert.deepEqual(deleteKbPage(dir, RULES, 'altro/idea.md'), { where: 'kb', path: 'kb/altro/idea.md' });
    assert.equal(existsSync(join(dir, 'kb', 'altro', 'idea.md')), false);
    assert.ok(!buildKnowledgeGraph(dir, RULES).nodes.some((node) => node.id === 'altro/idea.md'));
  });

  it('refuses anything outside kb/, a way out, a link, a hidden file, a page above L2 and a missing one, touching nothing', () => {
    const dir = home();
    symlinkSync(join(dir, 'fuori.md'), join(dir, 'kb', 'inbox', 'collegata.md'));
    symlinkSync(join(dir, 'docs'), join(dir, 'kb', 'documenti'));
    write(dir, { 'kb/inbox/.nascosta.md': '# nascosta\n' });
    for (const id of [
      '../docs/SPEC.md',
      '../fuori.md',
      'inbox/../../docs/SPEC.md',
      '/docs/SPEC.md',
      'documenti/SPEC.md',
      'inbox/collegata.md',
      'inbox/.nascosta.md',
      'segreti/chiave.md',
      'inbox/mancante.md',
      'inbox',
      '',
    ]) {
      assert.throws(() => deleteKbPage(dir, RULES, id), refused, id);
    }
    for (const path of ['docs/SPEC.md', 'fuori.md', 'kb/inbox/.nascosta.md', 'kb/segreti/chiave.md']) assert.ok(existsSync(join(dir, path)), path);
  });

  it('refuses a kb/ that is a link', () => {
    const real = home();
    const dir = join(scratch, randomUUID());
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(real, 'kb'), join(dir, 'kb'));
    assert.throws(() => deleteKbPage(dir, RULES, 'altro/idea.md'), refused);
    assert.ok(existsSync(join(real, 'kb', 'altro', 'idea.md')));
  });
});

describe('unlinkPlainFile', () => {
  it('unlinks a plain file only, below a real base', () => {
    const dir = home();
    const kb = join(dir, 'kb');
    assert.equal(unlinkPlainFile(kb, ['..', 'fuori.md']), false);
    assert.equal(unlinkPlainFile(kb, ['altro']), false);
    assert.equal(unlinkPlainFile(kb, ['altro/idea.md']), false);
    symlinkSync(kb, join(dir, 'kb-collegata'));
    assert.equal(unlinkPlainFile(join(dir, 'kb-collegata'), ['altro', 'idea.md']), false);
    assert.equal(unlinkPlainFile(kb, ['altro', 'idea.md']), true);
    assert.equal(unlinkPlainFile(kb, ['altro', 'idea.md']), false);
    assert.ok(existsSync(join(dir, 'fuori.md')));
  });
});

describe('a note of a project', () => {
  // A container with two git parts and its management folders, and a project that is one git (its notes in kb/progetti).
  const dir = join(scratch, 'progetti');
  const box = join(dir, 'repos', 'progetto-test');
  const one = join(dir, 'repos', 'un-git');
  const arianna = join(dir, 'arianna');
  write(box, {
    'Workplan/piano.md': '# Piano finto\n',
    'documenti/contratto.md': '---\nlabel: L3\n---\n# Contratto finto\n',
    'documenti/schema.txt': 'non una nota\n',
    'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n',
    'progetto-test-admin/README.md': '# Codice finto\n',
  });
  write(one, { '.git/HEAD': 'ref: refs/heads/main\n', 'README.md': '# Codice finto\n' });
  write(arianna, { 'kb/progetti/un-git/Workplan/diario.md': '# Diario finto\n', 'docs/SPEC.md': '# Documento finto\n' });
  symlinkSync(join(arianna, 'docs', 'SPEC.md'), join(box, 'Workplan', 'collegata.md'));
  const projects: Project[] = [
    { name: 'progetto-test', path: 'repos/progetto-test', absolute: box, label: 'L1' },
    { name: 'un-git', path: 'repos/un-git', absolute: one, label: 'L1' },
  ];
  const env = { home: arianna, rules: parseLabelRules('') };

  it('a note of a container goes, also a private one; the tab no longer lists it', () => {
    deleteProjectNote(projects, 'progetto-test', env, 'Workplan/piano.md');
    deleteProjectNote(projects, 'progetto-test', env, 'documenti/contratto.md');
    assert.equal(existsSync(join(box, 'Workplan', 'piano.md')), false);
    assert.equal(existsSync(join(box, 'documenti', 'contratto.md')), false);
    assert.ok(!readProjectKnowledge(projects, 'progetto-test', env).notes.some((note) => note.path === 'Workplan/piano.md'));
  });

  it('a note of a project of one git goes from kb/progetti', () => {
    deleteProjectNote(projects, 'un-git', env, 'Workplan/diario.md');
    assert.equal(existsSync(join(arianna, 'kb', 'progetti', 'un-git', 'Workplan', 'diario.md')), false);
  });

  it('refuses a part, the code, a way out, a link, a file that is no note and an unknown project', () => {
    const cases: [string, string][] = [
      ['progetto-test', 'progetto-test-admin/README.md'],
      ['progetto-test', '../../arianna/docs/SPEC.md'],
      ['progetto-test', 'Workplan/../progetto-test-admin/README.md'],
      ['progetto-test', 'Workplan/collegata.md'],
      ['progetto-test', 'documenti/schema.txt'],
      ['progetto-test', 'Workplan/.nascosta.md'],
      ['progetto-test', 'README.md'],
      ['un-git', 'README.md'],
      ['un-git', '../../../docs/SPEC.md'],
    ];
    for (const [project, path] of cases) {
      assert.throws(
        () => {
          deleteProjectNote(projects, project, env, path);
        },
        refused,
        `${project} ${path}`,
      );
    }
    assert.throws(() => {
      deleteProjectNote(projects, 'altro', env, 'Workplan/piano.md');
    }, refused);
    for (const path of [join(box, 'progetto-test-admin', 'README.md'), join(one, 'README.md'), join(arianna, 'docs', 'SPEC.md'), join(box, 'documenti', 'schema.txt')]) {
      assert.ok(existsSync(path), path);
    }
  });
});
