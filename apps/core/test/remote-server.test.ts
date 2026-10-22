import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { parseLabelRules, remotePaths, resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { findOpenssl, generateCertificate, loadRemoteTls } from '../src/remote-cert.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { remoteAccess } from '../src/server/remote.ts';
import { checkRequest, remoteDoor, securityHeaders } from '../src/server/security.ts';

// D-292: the remote port behind `tailscale serve`. Made-up name and files, in data/test-tmp.
const NAME = 'mac-prova.tail0000.ts.net';
const ORIGIN = `https://${NAME}`;
const root = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
const dist = join(root, 'dist');
let server: ApiServer;

before(async () => {
  mkdirSync(join(root, 'kb'), { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Arianna</title>');
  writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("push", () => {});');
  server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    capture: { home: root, rules: parseLabelRules('') },
    staticDir: dist,
    remote: { host: NAME, port: 0 },
  });
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function opensslWorks(binary: string): boolean {
  try {
    execFileSync(binary, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(options: { host?: string; port: number; path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: options.host ?? '127.0.0.1', port: options.port, path: options.path, method: options.method ?? 'GET', headers: options.headers ?? {} },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

const remote = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) =>
  send({ port: server.remotePort ?? -1, path, method, headers: { host: NAME, ...headers }, ...(body === undefined ? {} : { body }) });

test('the remote door accepts only its name, with or without :443, and only its https origin', () => {
  const door = remoteDoor(NAME);
  const facts = (host: string | undefined, origin?: string) => ({ method: 'GET', host, origin, contentType: undefined });
  assert.deepEqual(checkRequest(facts(NAME), door.hosts, door.origin), { ok: true });
  assert.deepEqual(checkRequest(facts(`${NAME}:443`, ORIGIN), door.hosts, door.origin), { ok: true });
  assert.deepEqual(checkRequest(facts(NAME.toUpperCase(), ORIGIN), door.hosts, door.origin), { ok: true });
  for (const host of ['127.0.0.1:7443', 'localhost:7443', `${NAME}:8443`, 'altro.tail0000.ts.net', `evil.example`, undefined]) {
    assert.equal(checkRequest(facts(host), door.hosts, door.origin).ok, false, String(host));
  }
  for (const origin of [`http://${NAME}`, `https://${NAME}:443`, 'https://evil.example', 'http://127.0.0.1:7420', 'null']) {
    assert.equal(checkRequest(facts(NAME, origin), door.hosts, door.origin).ok, false, origin);
  }
  // The socket of a remote page needs the origin too.
  assert.equal(checkRequest({ ...facts(NAME), upgrade: true }, door.hosts, door.origin).ok, false);
});

test('the headers of the remote port: wss:// of the name and HSTS; the port of this Mac unchanged', () => {
  const headers = securityHeaders(NAME, true);
  assert.match(headers['content-security-policy'] ?? '', new RegExp(`connect-src 'self' wss://${NAME.replaceAll('.', '\\.')};`));
  assert.equal(headers['strict-transport-security'], 'max-age=31536000');
  const local = securityHeaders('127.0.0.1:7420');
  assert.match(local['content-security-policy'] ?? '', /connect-src 'self' ws:\/\/127\.0\.0\.1:7420;/);
  assert.equal(local['strict-transport-security'], undefined);
});

test('remoteAccess: until stage B only the state, never the API or a socket', () => {
  const request = { method: 'GET', headers: {} };
  assert.deepEqual(remoteAccess(request, '/api/remote/status'), { kind: 'status', body: { paired: false } });
  for (const path of ['/api/conversations', '/api/ws', '/api/notifications/stream', '/api/remote/status/x', '/api/push/subscribe']) {
    assert.equal(remoteAccess(request, path).kind, 'refused', path);
  }
  assert.equal(remoteAccess({ method: 'POST', headers: {} }, '/api/remote/status').kind, 'refused');
  assert.equal(remoteAccess(request, '/api/remote/status', true).kind, 'refused');
  // A header claiming a session or a Tailscale user changes nothing.
  assert.equal(remoteAccess({ method: 'GET', headers: { cookie: 'session=x', 'tailscale-user-login': 'a@example.org' } }, '/api/conversations').kind, 'refused');
});

test('the remote port serves the files of the chat and the state of the pairing', async () => {
  assert.notEqual(server.remotePort, undefined);
  assert.notEqual(server.remotePort, server.port);
  const page = await remote('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Arianna<\/title>/);
  assert.match(String(page.headers['content-security-policy']), /wss:\/\/mac-prova\.tail0000\.ts\.net/);
  assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal((await remote('/sw.js', { host: `${NAME}:443` })).status, 200);
  // A client-side route of the chat: index.html.
  assert.equal((await remote('/impostazioni')).status, 200);
  const state = await remote('/api/remote/status', { origin: ORIGIN });
  assert.equal(state.status, 200);
  assert.deepEqual(JSON.parse(state.body), { paired: false });
});

test('every other route of the API is refused on the remote port with device-not-paired', async () => {
  for (const [method, path] of [
    ['GET', '/api/conversations'],
    ['GET', '/api/notifications/stream'],
    ['GET', '/api/does-not-exist'],
    ['POST', '/api/capture'],
  ] as const) {
    const answer = await remote(path, { origin: ORIGIN, 'content-type': 'application/json', 'x-arianna-helper': '1' }, method, method === 'POST' ? '{"text":"una nota"}' : undefined);
    assert.equal(answer.status, 401, `${method} ${path}`);
    assert.deepEqual(JSON.parse(answer.body), { error: 'device not paired', code: 'device-not-paired' });
  }
});

test('the remote port refuses another Host or Origin before anything else', async () => {
  for (const host of [`127.0.0.1:${String(server.remotePort)}`, `localhost:${String(server.remotePort)}`, 'evil.example', `${NAME}:8443`]) {
    assert.equal((await remote('/', { host })).status, 403, host);
    assert.equal((await remote('/api/remote/status', { host })).status, 403, host);
  }
  for (const origin of ['https://evil.example', `http://${NAME}`, `http://127.0.0.1:${String(server.port)}`]) {
    assert.equal((await remote('/api/remote/status', { origin })).status, 403, origin);
  }
  // Forwarding headers do not make a request local or trusted.
  assert.equal((await remote('/api/capture', { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': `127.0.0.1:${String(server.port)}` }, 'POST', '{"text":"x"}')).status, 401);
});

test('no WebSocket on the remote port: 401 with the right origin, 403 with another', async () => {
  const handshake = (headers: Record<string, string>) =>
    remote('/api/ws', { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers });
  assert.equal((await handshake({ origin: ORIGIN })).status, 401);
  assert.equal((await handshake({ origin: 'https://evil.example' })).status, 403);
});

test('the port of this Mac is unchanged: its own Host and origin, the API open, no HSTS', async () => {
  const local = `http://127.0.0.1:${String(server.port)}`;
  const created = await send({ port: server.port, path: '/api/capture', method: 'POST', headers: { origin: local, 'content-type': 'application/json' }, body: '{"text":"una nota"}' });
  assert.equal(created.status, 201);
  assert.equal(created.headers['strict-transport-security'], undefined);
  // The name of the tailnet is not a Host of the port of this Mac.
  assert.equal((await send({ port: server.port, path: '/', headers: { host: NAME } })).status, 403);
  assert.equal((await send({ port: server.port, path: '/api/remote/status', headers: { origin: local } })).status, 404);
});

test('the remote port listens on 127.0.0.1 only, even when the port of this Mac is on ::1', async () => {
  const other = await startApiServer({
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '::1',
    port: 0,
    staticDir: dist,
    remote: { host: NAME, port: 0 },
  });
  try {
    const port = other.remotePort ?? -1;
    assert.equal((await send({ port, path: '/', headers: { host: NAME } })).status, 200);
    await assert.rejects(send({ host: '::1', port, path: '/', headers: { host: NAME } }), { code: 'ECONNREFUSED' });
  } finally {
    await other.close();
  }
});

test('a remote port already taken closes only the remote port: the port of this Mac stays up', async () => {
  const errors: unknown[] = [];
  const taken = await startApiServer({
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    staticDir: dist,
    remote: { host: NAME, port: server.remotePort ?? -1 },
    onRemoteError: (error) => errors.push(error),
  });
  try {
    assert.equal(taken.remotePort, undefined);
    assert.equal(errors.length, 1);
    assert.equal((await send({ port: taken.port, path: '/' })).status, 200);
  } finally {
    await taken.close();
  }
});

test('a WebSocket to the screen of the browser is refused on the remote port too', async () => {
  const answer = await remote('/api/browser/screen?t=x', { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: ORIGIN });
  assert.equal(answer.status, 401);
});

test('without [server.remote] there is no remote port', async () => {
  const plain = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
  try {
    assert.equal(plain.remotePort, undefined);
  } finally {
    await plain.close();
  }
});

test('tls = "own": the remote port ends TLS with the certificate of data/remote, trusted only through its root', { skip: !opensslWorks(findOpenssl()) }, async () => {
  const paths = remotePaths(join(root, 'tls'));
  generateCertificate({ openssl: findOpenssl(), paths, host: NAME, now: new Date() });
  const tls = loadRemoteTls(paths, NAME, new Date());
  assert.ok(tls.ok);
  const own = await startApiServer({
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    staticDir: dist,
    remote: { host: NAME, port: 0, tls: { cert: tls.cert, key: tls.key } },
  });
  const ca = readFileSync(paths.root, 'utf8');
  const get = (path: string, trust: string | null = ca) =>
    new Promise<number>((resolve, reject) => {
      const request = httpsRequest(
        { agent: false, host: '127.0.0.1', servername: NAME, port: own.remotePort ?? -1, path, headers: { host: NAME, origin: ORIGIN }, ...(trust === null ? {} : { ca: trust }) },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
  try {
    assert.equal(await get('/'), 200);
    assert.equal(await get('/api/remote/status'), 200);
    assert.equal(await get('/api/conversations'), 401);
    // Without the root the certificate is not trusted; plain HTTP gets no page.
    await assert.rejects(get('/', null));
    const plain = await send({ port: own.remotePort ?? -1, path: '/', headers: { host: NAME } }).catch(() => undefined);
    assert.ok(plain === undefined || plain.status === 400, String(plain?.status));
    assert.doesNotMatch(plain?.body ?? '', /Arianna/);
  } finally {
    await own.close();
  }
});
