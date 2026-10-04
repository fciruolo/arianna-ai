import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';

import { DEFAULT_VOICE } from '@arianna/config';

import { inQuietHours, isWeekend, mayCall, startOfDay } from '../src/voice/outgoing.ts';
import { generateVapidKeys, isGone, parseSubscription, vapidHeader, vapidKey } from '../src/voice/push.ts';

const rules = DEFAULT_VOICE.outgoing;
// Local times: a Monday and a Saturday.
const monday = (hours: number, minutes = 0) => new Date(2026, 9, 5, hours, minutes);
const saturday = (hours: number) => new Date(2026, 9, 3, hours, 0);

test('quiet hours span midnight; equal bounds mean none; the weekend is Saturday and Sunday', () => {
  assert.ok(inQuietHours(monday(22), '21:00', '08:00'));
  assert.ok(inQuietHours(monday(7, 59), '21:00', '08:00'));
  assert.ok(!inQuietHours(monday(8), '21:00', '08:00'));
  assert.ok(!inQuietHours(monday(20, 59), '21:00', '08:00'));
  assert.ok(inQuietHours(monday(13, 30), '13:00', '14:00'));
  assert.ok(!inQuietHours(monday(3), '10:00', '10:00'));
  assert.ok(isWeekend(saturday(10)) && !isWeekend(monday(10)));
  assert.deepEqual(startOfDay(monday(15, 20)), new Date(2026, 9, 5));
});

test('mayCall: the rules of the user; a scheduled call skips quiet hours and weekend, never the daily maximum', () => {
  assert.deepEqual(mayCall(monday(10), rules, 0, 'waiting'), { ok: true });
  assert.deepEqual(mayCall(monday(22), rules, 0, 'waiting'), { ok: false, reason: 'quiet-hours' });
  assert.deepEqual(mayCall(saturday(11), rules, 0, 'task-done'), { ok: false, reason: 'quiet-hours' });
  assert.deepEqual(mayCall(monday(10), rules, 3, 'waiting'), { ok: false, reason: 'daily-limit' });
  assert.deepEqual(mayCall(saturday(23), rules, 2, 'scheduled'), { ok: true });
  assert.deepEqual(mayCall(monday(10), rules, 3, 'scheduled'), { ok: false, reason: 'daily-limit' });
  assert.deepEqual(mayCall(saturday(11), { ...rules, quietWeekend: false }, 0, 'waiting'), { ok: true });
});

test('VAPID: the header is a JWT signed ES256 for the origin of the push service, verifiable with the public key', () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const key = vapidKey(keys.publicKey, keys.privateKey);
  const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', 'mailto:me@example.org', keys.publicKey, key, new Date(0));
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match !== null);
  const [, head = '', claims = '', signature = '', publicKey] = match;
  assert.equal(publicKey, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), { aud: 'https://fcm.googleapis.com', exp: 12 * 3600, sub: 'mailto:me@example.org' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  // Halves that do not belong together, or of the wrong size, are refused.
  assert.throws(() => vapidKey(generateVapidKeys().publicKey, keys.privateKey), { name: 'PushError' });
  assert.throws(() => vapidKey(keys.publicKey, 'AAAA'), { name: 'PushError' });
});

test('subscriptions: only https endpoints of the browsers’ push services, with their keys', () => {
  const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x']) {
    assert.equal(parseSubscription({ endpoint, keys }).endpoint, endpoint);
  }
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x']) {
    assert.throws(() => parseSubscription({ endpoint, keys }), { name: 'PushError' }, endpoint);
  }
  assert.throws(() => parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x y', auth: 'a' } }), { name: 'PushError' });
  assert.ok(isGone(410) && isGone(404) && !isGone(201));
});
