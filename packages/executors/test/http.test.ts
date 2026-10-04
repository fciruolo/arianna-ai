// localRequestBytes (D-066): any body and headers, bytes back, a size limit.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { HttpBodyTooLarge, localRequestBytes } from '@arianna/executors';

let server: Server;
let base: string;
const seen: { method: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method ?? '', headers: request.headers, body: Buffer.concat(chunks) });
      const size = Number(new URL(request.url ?? '/', 'http://x').searchParams.get('size') ?? '0');
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-seconds-spent': '0.5' });
      response.end(Buffer.alloc(size, 0xff));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
});

test('sends the body and the headers given, and answers bytes with the response headers', async () => {
  const body = Buffer.from([0, 1, 2, 255]);
  const answer = await localRequestBytes(`${base}/x?size=100`, {
    method: 'POST',
    body,
    headers: { authorization: 'Bearer t', 'content-type': 'application/octet-stream' },
    signal: AbortSignal.timeout(5000),
    maxBytes: 100,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.length, 100);
  assert.equal(answer.body[0], 0xff);
  assert.equal(answer.headers['x-seconds-spent'], '0.5');
  const request = seen.at(-1);
  assert.ok(request !== undefined);
  assert.equal(request.headers.authorization, 'Bearer t');
  assert.deepEqual(request.body, body);
});

test('an answer above maxBytes is refused, and without maxBytes the default limit applies', async () => {
  await assert.rejects(
    localRequestBytes(`${base}/x?size=101`, { method: 'GET', signal: AbortSignal.timeout(5000), maxBytes: 100 }),
    (error: unknown) => error instanceof HttpBodyTooLarge,
  );
  const ok = await localRequestBytes(`${base}/x?size=1000`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  assert.equal(ok.body.length, 1000);
  assert.equal(seen.at(-1)?.method, 'DELETE');
  // No header is invented: a request without headers carries no authorization.
  assert.equal(seen.at(-1)?.headers.authorization, undefined);
});
