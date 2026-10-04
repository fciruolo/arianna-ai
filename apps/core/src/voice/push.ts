import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

import type { Sql } from '../db/client.ts';

/**
 * Web Push without content (D-066, choice 7): the notification only says
 * "Arianna ti chiama", written by the service worker; the request carries no
 * body, so no RFC 8291 encryption is needed, only the VAPID header (RFC 8292)
 * signed ES256 with node:crypto. The push services are cloud: the core sends
 * only after the gateway allowed the fixed L0 text on channel `push`.
 */

/** The push services of the browsers; any other endpoint is refused (no request to arbitrary hosts). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

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
  if (point.length !== 65 || point[0] !== 4) throw new PushError('voice.push.public_key: not an uncompressed P-256 point');
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

export type PushPoster = (endpoint: string, headers: Record<string, string>) => Promise<number>;

/** An empty POST over https; the answer status only. */
export const postPush: PushPoster = (endpoint, headers) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(endpoint, { method: 'POST', headers: { ...headers, 'content-length': '0' }, timeout: 10_000 }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    });
    req.on('timeout', () => req.destroy(new PushError('push service timeout')));
    req.on('error', reject);
    req.end();
  });

/** 404 and 410: the subscription is gone and must be forgotten. */
export function isGone(status: number): boolean {
  return status === 404 || status === 410;
}

export interface Pusher {
  readonly publicKey: string;
  subscribe(subscription: Subscription): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  /** "Arianna ti chiama" to every subscribed browser: an empty push after the gateway allowed the fixed text. */
  notify(): Promise<number>;
}

/** The fixed text the service worker shows; it is what the gateway checks on channel `push`. */
export const PUSH_TEXT = 'Arianna ti chiama';

export interface PusherOptions {
  sql: Sql;
  publicKey: string;
  key: KeyObject;
  subject: string;
  post?: PushPoster;
  /** The gateway pass on channel `push`; true when the fixed text may leave. */
  gate: () => Promise<boolean>;
  onError?: (error: unknown) => void;
}

export function createPusher(options: PusherOptions): Pusher {
  const { sql } = options;
  const post = options.post ?? postPush;
  return {
    publicKey: options.publicKey,
    async subscribe(subscription) {
      await sql`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth})
        ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, removed_at = NULL`;
    },
    async unsubscribe(endpoint) {
      await sql`UPDATE push_subscriptions SET removed_at = now() WHERE endpoint = ${endpoint} AND removed_at IS NULL`;
    },
    async notify() {
      const subscriptions = await sql<{ endpoint: string }[]>`SELECT endpoint FROM push_subscriptions WHERE removed_at IS NULL ORDER BY id`;
      if (subscriptions.length === 0 || !(await options.gate())) return 0;
      let sent = 0;
      for (const { endpoint } of subscriptions) {
        // The table only says https: the host is checked again before anything is sent.
        if (!isPushEndpoint(endpoint)) continue;
        try {
          const status = await post(endpoint, {
            ttl: '30',
            urgency: 'high',
            authorization: vapidHeader(endpoint, options.subject, options.publicKey, options.key),
          });
          if (isGone(status)) await sql`UPDATE push_subscriptions SET removed_at = now() WHERE endpoint = ${endpoint}`;
          else if (status >= 200 && status < 300) sent += 1;
        } catch (error) {
          options.onError?.(error);
        }
      }
      return sent;
    },
  };
}
