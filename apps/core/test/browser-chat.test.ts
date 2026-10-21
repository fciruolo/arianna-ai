import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext, type Context, type PageConsent } from '@arianna/policy';
import type { Page } from 'playwright-core';

import { AgentBrowser, openFailureKind, outsideAccess, READ_SCRIPT, type BrowserScope, type OpenSession, type PageElement } from '../src/browser/agent-browser.ts';
import { afterControl, browserChatLine, browserChatTitle, HANDOFF_LINE } from '../src/browser/handoff.ts';
import type { Sql } from '../src/db/client.ts';
import type { BrowserManager } from '../src/browser/manager.ts';
import type { NetworkScope } from '../src/browser/network.ts';
import type { BrowserSession } from '../src/browser/session.ts';

// D-281: the browser with an access made by the user passes to a Private chat born for it.
const SITE = 'biblioteca-finta.it';
const PUBLIC = createContext('L1', 'L0');
const CHAT = createContext('L2', 'L2', { browserSite: SITE });
const PRIVATE = createContext('L2', 'L2');

interface Harness {
  browser: AgentBrowser;
  scopes: NetworkScope[];
  released: string[];
  closed: string[];
  access: string | null;
  /** A click on the page sends to the site (a form, a POST of a script): held unless the scope may send. */
  clickSends: boolean;
  held: number;
  sent: number;
  page: { url: string; elements: PageElement[] };
}

function harness(): Harness {
  let active: { id: string } | null = null;
  const manager = { get state() { return 'free'; }, get active() { return active; } } as unknown as BrowserManager;
  const h: Harness = { browser: undefined as unknown as AgentBrowser, scopes: [], released: [], closed: [], access: null, clickSends: false, held: 0, sent: 0, page: { url: 'https://www.biblioteca-finta.it/prestiti', elements: [] } };
  const page = (): Page =>
    ({
      url: () => h.page.url,
      title: () => Promise.resolve('Prestiti'),
      evaluate: (script: unknown) => Promise.resolve(script === READ_SCRIPT ? { title: 'Prestiti', url: h.page.url, text: 'Tre prestiti', elements: h.page.elements, scrolled: 0 } : undefined),
      locator: () => ({
        first: () => ({
          click: () => {
            if (h.clickSends) {
              if (h.scopes.at(-1)?.send === true) h.sent += 1;
              else h.held += 1;
            }
            return Promise.resolve();
          },
          fill: () => Promise.resolve(),
          press: () => Promise.resolve(),
          evaluate: () => Promise.resolve(true),
        }),
      }),
      mainFrame: () => ({}),
      waitForEvent: () => Promise.reject(new Error('no navigation')),
      waitForLoadState: () => Promise.resolve(),
    }) as unknown as Page;
  const openSession: OpenSession = (_manager, id) => {
    active = { id };
    return Promise.resolve({
      network: {
        rescope: (next: NetworkScope) => { h.scopes.push(next); },
        lastNavigation: () => undefined,
        authenticated: () => h.access,
        heldSends: () => h.held,
        settle: () => Promise.resolve(),
      },
      openPage: (url: string) => { h.page.url = url; return Promise.resolve({ title: 'Prestiti', url }); },
      currentPage: () => Promise.resolve(page()),
      touch: () => undefined,
      close: () => { h.closed.push(id); active = null; return Promise.resolve(); },
    } as unknown as BrowserSession);
  };
  h.browser = new AgentBrowser({
    sql: undefined as unknown as Sql,
    manager,
    session: { home: '/nowhere' },
    gateTyped: () => Promise.resolve(true),
    onReleased: (conversationId) => { h.released.push(conversationId); },
    actionLimitMs: 200,
    openSession,
  });
  return h;
}

type Permit = { id: string; element: string };
const scope = (conversationId: string, context: Context = PUBLIC, consent: PageConsent = { from: 'public' }, sendPermit?: Permit): BrowserScope => ({
  conversationId,
  context,
  consent,
  ...(sendPermit === undefined ? {} : { sendPermit }),
});
const chat = (sendPermit?: Permit): BrowserScope => scope('chat', CHAT, { from: 'sites', sites: [SITE] }, sendPermit);

/** A browser of the work conversation `work` with an access to SITE, given back by the user. */
async function accessed(): Promise<Harness> {
  const h = harness();
  await h.browser.act(scope('work'), { kind: 'open', url: 'https://www.biblioteca-finta.it/accedi' });
  await h.browser.takeControl('work').done;
  h.access = SITE;
  h.browser.returnControl('work');
  return h;
}

test('handOver: the browser of the access passes to the chat with its context and the consent of the site; the screens of the work conversation close', async () => {
  const h = await accessed();
  assert.equal(await h.browser.handOver('work', 'chat'), SITE);
  assert.equal(h.browser.holder, 'chat');
  assert.equal(h.browser.accessOf('chat'), SITE);
  assert.equal(h.browser.movedFrom('work'), 'chat');
  assert.equal(h.browser.movedFrom('chat'), null);
  assert.deepEqual(h.released, ['work']);
  const last = h.scopes.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.context.browserSite, SITE);
  assert.deepEqual(last.consent, { from: 'sites', sites: [SITE] });
  assert.equal(last.driver, 'agent');
  // The first action reads the page.
  assert.deepEqual(await h.browser.act(chat(), { kind: 'scroll', direction: 'down' }), { ok: false, reason: 'reread' });
  const read = await h.browser.act(chat(), { kind: 'read' });
  assert.ok(read.ok && read.reading?.text === 'Tre prestiti');
});

test('handOver: nothing without an access, while the user drives, or twice', async () => {
  const h = harness();
  await h.browser.act(scope('work'), { kind: 'open', url: 'https://www.biblioteca-finta.it/accedi' });
  assert.equal(await h.browser.handOver('work', 'chat'), null);
  h.access = SITE;
  await h.browser.takeControl('work').done;
  assert.equal(await h.browser.handOver('work', 'chat'), null);
  h.browser.returnControl('work');
  assert.equal(await h.browser.handOver('other', 'chat'), null);
  assert.equal(await h.browser.handOver('work', 'chat'), SITE);
  assert.equal(await h.browser.handOver('chat', 'chat-2'), null);
  assert.equal(h.browser.holder, 'chat');
});

test('after the hand over the work conversation has no browser, and cannot take the one of the access', async () => {
  const h = await accessed();
  await h.browser.handOver('work', 'chat');
  assert.deepEqual(await h.browser.act(scope('work'), { kind: 'read' }), { ok: false, reason: 'not-open' });
  // Never taken over, however long it stays without actions: closing it would lose the access.
  assert.deepEqual(await h.browser.act(scope('work'), { kind: 'open', url: 'https://example.org/' }), { ok: false, reason: 'busy' });
  assert.equal(h.browser.holder, 'chat');
});

test('the chat acts only on the browser of its access; a private chat without the mark never does', async () => {
  const h = await accessed();
  await h.browser.handOver('work', 'chat');
  assert.deepEqual(await h.browser.act(scope('chat', PRIVATE, { from: 'sites', sites: [SITE] }), { kind: 'read' }), { ok: false, reason: 'authenticated' });
  const other = createContext('L2', 'L2', { browserSite: 'altro-sito-finto.it' });
  assert.deepEqual(await h.browser.act(scope('chat', other, { from: 'sites', sites: [SITE] }), { kind: 'read' }), { ok: false, reason: 'not-open' });
  // A chat of an access opens no browser of its own.
  const g = harness();
  assert.deepEqual(await g.browser.act(chat(), { kind: 'open', url: 'https://www.biblioteca-finta.it/' }), { ok: false, reason: 'not-open' });
});

test('the chat stays on the site of the access: open and links elsewhere are refused', async () => {
  const h = await accessed();
  await h.browser.handOver('work', 'chat');
  await h.browser.act(chat(), { kind: 'read' });
  assert.deepEqual(await h.browser.act(chat(), { kind: 'open', url: 'https://tracker-finto.net/' }), { ok: false, reason: 'outside-access', site: SITE });
  assert.deepEqual(await h.browser.act(chat(), { kind: 'open', url: 'http://www.biblioteca-finta.it/' }), { ok: false, reason: 'outside-access', site: SITE });
  assert.equal((await h.browser.act(chat(), { kind: 'open', url: 'https://catalogo.biblioteca-finta.it/' })).ok, true);
});

test('openFailureKind: the kind of a failed open for the log, never the address', () => {
  assert.equal(openFailureKind(new Error('page.goto: net::ERR_ABORTED at https://www.biblioteca-finta.it/prestiti?u=7')), 'net::ERR_ABORTED');
  assert.equal(openFailureKind(new Error('page.goto: Navigation to "https://x.it/" is interrupted by another navigation to "https://x.it/a"')), 'interrupted by another navigation');
  assert.equal(openFailureKind(new Error('page.goto: Timeout 15000ms exceeded.')), 'timeout');
  assert.equal(openFailureKind(new TypeError('https://www.biblioteca-finta.it/segreto')), 'TypeError');
  assert.equal(openFailureKind('boom'), 'string');
});

test('outsideAccess: https on the site or a subdomain only; links that are not pages stay', () => {
  const links = new Map<number, PageElement>([
    [1, { ref: 1, kind: 'link', label: 'Prestiti', href: 'https://www.biblioteca-finta.it/prestiti' }],
    [2, { ref: 2, kind: 'link', label: 'Fuori', href: 'https://biblioteca-finta.it.raccolta-finta.net/' }],
    [3, { ref: 3, kind: 'link', label: 'Ancora', href: 'javascript:void(0)' }],
    [4, { ref: 4, kind: 'button', label: 'Rinnova' }],
  ]);
  assert.equal(outsideAccess(SITE, { kind: 'click', ref: 1 }, links), false);
  assert.equal(outsideAccess(SITE, { kind: 'click', ref: 2 }, links), true);
  assert.equal(outsideAccess(SITE, { kind: 'click', ref: 3 }, links), false);
  assert.equal(outsideAccess(SITE, { kind: 'click', ref: 4 }, links), false);
  assert.equal(outsideAccess(SITE, { kind: 'open', url: 'https://notbiblioteca-finta.it/' }, links), true);
  assert.equal(outsideAccess(SITE, { kind: 'open', url: 'not an address' }, links), true);
  assert.equal(outsideAccess(SITE, { kind: 'read' }, links), false);
});

test('a send to the site asks the user; the click after «Invia» sends once', async () => {
  const h = await accessed();
  await h.browser.handOver('work', 'chat');
  h.page.elements = [{ ref: 1, kind: 'button', label: 'Rinnova' }];
  await h.browser.act(chat(), { kind: 'read' });
  h.clickSends = true;
  assert.deepEqual(await h.browser.act(chat(), { kind: 'click', ref: 1 }), { ok: false, reason: 'confirm-send', site: SITE, element: 'Rinnova' });
  assert.equal(h.sent, 0);
  // Approved for «Rinnova»: a click on another element does not send with it.
  const permit = { id: 'approval-1', element: 'Rinnova' };
  h.page.elements = [{ ref: 1, kind: 'button', label: 'Elimina' }, { ref: 2, kind: 'button', label: 'Rinnova' }];
  await h.browser.act(chat(permit), { kind: 'read' });
  assert.deepEqual(await h.browser.act(chat(permit), { kind: 'click', ref: 1 }), { ok: false, reason: 'confirm-send', site: SITE, element: 'Elimina' });
  assert.equal(h.sent, 0);
  // The approved element: it sends, and the network goes back to holding after it.
  assert.equal((await h.browser.act(chat(permit), { kind: 'click', ref: 2 })).ok, true);
  assert.equal(h.sent, 1);
  assert.notEqual(h.scopes.at(-1)?.send, true);
  // The same approval does not send twice.
  assert.equal((await h.browser.act(chat(permit), { kind: 'click', ref: 2 })).ok, false);
  assert.equal(h.sent, 1);
  // A click that sends nothing needs no approval.
  h.clickSends = false;
  assert.equal((await h.browser.act(chat(), { kind: 'click', ref: 1 })).ok, true);
});

test('the user drives in the chat too: Arianna pauses, given back she reads again', async () => {
  const h = await accessed();
  await h.browser.handOver('work', 'chat');
  assert.equal(await h.browser.takeControl('chat').done, true);
  assert.deepEqual(await h.browser.act(chat(), { kind: 'read' }), { ok: false, reason: 'paused' });
  // The requests of the user keep the context of the chat: forms to the site go.
  assert.equal(h.scopes.at(-1)?.driver, 'user');
  assert.equal(h.scopes.at(-1)?.context.browserSite, SITE);
  assert.equal(h.browser.returnControl('chat'), true);
  assert.deepEqual(await h.browser.act(chat(), { kind: 'click', ref: 1 }), { ok: false, reason: 'reread' });
});

test('handoff texts: the line of the work conversation never names the site; the chat line and title do', () => {
  assert.doesNotMatch(HANDOFF_LINE, /biblioteca/);
  assert.match(HANDOFF_LINE, /chat Privata/);
  assert.match(browserChatLine(SITE), new RegExp(SITE.replace('.', '\\.')));
  assert.match(browserChatLine(SITE), /Invia \/ No/);
  assert.equal(browserChatTitle(SITE), `${SITE} · accesso`);
});

test('afterControl: given back in the chat of an access, no new chat is opened', async () => {
  const calls: string[] = [];
  const sql = (() => {
    calls.push('sql');
    return Promise.resolve([]);
  }) as unknown as Sql;
  await afterControl(
    { sql, browser: { accessOf: () => SITE, handOver: () => { calls.push('handOver'); return Promise.resolve(SITE); }, release: () => Promise.resolve() }, kind: () => Promise.resolve('browser') },
    'chat',
    { state: 'returned', reason: 'user' },
  );
  assert.equal(calls.includes('handOver'), false);
});
