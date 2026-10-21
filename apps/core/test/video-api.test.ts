// «Riassumi il video» (D-273): the routes of the chat. The job itself is in
// test-db/video.test.ts; here only what the routes accept and refuse.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { captureNote } from '../src/capture.ts';
import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { readNote } from '../src/notes.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import type { VideoJobState } from '../src/video-job.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules('');
const VIDEO = 'https://youtu.be/dQw4w9WgXcQ?si=abc';

describe('POST and GET /api/notes/:name/video', () => {
  let dir: string;
  let server: ApiServer;
  let origin: string;
  const queued: string[] = [];
  const states = new Map<string, VideoJobState>();

  before(async () => {
    dir = join(scratch, 'home');
    mkdirSync(join(dir, 'kb', 'inbox'), { recursive: true });
    server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      capture: {
        home: dir,
        rules: RULES,
        organize: () => Promise.resolve(true),
        fetch: () => Promise.resolve(true),
        video: (path) => {
          queued.push(path);
          states.set(path, { state: 'queued' });
          return Promise.resolve(true);
        },
        videoState: (path) => Promise.resolve(states.get(path)),
      },
    });
    origin = `http://127.0.0.1:${String(server.port)}`;
  });
  after(async () => {
    await server.close();
  });

  const post = (path: string, body: unknown, from = origin) =>
    fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: from }, body: JSON.stringify(body) });
  const get = async (path: string) => (await fetch(`${origin}${path}`)).json() as Promise<{ video: (VideoJobState & { reasonText?: string }) | null }>;

  it('queues a video only when approved; never «Scarica e riassumi» for a video', async () => {
    const note = captureNote({ home: dir, rules: RULES, text: VIDEO, kind: 'link', url: VIDEO, source: { channel: 'hud', id: 'test' }, now: new Date(2026, 9, 21, 9, 0, 0) });
    const name = note.path.split('/').at(-1) ?? '';
    assert.deepEqual(await get(`/api/notes/${name}/video`), { video: null });
    assert.equal((await post(`/api/notes/${name}/video`, {})).status, 400);
    assert.equal((await post(`/api/notes/${name}/video`, { approved: 'yes' })).status, 400);
    assert.equal((await post(`/api/notes/${name}/video`, { approved: true, url: 'https://evil.example/' })).status, 400);
    assert.equal((await post(`/api/notes/${name}/video`, { approved: true }, 'https://evil.example')).status, 403);
    assert.deepEqual(queued, []);
    const response = await post(`/api/notes/${name}/video`, { approved: true });
    assert.equal(response.status, 202);
    assert.deepEqual(queued, [note.path]);
    assert.deepEqual(await get(`/api/notes/${name}/video`), { video: { state: 'queued' } });
    // The link downloader of D-154 never takes a video.
    assert.equal((await post(`/api/notes/${name}/fetch`, {})).status, 409);

    states.set(note.path, { state: 'failed', reason: 'too-long' });
    assert.deepEqual(await get(`/api/notes/${name}/video`), { video: { state: 'failed', reason: 'too-long', reasonText: 'il video dura più di 2 ore' } });
  });

  it('refuses a note without a video, a playlist and a video already summarized', async () => {
    writeFileSync(join(dir, 'kb', 'inbox', 'pensiero.md'), '---\nlabel: L2\nstatus: new\n---\n\nsolo un pensiero\n');
    assert.equal((await post('/api/notes/pensiero.md/video', { approved: true })).status, 409);
    writeFileSync(join(dir, 'kb', 'inbox', 'lista.md'), '---\nlabel: L2\nkind: link\nstatus: new\nurl: https://www.youtube.com/playlist?list=PL1234567890\n---\n\nlista\n');
    assert.equal((await post('/api/notes/lista.md/video', { approved: true })).status, 409);
    writeFileSync(
      join(dir, 'kb', 'inbox', 'fatto.md'),
      '---\nlabel: L2\nkind: link\nstatus: organized\nurl: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nmedia: youtube\nvideo_id: dQw4w9WgXcQ\nchannel: "Canale finto"\nduration: 754\ntranscript_source: automatic\n---\n\n## Riassunto\n\nx\n\n## Testo originale\n\nx\n',
    );
    assert.equal((await post('/api/notes/fatto.md/video', { approved: true })).status, 409);
    assert.equal((await post('/api/notes/..%2Fsegreto.md/video', { approved: true })).status, 404);
    assert.deepEqual(readNote(dir, RULES, 'fatto.md').video, { id: 'dQw4w9WgXcQ', channel: 'Canale finto', duration: 754, transcriptSource: 'automatic' });
    assert.equal(readNote(dir, RULES, 'pensiero.md').video, null);
  });
});
