import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { TcpSocketConnectOpts } from 'node:net';

import type { Sql } from '../db/client.ts';
import { encryptPush } from './push-crypto.ts';

/**
 * Web Push (D-066, choice 7; I-1) with the VAPID header (RFC 8292) signed
 * ES256 with node:crypto. Since D-295 the request carries the kind of the
 * notice and the id of its conversation, encrypted for the subscribed browser
 * alone (RFC 8291, push-crypto.ts): the push service carries bytes it cannot
 * read, and the phone knows what happened with its session expired. The
 * service worker writes a fixed sentence for the kind, never a text; without
 * a readable payload it asks the core, as before. The push services are
 * cloud: the core sends only after the gateway allowed the fixed L0 sentence
 * of that kind on channel `push`.
 */

/** The push services of the browsers; any other endpoint is refused (no request to arbitrary hosts). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every payload as long as the longest: its length does not tell the kind or whether a conversation is named. */
const PAYLOAD_BYTES = 96;

export class PushError extends Error {
  override name = 'PushError';
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function isPushEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && PUSH_HOSTS.some((host) => host.test(url.hostname));
}

/** Checks a subscription the page sends; the keys are kept, though no payload is encrypted with them. */
export function parseSubscription(value: unknown): Subscription {
  if (typeof value !== 'object' || value === null) throw new PushError('subscription: expected an object');
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !URL.canParse(endpoint)) throw new PushError('endpoint: an https URL of a push service');
  if (!isPushEndpoint(endpoint)) throw new PushError('endpoint: an https URL of a push service');
  const { p256dh, auth } = (typeof keys === 'object' && keys !== null ? keys : {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== 'string' || !BASE64URL.test(p256dh) || p256dh.length > 128 || typeof auth !== 'string' || !BASE64URL.test(auth) || auth.length > 64) {
    throw new PushError('keys: p256dh and auth, base64url');
  }
  return { endpoint, p256dh, auth };
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** A new VAPID key pair: the public key as the uncompressed point, the private as the 32-byte scalar. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  if (jwk.d === undefined || pub.x === undefined || pub.y === undefined) throw new PushError('key generation failed');
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { publicKey: b64url(point), privateKey: jwk.d };
}

/** The private key from the two halves in arianna.toml and the vault. */
export function vapidKey(publicKey: string, privateKey: string): KeyObject {
  const point = Buffer.from(publicKey, 'base64url');
  if (point.length !== 65 || point[0] !== 4) throw new PushError('push.public_key: not an uncompressed P-256 point');
  const d = Buffer.from(privateKey, 'base64url');
  if (d.length !== 32) throw new PushError('the VAPID private key must be 32 bytes, base64url');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) } });
  // The two halves must belong together, or every push would be refused: a
  // signature of the private half must verify with the public point alone.
  const publicOnly = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) } });
  const probe = Buffer.from('arianna-vapid-check');
  if (!verify('sha256', probe, { key: publicOnly, dsaEncoding: 'ieee-p1363' }, sign('sha256', probe, { key, dsaEncoding: 'ieee-p1363' }))) {
    throw new PushError('the VAPID keys do not match');
  }
  return key;
}

/** `Authorization: vapid t=<JWT>, k=<public key>` for one push service (RFC 8292). */
export function vapidHeader(endpoint: string, subject: string, publicKey: string, key: KeyObject, now: Date = new Date()): string {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

export type PushPoster = (endpoint: string, headers: Record<string, string>, body?: Buffer) => Promise<number>;

/**
 * Each address family gets 2 s: with Node's 250 ms a busy core (a reply just
 * ending) timed out on every address (AggregateError ETIMEDOUT). A socket
 * option the https types do not list; Node passes it on to the connection.
 */
const CONNECT: Pick<TcpSocketConnectOpts, 'autoSelectFamilyAttemptTimeout'> = { autoSelectFamilyAttemptTimeout: 2_000 };

/** A POST over https, empty or with the encrypted payload; the answer status only. */
export const postPush: PushPoster = (endpoint, headers, body) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(endpoint, { method: 'POST', headers: { ...headers, 'content-length': String(body?.length ?? 0) }, timeout: 10_000, ...CONNECT }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    });
    req.on('timeout', () => req.destroy(new PushError('push service timeout')));
    req.on('error', reject);
    req.end(body);
  });

/** 404 and 410: the subscription is gone and must be forgotten. */
export function isGone(status: number): boolean {
  return status === 404 || status === 410;
}

/** What a push is about: the service worker learns it from the core, never from the push. */
export type PushKind = 'call' | 'reply' | 'approval' | 'failure' | 'reminder';

export interface Pusher {
  readonly publicKey: string;
  /** `deviceId`: the paired phone it came from (D-292), absent on the Mac. */
  subscribe(subscription: Subscription, deviceId?: string): Promise<void>;
  /** `deviceId`: from the phone, only a subscription of that device. */
  unsubscribe(endpoint: string, deviceId?: string): Promise<void>;
  /**
   * A push to every subscribed browser, after the gateway allowed the fixed
   * sentence of `kind`: kind and conversation encrypted for each (D-295).
   */
  notify(kind: PushKind, options?: { skip?: ReadonlySet<string>; conversationId?: string | null }): Promise<number>;
}

/** The fixed sentences the service worker shows (public/sw.js); what the gateway checks on channel `push`. */
export const PUSH_TEXTS: Readonly<Record<PushKind, string>> = {
  call: 'Arianna ti chiama',
  reply: 'Arianna ha risposto',
  approval: 'Arianna aspetta una tua decisione',
  failure: 'Un lavoro è fallito',
  reminder: 'Arianna ha un promemoria',
};

export interface PusherOptions {
  sql: Sql;
  publicKey: string;
  key: KeyObject;
  subject: string;
  post?: PushPoster;
  /** The gateway pass on channel `push` for the fixed sentence of a kind; true when it may leave. */
  gate: (text: string, kind: PushKind) => Promise<boolean>;
  onError?: (error: unknown) => void;
}

export function createPusher(options: PusherOptions): Pusher {
  const { sql } = options;
  const post = options.post ?? postPush;
  // Keys that are not a point of the curve (a browser of before, a broken row): an empty push, and the service worker asks the core.
  const encrypted = (payload: Buffer, p256dh: string, auth: string): Buffer | undefined => {
    try {
      return encryptPush(payload, p256dh, auth);
    } catch (error) {
      options.onError?.(error);
      return undefined;
    }
  };
  return {
    publicKey: options.publicKey,
    async subscribe(subscription, deviceId) {
      // From the phone (D-292), the paired device it belongs to: «Scollega» stops its notices.
      await sql`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_id) VALUES (${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth}, ${deviceId ?? null})
        ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device_id = EXCLUDED.device_id, removed_at = NULL`;
    },
    async unsubscribe(endpoint, deviceId) {
      // From the phone (D-292) only a subscription of that device.
      if (deviceId !== undefined) {
        await sql`UPDATE push_subscriptions SET removed_at = now() WHERE endpoint = ${endpoint} AND device_id = ${deviceId} AND removed_at IS NULL`;
        return;
      }
      await sql`UPDATE push_subscriptions SET removed_at = now() WHERE endpoint = ${endpoint} AND removed_at IS NULL`;
    },
    async notify(kind, notifyOptions = {}) {
      const skip = notifyOptions.skip ?? new Set<string>();
      // The browsers of the Mac while its helper shows the notice (D-128): left out, never a call.
      const subscriptions = (
        await sql<{ endpoint: string; p256dh: string; auth: string }[]>`
          SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
          WHERE s.removed_at IS NULL
            -- A phone unlinked meanwhile (D-292) gets nothing, whatever the race with its subscription.
            AND (s.device_id IS NULL OR EXISTS (SELECT FROM remote_devices d WHERE d.id = s.device_id AND d.revoked_at IS NULL))
          ORDER BY s.id`
      ).filter(
        ({ endpoint }) => kind === 'call' || !skip.has(endpoint),
      );
      if (subscriptions.length === 0 || !(await options.gate(PUSH_TEXTS[kind], kind))) return 0;
      // A call is worth only while it rings; a notice waits a while. No `topic`:
      // Apple refuses `arianna-<kind>` (400 BadWebPushTopic), and without it the
      // push service does not learn the kind either.
      const timing = kind === 'call' ? { ttl: '30', urgency: 'high' } : { ttl: '3600', urgency: 'normal' };
      // Only the kind, from a closed list, and the id the core gave the conversation: anything
      // that is not an id leaves as null, so no text can ride along (D-295).
      const conversationId = notifyOptions.conversationId !== undefined && notifyOptions.conversationId !== null && UUID.test(notifyOptions.conversationId) ? notifyOptions.conversationId : null;
      const payload = Buffer.from(JSON.stringify({ kind, conversationId }).padEnd(PAYLOAD_BYTES, ' '));
      let sent = 0;
      for (const { endpoint, p256dh, auth } of subscriptions) {
        // The table only says https: the host is checked again before anything is sent.
        if (!isPushEndpoint(endpoint)) continue;
        try {
          const body = encrypted(payload, p256dh, auth);
          const status = await post(
            endpoint,
            {
              ...timing,
              ...(body === undefined ? {} : { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' }),
              authorization: vapidHeader(endpoint, options.subject, options.publicKey, options.key),
            },
            body,
          );
          if (isGone(status)) await sql`UPDATE push_subscriptions SET removed_at = now() WHERE endpoint = ${endpoint}`;
          else if (status >= 200 && status < 300) sent += 1;
          // A refusal (403 for a bad VAPID signature, 413, 429…): the status only, never the endpoint.
          else options.onError?.(Object.assign(new PushError(`push service answered ${String(status)}`), { code: `status-${String(status)}` }));
        } catch (error) {
          options.onError?.(error);
        }
      }
      return sent;
    },
  };
}
