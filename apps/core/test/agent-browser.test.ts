import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Context, PageConsent } from '@arianna/policy';
import type { Page } from 'playwright-core';

import { AgentBrowser, outsideConsent, parseReading, READ_SCRIPT, TAKE_OVER_MS, type BrowserScope, type OpenSession } from '../src/browser/agent-browser.ts';
import type { Sql } from '../src/db/client.ts';
import type { BrowserManager } from '../src/browser/manager.ts';
import type { NetworkScope } from '../src/browser/network.ts';
import type { BrowserSession } from '../src/browser/session.ts';

const PUBLIC: Context = { clearance: 'L1', effective: 'L0' } as unknown as Context;
const INTERNAL: Context = { clearance: 'L1', effective: 'L1' } as unknown as Context;

interface FakePage {
  url: string;
  title: string;
  reading: unknown;
  clicked: string[];
  filled: [string, string][];
  pressed: string[];
  typable: boolean;
  /** A script of the page that never ends: the reading hangs. */
  hang?: boolean;
  /** A script of the page that ends when this does: an action under way. */
  wait?: Promise<void>;
}

function fakePage(state: FakePage): Page {
  const locator = (selector: string) => ({
    first: () => ({
      click: () => { state.clicked.push(selector); return Promise.resolve(); },
      fill: (text: string) => { state.filled.push([selector, text]); return Promise.resolve(); },
      press: (key: string) => { state.pressed.push(key); return Promise.resolve(); },
      evaluate: () => Promise.resolve(state.typable),
    }),
  });
  return {
    url: () => state.url,
    title: () => Promise.resolve(state.title),
    evaluate: async (script: unknown) => {
      if (state.hang === true) return new Promise<never>(() => undefined);
      if (state.wait !== undefined) await state.wait;
      return script === READ_SCRIPT ? state.reading : undefined;
    },
    locator,
    mainFrame: () => ({}),
    waitForEvent: () => Promise.reject(new Error('no navigation')),
    waitForLoadState: () => Promise.resolve(),
  } as unknown as Page;
}

interface Harness {
  browser: AgentBrowser;
  /** The manager closed the browser by itself (idle, max). */
  expire: () => void;
  touches: number;
  opened: string[];
  closed: string[];
  scopes: NetworkScope[];
  taken: string[];
  released: string[];
  typed: string[];
  page: FakePage;
  clock: { now: number };
  /** The last navigation the fake network decided; set by a test. */
  last: { seq: number; outcome: 'blocked' | 'ok' | 'form'; site?: string } | undefined;
  /** Activity without an action (the user drives). */
  userTouches: number;
  /** The site of an access made by the user, as the fake network says (D-276). */
  access: string | null;
}

function harness(options: { gate?: boolean; failOpen?: boolean; last?: { seq: number; outcome: 'blocked' | 'ok' }; warmGuard?: () => Promise<unknown> } = {}): Harness {
  const page: FakePage = { url: 'https://comune-finto.it/servizi', title: 'Servizi', reading: { title: 'Servizi', url: 'https://comune-finto.it/servizi', text: 'Orari', elements: [], scrolled: 0 }, clicked: [], filled: [], pressed: [], typable: true };
  const clock = { now: 1_000_000 };
  let active: { id: string } | null = null;
  const manager = { get state() { return 'free'; }, get active() { return active; } } as unknown as BrowserManager;
  const h: Harness = { browser: undefined as unknown as AgentBrowser, expire: () => { active = null; }, touches: 0, opened: [], closed: [], scopes: [], taken: [], released: [], typed: [], page, clock, last: options.last, userTouches: 0, access: null };
  const openSession: OpenSession = (_manager, id) => {
    if (options.failOpen) return Promise.reject(new Error('docker'));
    active = { id };
    h.opened.push(id);
    const session = {
      network: { rescope: (scope: NetworkScope) => { h.scopes.push(scope); }, lastNavigation: () => (h.last === undefined ? undefined : { ...h.last }), authenticated: () => h.access, settle: () => Promise.resolve() },
      openPage: (url: string) => { page.url = url; return Promise.resolve({ title: page.title, url }); },
      currentPage: () => {
        h.touches += 1;
        return Promise.resolve(fakePage(page));
      },
      touch: () => { h.userTouches += 1; },
      close: () => { h.closed.push(id); active = null; return Promise.resolve(); },
    } as unknown as BrowserSession;
    return Promise.resolve(session);
  };
  h.browser = new AgentBrowser({
    sql: undefined as unknown as Sql,
    manager,
    session: { home: '/nowhere' },
    gateTyped: (text) => { h.typed.push(text); return Promise.resolve(options.gate ?? true); },
    onTaken: (conversationId) => { h.taken.push(conversationId); },
    onReleased: (conversationId) => { h.released.push(conversationId); },
    now: () => clock.now,
    actionLimitMs: 50,
    openSession,
    ...(options.warmGuard === undefined ? {} : { warmGuard: options.warmGuard }),
  });
  return h;
}

function scope(conversationId: string, consent: PageConsent = { from: 'public' }, context: Context = PUBLIC): BrowserScope {
  return { conversationId, context, consent };
}

test('a browser is held by one conversation: open, then read, then close', async () => {
  const h = harness();
  const opened = await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  assert.equal(opened.ok, true);
  assert.equal(h.browser.holder, 'a');
  const read = await h.browser.act(scope('a'), { kind: 'read' });
  assert.ok(read.ok && read.reading?.text === 'Orari');
  await h.browser.act(scope('a'), { kind: 'close' });
  assert.equal(h.browser.holder, null);
  assert.deepEqual(h.closed, h.opened);
});

test('the second scanner is ready before a page opens: its load is not counted in the time of the action (D-281)', async () => {
  let warmed = 0;
  let ready: () => void = () => undefined;
  const h = harness({ warmGuard: () => { warmed += 1; return new Promise<void>((resolve) => { ready = resolve; }); } });
  const opening = h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  // Longer than the deadline of an action (50 ms here): the browser waits without starting.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(h.opened, []);
  ready();
  assert.equal((await opening).ok, true);
  assert.equal(warmed, 1);
});

test('reading, scrolling and closing do not start the second scanner; one that cannot start does not stop the browser (D-281)', async () => {
  let warmed = 0;
  const h = harness({ warmGuard: () => { warmed += 1; return Promise.reject(new Error('no python')); } });
  assert.equal((await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' })).ok, true);
  assert.equal(warmed, 1);
  await h.browser.act(scope('a'), { kind: 'read' });
  await h.browser.act(scope('a'), { kind: 'scroll', direction: 'down' });
  await h.browser.act(scope('a'), { kind: 'close' });
  assert.equal(warmed, 1);
  assert.equal(h.browser.holder, null);
});

test('the wait for the second scanner holds no queue: the user takes the control meanwhile, and the action of Arianna is paused (D-281)', async () => {
  let slow = false;
  let ready: () => void = () => undefined;
  const h = harness({ warmGuard: () => (slow ? new Promise<void>((resolve) => { ready = resolve; }) : Promise.resolve()) });
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  slow = true;
  const clicking = h.browser.act(scope('a'), { kind: 'click', ref: 1 });
  const request = h.browser.takeControl('a');
  assert.equal(request.waiting, false);
  assert.equal(await request.done, true);
  ready();
  assert.deepEqual(await clicking, { ok: false, reason: 'paused' });
});

test('released or shut down while an open waits for the second scanner: no browser opens behind it (D-281)', async () => {
  for (const stop of ['release', 'close'] as const) {
    let ready: () => void = () => undefined;
    const h = harness({ warmGuard: () => new Promise<void>((resolve) => { ready = resolve; }) });
    const opening = h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
    await (stop === 'release' ? h.browser.release('a') : h.browser.close());
    ready();
    assert.deepEqual(await opening, { ok: false, reason: 'not-open' }, stop);
    assert.deepEqual(h.opened, [], stop);
    assert.equal(h.browser.holder, null, stop);
  }
});

test('a second scanner that throws at once does not make an action throw (D-281)', async () => {
  const h = harness({ warmGuard: () => { throw new Error('no python'); } });
  assert.equal((await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' })).ok, true);
});

test('an action other than open without a browser is refused, and so is reading before opening', async () => {
  const h = harness();
  const read = await h.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(read, { ok: false, reason: 'not-open' });
  assert.deepEqual(h.opened, []);
});

test('the scope of every action goes to the network: a conversation that became Internal clicks with the user consent', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  const consent: PageConsent = { from: 'user', addresses: ['https://comune-finto.it/servizi'] };
  await h.browser.act(scope('a', consent, INTERNAL), { kind: 'read' });
  assert.deepEqual(h.scopes.at(-1), { context: INTERNAL, consent, driver: 'agent' });
});

test('another conversation gets busy while the browser was used less than 2 minutes ago, and takes it after', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  h.clock.now += TAKE_OVER_MS - 1;
  assert.deepEqual(await h.browser.act(scope('b'), { kind: 'open', url: 'https://ricette-finte.it/' }), { ok: false, reason: 'busy' });
  assert.equal(h.browser.holder, 'a');
  h.clock.now += 1;
  const taken = await h.browser.act(scope('b'), { kind: 'open', url: 'https://ricette-finte.it/' });
  assert.equal(taken.ok, true);
  assert.equal(h.browser.holder, 'b');
  assert.deepEqual(h.taken, ['a']);
  assert.equal(h.closed.length, 1);
});

test('another conversation never takes the browser with an action other than open', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  h.clock.now += TAKE_OVER_MS * 2;
  assert.deepEqual(await h.browser.act(scope('b'), { kind: 'read' }), { ok: false, reason: 'not-open' });
  assert.equal(h.browser.holder, 'a');
});

test('a browser that does not start is a failure, never a throw', async () => {
  const h = harness({ failOpen: true });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' }), { ok: false, reason: 'start-failed' });
  assert.equal(h.browser.holder, null);
});

test('a click needs a reading of the same page, and an element of it', async () => {
  const h = harness();
  h.page.reading = { title: 'Servizi', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'button', label: 'Cerca' }], scrolled: 0 };
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'click', ref: 1 }), { ok: false, reason: 'no-reading' });
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'click', ref: 2 }), { ok: false, reason: 'unknown-element' });
  assert.equal((await h.browser.act(scope('a'), { kind: 'click', ref: 1 })).ok, true);
  assert.deepEqual(h.page.clicked, ['[data-arianna-ref="1"]']);
});

test('in an Internal conversation a link to another site waits for the user, a link of the same site is clicked', async () => {
  const h = harness();
  h.page.reading = {
    title: 'Servizi',
    url: 'https://comune-finto.it/servizi',
    text: '',
    elements: [
      { ref: 1, kind: 'link', label: 'Anagrafe', href: 'https://comune-finto.it/anagrafe' },
      { ref: 2, kind: 'link', label: 'Prenota', href: 'https://prenotazioni-finte.it/anagrafe' },
    ],
    scrolled: 0,
  };
  const consent: PageConsent = { from: 'user', addresses: ['https://comune-finto.it/servizi'] };
  await h.browser.act(scope('a', consent, INTERNAL), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a', consent, INTERNAL), { kind: 'read' });
  assert.deepEqual(await h.browser.act(scope('a', consent, INTERNAL), { kind: 'click', ref: 2 }), { ok: false, reason: 'confirm', url: 'https://prenotazioni-finte.it/anagrafe', site: 'prenotazioni-finte.it' });
  assert.deepEqual(h.page.clicked, []);
  assert.equal((await h.browser.act(scope('a', consent, INTERNAL), { kind: 'click', ref: 1 })).ok, true);
});

test('typing: through the gateway first, never in a password field, never beyond 200 characters', async () => {
  const h = harness();
  h.page.reading = {
    title: 'Cerca',
    url: 'https://comune-finto.it/servizi',
    text: '',
    elements: [{ ref: 1, kind: 'field', label: 'Cerca', type: 'search' }, { ref: 2, kind: 'password', label: 'Password' }, { ref: 3, kind: 'button', label: 'Vai' }],
    scrolled: 0,
  };
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'type', ref: 2, text: 'x', submit: false }), { ok: false, reason: 'password-field' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'type', ref: 3, text: 'x', submit: false }), { ok: false, reason: 'not-a-field' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'type', ref: 1, text: 'x'.repeat(201), submit: false }), { ok: false, reason: 'too-long' });
  assert.deepEqual(h.typed, []);
  const typed = await h.browser.act(scope('a'), { kind: 'type', ref: 1, text: 'orari anagrafe', submit: true });
  assert.ok(typed.ok && typed.typed === 14);
  assert.deepEqual(h.typed, ['orari anagrafe']);
  assert.deepEqual(h.page.filled, [['[data-arianna-ref="1"]', 'orari anagrafe']]);
  assert.deepEqual(h.page.pressed, ['Enter']);
});

test('a text the gateway refuses is never typed, nor is one in a field whose type changed', async () => {
  const blocked = harness({ gate: false });
  blocked.page.reading = { title: '', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'field', label: 'Cerca', type: 'search' }], scrolled: 0 };
  await blocked.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await blocked.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(await blocked.browser.act(scope('a'), { kind: 'type', ref: 1, text: 'IT60X0542811101000000123456', submit: false }), { ok: false, reason: 'typed-blocked' });
  assert.deepEqual(blocked.page.filled, []);
  const changed = harness();
  changed.page.reading = blocked.page.reading;
  changed.page.typable = false;
  await changed.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await changed.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(await changed.browser.act(scope('a'), { kind: 'type', ref: 1, text: 'orari', submit: false }), { ok: false, reason: 'not-a-field' });
  assert.deepEqual(changed.page.filled, []);
});

test('outsideConsent: public goes anywhere; user only its addresses and their sites', () => {
  assert.equal(outsideConsent({ from: 'public' }, 'https://altro-finto.it/'), undefined);
  const user: PageConsent = { from: 'user', addresses: ['https://comune-finto.it/servizi'] };
  assert.equal(outsideConsent(user, 'https://comune-finto.it/anagrafe'), undefined);
  assert.equal(outsideConsent(user, 'https://www.comune-finto.it/anagrafe'), undefined);
  assert.equal(outsideConsent(user, 'https://prenotazioni-finte.it/'), 'prenotazioni-finte.it');
  assert.equal(outsideConsent({ from: 'user', addresses: ['https://comune-finto.it/servizi', 'https://prenotazioni-finte.it/anagrafe'] }, 'https://prenotazioni-finte.it/anagrafe'), undefined);
  assert.equal(outsideConsent(user, 'mailto:ufficio@comune-finto.it'), undefined);
});

test('parseReading keeps only the expected shape of what a page returns', () => {
  const reading = parseReading({
    title: 'T',
    url: 'https://a-finto.it/',
    text: 'x'.repeat(30_000),
    scrolled: 250,
    elements: [
      { ref: 1, kind: 'link', label: 'A', href: 'https://a-finto.it/b', value: 'segreto' },
      { ref: 0, kind: 'button', label: 'zero' },
      { ref: 2, kind: 'script', label: 'evil' },
      { ref: 3, kind: 'field', label: 'Cerca', type: 'search', value: 'non letto' },
      'junk',
    ],
  });
  assert.equal(reading.text.length, 20_000);
  assert.equal(reading.scrolled, 100);
  assert.deepEqual(reading.elements, [
    { ref: 1, kind: 'link', label: 'A', href: 'https://a-finto.it/b' },
    { ref: 3, kind: 'field', label: 'Cerca', type: 'search' },
  ]);
  assert.deepEqual(parseReading(null), { title: '', url: '', text: '', elements: [], scrolled: 0 });
});

test('the reading script never reads the value of a field', () => {
  assert.doesNotMatch(READ_SCRIPT, /\.value\b/);
  assert.match(READ_SCRIPT, /getAttribute\('value'\)/);
});

test('a click that does not navigate after a refused page is not a refusal (the same last navigation, read again)', async () => {
  const h = harness({ last: { seq: 3, outcome: 'blocked' } });
  h.page.reading = { title: 'Servizi', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'button', label: 'Mostra' }], scrolled: 0 };
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.equal((await h.browser.act(scope('a'), { kind: 'click', ref: 1 })).ok, true);
});

test('every action reads the page through the session, which keeps the browser from closing as idle', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  const before = h.touches;
  await h.browser.act(scope('a'), { kind: 'read' });
  await h.browser.act(scope('a'), { kind: 'scroll', direction: 'down' });
  assert.ok(h.touches >= before + 2);
});

test('an action past its deadline closes the browser and fails, the queue goes on', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/lenta' });
  h.page.hang = true;
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'action-failed' });
  assert.equal(h.browser.holder, null);
  assert.equal(h.closed.length, 1);
  assert.equal((await h.browser.act(scope('b'), { kind: 'open', url: 'https://ricette-finte.it/' })).ok, true);
});

test('release closes the browser of that conversation only; close closes any', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  await h.browser.release('b');
  assert.equal(h.browser.holder, 'a');
  await h.browser.release('a');
  assert.equal(h.browser.holder, null);
  await h.browser.act(scope('b'), { kind: 'open', url: 'https://ricette-finte.it/' });
  await h.browser.close();
  assert.equal(h.browser.holder, null);
  assert.equal(h.closed.length, 2);
});

test('a browser the manager closed (idle, max) is no longer held', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  h.expire();
  assert.equal(h.browser.holder, null);
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'not-open' });
});

test('onReleased: the screens hear of every browser a conversation no longer holds (close, take-over, release, manager)', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  await h.browser.act(scope('a'), { kind: 'close' });
  assert.deepEqual(h.released, ['a']);
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  h.clock.now += TAKE_OVER_MS;
  await h.browser.act(scope('b'), { kind: 'open', url: 'https://ricette-finte.it/' });
  assert.deepEqual(h.released, ['a', 'a']);
  await h.browser.release('b');
  assert.deepEqual(h.released, ['a', 'a', 'b']);
  await h.browser.act(scope('c'), { kind: 'open', url: 'https://ricette-finte.it/' });
  h.expire();
  assert.equal(h.browser.holder, null);
  assert.deepEqual(h.released, ['a', 'a', 'b', 'c']);
  // Nothing held: nothing to tell.
  await h.browser.close();
  assert.deepEqual(h.released, ['a', 'a', 'b', 'c']);
});

test('in an Internal conversation browser.open takes only an address the user wrote; any other waits for the user', async () => {
  const h = harness();
  const consent: PageConsent = { from: 'user', addresses: ['https://comune-finto.it/servizi'] };
  assert.deepEqual(await h.browser.act(scope('a', consent, INTERNAL), { kind: 'open', url: 'https://comune-finto.it/cerca?q=dati' }), { ok: false, reason: 'confirm', url: 'https://comune-finto.it/cerca?q=dati', site: 'comune-finto.it' });
  assert.deepEqual(h.opened, []);
  assert.equal((await h.browser.act(scope('a', consent, INTERNAL), { kind: 'open', url: 'https://comune-finto.it/servizi#orari' })).ok, true);
  assert.equal((await h.browser.act(scope('a', consent, INTERNAL), { kind: 'open', url: 'https://comune-finto.it/altro' })).ok, false);
});

test('the reading takes address and title from the browser, not from what the page script returns', async () => {
  const h = harness();
  h.page.reading = { title: 'Finto', url: 'https://banca-finta.it/', text: '', elements: [], scrolled: 0 };
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  const read = await h.browser.act(scope('a'), { kind: 'read' });
  assert.ok(read.ok && read.reading?.url === 'https://comune-finto.it/servizi' && read.page.site === 'comune-finto.it' && read.reading.title === 'Servizi');
});

test('typing counts characters as the gateway does: 200 emoji are not too long', async () => {
  const h = harness();
  h.page.reading = { title: '', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'field', label: 'Cerca', type: 'search' }], scrolled: 0 };
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  const typed = await h.browser.act(scope('a'), { kind: 'type', ref: 1, text: '😀'.repeat(200), submit: false });
  assert.ok(typed.ok && typed.typed === 200);
});

test('closeByUser («Chiudi» in the chat): only the conversation holding the browser, after the action under way, then the next action hears why once', async () => {
  const h = harness();
  assert.equal(await h.browser.closeByUser('a'), false);
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  // Another conversation cannot close it.
  assert.equal(await h.browser.closeByUser('b'), false);
  assert.equal(h.browser.holder, 'a');
  // An action under way: the browser closes once it ended, never in the middle.
  let finish = (): void => undefined;
  h.page.wait = new Promise<void>((resolve) => { finish = resolve; });
  const reading = h.browser.act(scope('a'), { kind: 'read' });
  const closing = h.browser.closeByUser('a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.browser.holder, 'a');
  assert.deepEqual(h.closed, []);
  finish();
  assert.equal((await reading).ok, true);
  assert.equal(await closing, true);
  assert.equal(h.browser.holder, null);
  assert.deepEqual(h.closed, h.opened);
  assert.deepEqual(h.released, ['a']);
  // The next action of that conversation hears it was the user, once; another conversation does not.
  assert.deepEqual(await h.browser.act(scope('b'), { kind: 'read' }), { ok: false, reason: 'not-open' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'closed-by-user' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'not-open' });
  // browser.open opens it again.
  assert.equal(await h.browser.closeByUser('a'), false);
  delete h.page.wait;
  assert.equal((await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' })).ok, true);
  assert.equal(h.browser.holder, 'a');
});

test('after closeByUser, browser.open opens again at once, without the «closed by the user» refusal', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  assert.equal(await h.browser.closeByUser('a'), true);
  assert.equal((await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' })).ok, true);
  // The refusal was consumed by the open: a read now reads.
  assert.equal((await h.browser.act(scope('a'), { kind: 'read' })).ok, true);
});

test('siteOf: the site of the last page reached, only for the conversation holding the browser', async () => {
  const h = harness();
  assert.equal(h.browser.siteOf('a'), null);
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  assert.equal(h.browser.siteOf('a'), 'comune-finto.it');
  assert.equal(h.browser.siteOf('b'), null);
  await h.browser.act(scope('a'), { kind: 'close' });
  assert.equal(h.browser.siteOf('a'), null);
});

test('release forgets a «Chiudi» not yet heard: a later read hears «not open»', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/' });
  assert.equal(await h.browser.closeByUser('a'), true);
  await h.browser.release('a');
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'not-open' });
});


// «Prendi il controllo» (D-264, passo 5).
test('takeControl: only the conversation holding the browser; then Arianna is paused there and busy elsewhere, never taken over', async () => {
  const h = harness();
  assert.equal(await h.browser.takeControl('a').done, false);
  await h.browser.act({ ...scope('a'), meta: { taskId: 't1' } }, { kind: 'open', url: 'https://comune-finto.it/servizi' });
  assert.equal(await h.browser.takeControl('b').done, false);
  const request = h.browser.takeControl('a');
  assert.equal(request.waiting, false);
  assert.equal(await request.done, true);
  assert.equal(h.browser.driverOf('a'), 'user');
  assert.equal(h.browser.driverOf('b'), null);
  // The requests of the user go on with the scope of Arianna, without her task.
  const last = h.scopes.at(-1);
  assert.equal(last?.driver, 'user');
  assert.equal(last.meta, undefined);
  const paused = await h.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(paused, { ok: false, reason: 'paused' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'close' }), { ok: false, reason: 'paused' });
  h.clock.now += TAKE_OVER_MS * 10;
  assert.deepEqual(await h.browser.act(scope('b'), { kind: 'open', url: 'https://altro-finto.it/' }), { ok: false, reason: 'busy' });
  assert.equal(h.browser.holder, 'a');
  assert.equal(h.taken.length, 0);
});

test('returnControl: the first action of Arianna must be a reading, then she goes on', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.equal(h.browser.returnControl('a'), false);
  await h.browser.takeControl('a').done;
  assert.equal(h.browser.returnControl('b'), false);
  assert.equal(h.browser.returnControl('a'), true);
  assert.equal(h.browser.driverOf('a'), 'agent');
  assert.equal(h.scopes.at(-1)?.driver, 'agent');
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'click', ref: 1 }), { ok: false, reason: 'reread' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'scroll', direction: 'down' }), { ok: false, reason: 'reread' });
  const read = await h.browser.act(scope('a'), { kind: 'read' });
  assert.equal(read.ok, true);
  assert.equal((await h.browser.act(scope('a'), { kind: 'scroll', direction: 'down' })).ok, true);
});

test('takeControl waits for the action under way, never in the middle of it', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  let finish: () => void = () => undefined;
  h.page.wait = new Promise((resolve) => { finish = resolve; });
  const reading = h.browser.act(scope('a'), { kind: 'read' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = h.browser.takeControl('a');
  assert.equal(request.waiting, true);
  assert.equal(h.browser.driverOf('a'), 'agent');
  finish();
  assert.equal((await reading).ok, true);
  assert.equal(await request.done, true);
  assert.equal(h.browser.driverOf('a'), 'user');
});

test('input of the user counts as activity; the site and the refused navigations come from the network while the user drives', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  h.last = { seq: 4, outcome: 'ok', site: 'comune-finto.it' };
  h.browser.userInput('a');
  assert.equal(h.userTouches, 0);
  await h.browser.takeControl('a').done;
  const before = h.userTouches;
  h.browser.userInput('a');
  h.browser.userInput('b');
  assert.equal(h.userTouches, before + 1);
  // Nothing refused since the control was taken.
  assert.equal(h.browser.blockedOf('a'), null);
  h.last = { seq: 5, outcome: 'ok', site: 'servizi-finti.it' };
  assert.equal(h.browser.siteOf('a'), 'servizi-finti.it');
  h.last = { seq: 6, outcome: 'blocked' };
  assert.deepEqual(h.browser.blockedOf('a'), { seq: 6, outcome: 'blocked' });
  assert.equal(h.browser.blockedOf('b'), null);
  h.browser.returnControl('a');
  assert.equal(h.browser.blockedOf('a'), null);
});

test('after an access made by the user (D-276) Arianna neither reads nor acts in the browser; she may close it', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://banca-finta.it/accedi' });
  assert.equal(h.browser.accessOf('a'), null);
  h.access = 'banca-finta.it';
  assert.equal(h.browser.accessOf('a'), 'banca-finta.it');
  assert.equal(h.browser.accessOf('b'), null);
  for (const action of [{ kind: 'read' }, { kind: 'scroll', direction: 'down' }, { kind: 'click', ref: 1 }, { kind: 'open', url: 'https://banca-finta.it/conti' }, { kind: 'type', ref: 1, text: 'x', submit: false }] as const) {
    assert.deepEqual(await h.browser.act(scope('a'), action), { ok: false, reason: 'authenticated' }, action.kind);
  }
  // Given back after the access: still nothing, the reading is refused too.
  await h.browser.takeControl('a').done;
  h.browser.returnControl('a');
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'authenticated' });
  assert.equal((await h.browser.act(scope('a'), { kind: 'close' })).ok, true);
  assert.equal(h.browser.holder, null);
});
