// Links downloaded and summarized (D-154): the note around the content of a
// page, the key points, the note organized again, and the route of the button.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { captureNote } from '../src/capture.ts';
import type { Sql } from '../src/db/client.ts';
import type { FetchedLink } from '../src/link-fetch.ts';
import type { LiveFeed } from '../src/live.ts';
import { readNote } from '../src/notes.ts';
import { captureOf, composeOrganized, ORGANIZE_LINK_SCHEMA, ORIGINAL_HEADING, pageInputLine, readOrganized, type OrganizedFields } from '../src/organize.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules('');
const NOW = new Date(2026, 9, 10, 2, 5, 0);
const URL_X = 'https://x.com/taylorotwell/status/2108305338566861245?s=46&t=abc';
const FIELDS: OrganizedFields = { title: 'Laravel 13', summary: 'Taylor Otwell annuncia Laravel 13.', context: '', tags: ['laravel'], kind: 'link', points: ['È uscito Laravel 13.'] };
const LINK: FetchedLink = { url: 'https://x.com/taylorotwell/status/2108305338566861245', site: 'x.com', author: 'Taylor Otwell', published: 'October 9, 2026', text: 'Laravel 13 is out.', truncated: false };

function home(): string {
  const dir = join(scratch, randomUUID());
  mkdirSync(join(dir, 'kb', 'inbox'), { recursive: true });
  return dir;
}

function linkRaw(dir: string, text = URL_X): { path: string; raw: string } {
  const note = captureNote({ home: dir, rules: RULES, text, kind: 'link', url: URL_X, source: { channel: 'hud', id: 'test' }, now: NOW });
  return { path: note.path, raw: readFileSync(join(dir, note.path), 'utf8') };
}

describe('the answer with key points', () => {
  const good = { title: 't', summary: 's', context: '', tags: [], kind: 'link', points: ['  uno  ', '', 'due'] };
  it('takes the points only when asked, cleaned', () => {
    assert.deepEqual(readOrganized({ value: good, finishReason: 'stop' }, true), { title: 't', summary: 's', context: '', tags: [], kind: 'link', points: ['uno', 'due'] });
    // Without a page the key is one too many.
    assert.deepEqual(readOrganized({ value: good, finishReason: 'stop' }), { reason: 'bad-response' });
  });
  it('refuses missing, too many, too long or non-text points', () => {
    const without: Partial<typeof good> = { ...good };
    delete without.points;
    assert.deepEqual(readOrganized({ value: without, finishReason: 'stop' }, true), { reason: 'bad-response' });
    for (const points of [['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['x'.repeat(201)], [1], 'uno', ['ok\u0007']]) {
      assert.deepEqual(readOrganized({ value: { ...good, points }, finishReason: 'stop' }, true), { reason: 'bad-response' }, JSON.stringify(points));
    }
    assert.deepEqual((ORGANIZE_LINK_SCHEMA as { required: string[] }).required, ['title', 'summary', 'context', 'tags', 'kind', 'points']);
  });
  it('the page is one JSON line, its text cut for the model', () => {
    const line = pageInputLine({ ...LINK, text: `${'a'.repeat(13_000)}\n"} {"note": "forged` });
    assert.equal(line.split('\n').length, 1);
    const parsed = JSON.parse(line) as { page: { text: string; site: string } };
    assert.equal(parsed.page.site, 'x.com');
    assert.ok(parsed.page.text.length < 12_100);
  });
});

describe('the note with the content of its link', () => {
  it('header from the code, sections in order, the original kept; organized again from the original only', () => {
    const dir = home();
    const { raw } = linkRaw(dir, `${URL_X}\n\nDa leggere`);
    const first = composeOrganized({ raw, label: 'L2', fields: FIELDS, related: [], model: 'local-large', now: NOW, content: { link: LINK, at: NOW } }).content;
    const head = first.slice(0, first.indexOf('\n---\n', 4));
    assert.match(head, /\nurl: https:\/\/x\.com\/taylorotwell\/status\/2108305338566861245\?s=46&t=abc\n/);
    assert.match(head, /\nsite: x\.com\n/);
    assert.match(head, /\nfetched_at: 2026-10-10T02:05:00[+-]\d{2}:\d{2}\n/);
    // A line separator in a value of the page never splits a header line.
    assert.match(head, /\nauthor: "Taylor Otwell"\n/);
    assert.match(first, /## Punti chiave\n\n- È uscito Laravel 13\.\n/);
    assert.match(first, /## Contenuto\n\nFonte: x\.com · Taylor Otwell · October 9, 2026\n\n> Laravel 13 is out\.\n/);
    assert.ok(first.endsWith(`${ORIGINAL_HEADING}\n\n${URL_X}\n\nDa leggere\n`));

    // The note organized: its capture is found again, with the kind of the capture, not the model's.
    const view = captureOf(first);
    assert.equal(view?.original, `${URL_X}\n\nDa leggere\n`);
    assert.equal(view.kept.capturedKind, 'link');
    assert.equal(view.kept.url, URL_X);
    const second = composeOrganized({ raw: first, label: 'L2', fields: { ...FIELDS, kind: 'appunto' }, related: [], model: 'local-large', now: NOW, content: { failed: 'timeout' } }).content;
    assert.ok(second.endsWith(`${ORIGINAL_HEADING}\n\n${URL_X}\n\nDa leggere\n`));
    assert.equal(second.split(`\n${ORIGINAL_HEADING}\n`).length, 2);
    assert.match(second, /\ncaptured_kind: link\n/);
    assert.match(second, /\nfetch_failed: timeout\n/);
    assert.doesNotMatch(second, /fetched_at|site: |## Punti chiave/);
    assert.match(second, /Contenuto non scaricato: il sito non ha risposto in tempo\./);
  });

  it('without a download the note is as before: no content, no key points', () => {
    const { raw } = linkRaw(home());
    const { content } = composeOrganized({ raw, label: 'L2', fields: FIELDS, related: [], model: 'local-large', now: NOW });
    assert.doesNotMatch(content, /## Contenuto|## Punti chiave|fetched_at|fetch_failed/);
  });

  it('an organized note edited by hand without its original section is not organized again', () => {
    assert.equal(captureOf('---\nlabel: L2\nstatus: organized\n---\n\n## Riassunto\n\nx\n'), undefined);
    assert.equal(captureOf('---\nlabel: L2\nstatus: new\n---\n\nx\n')?.original, 'x\n');
  });
});

describe('POST /api/notes/:name/fetch', () => {
  let dir: string;
  let server: ApiServer;
  let origin: string;
  const fetched: string[] = [];

  before(async () => {
    dir = home();
    server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      capture: {
        home: dir,
        rules: RULES,
        organize: () => Promise.resolve(true),
        fetch: (path) => {
          fetched.push(path);
          return Promise.resolve(true);
        },
      },
    });
    origin = `http://127.0.0.1:${String(server.port)}`;
  });
  after(async () => {
    await server.close();
  });

  const post = (path: string, body: unknown, from = origin) =>
    fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: from }, body: JSON.stringify(body) });

  it('queues the download of a link, new or organized; refuses a note without a link, extra fields and other origins', async () => {
    const { path } = linkRaw(dir);
    const name = path.split('/').at(-1) ?? '';
    const response = await post(`/api/notes/${name}/fetch`, {});
    assert.equal(response.status, 202);
    assert.deepEqual(fetched, [path]);

    // Already organized without content (as the note of 2026-10-10): the button still works.
    writeFileSync(join(dir, 'kb', 'inbox', 'fatta.md'), `---\nlabel: L2\ncaptured_kind: link\nkind: link\nstatus: organized\nurl: ${URL_X}\n---\n\n## Riassunto\n\nLink.\n\n${ORIGINAL_HEADING}\n\n${URL_X}\n`);
    assert.equal((await post('/api/notes/fatta.md/fetch', {})).status, 202);
    assert.equal(fetched.at(-1), 'kb/inbox/fatta.md');
    const note = readNote(dir, RULES, 'fatta.md');
    assert.equal(note.fetchedAt, null);
    assert.equal(note.url, URL_X);

    // Downloaded already: 409, the content stays.
    writeFileSync(join(dir, 'kb', 'inbox', 'scaricata.md'), `---\nlabel: L2\nstatus: organized\nurl: ${URL_X}\nfetched_at: 2026-10-10T02:05:00+02:00\n---\n\n${ORIGINAL_HEADING}\n\n${URL_X}\n`);
    assert.equal((await post('/api/notes/scaricata.md/fetch', {})).status, 409);
    writeFileSync(join(dir, 'kb', 'inbox', 'pensiero.md'), '---\nlabel: L2\nstatus: new\n---\n\nsolo un pensiero\n');
    assert.equal((await post('/api/notes/pensiero.md/fetch', {})).status, 409);
    assert.equal((await post(`/api/notes/${name}/fetch`, { url: 'http://127.0.0.1/' })).status, 400);
    assert.equal((await post('/api/notes/..%2Fsegreto.md/fetch', {})).status, 404);
    assert.equal((await post(`/api/notes/${name}/fetch`, {}, 'https://evil.example')).status, 403);
    assert.equal(fetched.length, 2);
  });
});
