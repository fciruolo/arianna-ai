// The HTTP client of Hugging Face (I-10, D-139), against a local server: no network.
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createHubClient, HubError } from '../src/hub-http.ts';

let server: Server;
let base = '';
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers });
    switch (request.url) {
      case '/api/models?search=x':
        response.writeHead(200, { 'content-type': 'application/json' }).end('[{"id":"a/b"}]');
        return;
      case '/api/renamed':
        response.writeHead(307, { location: '/api/models?search=x' }).end();
        return;
      case '/api/away':
        response.writeHead(302, { location: 'http://elsewhere.invalid/api' }).end();
        return;
      case '/api/missing':
        response.writeHead(401).end('{"error":"Repository not found"}');
        return;
      case '/api/broken':
        response.writeHead(500).end('boom');
        return;
      case '/api/not-json':
        response.writeHead(200).end('<html>');
        return;
      case '/moved-file':
        // A small file sent to another host (here: the same server under another name).
        response.writeHead(302, { location: `http://localhost:${String((server.address() as AddressInfo).port)}/file` }).end();
        return;
      case '/slow':
        response.writeHead(200);
        response.write('[');
        return;
      case '/file':
        response.writeHead(200).end('0123456789');
        return;
      default:
        response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const code = (expected: HubError['code']) => (error: unknown) => error instanceof HubError && error.code === expected;

describe('hub client', () => {
  const client = () => createHubClient({ allowHttp: true, hubHost: new URL(base).host });

  it('reads the JSON of the API, follows a redirect on the same host, sends no identity', async () => {
    assert.deepEqual(await client().json(`${base}/api/models?search=x`), [{ id: 'a/b' }]);
    assert.deepEqual(await client().json(`${base}/api/renamed`), [{ id: 'a/b' }]);
    const headers = seen.at(-1)?.headers ?? {};
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['user-agent'], undefined);
  });

  it('never follows the API away from its host, and maps the answers to codes', async () => {
    await assert.rejects(client().json(`${base}/api/away`), code('upstream'));
    await assert.rejects(client().json(`${base}/api/missing`), code('not-found'));
    await assert.rejects(client().json(`${base}/api/nothing`), code('not-found'));
    await assert.rejects(client().json(`${base}/api/broken`), (error: unknown) => error instanceof HubError && error.code === 'upstream' && !error.message.includes('boom'));
    await assert.rejects(client().json(`${base}/api/not-json`), code('upstream'));
    // Another host from the start.
    await assert.rejects(client().json('http://elsewhere.invalid/api/models'), code('upstream'));
  });

  it('refuses plain HTTP unless a test allows it', async () => {
    await assert.rejects(createHubClient().json(`${base}/api/models?search=x`), code('upstream'));
    await assert.rejects(createHubClient().bytes(`${base}/file`, 100), code('upstream'));
  });

  it('a slow answer ends at the deadline', async () => {
    await assert.rejects(createHubClient({ allowHttp: true, hubHost: new URL(base).host, deadlineMs: 200 }).json(`${base}/slow`), code('upstream'));
  });

  it('a small file may follow a redirect to another host; the API may not', async () => {
    assert.equal((await client().bytes(`${base}/moved-file`, 10)).toString('utf8'), '0123456789');
    await assert.rejects(client().json(`${base}/moved-file`), code('upstream'));
  });

  it('reads a small file whole, and refuses one larger than said', async () => {
    assert.equal((await client().bytes(`${base}/file`, 10)).toString('utf8'), '0123456789');
    await assert.rejects(client().bytes(`${base}/file`, 9), code('upstream'));
  });
});
