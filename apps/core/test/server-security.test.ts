import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

import { allowedHosts, checkRequest, securityHeaders, type RequestFacts } from '../src/server/security.ts';

const HOSTS = allowedHosts('127.0.0.1', 7420);
const SAME = 'http://127.0.0.1:7420';

function facts(extra: Partial<RequestFacts>): RequestFacts {
  return { method: 'GET', host: '127.0.0.1:7420', origin: undefined, contentType: undefined, ...extra };
}

test('the server answers to its own address and to localhost, with its port', () => {
  assert.deepEqual([...HOSTS].sort(), ['127.0.0.1:7420', 'localhost:7420']);
  assert.deepEqual([...allowedHosts('::1', 7420)].sort(), ['[::1]:7420', 'localhost:7420']);
  assert.deepEqual(checkRequest(facts({ host: 'LOCALHOST:7420' }), HOSTS), { ok: true });
});

test('another Host is refused: DNS rebinding', () => {
  for (const host of ['evil.example:7420', '127.0.0.1', '127.0.0.1:80', 'localhost.evil.example:7420', undefined]) {
    assert.deepEqual(checkRequest(facts({ host }), HOSTS), { ok: false, status: 403, reason: 'unknown host' }, String(host));
  }
});

test('a request from another origin is refused, a same-origin one passes', () => {
  assert.deepEqual(checkRequest(facts({ origin: SAME }), HOSTS), { ok: true });
  for (const origin of ['http://evil.example', 'https://127.0.0.1:7420', 'http://127.0.0.1:5173', 'null']) {
    const result = checkRequest(facts({ method: 'POST', origin, contentType: 'application/json' }), HOSTS);
    assert.equal(result.ok, false, origin);
  }
});

test('the Origin must match the Host the browser used', () => {
  assert.equal(checkRequest(facts({ host: 'localhost:7420', origin: SAME }), HOSTS).ok, false);
  assert.equal(checkRequest(facts({ host: 'localhost:7420', origin: 'http://localhost:7420' }), HOSTS).ok, true);
});

test('state-changing requests need a JSON body: no form can send one', () => {
  for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    assert.deepEqual(
      checkRequest(facts({ method: 'POST', origin: SAME, contentType }), HOSTS),
      { ok: false, status: 415, reason: 'content type must be application/json' },
      String(contentType),
    );
  }
  assert.deepEqual(checkRequest(facts({ method: 'POST', origin: SAME, contentType: 'application/json; charset=utf-8' }), HOSTS), { ok: true });
  // Reads need no body.
  assert.deepEqual(checkRequest(facts({ method: 'GET' }), HOSTS), { ok: true });
});

test('a WebSocket handshake needs a same-origin Origin', () => {
  assert.deepEqual(checkRequest(facts({ upgrade: true }), HOSTS), { ok: false, status: 403, reason: 'missing origin' });
  assert.equal(checkRequest(facts({ upgrade: true, origin: 'http://evil.example' }), HOSTS).ok, false);
  assert.deepEqual(checkRequest(facts({ upgrade: true, origin: SAME }), HOSTS), { ok: true });
});

test('responses forbid framing, sniffing and foreign scripts', () => {
  const headers = securityHeaders('127.0.0.1:7420');
  assert.match(headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.match(headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.match(headers['content-security-policy'] ?? '', /connect-src 'self' ws:\/\/127\.0\.0\.1:7420/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
});

// The capture route of D-080 behind the same checks, on a real server.
test('POST /api/capture: same origin, known Host, JSON only, POST only', async () => {
  const dir = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
  mkdirSync(join(dir, 'kb'), { recursive: true });
  const server = await startApiServer({
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    capture: { home: dir, rules: parseLabelRules('') },
  });
  const port = server.port;
  const send = (method: string, headers: Record<string, string>, body = '{"text":"una nota"}') =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/api/capture', method, headers }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end(method === 'GET' ? undefined : body);
    });
  const same = `http://127.0.0.1:${String(port)}`;
  try {
    assert.equal(await send('POST', { 'content-type': 'application/json', origin: same }), 201);
    assert.equal(await send('POST', { 'content-type': 'application/json', origin: 'http://evil.example' }), 403);
    assert.equal(await send('POST', { 'content-type': 'application/json', host: `evil.example:${String(port)}` }), 403);
    assert.equal(await send('POST', { 'content-type': 'text/plain', origin: same }), 415);
    assert.equal(await send('GET', { origin: same }), 405);
    assert.equal(readdirSync(join(dir, 'kb', 'inbox')).length, 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
