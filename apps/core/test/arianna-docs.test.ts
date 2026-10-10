import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import { createContext } from '@arianna/policy';

import {
  ariannaDocuments,
  AriannaDocsError,
  createAriannaDocs,
  decisionUnits,
  isAriannaPagePath,
  mentionsOf,
  pagesOf,
  partsOf,
  sectionUnits,
} from '../src/arianna-docs.ts';
import { buildAriannaGraph, readAriannaPage } from '../src/knowledge.ts';
import { NoteError } from '../src/notes.ts';
import { createKb, KbError } from '../src/orchestrator/kb.ts';
import { MAX_READ } from '../src/orchestrator/tools.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const NO_RULES = parseLabelRules('');
const work = createContext('L1', 'L1');
const personal = createContext('L2', 'L2');

// Invented documents: the shape of docs/, none of their content.
const DECISIONS = [
  '# Registro delle decisioni',
  '',
  '| Id | Data | Decisione | Motivo | Stato |',
  '| --- | --- | --- | --- | --- |',
  '| D-001 | 2026-01-01 | **Lampade del giardino a energia solare.** Le lampade si accendono al tramonto con un sensore `O_LUCE|O_BUIO`. | Meno cavi nel prato | Accettata |',
  '| D-002 | 2026-01-02 | Il cancello si apre con un pulsante \\| e una chiave, vedi D-001. | Sicurezza del cortile | Proposta |',
  '| D-001 | 2026-01-03 | Un duplicato che non conta. | — | — |',
  '| D-xyz | 2026-01-04 | Riga con un id sbagliato. | — | — |',
  '| D-003 | riga troppo corta |',
].join('\n');

const PROPOSALS = [
  '# Proposte',
  '',
  'Introduzione alle proposte del giardino.',
  '',
  '## D-002 — Il cancello',
  '',
  '### Contesto',
  '',
  'Il cancello cigola da anni.',
  '',
  '```',
  '## non è un titolo dentro un blocco di codice',
  '```',
  '',
  '## Idee del giardino',
  '',
  '### I-7, una serra piccola',
  '',
  'Pomodori tutto l’anno, come in I-3.',
].join('\n');

/** A fake ARIANNA_HOME with docs/ and CHANGELOG.md. */
function home(extra: (dir: string) => void = () => undefined): string {
  const dir = join(scratch, randomUUID());
  const file = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  file('docs/DECISIONS.md', DECISIONS);
  file('docs/PROPOSTE.md', PROPOSALS);
  file('docs/SPEC.md', '# Specifica\n\n## Irrigazione\n\nLe aiuole si bagnano alle sei.\n\n## Recinto\n\nIl recinto è di legno.\n');
  file('docs/HANDOFF.md', '# Consegna\n\n## Coda\n\nirrigazione segreta della consegna\n');
  file('docs/mockups/pagina.md', '# Mockup\n\n## Bozza\n\nirrigazione del mockup\n');
  file('CHANGELOG.md', '# Registro delle versioni\n\n## [Non rilasciato]\n\n### Aggiunto\n\n- Irrigazione a goccia.\n\n## [0.1.0] - 2026-01-01\n\n- Primo seme.\n');
  extra(dir);
  return dir;
}

describe('cutting the documents into pages (D-155)', () => {
  it('a decision row is a page: title, status and reason first, an unescaped | kept in the decision', () => {
    const [first, second, ...rest] = decisionUnits(DECISIONS);
    assert.equal(rest.length, 0, 'duplicates, bad ids and short rows are left out');
    assert.equal(first?.slug, 'D-001');
    assert.equal(first.title, 'D-001 · Lampade del giardino a energia solare');
    assert.ok(first.body.startsWith('**Stato:** Accettata'));
    assert.match(first.body, /### Motivo\n\nMeno cavi nel prato/);
    assert.match(first.body, /`O_LUCE \| O_BUIO`|`O_LUCE\|O_BUIO`/);
    assert.equal(second?.slug, 'D-002');
    assert.match(second.body, /un pulsante \| e una chiave/);
    assert.ok(second.body.startsWith('**Stato:** Proposta'));
  });

  it('a document is cut at ## and ###, never inside a code block; ids name their section', () => {
    const units = sectionUnits(PROPOSALS, 'proposta', true);
    assert.deepEqual(
      units.map((unit) => unit.slug),
      ['introduzione', 'D-002-contesto', 'I-7'],
    );
    assert.equal(units[1]?.title, 'D-002 — Il cancello › Contesto');
    assert.match(units[1].body, /## non è un titolo/);
    assert.equal(units[0]?.title, 'Proposte');
  });

  it('the changelog is cut by version only, and the same slug twice gets a number', () => {
    const units = sectionUnits('## [0.1.0] - x\n\nuno\n\n### Aggiunto\n\n- a\n\n## [0.1.0] - y\n\ndue\n', 'versione', false);
    assert.deepEqual(
      units.map((unit) => unit.slug),
      ['0.1.0', '0.1.0-2'],
    );
    assert.match(units[0]?.body ?? '', /### Aggiunto/);
  });

  it('a long unit becomes parts that name each other, each read whole by kb.read', () => {
    const long = Array.from({ length: 300 }, (_, i) => `Paragrafo ${String(i)} sulle aiuole e sui semi.`).join('\n\n');
    const parts = partsOf(long, 1000);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= 1000));
    assert.equal(parts.join('\n\n'), long);
    const pages = pagesOf('docs/SPEC.md', `## Semi\n\n${long}`, 'L2', '2026-01-01T00:00:00.000Z');
    assert.equal(pages[0]?.path, 'arianna/SPEC/semi.md');
    assert.equal(pages[1]?.path, 'arianna/SPEC/semi-parte-2.md');
    assert.match(pages[0].body, /Continua in arianna\/SPEC\/semi-parte-2\.md/);
    assert.ok(pages.every((page) => page.body.length <= MAX_READ));
    // A heading that gives the name of a part: both pages stay, under different paths.
    const clash = pagesOf('docs/SPEC.md', `## Semi\n\n${long}\n\n## Semi parte 2\n\nUna sezione vera.`, 'L2', '2026-01-01T00:00:00.000Z');
    const paths = clash.map((page) => page.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.ok(paths.includes('arianna/SPEC/semi-parte-2-bis.md'));
    assert.equal(clash.find((page) => page.path === 'arianna/SPEC/semi-parte-2.md')?.body, 'Una sezione vera.');
    assert.ok(paths.every((path) => isAriannaPagePath(path)));
  });

  it('mentions are decisions and ideas, without the page itself', () => {
    assert.deepEqual(mentionsOf('Vedi D-001, D-087b e I-11; non X-D-9 né D-1234567.', 'D-001'), ['D-087b', 'I-11']);
  });

  it('every page of the real documents fits in one kb.read', () => {
    const docs = createAriannaDocs({ home: resolveHome({}), rules: NO_RULES });
    const pages = docs.list();
    assert.ok(pages.length > 100, String(pages.length));
    for (const page of pages) assert.ok(page.body.length + page.title.length + page.path.length + 4 <= MAX_READ, page.path);
    assert.ok(pages.some((page) => page.path === 'arianna/decisioni/D-145.md'));
    assert.ok(pages.every((page) => isAriannaPagePath(page.path)), 'every path is one the tools accept');
    assert.equal(new Set(pages.map((page) => page.path)).size, pages.length, 'paths are unique');
  });
});

describe('the source of Arianna on disk (D-155)', () => {
  it('reads docs/*.md and CHANGELOG.md, not HANDOFF.md, not docs/mockups/, not links', () => {
    const dir = home((d) => {
      writeFileSync(join(scratch, 'fuori.md'), '## Fuori\n\nirrigazione da fuori\n');
      symlinkSync(join(scratch, 'fuori.md'), join(d, 'docs', 'LINK.md'));
    });
    assert.deepEqual(ariannaDocuments(dir), ['docs/DECISIONS.md', 'docs/PROPOSTE.md', 'docs/SPEC.md', 'CHANGELOG.md']);
    const pages = createAriannaDocs({ home: dir, rules: NO_RULES }).list();
    assert.ok(pages.some((page) => page.path === 'arianna/decisioni/D-001.md'));
    assert.ok(pages.some((page) => page.path === 'arianna/proposte/I-7.md'));
    assert.ok(pages.some((page) => page.path === 'arianna/changelog/non-rilasciato.md'));
    assert.ok(pages.some((page) => page.path === 'arianna/SPEC/irrigazione.md'));
    assert.ok(!pages.some((page) => /consegna|mockup|fuori/.test(page.body)));
  });

  it('every page is L2; a rule on docs/ can raise it, nothing lowers it', () => {
    const dir = home();
    assert.ok(createAriannaDocs({ home: dir, rules: NO_RULES }).list().every((page) => page.label === 'L2'));
    const lower = parseLabelRules('[[folder]]\npath = "docs"\nlabel = "L0"\n');
    assert.ok(createAriannaDocs({ home: dir, rules: lower }).list().every((page) => page.label === 'L2'));
    const higher = parseLabelRules('[[folder]]\npath = "docs"\nlabel = "L3"\n');
    const raised = createAriannaDocs({ home: dir, rules: higher }).list();
    assert.equal(raised.find((page) => page.source === 'docs/SPEC.md')?.label, 'L3');
    assert.equal(raised.find((page) => page.source === 'CHANGELOG.md')?.label, 'L2');
  });

  it('a document that changes is read again', () => {
    const dir = home();
    const docs = createAriannaDocs({ home: dir, rules: NO_RULES });
    assert.equal(docs.load('arianna/SPEC/recinto.md').body, 'Il recinto è di legno.');
    writeFileSync(join(dir, 'docs', 'SPEC.md'), '# Specifica\n\n## Recinto\n\nIl recinto ora è di ferro battuto.\n');
    assert.equal(docs.load('arianna/SPEC/recinto.md').body, 'Il recinto ora è di ferro battuto.');
  });

  it('refuses paths with .., outside arianna/ or of another shape; a missing page is not found', () => {
    const docs = createAriannaDocs({ home: home(), rules: NO_RULES });
    for (const path of ['arianna/../docs/SPEC.md', 'arianna/SPEC/../../x.md', 'arianna/..md/x.md', 'docs/SPEC.md', 'arianna/SPEC.md', 'arianna/a/b/c.md', 'arianna/.x/y.md', 'arianna/SPEC/recinto']) {
      assert.equal(isAriannaPagePath(path), false, path);
      assert.throws(() => docs.load(path), (error) => error instanceof AriannaDocsError && error.code === 'invalid', path);
    }
    assert.throws(() => docs.load('arianna/SPEC/nessuna.md'), (error) => error instanceof AriannaDocsError && error.code === 'not-found');
  });
});

describe('kb.search, kb.read and kb.write on Arianna’s documents (D-155)', () => {
  const kbOf = (dir: string) => createKb({ home: dir, rules: NO_RULES, arianna: createAriannaDocs({ home: dir, rules: NO_RULES }) });

  it('with clearance L2 a decision is found by the words of its text and read, labeled L2', () => {
    const kb = kbOf(home());
    const [hit] = kb.search('cancello pulsante chiave', personal).hits;
    assert.equal(hit?.path, 'arianna/decisioni/D-002.md');
    assert.equal(hit.label, 'L2');
    const page = kb.read('arianna/decisioni/D-002.md', personal);
    assert.equal(page.label, 'L2');
    assert.match(page.body, /Sicurezza del cortile/);
  });

  it('with clearance L1 nothing is found nor read, whether the page exists or not', () => {
    const kb = kbOf(home());
    const search = kb.search('cancello pulsante chiave', work);
    assert.equal(search.hits.length, 0);
    // Not even counted: a fixed note on every work search would only be noise.
    assert.equal(search.skippedAbove, false);
    for (const path of ['arianna/decisioni/D-002.md', 'arianna/decisioni/D-999.md']) {
      assert.throws(() => kb.read(path, work), (error) => error instanceof KbError && error.code === 'above-clearance', path);
    }
  });

  it('kb.write never writes under arianna/', () => {
    const kb = kbOf(home());
    for (const path of ['arianna/decisioni/D-002.md', 'arianna/nuova/pagina.md']) {
      assert.throws(() => kb.write(path, 'testo', 'L2', 'task:1'), (error) => error instanceof KbError && error.code === 'not-allowed', path);
    }
  });

  it('kb.read refuses a path with .. under arianna/ and a missing page', () => {
    const kb = kbOf(home());
    assert.throws(() => kb.read('arianna/../docs/SPEC.md', personal), (error) => error instanceof KbError && error.code === 'invalid-path');
    assert.throws(() => kb.read('arianna/SPEC/nessuna.md', personal), (error) => error instanceof KbError && error.code === 'not-found');
  });

  it('the scope "kb" leaves Arianna’s documents out (the organizer of the inbox)', () => {
    const kb = kbOf(home());
    assert.equal(kb.search('cancello pulsante chiave', personal, 5, 'kb').hits.length, 0);
  });

  it('without the source, arianna/ pages are not found', () => {
    const kb = createKb({ home: home(), rules: NO_RULES });
    assert.equal(kb.search('cancello pulsante chiave', personal).hits.length, 0);
    assert.throws(() => kb.read('arianna/decisioni/D-002.md', personal), (error) => error instanceof KbError && error.code === 'not-found');
  });
});

describe('the Conoscenza page on Arianna’s documents (D-155)', () => {
  it('the graph has a folder per document and an edge for each decision mentioned', () => {
    const graph = buildAriannaGraph(createAriannaDocs({ home: home(), rules: NO_RULES }));
    const decision = graph.nodes.find((node) => node.id === 'arianna/decisioni/D-002.md');
    assert.equal(decision?.folder, 'decisioni');
    assert.equal(decision.kind, 'decisione');
    assert.equal(decision.label, 'L2');
    assert.ok(graph.edges.some((edge) => [edge.source, edge.target].sort().join(' ') === 'arianna/decisioni/D-001.md arianna/decisioni/D-002.md'));
    assert.equal(graph.hidden, 0);
  });

  it('pages above L2 are only counted; reading one, or a bad path, answers the same 404', () => {
    const dir = home();
    const docs = createAriannaDocs({ home: dir, rules: parseLabelRules('[[folder]]\npath = "docs/SPEC.md"\nlabel = "L3"\n') });
    const graph = buildAriannaGraph(docs);
    assert.ok(graph.hidden >= 2);
    assert.ok(!graph.nodes.some((node) => node.folder === 'SPEC'));
    for (const path of ['arianna/SPEC/recinto.md', 'arianna/../docs/SPEC.md', 'arianna/SPEC/nessuna.md']) {
      assert.throws(() => readAriannaPage(docs, path), (error) => error instanceof NoteError && error.code === 'not-found', path);
    }
    const page = readAriannaPage(docs, 'arianna/decisioni/D-001.md');
    assert.equal(page.folder, 'decisioni');
    assert.equal(page.label, 'L2');
  });
});
