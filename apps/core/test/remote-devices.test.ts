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
  CODE_MAX_WRONG,
  createRemoteDevices,
  decisionDigest,
  deviceName,
  PAIR_PER_MINUTE,
  RemoteError,
  SESSION_COOKIE,
  sessionToken,
  uuidBytes,
  type RemoteDevices,
} from '../src/remote/devices.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { localOnly } from '../src/server/remote.ts';
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

test('a decision from the phone needs a passkey check bound to it, of this session, not older than 5 minutes', async () => {
  const { passkey, token, deviceId } = await pairDevice();
  const session = await devices.session(cookie(token));
  assert.ok(session !== undefined);
  const approve = { approvalId: '0a5f3e1c-1111-4222-8333-444455556666', state: 'approved' as const };
  const check = async (binding = approve, signCount?: number) => {
    const options = await devices.decisionOptions(session, binding);
    assert.deepEqual(options.allowCredentials.map((item) => item.id), [passkey.id.toString('base64url')]);
    // The challenge carries the digest of the decision.
    assert.deepEqual(Buffer.from(options.challenge, 'base64url').subarray(16), decisionDigest(binding));
    return { challenge: options.challenge, assertion: passkey.get({ challenge: options.challenge, ...(signCount === undefined ? {} : { signCount }) }, HOST) };
  };
  // No check at all, or one that is not a passkey answer.
  await assert.rejects(devices.verifyDecision(session, approve, undefined), refusedWith(403, 'verification-required'));
  await assert.rejects(devices.verifyDecision(session, approve, { response: { clientDataJSON: '!' } }), refusedWith(403, 'verification-required'));
  // The right check passes, once.
  const good = await check();
  await devices.verifyDecision(session, approve, good.assertion);
  await assert.rejects(devices.verifyDecision(session, approve, good.assertion), refusedWith(403, 'verification-required'));
  // A check for another choice or another approval.
  const other = await check();
  await assert.rejects(devices.verifyDecision(session, { ...approve, state: 'rejected' }, other.assertion), refusedWith(403, 'verification-required'));
  const another = await check();
  await assert.rejects(devices.verifyDecision(session, { ...approve, approvalId: '0a5f3e1c-1111-4222-8333-000000000000' }, another.assertion), refusedWith(403, 'verification-required'));
  // Older than 5 minutes.
  const late = await check();
  clock += 5 * MINUTE;
  await assert.rejects(devices.verifyDecision(session, approve, late.assertion), refusedWith(403, 'verification-required'));
  // A check asked by another session of the same device.
  const otherSession = { ...session, id: 'another' };
  const stolen = await check();
  await assert.rejects(devices.verifyDecision(otherSession, approve, stolen.assertion), refusedWith(403, 'verification-required'));
  // A bad signature on the right challenge.
  const options = await devices.decisionOptions(session, approve);
  await assert.rejects(devices.verifyDecision(session, approve, passkey.get({ challenge: options.challenge }, HOST, { badSignature: true })), refusedWith(403, 'verification-required'));
  const outcomes = store.events.filter((event) => event.kind === 'remote.decision').map((event) => [event.payload.device, event.payload.outcome]);
  assert.deepEqual(outcomes[0], [deviceId, 'refused']);
  assert.ok(outcomes.some(([, outcome]) => outcome === 'ok'));
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
  assert.equal((await remote('/api/god/subtasks/x/land/merge', { method: 'POST', body: {}, headers: { cookie: cookie(token) } })).status, 403);
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

test('HTTP: a decision from the phone without its passkey check is refused by the server', async () => {
  const { token, passkey } = await pairDevice();
  const path = '/api/approvals/0a5f3e1c-1111-4222-8333-444455556666/decision';
  const decision = await remote(path, { method: 'POST', body: { state: 'approved' }, headers: { cookie: cookie(token) } });
  assert.deepEqual([decision.status, decision.body.code], [403, 'verification-required']);
  // A check for another approval, or for the other choice, does not open this one.
  for (const asked of [{ approvalId: '0a5f3e1c-1111-4222-8333-000000000000', state: 'approved' }, { approvalId: '0a5f3e1c-1111-4222-8333-444455556666', state: 'rejected' }]) {
    const options = await remote('/api/remote/verify', { method: 'POST', body: asked, headers: { cookie: cookie(token) } });
    assert.equal(options.status, 200);
    const verification = passkey.get({ challenge: (options.body.options as { challenge: string }).challenge }, HOST);
    const refused = await remote(path, { method: 'POST', body: { state: 'approved', verification }, headers: { cookie: cookie(token) } });
    assert.deepEqual([refused.status, refused.body.code], [403, 'verification-required']);
  }
  // On the port of the Mac the field does not exist.
  assert.equal((await local(path, { method: 'POST', body: { state: 'approved', verification: {} } })).status, 400);
  // Without a session the check cannot even be asked.
  assert.equal((await remote('/api/remote/verify', { method: 'POST', body: { approvalId: '0a5f3e1c-1111-4222-8333-000000000000', state: 'approved' } })).status, 401);
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

test('what only the Mac does stays there with a session: other decisions, the browser of the agent, actions on the Mac', () => {
  for (const path of [
    '/api/devices',
    '/api/devices/code',
    '/api/settings/privacy/confirm',
    '/api/notifications/stream',
    '/api/notifications/this-mac',
    '/api/skills-catalog/claude/share',
    '/api/profile/facts/share/confirm',
    '/api/god/plans/x/land/merge',
    '/api/god/subtasks/x/approve',
    '/api/routines/x/approve',
    '/api/archive/approve',
    '/api/wiki/proposals/x/approve',
    '/api/agents/x/promote',
    '/api/browser/control',
    '/api/browse/demo/open',
    '/api/browse/demo/reveal',
  ]) {
    assert.equal(localOnly(path), true, path);
  }
  for (const path of ['/api/conversations', '/api/approvals/x/decision', '/api/push/subscribe', '/api/devicesx', '/api/browse/demo/tree', '/api/routines/x', '/api/settings']) {
    assert.equal(localOnly(path), false, path);
  }
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
