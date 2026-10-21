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
const KINDS: Record<string, ConversationKind> = { [WORK]: 'work', [OTHER]: 'work', [PRIVATE]: 'private', [INCOGNITO]: 'incognito' };

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
}

function harness(options: { failOpen?: boolean; stuck?: boolean; limits?: ScreensOptions['limits']; pingMs?: number } = {}): Harness {
  const state: Harness['state'] = { holder: WORK, container: 'arianna-browser-chat-aaaaaaaaaaaa' };
  const channels: FakeChannel[] = [];
  const events: NewEvent[] = [];
  const closes: string[] = [];
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
    openChannel,
    onEvent: (event) => { events.push(event); },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.pingMs === undefined ? {} : { pingMs: options.pingMs }),
  });
  return { screens, state, channels, events, closes };
}

async function token(h: Harness, conversationId = WORK): Promise<string> {
  const issued = await h.screens.issue(conversationId);
  assert.ok(issued.ok, JSON.stringify(issued));
  return issued.token;
}

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

test('at most three screens per browser, from the same token; the fourth is refused', async (t) => {
  const h = harness();
  const port = await serve(t, h.screens);
  const shared = await token(h);
  const open: WebSocket[] = [];
  for (let index = 0; index < MAX_SCREENS; index += 1) {
    const ws = connect(port, `?t=${index === 0 ? shared : await token(h)}`);
    await once(ws, 'open');
    open.push(ws);
  }
  await until(() => h.screens.open === MAX_SCREENS, 'three screens');
  const fourth = connect(port, `?t=${shared}`);
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
  const again = connect(port, `?t=${shared}`);
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
  assert.deepEqual(await h.screens.status(WORK), { open: true, site: 'comune-finto.it' });
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
  assert.deepEqual(await get(port, `?conversationId=${WORK}`), { status: 200, body: { open: true, site: 'comune-finto.it' } });
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
