// The route of "Proponi bozza" (I-14 R2, D-175): status codes, one draft at a
// time, nothing else. No database and no model: the draft is a stand-in.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { Project } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import type { DraftOutcome } from '../src/rules-draft.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';

const SITE: Project = { name: 'sito', path: 'repos/sito', absolute: '/nowhere/sito', label: 'L1' };

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function post(origin: string, path: string, body: unknown = {}): Promise<Reply> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), origin } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

async function serve(rulesDraft?: (container: string) => Promise<DraftOutcome | undefined>): Promise<{ server: ApiServer; origin: string }> {
  const server = await startApiServer({
    // Unused by this route.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    projectContainers: () => [SITE],
    ...(rulesDraft === undefined ? {} : { rulesDraft }),
  });
  return { server, origin: `http://127.0.0.1:${String(server.port)}` };
}

describe('POST /api/projects/:project/rules-draft (D-175)', () => {
  let next: () => Promise<DraftOutcome | undefined> = () => Promise.resolve({ ok: true, text: '- Usa pnpm.', model: 'stub' });
  const asked: string[] = [];
  let api: { server: ApiServer; origin: string };
  let bare: { server: ApiServer; origin: string };

  before(async () => {
    api = await serve((container) => {
      asked.push(container);
      return next();
    });
    bare = await serve();
  });

  after(async () => {
    await api.server.close();
    await bare.server.close();
  });

  it('answers the draft of an approved container, saving nothing', async () => {
    next = () => Promise.resolve({ ok: true, text: '- Usa pnpm.', model: 'stub' });
    assert.deepEqual(await post(api.origin, '/api/projects/sito/rules-draft'), { status: 200, body: { text: '- Usa pnpm.', model: 'stub' } });
    assert.deepEqual(asked.splice(0), ['sito']);
    // A partial draft says why the model added nothing.
    next = () => Promise.resolve({ ok: true, text: '- Usa pnpm.', model: null, partial: 'timeout' });
    assert.deepEqual(await post(api.origin, '/api/projects/sito/rules-draft'), { status: 200, body: { text: '- Usa pnpm.', model: null, partial: 'timeout' } });
    asked.length = 0;
  });

  it('refuses an unknown or malformed project, an extra field, and a core without drafts', async () => {
    assert.equal((await post(api.origin, '/api/projects/altro/rules-draft')).status, 404);
    assert.equal((await post(api.origin, '/api/projects/Sito%20X/rules-draft')).status, 404);
    assert.equal((await post(api.origin, '/api/projects/sito/rules-draft', { text: 'x' })).status, 400);
    assert.equal((await post(bare.origin, '/api/projects/sito/rules-draft')).status, 503);
    assert.deepEqual(asked.splice(0), []);
  });

  it('a failure is its status, never a draft; the next request runs again', async () => {
    const cases: [Extract<DraftOutcome, { ok: false }>['reason'], number][] = [
      ['blocked', 403],
      ['unavailable', 503],
      ['timeout', 504],
      ['truncated', 502],
      ['bad-response', 502],
      ['model-error', 502],
    ];
    for (const [reason, status] of cases) {
      next = () => Promise.resolve({ ok: false, reason });
      const reply = await post(api.origin, '/api/projects/sito/rules-draft');
      assert.equal(reply.status, status, reason);
      assert.equal(reply.body.text, undefined);
    }
    next = () => Promise.reject(new Error('stub: crash'));
    assert.equal((await post(api.origin, '/api/projects/sito/rules-draft')).status, 500);
    next = () => Promise.resolve({ ok: true, text: '- x', model: 'stub' });
    assert.equal((await post(api.origin, '/api/projects/sito/rules-draft')).status, 200, 'released after every failure');
    asked.length = 0;
  });

  it('one draft at a time: a second request while one runs is 409', async () => {
    let release: (outcome: DraftOutcome) => void = () => undefined;
    next = () => new Promise((resolve) => { release = resolve; });
    const first = post(api.origin, '/api/projects/sito/rules-draft');
    while (asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await post(api.origin, '/api/projects/sito/rules-draft')).status, 409);
    release({ ok: true, text: '- y', model: 'stub' });
    assert.equal((await first).status, 200);
    asked.length = 0;
  });
});
