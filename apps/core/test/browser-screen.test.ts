// The screen of the browser in the chat (D-264, passo 4): tokens, the route,
// the WebSocket and the bridge to a fake channel instead of Xvnc.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';

import { WebSocket } from 'ws';

import type { OpenChannel } from '../src/browser/channel.ts';
import { VNC_SOCKET } from '../src/browser/container.ts';
import { RFB_VERSION } from '../src/browser/rfb-filter.ts';
import { BrowserScreens, MAX_SCREENS, SCREEN_CLOSE, type ConversationKind, type ScreenSocket, type ScreensOptions } from '../src/browser/screen.ts';
import type { Sql } from '../src/db/client.ts';
import type { NewEvent } from '../src/events.ts';
import type { LiveFeed } from '../src/live.ts';
import { SCREEN_MAX_PAYLOAD, startApiServer } from '../src/server/http.ts';

const WORK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '33333333-3333-4333-8333-333333333333';
const INCOGNITO = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';
/** The Private chat of an access (D-281), which the browser of WORK passed to. */
const CHAT = '66666666-6666-4666-8666-666666666666';
const KINDS: Record<string, ConversationKind> = { [WORK]: 'work', [OTHER]: 'work', [PRIVATE]: 'private', [INCOGNITO]: 'incognito', [CHAT]: 'browser' };

const HANDSHAKE = Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 1])]);
const UPDATE_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const KEY_EVENT = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);

interface FakeChannel {
  container: string;
  socket: string;
  /** What reached "Xvnc". */
  written: Buffer[];
  /** What "Xvnc" sends to the page. */
  fromVnc: PassThrough;
  closed: boolean;
}

interface Harness {
  screens: BrowserScreens;
  /** The browser: who holds it and its container; null when closed. */
  state: { holder: string | null; container: string | null };
  channels: FakeChannel[];
  events: NewEvent[];
  /** Conversations whose browser «Chiudi» closed. */
  closes: string[];
  /** Who drives (the fake AgentBrowser of passo 5), and what was asked of it. */
  driver: { value: 'agent' | 'user'; gives: number; inputs: number; gestures: number; wait?: Promise<void>; login?: boolean; loginAsked?: number };
  controls: { conversationId: string; state: string; reason?: string }[];
  /** Commands of the bar of the screen (D-286) the fake AgentBrowser got. */
  commands: unknown[];
}

function harness(options: { failOpen?: boolean; stuck?: boolean; limits?: ScreensOptions['limits']; pingMs?: number; idleMs?: number; checkMs?: number } = {}): Harness {
  const state: Harness['state'] = { holder: WORK, container: 'arianna-browser-chat-aaaaaaaaaaaa' };
  const driver: Harness['driver'] = { value: 'agent', gives: 0, inputs: 0, gestures: 0 };
  const controls: Harness['controls'] = [];
  const channels: FakeChannel[] = [];
  const events: NewEvent[] = [];
  const closes: string[] = [];
  const commands: unknown[] = [];
  const openChannel: OpenChannel = (container, socket) => {
    if (options.failOpen === true) throw new Error('docker');
    const fromVnc = new PassThrough();
    const toVnc = new PassThrough();
    const channel: FakeChannel = { container, socket, written: [], fromVnc, closed: false };
    toVnc.on('data', (chunk: Buffer) => { channel.written.push(chunk); });
    channels.push(channel);
    // stuck: "Xvnc" takes nothing, so what the page sends stays queued.
    const stream = options.stuck === true ? new Duplex({ read: () => undefined, write: () => undefined }) : Duplex.from({ readable: fromVnc, writable: toVnc });
    return { stream, close: () => { channel.closed = true; stream.destroy(); } };
  };
  const screens = new BrowserScreens({
    holder: () => state.holder,
    container: () => state.container,
    conversation: (id) => Promise.resolve(KINDS[id] ?? null),
    closeBrowser: (id) => {
      if (state.holder !== id) return Promise.resolve(false);
      state.holder = null;
      state.container = null;
      closes.push(id);
      return Promise.resolve(true);
    },
    site: (id) => (id === state.holder ? 'comune-finto.it' : null),
    url: (id) => (id === state.holder ? 'https://comune-finto.it/servizi?q=orari' : null),
    command: (_id, command) => {
      commands.push(command);
      return Promise.resolve(command.kind === 'forward' ? { ok: false, reason: 'no-page' } : { ok: true, url: 'https://comune-finto.it/servizi', site: 'comune-finto.it' });
    },
    movedTo: (id) => (id === WORK && state.holder === CHAT ? CHAT : null),
    openChannel,
    onEvent: (event) => { events.push(event); },
    control: {
      take: (id) => {
        const waiting = driver.wait !== undefined;
        const done = (driver.wait ?? Promise.resolve()).then(() => {
          if (state.holder !== id) return false;
          driver.value = 'user';
          return true;
        });
        return { waiting, done };
      },
      give: (id) => {
        if (state.holder !== id || driver.value !== 'user') return false;
        driver.value = 'agent';
        driver.gives += 1;
        return true;
      },
      input: () => { driver.inputs += 1; },
      gesture: () => { driver.gestures += 1; },
      driver: (id) => (state.holder === id ? driver.value : null),
      blocked: (id) => (state.holder === id && driver.value === 'user' ? { seq: 3, outcome: 'form' } : null),
      loginForm: (id) => {
        driver.loginAsked = (driver.loginAsked ?? 0) + 1;
        return Promise.resolve(state.holder === id && driver.login === true);
      },
    },
    onControl: (conversationId, change) => { controls.push({ conversationId, ...change }); },
    ...(options.idleMs === undefined ? {} : { controlIdleMs: options.idleMs }),
    ...(options.checkMs === undefined ? {} : { controlCheckMs: options.checkMs }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.pingMs === undefined ? {} : { pingMs: options.pingMs }),
  });
  return { screens, state, channels, events, closes, driver, controls, commands };
}

async function token(h: Harness, conversationId = WORK): Promise<string> {
  const issued = await h.screens.issue(conversationId);
  assert.ok(issued.ok, JSON.stringify(issued));
  return issued.token;
}

test('the Private chat of an access (D-281): token, status and control follow the browser; the work conversation shows where it went', async () => {
  const h = harness();
  h.state.holder = CHAT;
  const issued = await h.screens.issue(CHAT);
  assert.ok(issued.ok);
  assert.deepEqual(await h.screens.issue(WORK), { ok: false, reason: 'no-browser' });
  assert.deepEqual(await h.screens.status(CHAT), { open: true, site: 'comune-finto.it', control: 'agent', chat: true });
  assert.deepEqual(await h.screens.status(WORK), { open: false, movedTo: CHAT });
  assert.deepEqual(await h.screens.status(OTHER), { open: false });
  // A Private chat that is not of an access never gets one.
  h.state.holder = PRIVATE;
  assert.deepEqual(await h.screens.issue(PRIVATE), { ok: false, reason: 'private' });
  assert.deepEqual(await h.screens.status(PRIVATE), { open: false });
});

test('a token only for the conversation holding the browser, never for a Private or incognito one', async () => {
  const h = harness();
  const issued = await h.screens.issue(WORK);
  assert.ok(issued.ok);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(issued.token, 'base64url').length, 32);
  assert.ok(h.screens.valid(issued.token));
  assert.deepEqual(await h.screens.issue(OTHER), { ok: false, reason: 'no-browser' });
  assert.deepEqual(await h.screens.issue(MISSING), { ok: false, reason: 'not-found' });
  // Even when it held the browser (it cannot: the tools are off there), no token.
  h.state.holder = PRIVATE;
  assert.deepEqual(await h.screens.issue(PRIVATE), { ok: false, reason: 'private' });
  h.state.holder = INCOGNITO;
  assert.deepEqual(await h.screens.issue(INCOGNITO), { ok: false, reason: 'incognito' });
  h.state.holder = null;
  assert.deepEqual(await h.screens.issue(WORK), { ok: false, reason: 'no-browser' });
});

test('a token dies with its browser: closed, passed to another chat, or a new container of the same chat', async () => {
  const h = harness();
  const first = await token(h);
  assert.ok(h.screens.valid(first));
  // Another conversation takes the browser (a new container) and gets its own token.
  h.state.holder = OTHER;
  h.state.container = 'arianna-browser-chat-bbbbbbbbbbbb';
  assert.equal(h.screens.valid(first), false);
  const second = await token(h, OTHER);
  assert.ok(h.screens.valid(second));
  // The first chat opens a browser again: its old token does not come back to life.
  h.state.holder = WORK;
  h.state.container = 'arianna-browser-chat-cccccccccccc';
  assert.equal(h.screens.valid(first), false);
  assert.equal(h.screens.valid(second), false);
  // Closed.
  const third = await token(h);
  h.state.holder = null;
  h.state.container = null;
  assert.equal(h.screens.valid(third), false);
  // Wrong shapes and random tokens never hold.
  for (const wrong of ['', 'x', randomBytes(32).toString('base64url'), `${third}=`, third.slice(1)]) assert.equal(h.screens.valid(wrong), false);
});

test('after the shutdown no token holds and none is issued', async () => {
  const h = harness();
  const kept = await token(h);
  h.screens.close();
  assert.equal(h.screens.valid(kept), false);
  assert.deepEqual(await h.screens.issue(WORK), { ok: false, reason: 'no-browser' });
});

// --- the route and the WebSocket ---

async function serve(t: TestContext, screens?: BrowserScreens): Promise<number> {
  const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, ...(screens === undefined ? {} : { browserScreens: screens }) });
  t.after(async () => {
    screens?.close();
    await server.close();
  });
  return server.port;
}

function post(port: number, body: unknown, headers: Record<string, string> = {}, path = '/api/browser/screen'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${String(port)}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }); });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

function get(port: number, query: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: `/api/browser/screen${query}`, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(port: number, query: string, options: { origin?: string | null; path?: string } = {}): WebSocket {
  const origin = options.origin === undefined ? `http://127.0.0.1:${String(port)}` : options.origin;
  return new WebSocket(`ws://127.0.0.1:${String(port)}${options.path ?? '/api/browser/screen'}${query}`, origin === null ? {} : { origin });
}

/** The HTTP status of a refused handshake. */
async function refusedWith(ws: WebSocket): Promise<number> {
  ws.on('error', () => undefined);
  const [request, response] = (await once(ws, 'unexpected-response')) as [{ destroy(): void }, { statusCode?: number }];
  // With a listener of unexpected-response, ending the request is the caller's.
  request.destroy();
  return response.statusCode ?? 0;
}

async function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  const [code, reason] = (await once(ws, 'close')) as [number, Buffer];
  return { code, reason: reason.toString('utf8') };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('POST /api/browser/screen: 200 with a token, 409 without a browser, 403 Private or incognito, 400 and 404', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const ok = await post(port, { conversationId: WORK });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.token, 'string');
  assert.ok(h.screens.valid(ok.body.token as string));
  assert.deepEqual(await post(port, { conversationId: OTHER }), { status: 409, body: { error: 'no-browser' } });
  assert.deepEqual(await post(port, { conversationId: PRIVATE }), { status: 403, body: { error: 'private' } });
  assert.deepEqual(await post(port, { conversationId: INCOGNITO }), { status: 403, body: { error: 'incognito' } });
  assert.equal((await post(port, { conversationId: MISSING })).status, 404);
  assert.equal((await post(port, { conversationId: 'not-an-id' })).status, 400);
  assert.equal((await post(port, { conversationId: WORK, more: 1 })).status, 400);
  // The checks of every POST: another site, another Host, a body that is not JSON.
  assert.equal((await post(port, { conversationId: WORK }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(port, { conversationId: WORK }, { host: 'evil.example' })).status, 403);
  assert.equal((await post(port, { conversationId: WORK }, { 'content-type': 'text/plain' })).status, 415);
});

test('without the screens the route and the WebSocket answer 404', async (t) => {
  const port = await serve(t);
  assert.equal((await post(port, { conversationId: WORK })).status, 404);
  assert.equal(await refusedWith(connect(port, `?t=${randomBytes(32).toString('base64url')}`)), 404);
});

test('the WebSocket: Origin required and same-origin, a valid token, and no other path', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const good = await token(h);
  assert.equal(await refusedWith(connect(port, '')), 403);
  assert.equal(await refusedWith(connect(port, '?t=')), 403);
  assert.equal(await refusedWith(connect(port, `?t=${randomBytes(32).toString('base64url')}`)), 403);
  assert.equal(await refusedWith(connect(port, `?t=${good}`, { origin: null })), 403);
  assert.equal(await refusedWith(connect(port, `?t=${good}`, { origin: 'http://evil.example' })), 403);
  assert.equal(await refusedWith(connect(port, `?t=${good}`, { path: '/api/browser/screens' })), 404);
  assert.equal(await refusedWith(connect(port, `?t=${good}`, { path: '/api/browser/screen/x' })), 404);
  // A token of a browser passed to another chat.
  h.state.holder = OTHER;
  assert.equal(await refusedWith(connect(port, `?t=${good}`)), 403);
  assert.equal(h.channels.length, 0);
});

test('the bridge: Xvnc to the page as it is, the page to Xvnc through the filter; events without content', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const ws = connect(port, `?t=${await token(h)}`);
  await once(ws, 'open');
  await until(() => h.channels.length === 1, 'the channel');
  const channel = h.channels[0];
  assert.ok(channel);
  assert.equal(channel.socket, VNC_SOCKET);
  assert.equal(channel.container, 'arianna-browser-chat-aaaaaaaaaaaa');
  const received: Buffer[] = [];
  ws.on('message', (data: Buffer) => { received.push(data); });
  channel.fromVnc.write(Buffer.from(RFB_VERSION, 'latin1'));
  await until(() => Buffer.concat(received).toString('latin1') === RFB_VERSION, 'the bytes of Xvnc');
  // Split across frames, a key in between: only the handshake and the request reach Xvnc.
  ws.send(HANDSHAKE.subarray(0, 5));
  ws.send(Buffer.concat([HANDSHAKE.subarray(5), KEY_EVENT, UPDATE_REQUEST.subarray(0, 4)]));
  ws.send(UPDATE_REQUEST.subarray(4));
  await until(() => Buffer.concat(channel.written).length === HANDSHAKE.length + UPDATE_REQUEST.length, 'the bytes to Xvnc');
  assert.deepEqual(Buffer.concat(channel.written), Buffer.concat([HANDSHAKE, UPDATE_REQUEST]));
  assert.equal(h.screens.open, 1);
  // A refused type closes the screen and its channel.
  ws.send(Buffer.from([251, 0, 0, 0]));
  assert.deepEqual(await closed(ws), SCREEN_CLOSE.refused);
  await until(() => channel.closed, 'the channel closed');
  assert.equal(h.screens.open, 0);
  assert.equal(h.events.length, 2);
  assert.deepEqual(h.events[0], { kind: 'browser.screen', label: 'L0', payload: { state: 'opened', conversationId: WORK } });
  const end = h.events[1];
  assert.equal(end?.kind, 'browser.screen');
  assert.equal(end.label, 'L0');
  const payload = end.payload ?? {};
  assert.equal(payload.state, 'closed');
  assert.equal(payload.conversationId, WORK);
  assert.equal(payload.reason, 'refused-type');
  assert.equal(typeof payload.ms, 'number');
  assert.deepEqual(Object.keys(payload).sort(), ['conversationId', 'ms', 'reason', 'state']);
});

test('a text frame closes the screen', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const ws = connect(port, `?t=${await token(h)}`);
  await once(ws, 'open');
  ws.send('RFB 003.008\n');
  assert.deepEqual(await closed(ws), SCREEN_CLOSE.refused);
});

test('at most three screens per browser, one per token; the fourth is refused, a used token too', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const tokens = [await token(h), await token(h), await token(h), await token(h)];
  const open: WebSocket[] = [];
  for (let index = 0; index < MAX_SCREENS; index += 1) {
    const ws = connect(port, `?t=${tokens[index] ?? ''}`);
    await once(ws, 'open');
    open.push(ws);
  }
  await until(() => h.screens.open === MAX_SCREENS, 'three screens');
  // A token opens one screen only (passo 5): used, it no longer holds.
  assert.equal(h.screens.valid(tokens[0] ?? ''), false);
  assert.equal(await refusedWith(connect(port, `?t=${tokens[0] ?? ''}`)), 403);
  const fourth = connect(port, `?t=${tokens[3] ?? ''}`);
  assert.deepEqual(await closed(fourth), SCREEN_CLOSE.tooMany);
  assert.equal(h.channels.length, MAX_SCREENS);
  // A new token is refused too, so the chat can say «Troppi schermi aperti».
  assert.deepEqual(await h.screens.issue(WORK), { ok: false, reason: 'too-many-screens' });
  const refused = await post(port, { conversationId: WORK });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'too-many-screens' });
  // One closes: the next one opens.
  const first = open.shift();
  first?.close();
  await until(() => h.screens.open === MAX_SCREENS - 1, 'one screen less');
  const again = connect(port, `?t=${await token(h)}`);
  await once(again, 'open');
  await until(() => h.screens.open === MAX_SCREENS, 'three screens again');
});

test('when the browser closes or passes to another chat, its screens close with «browser chiuso»', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const a = connect(port, `?t=${await token(h)}`);
  const b = connect(port, `?t=${await token(h)}`);
  await Promise.all([once(a, 'open'), once(b, 'open')]);
  await until(() => h.screens.open === 2, 'two screens');
  // Still held: revoke closes nothing.
  h.screens.revoke();
  assert.equal(h.screens.open, 2);
  h.state.holder = OTHER;
  const both = Promise.all([closed(a), closed(b)]);
  h.screens.revoke();
  assert.deepEqual(await both, [SCREEN_CLOSE.browserClosed, SCREEN_CLOSE.browserClosed]);
  assert.ok(h.channels.every((channel) => channel.closed));
  assert.deepEqual(h.events.filter((event) => event.payload?.state === 'closed').map((event) => event.payload?.reason), ['browser-closed', 'browser-closed']);
});

test('the channel ending on its own closes the screen: vnc-closed while held, browser-closed once gone', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const held = connect(port, `?t=${await token(h)}`);
  await once(held, 'open');
  await until(() => h.channels.length === 1, 'the channel');
  h.channels[0]?.fromVnc.end();
  assert.deepEqual(await closed(held), SCREEN_CLOSE.vncClosed);
  const gone = connect(port, `?t=${await token(h)}`);
  await once(gone, 'open');
  await until(() => h.channels.length === 2, 'the second channel');
  h.state.holder = null;
  h.state.container = null;
  h.channels[1]?.fromVnc.end();
  assert.deepEqual(await closed(gone), SCREEN_CLOSE.browserClosed);
});

test('a channel that does not open closes the screen; the page closing closes the channel', async (t) => {
  const failing = harness({ failOpen: true });
  const port = await serve(t, failing.screens);
  const ws = connect(port, `?t=${await token(failing)}`);
  assert.deepEqual(await closed(ws), SCREEN_CLOSE.vncClosed);
  assert.equal(failing.screens.open, 0);
  assert.deepEqual(failing.events, []);

  const h = harness();
  const port2 = await serve(t, h.screens);
  const page = connect(port2, `?t=${await token(h)}`);
  await once(page, 'open');
  await until(() => h.channels.length === 1, 'the channel');
  page.close();
  await until(() => h.channels[0]?.closed === true, 'the channel closed');
  assert.equal(h.screens.open, 0);
  assert.equal(h.events.at(-1)?.payload?.reason, 'page-closed');
});

test('the shutdown closes every screen', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const ws = connect(port, `?t=${await token(h)}`);
  await once(ws, 'open');
  await until(() => h.screens.open === 1, 'the screen');
  h.screens.close();
  assert.deepEqual(await closed(ws), SCREEN_CLOSE.stopping);
  assert.ok(h.channels[0]?.closed);
});

/** A WebSocket of the page without a network: what it got, its buffered amount set by the test. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: { data: Buffer; done: () => void }[] = [];
  closes: [number | undefined, string | undefined][] = [];
  pings = 0;
  terminated = false;
  send(data: Buffer, _options: unknown, callback?: () => void): void {
    this.sent.push({ data, done: () => callback?.() });
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.readyState = 3;
    this.emit('close');
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
  ping(): void {
    this.pings += 1;
  }
}

function attachFake(h: Harness, token: string): FakeSocket {
  const socket = new FakeSocket();
  h.screens.attach(token, socket as unknown as ScreenSocket);
  return socket;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a frame longer than the maxPayload of the route closes the screen as overflow (1009 from ws), not as vnc-closed', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const ws = connect(port, `?t=${await token(h)}`);
  ws.on('error', () => undefined);
  await once(ws, 'open');
  await until(() => h.screens.open === 1, 'the screen');
  ws.send(Buffer.concat([HANDSHAKE, Buffer.alloc(SCREEN_MAX_PAYLOAD)]));
  const end = await closed(ws);
  assert.equal(end.code, 1009);
  await until(() => h.screens.open === 0, 'the screen closed');
  assert.ok(h.channels[0]?.closed);
  assert.equal(h.events.at(-1)?.payload?.reason, 'frame-too-long');
  // Nothing of the long frame reached Xvnc.
  assert.equal(Buffer.concat(h.channels.flatMap((channel) => channel.written)).length, 0);
});

test('a page that sends more than Xvnc takes is closed as overflow', async () => {
  const h = harness({ stuck: true, limits: { maxInbound: 100 } });
  const socket = attachFake(h, await token(h));
  socket.emit('message', HANDSHAKE, true);
  assert.equal(h.screens.open, 1);
  // Each request is forwarded and stays queued: past 100 bytes the screen closes.
  const open = (): number => h.screens.open;
  for (let index = 0; index < 20 && open() === 1; index += 1) socket.emit('message', UPDATE_REQUEST, true);
  assert.equal(h.screens.open, 0);
  assert.deepEqual(socket.closes, [[SCREEN_CLOSE.overflow.code, SCREEN_CLOSE.overflow.reason]]);
  assert.equal(h.events.at(-1)?.payload?.reason, 'overflow');
  assert.ok(h.channels[0]?.closed);
});

test('backpressure: the channel pauses above the high water of the page and resumes below the low water', async () => {
  const h = harness({ limits: { highWater: 1000, lowWater: 100 } });
  const socket = attachFake(h, await token(h));
  const fromVnc = h.channels[0]?.fromVnc;
  assert.ok(fromVnc);
  fromVnc.write(Buffer.from('a'));
  await tick();
  assert.equal(socket.sent.length, 1);
  // The page is behind: this chunk is sent, then the channel pauses.
  socket.bufferedAmount = 5000;
  fromVnc.write(Buffer.from('b'));
  await tick();
  assert.equal(socket.sent.length, 2);
  fromVnc.write(Buffer.from('c'));
  await tick();
  await tick();
  assert.equal(socket.sent.length, 2, 'nothing more while paused');
  // A send done while still above the low water: still paused.
  socket.bufferedAmount = 500;
  socket.sent[1]?.done();
  await tick();
  assert.equal(socket.sent.length, 2);
  // Below the low water: it resumes, and what waited goes out.
  socket.bufferedAmount = 50;
  socket.sent[1]?.done();
  await until(() => socket.sent.length === 3, 'the chunk that waited');
  assert.deepEqual(socket.sent[2]?.data, Buffer.from('c'));
  assert.equal(h.screens.open, 1);
  h.screens.close();
});

test('a page that does not answer the ping is dropped; one that answers stays', async () => {
  const h = harness({ pingMs: 15 });
  const answering = attachFake(h, await token(h));
  const silent = attachFake(h, await token(h));
  const pong = setInterval(() => { answering.emit('pong'); }, 3);
  try {
    await until(() => silent.terminated, 'the silent page terminated');
    assert.ok(silent.pings >= 1);
    assert.equal(answering.terminated, false);
    assert.equal(h.screens.open, 1);
    assert.ok(h.events.some((event) => event.payload?.reason === 'no-pong'));
  } finally {
    clearInterval(pong);
    h.screens.close();
  }
});

test('status: open only for the conversation holding the browser, never for a Private or incognito one', async () => {
  const h = harness();
  assert.deepEqual(await h.screens.status(WORK), { open: true, site: 'comune-finto.it', control: 'agent' });
  assert.deepEqual(await h.screens.status(OTHER), { open: false });
  assert.equal(await h.screens.status(MISSING), null);
  // Never open nor a site for a Private or incognito one, even holding it.
  h.state.holder = PRIVATE;
  assert.deepEqual(await h.screens.status(PRIVATE), { open: false });
  h.state.holder = INCOGNITO;
  assert.deepEqual(await h.screens.status(INCOGNITO), { open: false });
  h.state.holder = WORK;
  h.screens.close();
  assert.deepEqual(await h.screens.status(WORK), { open: false });
});

test('closeByUser: only the conversation holding the browser closes it, its screens close, an event without content', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const ws = connect(port, `?t=${await token(h)}`);
  await once(ws, 'open');
  await until(() => h.channels.length === 1, 'the channel');
  assert.equal(await h.screens.closeByUser(OTHER), 'no-browser');
  assert.equal(await h.screens.closeByUser(MISSING), 'not-found');
  assert.deepEqual(h.closes, []);
  const ended = closed(ws);
  assert.equal(await h.screens.closeByUser(WORK), 'closed');
  assert.deepEqual(h.closes, [WORK]);
  assert.deepEqual(await ended, { code: SCREEN_CLOSE.browserClosed.code, reason: SCREEN_CLOSE.browserClosed.reason });
  assert.deepEqual(h.events.find((event) => event.kind === 'browser.close'), { kind: 'browser.close', label: 'L0', payload: { conversationId: WORK, reason: 'user' } });
  // Once closed, nothing more to close.
  assert.equal(await h.screens.closeByUser(WORK), 'no-browser');
});

test('GET /api/browser/screen?conversationId: open or not, 404 for no conversation, 400 for a wrong id, Host checked', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  assert.deepEqual(await get(port, `?conversationId=${WORK}`), { status: 200, body: { open: true, site: 'comune-finto.it', control: 'agent' } });
  assert.deepEqual(await get(port, `?conversationId=${OTHER}`), { status: 200, body: { open: false } });
  assert.deepEqual(await get(port, `?conversationId=${PRIVATE}`), { status: 200, body: { open: false } });
  assert.equal((await get(port, `?conversationId=${MISSING}`)).status, 404);
  assert.equal((await get(port, '?conversationId=x')).status, 400);
  assert.equal((await get(port, '')).status, 400);
  assert.equal((await get(port, `?conversationId=${WORK}`, { host: 'evil.example' })).status, 403);
  assert.equal((await get(port, `?conversationId=${WORK}`, { origin: 'http://evil.example' })).status, 403);
});

test('POST /api/browser/close: 200 closed for the holder, 409 for another conversation, 404 and 400, Origin and Host checked', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const close = (body: unknown, headers: Record<string, string> = {}) => post(port, body, headers, '/api/browser/close');
  assert.equal((await close({ conversationId: WORK }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await close({ conversationId: WORK }, { host: 'evil.example' })).status, 403);
  assert.equal((await close({ conversationId: WORK }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await close({ conversationId: WORK, more: 1 })).status, 400);
  assert.equal((await close({ conversationId: 'x' })).status, 400);
  assert.equal((await close({ conversationId: MISSING })).status, 404);
  assert.deepEqual(await close({ conversationId: OTHER }), { status: 409, body: { error: 'no-browser' } });
  assert.deepEqual(h.closes, []);
  assert.deepEqual(await close({ conversationId: WORK }), { status: 200, body: { closed: true } });
  assert.deepEqual(h.closes, [WORK]);
  assert.deepEqual(await close({ conversationId: WORK }), { status: 409, body: { error: 'no-browser' } });
});

test('without the screens the status and close routes answer 404', async (t) => {
  const port = await serve(t);
  assert.equal((await get(port, `?conversationId=${WORK}`)).status, 404);
  assert.equal((await post(port, { conversationId: WORK }, {}, '/api/browser/close')).status, 404);
});

// «Prendi il controllo» (D-264, passo 5).
const SET_ENCODINGS = Buffer.from([2, 0, 0, 2, 0xff, 0xff, 0xfe, 0xfe, 0, 0, 0, 7]); // -258 and 7
const POINTER_DOWN = Buffer.from([5, 1, 0, 10, 0, 20]);

function written(h: Harness, index: number): Buffer {
  return Buffer.concat(h.channels[index]?.written ?? []);
}

test('take: only an open screen of the browser; its keys and clicks reach Xvnc, those of the others do not', async () => {
  const h = harness();
  const first = await token(h);
  const second = await token(h);
  assert.deepEqual(await h.screens.take(WORK, first), { ok: false, reason: 'no-screen' });
  const a = attachFake(h, first);
  const b = attachFake(h, second);
  a.emit('message', HANDSHAKE, true);
  b.emit('message', HANDSHAKE, true);
  assert.deepEqual(await h.screens.take(OTHER, first), { ok: false, reason: 'no-browser' });
  assert.deepEqual(await h.screens.take(MISSING, first), { ok: false, reason: 'not-found' });
  assert.deepEqual(await h.screens.take(WORK, 'x'), { ok: false, reason: 'no-screen' });
  const taken = await h.screens.take(WORK, first);
  assert.ok(taken.ok);
  assert.equal(taken.waiting, false);
  assert.equal(await taken.done, true);
  assert.equal(h.driver.value, 'user');
  assert.deepEqual(await h.screens.status(WORK, first), { open: true, site: 'comune-finto.it', url: 'https://comune-finto.it/servizi?q=orari', control: 'you', blocked: { seq: 3, outcome: 'form' } });
  assert.equal((await h.screens.status(WORK, second))?.control, 'other');
  assert.equal((await h.screens.status(WORK))?.control, 'user');
  a.emit('message', Buffer.concat([SET_ENCODINGS, KEY_EVENT, POINTER_DOWN]), true);
  b.emit('message', Buffer.concat([KEY_EVENT, POINTER_DOWN]), true);
  await tick();
  // SetEncodings without -258; the key and the click of the screen that drives only.
  assert.deepEqual(written(h, 0), Buffer.concat([HANDSHAKE, Buffer.from([2, 0, 0, 1, 0, 0, 0, 7]), KEY_EVENT, POINTER_DOWN]));
  assert.deepEqual(written(h, 1), HANDSHAKE);
  assert.ok(h.driver.inputs >= 1);
  // «Passa all'ultimo che lo chiede»: the second screen takes it, the first goes back to view.
  const again = await h.screens.take(WORK, second);
  assert.ok(again.ok && (await again.done));
  assert.equal((await h.screens.status(WORK, first))?.control, 'other');
  a.emit('message', KEY_EVENT, true);
  b.emit('message', KEY_EVENT, true);
  await tick();
  assert.equal(written(h, 0).length, HANDSHAKE.length + 8 + KEY_EVENT.length + POINTER_DOWN.length);
  assert.deepEqual(written(h, 1), Buffer.concat([HANDSHAKE, KEY_EVENT]));
  // One control, taken once.
  assert.deepEqual(h.controls, [{ conversationId: WORK, state: 'taken' }]);
  assert.equal(await h.screens.giveBack(OTHER), 'not-driving');
  assert.equal(await h.screens.giveBack(MISSING), 'not-found');
  assert.equal(await h.screens.giveBack(WORK), 'returned');
  assert.equal(h.driver.value, 'agent');
  assert.equal((await h.screens.status(WORK, second))?.control, 'agent');
  b.emit('message', KEY_EVENT, true);
  await tick();
  assert.deepEqual(written(h, 1), Buffer.concat([HANDSHAKE, KEY_EVENT]));
  assert.equal(await h.screens.giveBack(WORK), 'not-driving');
  const events = h.events.filter((event) => event.kind === 'browser.control');
  assert.deepEqual(events[0], { kind: 'browser.control', label: 'L0', payload: { state: 'taken', conversationId: WORK } });
  const returned = events[1]?.payload ?? {};
  assert.equal(returned.state, 'returned');
  assert.equal(returned.reason, 'user');
  assert.equal(returned.keys, 2);
  assert.equal(returned.clicks, 1);
  assert.deepEqual(Object.keys(returned).sort(), ['clicks', 'conversationId', 'keys', 'ms', 'reason', 'state']);
  assert.deepEqual(h.controls.at(-1), { conversationId: WORK, state: 'returned', reason: 'user' });
});

test('take waits for the action of Arianna under way; a screen closed meanwhile gives the browser back', async () => {
  const h = harness();
  let finish: () => void = () => undefined;
  h.driver.wait = new Promise((resolve) => { finish = resolve; });
  const t = await token(h);
  const other = attachFake(h, t);
  const asked = await h.screens.take(WORK, t);
  assert.ok(asked.ok && asked.waiting);
  other.close();
  finish();
  assert.equal(await asked.done, false);
  assert.equal(h.driver.value, 'agent');
  assert.equal(h.driver.gives, 1);
  assert.deepEqual(h.controls, [{ conversationId: WORK, state: 'returned', reason: 'screen-closed' }]);
});

test('the control goes back to Arianna when its screen closes, and after the minutes without input', async () => {
  const h = harness({ idleMs: 30, checkMs: 5 });
  const first = await token(h);
  const a = attachFake(h, first);
  const taken = await h.screens.take(WORK, first);
  assert.ok(taken.ok && (await taken.done));
  a.close();
  assert.equal(h.driver.value, 'agent');
  assert.deepEqual(h.controls.at(-1), { conversationId: WORK, state: 'returned', reason: 'screen-closed' });
  const second = await token(h);
  attachFake(h, second);
  const again = await h.screens.take(WORK, second);
  assert.ok(again.ok && (await again.done));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.driver.value, 'agent');
  assert.deepEqual(h.controls.at(-1), { conversationId: WORK, state: 'returned', reason: 'idle' });
  h.screens.close();
});

test('the control ends with the browser: no give back to a browser that is gone', async () => {
  const h = harness();
  const first = await token(h);
  attachFake(h, first);
  const taken = await h.screens.take(WORK, first);
  assert.ok(taken.ok && (await taken.done));
  h.state.holder = null;
  h.state.container = null;
  h.screens.revoke();
  assert.equal(h.driver.gives, 0);
  assert.deepEqual(h.controls.at(-1), { conversationId: WORK, state: 'returned', reason: 'browser-closed' });
  assert.equal(h.events.filter((event) => event.kind === 'browser.control').length, 2);
});

test('POST /api/browser/control: take with the token of an open screen (200, or 202 while Arianna acts), return; errors', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const control = (body: unknown, headers: Record<string, string> = {}) => post(port, body, headers, '/api/browser/control');
  const screen = await token(h);
  const ws = connect(port, `?t=${screen}`);
  await once(ws, 'open');
  await until(() => h.screens.open === 1, 'the screen');
  assert.equal((await control({ conversationId: WORK, action: 'take', screen }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await control({ conversationId: WORK, action: 'take' })).status, 400);
  assert.equal((await control({ conversationId: WORK, action: 'drive', screen })).status, 400);
  assert.equal((await control({ conversationId: WORK, action: 'take', screen, more: 1 })).status, 400);
  assert.equal((await control({ conversationId: WORK, action: 'return', screen })).status, 400);
  assert.equal((await control({ conversationId: MISSING, action: 'take', screen })).status, 404);
  assert.deepEqual(await control({ conversationId: OTHER, action: 'take', screen }), { status: 409, body: { error: 'no-browser' } });
  assert.deepEqual(await control({ conversationId: WORK, action: 'take', screen: randomBytes(32).toString('base64url') }), { status: 409, body: { error: 'no-screen' } });
  assert.deepEqual(await control({ conversationId: WORK, action: 'return' }), { status: 409, body: { error: 'not-driving' } });
  assert.deepEqual(await control({ conversationId: WORK, action: 'take', screen }), { status: 200, body: { control: 'you' } });
  assert.deepEqual(await get(port, `?conversationId=${WORK}&screen=${screen}`), { status: 200, body: { open: true, site: 'comune-finto.it', url: 'https://comune-finto.it/servizi?q=orari', control: 'you', blocked: { seq: 3, outcome: 'form' } } });
  assert.deepEqual(await control({ conversationId: WORK, action: 'return' }), { status: 200, body: { control: 'agent' } });
  let finish: () => void = () => undefined;
  h.driver.wait = new Promise((resolve) => { finish = resolve; });
  assert.deepEqual(await control({ conversationId: WORK, action: 'take', screen }), { status: 202, body: { waiting: true } });
  finish();
  await until(() => h.driver.value === 'user', 'the control taken after the action');
});

test('the bar of the screen (D-286): commands only from an open screen of the browser the conversation holds; events without addresses', async () => {
  const h = harness();
  const issued = await token(h);
  // Not open yet: no screen, nothing asked of the browser; no address in the status either.
  assert.deepEqual(await h.screens.navigate(WORK, issued, { kind: 'back' }), { ok: false, reason: 'no-screen' });
  assert.equal((await h.screens.status(WORK, issued))?.url, undefined);
  attachFake(h, issued);
  await tick();
  assert.equal((await h.screens.status(WORK, issued))?.url, 'https://comune-finto.it/servizi?q=orari');
  // Without the token of a screen, the status never says the address.
  assert.equal((await h.screens.status(WORK))?.url, undefined);
  assert.deepEqual(await h.screens.navigate(WORK, issued, { kind: 'open', url: 'https://comune-finto.it/servizi' }), { ok: true, url: 'https://comune-finto.it/servizi', site: 'comune-finto.it' });
  assert.deepEqual(await h.screens.navigate(WORK, issued, { kind: 'forward' }), { ok: false, reason: 'no-page' });
  assert.deepEqual(h.commands, [{ kind: 'open', url: 'https://comune-finto.it/servizi' }, { kind: 'forward' }]);
  const controls = h.events.filter((event) => event.kind === 'browser.control').map((event) => event.payload);
  assert.deepEqual(controls, [{ conversationId: WORK, command: 'open', outcome: 'ok' }, { conversationId: WORK, command: 'forward', outcome: 'no-page' }]);
  assert.doesNotMatch(JSON.stringify(controls), /comune-finto/);
  // Another conversation, or a wrong token: nothing.
  assert.deepEqual(await h.screens.navigate(WORK, 'x'.repeat(43), { kind: 'reload' }), { ok: false, reason: 'no-screen' });
  h.state.holder = null;
  assert.deepEqual(await h.screens.navigate(WORK, issued, { kind: 'reload' }), { ok: false, reason: 'no-browser' });
  assert.equal(h.commands.length, 2);
});

test('POST /api/browser/navigate (D-286): only from an open screen and the origin of the chat; the command checked; refusals as 409', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const navigate = (body: unknown, headers: Record<string, string> = {}) => post(port, body, headers, '/api/browser/navigate');
  const screen = await token(h);
  const ws = connect(port, `?t=${screen}`);
  await once(ws, 'open');
  await until(() => h.screens.open === 1, 'the screen');
  assert.equal((await navigate({ conversationId: WORK, screen, command: 'back' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await navigate({ conversationId: WORK, screen, command: 'print' })).status, 400);
  assert.equal((await navigate({ conversationId: WORK, screen, command: 'back', url: 'https://comune-finto.it/' })).status, 400);
  assert.equal((await navigate({ conversationId: WORK, screen, command: 'open' })).status, 400);
  assert.equal((await navigate({ conversationId: WORK, screen, command: 'open', url: 'https://comune-finto.it/', confirmed: 'yes' })).status, 400);
  assert.equal((await navigate({ conversationId: WORK, screen, command: 'back', more: 1 })).status, 400);
  assert.deepEqual(await navigate({ conversationId: WORK, screen: 'x'.repeat(43), command: 'back' }), { status: 409, body: { error: 'no-screen' } });
  assert.deepEqual(await navigate({ conversationId: WORK, screen, command: 'open', url: 'https://comune-finto.it/servizi' }), { status: 200, body: { ok: true, url: 'https://comune-finto.it/servizi', site: 'comune-finto.it' } });
  assert.deepEqual(await navigate({ conversationId: WORK, screen, command: 'forward' }), { status: 200, body: { ok: false, reason: 'no-page' } });
  ws.close();
});

test('a gesture of the user is a click, Enter or Space of the screen that drives; the keys of a text and the moves of the mouse never (D-286)', async () => {
  const h = harness();
  const screen = await token(h);
  const socket = attachFake(h, screen);
  socket.emit('message', HANDSHAKE, true);
  const taken = await h.screens.take(WORK, screen);
  assert.ok(taken.ok && (await taken.done));
  const keyOf = (keysym: number, down = true): Buffer => {
    const message = Buffer.from([4, down ? 1 : 0, 0, 0, 0, 0, 0, 0]);
    message.writeUInt32BE(keysym, 4);
    return message;
  };
  // Letters, Shift, a move of the mouse: input, never a gesture (a script while the user writes in a form gets none).
  socket.emit('message', Buffer.concat([keyOf(0x61), keyOf(0x61, false), keyOf(0xffe1), keyOf(0xffe1, false), Buffer.from([5, 0, 0, 10, 0, 20])]), true);
  await tick();
  assert.ok(h.driver.inputs >= 1);
  assert.equal(h.driver.gestures, 0);
  // Enter, then a click: two gestures.
  socket.emit('message', keyOf(0xff0d), true);
  await tick();
  socket.emit('message', Buffer.from([5, 1, 0, 10, 0, 20]), true);
  await tick();
  assert.equal(h.driver.gestures, 2);
});

test('status: «login» only to the screen that drives, when the page shows a login form (D-287)', async () => {
  const h = harness();
  const first = await token(h);
  const second = await token(h);
  attachFake(h, first).emit('message', HANDSHAKE, true);
  attachFake(h, second).emit('message', HANDSHAKE, true);
  h.driver.login = true;
  // Arianna drives: no check of the page, no note.
  assert.equal((await h.screens.status(WORK, first))?.login, undefined);
  assert.equal(h.driver.loginAsked ?? 0, 0);
  const taken = await h.screens.take(WORK, first);
  assert.ok(taken.ok && (await taken.done));
  assert.equal((await h.screens.status(WORK, first))?.login, true);
  assert.equal((await h.screens.status(WORK, second))?.login, undefined);
  assert.equal((await h.screens.status(WORK))?.login, undefined);
  // A page without a login form.
  h.driver.login = false;
  assert.equal((await h.screens.status(WORK, first))?.login, undefined);
});
