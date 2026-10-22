// The devices of the remote port (D-292, stage B), without PostgreSQL: the
// service with the in-memory store (test/support/memory-devices.ts) and the
// remote port of a real server on 127.0.0.1, with passkeys generated here.
// Made-up name and devices. test-db/remote-devices.test.ts runs the store on
// the real database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import {
  canonicalJson,
  CODE_MAX_WRONG,
  createRemoteDevices,
  intentDigest,
  deviceName,
  PAIR_PER_MINUTE,
  RemoteError,
  SESSION_COOKIE,
  sessionToken,
  uuidBytes,
  type Intent,
  type RemoteDevices,
} from '../src/remote/devices.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { localOnly, stepUpAction, VERIFICATION_HEADER } from '../src/server/remote.ts';
import { memoryDeviceStore, type MemoryDevices } from './support/memory-devices.ts';
import { TestPasskey } from './support/passkey.ts';

const HOST = 'mac-prova.tail0000.ts.net';
const ORIGIN = `https://${HOST}`;
const MINUTE = 60_000;

let clock: number;
let codes: string[];
let store: MemoryDevices;
let devices: RemoteDevices;

function fresh(): void {
  clock = Date.parse('2026-10-22T10:00:00Z');
  codes = [];
  store = memoryDeviceStore();
  devices = createRemoteDevices({
    store,
    host: HOST,
    now: () => clock,
    code: () => {
      const code = String(100_000 + codes.length * 7919).slice(0, 6);
      codes.push(code);
      return code;
    },
  });
}

function refusedWith(status: number, code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof RemoteError, String(error));
    assert.deepEqual([error.status, error.code], [status, code]);
    return true;
  };
}

/** Pairs a new passkey through the service; its device and session token. */
async function pairDevice(passkey = new TestPasskey(), name = 'iPhone di prova'): Promise<{ passkey: TestPasskey; deviceId: string; token: string }> {
  const { code } = devices.newCode(name);
  const options = await devices.pair(code);
  const { token, deviceId } = await devices.register(passkey.create({ challenge: options.challenge }, HOST, Buffer.from(options.user.id, 'base64url')));
  return { passkey, deviceId, token };
}

const cookie = (token: string): string => `${SESSION_COOKIE}=${token}`;

beforeEach(fresh);

test('a pairing code: 6 digits, 5 minutes, one use; the name stays on the Mac', async () => {
  const { code, expiresAt } = devices.newCode('  iPhone di Gilda  ');
  assert.match(code, /^\d{6}$/);
  assert.equal(expiresAt, new Date(clock + 5 * MINUTE).toISOString());
  assert.deepEqual(devices.codeState(), { expiresAt });
  const options = await devices.pair(code);
  assert.equal(options.rp.id, HOST);
  assert.equal(options.attestation, 'none');
  assert.deepEqual(options.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
  assert.deepEqual(options.pubKeyCredParams.map((param) => param.alg), [-7, -257]);
  // The name the user gave is not in what the phone receives.
  assert.doesNotMatch(JSON.stringify(options), /Gilda/);
  // Used once: the same code again is refused.
  await assert.rejects(devices.pair(code), refusedWith(401, 'code'));
  assert.equal(devices.codeState(), null);

  const late = devices.newCode('iPhone');
  clock += 5 * MINUTE;
  await assert.rejects(devices.pair(late.code), refusedWith(401, 'code'));
});

test('a code is burned after 5 wrong attempts; a new code replaces the old one', async () => {
  const { code } = devices.newCode('iPhone');
  for (let attempt = 0; attempt < CODE_MAX_WRONG; attempt += 1) await assert.rejects(devices.pair('000000'), refusedWith(401, 'code'));
  await assert.rejects(devices.pair(code), refusedWith(401, 'code'));
  const first = devices.newCode('iPhone').code;
  const second = devices.newCode('iPhone').code;
  await assert.rejects(devices.pair(first), refusedWith(401, 'code'));
  await devices.pair(second);
});

test('codes typed on the phone are limited per minute for everyone', async () => {
  devices.newCode('iPhone');
  for (let attempt = 0; attempt < PAIR_PER_MINUTE; attempt += 1) {
    // A new code each time: the limit is not the 5 wrong attempts of one code.
    if (attempt % 4 === 0) devices.newCode('iPhone');
    await assert.rejects(devices.pair('000000'), refusedWith(401, 'code'));
  }
  const { code } = devices.newCode('iPhone');
  await assert.rejects(devices.pair(code), refusedWith(429, 'too-many'));
  clock += MINUTE;
  await devices.pair(code);
});

test('the name of a device: trimmed, 60 characters at most, no control characters', () => {
  assert.equal(deviceName(undefined), 'iPhone');
  assert.equal(deviceName('   '), 'iPhone');
  assert.equal(deviceName(' iPad '), 'iPad');
  assert.throws(() => deviceName('a'.repeat(61)), RemoteError);
  assert.throws(() => deviceName('iPhone\nx'), RemoteError);
  assert.throws(() => deviceName(7), RemoteError);
});

test('registration: the passkey of the challenge, once; a session follows, stored only as sha256', async () => {
  const { deviceId, token } = await pairDevice();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.devices[0]?.name, 'iPhone di prova');
  assert.equal(store.sessions.length, 1);
  assert.ok(!JSON.stringify(store.sessions).includes(token));
  assert.deepEqual(await devices.session(cookie(token)), { id: '1', deviceId });
  assert.equal(await devices.session(`${SESSION_COOKIE}=${'A'.repeat(43)}`), undefined);
  assert.equal(await devices.session('other=1'), undefined);
  // The same registration again: its challenge is spent.
  const passkey = new TestPasskey();
  const options = await devices.pair(devices.newCode('iPhone').code);
  const body = passkey.create({ challenge: options.challenge }, HOST);
  await devices.register(body);
  await assert.rejects(devices.register(body), refusedWith(401, 'challenge'));
});

test('registration refused: wrong origin, wrong rpId, expired challenge, no challenge of the core', async () => {
  for (const change of [{ origin: 'https://evil.example' }, { rpId: 'altro.tail0000.ts.net' }]) {
    const options = await devices.pair(devices.newCode('iPhone').code);
    await assert.rejects(devices.register(new TestPasskey().create({ challenge: options.challenge, ...change }, HOST)), RemoteError);
  }
  const options = await devices.pair(devices.newCode('iPhone').code);
  clock += 5 * MINUTE;
  await assert.rejects(devices.register(new TestPasskey().create({ challenge: options.challenge }, HOST)), refusedWith(401, 'challenge'));
  await assert.rejects(devices.register(new TestPasskey().create({ challenge: randomBytes(32).toString('base64url') }, HOST)), refusedWith(401, 'challenge'));
  assert.equal(store.devices.length, 0);
});

test('sign-in with the passkey: a new session; wrong signature, unknown passkey and a counter going back are refused', async () => {
  const { passkey, deviceId } = await pairDevice();
  const options = devices.loginOptions();
  assert.equal(options.rpId, HOST);
  assert.equal(options.userVerification, 'required');
  const { token, deviceId: signedIn } = await devices.login(passkey.get({ challenge: options.challenge }, HOST));
  assert.equal(signedIn, deviceId);
  assert.notEqual(await devices.session(cookie(token)), undefined);

  await assert.rejects(devices.login(passkey.get({ challenge: devices.loginOptions().challenge }, HOST, { badSignature: true })), refusedWith(401, 'signature'));
  await assert.rejects(devices.login(new TestPasskey().get({ challenge: devices.loginOptions().challenge }, HOST)), refusedWith(401, 'unknown-credential'));
  // A counter that moved forward once, then back: a cloned passkey.
  await devices.login(passkey.get({ challenge: devices.loginOptions().challenge, signCount: 9 }, HOST));
  await assert.rejects(devices.login(passkey.get({ challenge: devices.loginOptions().challenge, signCount: 4 }, HOST)), refusedWith(401, 'counter'));
  // A challenge used once only, and never after its 2 minutes.
  const used = devices.loginOptions().challenge;
  await devices.login(passkey.get({ challenge: used, signCount: 10 }, HOST));
  await assert.rejects(devices.login(passkey.get({ challenge: used, signCount: 11 }, HOST)), refusedWith(401, 'challenge'));
  const old = devices.loginOptions().challenge;
  clock += 2 * MINUTE;
  await assert.rejects(devices.login(passkey.get({ challenge: old, signCount: 12 }, HOST)), refusedWith(401, 'challenge'));
});

test('a session ends after 12 hours, or after 30 minutes without use', async () => {
  const { token } = await pairDevice();
  // Used every 20 minutes: alive until the 12 hours.
  for (let minutes = 20; minutes < 12 * 60; minutes += 20) {
    clock += 20 * MINUTE;
    assert.notEqual(await devices.session(cookie(token)), undefined, `${String(minutes)} minutes`);
  }
  clock += 20 * MINUTE;
  assert.equal(await devices.session(cookie(token)), undefined);

  const second = await pairDevice();
  clock += 30 * MINUTE;
  assert.equal(await devices.session(cookie(second.token)), undefined);
});

test('«Scollega»: sessions and passkeys of the device end at once; the others stay', async () => {
  const one = await pairDevice();
  const two = await pairDevice(new TestPasskey(-257), 'iPad');
  const unlinked: string[] = [];
  devices.onUnlink((id) => unlinked.push(id));
  await devices.unlink(one.deviceId);
  assert.deepEqual(unlinked, [one.deviceId]);
  assert.equal(await devices.session(cookie(one.token)), undefined);
  await assert.rejects(devices.login(one.passkey.get({ challenge: devices.loginOptions().challenge }, HOST)), refusedWith(401, 'unknown-credential'));
  assert.notEqual(await devices.session(cookie(two.token)), undefined);
  assert.deepEqual((await devices.list()).map((device) => device.name), ['iPad']);
  await assert.rejects(devices.unlink(one.deviceId), refusedWith(404, 'not-found'));
  await assert.rejects(devices.unlink('not-a-uuid'), refusedWith(404, 'not-found'));
});

test('an action from the phone needs a passkey check bound to its intent, of this session, not older than 5 minutes, once', async () => {
  const { passkey, token, deviceId } = await pairDevice();
  const session = await devices.session(cookie(token));
  assert.ok(session !== undefined);
  const approve: Intent = { method: 'POST', path: '/api/approvals/0a5f3e1c-1111-4222-8333-444455556666/decision', body: { state: 'approved' } };
  const check = async (intent = approve) => {
    const options = await devices.intentOptions(session, intent);
    assert.deepEqual(options.allowCredentials.map((item) => item.id), [passkey.id.toString('base64url')]);
    // The challenge carries the digest of the intent.
    assert.deepEqual(Buffer.from(options.challenge, 'base64url').subarray(16), intentDigest(intent));
    return passkey.get({ challenge: options.challenge }, HOST);
  };
  const verify = (assertion: unknown, intent = approve, on = session) => devices.verifyIntent(on, intent, 'approval.decide', assertion);
  // No check at all, or one that is not a passkey answer.
  await assert.rejects(verify(undefined), refusedWith(403, 'verification-required'));
  await assert.rejects(verify({ response: { clientDataJSON: '!' } }), refusedWith(403, 'verification-required'));
  // The right check passes, once.
  const good = await check();
  await verify(good);
  await assert.rejects(verify(good), refusedWith(403, 'verification-required'));
  // A check for another choice, another object or another action.
  await assert.rejects(verify(await check(), { ...approve, body: { state: 'rejected' } }), refusedWith(403, 'verification-required'));
  await assert.rejects(verify(await check(), { ...approve, path: '/api/approvals/0a5f3e1c-1111-4222-8333-000000000000/decision' }), refusedWith(403, 'verification-required'));
  // The order of the keys does not change the intent; a value does.
  const twoKeys = { ...approve, body: { state: 'approved', choice: 'local' } };
  await verify(await check(twoKeys), { ...approve, body: { choice: 'local', state: 'approved' } });
  // Older than 5 minutes.
  const late = await check();
  clock += 5 * MINUTE;
  await assert.rejects(verify(late), refusedWith(403, 'verification-required'));
  // A check asked by another session of the same device, or by another device.
  const stolen = await check();
  await assert.rejects(verify(stolen, approve, { ...session, id: 'another' }), refusedWith(403, 'verification-required'));
  const other = await pairDevice(new TestPasskey(), 'iPad');
  const otherSession = await devices.session(cookie(other.token));
  assert.ok(otherSession !== undefined);
  const theirs = await devices.intentOptions(otherSession, approve);
  await assert.rejects(verify(other.passkey.get({ challenge: theirs.challenge }, HOST)), refusedWith(403, 'verification-required'));
  // A bad signature on the right challenge.
  const options = await devices.intentOptions(session, approve);
  await assert.rejects(verify(passkey.get({ challenge: options.challenge }, HOST, { badSignature: true })), refusedWith(403, 'verification-required'));
  const outcomes = store.events.filter((event) => event.kind === 'remote.verification').map((event) => [event.payload.device, event.payload.action, event.payload.outcome]);
  assert.deepEqual(outcomes[0], [deviceId, 'approval.decide', 'refused']);
  assert.ok(outcomes.some(([, , outcome]) => outcome === 'ok'));
});

test('the canonical intent: keys in order at every level, undefined left out', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], e: undefined }), '{"a":[{"c":null,"d":2}],"b":1}');
  assert.deepEqual(intentDigest({ method: 'post', path: '/x', body: { a: 1, b: 2 } }), intentDigest({ method: 'POST', path: '/x', body: { b: 2, a: 1 } }));
  assert.notDeepEqual(intentDigest({ method: 'POST', path: '/x', body: { a: 1 } }), intentDigest({ method: 'POST', path: '/x', body: { a: '1' } }));
});

test('events: device id and outcome only, never a code, a cookie, a key or a name', async () => {
  const { code } = devices.newCode('iPhone di Gilda');
  await assert.rejects(devices.pair('000000'));
  const options = await devices.pair(code);
  const passkey = new TestPasskey();
  const { token } = await devices.register(passkey.create({ challenge: options.challenge }, HOST, Buffer.from(options.user.id, 'base64url')));
  await devices.login(passkey.get({ challenge: devices.loginOptions().challenge }, HOST));
  await devices.unlink(store.devices[0]?.id ?? '');
  const text = JSON.stringify(store.events);
  for (const secret of [code, token, 'Gilda', passkey.id.toString('base64url'), options.challenge]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(
    store.events.map((event) => [event.kind, event.payload.outcome]),
    [
      ['remote.paired', 'refused'],
      ['remote.paired', 'ok'],
      ['remote.login', 'ok'],
      ['remote.unlinked', 'ok'],
    ],
  );
  for (const event of store.events) assert.deepEqual(Object.keys(event.payload).filter((key) => !['device', 'outcome', 'reason'].includes(key)), []);
});

test('the user handle of an assertion must be the device it signs in', async () => {
  const { passkey } = await pairDevice();
  await assert.rejects(devices.login(passkey.get({ challenge: devices.loginOptions().challenge }, HOST, { userHandle: uuidBytes('00000000-0000-4000-8000-000000000000') })), refusedWith(401, 'user-handle'));
});

test('the session cookie: only its own name and shape', () => {
  const token = 'a'.repeat(43);
  assert.equal(sessionToken(`x=1; ${SESSION_COOKIE}=${token}`), token);
  assert.equal(sessionToken(`arianna-session=${token}`), undefined);
  assert.equal(sessionToken(`${SESSION_COOKIE}=short`), undefined);
  assert.equal(sessionToken(undefined), undefined);
});

// --- Over HTTP, on the remote port of a real server -------------------------

let server: ApiServer;

before(async () => {
  fresh();
  server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: { subscribe: () => Promise.resolve(() => undefined) } as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    remote: { host: HOST, port: 0 },
    // The service of the test in progress: beforeEach makes a new one.
    remoteDevices: new Proxy({} as RemoteDevices, { get: (_target, key) => Reflect.get(devices, key) as unknown }),
  });
});

after(async () => {
  await server.close();
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { ...(text === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Not JSON: a file or an upgrade refusal.
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    request.end(text);
  });
}

const remote = (path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  send(server.remotePort ?? -1, path, { ...options, headers: { host: HOST, origin: ORIGIN, ...options.headers } });
const local = (path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  send(server.port, path, { ...options, headers: { origin: `http://127.0.0.1:${String(server.port)}`, ...options.headers } });

function tokenOf(answer: Answer): string {
  const set = answer.headers['set-cookie']?.[0] ?? '';
  const token = /^__Host-arianna-session=([A-Za-z0-9_-]{43});/.exec(set)?.[1];
  assert.ok(token !== undefined, set);
  return token;
}

test('HTTP: the code is made on the Mac only, never from the phone', async () => {
  const made = await local('/api/devices/code', { method: 'POST', body: { name: 'iPhone' } });
  assert.equal(made.status, 200);
  assert.match(String(made.body.code), /^\d{6}$/);
  assert.equal((await remote('/api/devices/code', { method: 'POST', body: {} })).status, 401);
  // Even with a session of a paired device.
  const { token } = await pairDevice();
  const phone = await remote('/api/devices/code', { method: 'POST', body: {}, headers: { cookie: cookie(token) } });
  assert.deepEqual([phone.status, phone.body.code], [403, 'local-only']);
  assert.equal((await remote('/api/devices', { headers: { cookie: cookie(token) } })).status, 403);
  assert.equal((await remote('/api/settings/privacy/confirm', { method: 'POST', body: {}, headers: { cookie: cookie(token) } })).status, 403);
  assert.equal((await remote('/api/notifications/stream', { headers: { cookie: cookie(token) } })).status, 403);
  assert.equal((await remote('/api/browser/control', { method: 'POST', body: {}, headers: { cookie: cookie(token) } })).status, 403);
  assert.equal((await remote('/api/browse/demo/open', { method: 'POST', body: {}, headers: { cookie: cookie(token) } })).status, 403);
  // The steps of the phone do not exist on the port of the Mac.
  assert.equal((await local('/api/remote/pair', { method: 'POST', body: { code: '123456' } })).status, 404);
});

test('HTTP: pairing, passkey, cookie; the API opens with the session and closes without it', async () => {
  const { code } = devices.newCode('iPhone');
  const paired = await remote('/api/remote/pair', { method: 'POST', body: { code } });
  assert.equal(paired.status, 200);
  const options = paired.body.options as { challenge: string; user: { id: string } };
  const passkey = new TestPasskey();
  const registered = await remote('/api/remote/register', { method: 'POST', body: { credential: passkey.create({ challenge: options.challenge }, HOST, Buffer.from(options.user.id, 'base64url')) } });
  assert.equal(registered.status, 201);
  const set = registered.headers['set-cookie']?.[0] ?? '';
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=43200']) assert.ok(set.split('; ').includes(attribute), attribute);
  const token = tokenOf(registered);

  assert.deepEqual((await remote('/api/remote/status', { headers: { cookie: cookie(token) } })).body, { session: true });
  assert.deepEqual((await remote('/api/remote/status')).body, { session: false });
  assert.equal((await remote('/api/notifications/latest', { headers: { cookie: cookie(token) } })).status, 200);
  assert.equal((await remote('/api/notifications/latest')).status, 401);
  // A write needs its origin even with the cookie.
  const noOrigin = await send(server.remotePort ?? -1, '/api/remote/logout', { method: 'POST', body: {}, headers: { host: HOST, cookie: cookie(token) } });
  assert.equal(noOrigin.status, 403);

  // Sign-in again, then out.
  const login = await remote('/api/remote/login/options', { method: 'POST', body: {} });
  const second = await remote('/api/remote/login', { method: 'POST', body: { credential: passkey.get({ challenge: (login.body.options as { challenge: string }).challenge }, HOST) } });
  assert.equal(second.status, 200);
  const other = tokenOf(second);
  const out = await remote('/api/remote/logout', { method: 'POST', body: {}, headers: { cookie: cookie(other) } });
  assert.match(out.headers['set-cookie']?.[0] ?? '', /Max-Age=0/);
  assert.equal((await remote('/api/notifications/latest', { headers: { cookie: cookie(other) } })).status, 401);
  assert.equal((await remote('/api/notifications/latest', { headers: { cookie: cookie(token) } })).status, 200);
});

test('HTTP: refusals of pairing in the codes of the page; a wrong code is 401, too many 429', async () => {
  devices.newCode('iPhone');
  const wrong = await remote('/api/remote/pair', { method: 'POST', body: { code: '000000' } });
  assert.deepEqual([wrong.status, wrong.body.code], [401, 'code']);
  assert.equal((await remote('/api/remote/pair', { method: 'POST', body: { code: '1', other: 1 } })).status, 400);
});

/** Every action that from the phone asks Face ID (D-292, step-up), with a body as the chat sends it. */
const STEP_UP_ACTIONS: { path: string; body: Record<string, unknown> }[] = [
  { path: '/api/approvals/0a5f3e1c-1111-4222-8333-444455556666/decision', body: { state: 'approved' } },
  { path: '/api/skills-catalog/claude/share', body: { skill: 'revisione', shared: true, sha256: 'a'.repeat(64) } },
  { path: '/api/profile/facts/share/confirm', body: { id: '0a5f3e1c-1111-4222-8333-444455556666' } },
  { path: '/api/god/plans/0a5f3e1c-1111-4222-8333-444455556666/land/approve', body: {} },
  { path: '/api/god/subtasks/0a5f3e1c-1111-4222-8333-444455556666/land/approve', body: { text: 'ok' } },
  { path: '/api/god/subtasks/0a5f3e1c-1111-4222-8333-444455556666/discard', body: {} },
  { path: '/api/routines/0a5f3e1c-1111-4222-8333-444455556666/approve', body: {} },
  { path: '/api/routines/0a5f3e1c-1111-4222-8333-444455556666/discard', body: {} },
  { path: '/api/archive/approve', body: { items: [{ name: 'nota.md', version: 'v1', folder: 'kb/work/clienti' }] } },
  { path: '/api/archive/discard', body: { name: 'nota.md', version: 'v1' } },
  { path: '/api/wiki/proposals/p1/approve', body: { path: 'kb/wiki/ricette/pane.md' } },
  { path: '/api/wiki/proposals/p1/discard', body: {} },
  { path: '/api/wiki/move', body: { from: 'kb/wiki/a', to: 'kb/wiki/b' } },
  { path: '/api/wiki/move-now', body: { kind: 'page', from: 'kb/wiki/a.md', to: 'kb/wiki/b.md', base: 'v1' } },
  { path: '/api/wiki/restore', body: { path: 'kb/wiki/a.md', version: 'v1', base: 'v2' } },
  { path: '/api/wiki/delete', body: { path: 'kb/wiki/a.md', base: 'v1' } },
  { path: '/api/wiki/folder/delete', body: { path: 'kb/wiki/vuota' } },
  { path: '/api/agents/traduttore/promote', body: { confirm: 'traduttore' } },
];

const header = (assertion: unknown): Record<string, string> => ({ [VERIFICATION_HEADER]: Buffer.from(JSON.stringify(assertion)).toString('base64url') });

test('HTTP: every decision from the phone asks Face ID for exactly it; the server refuses a missing, other, reused, late or foreign check', async () => {
  const mine = await pairDevice();
  const theirs = await pairDevice(new TestPasskey(), 'iPad');
  const ask = async (who: { token: string; passkey: TestPasskey }, path: string, body: unknown) => {
    const options = await remote('/api/remote/verify', { method: 'POST', body: { method: 'POST', path, body }, headers: { cookie: cookie(who.token) } });
    assert.equal(options.status, 200, path);
    return who.passkey.get({ challenge: (options.body.options as { challenge: string }).challenge }, HOST);
  };
  const send = (path: string, body: unknown, extra: Record<string, string> = {}) => remote(path, { method: 'POST', body, headers: { cookie: cookie(mine.token), ...extra } });
  const refused = (answer: Answer, what: string) => {
    assert.deepEqual([answer.status, answer.body.code], [403, 'verification-required'], what);
  };
  for (const { path, body } of STEP_UP_ACTIONS) {
    assert.equal(stepUpAction('POST', path) !== undefined, true, path);
    refused(await send(path, body), `${path}: no check`);
    // A check for another intent: another body (another path of the Wiki, another choice).
    refused(await send(path, body, header(await ask(mine, path, { ...body, other: 1 }))), `${path}: other intent`);
    // From another device.
    refused(await send(path, body, header(await ask(theirs, path, body))), `${path}: other device`);
    // The right one passes the check (the route then answers for itself: here without its service), once.
    const good = header(await ask(mine, path, body));
    const passed = await send(path, body, good);
    assert.notEqual(passed.body.code, 'verification-required', `${path}: right check`);
    refused(await send(path, body, good), `${path}: reused`);
    // Older than 5 minutes.
    const late = header(await ask(mine, path, body));
    clock += 5 * MINUTE + 1;
    refused(await send(path, body, late), `${path}: late`);
    // The sessions live on: they are used at every request.
  }
  // On the port of the Mac nothing is asked.
  assert.notEqual((await local('/api/routines/0a5f3e1c-1111-4222-8333-444455556666/approve', { method: 'POST', body: {} })).status, 403);
  // A check cannot be asked for a path that needs none.
  assert.equal((await remote('/api/remote/verify', { method: 'POST', body: { path: '/api/conversations', body: {} }, headers: { cookie: cookie(mine.token) } })).status, 400);
});

test('HTTP: the live feed opens from the phone with a session only, never the screen of the browser', async () => {
  const handshake = (path: string, headers: Record<string, string> = {}) =>
    remote(path, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
  assert.equal((await handshake('/api/ws')).status, 401);
  const { token, deviceId } = await pairDevice();
  assert.equal((await handshake('/api/browser/screen?t=x', { cookie: cookie(token) })).status, 403);
  // With the session the upgrade is accepted (101); unlinked, refused again.
  const upgraded = await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: server.remotePort ?? -1,
      path: '/api/ws',
      headers: { host: HOST, origin: ORIGIN, cookie: cookie(token), connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on('response', (response) => {
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(upgraded, 101);
  await local(`/api/devices/${deviceId}/unlink`, { method: 'POST', body: {} });
  assert.equal((await handshake('/api/ws', { cookie: cookie(token) })).status, 401);
});

test('HTTP: Impostazioni → Dispositivi on the Mac: the list with the last access, «Scollega»', async () => {
  const { deviceId, token } = await pairDevice();
  const listed = await local('/api/devices');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.host, HOST);
  const [device] = listed.body.devices as { id: string; name: string; lastSeenAt: string }[];
  assert.deepEqual([device?.id, device?.name], [deviceId, 'iPhone di prova']);
  assert.ok(device?.lastSeenAt !== undefined);
  assert.equal((await local(`/api/devices/${deviceId}/unlink`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await remote('/api/notifications/latest', { headers: { cookie: cookie(token) } })).status, 401);
  assert.deepEqual((await local('/api/devices')).body.devices, []);
  assert.equal((await local(`/api/devices/${deviceId}/unlink`, { method: 'POST', body: {} })).status, 404);
});

test('what only the Mac does stays there with a session: devices, privacy, the browser of the agent, actions on the Mac', () => {
  for (const path of ['/api/devices', '/api/devices/code', '/api/settings/privacy/confirm', '/api/notifications/stream', '/api/notifications/this-mac', '/api/browser/control', '/api/browse/demo/open', '/api/browse/demo/reveal']) {
    assert.equal(localOnly(path), true, path);
  }
  // The decisions are no longer Mac only: they ask Face ID (step-up).
  for (const { path } of STEP_UP_ACTIONS) assert.equal(localOnly(path), false, path);
  for (const path of ['/api/conversations', '/api/push/subscribe', '/api/devicesx', '/api/browse/demo/tree', '/api/routines/x', '/api/settings']) {
    assert.equal(localOnly(path), false, path);
    assert.equal(stepUpAction('POST', path), undefined, path);
  }
  assert.equal(stepUpAction('GET', '/api/routines/x/approve'), undefined);
});

test('HTTP: «Scollega» closes at once a live feed already open from the phone', async () => {
  const { WebSocket } = await import('ws');
  const { token, deviceId } = await pairDevice();
  const ws = new WebSocket(`ws://127.0.0.1:${String(server.remotePort)}/api/ws`, { headers: { host: HOST, origin: ORIGIN, cookie: cookie(token) } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  const closed = new Promise<number>((resolve) => {
    ws.once('close', (code) => {
      resolve(code);
    });
  });
  await local(`/api/devices/${deviceId}/unlink`, { method: 'POST', body: {} });
  assert.equal(await closed, 4401);
});
