// The routes of the clients (I-16, D-168) refuse before the database: unknown
// fields, fields that do not pass (with the issues the chat shows), a project
// not approved, a logo that is not a PNG, JPEG or WebP or is too large, an id
// that is not one. The database is never reached here: its stand-in fails
// the test if it is.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const ID = '7d9f1c2e-1111-4a5b-8c9d-0123456789ab';

function send(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the clients refuse before the database what does not pass', async (t) => {
  const reached: string[] = [];
  const sql = new Proxy(() => undefined, {
    get: (_target, key) => {
      reached.push(String(key));
      throw new Error('the database was reached');
    },
    apply: () => {
      reached.push('query');
      throw new Error('the database was reached');
    },
  }) as unknown as Sql;
  const server = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, projectContainers: () => [{ name: 'progetto-test', path: 'repos/progetto-test', absolute: '/nowhere', label: 'L1' }], clients: { dir: '/nowhere/clients' } });
  t.after(async () => {
    await server.close();
  });

  const unknown = await send(server.port, 'POST', '/api/clients', { displayName: 'Rossi Srl', colore: 'blu' });
  assert.equal(unknown.status, 400);

  const wrong = await send(server.port, 'POST', '/api/clients', { displayName: 'Rossi Srl', vatNumber: '12345678901', country: 'IT', sdiCode: 'XXXXXXX' });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body.issues, [
    { field: 'vatNumber', code: 'checksum' },
    { field: 'sdiCode', code: 'not-allowed' },
  ]);

  const nameless = await send(server.port, 'POST', '/api/clients', {});
  assert.deepEqual(nameless.body.issues, [{ field: 'displayName', code: 'required' }]);

  assert.equal((await send(server.port, 'POST', `/api/clients/${ID}/contacts`, { name: 'Anna', compleanno: '1/1' })).status, 400);
  const contact = await send(server.port, 'POST', `/api/clients/${ID}/contacts`, { name: '', email: 'anna' });
  assert.equal(contact.status, 400);
  assert.deepEqual(contact.body.issues, [
    { field: 'name', code: 'required' },
    { field: 'email', code: 'format' },
  ]);

  assert.equal((await send(server.port, 'POST', `/api/clients/${ID}/projects`, { project: 'altro' })).status, 400);
  assert.equal((await send(server.port, 'POST', `/api/clients/${ID}/projects`, { project: '../fuori' })).status, 400);
  assert.equal((await send(server.port, 'POST', `/api/clients/${ID}/archive`, { archived: 'sì' })).status, 400);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const notImage = await send(server.port, 'POST', `/api/clients/${ID}/logo`, { type: 'image/svg+xml', data: svg });
  assert.equal(notImage.status, 400);
  assert.deepEqual(notImage.body.issues, [{ field: 'logo', code: 'format' }]);
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024)]).toString('base64');
  const tooBig = await send(server.port, 'POST', `/api/clients/${ID}/logo`, { type: 'image/png', data: big });
  assert.ok(tooBig.status === 400 || tooBig.status === 413, String(tooBig.status));
  assert.equal((await send(server.port, 'POST', `/api/clients/${ID}/logo`, { data: 'non base64!' })).status, 400);

  assert.equal((await send(server.port, 'GET', '/api/clients/not-an-id')).status, 404);
  assert.equal((await send(server.port, 'GET', '/api/clients/of-project/..%2Ffuori')).status, 404);
  assert.deepEqual(reached, []);
});

test('without the folder of the logos the logo routes answer 404', async (t) => {
  const sql = { unsafe: () => Promise.resolve([]) } as unknown as Sql;
  const server = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await server.close();
  });
  assert.equal((await send(server.port, 'GET', `/api/clients/${ID}/logo`)).status, 404);
  assert.equal((await send(server.port, 'POST', `/api/clients/${ID}/logo`, { data: '' })).status, 404);
});
