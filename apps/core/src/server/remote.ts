/**
 * The remote port (D-292): the second listener of the core, which
 * `tailscale serve` publishes on the tailnet as https://<name>. A request is
 * remote because it arrived on this port, never because of a header.
 *
 * `remoteAccess` is the only place that lets a remote request reach the API
 * or the live feed. Without a session it answers only the state of the
 * session and the steps of pairing and sign-in (`/api/remote/*`, which exist
 * on this port only); with the session cookie of a paired device it lets
 * the request go on, except for what belongs to the Mac alone. The files of
 * the web chat do not come here: they hold nothing private.
 */
import type { IncomingMessage } from 'node:http';

import { CLEAR_COOKIE, RemoteError, sessionCookie, type Intent, type RemoteDevices, type RemoteSession } from '../remote/devices.ts';

/** The address of the remote port: always this one, whatever the configuration says. */
export const REMOTE_LISTEN_HOST = '127.0.0.1';

/** The route that tells the page on the phone whether this browser has a session. */
export const REMOTE_STATUS_PATH = '/api/remote/status';

export const DEVICE_NOT_PAIRED = 'device-not-paired';
export const LOCAL_ONLY = 'local-only';

/**
 * What only the Mac does, session or not (D-292, choice of the user after
 * stage B): devices and pairing codes; the privacy settings (the exits to
 * the cloud); the agent's browser with its screen; what acts on the Mac
 * itself (the notifications helper, «Apri» and «Mostra» of a project).
 */
const LOCAL_ONLY_PATHS: readonly RegExp[] = [
  /^\/api\/devices(\/|$)/,
  // The folders of the Mac Arianna may read (D-314): paths of the user, changed only from the Mac.
  /^\/api\/mac\/folders(\/|$)/,
  /^\/api\/settings\/privacy\//,
  /^\/api\/notifications\/(stream|this-mac)$/,
  /^\/api\/browser(\/|$)/,
  /^\/api\/browse\/[^/]+\/(open|reveal)$/,
  // The exact text that left (D-297): read on the Mac only; the list of the log stays readable.
  /^\/api\/gateway\/log\/[^/]+\/text$/,
  // What each exit was about (D-297): paths, searches, sites, also of blocked exits.
  /^\/api\/gateway\/log\/request\/[^/]+\/subjects$/,
];

/**
 * The decisions that from the phone need Face ID for each of them (D-292,
 * step-up): the closed name of the action, by method and path. The intent
 * checked is the method, the path (the object) and the JSON body (what
 * changes the outcome), one generic check before the route runs.
 */
const STEP_UP: readonly { action: string; pattern: RegExp }[] = [
  { action: 'approval.decide', pattern: /^\/api\/approvals\/[^/]+\/decision$/ },
  { action: 'skill.share', pattern: /^\/api\/skills-catalog\/claude\/share$/ },
  { action: 'fact.share', pattern: /^\/api\/profile\/facts\/share\/confirm$/ },
  { action: 'god.approve', pattern: /^\/api\/god\/plans$/ },
  { action: 'god.land', pattern: /^\/api\/god\/(plans|subtasks)\/[^/]+\/land\/[^/]+$/ },
  { action: 'god.subtask', pattern: /^\/api\/god\/subtasks\/[^/]+\/(stop|resume|discard|branch)$/ },
  { action: 'routine.decide', pattern: /^\/api\/routines\/[^/]+\/(approve|discard)$/ },
  { action: 'archive.decide', pattern: /^\/api\/archive\/(approve|discard)$/ },
  { action: 'wiki.decide', pattern: /^\/api\/wiki\/proposals\/[^/]+\/(approve|discard)$/ },
  { action: 'wiki.move', pattern: /^\/api\/wiki\/(move|move-now)$/ },
  { action: 'wiki.restore', pattern: /^\/api\/wiki\/restore$/ },
  { action: 'wiki.delete', pattern: /^\/api\/wiki\/(delete|folder\/delete)$/ },
  { action: 'note.release', pattern: /^\/api\/browse\/[^/]+\/knowledge\/release$/ },
  { action: 'agent.promote', pattern: /^\/api\/agents\/[^/]+\/promote$/ },
];

/** The header that carries the passkey check of an action from the phone: base64url of the JSON of the assertion. */
export const VERIFICATION_HEADER = 'x-arianna-verification';

/** The closed name of an action that needs Face ID from the phone, or undefined. */
export function stepUpAction(method: string, pathname: string): string | undefined {
  if (method !== 'POST') return undefined;
  return STEP_UP.find((rule) => rule.pattern.test(pathname))?.action;
}

/** The assertion of the header, or undefined when missing or not JSON. */
export function verificationOf(header: string | string[] | undefined): unknown {
  if (typeof header !== 'string' || header.length === 0 || header.length > 12_000 || !/^[A-Za-z0-9_-]+$/.test(header)) return undefined;
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export type RemoteAccess =
  /** Answered by the remote door itself: the state of the session, the steps of pairing and sign-in. */
  | { kind: 'answer'; status: number; body: unknown; cookie?: string }
  /** The request goes on to the API routes, with the session of its device. */
  | { kind: 'allowed'; session: RemoteSession }
  | { kind: 'refused'; status: 401 | 403 | 404; body: { error: string; code: string } };

const NOT_PAIRED: RemoteAccess = { kind: 'refused', status: 401, body: { error: 'device not paired', code: DEVICE_NOT_PAIRED } };
const NOT_HERE: RemoteAccess = { kind: 'refused', status: 403, body: { error: 'only from the Mac', code: LOCAL_ONLY } };

/** The session of a remote request let through, for the routes that ask (decisions, push). Set by `remoteAccess`'s caller, never by a header. */
const sessions = new WeakMap<IncomingMessage, RemoteSession>();

export function markRemote(request: IncomingMessage, session: RemoteSession): void {
  sessions.set(request, session);
}

/** The session of a request that came through the remote port; undefined on the port of the Mac. */
export function remoteSessionOf(request: IncomingMessage): RemoteSession | undefined {
  return sessions.get(request);
}

export function localOnly(pathname: string): boolean {
  return LOCAL_ONLY_PATHS.some((pattern) => pattern.test(pathname));
}

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new RemoteError(400, 'body', `unknown field ${key}`);
}

/** The action a passkey check is asked for: the same method, path and body the request itself will carry. */
export function intentOf(body: Record<string, unknown>): Intent {
  const { method, path, body: inner } = body;
  if (method !== undefined && method !== 'POST') throw new RemoteError(400, 'body', 'method must be POST');
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > 512) throw new RemoteError(400, 'body', 'path is required');
  if (stepUpAction('POST', path) === undefined) throw new RemoteError(400, 'body', 'this path does not need a passkey check');
  return { method: 'POST', path, body: inner ?? {} };
}

/**
 * Whether a request of the remote port, past the checks of Host and Origin,
 * may reach the API or the live feed (`upgrade`). `readBody` reads the JSON
 * body of the steps answered here.
 */
export async function remoteAccess(
  request: Pick<IncomingMessage, 'method' | 'headers'>,
  pathname: string,
  devices: RemoteDevices | undefined,
  readBody: () => Promise<Record<string, unknown>>,
  upgrade = false,
): Promise<RemoteAccess> {
  const session = devices === undefined ? undefined : await devices.session(request.headers.cookie);
  if (upgrade) {
    // Only the live feed of the chat; the screen of the agent's browser stays on the Mac.
    if (pathname !== '/api/ws') return session === undefined ? NOT_PAIRED : NOT_HERE;
    return session === undefined ? NOT_PAIRED : { kind: 'allowed', session };
  }
  const method = request.method ?? 'GET';
  if (pathname === REMOTE_STATUS_PATH && (method === 'GET' || method === 'HEAD')) {
    return { kind: 'answer', status: 200, body: { session: session !== undefined } };
  }
  if (pathname.startsWith('/api/remote/')) {
    if (devices === undefined) return NOT_PAIRED;
    if (method !== 'POST') return { kind: 'refused', status: 404, body: { error: 'not found', code: 'not-found' } };
    try {
      return await step(pathname, devices, session, readBody, request.headers.cookie);
    } catch (error) {
      if (error instanceof RemoteError) return { kind: 'answer', status: error.status, body: { error: error.message, code: error.code } };
      throw error;
    }
  }
  if (localOnly(pathname)) return session === undefined ? NOT_PAIRED : NOT_HERE;
  return session === undefined ? NOT_PAIRED : { kind: 'allowed', session };
}

async function step(
  pathname: string,
  devices: RemoteDevices,
  session: RemoteSession | undefined,
  readBody: () => Promise<Record<string, unknown>>,
  cookieHeader: string | undefined,
): Promise<RemoteAccess> {
  const body = await readBody();
  switch (pathname) {
    case '/api/remote/pair':
      only(body, ['code']);
      return { kind: 'answer', status: 200, body: { options: await devices.pair(body.code) } };
    case '/api/remote/register': {
      only(body, ['credential']);
      const { token } = await devices.register(body.credential);
      return { kind: 'answer', status: 201, body: { session: true }, cookie: sessionCookie(token) };
    }
    case '/api/remote/login/options':
      only(body, []);
      return { kind: 'answer', status: 200, body: { options: devices.loginOptions() } };
    case '/api/remote/login': {
      only(body, ['credential']);
      const { token } = await devices.login(body.credential);
      return { kind: 'answer', status: 200, body: { session: true }, cookie: sessionCookie(token) };
    }
    case '/api/remote/logout':
      only(body, []);
      await devices.logout(cookieHeader);
      return { kind: 'answer', status: 200, body: { session: false }, cookie: CLEAR_COOKIE };
    case '/api/remote/verify':
      if (session === undefined) return NOT_PAIRED;
      only(body, ['method', 'path', 'body']);
      return { kind: 'answer', status: 200, body: { options: await devices.intentOptions(session, intentOf(body)) } };
    default:
      return { kind: 'refused', status: 404, body: { error: 'not found', code: 'not-found' } };
  }
}
