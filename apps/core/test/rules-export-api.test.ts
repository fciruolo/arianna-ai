// The routes of "Esporta in CLAUDE.md e AGENTS.md" (I-14 R3, D-176): status
// codes and fields. No database and no files: the exporter is a stand-in.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { Project } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import type { ExportOutcome, ExportPlan } from '../src/rules-export.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';

const SITE: Project = { name: 'sito', path: 'repos/sito', absolute: '/nowhere/sito', label: 'L1' };

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function send(origin: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      { method, agent: false, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), origin } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

async function serve(rulesExport?: { plan: (container: string) => ExportPlan | null; write: (container: string, seen: ExportPlan) => ExportOutcome }): Promise<{ server: ApiServer; origin: string }> {
  const server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    projectContainers: () => [SITE],
    ...(rulesExport === undefined ? {} : { rulesExport }),
  });
  return { server, origin: `http://127.0.0.1:${String(server.port)}` };
}

describe('/api/projects/:project/rules-export (D-176)', () => {
  let plan: ExportPlan | null = { text: 'Usa pnpm.\n', files: [{ path: 'CLAUDE.md', status: 'new' }] };
  let outcome: ExportOutcome = { ok: true, files: [{ path: 'CLAUDE.md', status: 'written' }] };
  const written: [string, ExportPlan][] = [];
  let api: { server: ApiServer; origin: string };
  let bare: { server: ApiServer; origin: string };

  before(async () => {
    api = await serve({
      plan: () => plan,
      write: (container, seen) => {
        written.push([container, seen]);
        return outcome;
      },
    });
    bare = await serve();
  });

  after(async () => {
    await api.server.close();
    await bare.server.close();
  });

  it('answers the preview, and 409 for a project without rules', async () => {
    assert.deepEqual(await send(api.origin, 'GET', '/api/projects/sito/rules-export'), { status: 200, body: { text: 'Usa pnpm.\n', files: [{ path: 'CLAUDE.md', status: 'new' }] } });
    plan = null;
    assert.equal((await send(api.origin, 'GET', '/api/projects/sito/rules-export')).status, 409);
    plan = { text: 'Usa pnpm.\n', files: [] };
  });

  it('writes the text of the preview and answers what it did', async () => {
    outcome = { ok: true, files: [{ path: 'CLAUDE.md', status: 'written' }] };
    const seen: ExportPlan = { text: 'Usa pnpm.\n', files: [{ path: 'CLAUDE.md', status: 'new' }] };
    assert.deepEqual(await send(api.origin, 'POST', '/api/projects/sito/rules-export', seen), { status: 200, body: { files: [{ path: 'CLAUDE.md', status: 'written' }] } });
    assert.deepEqual(written.splice(0), [['sito', seen]]);
    outcome = { ok: false, reason: 'files-changed' };
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', seen)).status, 409);
    outcome = { ok: false, reason: 'changed' };
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', { text: 'x', files: [] })).status, 409);
    outcome = { ok: false, reason: 'no-rules' };
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', { text: 'x', files: [] })).status, 409);
    written.length = 0;
  });

  it('refuses an unknown project, a missing or extra field, and a core without export', async () => {
    assert.equal((await send(api.origin, 'GET', '/api/projects/altro/rules-export')).status, 404);
    assert.equal((await send(api.origin, 'POST', '/api/projects/altro/rules-export', { text: 'x', files: [] })).status, 404);
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', {})).status, 400);
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', { text: 'x' })).status, 400);
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', { text: 'x', files: [{ path: 'CLAUDE.md', status: 'mio' }] })).status, 400);
    assert.equal((await send(api.origin, 'POST', '/api/projects/sito/rules-export', { text: 'x', files: [], force: true })).status, 400);
    assert.equal((await send(bare.origin, 'GET', '/api/projects/sito/rules-export')).status, 503);
    assert.equal((await send(bare.origin, 'POST', '/api/projects/sito/rules-export', { text: 'x', files: [] })).status, 503);
    assert.deepEqual(written, []);
  });
});
