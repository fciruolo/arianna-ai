import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadCatalog, resolveHome, type CatalogEntry } from '@arianna/config';

import { createFetcher } from '../src/http.ts';
import { fileTarget, modelStatus, ModelError, PART_SUFFIX, pullFile, pullModels, selectedModels } from '../src/models.ts';

// Fake weights: random bytes, never a real model.
const BODY = randomBytes(64 * 1024 + 123);
const SHA = createHash('sha256').update(BODY).digest('hex');
const ROOT = join(resolveHome({}), 'data', 'test-tmp', `installer-${randomUUID()}`);

let server: Server;
let base = '';
const seen: { path: string; range: string | undefined }[] = [];

before(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    seen.push({ path, range: request.headers.range });
    if (path === '/redirect') {
      response.writeHead(302, { location: '/weights' }).end();
    } else if (path === '/loop') {
      response.writeHead(302, { location: '/loop' }).end();
    } else if (path === '/no-range') {
      response.writeHead(200).end(BODY); // ignores Range, like some servers
    } else if (path === '/corrupt') {
      const bad = Buffer.from(BODY);
      bad[0] = (bad[0] ?? 0) ^ 0xff;
      response.writeHead(200).end(bad);
    } else if (path === '/bigger') {
      response.writeHead(200).end(Buffer.concat([BODY, Buffer.from('extra')]));
    } else if (path === '/missing') {
      response.writeHead(404).end('not here');
    } else if (path === '/bad-location') {
      response.writeHead(302, { location: 'http://[bad' }).end();
    } else if (path === '/changed') {
      response.writeHead(416).end();
    } else if (path === '/stall') {
      response.writeHead(200);
      response.write(BODY.subarray(0, 2000)); // then nothing: the client must give up
    } else {
      const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
      if (match === null) {
        response.writeHead(200).end(BODY);
        return;
      }
      // /wrong-range answers 206 from the wrong offset.
      const from = path === '/wrong-range' && request.headers.range !== 'bytes=0-' ? 0 : Number(match[1]);
      response.writeHead(206, { 'content-range': `bytes ${String(from)}-${String(BODY.length - 1)}/${String(BODY.length)}` }).end(BODY.subarray(from));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const fetch = createFetcher({ allowHttp: true });

function models(path: string, sha = SHA): CatalogEntry[] {
  return [
    {
      id: 'fake-model',
      family: 'fake',
      runtime: 'mlx',
      ramMinGib: 1,
      roles: ['orchestrator'],
      status: 'experimental',
      files: [{ path: 'weights/model.bin', url: `${base}${path}`, sizeBytes: BODY.length, sha256: sha }],
    },
  ];
}

function freshData(): string {
  const data = join(ROOT, randomUUID());
  mkdirSync(data, { recursive: true });
  return data;
}

test('a missing model is downloaded, verified and then reported present and ok', async () => {
  const data = freshData();
  const wanted = models('/weights');
  assert.deepEqual((await modelStatus(wanted, data)).map((status) => status.state), ['missing']);
  const pulled = await pullModels(wanted, data, { fetch });
  assert.equal(pulled.length, 1);
  const target = fileTarget(data, 'fake-model', { path: 'weights/model.bin', url: '', sizeBytes: 0, sha256: '' });
  assert.deepEqual(readFileSync(target), BODY);
  assert.equal(existsSync(`${target}${PART_SUFFIX}`), false);
  assert.deepEqual((await modelStatus(wanted, data)).map((status) => status.state), ['present']);
  assert.deepEqual((await modelStatus(wanted, data, { hash: true })).map((status) => status.state), ['ok']);
  // Nothing left to do: no second request.
  const before = seen.length;
  assert.deepEqual(await pullModels(wanted, data, { fetch }), []);
  assert.equal(seen.length, before);
});

test('an interrupted download resumes from the .part with a Range request', async () => {
  const data = freshData();
  const [status] = await modelStatus(models('/weights'), data);
  assert.ok(status !== undefined);
  mkdirSync(dirname(status.target), { recursive: true });
  writeFileSync(`${status.target}${PART_SUFFIX}`, BODY.subarray(0, 1000));
  assert.equal((await modelStatus(models('/weights'), data))[0]?.state, 'partial');
  await pullFile(status, { fetch });
  assert.equal(seen.at(-1)?.range, 'bytes=1000-');
  assert.deepEqual(readFileSync(status.target), BODY);
});

test('a server that ignores Range restarts the file, and redirects are followed', async () => {
  const data = freshData();
  const [status] = await modelStatus(models('/no-range'), data);
  assert.ok(status !== undefined);
  mkdirSync(dirname(status.target), { recursive: true });
  writeFileSync(`${status.target}${PART_SUFFIX}`, BODY.subarray(0, 5000));
  await pullFile(status, { fetch });
  assert.deepEqual(readFileSync(status.target), BODY);

  const redirected = freshData();
  await pullModels(models('/redirect'), redirected, { fetch });
  assert.deepEqual((await modelStatus(models('/redirect'), redirected, { hash: true })).map((s) => s.state), ['ok']);
});

test('a file with the wrong hash is discarded, never installed', async () => {
  const data = freshData();
  await assert.rejects(pullModels(models('/corrupt'), data, { fetch }), (error: unknown) => error instanceof ModelError && error.code === 'wrong-hash');
  const [status] = await modelStatus(models('/corrupt'), data);
  assert.equal(status?.state, 'missing');
});

test('a file larger than the catalog, an HTTP error, a redirect loop and plain HTTP are refused', async () => {
  const code = (path: string, expected: string, fetcher = fetch) =>
    assert.rejects(pullModels(models(path), freshData(), { fetch: fetcher }), (error: unknown) => error instanceof ModelError && error.code === expected);
  await code('/bigger', 'too-large');
  await code('/missing', 'http-status');
  await code('/loop', 'redirects');
  await code('/weights', 'insecure-url', createFetcher());
});

test('a file of the wrong size is replaced; a wrong hash shows only when verifying', async () => {
  const data = freshData();
  const [status] = await modelStatus(models('/weights'), data);
  assert.ok(status !== undefined);
  mkdirSync(dirname(status.target), { recursive: true });
  writeFileSync(status.target, 'short');
  assert.equal((await modelStatus(models('/weights'), data))[0]?.state, 'wrong-size');
  await pullModels(models('/weights'), data, { fetch });
  assert.deepEqual(readFileSync(status.target), BODY);

  const flipped = Buffer.from(BODY);
  flipped[10] = (flipped[10] ?? 0) ^ 1;
  writeFileSync(status.target, flipped);
  assert.equal((await modelStatus(models('/weights'), data))[0]?.state, 'present');
  assert.equal((await modelStatus(models('/weights'), data, { hash: true }))[0]?.state, 'wrong-hash');
});

test('an invalid redirect, a 206 from the wrong offset and a file changed upstream are handled', async () => {
  await assert.rejects(pullModels(models('/bad-location'), freshData(), { fetch }), (error: unknown) => error instanceof ModelError && error.code === 'redirects');

  // Wrong offset: start over from zero instead of appending the wrong bytes.
  const data = freshData();
  const [status] = await modelStatus(models('/wrong-range'), data);
  assert.ok(status !== undefined);
  mkdirSync(dirname(status.target), { recursive: true });
  writeFileSync(`${status.target}${PART_SUFFIX}`, BODY.subarray(0, 3000));
  await pullFile(status, { fetch });
  assert.deepEqual(readFileSync(status.target), BODY);

  // 416: the .part no longer matches the server and is discarded.
  const changed = freshData();
  const [stale] = await modelStatus(models('/changed'), changed);
  assert.ok(stale !== undefined);
  mkdirSync(dirname(stale.target), { recursive: true });
  writeFileSync(`${stale.target}${PART_SUFFIX}`, BODY.subarray(0, 10));
  await assert.rejects(pullFile(stale, { fetch }), /no longer matches/);
  assert.equal(existsSync(`${stale.target}${PART_SUFFIX}`), false);
});

test('a server that stops sending fails with the file name, and the .part is kept for resuming', async () => {
  const data = freshData();
  await assert.rejects(
    pullModels(models('/stall'), data, { fetch: createFetcher({ allowHttp: true, idleTimeoutMs: 200 }) }),
    (error: unknown) => error instanceof ModelError && error.code === 'network' && /fake-model\/weights\/model\.bin/.test(error.message),
  );
  assert.equal((await modelStatus(models('/stall'), data))[0]?.state, 'partial');
});

test('pull with verify replaces a file of the right size but the wrong hash', async () => {
  const data = freshData();
  await pullModels(models('/weights'), data, { fetch });
  const [status] = await modelStatus(models('/weights'), data);
  assert.ok(status !== undefined);
  const flipped = Buffer.from(BODY);
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  writeFileSync(status.target, flipped);
  assert.deepEqual(await pullModels(models('/weights'), data, { fetch }), []);
  assert.equal((await pullModels(models('/weights'), data, { fetch, verify: true })).length, 1);
  assert.deepEqual(readFileSync(status.target), BODY);
});

test('selectedModels: the models of the roles, and with trial every stt and tts candidate too (D-066)', () => {
  const catalog = loadCatalog(resolveHome({}));
  const ids = (roles: Record<string, string>, trial?: boolean) => selectedModels({ roles }, catalog, trial === undefined ? {} : { trial }).map(({ id }) => id);
  assert.deepEqual(ids({ voice: 'qwen3-4b-instruct-2507-4bit', tts: 'kokoro-82m-bf16-mlx' }), ['qwen3-4b-instruct-2507-4bit', 'kokoro-82m-bf16-mlx']);
  assert.deepEqual(ids({ voice: 'qwen3-4b-instruct-2507-4bit' }, true), [
    'qwen3-4b-instruct-2507-4bit',
    'parakeet-tdt-0.6b-v3-mlx',
    'kokoro-82m-bf16-mlx',
    'qwen3-tts-1.7b-customvoice-bf16-mlx',
    'qwen3-tts-1.7b-base-bf16-mlx',
    'voxtral-4b-tts-bf16-mlx',
  ]);
  assert.deepEqual(ids({}, false), []);
});
