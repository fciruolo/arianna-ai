// The Archivist A1 (D-195): the folders a note may go to, the proposal in the
// header of the note, and the move the user approves: inside kb/ only,
// through real folders, never over a file, never with a lower label, never a
// note changed after the proposal. Fake notes only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import {
  approveArchive,
  approveMany,
  ArchiveError,
  archiveFolders,
  archiveSchema,
  composeArchived,
  discardArchive,
  listProposals,
  notesToPropose,
  proposalBasis,
  readArchiveAnswer,
  readProposal,
  relocateArchived,
  stripProposal,
  wasArchived,
  withDiscard,
  withProposal,
} from '../src/archivist.ts';
import { listPageIds } from '../src/knowledge.ts';
import { noteLabel, sha256 } from '../src/notes.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `archivist-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules(
  ['[[folder]]\npath = "kb/public"\nlabel = "L0"', '[[folder]]\npath = "kb/work"\nlabel = "L1"', '[[folder]]\npath = "kb/private"\nlabel = "L2"', '[[folder]]\npath = "kb/private/segreti"\nlabel = "L3"'].join('\n\n'),
);
const NAME = '2026-10-13-080000-ombrellone.md';
const NOTE = [
  '---',
  'label: L2',
  'source: capture:hud:test',
  'captured_at: 2026-10-13T08:00:00+02:00',
  'kind: idea',
  'status: organized',
  'title: "Ombrellone"',
  'tags: ["casa"]',
  'organized_at: 2026-10-13T08:01:00+02:00',
  'model: local-large',
  '---',
  '',
  '## Riassunto',
  '',
  'Comprare un ombrellone finto per il balcone.',
  '',
  '## Contesto',
  '',
  'Nessun collegamento.',
  '',
  '## Testo originale',
  '',
  'ombrellone balcone, idea finta',
  '',
].join('\n');

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const PROPOSAL = { folder: 'kb/private/casa', title: 'Ombrellone per il balcone', links: ['kb/private/casa/balcone.md'], reason: 'Un acquisto per la casa.' };

/** A home with fake folders, an organized note with a proposal, and a file outside kb/. */
function home(note = NOTE): { dir: string; version: string } {
  const dir = join(scratch, randomUUID());
  const raw = withProposal(note, PROPOSAL, 'local-large', new Date(2026, 9, 13, 8, 2));
  write(dir, {
    [`kb/inbox/${NAME}`]: raw,
    'kb/inbox/2026-10-13-090000-spesa.md': `---\nlabel: L2\nstatus: organized\ntitle: "Spesa"\n---\n\nVedi [[inbox/${NAME.replace(/\.md$/, '')}]] e [[inbox/${NAME.replace(/\.md$/, '')}|l'ombrellone]].\n`,
    'kb/private/casa/balcone.md': '---\ntitle: Balcone, lavori finti\n---\n\nIl balcone va sistemato.\n',
    'kb/private/auto/tagliando.md': '# Tagliando finto\n',
    'kb/private/segreti/chiave.md': '# Segreto finto\n',
    'kb/public/ricette/torta.md': '# Torta finta\n',
    'kb/work/clienti/rossi.md': '# Cliente finto\n',
    'kb/progetti/demo/nota.md': '# Progetto finto\n',
    'kb/.obsidian/app.json': '{}',
    'fuori/nota.md': '# Fuori da kb\n',
  });
  return { dir, version: sha256(raw) };
}

function code(error: unknown): string | undefined {
  return error instanceof ArchiveError ? error.code : undefined;
}

describe('archiveFolders', () => {
  it('offers the real folders of kb/ up to L2, never the inbox, the projects, hidden ones or L3', () => {
    const { dir } = home();
    const folders = archiveFolders(dir, RULES).map((folder) => `${folder.path}:${folder.label}`);
    assert.deepEqual(folders, [
      'kb/private:L2',
      'kb/private/auto:L2',
      'kb/private/casa:L2',
      'kb/public:L0',
      'kb/public/ricette:L0',
      'kb/work:L1',
      'kb/work/clienti:L1',
    ]);
  });

  it('never offers kb/archivio nor a folder inside it (D-198)', () => {
    const { dir } = home();
    write(dir, { 'kb/archivio/private/casa/vecchia.md': '# Archiviata finta\n' });
    const paths = archiveFolders(dir, RULES).map((folder) => folder.path);
    assert.equal(paths.some((path) => path.toLowerCase().startsWith('kb/archivio')), false);
    assert.equal(paths.includes('kb/private/casa'), true);
  });

  it('never offers a folder that is a link, inside or outside kb/', () => {
    const { dir } = home();
    symlinkSync(join(dir, 'fuori'), join(dir, 'kb', 'private', 'scorciatoia'));
    symlinkSync(join(dir, 'kb', 'private', 'casa'), join(dir, 'kb', 'casa2'));
    const paths = archiveFolders(dir, RULES).map((folder) => folder.path);
    assert.equal(paths.includes('kb/private/scorciatoia'), false);
    assert.equal(paths.includes('kb/casa2'), false);
  });

  it('is empty when kb/ is itself a link', () => {
    const dir = join(scratch, randomUUID());
    write(dir, { 'altrove/private/casa/x.md': '# x\n' });
    symlinkSync(join(dir, 'altrove'), join(dir, 'kb'));
    assert.deepEqual(archiveFolders(dir, RULES), []);
  });
});

describe('the proposal in the header', () => {
  it('reads back what was written, for this version of the note', () => {
    const raw = withProposal(NOTE, PROPOSAL, 'local-large', new Date());
    const proposal = readProposal(raw);
    assert.equal(proposal?.state, 'proposed');
    assert.equal(proposal.folder, 'kb/private/casa');
    assert.equal(proposal.title, 'Ombrellone per il balcone');
    assert.deepEqual(proposal.links, ['kb/private/casa/balcone.md']);
    assert.equal(stripProposal(raw), NOTE);
    assert.equal(proposalBasis(raw), sha256(NOTE));
  });

  it('a note changed after the proposal makes it expired', () => {
    const raw = withProposal(NOTE, PROPOSAL, 'local-large', new Date());
    assert.equal(readProposal(raw.replace('idea finta', 'idea cambiata'))?.state, 'expired');
  });

  it('a hand-edited proposal that is not valid any more is expired, never followed', () => {
    const raw = withProposal(NOTE, PROPOSAL, 'local-large', new Date()).replace('archive_folder: kb/private/casa', 'archive_folder: kb/../fuori');
    assert.equal(readProposal(raw)?.state, 'expired');
  });

  it('a discard holds for this version only', () => {
    const discarded = withDiscard(NOTE, new Date());
    assert.equal(readProposal(discarded)?.state, 'discarded');
    assert.equal(readProposal(discarded.replace('idea finta', 'idea nuova')), undefined);
  });

  it('a note with a BOM or CRLF lines has no proposal the code could rewrite', () => {
    const raw = withProposal(NOTE, PROPOSAL, 'local-large', new Date());
    assert.equal(readProposal(`\uFEFF${raw}`), undefined);
    assert.equal(readProposal(raw.replace(/\n/g, '\r\n')), undefined);
  });

  it('a note without a proposal has none', () => {
    assert.equal(readProposal(NOTE), undefined);
  });
});

describe('the answer of the model', () => {
  const folders = ['private/casa', 'public/ricette'];
  const related = ['private/casa/balcone'];

  it('takes a folder and links among those given', () => {
    const read = readArchiveAnswer({ value: { folder: 'private/casa', title: 'Ombrellone', links: ['private/casa/balcone'], reason: 'Casa.' }, finishReason: 'stop' }, folders, related);
    assert.deepEqual(read, { folder: 'kb/private/casa', title: 'Ombrellone', links: ['kb/private/casa/balcone.md'], reason: 'Casa.' });
  });

  it('refuses a folder or a link it was not given, a long title, extra keys, a cut answer', () => {
    const bad = [
      { folder: 'inbox', title: 'x', links: [], reason: '' },
      { folder: '../fuori', title: 'x', links: [], reason: '' },
      { folder: 'private/casa', title: 'x', links: ['private/segreti/chiave'], reason: '' },
      { folder: 'private/casa', title: 'x'.repeat(81), links: [], reason: '' },
      { folder: 'private/casa', title: 'riga\nnuova', links: [], reason: '' },
      { folder: 'private/casa', title: 'x', links: [], reason: '', label: 'L0' },
    ];
    for (const value of bad) assert.deepEqual(readArchiveAnswer({ value, finishReason: 'stop' }, folders, related), { failed: 'bad-response' });
    assert.deepEqual(readArchiveAnswer({ value: {}, finishReason: 'length' }, folders, related), { failed: 'truncated' });
  });

  it('constrains the schema to the folders and links given', () => {
    const schema = archiveSchema(folders, []) as { properties: { folder: { enum: string[] }; links: { maxItems: number } } };
    assert.deepEqual(schema.properties.folder.enum, folders);
    assert.equal(schema.properties.links.maxItems, 0);
  });
});

describe('approveArchive', () => {
  it('moves the note with its text, a label never lower, the title and the links', () => {
    const { dir, version } = home();
    const archived = approveArchive(dir, RULES, { name: NAME, version }, new Date(2026, 9, 13, 9, 0));
    assert.equal(archived.path, `kb/archivio/private/casa/${NAME}`);
    assert.equal(archived.corrected, false);
    assert.equal(existsSync(join(dir, 'kb', 'inbox', NAME)), false);
    const moved = readFileSync(join(dir, archived.path), 'utf8');
    assert.match(moved, /^---\nlabel: L2\n/);
    assert.match(moved, /\ntitle: "Ombrellone per il balcone"\n/);
    assert.doesNotMatch(moved, /^archive(_[a-z]+)?:/m);
    assert.match(moved, /## Collegamenti\n\n- \[\[private\/casa\/balcone\]\]\n\n## Testo originale\n\nombrellone balcone, idea finta\n$/);
    assert.equal(noteLabel(RULES, archived.path, moved), 'L2');
  });

  it('keeps the label when the folder has a lower one (never lower)', () => {
    const { dir, version } = home();
    const archived = approveArchive(dir, RULES, { name: NAME, version, folder: 'kb/public/ricette', links: [] });
    assert.equal(archived.corrected, true);
    assert.equal(archived.label, 'L2');
    const moved = readFileSync(join(dir, archived.path), 'utf8');
    assert.equal(noteLabel(RULES, archived.path, moved), 'L2');
  });

  it('writes the label of the inbox even when the note had no label line', () => {
    const { dir, version } = home(NOTE.replace('label: L2\n', ''));
    const archived = approveArchive(dir, RULES, { name: NAME, version, folder: 'kb/work/clienti' });
    assert.equal(noteLabel(RULES, archived.path, readFileSync(join(dir, archived.path), 'utf8')), 'L2');
  });

  it('rewrites the links to the note in the other pages', () => {
    const { dir, version } = home();
    const archived = approveArchive(dir, RULES, { name: NAME, version });
    assert.equal(archived.relinked, 1);
    const spesa = readFileSync(join(dir, 'kb', 'inbox', '2026-10-13-090000-spesa.md'), 'utf8');
    const stem = NAME.replace(/\.md$/, '');
    assert.match(spesa, new RegExp(`\\[\\[archivio/private/casa/${stem}\\]\\] e \\[\\[archivio/private/casa/${stem}\\|l'ombrellone\\]\\]`));
  });

  it('never writes the folder of the note in a page with a lower label, nor touches a page above L2 or an ambiguous link', () => {
    const { dir, version } = home();
    const stem = NAME.replace(/\.md$/, '');
    write(dir, {
      'kb/public/ricette/link.md': `# Pagina pubblica finta\n\nVedi [[inbox/${stem}]].\n`,
      'kb/private/segreti/link.md': `# Segreto finto\n\nVedi [[inbox/${stem}]].\n`,
      [`kb/private/auto/${NAME}`]: '# Omonima finta\n',
      'kb/private/auto/ambiguo.md': `# Ambiguo finto\n\nVedi [[${stem}]].\n`,
    });
    const archived = approveArchive(dir, RULES, { name: NAME, version });
    const pub = readFileSync(join(dir, 'kb', 'public', 'ricette', 'link.md'), 'utf8');
    // The file name is shared with kb/private/auto: no short form is unique, so the L0 page is left as it was.
    assert.equal(pub, `# Pagina pubblica finta\n\nVedi [[inbox/${stem}]].\n`);
    assert.doesNotMatch(pub, /private\/casa/);
    assert.equal(readFileSync(join(dir, 'kb', 'private', 'segreti', 'link.md'), 'utf8'), `# Segreto finto\n\nVedi [[inbox/${stem}]].\n`);
    assert.equal(readFileSync(join(dir, 'kb', 'private', 'auto', 'ambiguo.md'), 'utf8'), `# Ambiguo finto\n\nVedi [[${stem}]].\n`);
    assert.equal(archived.relinked, 1);
  });

  it('gives a page with a lower label the file name alone when it is unique', () => {
    const { dir, version } = home();
    const stem = NAME.replace(/\.md$/, '');
    write(dir, { 'kb/public/ricette/link.md': `# Pagina pubblica finta\n\nVedi [[inbox/${stem}|l'ombrellone]].\n` });
    approveArchive(dir, RULES, { name: NAME, version });
    assert.equal(readFileSync(join(dir, 'kb', 'public', 'ricette', 'link.md'), 'utf8'), `# Pagina pubblica finta\n\nVedi [[${stem}|l'ombrellone]].\n`);
  });

  it('approves two linked notes together: the rewrite of the first keeps the second fresh', () => {
    const { dir, version } = home();
    const stem = NAME.replace(/\.md$/, '');
    const second = '2026-10-13-100000-sdraio.md';
    const raw = withProposal(NOTE.replace('Nessun collegamento.', `Vedi [[inbox/${stem}]].`).replace('ombrellone balcone', 'sdraio balcone'), { ...PROPOSAL, links: [] }, 'local-large', new Date());
    write(dir, { [`kb/inbox/${second}`]: raw });
    const results = approveMany(dir, RULES, [
      { name: NAME, version },
      { name: second, version: sha256(raw) },
    ]);
    assert.deepEqual(
      results.map((result) => result.ok),
      [true, true],
    );
    assert.match(readFileSync(join(dir, 'kb', 'archivio', 'private', 'casa', second), 'utf8'), new RegExp(`\\[\\[archivio/private/casa/${stem}\\]\\]`));
  });

  it('refuses a folder outside kb/, the inbox, the projects, an L3 folder or one that does not exist', () => {
    for (const folder of ['fuori', 'kb/../fuori', 'kb', 'kb/inbox', 'kb/progetti/demo', 'kb/private/segreti', 'kb/private/nuova', '/tmp']) {
      const { dir, version } = home();
      assert.throws(() => approveArchive(dir, RULES, { name: NAME, version, folder }), (error) => code(error) === 'folder', folder);
      assert.equal(existsSync(join(dir, 'kb', 'inbox', NAME)), true);
    }
  });

  it('refuses a folder that is a link, and writes nothing behind it', () => {
    const { dir, version } = home();
    symlinkSync(join(dir, 'fuori'), join(dir, 'kb', 'private', 'scorciatoia'));
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version, folder: 'kb/private/scorciatoia' }), (error) => code(error) === 'folder');
    assert.equal(existsSync(join(dir, 'fuori', NAME)), false);
  });

  it('refuses a note of the inbox that is a link', () => {
    const { dir } = home();
    const outside = join(dir, 'fuori', 'falsa.md');
    const raw = withProposal(NOTE, PROPOSAL, 'local-large', new Date());
    writeFileSync(outside, raw);
    symlinkSync(outside, join(dir, 'kb', 'inbox', '2026-10-13-100000-falsa.md'));
    assert.throws(() => approveArchive(dir, RULES, { name: '2026-10-13-100000-falsa.md', version: sha256(raw) }), (error) => code(error) === 'not-found');
    assert.equal(readFileSync(outside, 'utf8'), raw);
  });

  it('refuses a folder gone after the proposal', () => {
    const { dir, version } = home();
    rmSync(join(dir, 'kb', 'private', 'casa'), { recursive: true });
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version }), (error) => code(error) === 'folder');
    assert.equal(existsSync(join(dir, 'kb', 'inbox', NAME)), true);
  });

  it('refuses a note changed after the proposal (expired) or after the page showed it (changed)', () => {
    const { dir } = home();
    const file = join(dir, 'kb', 'inbox', NAME);
    const edited = readFileSync(file, 'utf8').replace('idea finta', 'idea cambiata');
    writeFileSync(file, edited);
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version: sha256(edited) }), (error) => code(error) === 'expired');
    const other = home();
    assert.throws(() => approveArchive(other.dir, RULES, { name: NAME, version: 'a'.repeat(64) }), (error) => code(error) === 'changed');
    assert.equal(existsSync(join(other.dir, 'kb', 'inbox', NAME)), true);
  });

  it('never overwrites a note with the same name in the folder', () => {
    const { dir, version } = home();
    write(dir, { [`kb/archivio/private/casa/${NAME}`]: '# Già qui, finta\n' });
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version }), (error) => code(error) === 'exists');
    assert.equal(readFileSync(join(dir, 'kb', 'archivio', 'private', 'casa', NAME), 'utf8'), '# Già qui, finta\n');
    assert.equal(existsSync(join(dir, 'kb', 'inbox', NAME)), true);
  });

  it('writes in kb/archivio, never in the folder of kb/ the repository tracks (D-198)', () => {
    const { dir, version } = home();
    approveArchive(dir, RULES, { name: NAME, version });
    assert.equal(existsSync(join(dir, 'kb', 'private', 'casa', NAME)), false);
    assert.equal(existsSync(join(dir, 'kb', 'archivio', 'private', 'casa', NAME)), true);
  });

  it('never writes through kb/archivio when it is a link (D-198)', () => {
    const { dir, version } = home();
    symlinkSync(join(dir, 'fuori'), join(dir, 'kb', 'archivio'));
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version }), (error) => code(error) === 'folder');
    assert.equal(existsSync(join(dir, 'fuori', 'private')), false);
    assert.equal(existsSync(join(dir, 'kb', 'inbox', NAME)), true);
  });

  it('neither offers nor takes a folder whose place in the archive has a label above L2 (D-198)', () => {
    const { dir, version } = home();
    const rules = parseLabelRules(['[[folder]]\npath = "kb/private"\nlabel = "L2"', '[[folder]]\npath = "kb/archivio/private/casa"\nlabel = "L3"'].join('\n\n'));
    assert.equal(archiveFolders(dir, rules).some((folder) => folder.path === 'kb/private/casa'), false);
    assert.equal(archiveFolders(dir, rules).some((folder) => folder.path === 'kb/private/auto'), true);
    assert.throws(() => approveArchive(dir, rules, { name: NAME, version }), (error) => code(error) === 'folder');
    assert.equal(existsSync(join(dir, 'kb', 'inbox', NAME)), true);
  });

  it('keeps only proposed links, and a title on one line', () => {
    const { dir, version } = home();
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version, links: ['kb/private/auto/tagliando.md'] }), (error) => code(error) === 'invalid');
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version, title: 'due\nrighe' }), (error) => code(error) === 'invalid');
    assert.throws(() => approveArchive(dir, RULES, { name: `../${NAME}`, version }), (error) => code(error) === 'not-found');
  });

  it('refuses a note above L2', () => {
    const { dir } = home(NOTE.replace('label: L2', 'label: L3'));
    const raw = readFileSync(join(dir, 'kb', 'inbox', NAME), 'utf8');
    assert.throws(() => approveArchive(dir, RULES, { name: NAME, version: sha256(raw) }), (error) => code(error) === 'not-found');
  });
});

describe('composeArchived', () => {
  it('raises a label, never keeps a lower one', () => {
    const out = composeArchived(withProposal(NOTE.replace('label: L2', 'label: L1'), PROPOSAL, 'm', new Date()), { label: 'L2', title: 'T', links: [], now: new Date() });
    assert.match(out, /^---\nlabel: L2\n/);
    assert.equal(out.match(/^label:/gm)?.length, 1);
  });
});

describe('discard and the view', () => {
  it('lists the proposals, leaves out a discarded one, and proposes the organized notes without one', () => {
    const { dir, version } = home();
    const listed = listProposals(dir, RULES);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.state, 'proposed');
    assert.deepEqual(listed[0].links, [{ path: 'kb/private/casa/balcone.md', title: 'Balcone, lavori finti' }]);
    assert.deepEqual(notesToPropose(dir, RULES, 10), ['kb/inbox/2026-10-13-090000-spesa.md']);
    discardArchive(dir, RULES, NAME, version);
    assert.equal(listProposals(dir, RULES).length, 0);
    assert.equal(readProposal(readFileSync(join(dir, 'kb', 'inbox', NAME), 'utf8'))?.state, 'discarded');
    assert.equal(notesToPropose(dir, RULES, 10).includes(`kb/inbox/${NAME}`), false);
  });

  it('refuses to discard a note changed since it was shown', () => {
    const { dir } = home();
    assert.throws(
      () => {
        discardArchive(dir, RULES, NAME, 'b'.repeat(64));
      },
      (error) => code(error) === 'changed',
    );
  });
});

describe('relocateArchived (D-198)', () => {
  const APPROVED = composeArchived(withProposal(NOTE, PROPOSAL, 'local-large', new Date()), { label: 'L2', title: 'Ombrellone per il balcone', links: [], now: new Date(2026, 9, 13, 9, 0) });

  it('moves a note approved before D-198 to the same folder of kb/archivio, unchanged, and the links follow', () => {
    const { dir } = home();
    const stem = NAME.replace(/\.md$/, '');
    write(dir, {
      [`kb/private/finanze/${NAME}`]: APPROVED,
      'kb/private/casa/link.md': `# Pagina finta\n\nVedi [[private/finanze/${stem}]].\n`,
    });
    assert.deepEqual(relocateArchived(dir, RULES), { moved: 1, left: 0 });
    assert.equal(existsSync(join(dir, 'kb', 'private', 'finanze', NAME)), false);
    assert.equal(readFileSync(join(dir, 'kb', 'archivio', 'private', 'finanze', NAME), 'utf8'), APPROVED);
    assert.equal(readFileSync(join(dir, 'kb', 'private', 'casa', 'link.md'), 'utf8'), `# Pagina finta\n\nVedi [[archivio/private/finanze/${stem}]].\n`);
    // Once in the archive it is not looked at again.
    assert.deepEqual(relocateArchived(dir, RULES), { moved: 0, left: 0 });
  });

  it('never moves a development document, nor the notes of the inbox, the projects or the archive', () => {
    const { dir } = home();
    const document = '---\ntitle: Bolletta finta\ncaptured_at: 2026-10-01T08:00:00+02:00\n---\n\nUn documento di sviluppo.\n';
    write(dir, {
      'kb/private/finanze/bolletta.md': document,
      'kb/inbox/2026-10-13-110000-gia.md': APPROVED,
      [`kb/progetti/demo/${NAME}`]: APPROVED,
    });
    assert.deepEqual(relocateArchived(dir, RULES), { moved: 0, left: 0 });
    assert.equal(readFileSync(join(dir, 'kb', 'private', 'finanze', 'bolletta.md'), 'utf8'), document);
    assert.equal(existsSync(join(dir, 'kb', 'inbox', '2026-10-13-110000-gia.md')), true);
    assert.equal(existsSync(join(dir, 'kb', 'progetti', 'demo', NAME)), true);
    assert.equal(wasArchived(document), false);
    assert.equal(wasArchived(APPROVED), true);
  });

  it('no development document of the repository kb/ looks like an approved note', () => {
    const root = join(resolveHome({}), 'kb');
    const ids = listPageIds(root).filter((id) => !/^(inbox|progetti|archivio)\//i.test(id));
    assert.ok(ids.length > 0);
    for (const id of ids) assert.equal(wasArchived(readFileSync(join(root, id), 'utf8')), false, id);
  });

  it('never overwrites a note in the archive, keeps a higher label, never goes through a link', () => {
    const { dir } = home();
    write(dir, {
      [`kb/private/finanze/${NAME}`]: APPROVED,
      [`kb/archivio/private/finanze/${NAME}`]: '# Già archiviata, finta\n',
      [`kb/private/segreti/${NAME}`]: APPROVED,
    });
    // kb/private/segreti is L3, and so is its place in the archive: it moves, still L3.
    assert.deepEqual(relocateArchived(dir, RULES), { moved: 1, left: 1 });
    assert.equal(readFileSync(join(dir, 'kb', 'archivio', 'private', 'finanze', NAME), 'utf8'), '# Già archiviata, finta\n');
    assert.equal(readFileSync(join(dir, 'kb', 'private', 'finanze', NAME), 'utf8'), APPROVED);
    assert.equal(noteLabel(RULES, `kb/archivio/private/segreti/${NAME}`, APPROVED), 'L3');

    const lower = home();
    write(lower.dir, { [`kb/work/clienti/${NAME}`]: APPROVED });
    const rules = parseLabelRules(['[[folder]]\npath = "kb/work"\nlabel = "L3"', '[[folder]]\npath = "kb/archivio/work"\nlabel = "L2"'].join('\n\n'));
    // A lower rule over the archive cannot lower the note: the folder outside it still counts.
    assert.deepEqual(relocateArchived(lower.dir, rules), { moved: 1, left: 0 });
    assert.equal(noteLabel(rules, `kb/archivio/work/clienti/${NAME}`, APPROVED), 'L3');

    const linked = home();
    write(linked.dir, { [`kb/private/finanze/${NAME}`]: APPROVED });
    symlinkSync(join(linked.dir, 'fuori'), join(linked.dir, 'kb', 'archivio'));
    assert.deepEqual(relocateArchived(linked.dir, RULES), { moved: 0, left: 1 });
    assert.equal(existsSync(join(linked.dir, 'fuori', 'private')), false);
    assert.equal(readFileSync(join(linked.dir, 'kb', 'private', 'finanze', NAME), 'utf8'), APPROVED);
  });
});
