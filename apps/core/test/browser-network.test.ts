// The network of the agent's browser (D-264, passo 2): every request of
// Chromium decided in the core, with a fake Playwright context, a fake
// network and the real gateway on a fake log. No Docker, no network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createContext, piiReport, type PageConsent } from '@arianna/policy';
import type { BrowserContext, Route } from 'playwright-core';

import type { Sql } from '../src/db/client.ts';
import type { NewEvent } from '../src/events.ts';
import { attachNetwork, BrowserBudget, movePage, navigationConsent, resourceTypeOf, withWritten, type NetworkJob } from '../src/browser/network.ts';
import type { ResourceInput, ResourceResult } from '../src/browser/resource-fetch.ts';
import { configurePiiGuard } from '../src/pii-guard.ts';

/** What the fake second scanner finds: nothing, or a person in every text. */
let rizzoFinds = false;
configurePiiGuard({
  state: 'ready', warm: () => Promise.resolve(true),
  scan: (texts) => Promise.resolve(piiReport(texts, texts.map((text) => (rizzoFinds && text.length > 4 ? [{ kind: 'FULLNAME', start: 0, end: 4, score: 0.99 }] : [])))),
  stop: () => Promise.resolve(),
});

function fakeSql(rows: unknown[][]): Sql {
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    rows.push(values);
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

interface FakeRequestSpec {
  url: string;
  method?: string;
  type?: string;
  /** A navigation of the main frame (true), of an iframe (false), or no navigation (undefined). */
  main?: boolean;
  headers?: Record<string, string>;
  body?: Buffer;
  redirects?: number;
  /** The frame object of the request (its identity), and the sandbox attribute of an iframe. */
  frame?: object;
  sandbox?: string;
  /** Playwright does not know the frame yet (a popup being created): frame() throws. */
  unknownFrame?: boolean;
  /** The address of the page of the frame before the navigation (a form is sent from it). */
  pageUrl?: string;
  /** allHeaders of Playwright never answers (an event of Chromium that does not come). */
  hangHeaders?: boolean;
}

interface Outcome {
  fulfilled?: { status: number; headers: Record<string, string>; body: Buffer };
  aborted?: string;
}

function fakeRequest(spec: FakeRequestSpec): unknown {
  const chain = (left: number): unknown => (left === 0 ? null : { redirectedFrom: () => chain(left - 1) });
  return {
    url: () => spec.url,
    method: () => spec.method ?? 'GET',
    resourceType: () => spec.type ?? (spec.main === undefined ? 'image' : 'document'),
    isNavigationRequest: () => spec.main !== undefined,
    frame: () => {
      if (spec.unknownFrame === true) throw new Error('frame not created yet');
      return spec.frame ?? {
      url: () => spec.pageUrl ?? 'about:blank',
      parentFrame: () => (spec.main === true ? null : {}),
      frameElement: () => Promise.resolve({ getAttribute: () => Promise.resolve(spec.sandbox ?? null), dispose: () => Promise.resolve() }),
      };
    },
    redirectedFrom: () => chain(spec.redirects ?? 0),
    headers: () => spec.headers ?? {},
    allHeaders: () => (spec.hangHeaders === true ? new Promise(() => undefined) : Promise.resolve(spec.headers ?? {})),
    postDataBuffer: () => spec.body ?? null,
  };
}

interface Harness {
  send(spec: FakeRequestSpec): Promise<Outcome>;
  rows: unknown[][];
  events: NewEvent[];
  fetched: ResourceInput[];
  close(): Promise<void>;
  handle: Awaited<ReturnType<typeof attachNetwork>>;
}

type Answer = (input: ResourceInput) => ResourceResult;

const okImage: Answer = () => ({ ok: true, status: 200, headers: [['content-type', 'image/png']], body: Buffer.from('png') });

async function harness(options: { consent?: PageConsent; level?: 'L0' | 'L1'; answer?: Answer; budget?: BrowserBudget; debug?: (line: string) => void; hang?: boolean; delayMs?: number; isRetired?: (page: unknown) => boolean; isAgentTab?: (page: unknown) => boolean; onUserAddress?: (address: string, conversationId: string | undefined) => void } = {}): Promise<Harness> {
  const rows: unknown[][] = [];
  const events: NewEvent[] = [];
  const fetched: ResourceInput[] = [];
  let handler: ((route: Route) => Promise<void> | void) | undefined;
  const context = {
    route: (_pattern: string, callback: (route: Route) => Promise<void>) => {
      handler = callback;
      return Promise.resolve();
    },
    unrouteAll: () => Promise.resolve(),
  } as unknown as BrowserContext;
  const answer = options.answer ?? okImage;
  const job: NetworkJob = {
    sql: fakeSql(rows),
    context: options.level === 'L1' ? createContext('L1', 'L1') : createContext('L1', 'L0'),
    consent: options.consent ?? { from: 'public' },
    userAgent: 'Mozilla/5.0 Chrome/155.0.0.0',
    onEvent: (event) => events.push(event),
    fetchResource: (input) => {
      fetched.push(input);
      // A download that never ends (seen in the trial of D-281): only the deadline of the request answers it.
      if (options.hang === true) return new Promise(() => undefined);
      const delay = options.delayMs;
      return delay === undefined ? Promise.resolve(answer(input)) : new Promise((resolve) => { setTimeout(() => { resolve(answer(input)); }, delay); });
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
    ...(options.isRetired === undefined ? {} : { isRetired: options.isRetired }),
    ...(options.isAgentTab === undefined ? {} : { isAgentTab: options.isAgentTab }),
    ...(options.onUserAddress === undefined ? {} : { onUserAddress: options.onUserAddress }),
    headersTimeoutMs: 50,
    hopTimeoutMs: 100,
    unsafeTestAddresses: [],
  };
  const handle = await attachNetwork(context, job);
  return {
    rows,
    events,
    fetched,
    handle,
    close: () => handle.close(),
    async send(spec) {
      const outcome: Outcome = {};
      const route = {
        request: () => fakeRequest(spec),
        fulfill: (response: { status: number; headers: Record<string, string>; body: Buffer }) => {
          outcome.fulfilled = response;
          return Promise.resolve();
        },
        abort: (code: string) => {
          outcome.aborted = code;
          return Promise.resolve();
        },
      } as unknown as Route;
      assert.ok(handler);
      await handler(route);
      return outcome;
    },
  };
}

/** target and rule of each gateway_log row. */
const logged = (rows: unknown[][]) => rows.map((values) => [values[3], values[7]]);

describe('attachNetwork', () => {
  /** A user driving with gestures handed one at a time, as the filter of the screen gives them. */
  const userWith = (net: Harness, consent: PageConsent, gestures: { left: number }) => {
    net.handle.rescope({
      context: createContext('L1', 'L1'),
      consent,
      driver: 'user',
      conversationId: 'conv-a',
      takeGesture: () => {
        if (gestures.left === 0) return false;
        gestures.left -= 1;
        return true;
      },
    });
  };
  const html: Answer = () => ({ ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>pagina</p>') });

  it('a page the user clicks while driving opens on a new site, and its site becomes the conversation\'s (D-286)', async () => {
    const noted: [string, string | undefined][] = [];
    const consent: PageConsent = { from: 'user', addresses: ['https://example.com/catalogo'] };
    const net = await harness({ consent, level: 'L1', answer: html, onUserAddress: (address, conversation) => noted.push([address, conversation]) });
    // Arianna driving: another site stays refused ("clic solo nello stesso sito").
    assert.equal((await net.send({ url: 'https://altro.example.net/pagina', main: true })).aborted, 'blockedbyclient');
    const gestures = { left: 1 };
    userWith(net, consent, gestures);
    // A page of a site already covered takes no gesture and notes nothing.
    assert.ok((await net.send({ url: 'https://example.com/altra', main: true })).fulfilled !== undefined);
    assert.equal(gestures.left, 1);
    // The click of the user: the new site opens, noted as a site for the conversation of the scope.
    const opened = await net.send({ url: 'https://altro.example.net/pagina#sezione', main: true });
    assert.ok(opened.fulfilled !== undefined);
    assert.deepEqual(noted, [['https://altro.example.net/', 'conv-a']]);
    assert.equal(net.handle.lastNavigation()?.outcome, 'ok');
    await net.close();
  });

  it('without a gesture of the user a navigation to a new site stays refused and is not noted: a script, a meta refresh, a command of the bar (D-286)', async () => {
    const noted: string[] = [];
    const consent: PageConsent = { from: 'user', addresses: ['https://example.com/catalogo'] };
    const net = await harness({ consent, level: 'L1', answer: html, onUserAddress: (address) => noted.push(address) });
    // A script or a timer of the page: driver user, no gesture left.
    userWith(net, consent, { left: 0 });
    assert.equal((await net.send({ url: 'https://altro.example.net/pagina', main: true })).aborted, 'blockedbyclient');
    // One click, then the meta refresh of the page it opened: the second has no gesture.
    userWith(net, consent, { left: 1 });
    assert.ok((await net.send({ url: 'https://altro.example.net/pagina', main: true })).fulfilled !== undefined);
    assert.equal((await net.send({ url: 'https://terzo.example.org/', main: true })).aborted, 'blockedbyclient');
    // A command of the bar (Ricarica, Indietro): the user's scope without gestures at all.
    net.handle.rescope({ context: createContext('L1', 'L1'), consent, driver: 'user' });
    assert.equal((await net.send({ url: 'https://quarto.example.org/', main: true })).aborted, 'blockedbyclient');
    assert.deepEqual(noted, ['https://altro.example.net/']);
    await net.close();
  });

  it('a click of the user: its redirect to another site, an iframe, the scanner, an origin tab and a refused page note nothing new (D-286)', async () => {
    const noted: string[] = [];
    const consent: PageConsent = { from: 'user', addresses: ['https://example.com/catalogo'] };
    const answer: Answer = (input) => (input.url.includes('salto')
      ? { ok: true, status: 302, headers: [['location', 'https://terzo.example.org/altro']], body: Buffer.alloc(0), location: 'https://terzo.example.org/altro' }
      : { ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>pagina</p>') });
    const agent = { name: 'agent' };
    const origin = { name: 'origin' };
    const net = await harness({ consent, level: 'L1', answer, onUserAddress: (address) => noted.push(address), isAgentTab: (page) => page === agent });
    const frameOf = (page: object) => ({ url: () => 'about:blank', parentFrame: () => null, page: () => page });
    userWith(net, consent, { left: 10 });
    // Its redirect to another site is not the user's choice: refused, and nothing noted.
    assert.equal((await net.send({ url: 'https://altro.example.net/salto', main: true, frame: frameOf(agent) })).aborted, 'blockedbyclient');
    // The scanner refuses what it always refused.
    assert.equal((await net.send({ url: 'https://altro.example.net/?iban=IT60X0542811101000000123456', main: true, frame: frameOf(agent) })).aborted, 'blockedbyclient');
    // The tab a popup came from is not the agent's: no choice of the user there.
    assert.equal((await net.send({ url: 'https://quinto.example.org/', main: true, frame: frameOf(origin) })).aborted, 'blockedbyclient');
    // An iframe of another site follows the rules of before.
    assert.equal((await net.send({ url: 'https://quarto.example.org/embed', main: false, type: 'document', frame: { ...frameOf(agent), parentFrame: () => ({}) } })).aborted, 'blockedbyclient');
    assert.deepEqual(noted, []);
    await net.close();
  });

  it('withWritten: a `user` consent takes the address, `sites` (the Private chat of an access) and `public` stay as they are (D-286)', () => {
    assert.deepEqual(withWritten({ from: 'user', addresses: ['https://a.example.org/'] }, 'https://b.example.org/x'), { from: 'user', addresses: ['https://b.example.org/x', 'https://a.example.org/'] });
    assert.deepEqual(withWritten({ from: 'sites', sites: ['banca-finta.it'] }, 'https://b.example.org/x'), { from: 'sites', sites: ['banca-finta.it'] });
    assert.deepEqual(withWritten({ from: 'public' }, 'https://b.example.org/x'), { from: 'public' });
    assert.deepEqual(withWritten({ from: 'user', addresses: ['https://a.example.org/'] }, undefined), { from: 'user', addresses: ['https://a.example.org/'] });
  });

  it('the navigations of a tab that is not the agent\'s now (the origin of a popup) are not its navigation; the agent\'s are (D-283 review)', async () => {
    const agent = { name: 'agent' };
    const origin = { name: 'origin' };
    const net = await harness({ isAgentTab: (page) => page === agent, isRetired: () => false });
    const frameOf = (page: object) => ({ url: () => 'about:blank', parentFrame: () => null, page: () => page });
    const other = await net.send({ url: 'https://example.com/accesso', main: true, frame: frameOf(origin) });
    assert.ok(other.fulfilled !== undefined);
    assert.equal(net.handle.lastNavigation(), undefined);
    // Not left: the answer is given. The agent's tab: its navigation counts.
    const own = await net.send({ url: 'https://example.com/pagina', main: true, frame: frameOf(agent) });
    assert.ok(own.fulfilled !== undefined);
    assert.equal(net.handle.lastNavigation()?.outcome, 'ok');
    await net.close();
  });

  it('refuses every request of a tab the agent left, before the gateway, and never takes its navigation as the agent\'s (D-283 review)', async () => {
    const left = { name: 'left' };
    const kept = { name: 'kept' };
    const net = await harness({ isRetired: (page) => page === left });
    const frameOf = (page: object) => ({ url: () => 'about:blank', parentFrame: () => null, page: () => page });
    const refused = await net.send({ url: 'https://example.com/pagina', main: true, frame: frameOf(left) });
    assert.equal(refused.aborted, 'blockedbyclient');
    const image = await net.send({ url: 'https://example.com/logo.png', frame: { ...frameOf(left), parentFrame: () => ({}) } });
    assert.equal(image.aborted, 'blockedbyclient');
    assert.deepEqual([net.rows, net.fetched], [[], []]);
    assert.equal(net.handle.lastNavigation(), undefined);
    // The tab of the agent goes on as before.
    const page = await net.send({ url: 'https://example.com/pagina', main: true, frame: frameOf(kept) });
    assert.ok(page.fulfilled !== undefined);
    assert.equal(net.handle.lastNavigation()?.outcome, 'ok');
    await net.close();
  });

  it('a tab left while its request was decided gets no answer, and its page is not the agent\'s navigation (D-283 review)', async () => {
    const tab = { name: 'tab' };
    let left = false;
    const net = await harness({ isRetired: (page) => left && page === tab, delayMs: 30 });
    const frame = { url: () => 'about:blank', parentFrame: () => null, page: () => tab };
    const sending = net.send({ url: 'https://example.com/pagina', main: true, frame });
    // Left during the download.
    await new Promise((resolve) => setTimeout(resolve, 5));
    left = true;
    const outcome = await sending;
    assert.equal(outcome.fulfilled, undefined);
    assert.equal(outcome.aborted, 'blockedbyclient');
    assert.equal(net.handle.lastNavigation(), undefined);
    await net.close();
  });

  it('refuses a scheme other than http(s) first, before counting it', async () => {
    const net = await harness();
    for (const url of ['ws://example.com/socket', 'ftp://example.com/a', 'blob:https://example.com/1', 'chrome://settings']) {
      assert.equal((await net.send({ url })).aborted, 'blockedbyclient', url);
    }
    assert.equal(net.handle.budget.requests, 0);
    assert.deepEqual(net.rows, []);
    assert.deepEqual(net.fetched, []);
  });

  it('a main page passes the gateway as a page, with the second scanner, and is downloaded as a document', async () => {
    const net = await harness({ answer: () => ({ ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>ciao</p>') }) });
    const outcome = await net.send({ url: 'https://example.net/listino', main: true });
    assert.equal(outcome.fulfilled?.status, 200);
    assert.equal(net.fetched[0]?.type, 'document');
    assert.deepEqual(logged(net.rows), [['web-page-public', 'page']]);
    rizzoFinds = true;
    try {
      assert.equal((await net.send({ url: 'https://example.net/?q=Mario', main: true })).aborted, 'blockedbyclient');
      assert.equal(net.rows.at(-1)?.[7], 'pii');
      // A resource is never read by the second scanner (choice of the user: iframes too).
      assert.ok((await net.send({ url: 'https://cdn.example.net/?q=Mario', type: 'image' })).fulfilled);
      assert.ok((await net.send({ url: 'https://frame.example.net/?q=Mario', main: false })).fulfilled);
      assert.deepEqual(logged(net.rows.slice(-2)), [['web-resource-public', 'resource'], ['web-resource-public', 'resource']]);
    } finally {
      rizzoFinds = false;
    }
  });

  it('refuses a form sent by a frame, main or iframe, before the gateway; a POST of a script goes as a resource', async () => {
    const net = await harness();
    assert.equal((await net.send({ url: 'https://example.net/login', main: true, method: 'POST', body: Buffer.from('user=a') })).aborted, 'blockedbyclient');
    assert.equal((await net.send({ url: 'https://example.net/frame', main: false, method: 'POST', body: Buffer.from('a=1') })).aborted, 'blockedbyclient');
    assert.deepEqual(net.rows, []);
    assert.deepEqual(net.events.map((event) => event.payload), [{ outcome: 'form' }]);
    const post = await net.send({ url: 'https://api.example.net/v1', type: 'fetch', method: 'POST', body: Buffer.from('{"a":1}'), headers: { 'content-type': 'application/json' } });
    assert.ok(post.fulfilled);
    assert.equal(net.fetched[0]?.body?.toString('utf8'), '{"a":1}');
    assert.deepEqual(logged(net.rows), [['web-resource-public', 'resource']]);
  });

  it('maps the kinds of Playwright and refuses the others', () => {
    assert.equal(resourceTypeOf('xhr', 'GET'), 'fetch');
    assert.equal(resourceTypeOf('fetch', 'POST'), 'fetch');
    assert.equal(resourceTypeOf('document', 'GET'), 'document');
    assert.equal(resourceTypeOf('other', 'GET'), 'image');
    assert.equal(resourceTypeOf('other', 'POST'), undefined);
    for (const type of ['media', 'websocket', 'eventsource', 'ping', 'texttrack', 'manifest', 'prefetch', 'cspviolationreport', 'signedexchange']) assert.equal(resourceTypeOf(type, 'GET'), undefined, type);
  });

  it('a refused kind is aborted without asking the gateway', async () => {
    const net = await harness();
    for (const type of ['media', 'websocket', 'eventsource', 'ping', 'texttrack', 'manifest']) {
      assert.equal((await net.send({ url: 'https://example.net/x', type })).aborted, 'blockedbyclient', type);
    }
    assert.equal((await net.send({ url: 'https://example.net/favicon.ico', type: 'other' })).fulfilled?.status, 200);
    assert.deepEqual(logged(net.rows), [['web-resource-public', 'resource']]);
  });

  it('keeps the limits of the job: requests, pages and bytes, one event per limit', async () => {
    const net = await harness({ budget: new BrowserBudget({ requests: 3, pages: 1, bytes: 10 }) });
    assert.ok((await net.send({ url: 'https://example.net/a', main: true })).fulfilled);
    assert.equal((await net.send({ url: 'https://example.net/b', main: true })).aborted, 'blockedbyclient');
    assert.ok((await net.send({ url: 'https://example.net/1.png' })).fulfilled);
    // 3 + 3 + 3 bytes so far; the next answer goes beyond 10.
    assert.ok((await net.send({ url: 'https://example.net/2.png' })).fulfilled);
    assert.equal((await net.send({ url: 'https://example.net/3.png' })).aborted, 'blockedbyclient');
    assert.equal((await net.send({ url: 'https://example.net/4.png' })).aborted, 'blockedbyclient');
    const limits = net.events.filter((event) => event.kind === 'browser.limit').map((event) => event.payload);
    assert.deepEqual(limits, [{ limit: 'pages' }, { limit: 'requests' }]);
    const bytes = await harness({ budget: new BrowserBudget({ bytes: 5 }) });
    assert.ok((await bytes.send({ url: 'https://example.net/1.png' })).fulfilled);
    assert.equal((await bytes.send({ url: 'https://example.net/2.png' })).aborted, 'blockedbyclient');
    assert.equal((await bytes.send({ url: 'https://example.net/3.png' })).aborted, 'blockedbyclient');
    assert.deepEqual(bytes.events.filter((event) => event.kind === 'browser.limit').map((event) => event.payload), [{ limit: 'bytes' }]);
  });

  it('follows at most 3 redirects, each through the gateway and counted; a frame is moved to its final origin', async () => {
    const hops = new Map([
      ['https://example.net/0', 'https://example.net/1'],
      ['https://example.net/1', 'https://a.example.org/2'],
      ['https://a.example.org/2', 'https://b.example.org/3'],
      ['https://b.example.org/3', 'https://c.example.org/4#top'],
      ['https://example.net/same', 'https://example.net/other'],
      ['https://example.net/to-local', 'http://127.0.0.1/json/version'],
    ]);
    const answer: Answer = (input) => {
      const next = hops.get(input.url);
      return next === undefined
        ? { ok: true, status: 200, headers: [['content-type', 'text/html'], ['cache-control', 'no-store']], body: Buffer.from('<p>fine</p>') }
        : { ok: true, status: 302, headers: [['location', next]], body: Buffer.alloc(0), location: next };
    };
    const net = await harness({ answer });
    const mainFrame = { parentFrame: () => null };
    const moved = await net.send({ url: 'https://example.net/1', main: true, frame: mainFrame });
    assert.equal(moved.fulfilled?.status, 200);
    assert.deepEqual(moved.fulfilled.body, movePage('https://c.example.org/4#top'));
    assert.deepEqual(logged(net.rows), [['web-page-public', 'page'], ['web-page-public', 'page'], ['web-page-public', 'page'], ['web-page-public', 'page']]);
    // Every hop counts in the requests, one page only.
    assert.equal(net.handle.budget.requests, 4);
    assert.equal(net.handle.budget.pages, 1);
    // An iframe never gets the answer kept for a main frame, nor another main frame.
    const otherFrame = { parentFrame: () => null };
    const fetchedBefore = net.fetched.length;
    assert.equal((await net.send({ url: 'https://c.example.org/4', main: false })).fulfilled?.status, 200);
    assert.equal(net.fetched.length, fetchedBefore + 1);
    assert.equal((await net.send({ url: 'https://c.example.org/4', main: true, frame: otherFrame })).fulfilled?.status, 200);
    assert.equal(net.fetched.length, fetchedBefore + 2);
    // The frame arrives at the final address, without its fragment: the kept answer, no new download nor page.
    const final = await net.send({ url: 'https://c.example.org/4', main: true, frame: mainFrame });
    assert.equal(final.fulfilled?.body.toString('utf8'), '<p>fine</p>');
    assert.equal(net.fetched.length, fetchedBefore + 2);
    assert.equal(net.handle.budget.pages, 2);
    // From /0 the fourth redirect is never asked.
    const rowsBefore = net.rows.length;
    assert.equal((await net.send({ url: 'https://example.net/0', main: true })).aborted, 'blockedbyclient');
    assert.equal(net.rows.length - rowsBefore, 4);
    assert.equal(net.events.at(-1)?.payload?.outcome, 'too-many-redirects');
    // A request that already comes from a chain longer than 3.
    assert.equal((await net.send({ url: 'https://example.net/4', type: 'image', redirects: 4 })).aborted, 'blockedbyclient');
    // Within the same origin too a frame is moved to its true address (relative links resolve against it).
    assert.deepEqual((await net.send({ url: 'https://example.net/same', main: true })).fulfilled?.body, movePage('https://example.net/other'));
    // A sandboxed iframe is moved too, scripts or not: without them it stays empty (closed), never served at its first address.
    assert.deepEqual((await net.send({ url: 'https://example.net/1', main: false, sandbox: 'allow-forms' })).fulfilled?.body, movePage('https://c.example.org/4#top'));
    assert.deepEqual((await net.send({ url: 'https://example.net/1', main: false, sandbox: 'allow-scripts' })).fulfilled?.body, movePage('https://c.example.org/4#top'));
    // A frame Playwright does not know yet is moved, and nothing is kept for it: its next navigation is downloaded again.
    const unknownBefore = net.fetched.length;
    assert.deepEqual((await net.send({ url: 'https://example.net/1', main: true, unknownFrame: true })).fulfilled?.body, movePage('https://c.example.org/4#top'));
    const afterMove = net.fetched.length;
    assert.ok(afterMove > unknownBefore);
    assert.equal((await net.send({ url: 'https://c.example.org/4', main: true, unknownFrame: true })).fulfilled?.body.toString('utf8'), '<p>fine</p>');
    assert.equal(net.fetched.length, afterMove + 1);
    // A sub-resource gets the final answer at its first address (Set-Cookie is dropped by fetchResource, browser-resource.test.ts).
    const image = await net.send({ url: 'https://a.example.org/2', type: 'image' });
    assert.equal(image.fulfilled?.status, 200);
    assert.equal(image.fulfilled.body.toString('utf8'), '<p>fine</p>');
    // A redirect towards this machine stops there: no gateway row, no download for it.
    const rowsLocal = net.rows.length;
    const fetchedLocal = net.fetched.length;
    assert.equal((await net.send({ url: 'https://example.net/to-local', type: 'image' })).aborted, 'addressunreachable');
    assert.equal(net.rows.length - rowsLocal, 1);
    assert.equal(net.fetched.length - fetchedLocal, 1);
    assert.equal((await net.send({ url: 'https://example.net/to-local', main: true })).aborted, 'addressunreachable');
  });

  it('a redirect of a script call to another origin is read only if that origin allows the page', async () => {
    const answer: Answer = (input) =>
      input.url === 'https://example.net/api'
        ? { ok: true, status: 302, headers: [['location', 'https://other.example.org/api']], body: Buffer.alloc(0), location: 'https://other.example.org/api' }
        : { ok: true, status: 200, headers: [['content-type', 'application/json'], ...(input.url.includes('open') ? [['access-control-allow-origin', '*'] as [string, string]] : [])], body: Buffer.from('{}') };
    const net = await harness({ answer });
    // Same origin for the page, another origin after the redirect, which does not allow it.
    assert.equal((await net.send({ url: 'https://example.net/api', type: 'fetch' })).aborted, 'blockedbyclient');
    const open = await harness({
      answer: (input) =>
        input.url === 'https://example.net/api'
          ? { ok: true, status: 302, headers: [['location', 'https://open.example.org/api']], body: Buffer.alloc(0), location: 'https://open.example.org/api' }
          : answer(input),
    });
    assert.ok((await open.send({ url: 'https://example.net/api', type: 'fetch' })).fulfilled);
  });

  it('with the user consent an iframe navigates only on the sites of the user: first load, clicks and redirects', async () => {
    const consent: PageConsent = { from: 'user', addresses: ['https://example.com/listino'] };
    const answer: Answer = (input) =>
      input.url === 'https://example.com/embed'
        ? { ok: true, status: 302, headers: [['location', 'https://tracker.example.net/frame']], body: Buffer.alloc(0), location: 'https://tracker.example.net/frame' }
        : okImage(input);
    const net = await harness({ consent, level: 'L1', answer });
    assert.ok((await net.send({ url: 'https://example.com/listino', main: true })).fulfilled);
    assert.ok((await net.send({ url: 'https://cdn.example.com/frame', main: false })).fulfilled);
    const rows = net.rows.length;
    assert.equal((await net.send({ url: 'https://video.example.net/embed?q=Rossi', main: false })).aborted, 'blockedbyclient');
    assert.equal((await net.send({ url: 'https://example.com/embed', main: false })).aborted, 'blockedbyclient');
    // Refused before the gateway: the redirect asked once (example.com), the other site never.
    assert.equal(net.rows.length - rows, 1);
    // With the public consent any public iframe loads.
    const open = await harness();
    assert.ok((await open.send({ url: 'https://video.example.net/embed', main: false })).fulfilled);
  });

  it('a navigation whose frame is unknown counts as a main page: the page gateway, the second scanner, the page limit', async () => {
    const net = await harness({ budget: new BrowserBudget({ pages: 1 }) });
    rizzoFinds = true;
    try {
      assert.equal((await net.send({ url: 'https://popup.example.net/?q=Mario', main: false, unknownFrame: true })).aborted, 'blockedbyclient');
      assert.deepEqual(logged(net.rows), [['web-page-public', 'pii']]);
    } finally {
      rizzoFinds = false;
    }
    assert.equal(net.handle.budget.pages, 1);
    assert.equal((await net.send({ url: 'https://popup.example.net/b', main: false, unknownFrame: true })).aborted, 'blockedbyclient');
    assert.deepEqual(net.events.filter((event) => event.kind === 'browser.limit').map((event) => event.payload), [{ limit: 'pages' }]);
  });

  it('with the sites consent an iframe navigates only on a listed site or a subdomain of it', async () => {
    const net = await harness({ consent: { from: 'sites', sites: ['example.com'] }, level: 'L1' });
    assert.ok((await net.send({ url: 'https://example.com/frame', main: false })).fulfilled);
    assert.ok((await net.send({ url: 'https://docs.example.com/frame', main: false })).fulfilled);
    const rows = net.rows.length;
    assert.equal((await net.send({ url: 'https://example.com.evil.example/frame', main: false })).aborted, 'blockedbyclient');
    assert.equal((await net.send({ url: 'https://other.example.net/frame', main: false })).aborted, 'blockedbyclient');
    assert.equal(net.rows.length, rows);
    // A resource that is not a frame loads from any public site.
    assert.ok((await net.send({ url: 'https://cdn.example.net/a.png' })).fulfilled);
  });

  it('close stops the requests under way, refuses the ones decided after the gateway, then counts', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signals: (AbortSignal | undefined)[] = [];
    const rows: unknown[][] = [];
    const events: NewEvent[] = [];
    let handler: ((route: Route) => Promise<void>) | undefined;
    const context = {
      route: (_pattern: string, callback: (route: Route) => Promise<void>) => {
        handler = callback;
        return Promise.resolve();
      },
      unrouteAll: () => Promise.resolve(),
    } as unknown as BrowserContext;
    const handle = await attachNetwork(context, {
      sql: fakeSql(rows),
      context: createContext('L1', 'L0'),
      consent: { from: 'public' },
      userAgent: 'Mozilla/5.0',
      onEvent: (event) => events.push(event),
      fetchResource: async (_input, _options, signal) => {
        signals.push(signal);
        await waiting;
        return signal?.aborted === true ? { ok: false, reason: 'interrupted' } : okImage(_input);
      },
    });
    const outcome: Outcome = {};
    const route = {
      request: () => fakeRequest({ url: 'https://example.net/slow.png' }),
      fulfill: () => {
        outcome.fulfilled = { status: 200, headers: {}, body: Buffer.alloc(0) };
        return Promise.resolve();
      },
      abort: (code: string) => {
        outcome.aborted = code;
        return Promise.resolve();
      },
    } as unknown as Route;
    assert.ok(handler);
    const pending = handler(route);
    await new Promise((resolve) => setImmediate(resolve));
    const closing = handle.close();
    assert.equal(signals[0]?.aborted, true);
    // browser.network waits for the request under way.
    assert.deepEqual(events.filter((event) => event.kind === 'browser.network'), []);
    release();
    await pending;
    await closing;
    assert.equal(outcome.aborted, 'failed');
    assert.equal(outcome.fulfilled, undefined);
    assert.equal(events.at(-1)?.kind, 'browser.network');
    assert.deepEqual(events.at(-1)?.payload?.counts, { image: { refused: 1 } });
  });

  it('with the user consent the first page is the written one; clicks and redirects stay on its site', async () => {
    const consent: PageConsent = { from: 'user', addresses: ['https://example.com/listino'] };
    assert.deepEqual(navigationConsent(consent, 'https://example.com/listino', 0), consent);
    assert.deepEqual(navigationConsent(consent, 'https://example.com/altro', 1), { from: 'sites', sites: ['example.com'] });
    assert.deepEqual(navigationConsent({ from: 'public' }, 'https://example.net/', 0), { from: 'public' });
    const net = await harness({ consent, level: 'L1' });
    assert.ok((await net.send({ url: 'https://example.com/listino', main: true })).fulfilled);
    assert.ok((await net.send({ url: 'https://www.example.com/prezzi', main: true })).fulfilled);
    assert.equal((await net.send({ url: 'https://example.net/?q=Rossi', main: true })).aborted, 'blockedbyclient');
    assert.deepEqual(logged(net.rows), [['web-page-user', 'page'], ['web-page-sites', 'page'], ['web-page-sites', 'page-consent']]);
    // A resource of the page loads from any public site.
    assert.ok((await net.send({ url: 'https://cdn.example.net/app.js', type: 'script' })).fulfilled);
    assert.equal(net.rows.at(-1)?.[3], 'web-resource-user');
  });

  it('keeps CORS as without interception: a cross-origin answer without the header allows only its own origin', async () => {
    const net = await harness({ answer: () => ({ ok: true, status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('{}') }) });
    const cross = await net.send({ url: 'https://api.example.org/v1', type: 'fetch', headers: { origin: 'https://example.net' } });
    assert.equal(cross.fulfilled?.headers['access-control-allow-origin'], 'https://api.example.org');
    const same = await net.send({ url: 'https://example.net/v1', type: 'fetch', headers: { origin: 'https://example.net' } });
    assert.equal(same.fulfilled?.headers['access-control-allow-origin'], undefined);
    const allowed = await harness({ answer: () => ({ ok: true, status: 200, headers: [['content-type', 'application/json'], ['access-control-allow-origin', '*']], body: Buffer.from('{}') }) });
    assert.equal((await allowed.send({ url: 'https://api.example.org/v1', type: 'fetch', headers: { origin: 'https://example.net' } })).fulfilled?.headers['access-control-allow-origin'], '*');
  });

  it('events carry the site of an allowed page and counts, never an address', async () => {
    const net = await harness({ answer: (input) => (input.url.includes('/fail') ? { ok: false, reason: 'timeout' } : { ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('x') }) });
    await net.send({ url: 'https://example.net/percorso/segreto?q=1', main: true });
    await net.send({ url: 'https://example.net/fail/qui', main: true });
    await net.send({ url: 'https://example.net/a.png?id=7' });
    await net.send({ url: 'https://example.net/form', main: true, method: 'POST' });
    await net.close();
    await net.close();
    const kinds = net.events.map((event) => event.kind);
    assert.deepEqual(kinds, ['browser.navigate', 'browser.navigate', 'browser.navigate', 'browser.network']);
    assert.deepEqual(net.events.slice(0, 3).map((event) => event.payload), [
      { outcome: 'ok', site: 'example.net' },
      { outcome: 'failed', site: 'example.net', reason: 'timeout' },
      { outcome: 'form' },
    ]);
    const text = JSON.stringify(net.events);
    for (const part of ['percorso', 'segreto', 'q=1', '/fail', 'a.png', 'https://']) assert.ok(!text.includes(part), part);
    assert.deepEqual(net.events.at(-1)?.payload, { pages: 3, requests: 4, bytes: 2, counts: { page: { ok: 1, failed: 1, form: 1 }, image: { ok: 1 } }, limits: [] });
    // After close, nothing more passes.
    assert.equal((await net.send({ url: 'https://example.net/b.png' })).aborted, 'blockedbyclient');
  });
});

// The access made by the user (D-276, D-264 passo 5).
describe('attachNetwork: forms and cookies of the user', () => {
  const html = (setCookies?: string[]): ResourceResult => ({ ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>ok</p>'), ...(setCookies === undefined ? {} : { setCookies }) });
  const columns = (row: unknown[] | undefined) => ({ target: row?.[3], label: row?.[5], decision: row?.[6], rule: row?.[7], reason: row?.[8], bytes: row?.[9] });
  const asUser = (net: Harness, consent: PageConsent = { from: 'public' }, level: 'L0' | 'L1' = 'L0') => {
    net.handle.rescope({ context: level === 'L1' ? createContext('L1', 'L1') : createContext('L1', 'L0'), consent, driver: 'user' });
  };

  it('a 307 or 308 of a form keeps its body only as a form again, to the site of the form: logged with its size; to another site never sent', async () => {
    const body = Buffer.from('utente=finto&password=finta-123');
    const redirect = (location: string, status: number): ResourceResult => ({ ok: true, status, headers: [['location', location]], body: Buffer.alloc(0), location });
    const net = await harness({
      answer: (input) =>
        input.url === 'https://www.banca-finta.it/session' ? redirect('https://login.banca-finta.it/session', 307) : input.url === 'https://login.banca-finta.it/session' ? redirect('https://other.example.org/raccolta', 308) : html(),
    });
    asUser(net);
    const sent = await net.send({ url: 'https://www.banca-finta.it/session', main: true, method: 'POST', body, pageUrl: 'https://www.banca-finta.it/accedi' });
    assert.equal(sent.fulfilled, undefined);
    // The second hop, on the site, went again as a form with its bytes; the third, to another site, was never asked.
    assert.deepEqual(net.rows.map((row) => columns(row).target), ['web-form', 'web-form', 'web-form']);
    assert.deepEqual(net.rows.map((row) => columns(row).bytes), [body.length, body.length, body.length]);
    assert.deepEqual(net.rows.map((row) => columns(row).decision), ['allow', 'allow', 'block']);
    assert.deepEqual(net.fetched.map((request) => request.url), ['https://www.banca-finta.it/session', 'https://login.banca-finta.it/session']);
    assert.equal(net.fetched[1]?.body?.toString('utf8'), body.toString('utf8'));
  });

  it('a form of the user to the site of its page leaves as written, logged with its size only; from then on the browser has an access', async () => {
    const net = await harness({ answer: () => html(['sid=abc; Path=/; Domain=banca-finta.it']) });
    asUser(net);
    const body = Buffer.from('utente=finto&password=finta-123');
    const sent = await net.send({ url: 'https://login.banca-finta.it/session', main: true, method: 'POST', body, pageUrl: 'https://www.banca-finta.it/accedi', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(sent.fulfilled?.status, 200);
    assert.equal(net.fetched[0]?.body?.toString('utf8'), body.toString('utf8'));
    assert.equal(net.fetched[0].method, 'POST');
    const row = columns(net.rows[0]);
    assert.deepEqual({ ...row, reason: undefined }, { target: 'web-form', label: 'L2', decision: 'allow', rule: 'form', reason: undefined, bytes: body.length });
    // Nothing of the content in the log, nor in the events.
    assert.ok(!JSON.stringify(net.rows).includes('finta-123'));
    assert.ok(!JSON.stringify(net.events).includes('finta-123'));
    assert.equal(net.handle.authenticated(), 'banca-finta.it');
    assert.deepEqual(net.events.find((event) => event.kind === 'browser.access')?.payload, {});
    // The next page of the site: as `session`, L2, with the cookie of the answer.
    assert.ok((await net.send({ url: 'https://www.banca-finta.it/conti', main: true, pageUrl: 'https://www.banca-finta.it/accedi' })).fulfilled);
    assert.deepEqual(columns(net.rows.at(-1)).target, 'web-session');
    assert.equal(columns(net.rows.at(-1)).label, 'L2');
    assert.equal(net.fetched.at(-1)?.cookie, 'sid=abc');
    // After the access the events never name the site.
    assert.deepEqual(net.events.at(-1)?.payload, { outcome: 'ok' });
  });

  it('after the access nothing goes to another site: pages, iframes and resources carry L2 and the gateway refuses them', async () => {
    const net = await harness({ answer: () => html() });
    asUser(net);
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    const fetched = net.fetched.length;
    for (const spec of [{ url: 'https://news-finte.it/', main: true }, { url: 'https://cdn-finto.net/app.js', type: 'script' }, { url: 'https://tracker-finto.net/p.gif?u=1', type: 'image' }, { url: 'https://video-finto.net/embed', main: false }]) {
      assert.ok((await net.send(spec)).aborted, spec.url);
    }
    assert.equal(net.fetched.length, fetched);
    // Every refusal is a row of the gateway, L2: never a cookie nor a request.
    for (const row of net.rows.slice(1)) assert.equal(columns(row).label, 'L2');
    assert.ok(net.rows.slice(1).every((row) => columns(row).decision === 'block'));
    // A click of the user to another site (D-286), with a gesture: refused all the same after the access.
    net.handle.rescope({ context: createContext('L1', 'L0'), consent: { from: 'user', addresses: ['https://banca-finta.it/accedi'] }, driver: 'user', takeGesture: () => true });
    assert.ok((await net.send({ url: 'https://altro-sito-finto.it/', main: true })).aborted);
    asUser(net);
    // A resource of the site goes, as `session`, with no cookie when the jar has none for it.
    assert.ok((await net.send({ url: 'https://static.banca-finta.it/app.css', type: 'stylesheet' })).fulfilled);
    assert.equal(columns(net.rows.at(-1)).target, 'web-session');
  });

  it('a form to another site, a form while Arianna drives, a form from an iframe: refused before the gateway', async () => {
    const net = await harness({ answer: () => html() });
    assert.ok((await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' })).aborted);
    asUser(net);
    assert.ok((await net.send({ url: 'https://raccolta-finta.net/steal', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' })).aborted);
    assert.ok((await net.send({ url: 'https://banca-finta.it/session', main: false, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' })).aborted);
    assert.ok((await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1') })).aborted);
    assert.deepEqual(net.rows, []);
    assert.equal(net.handle.authenticated(), null);
    // Once the browser has an access, a form to another site's page stays refused too.
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    assert.ok((await net.send({ url: 'https://altra-finta.it/form', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://altra-finta.it/' })).aborted);
    assert.equal(net.handle.authenticated(), 'banca-finta.it');
  });

  it('the cookies of the main pages wait for a form of the user to their site, never sent before; given back without a form, they go', async () => {
    const answers = new Map<string, string[]>([['https://banca-finta.it/accedi', ['csrf=t1; Path=/']], ['https://news-finte.it/', ['track=1']], ['https://posta-finta.it/accedi', ['csrf=p1; Path=/']]]);
    const net = await harness({ answer: (input) => html(answers.get(input.url)) });
    // Arianna reads the page of the access: its cookie waits (a CSRF token), never sent by her.
    await net.send({ url: 'https://banca-finta.it/accedi', main: true });
    await net.send({ url: 'https://banca-finta.it/accedi', main: true });
    assert.equal(net.fetched.at(-1)?.cookie, undefined);
    net.handle.rescope({ context: createContext('L1', 'L0'), consent: { from: 'public' }, driver: 'agent' });
    asUser(net);
    await net.send({ url: 'https://news-finte.it/', main: true });
    // Never sent while they wait.
    await net.send({ url: 'https://news-finte.it/', main: true });
    assert.equal(net.fetched.at(-1)?.cookie, undefined);
    // The form of the user carries the cookie of its site only, also the one of the page Arianna read.
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    assert.equal(net.fetched.at(-1)?.cookie, 'csrf=t1');
    assert.equal(net.handle.authenticated(), 'banca-finta.it');
  });

  it('a form of the user over http never leaves: no access, nothing fetched', async () => {
    const net = await harness({ answer: () => html(['sid=1']) });
    asUser(net);
    await net.send({ url: 'http://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'http://banca-finta.it/accedi' });
    assert.deepEqual(net.fetched, []);
    assert.equal(net.handle.authenticated(), null);
  });

  it('given back without a form, the cookies that waited go', async () => {
    const net = await harness({ answer: (input) => html(input.url === 'https://banca-finta.it/accedi' ? ['csrf=t1; Path=/'] : undefined) });
    asUser(net);
    await net.send({ url: 'https://banca-finta.it/accedi', main: true });
    net.handle.rescope({ context: createContext('L1', 'L0'), consent: { from: 'public' }, driver: 'agent' });
    asUser(net);
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    assert.equal(net.fetched.at(-1)?.cookie, undefined);
  });

  it('closing the network forgets the access and its cookies', async () => {
    const net = await harness({ answer: () => html(['sid=1']) });
    asUser(net);
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    assert.equal(net.handle.authenticated(), 'banca-finta.it');
    await net.close();
    assert.equal(net.handle.authenticated(), null);
  });
});

// A page that did not load in the trial of D-281: a request whose extra headers never come is still answered.
describe('attachNetwork: requests are always answered', () => {
  it('allHeaders that never answers: the headers Playwright has are used, the request goes on', async () => {
    const net = await harness();
    const sent = await net.send({ url: 'https://example.net/fonts/a.woff2', type: 'font', hangHeaders: true, headers: { accept: '*/*' } });
    assert.ok(sent.fulfilled);
    assert.equal(net.fetched.length, 1);
  });

  it('a download that never ends: the page and the resource are refused at the deadline, with a timeout', async () => {
    const net = await harness({ hang: true });
    const page = await net.send({ url: 'https://example.net/login', main: true });
    assert.equal(page.aborted, 'timedout');
    assert.equal(net.handle.lastNavigation()?.outcome, 'failed');
    assert.equal(net.handle.lastNavigation()?.reason, 'timeout');
    const image = await net.send({ url: 'https://example.net/a.png' });
    assert.equal(image.aborted, 'timedout');
    assert.deepEqual(net.handle.counts(), { page: { failed: 1 }, image: { failed: 1 } });
  });

  it('an answer that comes after the deadline: its redirect is never followed and its cookies are never kept', async () => {
    const net = await harness({ delayMs: 200, answer: () => ({ ok: true, status: 302, headers: [['location', 'https://example.net/next']], body: Buffer.alloc(0), location: 'https://example.net/next', setCookies: ['sid=late'] }) });
    net.handle.rescope({ context: createContext('L1', 'L0'), consent: { from: 'public' }, driver: 'user' });
    const sent = await net.send({ url: 'https://example.net/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://example.net/accedi' });
    assert.equal(sent.aborted, 'timedout');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(net.fetched.map((request) => request.url), ['https://example.net/session']);
    // The form left before the deadline (the access is born with it, as in D-276); the cookie of its late answer is not kept.
    assert.equal(net.handle.authenticated(), 'example.net');
    await net.send({ url: 'https://example.net/conti', main: true });
    assert.equal(net.fetched.at(-1)?.cookie, undefined);
  });
});

// The Private chat of an access (D-281): Arianna reads the site of the access, and sends to it only after «Invia».
describe('attachNetwork: the Private chat of an access', () => {
  const html = (): ResourceResult => ({ ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>ok</p>') });
  const target = (row: unknown[] | undefined) => ({ target: row?.[3], label: row?.[5], decision: row?.[6], rule: row?.[7] });
  const CHAT_CONTEXT = createContext('L2', 'L2', { browserSite: 'banca-finta.it' });
  const accessed = async (): Promise<Harness> => {
    const net = await harness({ answer: () => html() });
    net.handle.rescope({ context: createContext('L1', 'L0'), consent: { from: 'public' }, driver: 'user' });
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    net.handle.rescope({ context: CHAT_CONTEXT, consent: { from: 'sites', sites: ['banca-finta.it'] }, driver: 'agent' });
    return net;
  };

  it('pages and reads of the site go as session from the context of the chat; another site never', async () => {
    const net = await accessed();
    assert.ok((await net.send({ url: 'https://www.banca-finta.it/conti', main: true, pageUrl: 'https://www.banca-finta.it/' })).fulfilled);
    assert.deepEqual(target(net.rows.at(-1)), { target: 'web-session', label: 'L2', decision: 'allow', rule: 'session' });
    assert.ok((await net.send({ url: 'https://api.banca-finta.it/saldo', type: 'fetch' })).fulfilled);
    assert.ok((await net.send({ url: 'https://news-finte.it/', main: true })).aborted);
    assert.ok((await net.send({ url: 'https://cdn-finto.net/app.js', type: 'script' })).aborted);
    assert.equal(net.handle.heldSends(), 0);
  });

  it('a send of Arianna to the site (form or POST of a script) is held and counted without «Invia»; with it, it goes', async () => {
    const net = await accessed();
    const rows = net.rows.length;
    assert.ok((await net.send({ url: 'https://banca-finta.it/rinnova', main: true, method: 'POST', body: Buffer.from('p=7'), pageUrl: 'https://banca-finta.it/prestiti' })).aborted);
    assert.ok((await net.send({ url: 'https://api.banca-finta.it/rinnova', type: 'fetch', method: 'POST', body: Buffer.from('{"p":7}') })).aborted);
    assert.equal(net.handle.heldSends(), 2);
    // Held before the gateway: nothing logged.
    assert.equal(net.rows.length, rows);
    net.handle.rescope({ context: CHAT_CONTEXT, consent: { from: 'sites', sites: ['banca-finta.it'] }, driver: 'agent', send: true });
    assert.ok((await net.send({ url: 'https://banca-finta.it/rinnova', main: true, method: 'POST', body: Buffer.from('p=7'), pageUrl: 'https://banca-finta.it/prestiti' })).fulfilled);
    assert.deepEqual(target(net.rows.at(-1)), { target: 'web-form', label: 'L2', decision: 'allow', rule: 'form' });
    assert.ok((await net.send({ url: 'https://api.banca-finta.it/rinnova', type: 'fetch', method: 'POST', body: Buffer.from('{"p":7}') })).fulfilled);
    assert.deepEqual(target(net.rows.at(-1)), { target: 'web-session', label: 'L2', decision: 'allow', rule: 'session' });
    // Even with «Invia», never a form to another site.
    assert.ok((await net.send({ url: 'https://raccolta-finta.net/x', main: true, method: 'POST', body: Buffer.from('p=7'), pageUrl: 'https://banca-finta.it/prestiti' })).aborted);
    assert.equal(net.handle.heldSends(), 2);
  });

  it('in a work context after the access nothing is held: the user sends as before', async () => {
    const net = await harness({ answer: () => html() });
    net.handle.rescope({ context: createContext('L1', 'L0'), consent: { from: 'public' }, driver: 'user' });
    await net.send({ url: 'https://banca-finta.it/session', main: true, method: 'POST', body: Buffer.from('a=1'), pageUrl: 'https://banca-finta.it/accedi' });
    assert.ok((await net.send({ url: 'https://banca-finta.it/altro', main: true, method: 'POST', body: Buffer.from('b=2'), pageUrl: 'https://banca-finta.it/conti' })).fulfilled);
    assert.equal(net.handle.heldSends(), 0);
  });
});
