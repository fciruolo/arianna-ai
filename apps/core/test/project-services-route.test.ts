// The routes of the tab Servizi (D-134, tappa 2): only an id of the list, the fingerprint of what was confirmed, never a command.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { createServiceManager, listServices } from '../src/project-services.ts';
import { startApiServer } from '../src/server/http.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `services-route-${randomUUID()}`);
const ROOT = join(HOME, 'orto');
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const PROJECTS: Project[] = [{ name: 'orto', path: 'repos/orto', absolute: ROOT, label: 'L1' }];

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('start: a body with a command, a bad id, an unknown service or project, no or a stale fingerprint are refused; the right one runs the argv of the file', async (t) => {
  let busy = false;
  const sql = { unsafe: () => Promise.resolve(busy ? [{ id: '1' }] : []) } as unknown as Sql;
  const spawned: string[][] = [];
  const services = createServiceManager({
    spawn: (command, args) => {
      spawned.push([command, ...args]);
      throw new Error('not run in the test');
    },
  });
  const server = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, approvedProjects: () => PROJECTS, services });
  t.after(async () => {
    await server.close();
  });
  const [listed] = await listServices(ROOT);
  assert.ok(listed !== undefined);
  const start = (body: unknown, project = 'orto') => post(server.port, `/api/browse/${project}/services/start`, body);

  assert.equal((await start({ service: 'package.json:test', fingerprint: listed.fingerprint, command: ['rm', '-rf', '/'] })).status, 400);
  assert.equal((await start({ service: 'rm -rf /', fingerprint: listed.fingerprint })).status, 400);
  assert.equal((await start({ service: 'package.json:build', fingerprint: listed.fingerprint })).status, 404);
  assert.equal((await start({ service: 'package.json:test' })).status, 400);
  assert.equal((await start({ service: 'package.json:test', fingerprint: '0000000000000000' })).status, 409);
  assert.equal((await start({ service: 'package.json:test', fingerprint: listed.fingerprint }, 'altro')).status, 403);
  busy = true;
  assert.equal((await start({ service: 'package.json:test', fingerprint: listed.fingerprint })).status, 409, 'not while the Coder works there');
  busy = false;
  assert.deepEqual(spawned, []);
  assert.equal((await start({ service: 'package.json:test', fingerprint: listed.fingerprint })).status, 200);
  assert.deepEqual(spawned, [['npm', 'run', 'test']]);
  // Stopping what was not started here is refused.
  assert.equal((await post(server.port, '/api/browse/orto/services/stop', { service: 'package.json:test' })).status, 409);
});

test('without a manager the routes answer 404', async (t) => {
  const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, approvedProjects: () => PROJECTS });
  t.after(async () => {
    await server.close();
  });
  assert.equal((await post(server.port, '/api/browse/orto/services/start', { service: 'package.json:test', fingerprint: '0000000000000000' })).status, 404);
});
