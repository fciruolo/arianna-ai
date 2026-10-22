import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext, type Context, type PageConsent } from '@arianna/policy';
import type { Page } from 'playwright-core';

import { AgentBrowser, outsideConsent, parseReading, READ_SCRIPT, TAKE_OVER_MS, type BrowserScope, type OpenSession, type TypedVerdict } from '../src/browser/agent-browser.ts';
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
  /** The saved values let go each time a text was gated (D-283). */
  typedApproved: string[][];
  /** The network job of the last browser opened. */
  job?: Parameters<OpenSession>[2];
  /** Commands of the bar the session got (D-286). */
  history: string[];
}

function harness(options: { gate?: TypedVerdict; failOpen?: boolean; last?: { seq: number; outcome: 'blocked' | 'ok' }; savedIn?: (address: string, approved: ReadonlySet<string>) => readonly string[] } = {}): Harness {
  const page: FakePage = { url: 'https://comune-finto.it/servizi', title: 'Servizi', reading: { title: 'Servizi', url: 'https://comune-finto.it/servizi', text: 'Orari', elements: [], scrolled: 0 }, clicked: [], filled: [], pressed: [], typable: true };
  const clock = { now: 1_000_000 };
  let active: { id: string } | null = null;
  const manager = { get state() { return 'free'; }, get active() { return active; } } as unknown as BrowserManager;
  const h: Harness = { browser: undefined as unknown as AgentBrowser, expire: () => { active = null; }, touches: 0, opened: [], closed: [], scopes: [], taken: [], released: [], typed: [], page, clock, last: options.last, userTouches: 0, access: null, typedApproved: [], history: [] };
  const openSession: OpenSession = (_manager, id, job) => {
    if (options.failOpen) return Promise.reject(new Error('docker'));
    active = { id };
    h.opened.push(id);
    h.job = job;
    const session = {
      // The bar of the screen (D-286): back, forward and reload as recorded; no page ahead for `forward`.
      history: async (command: string) => {
        h.history.push(command);
        // A page that is slow to load holds the command, as `wait` holds a script.
        if (page.wait !== undefined) await page.wait;
        return command === 'forward' ? null : { title: page.title, url: page.url };
      },
      currentUrl: () => page.url,
      network: { rescope: (scope: NetworkScope) => { h.scopes.push(scope); }, lastNavigation: () => (h.last === undefined ? undefined : { ...h.last }), authenticated: () => h.access, settle: () => Promise.resolve() },
      // An address under /rifiutata is refused by the fake network: Chromium's error, as a blocked navigation.
      openPage: (url: string) => (url.includes('/rifiutata') ? Promise.reject(new Error('net::ERR_BLOCKED_BY_CLIENT')) : (page.url = url, Promise.resolve({ title: page.title, url }))),
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
    gateTyped: (text, _scope, approved) => { h.typed.push(text); h.typedApproved.push([...approved]); return Promise.resolve(options.gate ?? true); },
    onTaken: (conversationId) => { h.taken.push(conversationId); },
    onReleased: (conversationId) => { h.released.push(conversationId); },
    now: () => clock.now,
    actionLimitMs: 50,
    openSession,
    ...(options.savedIn === undefined ? {} : { savedIn: options.savedIn }),
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

test('no action starts the second scanner any more: the saved values take its place in the browser (D-283)', async () => {
  const h = harness();
  const started = Date.now();
  assert.equal((await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' })).ok, true);
  assert.ok(Date.now() - started < 1_000);
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
  assert.deepEqual(h.scopes.at(-1), { context: INTERNAL, consent, driver: 'agent', meta: { saved: { approved: new Set() } }, conversationId: 'a' });
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
  // The requests of the user go on with the scope of Arianna, without her task; compared with the saved values all the same (D-283).
  const last = h.scopes.at(-1);
  assert.equal(last?.driver, 'user');
  assert.equal(last.meta?.taskId, undefined);
  assert.ok(last.meta?.saved !== undefined);
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

test('a saved private value in an address or a typed text asks the user, with its references only (D-283)', async () => {
  const h = harness({ gate: { saved: ['client:c1:name'] } });
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  h.page.reading = { title: 'Cerca', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'field', label: 'Cerca', type: 'search' }], scrolled: 0 };
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'type', ref: 1, text: 'Ferramenta Lunardi Srl', submit: false }), { ok: false, reason: 'confirm-private', saved: ['client:c1:name'], site: 'comune-finto.it' });
  assert.deepEqual(h.page.filled, []);
  // A page refused by the network for a saved value: the open asks the user too.
  const blocked = harness();
  blocked.last = { seq: 1, outcome: 'blocked', reason: 'saved-private', saved: ['contact:k1:contact-name'] } as Harness['last'];
  const opening = await blocked.browser.act(scope('a'), { kind: 'open', url: 'https://cerca-finto.it/rifiutata?q=Ottavio+Brenta' });
  // With the site the value would go to, the name only.
  assert.deepEqual(opening, { ok: false, reason: 'confirm-private', saved: ['contact:k1:contact-name'], site: 'cerca-finto.it' });
  // Refused for another reason: no card.
  blocked.last = { seq: 2, outcome: 'blocked' };
  assert.equal((await blocked.browser.act(scope('a'), { kind: 'open', url: 'https://cerca-finto.it/rifiutata' })).ok, false);
  assert.notEqual((await blocked.browser.act(scope('a'), { kind: 'open', url: 'https://cerca-finto.it/rifiutata' }) as { reason: string }).reason, 'confirm-private');
});

test('the values the user let go hold for the browser they were read for, until it closes (D-283)', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  const opened = h.browser.openedAt('a');
  assert.equal(typeof opened, 'number');
  assert.equal(h.browser.openedAt('b'), null);
  h.page.reading = { title: 'Cerca', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'field', label: 'Cerca', type: 'search' }], scrolled: 0 };
  // Approved for an older browser: not merged.
  await h.browser.act({ ...scope('a'), saved: { opened: (opened ?? 0) - 1, approved: new Set(['client:old:name']) } }, { kind: 'read' });
  await h.browser.act({ ...scope('a'), saved: { opened: opened ?? 0, approved: new Set(['client:c1:name']) } }, { kind: 'type', ref: 1, text: 'Ferramenta Lunardi Srl', submit: false });
  assert.deepEqual(h.typedApproved.at(-1), ['client:c1:name']);
  // A later action without the approvals in its scope keeps them: the set belongs to the browser.
  await h.browser.act(scope('a'), { kind: 'type', ref: 1, text: 'orari', submit: false });
  assert.deepEqual(h.typedApproved.at(-1), ['client:c1:name']);
  assert.deepEqual([...(h.scopes.at(-1)?.meta?.saved?.approved ?? [])], ['client:c1:name']);
  // Closed, a new browser starts with none.
  await h.browser.act(scope('a'), { kind: 'close' });
  h.clock.now += 1;
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  await h.browser.act({ ...scope('a'), saved: { opened: opened ?? 0, approved: new Set(['client:c1:name']) } }, { kind: 'type', ref: 1, text: 'orari', submit: false });
  assert.deepEqual(h.typedApproved.at(-1), []);
});

test('released or shut down while an open is under way: no browser stays open behind it, and none opens after a shutdown', async () => {
  for (const stop of ['release', 'close'] as const) {
    const h = harness();
    const opening = h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
    await (stop === 'release' ? h.browser.release('a') : h.browser.close());
    await opening;
    assert.equal(h.browser.holder, null, stop);
    assert.equal(h.opened.length, 1, stop);
    assert.deepEqual(h.closed, h.opened, stop);
  }
  const h = harness();
  await h.browser.close();
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' }), { ok: false, reason: 'not-open' });
  assert.deepEqual(h.opened, []);
});

test('reading a tab with no page (blank, or the error page of a refused open) runs no script and keeps the browser (D-283 trial)', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  for (const url of ['chrome-error://chromewebdata/', 'about:blank']) {
    h.page.url = url;
    // A script there would never answer: the read must not run it.
    h.page.hang = true;
    assert.deepEqual(await h.browser.act(scope('a'), { kind: 'read' }), { ok: false, reason: 'no-page' }, url);
    assert.equal(h.browser.holder, 'a', url);
  }
  h.page.hang = false;
  h.page.url = 'https://comune-finto.it/servizi';
  assert.equal((await h.browser.act(scope('a'), { kind: 'read' })).ok, true);
});

test('the check before the page (D-283): a saved value in the address of open or of a link asks at once, nothing navigates; let go, it opens', async () => {
  const asked: string[][] = [];
  const h = harness({ savedIn: (address, approved) => { asked.push([...approved]); return address.includes('Lunardi') && !approved.has('client:c1:name') ? ['client:c1:name'] : []; } });
  const url = 'https://cerca-finto.it/?q=Ferramenta+Lunardi';
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'open', url }), { ok: false, reason: 'confirm-private', saved: ['client:c1:name'], site: 'cerca-finto.it' });
  assert.notEqual(h.page.url, url);
  // A link with a saved value: the same card, no click.
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  h.page.reading = { title: 'Servizi', url: 'https://comune-finto.it/servizi', text: '', elements: [{ ref: 1, kind: 'link', label: 'Lunardi', href: 'https://comune-finto.it/cerca?q=Lunardi' }], scrolled: 0 };
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'click', ref: 1 }), { ok: false, reason: 'confirm-private', saved: ['client:c1:name'], site: 'comune-finto.it' });
  assert.deepEqual(h.page.clicked, []);
  // Let go for this browser: it opens.
  const opened = h.browser.openedAt('a');
  const done = await h.browser.act({ ...scope('a'), saved: { opened, approved: new Set(['client:c1:name']) } }, { kind: 'open', url });
  assert.equal(done.ok, true);
  assert.deepEqual(asked.at(-1), ['client:c1:name']);
});

test('the check before the page is never made in the Private chat of an access, which the gateway does not compare (D-283 review)', async () => {
  let asked = 0;
  const h = harness({ savedIn: (_address, approved) => { asked += 1; return approved.has('client:c1:name') ? [] : ['client:c1:name']; } });
  // The work conversation, before the access: asked, and refused.
  assert.equal((await h.browser.act(scope('a'), { kind: 'open', url: 'https://biblioteca-finta.it/' })).ok, false);
  const before = asked;
  // Opened from a card, then an access made by the user, then the Private chat.
  await h.browser.act({ ...scope('a'), saved: { opened: null, approved: new Set(['client:c1:name']) } }, { kind: 'open', url: 'https://biblioteca-finta.it/' });
  h.access = 'biblioteca-finta.it';
  assert.equal(await h.browser.handOver('a', 'chat'), 'biblioteca-finta.it');
  const chat: BrowserScope = { conversationId: 'chat', context: createContext('L2', 'L2', { browserSite: 'biblioteca-finta.it' }), consent: { from: 'sites', sites: ['biblioteca-finta.it'] } };
  await h.browser.act(chat, { kind: 'read' });
  const opened = await h.browser.act(chat, { kind: 'open', url: 'https://biblioteca-finta.it/prestiti?nome=Lunardi' });
  assert.notEqual(!opened.ok ? opened.reason : 'ok', 'confirm-private');
  // Asked once more for the open from the card (once for a new browser), never in the chat.
  assert.equal(asked, before + 1);
});

test('a check before the page that throws: only the kind of the error is written, and the network decides the page (D-283 review)', async () => {
  let calls = 0;
  const h = harness({ savedIn: () => { calls += 1; throw new TypeError('not loaded'); } });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { warnings.push(line); };
  try {
    const opened = await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi?q=Lunardi' });
    assert.equal(opened.ok, true);
  } finally {
    console.warn = warn;
  }
  // Once for a new browser, before it starts.
  assert.equal(calls, 1);
  assert.deepEqual(warnings, ['browser: the check of saved values before a page failed (TypeError)']);
});

test('the check before the page: a card starts no browser, and a busy browser answers busy before any check (D-283 review)', async () => {
  let calls = 0;
  const h = harness({ savedIn: () => { calls += 1; return ['client:c1:name']; } });
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi' }), { ok: false, reason: 'confirm-private', saved: ['client:c1:name'], site: 'cerca-finto.it' });
  // No container asked, the manager free.
  assert.deepEqual(h.opened, []);
  assert.equal(h.browser.holder, null);
  // Another conversation holds the browser, in use: «occupato», and nothing checked nor taken.
  const busy = harness({ savedIn: (_address, approved) => { calls += 1; return approved.has('client:c1:name') ? [] : ['client:c1:name']; } });
  await busy.browser.act({ ...scope('b'), saved: { opened: null, approved: new Set(['client:c1:name']) } }, { kind: 'open', url: 'https://comune-finto.it/servizi' });
  const before = calls;
  assert.deepEqual(await busy.browser.act(scope('a'), { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi' }), { ok: false, reason: 'busy' });
  assert.equal(calls, before);
  assert.equal(busy.browser.holder, 'b');
});

test('the bar of the screen (D-286): back, forward, reload and an address as the user\'s, in the queue; Arianna reads the page again after', async () => {
  const h = harness({ savedIn: (address, approved) => (address.includes('Lunardi') && !approved.has('client:c1:name') ? ['client:c1:name'] : []) });
  assert.deepEqual(await h.browser.userCommand('a', { kind: 'back' }), { ok: false, reason: 'not-open' });
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  await h.browser.act(scope('a'), { kind: 'read' });
  assert.equal(h.browser.urlOf('a'), 'https://comune-finto.it/servizi');
  assert.equal(h.browser.urlOf('b'), null);
  const back = await h.browser.userCommand('a', { kind: 'back' });
  assert.equal(back.ok, true);
  assert.deepEqual(await h.browser.userCommand('a', { kind: 'forward' }), { ok: false, reason: 'no-page' });
  assert.equal((await h.browser.userCommand('a', { kind: 'reload' })).ok, true);
  assert.deepEqual(h.history, ['back', 'forward', 'reload']);
  // While the command ran the network decided as for the user; then Arianna again, who reads the page first.
  assert.ok(h.scopes.some((next) => next.driver === 'user'));
  assert.equal(h.scopes.at(-1)?.driver, 'agent');
  assert.deepEqual(await h.browser.act(scope('a'), { kind: 'click', ref: 1 }), { ok: false, reason: 'reread' });
  // An address written in the bar: a saved value asks first, «Apri» lets it go for this browser.
  const asked = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi' });
  assert.ok(!asked.ok && asked.reason === 'confirm-private');
  assert.deepEqual(asked.saved, ['client:c1:name']);
  assert.equal(asked.site, 'cerca-finto.it');
  assert.match(asked.ask ?? '', /^[0-9a-f]{32}$/);
  // «Apri» only with the token of the question asked for that address: another token, or another address, asks again.
  const forged = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi', ask: 'f'.repeat(32) });
  assert.equal(!forged.ok && forged.reason, 'confirm-private');
  const fresh = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi' });
  const other = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi+bis', ...(!fresh.ok && fresh.reason === 'confirm-private' && fresh.ask !== undefined ? { ask: fresh.ask } : {}) });
  assert.equal(!other.ok && other.reason, 'confirm-private');
  const again = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi' });
  const opened = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi', ...(!again.ok && again.reason === 'confirm-private' && again.ask !== undefined ? { ask: again.ask } : {}) });
  assert.equal(opened.ok, true);
  assert.deepEqual([...(h.scopes.at(-1)?.meta?.saved?.approved ?? [])], ['client:c1:name']);
  // A public consent covers every site already: nothing to note.
  assert.deepEqual(h.browser.userAddressesOf('a'), []);
  // An Internal conversation: the address written in the bar, on a new site, noted as its site.
  const internal = { conversationId: 'a', context: INTERNAL, consent: { from: 'user' as const, addresses: ['https://comune-finto.it/servizi'] } };
  await h.browser.act(internal, { kind: 'read' });
  assert.equal((await h.browser.userCommand('a', { kind: 'open', url: 'https://nuovo-finto.it/pagina' })).ok, true);
  assert.deepEqual(h.browser.userAddressesOf('a'), ['https://nuovo-finto.it/']);
  // A page on a site the conversation already covers: no note.
  assert.equal((await h.browser.userCommand('a', { kind: 'open', url: 'https://comune-finto.it/altra' })).ok, true);
  assert.deepEqual(h.browser.userAddressesOf('a'), ['https://nuovo-finto.it/']);
  // A token is used once.
  const reused = await h.browser.userCommand('a', { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi', ...(!again.ok && again.reason === 'confirm-private' && again.ask !== undefined ? { ask: again.ask } : {}) });
  assert.equal(reused.ok, true, 'let go for this browser: no question any more');
  // Not an address: nothing opens.
  assert.deepEqual(await h.browser.userCommand('a', { kind: 'open', url: 'javascript:alert(1)' }), { ok: false, reason: 'navigation-failed' });
});

test('the bar is off during an action of Arianna (D-286)', async () => {
  let release: () => void = () => undefined;
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  h.page.wait = new Promise<void>((resolve) => { release = resolve; });
  const reading = h.browser.act(scope('a'), { kind: 'read' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.browser.actingFor('a'), true);
  assert.deepEqual(await h.browser.userCommand('a', { kind: 'reload' }), { ok: false, reason: 'agent-busy' });
  release();
  await reading;
  assert.equal(h.browser.actingFor('a'), false);
  assert.deepEqual(h.history, []);
});

test('the pages the user opens while driving are the conversation\'s for Arianna too (D-286)', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  assert.deepEqual(h.browser.userAddressesOf('a'), []);
  // Noted as sites, for the conversation of the scope that navigated (never the one holding the browser later).
  h.job?.onUserAddress?.('https://altro-finto.it/pagina', 'a');
  h.job?.onUserAddress?.('https://terzo-finto.it/x', 'a');
  h.job?.onUserAddress?.('https://altro-finto.it/altra', 'a');
  h.job?.onUserAddress?.('https://quarto-finto.it/', 'b');
  assert.deepEqual(h.browser.userAddressesOf('a'), ['https://altro-finto.it/', 'https://terzo-finto.it/']);
  assert.deepEqual(h.browser.userAddressesOf('b'), ['https://quarto-finto.it/']);
  // The conversation becomes private or is deleted: its pages go.
  await h.browser.release('a');
  assert.deepEqual(h.browser.userAddressesOf('a'), []);
});

test('a click or a key of the user chooses one navigation, within a short time; the bar and Arianna never (D-286)', async () => {
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  // Arianna drives: no gesture to take.
  assert.equal(h.scopes.at(-1)?.takeGesture, undefined);
  await h.browser.takeControl('a').done;
  const user = h.scopes.at(-1);
  assert.equal(user?.driver, 'user');
  assert.equal(user.conversationId, 'a');
  const take = user.takeGesture;
  assert.ok(take !== undefined);
  // Taking the control is no click on a page: nothing to take yet.
  assert.equal(take(), false);
  h.browser.userGesture('a');
  assert.equal(take(), true);
  // Taken once: a meta refresh or a script after it has none.
  assert.equal(take(), false);
  h.browser.userGesture('a');
  h.clock.now += 2_000;
  assert.equal(take(), false, 'too late');
  // Another conversation's gesture: nothing.
  h.browser.userGesture('b');
  assert.equal(take(), false);
  // A command of the bar: as the user's, without a gesture.
  h.browser.userGesture('a');
  await h.browser.userCommand('a', { kind: 'reload' });
  const during = h.scopes.filter((next) => next.driver === 'user').at(-2);
  assert.equal(during?.takeGesture, undefined);
});

test('the bar of the user does not say Arianna is acting; nothing after a shutdown (D-286)', async () => {
  let release: () => void = () => undefined;
  const h = harness();
  await h.browser.act(scope('a'), { kind: 'open', url: 'https://comune-finto.it/servizi' });
  h.page.wait = new Promise<void>((resolve) => { release = resolve; });
  // The fake history waits for the page script: a command under way.
  const realHistory = h.history;
  const pending = h.browser.userCommand('a', { kind: 'reload' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.browser.actingFor('a'), false);
  release();
  await pending;
  assert.equal(realHistory.length, 1);
  await h.browser.close();
  assert.deepEqual(await h.browser.userCommand('a', { kind: 'reload' }), { ok: false, reason: 'not-open' });
});

test('a free browser of another conversation and a saved value: the card, and the browser is neither closed nor taken (D-283 review)', async () => {
  const h = harness({ savedIn: (_address, approved) => (approved.has('client:c1:name') ? [] : ['client:c1:name']) });
  await h.browser.act({ ...scope('b'), saved: { opened: null, approved: new Set(['client:c1:name']) } }, { kind: 'open', url: 'https://comune-finto.it/servizi' });
  // Unused for long enough to be taken.
  h.clock.now += TAKE_OVER_MS * 2;
  const asked = await h.browser.act(scope('a'), { kind: 'open', url: 'https://cerca-finto.it/?q=Lunardi' });
  assert.equal(!asked.ok && asked.reason, 'confirm-private');
  assert.deepEqual(h.closed, []);
  assert.deepEqual(h.taken, []);
  assert.equal(h.browser.holder, 'b');
});
