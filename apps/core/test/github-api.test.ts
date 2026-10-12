// The HTTP client of the API of GitHub (I-21, D-186), against a local server: no network.
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createGithubClient, GithubError } from '../src/github-api.ts';

let server: Server;
let host = '';
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers });
    switch (request.url) {
      case '/repos/a/b/releases':
        response.writeHead(200, { 'content-type': 'application/json' }).end('[{"tag_name":"v1"}]');
        return;
      case '/repos/a/renamed/releases':
        response.writeHead(301, { location: '/repos/a/b/releases' }).end();
        return;
      case '/repos/a/away/releases':
        response.writeHead(302, { location: 'http://elsewhere.invalid/repos/a/b/releases' }).end();
        return;
      case '/repos/a/limited/releases':
        response.writeHead(403, { 'x-ratelimit-remaining': '0' }).end('{"message":"API rate limit exceeded"}');
        return;
      case '/repos/a/broken/releases':
        response.writeHead(500).end('boom');
        return;
      case '/repos/a/html/releases':
        response.writeHead(200).end('<html>');
        return;
      case '/repos/a/big/releases':
        response.writeHead(200).end(`[${'"x",'.repeat(100)}"x"]`);
        return;
      case '/repos/a/slow/releases':
        response.writeHead(200);
        response.write('[');
        return;
      default:
        response.writeHead(404).end('{"message":"Not Found"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
});

const code = (expected: GithubError['code']) => (error: unknown) => error instanceof GithubError && error.code === expected;

describe('github client', () => {
  const client = (deadlineMs?: number) => createGithubClient({ allowHttp: true, host, ...(deadlineMs === undefined ? {} : { deadlineMs }) });

  it('reads the JSON of the API with a fixed user agent and nothing of the user', async () => {
    assert.deepEqual(await client()('/repos/a/b/releases', 1024), [{ tag_name: 'v1' }]);
    const headers = seen.at(-1)?.headers ?? {};
    assert.equal(headers['user-agent'], 'arianna-catalog');
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
  });

  it('follows a redirect on the same host only', async () => {
    assert.deepEqual(await client()('/repos/a/renamed/releases', 1024), [{ tag_name: 'v1' }]);
    await assert.rejects(client()('/repos/a/away/releases', 1024), code('upstream'));
  });

  it('maps the answers to codes, never with the body', async () => {
    await assert.rejects(client()('/repos/a/missing/releases', 1024), code('not-found'));
    await assert.rejects(client()('/repos/a/limited/releases', 1024), code('limited'));
    await assert.rejects(client()('/repos/a/broken/releases', 1024), (error: unknown) => error instanceof GithubError && error.code === 'upstream' && !error.message.includes('boom'));
    await assert.rejects(client()('/repos/a/html/releases', 1024), code('upstream'));
  });

  it('refuses an answer larger than the limit, a slow one, a path that is not of the API, plain HTTP', async () => {
    await assert.rejects(client()('/repos/a/big/releases', 100), /larger than expected/);
    await assert.rejects(client(200)('/repos/a/slow/releases', 1024), code('upstream'));
    await assert.rejects(client()('https://evil.example/x', 1024), /invalid path/);
    await assert.rejects(client()('/repos/a/../b', 1024), /invalid path/);
    await assert.rejects(client()('/repos/a b', 1024), /invalid path/);
    await assert.rejects(createGithubClient({ host })('/repos/a/b/releases', 1024), code('upstream'));
  });
});
