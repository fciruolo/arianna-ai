// The devices of the remote port on PostgreSQL (D-292, stage B; migration
// 0089): the store of the service, the guards of the tables, the events with
// metadata only, «Scollega» with the push subscriptions of the phone, and a
// decision on an approval from the phone through the remote port, with the
// passkey check bound to it. Passkeys generated in the test, made-up names.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { after, beforeEach, test } from 'node:test';

import { createRemoteDevices, SESSION_COOKIE, sessionHash, type RemoteDevices } from '../src/remote/devices.ts';
import { createDeviceStore } from '../src/remote/store.ts';
import { startLiveFeed, type LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { TestPasskey } from '../test/support/passkey.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOST = 'mac-prova.tail0000.ts.net';
const ORIGIN = `https://${HOST}`;
const MINUTE = 60_000;
let clock = Date.parse('2026-10-22T10:00:00Z');
let devices: RemoteDevices;
let live: LiveFeed;
let server: ApiServer;

let started: Promise<void> | undefined;
/** The service and the server, once, on the database of this file (ready only inside a test). */
function ready(): Promise<void> {
  started ??= (async () => {
    devices = createRemoteDevices({ store: createDeviceStore(db().sql), host: HOST, now: () => clock });
    live = await startLiveFeed(db().sql);
    server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, remote: { host: HOST, port: 0 }, remoteDevices: devices });
  })();
  return started;
}

after(async () => {
  if (started === undefined) return;
  await server.close();
  await live.close();
});

beforeEach(ready);

async function pairDevice(name = 'iPhone di prova'): Promise<{ passkey: TestPasskey; deviceId: string; token: string }> {
  const passkey = new TestPasskey();
  const options = await devices.pair(devices.newCode(name).code);
  const { token, deviceId } = await devices.register(passkey.create({ challenge: options.challenge }, HOST, Buffer.from(options.user.id, 'base64url')));
  return { passkey, deviceId, token };
}

const cookie = (token: string): string => `${SESSION_COOKIE}=${token}`;

function post(path: string, body: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = httpRequest(
      { host: '127.0.0.1', port: server.remotePort ?? -1, path, method: 'POST', headers: { host: HOST, origin: ORIGIN, cookie: cookie(token), 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.end(text);
  });
}

test('0089: pairing writes the device, its public key and the sha256 of the cookie; never the cookie', async () => {
  const { deviceId, token, passkey } = await pairDevice();
  const [device] = await db().sql<{ name: string; revoked: boolean }[]>`SELECT name, revoked_at IS NOT NULL AS revoked FROM remote_devices WHERE id = ${deviceId}`;
  assert.deepEqual(device, { name: 'iPhone di prova', revoked: false });
  const [credential] = await db().sql<{ id: Buffer; algorithm: number }[]>`SELECT credential_id AS id, algorithm FROM remote_credentials WHERE device_id = ${deviceId}`;
  assert.deepEqual(credential?.id, passkey.id);
  assert.equal(credential.algorithm, -7);
  const sessions = await db().sql<{ hash: Buffer }[]>`SELECT token_hash AS hash FROM remote_sessions WHERE device_id = ${deviceId}`;
  assert.deepEqual(sessions.map((row) => row.hash), [sessionHash(token)]);
  const everything = JSON.stringify(await db().owner`SELECT * FROM remote_sessions`);
  assert.ok(!everything.includes(token));
  assert.notEqual(await devices.session(cookie(token)), undefined);
});

test('0089: sign-in, the 30 minutes and the 12 hours on the database', async () => {
  const { passkey } = await pairDevice();
  const { token } = await devices.login(passkey.get({ challenge: devices.loginOptions().challenge }, HOST));
  clock += 29 * MINUTE;
  assert.notEqual(await devices.session(cookie(token)), undefined);
  clock += 31 * MINUTE;
  assert.equal(await devices.session(cookie(token)), undefined);
  const again = await devices.login(passkey.get({ challenge: devices.loginOptions().challenge }, HOST));
  for (let step = 0; step < 36; step += 1) {
    clock += 20 * MINUTE;
    await devices.session(cookie(again.token));
  }
  assert.equal(await devices.session(cookie(again.token)), undefined);
});

test('0089: the guards: no session over 12 hours, no counter going back, no revocation undone, nothing for an unlinked device', async () => {
  const { deviceId } = await pairDevice();
  const now = new Date(clock);
  await assert.rejects(
    db().sql`INSERT INTO remote_sessions (device_id, token_hash, created_at, last_seen_at, expires_at) VALUES (${deviceId}, ${randomBytes(32)}, ${now}, ${now}, ${new Date(clock + 13 * 3_600_000)})`,
    /remote_sessions_check|expires_at/,
  );
  await db().sql`UPDATE remote_credentials SET sign_count = 5 WHERE device_id = ${deviceId}`;
  await assert.rejects(db().sql`UPDATE remote_credentials SET sign_count = 4 WHERE device_id = ${deviceId}`, /remote_credentials_guard/);
  await assert.rejects(db().sql`UPDATE remote_credentials SET public_key = ${randomBytes(91)} WHERE device_id = ${deviceId}`, /remote_credentials_guard/);
  await assert.rejects(db().sql`DELETE FROM remote_devices WHERE id = ${deviceId}`, /permission denied/);
  await devices.unlink(deviceId);
  await assert.rejects(db().sql`UPDATE remote_devices SET revoked_at = NULL WHERE id = ${deviceId}`, /remote_devices_guard/);
  await assert.rejects(db().sql`UPDATE remote_sessions SET revoked_at = NULL WHERE device_id = ${deviceId}`, /remote_sessions_guard/);
  await assert.rejects(
    db().sql`INSERT INTO remote_sessions (device_id, token_hash, created_at, last_seen_at, expires_at) VALUES (${deviceId}, ${randomBytes(32)}, ${now}, ${now}, ${new Date(clock + 3_600_000)})`,
    /remote_device_live/,
  );
  await assert.rejects(
    db().sql`INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_id) VALUES ('https://web.push.apple.com/x-unlinked', 'a', 'b', ${deviceId})`,
    /remote_device_live/,
  );
  await assert.rejects(db().sql`INSERT INTO remote_devices (name) VALUES (${'a\nb'})`, /remote_devices_name_check/);
});

test('«Scollega» on the database: sessions, passkeys and the push of the phone end at once; events carry ids only', async () => {
  const { deviceId, token, passkey } = await pairDevice('iPhone di Gilda');
  const endpoint = `https://web.push.apple.com/${randomBytes(8).toString('hex')}`;
  const subscribed = await post('/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } } }, token);
  // Without push keys in this test the route answers 404; the subscription with its device is checked directly below.
  if (subscribed.status !== 201) await db().sql`INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_id) VALUES (${endpoint}, 'a', 'b', ${deviceId})`;
  await devices.unlink(deviceId);
  assert.equal(await devices.session(cookie(token)), undefined);
  await assert.rejects(devices.login(passkey.get({ challenge: devices.loginOptions().challenge }, HOST)));
  const [push] = await db().sql<{ removed: boolean }[]>`SELECT removed_at IS NOT NULL AS removed FROM push_subscriptions WHERE endpoint = ${endpoint}`;
  assert.equal(push?.removed, true);
  const events = await db().sql<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label::text AS label, payload FROM events WHERE kind LIKE 'remote.%' AND payload ->> 'device' = ${deviceId} ORDER BY id`;
  assert.deepEqual(
    events.map((event) => [event.kind, event.label, event.payload.outcome]),
    [
      ['remote.paired', 'L0', 'ok'],
      ['remote.unlinked', 'L0', 'ok'],
    ],
  );
  const all = JSON.stringify(await db().sql`SELECT payload FROM events WHERE kind LIKE 'remote.%'`);
  assert.ok(!all.includes('Gilda'));
  assert.ok(!all.includes(token));
});

test('a decision from the phone: refused without the passkey check, recorded with it', async () => {
  const { passkey, token } = await pairDevice();
  const [row] = await db().sql<{ id: string }[]>`INSERT INTO approvals (kind, action, detail, label) VALUES ('action', 'send_external', '{}', 'L1') RETURNING id::text`;
  assert.ok(row !== undefined);
  const path = `/api/approvals/${row.id}/decision`;
  const refused = await post(path, { state: 'approved' }, token);
  assert.deepEqual([refused.status, refused.body.code], [403, 'verification-required']);
  // A check asked for «rifiuta» does not approve.
  const wrong = await post('/api/remote/verify', { approvalId: row.id, state: 'rejected' }, token);
  const wrongCheck = passkey.get({ challenge: (wrong.body.options as { challenge: string }).challenge }, HOST);
  assert.equal((await post(path, { state: 'approved', verification: wrongCheck }, token)).status, 403);
  const [still] = await db().sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${row.id}`;
  assert.equal(still?.state, 'pending');

  const asked = await post('/api/remote/verify', { approvalId: row.id, state: 'approved' }, token);
  const check = passkey.get({ challenge: (asked.body.options as { challenge: string }).challenge }, HOST);
  const decided = await post(path, { state: 'approved', verification: check }, token);
  assert.equal(decided.status, 200);
  const [after] = await db().sql<{ state: string }[]>`SELECT state FROM approvals WHERE id = ${row.id}`;
  assert.equal(after?.state, 'approved');
});
