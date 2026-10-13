// The graph of kb/ for the "Conoscenza" page (D-087): which pages become
// nodes, which links and tags become edges, and the routes that serve them.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import {
  buildKnowledgeGraph,
  graphOf,
  pageFolder,
  parseTags,
  readKnowledgePage,
  resolveWikilink,
  TAG_CLIQUE_LIMIT,
  wikilinkTargets,
  type GraphCache,
  type KnowledgeGraph,
  type PageFacts,
} from '../src/knowledge.ts';
import type { LiveFeed } from '../src/live.ts';
import { NoteError } from '../src/notes.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules(
  '[[folder]]\npath = "kb/public"\nlabel = "L0"\n[[folder]]\npath = "kb/work"\nlabel = "L1"\n[[folder]]\npath = "kb/segreti"\nlabel = "L3"\n',
);

function write(home: string, path: string, text: string): void {
  const file = join(home, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A fake kb/ with every case the graph must handle. */
function fixture(): string {
  const home = join(scratch, randomUUID());
  write(home, 'kb/public/ricetta.md', '---\ntitle: Pane in casa\ntags: ["cucina", "pane"]\n---\n\nVedi [[work/progetto|il progetto]] e [[manca]] e [[segreti/conto]] e [[inbox/alta]].\n');
  write(home, 'kb/work/progetto.md', '---\nkind: progetto\ntags: [cucina]\n---\n\nTorna a [[public/ricetta.md]] e a ![[nota#sezione]].\n');
  write(home, 'kb/inbox/nota.md', '---\nlabel: L2\ntitle: "Una nota"\n---\n\nCollegata a [[kb/public/ricetta.md]].\n');
  write(home, 'kb/inbox/alta.md', '---\nlabel: L3\ntitle: Segretissima\ntags: ["cucina"]\n---\n\n[[public/ricetta]] TESTO-L3\n');
  write(home, 'kb/inbox/rotta.md', '---\nlabel: L9\n---\n\n[[public/ricetta]] TESTO-INVALID\n');
  write(home, 'kb/inbox/aperta.md', '---\ntitle: senza chiusura\n\n[[public/ricetta]]\n');
  write(home, 'kb/segreti/conto.md', 'TESTO-CARTELLA-L3 [[public/ricetta]]\n');
  write(home, 'kb/.obsidian/workspace.md', '[[public/ricetta]]');
  write(home, 'kb/private/.nascosta.md', '[[public/ricetta]]');
  write(home, 'outside.md', 'FUORI [[public/ricetta]]');
  symlinkSync(join(home, 'outside.md'), join(home, 'kb', 'private', 'link.md'));
  symlinkSync(join(home, 'kb', 'segreti'), join(home, 'kb', 'cartella-link'));
  return home;
}

const ids = (graph: KnowledgeGraph) => graph.nodes.map((node) => node.id).sort();

describe('page header and links', () => {
  it('reads tags as JSON, flow lists and comma lists, lowercase and without #', () => {
    assert.deepEqual(parseTags('["Casa", "casa", "pane"]'), ['casa', 'pane']);
    assert.deepEqual(parseTags('[cucina, #pane]'), ['cucina', 'pane']);
    assert.deepEqual(parseTags('a, b c, d'), ['a', 'd']);
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(''), []);
  });

  it('finds wikilink targets without aliases and headings', () => {
    assert.deepEqual(wikilinkTargets('[[a]] [[b|B]] ![[c#h]] [[ ]] [x](y) [[d\ne]]'), ['a', 'b', 'c']);
  });

  it('resolves to existing pages with or without .md, by full path or unique name, never ambiguously', () => {
    const pages = ['inbox/nota.md', 'public/ricetta.md', 'work/a/doppio.md', 'work/b/doppio.md'];
    assert.equal(resolveWikilink('inbox/nota', pages), 'inbox/nota.md');
    assert.equal(resolveWikilink('inbox/nota.md', pages), 'inbox/nota.md');
    assert.equal(resolveWikilink('kb/inbox/nota.md', pages), 'inbox/nota.md');
    assert.equal(resolveWikilink('Ricetta', pages), 'public/ricetta.md');
    assert.equal(resolveWikilink('a/doppio', pages), 'work/a/doppio.md');
    assert.equal(resolveWikilink('doppio', pages), undefined);
    assert.equal(resolveWikilink('manca', pages), undefined);
    assert.equal(resolveWikilink('../outside', pages), undefined);
  });
});

describe('graphOf', () => {
  const facts = (tags: string[], links: string[] = []): PageFacts => ({ title: 't', kind: null, tags, label: 'L1', links });

  it('links pages sharing a tag in a clique up to the limit, through a tag node above it', () => {
    const small = Array.from({ length: TAG_CLIQUE_LIMIT }, (_, i) => ({ id: `a/${String(i)}.md`, facts: facts(['poco']), updatedAt: null }));
    const graph = graphOf(small, 0);
    assert.equal(graph.edges.length, (TAG_CLIQUE_LIMIT * (TAG_CLIQUE_LIMIT - 1)) / 2);
    assert.ok(graph.nodes.every((node) => !node.id.startsWith('tag:')));
    const big = Array.from({ length: TAG_CLIQUE_LIMIT + 1 }, (_, i) => ({ id: `a/${String(i)}.md`, facts: facts(['molto']), updatedAt: null }));
    const hub = graphOf(big, 0);
    const tagNode = hub.nodes.find((node) => node.id === 'tag:molto');
    assert.ok(tagNode !== undefined);
    assert.equal(tagNode.kind, 'tag');
    assert.equal(tagNode.degree, TAG_CLIQUE_LIMIT + 1);
    assert.equal(hub.edges.length, TAG_CLIQUE_LIMIT + 1);
    assert.ok(hub.edges.every((edge) => edge.target === 'tag:molto' && edge.type === 'tag'));
  });

  it('counts each edge once and leaves out self links', () => {
    const graph = graphOf(
      [
        { id: 'a.md', facts: facts([], ['b', 'b.md', 'a']), updatedAt: null },
        { id: 'b.md', facts: facts([], ['a']), updatedAt: null },
      ],
      0,
    );
    assert.deepEqual(graph.edges, [{ source: 'a.md', target: 'b.md', type: 'link' }]);
    assert.deepEqual(
      graph.nodes.map((node) => node.degree),
      [1, 1],
    );
  });
});

describe('buildKnowledgeGraph', () => {
  it('shows pages up to L2 only; L3 and invalid labels are counted, never nodes nor ends of edges', () => {
    const home = fixture();
    const graph = buildKnowledgeGraph(home, RULES);
    assert.deepEqual(ids(graph), ['inbox/nota.md', 'public/ricetta.md', 'work/progetto.md']);
    // alta (L3), rotta (invalid), aperta (header not closed), segreti/conto (L3 folder).
    assert.equal(graph.hidden, 4);
    const visible = new Set(ids(graph));
    for (const edge of graph.edges) assert.ok(visible.has(edge.source) && visible.has(edge.target), JSON.stringify(edge));
    const text = JSON.stringify(graph);
    for (const secret of ['Segretissima', 'TESTO', 'alta', 'rotta', 'conto', 'segreti', 'FUORI', 'link.md', 'obsidian', 'nascosta']) assert.doesNotMatch(text, new RegExp(secret));
  });

  it('turns resolved wikilinks into edges and drops the missing ones', () => {
    const graph = buildKnowledgeGraph(fixture(), RULES);
    const links = graph.edges.filter((edge) => edge.type === 'link').map((edge) => [edge.source, edge.target].sort().join(' '));
    assert.deepEqual(links.sort(), ['inbox/nota.md public/ricetta.md', 'inbox/nota.md work/progetto.md', 'public/ricetta.md work/progetto.md']);
    const tags = graph.edges.filter((edge) => edge.type === 'tag');
    assert.deepEqual(tags, [{ source: 'public/ricetta.md', target: 'work/progetto.md', type: 'tag' }]);
    const recipe = graph.nodes.find((node) => node.id === 'public/ricetta.md');
    assert.deepEqual(recipe && { title: recipe.title, folder: recipe.folder, label: recipe.label, tags: recipe.tags, degree: recipe.degree }, {
      title: 'Pane in casa',
      folder: 'public',
      label: 'L0',
      tags: ['cucina', 'pane'],
      degree: 3,
    });
    assert.equal(graph.nodes.find((node) => node.id === 'work/progetto.md')?.kind, 'progetto');
    assert.equal(graph.nodes.find((node) => node.id === 'inbox/nota.md')?.title, 'Una nota');
    assert.ok(!('body' in (recipe ?? {})));
  });

  it('reuses what it read while a page does not change, and reads it again when it does', () => {
    const home = fixture();
    const cache: GraphCache = new Map();
    buildKnowledgeGraph(home, RULES, cache);
    assert.ok(cache.has('public/ricetta.md'));
    write(home, 'kb/public/ricetta.md', '---\ntitle: Pane nuovo e più lungo\n---\n\nniente\n');
    utimesSync(join(home, 'kb', 'public', 'ricetta.md'), new Date(), new Date(Date.now() + 5_000));
    const graph = buildKnowledgeGraph(home, RULES, cache);
    assert.equal(graph.nodes.find((node) => node.id === 'public/ricetta.md')?.title, 'Pane nuovo e più lungo');
    // A page raised to L3 is hidden at once, cached or not.
    write(home, 'kb/work/progetto.md', '---\nlabel: L3\n---\n\nx\n');
    utimesSync(join(home, 'kb', 'work', 'progetto.md'), new Date(), new Date(Date.now() + 10_000));
    assert.ok(!ids(buildKnowledgeGraph(home, RULES, cache)).includes('work/progetto.md'));
  });

  it('checks the folders on the way again, also for a cached page', () => {
    const home = fixture();
    assert.equal(pageFolder(home, 'public/ricetta.md'), join(home, 'kb', 'public'));
    assert.equal(pageFolder(home, 'cartella-link/conto.md'), undefined);
    assert.equal(pageFolder(home, 'private/link.md/x.md'), undefined);
    // A cached page whose folder became a link meanwhile: the entry goes, the page is not shown.
    const cache: GraphCache = new Map();
    buildKnowledgeGraph(home, RULES, cache);
    const other = join(scratch, randomUUID());
    mkdirSync(other, { recursive: true });
    rmSync(join(home, 'kb', 'work'), { recursive: true });
    write(other, 'work/progetto.md', '---\nkind: progetto\n---\n\nx\n');
    symlinkSync(join(other, 'work'), join(home, 'kb', 'work'));
    assert.ok(!ids(buildKnowledgeGraph(home, RULES, cache)).includes('work/progetto.md'));
    assert.ok(!cache.has('work/progetto.md'));
  });

  it('gives an empty graph without kb/ or when kb/ is a link', () => {
    const home = join(scratch, randomUUID());
    mkdirSync(home, { recursive: true });
    assert.deepEqual(buildKnowledgeGraph(home, RULES), { nodes: [], edges: [], hidden: 0, truncated: false });
    const other = fixture();
    symlinkSync(join(other, 'kb'), join(home, 'kb'));
    assert.deepEqual(buildKnowledgeGraph(home, RULES).nodes, []);
  });
});

describe('readKnowledgePage', () => {
  it('reads a page up to L2 with its text', () => {
    const page = readKnowledgePage(fixture(), RULES, 'public/ricetta.md');
    assert.equal(page.title, 'Pane in casa');
    assert.match(page.body, /il progetto/);
  });

  it('answers the same not-found for traversal, links, hidden folders, L3 and invalid pages', () => {
    const home = fixture();
    for (const id of ['../outside.md', 'public/../../outside.md', 'private/link.md', 'cartella-link/conto.md', '.obsidian/workspace.md', 'private/.nascosta.md', 'inbox/alta.md', 'inbox/rotta.md', 'segreti/conto.md', 'manca.md', '/etc/passwd', 'public/ricetta', '']) {
      assert.throws(() => readKnowledgePage(home, RULES, id), (error: unknown) => error instanceof NoteError && error.code === 'not-found' && error.message === 'page not found', id);
    }
  });
});

describe('knowledge routes', () => {
  let home: string;
  let server: ApiServer;
  let origin: string;

  before(async () => {
    home = fixture();
    server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      capture: { home, rules: RULES },
    });
    origin = `http://127.0.0.1:${String(server.port)}`;
  });
  after(async () => {
    await server.close();
  });

  const get = (path: string) => fetch(`${origin}${path}`, { headers: { origin } });

  it('serves the graph and one page', async () => {
    const graph = (await (await get('/api/knowledge/graph')).json()) as KnowledgeGraph;
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.hidden, 4);
    const page = (await (await get('/api/knowledge/page?path=work%2Fprogetto.md')).json()) as { page: { body: string; kind: string } };
    assert.match(page.page.body, /Torna a/);
    assert.equal(page.page.kind, 'progetto');
  });

  it('serves Arianna’s documents as a source apart, with the same 404 for bad paths and 400 for another source (D-155)', async () => {
    mkdirSync(join(home, 'docs'), { recursive: true });
    writeFileSync(join(home, 'docs', 'DECISIONS.md'), '| D-001 | 2026-01-01 | **Siepe di alloro.** Bassa, lungo il viale. | Ombra | Accettata |\n');
    const graph = (await (await get('/api/knowledge/graph?source=arianna')).json()) as KnowledgeGraph;
    assert.deepEqual(
      graph.nodes.map((node) => [node.id, node.folder, node.label]),
      [['arianna/decisioni/D-001.md', 'decisioni', 'L2']],
    );
    const page = (await (await get('/api/knowledge/page?source=arianna&path=arianna%2Fdecisioni%2FD-001.md')).json()) as { page: { body: string; title: string } };
    assert.equal(page.page.title, 'D-001 · Siepe di alloro');
    assert.match(page.page.body, /Accettata/);
    // The notes' graph does not change, and a page of kb/ is not one of Arianna's.
    assert.equal(((await (await get('/api/knowledge/graph')).json()) as KnowledgeGraph).nodes.length, 3);
    for (const path of ['arianna%2F..%2Fdocs%2FDECISIONS.md', 'arianna%2Fdecisioni%2FD-999.md', 'work%2Fprogetto.md', '']) {
      const response = await get(`/api/knowledge/page?source=arianna&path=${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), '{"error":"page not found"}', path);
    }
    assert.equal((await get('/api/knowledge/graph?source=docs')).status, 400);
    assert.equal((await get('/api/knowledge/page?source=..&path=x.md')).status, 400);
  });

  it('refuses traversal, links and L3 pages with the same 404, without their content', async () => {
    for (const path of ['..%2Foutside.md', 'public%2F..%2F..%2Foutside.md', 'private%2Flink.md', 'inbox%2Falta.md', 'segreti%2Fconto.md', '.obsidian%2Fworkspace.md', 'manca.md', '']) {
      const response = await get(`/api/knowledge/page?path=${path}`);
      assert.equal(response.status, 404, path);
      const text = await response.text();
      assert.equal(text, '{"error":"page not found"}', path);
    }
    assert.equal((await get('/api/knowledge/page')).status, 404);
  });

  it('answers only same-origin requests on a known Host, and only GET', async () => {
    const send = (method: string, path: string, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: server.port, path, method, headers }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on('error', reject);
        request.end(method === 'POST' ? '{}' : undefined);
      });
    assert.equal(await send('GET', '/api/knowledge/graph', { host: `evil.example:${String(server.port)}` }), 403);
    assert.equal(await send('GET', '/api/knowledge/graph', { origin: 'http://evil.example' }), 403);
    assert.equal(await send('POST', '/api/knowledge/graph', { 'content-type': 'application/json', origin }), 405);
  });

  it('is not served without the knowledge base', async () => {
    const bare = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${String(bare.port)}/api/knowledge/graph`);
      assert.equal(response.status, 404);
    } finally {
      await bare.close();
    }
  });
});
