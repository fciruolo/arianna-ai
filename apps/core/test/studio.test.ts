// The routes of the Studio of design (I-19, D-184): docs/STUDIO-API.md, each rule with a positive and a negative case.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { DeckError, type Deck } from '@arianna/pptx';
import { Secret } from '@arianna/vault';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { groupOf, mockupFolder, PPTX_TYPE, type PptxCodec } from '../src/studio.ts';
import { startApiServer } from '../src/server/http.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `studio-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const VAULT_VALUE = 'studio-Vault-Value-4815162342';
new Secret('test/studio', VAULT_VALUE);

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** A project `sito` (folder `mockups`), an Arianna-like `casa` (folder `docs/mockups`) and `vuoto` without mockups. */
function makeProjects(): Project[] {
  const sito = join(HOME, 'repos', 'sito');
  const mockups = join(sito, 'mockups');
  mkdirSync(join(mockups, 'vecchi'), { recursive: true });
  mkdirSync(join(sito, '.git'), { recursive: true });
  writeFileSync(join(mockups, 'landing-2.html'), '<h1>Landing 2</h1>\n');
  writeFileSync(join(mockups, 'landing.html'), '<h1>Landing</h1>\n');
  writeFileSync(join(mockups, 'landing-10.html'), '<h1>Landing 10</h1>\n');
  writeFileSync(join(mockups, 'about-1.html'), '<h1>About</h1>\n');
  writeFileSync(join(mockups, 'vecchi', 'old.html'), '<h1>Old</h1>\n');
  writeFileSync(join(mockups, '.bozza.html'), '<h1>Hidden</h1>\n');
  writeFileSync(join(mockups, 'note.txt'), 'not a mockup\n');
  writeFileSync(join(mockups, 'segreto.html'), `<p>${VAULT_VALUE}</p>\n`);
  writeFileSync(join(mockups, 'grande.html'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  writeFileSync(join(sito, 'index.html'), '<h1>Index</h1>\n');
  writeFileSync(join(sito, '.git', 'config.html'), '<h1>git</h1>\n');
  symlinkSync('../index.html', join(mockups, 'link.html'));
  symlinkSync('/etc/hosts', join(mockups, 'fuori.html'));
  const casa = join(HOME, 'repos', 'casa');
  mkdirSync(join(casa, 'docs', 'mockups'), { recursive: true });
  mkdirSync(join(casa, 'apps', 'hud'), { recursive: true });
  writeFileSync(join(casa, 'docs', 'DECISIONS.md'), '# Decisioni\n');
  writeFileSync(join(casa, 'docs', 'mockups', 'studio.html'), '<section data-slide><h1>Uno</h1></section>\n');
  const vuoto = join(HOME, 'repos', 'vuoto');
  mkdirSync(vuoto, { recursive: true });
  const giro = join(HOME, 'repos', 'giro');
  mkdirSync(join(giro, 'altrove'), { recursive: true });
  writeFileSync(join(giro, 'altrove', 'pagina.html'), '<h1>Altrove</h1>\n');
  symlinkSync('altrove', join(giro, 'mockups'));
  return [
    { name: 'giro', path: 'repos/giro', absolute: giro, label: 'L1' },
    { name: 'sito', path: 'repos/sito', absolute: sito, label: 'L1' },
    { name: 'casa', path: 'repos/casa', absolute: casa, label: 'L0' },
    { name: 'vuoto', path: 'repos/vuoto', absolute: vuoto, label: 'L1' },
  ];
}

const PROJECTS = makeProjects();
const SITO = join(HOME, 'repos', 'sito');

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
  json: Record<string, unknown>;
}

function call(port: number, method: string, path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let json: Record<string, unknown> = {};
        if (String(response.headers['content-type']).startsWith('application/json')) json = JSON.parse(bytes.toString('utf8') || '{}') as Record<string, unknown>;
        resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes, json });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A fake of the database that keeps the events appendEvent writes: kind, label and payload. */
function fakeSql(): { sql: Sql; events: { kind: string; label: string; payload: Record<string, unknown> }[] } {
  const events: { kind: string; label: string; payload: Record<string, unknown> }[] = [];
  const tag = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    events.push({ kind: values[3] as string, label: values[4] as string, payload: values[5] as Record<string, unknown> });
    return Promise.resolve([{ id: '1' }]);
  };
  return { sql: Object.assign(tag, { json: (value: unknown) => value }) as unknown as Sql, events };
}

const FAKE_PPTX: PptxCodec = {
  parse(raw) {
    const slides: unknown = typeof raw === 'object' && raw !== null ? (raw as { slides?: unknown }).slides : undefined;
    if (!Array.isArray(slides) || slides.length === 0) throw new DeckError('no slides');
    return raw as Deck;
  },
  write: (deck) => Buffer.from(`PK-fake ${String(deck.slides.length)}`),
};

async function server(t: { after: (fn: () => Promise<void>) => void }) {
  const { sql, events } = fakeSql();
  const api = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, approvedProjects: () => PROJECTS, studioPptx: FAKE_PPTX });
  t.after(async () => {
    await api.close();
  });
  return { port: api.port, events };
}

test('group and variant come from the number at the end of the name', () => {
  assert.deepEqual(groupOf('landing-2.html'), { group: 'landing', variant: 2 });
  assert.deepEqual(groupOf('landing.html'), { group: 'landing', variant: null });
  assert.deepEqual(groupOf('hero_12.html'), { group: 'hero', variant: 12 });
  assert.deepEqual(groupOf('2026.html'), { group: '2026', variant: null });
});

test('the folder is docs/mockups in the repository of Arianna, mockups elsewhere', async () => {
  assert.equal(await mockupFolder(join(HOME, 'repos', 'casa')), 'docs/mockups');
  assert.equal(await mockupFolder(SITO), 'mockups');
});

test('the list: only visible .html files directly in the folder, regular, at most 2 MiB, grouped and ordered', async (t) => {
  const { port } = await server(t);
  const answer = await call(port, 'GET', '/api/studio/sito/mockups');
  assert.equal(answer.status, 200);
  assert.equal(answer.json.folder, 'mockups');
  const files = answer.json.files as { path: string; name: string; group: string; variant: number | null; bytes: number; modified: string; sha256: string }[];
  // segreto.html is listed (name, size and hash only); its text is refused on reading.
  assert.deepEqual(
    files.map((file) => file.name),
    ['about-1.html', 'landing.html', 'landing-2.html', 'landing-10.html', 'segreto.html'],
  );
  const landing = files.find((file) => file.name === 'landing-2.html');
  assert.deepEqual({ ...landing, modified: undefined }, { path: 'mockups/landing-2.html', name: 'landing-2.html', group: 'landing', variant: 2, bytes: Buffer.byteLength('<h1>Landing 2</h1>\n'), modified: undefined, sha256: sha('<h1>Landing 2</h1>\n') });
  assert.ok(!Number.isNaN(Date.parse(landing?.modified ?? '')));

  const casa = await call(port, 'GET', '/api/studio/casa/mockups');
  assert.equal(casa.json.folder, 'docs/mockups');
  assert.deepEqual((casa.json.files as { path: string }[]).map((file) => file.path), ['docs/mockups/studio.html']);

  const vuoto = await call(port, 'GET', '/api/studio/vuoto/mockups');
  assert.deepEqual(vuoto.json, { folder: 'mockups', files: [] }, 'a missing folder is an empty list');

  // A folder of mockups that is a link is not read, nor its files.
  assert.equal((await call(port, 'GET', '/api/studio/giro/mockups')).status, 403);
  assert.equal((await call(port, 'GET', '/api/studio/giro/file?path=mockups/pagina.html')).status, 403);
});

test('a project not registered is 404', async (t) => {
  const { port } = await server(t);
  assert.deepEqual((await call(port, 'GET', '/api/studio/altro/mockups')).json, { error: 'not-found' });
  assert.equal((await call(port, 'GET', '/api/studio/altro/mockups')).status, 404);
  assert.equal((await call(port, 'GET', '/api/studio/sito/file?path=mockups/landing.html')).status, 200);
  assert.equal((await call(port, 'GET', '/api/studio/altro/file?path=mockups/landing.html')).status, 404);
});

test('reading: a mockup of the folder, nothing else', async (t) => {
  const { port } = await server(t);
  const read = (path: string) => call(port, 'GET', `/api/studio/sito/file?path=${encodeURIComponent(path)}`);
  const ok = await read('mockups/landing.html');
  assert.deepEqual(ok.json, { path: 'mockups/landing.html', text: '<h1>Landing</h1>\n', sha256: sha('<h1>Landing</h1>\n') });
  const refused = { error: 'refused' };
  for (const path of ['index.html', 'mockups/../index.html', 'mockups/vecchi/old.html', 'mockups/.bozza.html', 'mockups/note.txt', '.git/config.html', 'mockups/link.html', 'mockups/fuori.html', 'mockups/segreto.html', '/etc/hosts']) {
    const answer = await read(path);
    assert.equal(answer.status, 403, path);
    assert.deepEqual(answer.json, refused, path);
  }
  assert.equal((await read('mockups/manca.html')).status, 404, 'a file that is not there');
  assert.equal((await call(port, 'GET', '/api/studio/sito/file')).status, 400, 'no path');
  const large = await read('mockups/grande.html');
  assert.equal(large.status, 413);
  assert.deepEqual(large.json, { error: 'too-large' });
});

test('writing: only with the sha256 read, atomic, the event without the text', async (t) => {
  const { port, events } = await server(t);
  const path = 'mockups/about-1.html';
  const before = readFileSync(join(SITO, path), 'utf8');
  const inode = statSync(join(SITO, path)).ino;
  const put = (body: unknown) => call(port, 'PUT', '/api/studio/sito/file', body);

  const stale = await put({ path, text: '<h1>Nuovo</h1>\n', base: sha('something else') });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, { error: 'changed', sha256: sha(before) });
  assert.equal(readFileSync(join(SITO, path), 'utf8'), before, 'nothing written on a 409');

  const secret = await put({ path, text: `<p>${VAULT_VALUE}</p>`, base: sha(before) });
  assert.equal(secret.status, 403);
  assert.deepEqual(secret.json, { error: 'refused' });
  assert.equal(readFileSync(join(SITO, path), 'utf8'), before);

  const tooLarge = await put({ path, text: 'a'.repeat(2 * 1024 * 1024 + 1), base: sha(before) });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.json, { error: 'too-large' });

  assert.equal((await put({ path, text: 1, base: sha(before) })).status, 400);
  assert.equal((await put({ path, text: 'x', base: 'abc' })).status, 400);
  assert.equal((await put({ path, text: 'x', base: sha(before), extra: true })).status, 400);
  assert.equal((await put({ path: 'mockups/nuovo.html', text: 'x', base: sha('') })).status, 404, 'only a mockup that exists');
  assert.equal((await put({ path: 'mockups/link.html', text: 'x', base: sha('<h1>Index</h1>\n') })).status, 403, 'never through a link');
  assert.equal(readFileSync(join(SITO, 'index.html'), 'utf8'), '<h1>Index</h1>\n');
  assert.equal((await put({ path: '.git/config.html', text: 'x', base: sha('<h1>git</h1>\n') })).status, 403);
  assert.equal((await put({ path, text: 'x', base: sha(before) })).status, 200);
  assert.deepEqual(events.length, 1);

  const text = '<h1>About, nuovo</h1>\n';
  const ok = await put({ path, text, base: sha('x') });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { path, sha256: sha(text) });
  assert.equal(readFileSync(join(SITO, path), 'utf8'), text);
  assert.notEqual(statSync(join(SITO, path)).ino, inode, 'replaced by a rename, not rewritten in place');
  assert.deepEqual(
    readdirSync(join(SITO, 'mockups')).filter((name) => name.includes('studio-tmp')),
    [],
    'no temporary file left',
  );
  assert.deepEqual(events.at(-1), { kind: 'studio.edit', label: 'L1', payload: { project: 'sito', path, before: sha('x'), after: sha(text), bytes: Buffer.byteLength(text) } });
  assert.ok(!JSON.stringify(events).includes('About, nuovo'), 'never the text');
  // The same base again: the file has changed.
  assert.equal((await put({ path, text: 'y', base: sha('x') })).status, 409);
});

test('export: a valid deck of an existing mockup is a .pptx download; an invalid deck is 400', async (t) => {
  const { port, events } = await server(t);
  const deck: Deck = { title: 'Uno', slides: [{ title: 'Uno' }, { title: 'Due' }] };
  const ok = await call(port, 'POST', '/api/studio/casa/pptx', { path: 'docs/mockups/studio.html', deck });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], PPTX_TYPE);
  assert.match(String(ok.headers['content-disposition']), /^attachment; filename="studio\.pptx"/);
  assert.equal(ok.bytes.toString('utf8'), 'PK-fake 2');
  assert.deepEqual(events.at(-1), { kind: 'studio.export', label: 'L0', payload: { project: 'casa', path: 'docs/mockups/studio.html', slides: 2 } });

  const invalid = await call(port, 'POST', '/api/studio/casa/pptx', { path: 'docs/mockups/studio.html', deck: { title: 'x', slides: [] } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.json, { error: 'invalid' });
  assert.equal((await call(port, 'POST', '/api/studio/casa/pptx', { path: 'docs/mockups/manca.html', deck })).status, 404);
  assert.equal((await call(port, 'POST', '/api/studio/sito/pptx', { path: 'mockups/segreto.html', deck })).status, 403);
  assert.equal((await call(port, 'POST', '/api/studio/altro/pptx', { path: 'mockups/landing.html', deck })).status, 404);
  assert.equal(events.length, 1, 'no event for a refused export');
});
