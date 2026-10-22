import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { onThisMac } from '../src/lib/push.ts';
import { onRemoteOrigin, pairedOf, remotePaired } from '../src/lib/remote.ts';

test('the remote origin (D-292) is https on a *.ts.net name; the Mac is never it', () => {
  assert.equal(onRemoteOrigin({ protocol: 'https:', hostname: 'mac-prova.tail0000.ts.net' }), true);
  assert.equal(onRemoteOrigin({ protocol: 'http:', hostname: 'mac-prova.tail0000.ts.net' }), false);
  assert.equal(onRemoteOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), false);
  assert.equal(onRemoteOrigin({ protocol: 'https:', hostname: 'evil.example' }), false);
  assert.equal(onThisMac('mac-prova.tail0000.ts.net'), false);
});

test('paired only when the core says so; an error or a refusal is not paired', async () => {
  assert.equal(pairedOf({ paired: true }), true);
  for (const body of [{ paired: false }, { paired: 'true' }, null, [], 'paired']) assert.equal(pairedOf(body), false);
  const answer = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;
  assert.equal(await remotePaired(answer(200, { paired: false })), false);
  assert.equal(await remotePaired(answer(200, { paired: true })), true);
  assert.equal(await remotePaired(answer(401, { paired: true })), false);
  assert.equal(await remotePaired((() => Promise.reject(new Error('offline')))), false);
});

test('the page installs on the iPhone: apple-touch-icon and the meta of a home-screen app', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-maskable-512\.png" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Arianna" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="[a-z-]+" \/>/);
});
