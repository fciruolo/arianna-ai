// The network of the agent's browser (D-264, passo 2): every request of
// Chromium decided in the core, with a fake Playwright context, a fake
// network and the real gateway on a fake log. No Docker, no network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createContext, piiReport, type PageConsent } from '@arianna/policy';
import type { BrowserContext, Route } from 'playwright-core';

import type { Sql } from '../src/db/client.ts';
import type { NewEvent } from '../src/events.ts';
import { attachNetwork, BrowserBudget, movePage, navigationConsent, resourceTypeOf, type NetworkJob } from '../src/browser/network.ts';
import type { ResourceInput, ResourceResult } from '../src/browser/resource-fetch.ts';
import { configurePiiGuard } from '../src/pii-guard.ts';

/** What the fake second scanner finds: nothing, or a person in every text. */
let rizzoFinds = false;
configurePiiGuard({
  state: 'ready',
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
      parentFrame: () => (spec.main === true ? null : {}),
      frameElement: () => Promise.resolve({ getAttribute: () => Promise.resolve(spec.sandbox ?? null), dispose: () => Promise.resolve() }),
      };
    },
    redirectedFrom: () => chain(spec.redirects ?? 0),
    headers: () => spec.headers ?? {},
    allHeaders: () => Promise.resolve(spec.headers ?? {}),
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

async function harness(options: { consent?: PageConsent; level?: 'L0' | 'L1'; answer?: Answer; budget?: BrowserBudget } = {}): Promise<Harness> {
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
      return Promise.resolve(answer(input));
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
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
