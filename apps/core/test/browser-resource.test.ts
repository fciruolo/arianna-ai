// The network of the agent's browser (D-264, passo 2): one resource at a time,
// through the gateway, by the public network of the core, never towards this
// machine or the local network, with only the listed headers.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { createContext } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import { createResourcePool, fetchResource, redirectTarget, type ResourceInput, type ResourceOptions, type ResourcePool } from '../src/browser/resource-fetch.ts';
import { gateResource } from '../src/browser/resource-gate.ts';

// No test reaches the internet: a fake server on 127.0.0.1 and a fake resolver
// that names it; 127.0.0.1 counts as public only through the explicit test option.
let server: Server;
let port = 0;
const routes = new Map<string, (request: IncomingMessage, response: ServerResponse, body: Buffer) => void>();
const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      const handler = routes.get(request.url?.split('?')[0] ?? '');
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'text/html' }).end('<p>not here</p>');
        return;
      }
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  seen.length = 0;
});

const NAMES: Record<string, string> = {
  'site.example.org': '127.0.0.1',
  'second.example.org': '127.0.0.1',
  'inner.example.org': '10.0.0.1',
  'loop.example.org': '127.0.0.2',
};

const resolve = (host: string) => {
  const address = NAMES[host];
  return address === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve([{ address, family: 4 }]);
};

const pools: ResourcePool[] = [];
function network(extra: Partial<ResourceOptions> & { concurrency?: number } = {}): ResourceOptions {
  const pool = extra.pool ?? createResourcePool({ resolve, unsafeTestAddresses: extra.unsafeTestAddresses ?? ['127.0.0.1'], ...(extra.concurrency === undefined ? {} : { concurrency: extra.concurrency }) });
  pools.push(pool);
  return { userAgent: 'Mozilla/5.0 (X11; Linux aarch64) Chrome/140.0.0.0 Safari/537.36', pool, resolve, unsafeTestAddresses: ['127.0.0.1'], ...extra };
}
after(() => {
  for (const pool of pools) pool.destroy();
});

/** The first item of a list; a test with none fails. */
function first<T>(list: readonly T[]): T {
  const item = list.at(0);
  if (item === undefined) throw new Error('nothing there');
  return item;
}

const at = (path: string) => `http://site.example.org:${String(port)}${path}`;
const get = (url: string, type: ResourceInput['type'] = 'image', headers: Record<string, string> = {}): ResourceInput => ({ url, method: 'GET', headers, type });

describe('fetchResource', () => {
  it('refuses this machine and the local network before any byte leaves', async () => {
    // Nothing counts as public here: the fake server is on 127.0.0.1 like the debugger of a container.
    const strict = network({ unsafeTestAddresses: [] });
    for (const url of [`http://127.0.0.1:${String(port)}/json/version`, 'http://localhost/json', 'http://[::1]/', 'http://10.0.0.1/', `http://inner.example.org:${String(port)}/a`, `http://loop.example.org:${String(port)}/a`]) {
      const result = await fetchResource(get(url), strict);
      assert.deepEqual(result, { ok: false, reason: 'private-address' }, url);
    }
    // Without the test option, a port is not even allowed: the debugger port is refused as an address.
    const pool = createResourcePool({ resolve });
    pools.push(pool);
    const real: ResourceOptions = { userAgent: 'Mozilla/5.0', pool, resolve };
    assert.deepEqual(await fetchResource(get('http://127.0.0.1:9222/json/version'), real), { ok: false, reason: 'invalid-url' });
    assert.deepEqual(await fetchResource(get('http://127.0.0.1/'), real), { ok: false, reason: 'private-address' });
    assert.deepEqual(seen, []);
  });

  it('gives an image of a public site, with only the listed headers out and in', async () => {
    routes.set('/logo.png', (_request, response) => {
      response.writeHead(200, {
        'content-type': 'image/png',
        'set-cookie': 'id=1',
        'set-cookie2': 'id=2',
        'www-authenticate': 'Basic',
        'clear-site-data': '"cookies"',
        'alt-svc': 'h3=":443"',
        'cache-control': 'max-age=60',
        'access-control-allow-origin': '*',
      });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const result = await fetchResource(
      get(at('/logo.png#frag'), 'image', {
        Accept: 'image/avif,image/webp,*/*;fake-vault-token-ACCEPT-0001',
        Cookie: 'session=secret',
        Authorization: 'Bearer secret',
        'Proxy-Authorization': 'Basic x',
        Referer: 'https://example.com/private?q=1',
        'If-None-Match': '"abc"',
        'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
        Range: 'bytes=0-10',
        'Sec-CH-UA': '"Chromium"',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'text/plain',
        Origin: 'https://example.com/some/path',
        'User-Agent': 'something else',
      }),
      network(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual([...result.body], [0x89, 0x50, 0x4e, 0x47]);
    const names = result.headers.map(([name]) => name);
    for (const name of ['set-cookie', 'set-cookie2', 'www-authenticate', 'clear-site-data', 'alt-svc', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) assert.ok(!names.includes(name), name);
    assert.ok(names.includes('cache-control') && names.includes('access-control-allow-origin') && names.includes('content-type'));
    const request = first(seen);
    assert.equal(request.url, '/logo.png');
    assert.deepEqual(Object.keys(request.headers).sort(), ['accept', 'accept-encoding', 'accept-language', 'connection', 'host', 'origin', 'user-agent']);
    assert.equal(request.headers.origin, 'https://example.com');
    assert.equal(request.headers['accept-language'], 'it,en;q=0.8');
    assert.equal(request.headers['accept-encoding'], 'gzip, deflate, br');
    assert.equal(request.headers['user-agent'], 'Mozilla/5.0 (X11; Linux aarch64) Chrome/140.0.0.0 Safari/537.36');
    // The Accept of the page never leaves: it is fixed by kind, so a value in it is never sent unread.
    assert.equal(request.headers.accept, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5');
    assert.ok(!JSON.stringify(request.headers).includes('fake-vault-token'));
  });

  it('the Cookie of the core (D-276) leaves; the Set-Cookie lines come back apart, never among the headers for the browser', async () => {
    routes.set('/conti', (_request, response) => {
      response.setHeader('set-cookie', ['sid=1; Path=/', 'pref=it']);
      response.writeHead(200, { 'content-type': 'text/html' }).end('<p>conti</p>');
    });
    const result = await fetchResource({ ...get(at('/conti'), 'document', { Cookie: 'from-the-page=1' }), cookie: 'sid=0' }, network());
    assert.ok(result.ok);
    assert.deepEqual(result.setCookies, ['sid=1; Path=/', 'pref=it']);
    assert.ok(!result.headers.some(([name]) => name === 'set-cookie'));
    assert.equal(first(seen).headers.cookie, 'sid=0');
    // Without the cookie of the core, none: the header of the page never leaves.
    await fetchResource(get(at('/conti'), 'document', { Cookie: 'from-the-page=1' }), network());
    assert.equal(seen.at(-1)?.headers.cookie, undefined);
  });

  it('a Content-Type of a POST only from a closed list: a value written in it never leaves', async () => {
    routes.set('/form', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const options = network();
    const sentType = async (value: string, body = 'a=1'): Promise<string | undefined> => {
      seen.length = 0;
      await fetchResource({ url: at('/form'), method: 'POST', headers: { 'Content-Type': value }, body: Buffer.from(body), type: 'fetch' }, options);
      return first(seen).headers['content-type'];
    };
    assert.equal(await sentType('application/x-www-form-urlencoded'), 'application/x-www-form-urlencoded');
    assert.equal(await sentType('text/plain;charset=UTF-8'), 'text/plain; charset=utf-8');
    assert.equal(await sentType('application/json'), 'application/json');
    // A multipart boundary only when the body read by the gateway uses it.
    const multipart = '------WebKitFormBoundaryAbCdEf0123456789\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n------WebKitFormBoundaryAbCdEf0123456789--\r\n';
    assert.equal(await sentType('multipart/form-data; boundary=----WebKitFormBoundaryAbCdEf0123456789', multipart), 'multipart/form-data; boundary=----WebKitFormBoundaryAbCdEf0123456789');
    assert.equal(await sentType('multipart/form-data; boundary=----WebKitFormBoundaryZzZzZz0123456789', multipart), undefined);
    for (const value of [
      'application/json; x=IT60X0542811101000000123456',
      'text/plain; charset=fake-vault-token-1234',
      'multipart/form-data; boundary=IT60X0542811101000000123456',
      'multipart/form-data',
      'application/x-iban-IT60X0542811101000000123456',
      'application/csp-report',
    ]) {
      assert.equal(await sentType(value), undefined, value);
      assert.ok(!JSON.stringify(first(seen).headers).includes('IT60') && !JSON.stringify(first(seen).headers).includes('fake-vault'), value);
    }
  });

  it('sends a POST body and its content type; refuses other methods, a GET with a body and a body over 64 KB', async () => {
    routes.set('/api', (_request, response, body) => {
      response.writeHead(200, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ got: body.toString('utf8') }));
    });
    const options = network();
    const posted = await fetchResource({ url: at('/api'), method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: Buffer.from('{"a":1}'), type: 'fetch' }, options);
    assert.equal(posted.ok, true);
    assert.deepEqual(JSON.parse(posted.body.toString('utf8')), { got: '{"a":1}' });
    assert.equal(first(seen).headers['content-type'], 'application/json');
    assert.equal(first(seen).headers.origin, undefined);
    seen.length = 0;
    // Content-Type only with POST.
    await fetchResource({ url: at('/api'), method: 'GET', headers: { 'content-type': 'application/json' }, type: 'fetch' }, options);
    assert.equal(first(seen).headers['content-type'], undefined);
    seen.length = 0;
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT']) {
      assert.deepEqual(await fetchResource({ url: at('/api'), method, headers: {}, type: 'fetch' }, options), { ok: false, reason: 'invalid-request' }, method);
    }
    assert.deepEqual(await fetchResource({ url: at('/api'), method: 'GET', headers: {}, body: Buffer.from('x'), type: 'fetch' }, options), { ok: false, reason: 'invalid-request' });
    assert.deepEqual(await fetchResource({ url: at('/api'), method: 'POST', headers: {}, body: Buffer.alloc(64 * 1024 + 1, 97), type: 'fetch' }, options), { ok: false, reason: 'body-too-large' });
    assert.equal((await fetchResource({ url: at('/api'), method: 'POST', headers: {}, body: Buffer.alloc(64 * 1024, 97), type: 'fetch' }, options)).ok, true);
    assert.equal(seen.length, 1);
    for (const url of ['ftp://site.example.org/a', 'data:text/plain,a', 'https://user:pw@site.example.org/a']) {
      assert.deepEqual(await fetchResource(get(url), options), { ok: false, reason: 'invalid-url' }, url);
    }
  });

  it('refuses a body over the limit of its kind, declared, streamed or inflated from a small gzip', async () => {
    const limit = 2 * 1024 * 1024;
    routes.set('/exact.css', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/css' }).end(Buffer.alloc(limit, 32));
    });
    routes.set('/declared.css', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/css', 'content-length': String(limit + 1) }).end(Buffer.alloc(limit + 1, 32));
    });
    routes.set('/streamed.css', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.write(Buffer.alloc(limit, 32));
      response.end(Buffer.alloc(1, 32));
    });
    const bomb = gzipSync(Buffer.alloc(limit * 4, 32));
    assert.ok(bomb.length < 64 * 1024);
    routes.set('/bomb.css', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip', 'content-length': String(bomb.length) }).end(bomb);
    });
    routes.set('/small.css', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'content-encoding': 'gzip' }).end(gzipSync('body { color: red }'));
    });
    const options = network();
    const exact = await fetchResource(get(at('/exact.css'), 'stylesheet'), options);
    assert.equal(exact.ok ? exact.body.length : -1, limit);
    assert.deepEqual(await fetchResource(get(at('/declared.css'), 'stylesheet'), options), { ok: false, reason: 'too-large' });
    assert.deepEqual(await fetchResource(get(at('/streamed.css'), 'stylesheet'), options), { ok: false, reason: 'too-large' });
    assert.deepEqual(await fetchResource(get(at('/bomb.css'), 'stylesheet'), options), { ok: false, reason: 'too-large' });
    const small = await fetchResource(get(at('/small.css'), 'stylesheet'), options);
    assert.equal(small.ok ? small.body.toString('utf8') : '', 'body { color: red }');
    assert.ok(small.ok && !small.headers.some(([name]) => name === 'content-encoding'));
    // A script may be larger than a style sheet.
    routes.set('/big.js', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(Buffer.alloc(limit + 1, 32));
    });
    assert.equal((await fetchResource(get(at('/big.js'), 'script'), options)).ok, true);
  });

  it('accepts only the media types of the kind; an error answer keeps its status', async () => {
    routes.set('/page.html', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<p>hi</p>');
    });
    routes.set('/data.json', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end('{"ok":true}');
    });
    const options = network();
    assert.deepEqual(await fetchResource(get(at('/page.html'), 'image'), options), { ok: false, reason: 'unsupported-type' });
    assert.deepEqual(await fetchResource(get(at('/page.html'), 'script'), options), { ok: false, reason: 'unsupported-type' });
    assert.equal((await fetchResource(get(at('/page.html'), 'document'), options)).ok, true);
    assert.equal((await fetchResource(get(at('/data.json'), 'fetch'), options)).ok, true);
    assert.deepEqual(await fetchResource(get(at('/data.json'), 'stylesheet'), options), { ok: false, reason: 'unsupported-type' });
    // A 404 of an image: the status, no body of another type.
    const missing = await fetchResource(get(at('/missing.png'), 'image'), options);
    assert.equal(missing.ok ? missing.status : 0, 404);
    assert.equal(missing.ok ? missing.body.length : -1, 0);
    // A 404 of a frame: its page.
    const frame = await fetchResource(get(at('/missing'), 'document'), options);
    assert.equal(frame.ok ? frame.body.toString('utf8') : '', '<p>not here</p>');
  });

  it('gives a redirect back with its Location, without following it', async () => {
    routes.set('/old', (_request, response) => {
      response.writeHead(302, { location: '/new?x=1', 'set-cookie': 'a=1' }).end();
    });
    routes.set('/script-redirect', (_request, response) => {
      response.writeHead(301, { location: 'javascript:alert(1)' }).end();
    });
    const result = await fetchResource(get(at('/old'), 'image'), network());
    assert.equal(result.ok, true);
    assert.equal(result.status, 302);
    assert.equal(result.location, at('/new?x=1'));
    assert.deepEqual(result.headers.find(([name]) => name === 'location'), ['location', at('/new?x=1')]);
    assert.ok(!result.headers.some(([name]) => name === 'set-cookie'));
    assert.deepEqual(seen.map((request) => request.url), ['/old']);
    assert.deepEqual(await fetchResource(get(at('/script-redirect'), 'image'), network()), { ok: false, reason: 'insecure-redirect' });
    // From https never down to http.
    assert.deepEqual(redirectTarget('http://example.com/a', new URL('https://example.com/b')), { reason: 'insecure-redirect' });
    assert.deepEqual(redirectTarget('https://example.net/a', new URL('http://example.com/b')), { href: 'https://example.net/a' });
  });

  it('a socket kept alive towards one host never keeps a request to another waiting', async () => {
    routes.set('/kept', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' }).end('x');
    });
    const one = network({ concurrency: 1, timeoutMs: 2_000 });
    assert.equal((await fetchResource(get(at('/kept')), one)).ok, true);
    const other = await fetchResource(get(`http://second.example.org:${String(port)}/kept`), one);
    assert.equal(other.ok, true);
  });

  it('stops after its time, keeps the limit of requests at the same time, and closes with the job', async () => {
    let running = 0;
    let most = 0;
    routes.set('/slow', (_request, response) => {
      running += 1;
      most = Math.max(most, running);
      setTimeout(() => {
        running -= 1;
        response.writeHead(200, { 'content-type': 'image/png' }).end('x');
      }, 80);
    });
    const two = network({ concurrency: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, () => fetchResource(get(at('/slow')), two)));
    assert.ok(results.every((result) => result.ok));
    assert.equal(most, 2);
    routes.set('/never', () => {
      // No answer.
    });
    assert.deepEqual(await fetchResource(get(at('/never')), network({ timeoutMs: 150 })), { ok: false, reason: 'timeout' });
    const controller = new AbortController();
    const pending = fetchResource(get(at('/never')), network(), controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 50);
    assert.deepEqual(await pending, { ok: false, reason: 'interrupted' });
    const closing = network();
    closing.pool.destroy();
    assert.deepEqual(await fetchResource(get(at('/slow')), closing), { ok: false, reason: 'interrupted' });
  });
});

/** A database that takes every gateway_log row. */
function fakeSql(rows: unknown[][]): Sql {
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    rows.push(values);
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

describe('gateResource', () => {
  it('passes the gateway with the consent of the page and logs neither the address nor the site', async () => {
    routes.set('/pixel.gif', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/gif' }).end('GIF89a');
    });
    const rows: unknown[][] = [];
    const result = await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L0'), consent: { from: 'public' }, request: get(at('/pixel.gif?a=1')), network: network() });
    assert.equal(result.ok, true);
    assert.deepEqual(rows.map((values) => [values[2], values[3], values[6], values[7]]), [['web', 'web-resource-public', 'allow', 'resource']]);
    assert.ok(rows.every((values) => !values.some((value) => typeof value === 'string' && (value.includes('example.org') || value.includes('pixel')))));
    assert.deepEqual(seen.map((request) => request.url), ['/pixel.gif?a=1']);
  });

  it('a public consent from an internal session is blocked and nothing is requested', async () => {
    const rows: unknown[][] = [];
    const result = await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L1'), consent: 'public', request: get(at('/pixel.gif')), network: network() });
    assert.deepEqual(result, { ok: false, reason: 'blocked' });
    assert.deepEqual(rows.map((values) => [values[3], values[6], values[7]]), [['web-resource-public', 'block', 'page-consent']]);
    assert.deepEqual(seen, []);
    // With the consent of a page the user wrote, the same internal session loads it.
    assert.equal((await gateResource({ sql: fakeSql([]), context: createContext('L1', 'L1'), consent: 'user', request: get(at('/pixel.gif')), network: network() })).ok, true);
  });

  it('sends the exact body the gateway read; a body with an IBAN or not UTF-8 never leaves', async () => {
    routes.set('/collect', (_request, response, body) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ length: body.length }));
    });
    const context = createContext('L1', 'L1');
    const post = (body: Buffer): ResourceInput => ({ url: at('/collect'), method: 'POST', headers: { 'content-type': 'application/json' }, body, type: 'fetch' });
    const rows: unknown[][] = [];
    const text = '﻿{"q":"caffè"}';
    const sent = await gateResource({ sql: fakeSql(rows), context, consent: 'sites', request: post(Buffer.from(text, 'utf8')), network: network() });
    assert.equal(sent.ok, true);
    assert.deepEqual(seen[0]?.body, Buffer.from(text, 'utf8'));
    assert.equal(rows[0]?.[3], 'web-resource-sites');
    seen.length = 0;
    const iban = await gateResource({ sql: fakeSql(rows), context, consent: 'sites', request: post(Buffer.from('{"iban":"IT60X0542811101000000123456"}')), network: network() });
    assert.deepEqual(iban, { ok: false, reason: 'blocked' });
    assert.equal(rows.at(-1)?.[7], 'scanner');
    const before = rows.length;
    assert.deepEqual(await gateResource({ sql: fakeSql(rows), context, consent: 'sites', request: post(Buffer.from([0xff, 0xfe, 0x00])), network: network() }), { ok: false, reason: 'unreadable-body' });
    assert.equal(rows.length, before);
    assert.deepEqual(seen, []);
  });

  it('a private address or a refused method is answered before the gateway: no row, no request', async () => {
    const rows: unknown[][] = [];
    const strict = network({ unsafeTestAddresses: [] });
    for (const url of [`http://127.0.0.1:${String(port)}/json/version`, 'http://localhost/', 'http://[::1]/', 'http://10.0.0.1/']) {
      assert.deepEqual(await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L0'), consent: 'public', request: get(url), network: strict }), { ok: false, reason: 'private-address' }, url);
    }
    assert.deepEqual(await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L0'), consent: 'public', request: { url: at('/a'), method: 'DELETE', headers: {}, type: 'fetch' }, network: network() }), { ok: false, reason: 'invalid-request' });
    assert.deepEqual(rows, []);
    assert.deepEqual(seen, []);
  });

  it('after an access (D-276): a request of its site goes as session with the cookie; another site carries L2 and never its cookie', async () => {
    const rows: unknown[][] = [];
    routes.set('/pixel.gif', (_request, response) => { response.writeHead(200, { 'content-type': 'image/gif' }).end('GIF'); });
    const onSite = await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L1'), consent: 'user', session: 'site.example.org', request: { ...get(at('/pixel.gif')), cookie: 'sid=1' }, network: network() });
    assert.equal(onSite.ok, true);
    assert.equal(first(seen).headers.cookie, 'sid=1');
    assert.equal(rows.at(-1)?.[3], 'web-session');
    assert.equal(rows.at(-1)?.[5], 'L2');
    const other = await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L1'), consent: 'user', session: 'banca-finta.it', request: { ...get(at('/pixel.gif')), cookie: 'sid=1' }, network: network() });
    assert.deepEqual(other, { ok: false, reason: 'blocked' });
    assert.equal(seen.length, 1);
    assert.equal(rows.at(-1)?.[7], 'cloud-label');
    // Without an access the cookie never goes, even when a caller set it.
    await gateResource({ sql: fakeSql(rows), context: createContext('L1', 'L1'), consent: 'user', request: { ...get(at('/pixel.gif')), cookie: 'sid=1' }, network: network() });
    assert.equal(seen.at(-1)?.headers.cookie, undefined);
  });

  it('a gateway that cannot write its log is a refusal', async () => {
    const broken = (() => Promise.reject(new Error('log not writable'))) as unknown as Sql;
    assert.deepEqual(await gateResource({ sql: broken, context: createContext('L1', 'L0'), consent: 'public', request: get(at('/pixel.gif')), network: network() }), { ok: false, reason: 'blocked' });
    assert.deepEqual(seen, []);
  });
});
