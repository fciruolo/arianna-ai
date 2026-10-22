import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { onThisMac } from '../src/lib/push.ts';
import {
  browserErrorCode,
  credentialJson,
  creationOptionsOf,
  decisionBody,
  fromBase64url,
  onRemoteOrigin,
  RemoteError,
  remoteErrorText,
  remoteSession,
  requestOptionsOf,
  sessionEnded,
  sessionOf,
  toBase64url,
} from '../src/lib/remote.ts';

test('the remote origin (D-292) is https on a *.ts.net name; the Mac is never it', () => {
  assert.equal(onRemoteOrigin({ protocol: 'https:', hostname: 'mac-prova.tail0000.ts.net' }), true);
  assert.equal(onRemoteOrigin({ protocol: 'http:', hostname: 'mac-prova.tail0000.ts.net' }), false);
  assert.equal(onRemoteOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), false);
  assert.equal(onRemoteOrigin({ protocol: 'https:', hostname: 'evil.example' }), false);
  assert.equal(onThisMac('mac-prova.tail0000.ts.net'), false);
});

test('a session only when the core says so; an error or a refusal is no session', async () => {
  assert.equal(sessionOf({ session: true }), true);
  for (const body of [{ session: false }, { session: 'true' }, { paired: true }, null, [], 'session']) assert.equal(sessionOf(body), false);
  const answer = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;
  assert.equal(await remoteSession(answer(200, { session: false })), false);
  assert.equal(await remoteSession(answer(200, { session: true })), true);
  assert.equal(await remoteSession(answer(401, { session: true })), false);
  assert.equal(await remoteSession((() => Promise.reject(new Error('offline')))), false);
});

test('base64url: round trip without padding; anything else refused', () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33, 65]) {
    const bytes = new Uint8Array(length).map((_, index) => (index * 37 + 251) % 256);
    const text = toBase64url(bytes);
    assert.doesNotMatch(text, /[+/=]/);
    assert.equal(text, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(new Uint8Array(fromBase64url(text)), bytes);
  }
  assert.throws(() => fromBase64url('ab+c'));
  assert.throws(() => fromBase64url('ab=='));
});

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64url');

test('the options of the core become the binary options of WebAuthn', () => {
  const created = creationOptionsOf({
    challenge: b64([1, 2, 3]),
    rp: { id: 'mac-prova.tail0000.ts.net', name: 'Arianna' },
    user: { id: b64([9, 9]), name: 'arianna', displayName: 'Arianna' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: 300000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
  assert.deepEqual(new Uint8Array(created.challenge as ArrayBuffer), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(created.user.id as ArrayBuffer), new Uint8Array([9, 9]));
  assert.equal(created.rp.id, 'mac-prova.tail0000.ts.net');
  assert.equal(created.attestation, 'none');
  assert.deepEqual(created.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
  assert.deepEqual(created.pubKeyCredParams.map((param) => param.alg), [-7, -257]);

  const requested = requestOptionsOf({ challenge: b64([4]), rpId: 'mac-prova.tail0000.ts.net', timeout: 120000, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: b64([7, 7]) }] });
  assert.equal(requested.userVerification, 'required');
  assert.equal(requested.rpId, 'mac-prova.tail0000.ts.net');
  assert.deepEqual(new Uint8Array(requested.allowCredentials?.[0]?.id as ArrayBuffer), new Uint8Array([7, 7]));
});

test('a credential becomes the JSON the core reads: registration and assertion', () => {
  const buffer = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;
  assert.deepEqual(credentialJson({ rawId: buffer([1, 2]), type: 'public-key', response: { clientDataJSON: buffer([3]), attestationObject: buffer([4]) } }), {
    id: b64([1, 2]),
    rawId: b64([1, 2]),
    type: 'public-key',
    response: { clientDataJSON: b64([3]), attestationObject: b64([4]) },
  });
  assert.deepEqual(
    credentialJson({ rawId: buffer([1]), type: 'public-key', response: { clientDataJSON: buffer([3]), authenticatorData: buffer([5]), signature: buffer([6]), userHandle: buffer([8]) } }),
    { id: b64([1]), rawId: b64([1]), type: 'public-key', response: { clientDataJSON: b64([3]), authenticatorData: b64([5]), signature: b64([6]), userHandle: b64([8]) } },
  );
  const anonymous = credentialJson({ rawId: buffer([1]), type: 'public-key', response: { clientDataJSON: buffer([3]), authenticatorData: buffer([5]), signature: buffer([6]), userHandle: null } });
  assert.equal((anonymous.response as Record<string, unknown>).userHandle, null);
  assert.throws(() => credentialJson({ rawId: buffer([1]), type: 'public-key', response: { clientDataJSON: buffer([3]) } }));
});

test('every refusal of the core and of the browser has its Italian text', () => {
  const codes = ['code', 'too-many', 'challenge', 'signature', 'counter', 'unknown-credential', 'device-not-paired', 'local-only', 'verification-required', 'cancelled', 'unsupported'];
  const texts = codes.map((code) => remoteErrorText(code));
  assert.equal(new Set(texts).size, codes.length);
  for (const text of texts) assert.doesNotMatch(text, /\b(the|failed|refused|wrong)\b/);
  assert.match(remoteErrorText('code'), /6 cifre/);
  assert.match(remoteErrorText(undefined), /Riprova/);
  assert.match(remoteErrorText('qualcosa'), /Riprova/);
  assert.equal(browserErrorCode(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 'cancelled');
  assert.equal(browserErrorCode(new RemoteError(401, 'code', 'wrong code')), 'code');
  assert.equal(browserErrorCode('x'), 'unknown');
});

test('a decision from the phone carries its check; from the Mac the body is as before', () => {
  const check = { id: 'x' };
  assert.deepEqual(decisionBody({ state: 'approved' }), { state: 'approved' });
  assert.deepEqual(decisionBody({ state: 'rejected', choice: 'local', starts: [1], revision: 2 }, check), { state: 'rejected', choice: 'local', starts: [1], revision: 2, verification: check });
  assert.equal(sessionEnded(true, 401, { code: 'device-not-paired' }), true);
  assert.equal(sessionEnded(false, 401, { code: 'device-not-paired' }), false);
  assert.equal(sessionEnded(true, 403, { code: 'verification-required' }), false);
});

test('the page installs on the iPhone: apple-touch-icon and the meta of a home-screen app', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-maskable-512\.png" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Arianna" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="[a-z-]+" \/>/);
});
