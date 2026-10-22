/**
 * The devices of the remote port (D-292, stage B): pairing with a code shown
 * on the Mac, the passkey the phone creates, sign-in with Face ID, the
 * session cookie, the passkey asked again for each decision on an approval,
 * and «Scollega».
 *
 * What lives in memory, in this process only: the one pairing code, the
 * challenges (single use, short-lived) and the limits per minute. A restart
 * of the core forgets them, and that is fine: a code is made again on the
 * Mac, a challenge is asked again. What lives in the database (store.ts):
 * devices, public keys of the passkeys, and the sha256 of the session
 * cookies. Events carry the id of the device and the outcome, never a
 * code, a cookie, a key or the name of a device.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { base64url, fromBase64url, verifyAssertion, verifyRegistration, WebAuthnError, type CoseAlgorithm, type NewCredential } from './webauthn.ts';

export const SESSION_COOKIE = '__Host-arianna-session';
export const SESSION_MAX_MS = 12 * 60 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
/** The last use of a session is written at most this often: not one write per request. */
export const SESSION_TOUCH_MS = 60_000;
export const CODE_TTL_MS = 5 * 60_000;
export const CODE_MAX_WRONG = 5;
/** Codes typed on the phone, right or wrong, in a minute, from anyone: a 6-digit code is never guessed by trying. */
export const PAIR_PER_MINUTE = 10;
export const LOGIN_PER_MINUTE = 30;
export const REGISTER_TTL_MS = 5 * 60_000;
export const LOGIN_TTL_MS = 2 * 60_000;
/** How old the passkey check of a decision on an approval may be (D-292). */
export const DECISION_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 100;
const DEVICE_NAME_MAX = 60;

export type RemoteEventKind = 'remote.paired' | 'remote.login' | 'remote.unlinked' | 'remote.decision';

/** An event of the log: the device id (when known) and the outcome, nothing else. */
export interface RemoteEvent {
  kind: RemoteEventKind;
  payload: { device?: string; outcome: 'ok' | 'refused'; reason?: string };
}

export interface StoredDeviceCredential {
  deviceId: string;
  credentialId: Buffer;
  publicKey: Buffer;
  algorithm: CoseAlgorithm;
  signCount: number;
}

export interface DeviceSummary {
  id: string;
  /** Text of the user (L1): for the settings page of the Mac only. */
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** The database side (store.ts); an in-memory one in the tests. Times come from the service's clock. */
export interface DeviceStore {
  /** A new device with its first credential and its first session, in one transaction. */
  pair(device: { id: string; name: string }, credential: NewCredential, session: NewSession): Promise<void>;
  /** A credential of a device not unlinked, by its id. */
  credential(credentialId: Buffer): Promise<StoredDeviceCredential | undefined>;
  /** The credential ids of a device not unlinked. */
  credentials(deviceId: string): Promise<Buffer[]>;
  /** Moves the counter forward; false when another use moved it meanwhile, or the credential is gone. */
  useCredential(credentialId: Buffer, from: number, to: number, at: Date): Promise<boolean>;
  createSession(deviceId: string, session: NewSession): Promise<void>;
  /** A session alive at `now`: not revoked, its device not unlinked, before its end and not idle. */
  session(tokenHash: Buffer, now: Date, idleMs: number): Promise<{ id: string; deviceId: string; lastSeenAt: Date } | undefined>;
  touchSession(id: string, deviceId: string, at: Date): Promise<void>;
  /** The same rules as `session`, by id, without counting as a use: for a socket left open. */
  sessionAlive(id: string, now: Date, idleMs: number): Promise<boolean>;
  endSession(tokenHash: Buffer, at: Date): Promise<void>;
  list(): Promise<DeviceSummary[]>;
  /** Revokes the device, its credentials, its sessions and its push subscriptions; false when there was none to unlink. */
  unlink(deviceId: string, at: Date): Promise<boolean>;
  event(event: RemoteEvent): Promise<void>;
}

export interface NewSession {
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

/** A refusal with an HTTP status and a code the page understands; the message is English, the page has its own words. */
export class RemoteError extends Error {
  override name = 'RemoteError';
  readonly status: 400 | 401 | 403 | 404 | 409 | 429;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 409 | 429, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A remote request with a valid session. */
export interface RemoteSession {
  id: string;
  deviceId: string;
}

/** What a decision on an approval is: the passkey check is bound to exactly this. */
export interface DecisionBinding {
  approvalId: string;
  state: 'approved' | 'rejected';
  choice?: string;
  starts?: unknown;
  revision?: unknown;
}

/** The bytes a decision's challenge carries after its nonce: the sha256 of the decision, so the assertion is of this decision only. */
export function decisionDigest(binding: DecisionBinding): Buffer {
  const canonical = JSON.stringify([binding.approvalId, binding.state, binding.choice ?? null, binding.starts ?? null, binding.revision ?? null]);
  return createHash('sha256').update('arianna-decision\0').update(canonical).digest();
}

export function sessionHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** The session cookie of a Cookie header, when it has the shape the core gives (32 bytes, base64url). */
export function sessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== SESSION_COOKIE) continue;
    const value = rest.join('=');
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

export function sessionCookie(token: string, maxMs = SESSION_MAX_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${String(Math.floor(maxMs / 1000))}`;
}

export const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

/** A device name typed on the Mac: trimmed, 1 to 60 characters, no control characters; «iPhone» when empty. */
export function deviceName(value: unknown): string {
  if (value === undefined || value === null) return 'iPhone';
  if (typeof value !== 'string') throw new RemoteError(400, 'name', 'name must be a text');
  const name = value.trim();
  if (name === '') return 'iPhone';
  // eslint-disable-next-line no-control-regex
  if (Array.from(name).length > DEVICE_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new RemoteError(400, 'name', `name: 1 to ${String(DEVICE_NAME_MAX)} characters, no control characters`);
  return name;
}

/** A limit of `max` per minute, for everyone together. */
export function createLimiter(max: number, now: () => number): () => boolean {
  const times: number[] = [];
  return () => {
    const at = now();
    while (times.length > 0 && (times[0] ?? 0) <= at - 60_000) times.shift();
    if (times.length >= max) return false;
    times.push(at);
    return true;
  };
}

type Pending =
  | { purpose: 'register'; expires: number; deviceId: string; name: string }
  | { purpose: 'login'; expires: number }
  | { purpose: 'decision'; expires: number; session: RemoteSession; digest: Buffer };

export interface RemoteDevicesOptions {
  store: DeviceStore;
  /** The host of [server.remote]: the rpId; the origin is https://<host>. */
  host: string;
  now?: () => number;
  /** For the tests: the code; otherwise crypto.randomInt. */
  code?: () => string;
}

export interface CreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  attestation: 'none';
  authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' };
  excludeCredentials: never[];
}

export interface RequestOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required';
  allowCredentials: { type: 'public-key'; id: string }[];
}

export interface RemoteDevices {
  readonly host: string;
  /** Mac only: a new code, replacing the one before; the name the device will have. */
  newCode(name: unknown): { code: string; expiresAt: string };
  /** Mac only: whether a code is waiting, and until when (never the code). */
  codeState(): { expiresAt: string } | null;
  /** Phone: the code typed; the options of the passkey to create. */
  pair(code: unknown): Promise<CreationOptions>;
  /** Phone: the passkey created; a session token for the cookie. */
  register(credential: unknown): Promise<{ token: string; deviceId: string }>;
  loginOptions(): RequestOptions;
  login(assertion: unknown): Promise<{ token: string; deviceId: string }>;
  /** The session of a Cookie header, or undefined. */
  session(cookieHeader: string | undefined): Promise<RemoteSession | undefined>;
  logout(cookieHeader: string | undefined): Promise<void>;
  /** Whether a session is still alive, without counting as a use: the live feed checks it while open. */
  alive(session: RemoteSession): Promise<boolean>;
  /** Called with the id of each device unlinked: its open sockets close at once. */
  onUnlink(listener: (deviceId: string) => void): void;
  /** The options of the passkey check bound to a decision. */
  decisionOptions(session: RemoteSession, binding: DecisionBinding): Promise<RequestOptions>;
  /** Throws a RemoteError unless `assertion` is a check of this device, for exactly this decision, not older than 5 minutes. */
  verifyDecision(session: RemoteSession, binding: DecisionBinding, assertion: unknown): Promise<void>;
  list(): Promise<DeviceSummary[]>;
  unlink(deviceId: string): Promise<void>;
}

function refused(code: string): RemoteError {
  return new RemoteError(401, code, 'passkey refused');
}

/** The challenge a credential answers to, read from its clientDataJSON before anything else is checked. */
function challengeOf(body: unknown): string {
  const response = typeof body === 'object' && body !== null ? (body as { response?: unknown }).response : undefined;
  const raw = typeof response === 'object' && response !== null ? (response as { clientDataJSON?: unknown }).clientDataJSON : undefined;
  try {
    const data = JSON.parse(fromBase64url(raw, 'client-data').toString('utf8')) as { challenge?: unknown };
    if (typeof data.challenge === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.challenge)) return data.challenge;
  } catch {
    // Refused below.
  }
  throw refused('client-data');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createRemoteDevices(options: RemoteDevicesOptions): RemoteDevices {
  const { store, host } = options;
  const now = options.now ?? Date.now;
  const origin = `https://${host}`;
  const makeCode = options.code ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
  let code: { value: Buffer; name: string; expires: number; wrong: number } | undefined;
  const pending = new Map<string, Pending>();
  const pairLimit = createLimiter(PAIR_PER_MINUTE, now);
  const unlinkListeners: ((deviceId: string) => void)[] = [];
  const loginLimit = createLimiter(LOGIN_PER_MINUTE, now);

  function issue(entry: Pending, bytes: Buffer = randomBytes(32)): string {
    const at = now();
    for (const [key, value] of pending) if (value.expires <= at) pending.delete(key);
    while (pending.size >= MAX_CHALLENGES) pending.delete(pending.keys().next().value as string);
    const challenge = base64url(bytes);
    pending.set(challenge, entry);
    return challenge;
  }

  /** The pending entry of a challenge, taken away: single use, whatever comes next. */
  function take(challenge: string): Pending | undefined {
    const entry = pending.get(challenge);
    pending.delete(challenge);
    if (entry === undefined || entry.expires <= now()) return undefined;
    return entry;
  }

  function newSession(): { token: string; session: NewSession } {
    const token = base64url(randomBytes(32));
    const createdAt = new Date(now());
    return { token, session: { tokenHash: sessionHash(token), createdAt, expiresAt: new Date(createdAt.getTime() + SESSION_MAX_MS) } };
  }

  async function record(event: RemoteEvent): Promise<void> {
    await store.event(event);
  }

  /** An assertion of a stored credential against `challenge`; the counter is moved forward atomically. */
  async function assert(assertion: unknown, challenge: Buffer, deviceId?: string): Promise<StoredDeviceCredential> {
    let id: Buffer;
    try {
      const credential = assertion as { rawId?: unknown };
      id = fromBase64url(credential.rawId, 'credential-id', 1400);
    } catch {
      throw refused('credential');
    }
    const stored = await store.credential(id);
    if (stored === undefined || (deviceId !== undefined && stored.deviceId !== deviceId)) throw refused('unknown-credential');
    let signCount: number;
    try {
      ({ signCount } = verifyAssertion(assertion, { challenge, origin, rpId: host }, { ...stored, userHandle: uuidBytes(stored.deviceId) }));
    } catch (error) {
      if (error instanceof WebAuthnError) throw Object.assign(refused(error.code), { device: stored.deviceId });
      throw error;
    }
    if (!(await store.useCredential(stored.credentialId, stored.signCount, signCount, new Date(now())))) throw Object.assign(refused('counter'), { device: stored.deviceId });
    return stored;
  }

  return {
    host,

    newCode(name) {
      const value = makeCode();
      if (!/^\d{6}$/.test(value)) throw new Error('a pairing code is 6 digits');
      const expires = now() + CODE_TTL_MS;
      code = { value: Buffer.from(value), name: deviceName(name), expires, wrong: 0 };
      return { code: value, expiresAt: new Date(expires).toISOString() };
    },

    codeState() {
      if (code === undefined || code.expires <= now()) return null;
      return { expiresAt: new Date(code.expires).toISOString() };
    },

    async pair(typed) {
      if (!pairLimit()) throw new RemoteError(429, 'too-many', 'too many attempts: wait a minute');
      const current = code;
      if (current === undefined || current.expires <= now()) {
        code = undefined;
        await record({ kind: 'remote.paired', payload: { outcome: 'refused', reason: 'no-code' } });
        throw new RemoteError(401, 'code', 'no valid code: make a new one on the Mac');
      }
      const given = Buffer.from(typeof typed === 'string' ? typed.trim() : '');
      if (given.length !== current.value.length || !timingSafeEqual(given, current.value)) {
        current.wrong += 1;
        // Five wrong codes burn it: a new one is made on the Mac.
        if (current.wrong >= CODE_MAX_WRONG) code = undefined;
        await record({ kind: 'remote.paired', payload: { outcome: 'refused', reason: 'wrong-code' } });
        throw new RemoteError(401, 'code', 'wrong code');
      }
      // One use: the code is gone the moment it is right.
      code = undefined;
      const deviceId = randomUUID();
      const challenge = issue({ purpose: 'register', expires: now() + REGISTER_TTL_MS, deviceId, name: current.name });
      return {
        challenge,
        rp: { id: host, name: 'Arianna' },
        // The user of the passkey is the device: its id, and a neutral name (the name the user gave stays on the Mac).
        user: { id: base64url(uuidBytes(deviceId)), name: 'arianna', displayName: 'Arianna' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: REGISTER_TTL_MS,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: [],
      };
    },

    async register(body) {
      if (!pairLimit()) throw new RemoteError(429, 'too-many', 'too many attempts: wait a minute');
      const challenge = challengeOf(body);
      const entry = take(challenge);
      if (entry?.purpose !== 'register') {
        await record({ kind: 'remote.paired', payload: { outcome: 'refused', reason: 'challenge' } });
        throw refused('challenge');
      }
      let credential: NewCredential;
      try {
        credential = verifyRegistration(body, { challenge: Buffer.from(challenge, 'base64url'), origin, rpId: host });
      } catch (error) {
        if (!(error instanceof WebAuthnError)) throw error;
        await record({ kind: 'remote.paired', payload: { outcome: 'refused', reason: error.code } });
        throw refused(error.code);
      }
      const { token, session } = newSession();
      await store.pair({ id: entry.deviceId, name: entry.name }, credential, session);
      await record({ kind: 'remote.paired', payload: { device: entry.deviceId, outcome: 'ok' } });
      return { token, deviceId: entry.deviceId };
    },

    loginOptions() {
      if (!loginLimit()) throw new RemoteError(429, 'too-many', 'too many attempts: wait a minute');
      // No allowCredentials: the passkey is discoverable, the phone offers it with Face ID.
      const challenge = issue({ purpose: 'login', expires: now() + LOGIN_TTL_MS });
      return { challenge, rpId: host, timeout: LOGIN_TTL_MS, userVerification: 'required', allowCredentials: [] };
    },

    async login(body) {
      if (!loginLimit()) throw new RemoteError(429, 'too-many', 'too many attempts: wait a minute');
      const challenge = challengeOf(body);
      const entry = take(challenge);
      if (entry?.purpose !== 'login') {
        await record({ kind: 'remote.login', payload: { outcome: 'refused', reason: 'challenge' } });
        throw refused('challenge');
      }
      let stored: StoredDeviceCredential;
      try {
        stored = await assert(body, Buffer.from(challenge, 'base64url'));
      } catch (error) {
        if (error instanceof RemoteError) {
          const device = (error as RemoteError & { device?: string }).device;
          await record({ kind: 'remote.login', payload: { ...(device === undefined ? {} : { device }), outcome: 'refused', reason: error.code } });
        }
        throw error;
      }
      const { token, session } = newSession();
      await store.createSession(stored.deviceId, session);
      await record({ kind: 'remote.login', payload: { device: stored.deviceId, outcome: 'ok' } });
      return { token, deviceId: stored.deviceId };
    },

    async session(cookieHeader) {
      const token = sessionToken(cookieHeader);
      if (token === undefined) return undefined;
      const at = new Date(now());
      const found = await store.session(sessionHash(token), at, SESSION_IDLE_MS);
      if (found === undefined) return undefined;
      if (at.getTime() - found.lastSeenAt.getTime() >= SESSION_TOUCH_MS) await store.touchSession(found.id, found.deviceId, at);
      return { id: found.id, deviceId: found.deviceId };
    },

    async logout(cookieHeader) {
      const token = sessionToken(cookieHeader);
      if (token !== undefined) await store.endSession(sessionHash(token), new Date(now()));
    },

    alive: (session) => store.sessionAlive(session.id, new Date(now()), SESSION_IDLE_MS),

    onUnlink(listener) {
      unlinkListeners.push(listener);
    },

    async decisionOptions(session, binding) {
      const nonce = randomBytes(16);
      const digest = decisionDigest(binding);
      const challenge = issue({ purpose: 'decision', expires: now() + DECISION_TTL_MS, session, digest }, Buffer.concat([nonce, digest]));
      const ids = await store.credentials(session.deviceId);
      return { challenge, rpId: host, timeout: LOGIN_TTL_MS, userVerification: 'required', allowCredentials: ids.map((id) => ({ type: 'public-key', id: base64url(id) })) };
    },

    async verifyDecision(session, binding, assertion) {
      if (assertion === undefined || assertion === null) {
        await record({ kind: 'remote.decision', payload: { device: session.deviceId, outcome: 'refused', reason: 'missing' } });
        throw new RemoteError(403, 'verification-required', 'a decision from the phone needs the passkey');
      }
      let challenge: string;
      try {
        challenge = challengeOf(assertion);
      } catch {
        await record({ kind: 'remote.decision', payload: { device: session.deviceId, outcome: 'refused', reason: 'client-data' } });
        throw new RemoteError(403, 'verification-required', 'the passkey check is not readable');
      }
      const entry = take(challenge);
      const bytes = Buffer.from(challenge, 'base64url');
      const digest = decisionDigest(binding);
      // The check must be of this session and of exactly this decision: the digest is in the challenge itself.
      if (
        entry?.purpose !== 'decision' ||
        entry.session.id !== session.id ||
        entry.session.deviceId !== session.deviceId ||
        !timingSafeEqual(entry.digest, digest) ||
        bytes.length !== 48 ||
        !timingSafeEqual(bytes.subarray(16), digest)
      ) {
        await record({ kind: 'remote.decision', payload: { device: session.deviceId, outcome: 'refused', reason: 'challenge' } });
        throw new RemoteError(403, 'verification-required', 'the passkey check is missing, expired or for another decision');
      }
      try {
        await assert(assertion, bytes, session.deviceId);
      } catch (error) {
        if (error instanceof RemoteError) {
          await record({ kind: 'remote.decision', payload: { device: session.deviceId, outcome: 'refused', reason: error.code } });
          throw new RemoteError(403, 'verification-required', 'the passkey check failed');
        }
        throw error;
      }
      await record({ kind: 'remote.decision', payload: { device: session.deviceId, outcome: 'ok' } });
    },

    list: () => store.list(),

    async unlink(deviceId) {
      if (!UUID.test(deviceId)) throw new RemoteError(404, 'not-found', 'no such device');
      if (!(await store.unlink(deviceId, new Date(now())))) throw new RemoteError(404, 'not-found', 'no such device');
      // A decision check waiting for this device goes too.
      for (const [key, entry] of pending) if (entry.purpose === 'decision' && entry.session.deviceId === deviceId) pending.delete(key);
      for (const listener of unlinkListeners) {
        try {
          listener(deviceId);
        } catch {
          // The device is unlinked in the database: a broken listener does not undo it.
        }
      }
      await record({ kind: 'remote.unlinked', payload: { device: deviceId, outcome: 'ok' } });
    },
  };
}

/** The 16 bytes of a uuid: the user.id of the passkey of a device. */
export function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replaceAll('-', ''), 'hex');
}
