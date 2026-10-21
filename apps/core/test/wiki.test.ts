// The Wiki (D-280): pages composed by the code and read back the same way,
// proposals approved only for the page they were made for, never a point
// removed, old versions kept for «Ripristina», folders moved as approved
// proposals with their links following, indexes composed by the code; only
// real folders, never a link. Fake notes only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { archiveFolders } from '../src/archivist.ts';
import { buildKnowledgeGraph, readKnowledgePage } from '../src/knowledge.ts';
import { sha256 } from '../src/notes.ts';
import {
  allProposals,
  applyDecision,
  approveWikiProposal,
  composeIndex,
  composeWikiPage,
  countWikiProposals,
  deleteWikiPage,
  discardWikiProposal,
  indexSummary,
  inertLine,
  isSafeWikiPage,
  listWikiProposals,
  pageVersions,
  parseWikiPage,
  proposeMove,
  readWikiView,
  rebuildIndexes,
  visibleWikiTree,
  restoreWikiVersion,
  WikiError,
  wikiCandidates,
  wikiTree,
  type StoredProposal,
  type WikiPageData,
} from '../src/wiki.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `wiki-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules(['[[folder]]\npath = "kb"\nlabel = "L0"', '[[folder]]\npath = "kb/private"\nlabel = "L2"'].join('\n\n'));
const NOW = new Date('2026-10-21T10:00:00+02:00');

const NOTE = ['---', 'label: L2', 'title: "Octane finto"', 'status: organized', '---', '', '## Riassunto', '', 'Octane su Swoole, nota inventata.', ''].join('\n');

const PAGE: WikiPageData = {
  title: 'Swoole con Octane',
  summary: 'Come gira Octane su Swoole.',
  points: [
    { text: 'Octane usa Swoole o RoadRunner.', sources: ['inbox/2026-10-21-100000-octane'] },
    { text: 'La memoria cresce con gli oggetti statici.', sources: ['inbox/2026-10-21-100000-octane'] },
  ],
  questions: [],
  sources: ['inbox/2026-10-21-100000-octane'],
  related: [],
};

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

let homes = 0;
function home(files: Record<string, string> = {}): string {
  homes += 1;
  const root = join(scratch, String(homes));
  write(root, { 'kb/inbox/2026-10-21-100000-octane.md': NOTE, 'kb/private/nota.md': '---\nlabel: L2\n---\nprivata finta\n', ...files });
  return root;
}

function proposal(root: string, fields: Partial<StoredProposal>): StoredProposal {
  const stored: StoredProposal = {
    v: 1,
    id: randomUUID().replace(/-/g, '').slice(0, 16),
    kind: 'create',
    path: 'laravel/octane/swoole',
    base: null,
    content: composeWikiPage(PAGE, NOW),
    title: PAGE.title,
    source: 'inbox/2026-10-21-100000-octane.md',
    reason: 'Parla di Swoole.',
    model: 'local-large',
    createdAt: '2026-10-21T10:00:00+02:00',
    points: 2,
    citations: 2,
    ...fields,
  };
  write(root, { [`kb/wiki/.proposte/${stored.id}.json`]: JSON.stringify(stored) });
  return stored;
}

describe('the page', () => {
  it('is composed by the code and read back exactly; a page edited by hand is not read as one', () => {
    const raw = composeWikiPage({ ...PAGE, questions: ['Serve RoadRunner?'], related: ['laravel/code'] }, NOW);
    assert.match(raw, /^---\nlabel: L2\nkind: wiki\ntitle: "Swoole con Octane"\n/);
    assert.match(raw, /\n- Octane usa Swoole o RoadRunner\. \[\[inbox\/2026-10-21-100000-octane\]\]\n/);
    assert.match(raw, /## Pagine collegate\n\n- \[\[wiki\/laravel\/code\]\]\n$/);
    assert.deepEqual(parseWikiPage(raw), { ...PAGE, questions: ['Serve RoadRunner?'], related: ['laravel/code'] });
    assert.equal(isSafeWikiPage(raw), true);
    assert.equal(parseWikiPage(raw.replace('## Punti', 'Una riga mia.\n\n## Punti')), undefined);
    assert.equal(parseWikiPage(raw.replace('- Octane usa Swoole o RoadRunner. [[inbox/2026-10-21-100000-octane]]', '- Un punto senza fonte')), undefined);
  });

  it('is not safe with a lower label, an image, a link or HTML in it', () => {
    const raw = composeWikiPage(PAGE, NOW);
    assert.equal(isSafeWikiPage(raw.replace('label: L2', 'label: L1')), false);
    assert.equal(isSafeWikiPage(raw.replace('Come gira Octane su Swoole.', '![x](https://esempio.invalid/x.png)')), false);
    assert.equal(isSafeWikiPage(raw.replace('Come gira Octane su Swoole.', '<img src=x>')), false);
  });

  it('makes a text of the model inert: no wikilink, image, address or HTML', () => {
    assert.equal(inertLine('Vedi [[private/nota]] e ![x](https://esempio.invalid/a.png) <b>ok</b>'), 'Vedi private/nota e !\\[x]\\(https[://]esempio.invalid/a.png) &lt;b&gt;ok&lt;/b&gt;');
    assert.equal(inertLine('# Titolo\nseconda riga'), '\\# Titolo seconda riga');
    // Brackets the link filter leaves alone and a leading code fence: never a link nor a block.
    assert.equal(inertLine('x ]] y [[ z'), 'x  y  z');
    assert.ok(inertLine('```js codice').startsWith('\\`'));
  });

  it('an update rewrites or adds points and never removes one', () => {
    const decision = {
      action: 'update' as const,
      path: 'laravel/octane/swoole',
      title: 'Altro titolo',
      summary: '',
      points: [
        { text: 'Octane usa Swoole, RoadRunner o FrankenPHP.', sources: ['nota-2'], replaces: 1 },
        { text: 'Dopo un deploy i worker vanno riavviati.', sources: ['nota-1', 'nota-9'], replaces: 0 },
        { text: 'Una citazione sconosciuta.', sources: ['nota-9'], replaces: 0 },
      ],
      questions: ['Serve RoadRunner?'],
      related: ['laravel/code'],
      reason: '',
    };
    const cite = (id: string): string | undefined => ({ 'nota-1': 'inbox/a', 'nota-2': 'archivio/private/b' } as Record<string, string>)[id];
    const data = applyDecision(PAGE, decision, cite);
    assert.equal(data.title, PAGE.title);
    assert.equal(data.summary, PAGE.summary);
    assert.equal(data.points.length, 3);
    assert.deepEqual(data.points[0], { text: 'Octane usa Swoole, RoadRunner o FrankenPHP.', sources: ['inbox/2026-10-21-100000-octane', 'archivio/private/b'] });
    assert.deepEqual(data.points[1], PAGE.points[1]);
    assert.deepEqual(data.points[2], { text: 'Dopo un deploy i worker vanno riavviati.', sources: ['inbox/a'] });
    assert.deepEqual(data.sources, ['inbox/2026-10-21-100000-octane', 'archivio/private/b', 'inbox/a']);
    assert.deepEqual(data.related, ['laravel/code']);
  });
});

describe('proposals', () => {
  it('a new page goes where it was proposed, with the indexes of its folders; never over a page', () => {
    const root = home();
    const first = proposal(root, {});
    const approved = approveWikiProposal(root, RULES, first.id, {}, NOW);
    assert.equal(approved.path, 'laravel/octane/swoole');
    assert.deepEqual(approved.folders.sort(), ['', 'laravel', 'laravel/octane']);
    assert.equal(parseWikiPage(readFileSync(join(root, 'kb/wiki/laravel/octane/swoole.md'), 'utf8'))?.title, PAGE.title);
    assert.match(readFileSync(join(root, 'kb/wiki/laravel/octane/_indice.md'), 'utf8'), /- \[\[wiki\/laravel\/octane\/swoole\|Swoole con Octane\]\]/);
    assert.match(readFileSync(join(root, 'kb/wiki/_indice.md'), 'utf8'), /- \[\[wiki\/laravel\/_indice\|Laravel\]\]/);
    assert.equal(allProposals(root).length, 0);
    const second = proposal(root, {});
    assert.throws(() => approveWikiProposal(root, RULES, second.id, {}, NOW), (error) => error instanceof WikiError && error.code === 'exists');
    // The user moves it: another path is fine, an invalid one is not.
    assert.throws(() => approveWikiProposal(root, RULES, second.id, { path: '../fuori' }, NOW), (error) => error instanceof WikiError && error.code === 'invalid');
    assert.equal(approveWikiProposal(root, RULES, second.id, { path: 'laravel/swoole' }, NOW).corrected, true);
    assert.equal(existsSync(join(root, 'kb/wiki/laravel/swoole.md')), true);
    assert.deepEqual(wikiTree(root).pages.map((page) => page.path), ['laravel/octane/swoole', 'laravel/swoole']);
  });

  it('a proposal whose content is not a page of the code is refused', () => {
    const root = home();
    const bad = proposal(root, { content: composeWikiPage(PAGE, NOW).replace('Come gira Octane su Swoole.', '![x](https://esempio.invalid/x.png)') });
    assert.throws(() => approveWikiProposal(root, RULES, bad.id, {}, NOW), (error) => error instanceof WikiError && error.code === 'edited');
    assert.equal(existsSync(join(root, 'kb/wiki/laravel/octane/swoole.md')), false);
  });

  it('an update applies only to the page it was made for, keeps the old version, and «Ripristina» brings it back', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    const file = join(root, 'kb/wiki/laravel/octane/swoole.md');
    const before = readFileSync(file, 'utf8');
    const updated = composeWikiPage({ ...PAGE, points: [...PAGE.points, { text: 'Un punto nuovo.', sources: ['inbox/2026-10-21-100000-octane'] }] }, NOW);
    const stale = proposal(root, { kind: 'update', base: sha256('altro'), content: updated });
    assert.equal(listWikiProposals(root, RULES).find((item) => item.id === stale.id)?.state, 'expired');
    assert.throws(() => approveWikiProposal(root, RULES, stale.id, {}, NOW), (error) => error instanceof WikiError && error.code === 'expired');
    const fresh = proposal(root, { kind: 'update', base: sha256(before), content: updated });
    const view = listWikiProposals(root, RULES).find((item) => item.id === fresh.id);
    assert.equal(view?.state, 'fresh');
    assert.equal(view.diff.added, 1);
    assert.equal(view.source?.title, 'Octane finto');
    assert.throws(() => approveWikiProposal(root, RULES, fresh.id, { path: 'laravel/altro' }, NOW), (error) => error instanceof WikiError && error.code === 'invalid');
    approveWikiProposal(root, RULES, fresh.id, {}, NOW);
    assert.match(readFileSync(file, 'utf8'), /Un punto nuovo\./);
    const versions = pageVersions(root, 'laravel/octane/swoole');
    assert.equal(versions.length, 1);
    const current = readWikiView(root, RULES, 'laravel/octane/swoole');
    assert.throws(() => { restoreWikiVersion(root, RULES, 'laravel/octane/swoole', versions[0]?.id ?? '', sha256('altro'), NOW); }, (error) => error instanceof WikiError && error.code === 'changed');
    restoreWikiVersion(root, RULES, 'laravel/octane/swoole', versions[0]?.id ?? '', current.version, NOW);
    assert.equal(readFileSync(file, 'utf8'), before);
    // The version replaced is kept in turn: the restore can be undone.
    assert.equal(pageVersions(root, 'laravel/octane/swoole').length, 2);
  });

  it('«Scarta» removes the proposal only', () => {
    const root = home();
    const item = proposal(root, {});
    assert.equal(discardWikiProposal(root, item.id), 'create');
    assert.equal(allProposals(root).length, 0);
    assert.throws(() => discardWikiProposal(root, item.id), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.throws(() => discardWikiProposal(root, '../../x'), (error) => error instanceof WikiError && error.code === 'not-found');
  });

  it('citations follow a note the Archivist moved since the proposal', () => {
    const root = home();
    const item = proposal(root, {});
    rmSync(join(root, 'kb/inbox/2026-10-21-100000-octane.md'));
    write(root, { 'kb/archivio/private/2026-10-21-100000-octane.md': NOTE });
    approveWikiProposal(root, RULES, item.id, {}, NOW);
    const page = readFileSync(join(root, 'kb/wiki/laravel/octane/swoole.md'), 'utf8');
    assert.match(page, /\[\[archivio\/private\/2026-10-21-100000-octane\]\]/);
    assert.doesNotMatch(page, /\[\[inbox\//);
  });
});

describe('deleting a page', () => {
  it('«Elimina» takes the page as shown, its versions and the proposals on it; the indexes follow and an empty folder goes', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    approveWikiProposal(root, RULES, proposal(root, {}).id, { path: 'laravel/swoole' }, NOW);
    const file = join(root, 'kb/wiki/laravel/octane/swoole.md');
    const before = readFileSync(file, 'utf8');
    const updated = composeWikiPage({ ...PAGE, points: [...PAGE.points, { text: 'Un punto nuovo.', sources: ['inbox/2026-10-21-100000-octane'] }] }, NOW);
    approveWikiProposal(root, RULES, proposal(root, { kind: 'update', base: sha256(before), content: updated }).id, {}, NOW);
    assert.equal(pageVersions(root, 'laravel/octane/swoole').length, 1);
    const waiting = proposal(root, { kind: 'update', base: sha256(updated), content: updated });
    const other = proposal(root, { path: 'laravel/altra' });
    const current = readWikiView(root, RULES, 'laravel/octane/swoole');
    // Changed after it was shown: nothing goes.
    assert.throws(() => deleteWikiPage(root, RULES, 'laravel/octane/swoole', sha256('altro')), (error) => error instanceof WikiError && error.code === 'changed');
    assert.ok(existsSync(file));
    assert.deepEqual(deleteWikiPage(root, RULES, 'laravel/octane/swoole', current.version), { versions: 1, proposals: 1 });
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(join(root, 'kb/wiki/.storia/laravel__octane__swoole')), false);
    assert.deepEqual(pageVersions(root, 'laravel/octane/swoole'), []);
    const left = allProposals(root).map((item) => item.id);
    assert.ok(!left.includes(waiting.id));
    assert.ok(left.includes(other.id));
    // The folder left without pages goes with its index; the parent index no longer names it.
    assert.equal(existsSync(join(root, 'kb/wiki/laravel/octane')), false);
    assert.doesNotMatch(readFileSync(join(root, 'kb/wiki/laravel/_indice.md'), 'utf8'), /octane/);
    assert.match(readFileSync(join(root, 'kb/wiki/laravel/_indice.md'), 'utf8'), /laravel\/swoole/);
  });

  it('refuses an index, a missing page, an invalid path and a page a rule raises above L2, touching nothing', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    const index = readFileSync(join(root, 'kb/wiki/_indice.md'), 'utf8');
    const up = '.'.repeat(2);
    for (const path of ['_indice', 'laravel/_indice', 'laravel/octane/mancante', `${up}/altro`, 'laravel']) {
      assert.throws(() => deleteWikiPage(root, RULES, path, sha256(index)), (error) => error instanceof WikiError && error.code === 'not-found', path);
    }
    assert.throws(() => deleteWikiPage(root, RULES, 'laravel/octane/swoole', 'non-uno-sha'), (error) => error instanceof WikiError && error.code === 'invalid');
    const strict = parseLabelRules(['[[folder]]\npath = "kb"\nlabel = "L0"', '[[folder]]\npath = "kb/wiki/laravel"\nlabel = "L3"'].join('\n\n'));
    const page = readWikiView(root, RULES, 'laravel/octane/swoole');
    assert.throws(() => deleteWikiPage(root, strict, 'laravel/octane/swoole', page.version), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.ok(existsSync(join(root, 'kb/wiki/laravel/octane/swoole.md')));
    assert.ok(existsSync(join(root, 'kb/wiki/_indice.md')));
  });
});

describe('moving a folder', () => {
  it('is a proposal; approved, the pages move and the links follow', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    approveWikiProposal(root, RULES, proposal(root, { path: 'php/composer', content: composeWikiPage({ ...PAGE, title: 'Composer', related: ['laravel/octane/swoole'] }, NOW) }).id, {}, NOW);
    write(root, { 'kb/private/link.md': '---\nlabel: L2\n---\nVedi [[wiki/laravel/octane/swoole]].\n' });
    const move = proposeMove(root, RULES, 'laravel/octane', 'php/octane', NOW);
    assert.equal(listWikiProposals(root, RULES).find((item) => item.id === move.id)?.moves[0]?.to, 'php/octane/swoole');
    const approved = approveWikiProposal(root, RULES, move.id, {}, NOW);
    assert.equal(approved.path, 'php/octane');
    assert.equal(existsSync(join(root, 'kb/wiki/php/octane/swoole.md')), true);
    assert.equal(existsSync(join(root, 'kb/wiki/laravel')), false);
    assert.match(readFileSync(join(root, 'kb/private/link.md'), 'utf8'), /\[\[wiki\/php\/octane\/swoole\]\]/);
    assert.match(readFileSync(join(root, 'kb/wiki/php/composer.md'), 'utf8'), /\[\[wiki\/php\/octane\/swoole\]\]/);
    assert.match(readFileSync(join(root, 'kb/wiki/php/_indice.md'), 'utf8'), /octane\/_indice/);
  });

  it('refuses a destination that exists, inside itself, too deep; expires when the folder changes', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    approveWikiProposal(root, RULES, proposal(root, { path: 'php/composer' }).id, {}, NOW);
    assert.throws(() => proposeMove(root, RULES, 'laravel', 'php', NOW), (error) => error instanceof WikiError && error.code === 'exists');
    assert.throws(() => proposeMove(root, RULES, 'laravel', 'laravel/dentro', NOW), (error) => error instanceof WikiError && error.code === 'invalid');
    assert.throws(() => proposeMove(root, RULES, 'laravel', 'php/laravel', NOW), (error) => error instanceof WikiError && error.code === 'invalid');
    assert.throws(() => proposeMove(root, RULES, 'nessuna', 'altra', NOW), (error) => error instanceof WikiError && error.code === 'not-found');
    const move = proposeMove(root, RULES, 'laravel/octane', 'laravel/server', NOW);
    approveWikiProposal(root, RULES, proposal(root, { path: 'laravel/octane/roadrunner' }).id, {}, NOW);
    assert.throws(() => approveWikiProposal(root, RULES, move.id, {}, NOW), (error) => error instanceof WikiError && error.code === 'expired');
  });
});

describe('the tree, the indexes and the rest of kb/', () => {
  it('composes indexes with the «In breve» kept, and drops those of empty folders', () => {
    const tree = { folders: ['laravel'], pages: [{ path: 'laravel/swoole', title: 'Swoole | [x]', updatedAt: '' }] };
    const index = composeIndex('laravel', 'Note su Laravel.', tree);
    assert.match(index, /- \[\[wiki\/laravel\/swoole\|Swoole x\]\]/);
    assert.equal(indexSummary(index), 'Note su Laravel.');
    assert.equal(indexSummary(composeIndex('laravel', '', tree)), '');
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    rebuildIndexes(root, RULES, new Map([['laravel', 'Note finte su Laravel.']]));
    assert.equal(indexSummary(readFileSync(join(root, 'kb/wiki/laravel/_indice.md'), 'utf8')), 'Note finte su Laravel.');
    rmSync(join(root, 'kb/wiki/laravel/octane/swoole.md'));
    rebuildIndexes(root, RULES);
    assert.equal(existsSync(join(root, 'kb/wiki/laravel')), false);
    assert.equal(readWikiView(root, RULES, '_indice').kind, 'index');
  });

  it('finds the pages close to a text', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    assert.deepEqual(wikiCandidates(root, RULES, 'Swoole e la memoria').map((page) => page.path), ['laravel/octane/swoole']);
    assert.deepEqual(wikiCandidates(root, RULES, 'ricetta della torta'), []);
  });

  it('is L2 even under a lower rule, in the graph without proposals nor old versions, and never a folder of the Archivist', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    proposal(root, {});
    assert.equal(readKnowledgePage(root, RULES, 'wiki/laravel/octane/swoole.md').label, 'L2');
    const ids = buildKnowledgeGraph(root, RULES).nodes.map((node) => node.id);
    assert.ok(ids.includes('wiki/laravel/octane/swoole.md'));
    assert.ok(!ids.some((id) => id.includes('.proposte') || id.includes('.storia')));
    assert.ok(!archiveFolders(root, RULES).some((folder) => folder.path.startsWith('kb/wiki')));
  });

  it('a rule above L2 on a sub-folder of kb/wiki stays: neither shown, read nor given to the model', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    const strict = parseLabelRules(['[[folder]]\npath = "kb"\nlabel = "L0"', '[[folder]]\npath = "kb/wiki/segreti"\nlabel = "L3"'].join('\n\n'));
    mkdirSync(join(root, 'kb/wiki/segreti'), { recursive: true });
    writeFileSync(join(root, 'kb/wiki/segreti/swoole.md'), composeWikiPage({ ...PAGE, title: 'Swoole segreto' }, NOW));
    assert.ok(wikiTree(root).pages.some((page) => page.path === 'segreti/swoole'));
    const visible = visibleWikiTree(root, strict);
    assert.ok(!visible.folders.includes('segreti'));
    assert.ok(!visible.pages.some((page) => page.path.startsWith('segreti/')));
    assert.ok(visible.pages.some((page) => page.path === 'laravel/octane/swoole'));
    assert.throws(() => readWikiView(root, strict, 'segreti/swoole'), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.throws(() => readWikiView(root, strict, 'segreti/_indice'), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.deepEqual(wikiCandidates(root, strict, 'Swoole e la memoria').map((page) => page.path), ['laravel/octane/swoole']);
    // Without the rule the same page is there.
    assert.equal(readWikiView(root, RULES, 'segreti/swoole').title, 'Swoole segreto');
  });

  it('a rule above L2 inside kb/wiki: no move of it or of a folder around it, no proposal shown or approved there, no name in the indexes', () => {
    const root = home();
    approveWikiProposal(root, RULES, proposal(root, {}).id, {}, NOW);
    const strict = parseLabelRules(['[[folder]]\npath = "kb"\nlabel = "L0"', '[[folder]]\npath = "kb/private"\nlabel = "L2"', '[[folder]]\npath = "kb/wiki/laravel/segreti"\nlabel = "L3"'].join('\n\n'));
    mkdirSync(join(root, 'kb/wiki/laravel/segreti'), { recursive: true });
    writeFileSync(join(root, 'kb/wiki/laravel/segreti/chiave.md'), composeWikiPage({ ...PAGE, title: 'Chiave segreta' }, NOW));
    rebuildIndexes(root, strict);
    assert.doesNotMatch(readFileSync(join(root, 'kb/wiki/laravel/_indice.md'), 'utf8'), /segret/i);
    assert.throws(() => proposeMove(root, strict, 'laravel', 'php', NOW), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.throws(() => proposeMove(root, strict, 'laravel/segreti', 'laravel/aperti', NOW), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.throws(() => proposeMove(root, strict, 'laravel/octane', 'laravel/segreti', NOW), (error) => error instanceof WikiError);
    const there = proposal(root, { path: 'laravel/segreti/nuova' });
    assert.ok(!listWikiProposals(root, strict).some((item) => item.id === there.id));
    assert.equal(countWikiProposals(root, strict), countWikiProposals(root, RULES) - 1);
    assert.throws(() => approveWikiProposal(root, strict, there.id, {}, NOW), (error) => error instanceof WikiError && error.code === 'not-found');
    const elsewhere = proposal(root, { path: 'laravel/aperta' });
    assert.throws(() => approveWikiProposal(root, strict, elsewhere.id, { path: 'laravel/segreti/aperta' }, NOW), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.ok(listWikiProposals(root, strict).some((item) => item.id === elsewhere.id));
  });

  it('never goes through a link: a kb/wiki that is a link is neither read nor written', () => {
    const root = home();
    const elsewhere = join(scratch, `fuori-${String(homes)}`);
    mkdirSync(join(elsewhere, 'laravel'), { recursive: true });
    writeFileSync(join(elsewhere, 'laravel/x.md'), composeWikiPage(PAGE, NOW));
    symlinkSync(elsewhere, join(root, 'kb/wiki'));
    assert.deepEqual(wikiTree(root), { folders: [], pages: [] });
    assert.throws(() => readWikiView(root, RULES, 'laravel/x'), (error) => error instanceof WikiError && error.code === 'not-found');
    assert.deepEqual(allProposals(root), []);
    assert.throws(() => proposeMove(root, RULES, 'laravel', 'php', NOW), (error) => error instanceof WikiError);
  });
});
