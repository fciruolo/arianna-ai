import { MAX_FORM_BODY, spendAllowed, type Context, type Label, type PageConsent, type ResourceType, type Target } from '@arianna/policy';
import type { BrowserContext, Frame, Page, Request, Route } from 'playwright-core';

import type { Sql } from '../db/client.ts';
import type { NewEvent } from '../events.ts';
import { passGateway, type GatewayMeta } from '../gateway.ts';
import { siteOf } from '../link-fetch.ts';
import { redirectConsent } from '../web-page.ts';
import { CookieJar, onSite } from './cookie-jar.ts';
import { createResourcePool, fetchResource, resourceUrl, type ResourceFailure, type ResourceInput, type ResourceOptions, type ResourcePool, type ResourceResult } from './resource-fetch.ts';
import { gateResource } from './resource-gate.ts';

/**
 * The network of the agent's browser (D-264, passo 2). The container has no
 * network (`--network none`): every request of Chromium is stopped by
 * `context.route('**\/*')` of Playwright, before the first navigation, and
 * decided here, in this order:
 *
 * 1. a scheme other than http(s): aborted;
 * 2. the limits of the job (30 main pages, 2,000 requests, 50 MB decompressed): aborted;
 * 3. a navigation of a frame (main page, popup or iframe) with a method other than GET: aborted ("niente moduli");
 * 4. a main page (the main frame of a tab, popups included): the gateway as
 *    a page (D-262, second scanner included), with the consent of the job;
 *    then downloaded as a `document` resource;
 * 5. any other request, iframes included (choice of the user, 2026-10-21: as
 *    resources, without the second scanner): `gateResource`.
 *
 * Redirects. Playwright calls the handler only for the first request of a
 * chain: when a 3xx is fulfilled, Chromium follows it and Playwright sends
 * the next hop on with `Fetch.continueRequest`, which fails here for the
 * missing network (tried on 2026-10-21 with Chromium 155). So the core follows
 * the redirects itself, at most 3 per chain, each hop through the gateway
 * again (a main page with the consent of its redirects, `redirectConsent` as
 * in web-page.ts), and every hop counts in the limit of requests. A frame
 * whose final address differs from the asked one is answered with a page
 * that moves it there (`<meta http-equiv=refresh>`) and the final
 * answer is kept for that one next navigation of that same frame: the frame
 * ends on its true address and origin, relative links resolve against it,
 * nothing is downloaded twice (a frame Playwright does not know yet keeps
 * nothing: its next navigation is asked and downloaded again). A sandboxed
 * frame without `allow-scripts` does not follow a meta refresh (tried on
 * 2026-10-21) and stays on the empty page: it fails closed. Serving it the
 * final answer at its first address would be safe only if the frame had no
 * scripts since its navigation started, and the `sandbox` attribute read now
 * does not say that (a script may have changed it meanwhile), so it is not done. A
 * sub-resource gets the final answer at its first address; a script call
 * (`fetch`) redirected to another origin only when that origin allows the
 * page (Access-Control-Allow-Origin), as a browser would.
 *
 * Iframes with a `user` or `sites` consent: every navigation of an iframe,
 * the first load included (Playwright does not tell a first load from a
 * later click reliably), must be on the sites `navigationConsent` allows
 * after the first page ("Clic solo nello stesso sito"), each hop of its
 * redirects too. An embed from another site is not shown in an Internal
 * session; with the public consent any public iframe loads.
 *
 * What Playwright does by itself, never reaching this handler:
 * - CORS preflights (OPTIONS): answered by Playwright with a 204 that allows
 *   everything; nothing leaves. The real request comes here afterwards.
 * - Requests without a frame (no frameId: some service worker fetches, and
 *   requests of targets Playwright does not track) and the hops of a
 *   redirect: continued without a handler, so they fail for the missing network.
 * - A fulfilled answer to a cross-origin request without
 *   Access-Control-Allow-Origin gets one from Playwright (the origin itself,
 *   with credentials): CORS would be off. Here such an answer gets
 *   Access-Control-Allow-Origin with the origin of the answer, so a page reads
 *   across origins only what the site allows, as without interception.
 *
 * No cookie leaves (the headers are rebuilt by resource-fetch.ts) and no
 * Set-Cookie arrives. Events carry the site of an allowed main page and
 * counts, never a whole address nor a text.
 *
 * The access made by the user (D-276, D-264 passo 5). While the user drives
 * (`driver: 'user'`):
 * - a form (a POST navigation of the main frame) to the site of the page it
 *   is sent from (`siteOf` of the page, its subdomains too) goes through the
 *   gateway as `form`: its address and its size, never its content, which
 *   leaves as the user wrote it; a form to another site, or with Arianna
 *   driving, stays refused (`form`);
 * - the Set-Cookie lines of the answers to the main pages (of the user, or
 *   of Arianna before: the page of the access is often one she read) wait
 *   in memory, by site, never sent: the first form of the user to a site
 *   makes them the cookie jar of that site (so a login that set its cookie
 *   with the page of the form works). Given back without a form, they go.
 * From that form on the browser has an access («autenticato»): every request
 * carries L2. A request of the site of the access goes as `session` with the
 * cookies of the jar (the core adds them, Chromium never sees one) and keeps
 * the Set-Cookie lines of its answer; any other request carries L2 with the
 * consent of the page, which the gateway refuses: nothing read after the
 * access goes to another site. The jar dies with the browser.
 *
 * The Private chat of an access (D-281): once the browser passed to it, the
 * scope carries a context marked with the site of the access, from which the
 * gateway lets `session`, `form` and typed text go to that site. While
 * Arianna drives there, every request other than GET and HEAD (a form, a
 * POST of the page's scripts) is refused before the gateway and counted
 * (`heldSends`), unless the scope says `send` (an «Invia» of the user, for
 * one action): then a form to the site goes as `form`, a POST as `session`.
 */

export const MAX_PAGES = 30;
export const MAX_REQUESTS = 2_000;
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
/** How long the final answer of a redirected frame waits for its navigation. */
const KEEP_FINAL_MS = 30_000;

export type LimitKind = 'pages' | 'requests' | 'bytes';

/** The limits of one job (D-264); pure. */
export class BrowserBudget {
  readonly limits: Readonly<Record<LimitKind, number>>;
  pages = 0;
  requests = 0;
  bytes = 0;

  constructor(limits: Partial<Record<LimitKind, number>> = {}) {
    this.limits = { pages: limits.pages ?? MAX_PAGES, requests: limits.requests ?? MAX_REQUESTS, bytes: limits.bytes ?? MAX_BYTES };
  }

  /** Takes one request (and one page for a main page), or names the limit reached. */
  take(mainPage: boolean): LimitKind | null {
    if (this.requests >= this.limits.requests) return 'requests';
    if (this.bytes >= this.limits.bytes) return 'bytes';
    if (mainPage && this.pages >= this.limits.pages) return 'pages';
    this.requests += 1;
    if (mainPage) this.pages += 1;
    return null;
  }

  /** Counts decompressed bytes; `bytes` when they go beyond the limit (that answer is refused too). */
  addBytes(count: number): LimitKind | null {
    this.bytes += count;
    return this.bytes > this.limits.bytes ? 'bytes' : null;
  }
}

/** Outcome of a request, as events count it: a closed list. */
export const REQUEST_OUTCOMES = ['ok', 'http-error', 'blocked', 'refused', 'form', 'limit', 'too-many-redirects', 'failed'] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

/** Our kinds of request, plus `page` for a main page and `other` for what is refused by its kind. */
export type CountedType = ResourceType | 'page' | 'other';

/** Playwright's resource types towards ours; anything missing is refused (media, websocket, eventsource, ping, texttrack, manifest, prefetch…). */
export function resourceTypeOf(type: string, method: string): ResourceType | undefined {
  switch (type) {
    case 'document':
      return 'document';
    case 'stylesheet':
    case 'script':
    case 'image':
    case 'font':
      return type;
    case 'fetch':
    case 'xhr':
      return 'fetch';
    // An unknown kind only as an image (a favicon, an <img> of a kind Chromium does not name).
    case 'other':
      return method === 'GET' ? 'image' : undefined;
    default:
      return undefined;
  }
}

/** The abort code Chromium shows for a refusal. */
type AbortCode = 'blockedbyclient' | 'addressunreachable' | 'namenotresolved' | 'timedout' | 'connectionfailed' | 'failed';

function abortCode(reason: ResourceFailure | 'limit' | 'form' | 'refused' | 'too-many-redirects'): AbortCode {
  switch (reason) {
    case 'private-address':
      return 'addressunreachable';
    case 'dns':
      return 'namenotresolved';
    case 'timeout':
      return 'timedout';
    case 'network':
      return 'connectionfailed';
    case 'bad-response':
    case 'too-large':
    case 'unsupported-type':
    case 'interrupted':
      return 'failed';
    default:
      return 'blockedbyclient';
  }
}

export interface NetworkJob {
  sql: Sql;
  /** The context of the session of the job: the gateway refuses anything above Internal (L1) or with finance data. */
  context: Context;
  /** The consent the job was opened with (D-262). */
  consent: PageConsent;
  /** The User-Agent of the Chromium of the container (Browser.getVersion). */
  userAgent: string;
  meta?: GatewayMeta;
  /** Events: `browser.navigate`, `browser.limit`, `browser.network`. */
  onEvent?: (event: NewEvent) => void;
  budget?: BrowserBudget;
  /** Default: a pool of its own, destroyed by close(). */
  pool?: ResourcePool;
  /** Tests only, never set by the core: see ResourceOptions. */
  unsafeTestAddresses?: readonly string[];
  resolve?: ResourceOptions['resolve'];
  timeoutMs?: number;
  /** Tests: the network part, with fake servers. */
  fetchResource?: typeof fetchResource;
  /**
   * Trials and tests only, never stored: every decided request with its
   * address, to count by hand what the scanner refused (try-cli.ts).
   */
  trace?: (entry: { url: string; type: CountedType; kind: string; outcome: RequestOutcome; reason?: ResourceFailure }) => void;
}

/** The last main page decided; `seq` grows by one at each, so a caller tells a new one from the same one read again. */
export interface LastNavigation {
  seq: number;
  outcome: RequestOutcome;
  site?: string;
  reason?: ResourceFailure;
}

/** What decides the requests of a job: the session it acts for, its consent and the ids of the gateway log. */
export interface NetworkScope {
  context: Context;
  consent: PageConsent;
  meta?: GatewayMeta;
  /** Who drives the browser (D-264, passo 5): `agent` when missing. */
  driver?: 'agent' | 'user';
  /**
   * The Private chat of an access (D-281, context with `browserSite`): Arianna
   * may send to the site of the access (a form, a POST of the page's scripts)
   * only while this is true, for the one action the user approved with
   * «Invia». Without it every request of Arianna there other than GET and
   * HEAD is refused and counted (`heldSends`).
   */
  send?: boolean;
}

/** Cookies of a site waiting for the first form of the user (D-276): at most this many sites, the oldest go. */
const MAX_PENDING_SITES = 8;

export interface NetworkHandle {
  readonly budget: BrowserBudget;
  /**
   * The session of the job changed (D-264, passo 3: the browser of a
   * conversation outlives one answer): the requests from now on are decided
   * with this context, consent and log ids. A request already deciding keeps
   * the scope it started with.
   */
  rescope(next: NetworkScope): void;
  /** The last main page decided, for the answer of a tool: its outcome, the site of an allowed address, why it failed. */
  lastNavigation(): LastNavigation | undefined;
  /** Counts by kind and outcome so far. */
  counts(): Record<string, Record<string, number>>;
  /** After a navigation: waits while the frame is moved to the final address of a redirect. */
  settle(page: Page, timeoutMs?: number): Promise<void>;
  /** The site of the access made by the user (D-276), once a form of the user went; null before. */
  authenticated(): string | null;
  /** Requests of Arianna other than GET and HEAD refused in the Private chat of an access without «Invia» (D-281), so far. */
  heldSends(): number;
  /** Removes the interception, sends `browser.network`, closes the connections. */
  close(): Promise<void>;
}

/**
 * A frame navigation: of the main frame (a page) or of an iframe. A navigation
 * whose frame Playwright does not know yet (a popup being created) counts as a
 * main page: the stricter way, with the second scanner and the page limit.
 */
function frameOf(request: Request): { navigation: boolean; main: boolean } {
  if (!request.isNavigationRequest()) return { navigation: false, main: false };
  try {
    return { navigation: true, main: request.frame().parentFrame() === null };
  } catch {
    return { navigation: true, main: true };
  }
}

function redirectsBefore(request: Request): number {
  let count = 0;
  for (let previous = request.redirectedFrom(); previous !== null; previous = previous.redirectedFrom()) count += 1;
  return count;
}

/** An address of a `user` consent as compared: without the fragment. */
function withoutHash(address: string): string | undefined {
  try {
    const url = new URL(address);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * The consent of a main page of the job. `public` and `sites` stay as they are
 * (with the oEmbed of X for a listed post). `user`: an address the user wrote,
 * as the first hop, with the `user` consent; anything else (a click, a
 * redirect) only on the sites of the addresses the user wrote ("Clic solo
 * nello stesso sito", 2026-10-20).
 */
export function navigationConsent(consent: PageConsent, address: string, hop: number): PageConsent {
  if (consent.from === 'public') return consent;
  if (consent.from === 'sites') return redirectConsent(consent, address);
  const key = withoutHash(address);
  if (hop === 0 && consent.addresses.some((written) => withoutHash(written) === key)) return consent;
  const sites = new Set<string>();
  for (const written of consent.addresses) {
    const derived = redirectConsent(consent, written);
    if (derived.from === 'sites') for (const site of derived.sites) sites.add(site);
  }
  // No site to derive: the user consent itself, which refuses any other address.
  return sites.size === 0 ? consent : { from: 'sites', sites: [...sites] };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The page that moves a frame to the final address of a redirect: our own text, no script. */
export function movePage(final: string): Buffer {
  return Buffer.from(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeAttribute(final)}"><title></title>`, 'utf8');
}

type Answer = Extract<ResourceResult, { ok: true }>;

/** The headers for route.fulfill: one value per name (repeated ones joined), and CORS as without interception. */
function fulfillHeaders(answer: Answer, origin: string | undefined, final: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of answer.headers) headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  if (origin !== undefined && headers['access-control-allow-origin'] === undefined) {
    let own: string | undefined;
    try {
      own = new URL(final).origin;
    } catch {
      own = undefined;
    }
    // Playwright would add the origin of the page with credentials: the origin of the answer allows only itself.
    if (own !== undefined && own !== origin.trim()) headers['access-control-allow-origin'] = own;
  }
  return headers;
}

function originOf(address: string): string | undefined {
  try {
    const origin = new URL(address).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Whether an answer from another origin lets the page read it: `*` (no credentials leave anyway) or the page's own origin. */
function corsAllows(answer: Answer, origin: string | undefined): boolean {
  const allowed = answer.headers.find(([name]) => name === 'access-control-allow-origin')?.[1].trim();
  return allowed === '*' || (allowed !== undefined && origin !== undefined && allowed === origin.trim());
}

/** The frame of a request, when Playwright knows it. */
function frameObject(request: Request): Frame | undefined {
  try {
    return request.frame();
  } catch {
    return undefined;
  }
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** A request with the cookie of the jar of the core, or none: never one a caller left on it. */
function withCookie(request: ResourceInput, cookie: string | undefined): ResourceInput {
  const next: ResourceInput = { url: request.url, method: request.method, headers: request.headers, type: request.type, ...(request.body === undefined ? {} : { body: request.body }) };
  return cookie === undefined ? next : { ...next, cookie };
}

/**
 * The site a form of the user may go to (D-276): the site of the page it is
 * sent from (the frame's address before the navigation), when the form goes
 * to that site or a subdomain and, once the browser has an access, that site
 * is the one of the access. Undefined: the form stays refused.
 */
export function userFormSite(request: Pick<Request, 'frame'>, address: string, accessSite: string | undefined): string | undefined {
  let pageSite: string | undefined;
  let host: string;
  try {
    pageSite = siteOf(request.frame().url());
    host = new URL(address).hostname;
  } catch {
    return undefined;
  }
  if (pageSite === undefined || pageSite === '' || !onSite(host, pageSite)) return undefined;
  if (accessSite !== undefined && pageSite !== accessSite) return undefined;
  return pageSite;
}

/**
 * Attaches the network of a job to the context of the browser: call it
 * before the first navigation. Every request of every page of the context,
 * popups and iframes included, is decided here.
 */
export async function attachNetwork(context: BrowserContext, job: NetworkJob): Promise<NetworkHandle> {
  const budget = job.budget ?? new BrowserBudget();
  const ownPool = job.pool === undefined;
  const pool = job.pool ?? createResourcePool({ ...(job.resolve === undefined ? {} : { resolve: job.resolve }), ...(job.unsafeTestAddresses === undefined ? {} : { unsafeTestAddresses: job.unsafeTestAddresses }) });
  const network: ResourceOptions = {
    userAgent: job.userAgent,
    pool,
    ...(job.resolve === undefined ? {} : { resolve: job.resolve }),
    ...(job.unsafeTestAddresses === undefined ? {} : { unsafeTestAddresses: job.unsafeTestAddresses }),
    ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
  };
  const download = job.fetchResource ?? fetchResource;
  // The session of the job may change between two actions (D-264, passo 3): read at each request, never kept.
  let scope: NetworkScope = { context: job.context, consent: job.consent, ...(job.meta === undefined ? {} : { meta: job.meta }) };
  const counts: Record<string, Record<string, number>> = {};
  const limitsSent = new Set<LimitKind>();
  /** The final answer of a redirected frame, for the next navigation of that frame only: address without fragment → answer. */
  const finals = new Map<string, { answer: Answer; at: number; main: boolean; frame: Frame }>();
  /** Asked address of a frame moved by movePage → its final address. */
  const moved = new Map<string, string>();
  /** The cookie jar of the site of the access (D-276): null until the first form of the user. */
  let session: CookieJar | null = null;
  /** Sends of Arianna held in the Private chat of an access (D-281): the click that caused one asks the user. */
  let held = 0;
  /** Cookies of the navigations of the user, waiting for a form to their site; never sent. */
  const pending = new Map<string, CookieJar>();
  let closed = false;
  // Read through a function: the handler awaits, and close() may run meanwhile.
  const isClosed = (): boolean => closed;
  /** Aborted by close(): requests waiting for the network or downloading stop. */
  const stopping = new AbortController();
  const inFlight = new Set<Promise<void>>();
  const interrupted: ResourceResult = { ok: false, reason: 'interrupted' };
  /** The network part, never once the job is closing. */
  const fetchOne = (input: ResourceInput, options: ResourceOptions, signal?: AbortSignal): Promise<ResourceResult> =>
    closed ? Promise.resolve(interrupted) : download(input, options, signal ?? stopping.signal);

  const emit = (event: NewEvent): void => {
    try {
      job.onEvent?.(event);
    } catch {
      console.warn('browser: an event of the network could not be recorded');
    }
  };
  const count = (type: CountedType, outcome: RequestOutcome, url: string, kind: string, reason?: ResourceFailure): void => {
    const row = (counts[type] ??= {});
    row[outcome] = (row[outcome] ?? 0) + 1;
    job.trace?.({ url, type, kind, outcome, ...(reason === undefined ? {} : { reason }) });
  };
  const limit = (kind: LimitKind): void => {
    if (limitsSent.has(kind)) return;
    limitsSent.add(kind);
    emit({ kind: 'browser.limit', label: 'L0', payload: { limit: kind }, ...meta() });
  };
  const meta = (): Pick<NewEvent, 'taskId' | 'runId'> => ({ ...(scope.meta?.taskId === undefined ? {} : { taskId: scope.meta.taskId }), ...(scope.meta?.runId === undefined ? {} : { runId: scope.meta.runId }) });
  let last: LastNavigation | undefined;
  const navigated = (outcome: RequestOutcome, site?: string, reason?: ResourceFailure): void => {
    last = { seq: (last?.seq ?? 0) + 1, outcome, ...(site === undefined ? {} : { site }), ...(reason === undefined ? {} : { reason }) };
    // The site only of an address the gateway let go: a refused one may carry what it was refused for.
    // After an access (D-276) never: what the user does on that site says something of the user.
    const logged = session === null ? site : undefined;
    emit({ kind: 'browser.navigate', label: scope.context.effective, payload: { outcome, ...(logged === undefined ? {} : { site: logged }), ...(reason === undefined ? {} : { reason }) }, ...meta() });
  };

  /**
   * The Set-Cookie lines of an answer (D-276): kept by the jar of the access
   * for its site; before an access, for a main page the user navigated to,
   * waiting for a form to that site. Anything else is dropped, as before.
   */
  const keepCookies = (result: ResourceResult, address: string, main: boolean): void => {
    if (!result.ok || result.setCookies === undefined) return;
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return;
    }
    if (session !== null) {
      session.store(result.setCookies, url, Date.now());
      return;
    }
    const site = siteOf(url.href);
    // Arianna's navigations too: the page of the access is often the one she read (a CSRF cookie); never sent before a form of the user.
    if (!main || site === undefined) return;
    let jar = pending.get(site);
    if (jar === undefined) {
      if (pending.size >= MAX_PENDING_SITES) pending.delete(pending.keys().next().value ?? '');
      jar = new CookieJar(site);
      pending.set(site, jar);
    }
    jar.store(result.setCookies, url, Date.now());
  };
  /** The label of what a request carries: the session's, L2 once the browser has an access. */
  const requestLabel = (): Label => (session === null ? scope.context.effective : 'L2');

  /** One hop of a main page: the gateway as a page (second scanner included), then the download. */
  const pageHop = async (address: string, hop: number, request: ResourceInput): Promise<ResourceResult> => {
    const url = resourceUrl(address, network);
    if (typeof url === 'string') return { ok: false, reason: url };
    // A page is its address only: a body (a 307/308 of a form) goes through formHop, never here.
    if (request.body !== undefined) return { ok: false, reason: 'blocked' };
    // After an access (D-276): the site of the access as `session`, with its cookies; any other carries L2 and is refused.
    const jar = session;
    // Only https: the cookies of the access never travel in clear (D-276).
    const onAccess = jar !== null && url.protocol === 'https:' && onSite(url.hostname, jar.site);
    const method = request.method.toUpperCase() === 'POST' ? 'POST' : 'GET';
    const target: Target = onAccess ? { kind: 'web', session: { site: jar.site, type: 'document', method } } : { kind: 'web', page: navigationConsent(scope.consent, url.href, hop) };
    let allowed: string | undefined;
    try {
      const decision = await passGateway(job.sql, [{ value: url.href, label: requestLabel(), source: 'web:page' }], scope.context, target, scope.meta);
      if (decision.decision === 'allow') {
        const spent = spendAllowed(decision);
        allowed = spent?.target.kind === 'web' && (spent.target.page !== undefined || spent.target.session !== undefined) ? spent.texts[0] : undefined;
      }
    } catch {
      allowed = undefined;
    }
    // Closed while the gateway decided: nothing is requested.
    if (isClosed()) return interrupted;
    if (allowed !== url.href) return { ok: false, reason: 'blocked' };
    const cookie = onAccess ? jar.header(url, Date.now()) : undefined;
    const result = await fetchOne(withCookie({ ...request, url: allowed, type: 'document' }, cookie), network, stopping.signal);
    keepCookies(result, allowed, true);
    return result;
  };

  /**
   * The first hop of a form the user sent while driving (D-276): to the site
   * of the page it was sent from, through the gateway as `form` (its address
   * and size, never its content), then sent as the user wrote it. The first
   * form to a site makes the cookies waiting for it the jar of the access.
   */
  const formHop = async (request: ResourceInput, site: string): Promise<ResourceResult> => {
    const url = resourceUrl(request.url, network);
    if (typeof url === 'string') return { ok: false, reason: url };
    // A form of the user leaves only over https: what the user wrote never travels in clear (D-276).
    if (url.protocol !== 'https:') return { ok: false, reason: 'blocked' };
    const bytes = request.body?.length ?? 0;
    if (bytes > MAX_FORM_BODY) return { ok: false, reason: 'body-too-large' };
    let allowed: string | undefined;
    try {
      const decision = await passGateway(job.sql, [{ value: url.href, label: 'L2', source: 'browser:form' }], scope.context, { kind: 'web', form: { site, bytes } }, scope.meta);
      if (decision.decision === 'allow') {
        const spent = spendAllowed(decision);
        allowed = spent?.target.kind === 'web' && spent.target.form !== undefined ? spent.texts[0] : undefined;
      }
    } catch {
      allowed = undefined;
    }
    if (isClosed()) return interrupted;
    if (allowed !== url.href) return { ok: false, reason: 'blocked' };
    // The browser has an access from here on: everything it asks carries L2.
    if (session === null) {
      session = pending.get(site) ?? new CookieJar(site);
      pending.clear();
      // L0 without the site: which site the user signs in to says something of the user (the gateway log keeps it, locally).
      emit({ kind: 'browser.access', label: 'L0', payload: {}, ...meta() });
    }
    const cookie = session.header(url, Date.now());
    const result = await fetchOne(withCookie({ ...request, url: allowed, type: 'document' }, cookie), network, stopping.signal);
    keepCookies(result, allowed, true);
    return result;
  };

  /** Whether an iframe may navigate to `address`: always with `public`; with `user` or `sites` only on the sites `navigationConsent` allows after the first page. */
  const frameOnSites = (address: string): boolean => {
    if (scope.consent.from === 'public') return true;
    const allowedConsent = navigationConsent(scope.consent, address, 1);
    let host: string;
    try {
      host = new URL(address).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return false;
    }
    if (allowedConsent.from === 'sites') return allowedConsent.sites.some((site) => host === site || host.endsWith(`.${site}`));
    if (allowedConsent.from === 'user') return allowedConsent.addresses.some((written) => withoutHash(written) === withoutHash(address));
    return true;
  };

  /** One hop of any other request: gateResource, the gateway as a resource; an iframe on the sites of its consent first. */
  const resourceHop = async (request: ResourceInput, frameNavigation: boolean): Promise<ResourceResult> => {
    if (frameNavigation && !frameOnSites(request.url)) return { ok: false, reason: 'other-site' };
    // After an access (D-276): the cookies of the jar, which gateResource sends only for a request of its site.
    const jar = session;
    let cookie: string | undefined;
    try {
      cookie = jar?.header(new URL(request.url), Date.now());
    } catch {
      cookie = undefined;
    }
    const result = await gateResource({
      sql: job.sql,
      context: scope.context,
      consent: scope.consent,
      request: withCookie(request, cookie),
      network,
      ...(jar === null ? {} : { session: jar.site }),
      ...(scope.meta === undefined ? {} : { meta: scope.meta }),
      signal: stopping.signal,
      fetchResource: fetchOne,
    });
    if (jar !== null) keepCookies(result, request.url, false);
    return result;
  };

  /** Follows up to MAX_REDIRECTS hops, each through the gateway and counted in the requests; the final answer and its address. */
  const follow = async (
    first: ResourceInput,
    already: number,
    hop: (request: ResourceInput, index: number) => Promise<ResourceResult>,
  ): Promise<{ result: ResourceResult; final: string; tooMany: boolean; limited?: LimitKind }> => {
    let request = first;
    for (let index = already; ; index += 1) {
      if (index > already) {
        const reached = budget.take(false);
        if (reached !== null) return { result: { ok: false, reason: 'blocked' }, final: request.url, tooMany: false, limited: reached };
      }
      const result = await hop(request, index);
      if (!result.ok || result.location === undefined) return { result, final: request.url, tooMany: false };
      // The hop that would be the fourth redirect is never asked.
      if (index >= MAX_REDIRECTS) return { result, final: request.url, tooMany: true };
      // As browsers do: 303, and 301/302 of a POST, go on as GET without a body; 307 and 308 keep both.
      const keep = result.status === 307 || result.status === 308;
      const method = keep || request.method.toUpperCase() === 'HEAD' ? request.method : 'GET';
      request = { url: result.location, method, headers: request.headers, type: request.type, ...(keep && request.body !== undefined ? { body: request.body } : {}) };
    }
  };

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = request.url();
    const method = request.method().toUpperCase();
    const frame = frameOf(request);
    const counted: CountedType = frame.main ? 'page' : (resourceTypeOf(request.resourceType(), method) ?? 'other');
    const abort = async (outcome: RequestOutcome, reason?: ResourceFailure): Promise<void> => {
      count(counted, outcome, url, request.resourceType(), reason);
      await route.abort(reason === undefined ? 'blockedbyclient' : abortCode(reason)).catch(() => undefined);
    };
    if (closed) {
      await abort('refused');
      return;
    }
    // 1. Only http(s).
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = '';
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      await abort('refused', 'invalid-url');
      return;
    }
    // The final answer of a redirected frame, already through the gateway: the one next navigation of that frame.
    const key = withoutHash(url) ?? url;
    const kept = frame.navigation && method === 'GET' ? finals.get(key) : undefined;
    if (kept !== undefined && kept.main === frame.main && kept.frame === frameObject(request)) {
      finals.delete(key);
      if (Date.now() - kept.at <= KEEP_FINAL_MS) {
        count(counted, kept.answer.status >= 400 ? 'http-error' : 'ok', url, request.resourceType());
        await route.fulfill({ status: kept.answer.status, headers: fulfillHeaders(kept.answer, undefined, url), body: kept.answer.body }).catch(() => undefined);
        return;
      }
    }
    // 2. The limits of the job.
    const reached = budget.take(frame.main);
    if (reached !== null) {
      limit(reached);
      if (frame.main) navigated('limit');
      await abort('limit');
      return;
    }
    // 3a. The Private chat of an access (D-281): Arianna sends nothing to the site without «Invia» for this action.
    const agentInChat = scope.driver !== 'user' && scope.context.browserSite !== undefined && session !== null;
    if (agentInChat && method !== 'GET' && method !== 'HEAD' && scope.send !== true) {
      held += 1;
      if (frame.main) navigated('form');
      await abort('form');
      return;
    }
    // 3. No form sent by a frame, main or not; a form of the user to the site of its page excepted (D-276),
    // and one of Arianna in the Private chat of the access with «Invia» (D-281).
    let formSite: string | undefined;
    if (frame.navigation && method !== 'GET') {
      formSite = frame.main && method === 'POST' && (scope.driver === 'user' || agentInChat) ? userFormSite(request, url, session?.site) : undefined;
      if (formSite === undefined) {
        if (frame.main) navigated('form');
        await abort('form');
        return;
      }
    }
    const type = frame.main ? 'document' : resourceTypeOf(request.resourceType(), method);
    if (type === undefined) {
      await abort('refused');
      return;
    }
    const before = redirectsBefore(request);
    if (before > MAX_REDIRECTS) {
      if (frame.main) navigated('too-many-redirects');
      await abort('too-many-redirects');
      return;
    }
    const headers = await request.allHeaders().catch(() => request.headers());
    const body = request.postDataBuffer();
    const input: ResourceInput = { url, method, headers, type, ...(body === null ? {} : { body }) };
    // 4. A main page through the gateway as a page; 5. anything else as a resource.
    const site = formSite;
    const { result, final, tooMany, limited } = frame.main
      ? await follow(input, before, (next, index) => (site !== undefined && (index === before || next.body !== undefined) ? formHop(next, site) : pageHop(next.url, index, next)))
      : await follow(input, before, (next) => resourceHop(next, frame.navigation));
    if (isClosed()) {
      await abort('refused', 'interrupted');
      return;
    }
    if (limited !== undefined) {
      limit(limited);
      if (frame.main) navigated('limit');
      await abort('limit');
      return;
    }
    if (!result.ok) {
      // `blocked`: the gateway refused this hop (its row says why); anything else: the network or the answer.
      const outcome: RequestOutcome = result.reason === 'blocked' ? 'blocked' : result.reason === 'private-address' || result.reason === 'invalid-url' || result.reason === 'invalid-request' || result.reason === 'body-too-large' || result.reason === 'unreadable-body' || result.reason === 'insecure-redirect' || result.reason === 'other-site' ? 'refused' : 'failed';
      // The site only of an address the gateway let go (a failure of the network after it).
      if (frame.main) navigated(outcome, outcome === 'failed' ? siteOf(final) : undefined, result.reason);
      await abort(outcome, result.reason);
      return;
    }
    if (tooMany) {
      if (frame.main) navigated('too-many-redirects', siteOf(final));
      await abort('too-many-redirects');
      return;
    }
    const over = budget.addBytes(result.body.length);
    if (over !== null) {
      limit(over);
      if (frame.main) navigated('limit', siteOf(final));
      await abort('limit');
      return;
    }
    const origin = headerOf(headers, 'origin');
    const crossRedirect = originOf(final) !== originOf(url);
    // A script call redirected to another origin is read by the page as if from its first address: only when that origin allows the page.
    if (type === 'fetch' && crossRedirect && !corsAllows(result, origin ?? originOf(url))) {
      await abort('refused', 'cors');
      return;
    }
    const outcome: RequestOutcome = result.status >= 400 ? 'http-error' : 'ok';
    if (frame.main) navigated(outcome === 'ok' ? 'ok' : 'http-error', siteOf(final));
    count(counted, outcome, url, request.resourceType());
    const movedAway = (withoutHash(final) ?? final) !== (withoutHash(url) ?? url);
    if (frame.navigation && movedAway) {
      // The frame goes to its true address and origin. The answer waits there for this frame only;
      // a frame Playwright does not know yet keeps nothing: its next navigation is asked again.
      const owner = frameObject(request);
      if (owner !== undefined) finals.set(withoutHash(final) ?? final, { answer: result, at: Date.now(), main: frame.main, frame: owner });
      moved.set(withoutHash(url) ?? url, final);
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: movePage(final) }).catch(() => undefined);
      return;
    }
    await route.fulfill({ status: result.status, headers: fulfillHeaders(result, origin, final), body: result.body }).catch(() => undefined);
  };
  const tracked = (route: Route): Promise<void> => {
    const run = handler(route).catch(async () => {
      await route.abort('failed').catch(() => undefined);
    });
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
    return run;
  };

  await context.route('**/*', tracked);

  return {
    budget,
    rescope(next) {
      const before = scope.driver;
      scope = {
        context: next.context,
        consent: next.consent,
        ...(next.meta === undefined ? {} : { meta: next.meta }),
        ...(next.driver === undefined ? {} : { driver: next.driver }),
        ...(next.send === true ? { send: true } : {}),
      };
      // Given back without a form: the cookies that waited for one go (D-276).
      if (before === 'user' && next.driver !== 'user') pending.clear();
    },
    authenticated: () => session?.site ?? null,
    heldSends: () => held,
    counts: () => structuredClone(counts),
    lastNavigation: () => (last === undefined ? undefined : { ...last }),
    async settle(page, timeoutMs = 15_000) {
      for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
        const key = withoutHash(page.url()) ?? page.url();
        const final = moved.get(key);
        if (final === undefined) return;
        moved.delete(key);
        await page.waitForURL((current) => current.href === final, { waitUntil: 'load', timeout: timeoutMs }).catch(() => undefined);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      session = null;
      pending.clear();
      stopping.abort();
      await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
      // The counts are final only when every request under way has ended or stopped.
      await Promise.allSettled([...inFlight]);
      emit({ kind: 'browser.network', label: 'L0', payload: { pages: budget.pages, requests: budget.requests, bytes: budget.bytes, counts: structuredClone(counts), limits: [...limitsSent] }, ...meta() });
      if (ownPool) pool.destroy();
    },
  };
}
