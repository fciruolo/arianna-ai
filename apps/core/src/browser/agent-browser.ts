import { randomBytes } from 'node:crypto';

import { createContext, spendAllowed, type Context, type PageConsent, type Target } from '@arianna/policy';
import type { Page } from 'playwright-core';

import type { Sql } from '../db/client.ts';
import type { NewEvent } from '../events.ts';
import { passGateway, type GatewayMeta } from '../gateway.ts';
import { siteOf } from '../link-fetch.ts';
import { BrowserError } from './container.ts';
import type { BrowserManager } from './manager.ts';
import { coveredBy, navigationConsent, withWritten, type NetworkJob, type NetworkScope, type RequestOutcome } from './network.ts';
import type { ResourceFailure } from './resource-fetch.ts';
import { connectSession, type BrowserSession, type SessionOptions } from './session.ts';

/**
 * The browser of Arianna in a chat (D-264, passo 3). One browser for the
 * installation (BrowserManager), held by one conversation at a time («Per
 * conversazione», 2026-10-21): it stays open between the answers of that
 * conversation until 15 minutes without actions, 30 in all, or
 * `browser.close`. Another conversation takes it only when it has been
 * unused for TAKE_OVER_MS («Lo prende se fermo da 2 minuti»): the first one
 * is told by onTaken; while in use, «occupato».
 *
 * Every action runs one at a time. The context and the consent of the
 * session are those of the step that acts, set again at each action
 * (NetworkHandle.rescope): a conversation that went from Public to Internal
 * clicks from then on with the `user` consent.
 *
 * What the model gets of a page is read by a fixed script of the core
 * (READ_SCRIPT), never by code of the model: the visible text and a numbered
 * list of the elements, never the value of a field; a password field is
 * listed as not to be used and nothing is typed in it. The numbers are kept
 * on the elements of the page as an attribute: a hostile page can move them,
 * and then a click lands on another element of the same page; every
 * navigation it causes passes the network of the job (D-267) all the same.
 * The same holds for what the script reads in the world of the page (the
 * kind of a field, the address of a link): a page can make a password field
 * look like a text field, or show another address on the card «Apri / No».
 * The text typed has passed the gateway before, and every page the browser
 * then loads passes the network: those stay the boundary. The address and
 * the title of a reading come from Playwright, not from the script.
 *
 * In an Internal conversation `browser.open` takes only an address the user
 * wrote (or opened from a card), as web.fetch: any other waits for the user;
 * the sites of those addresses count for clicks and redirects only.
 * Every action has a deadline (ACTION_LIMIT_MS): a page that hangs the
 * browser loses it, never the queue nor the shutdown of the core.
 *
 * «Prendi il controllo» (D-264, passo 5): the control is `agent` or `user`.
 * takeControl waits for the action under way (bounded by ACTION_LIMIT_MS),
 * never in the middle of one; while the user drives, every action of the
 * conversation answers `paused` and every action of another one `busy`
 * (never taken over, however long the browser stays without actions of
 * Arianna). The network decides the requests of the user without the task of
 * Arianna (no task in gateway_log). Given back, the first action must be a
 * reading (`reread`): the page is no longer the one Arianna read. Input of
 * the user counts as activity for the 15 minutes; the 30 stay.
 *
 * After an access made by the user (D-276: a form of the user, then the
 * cookies of that site) the pages are Private (L2). A conversation with the
 * browser tools is a work conversation, cleared for L1: a read above the
 * clearance is denied (docs/PRIVACY-POLICY-SPEC.md, rule 9). So every
 * action of Arianna there but browser.close answers `authenticated`.
 *
 * «Nuova chat Privata» (D-281): given back by the user, the browser with an
 * access passes to a Private chat born for it (handOver, in the queue of the
 * actions): its scope is the context of that chat, marked with the site of
 * the access (`browserSite`), and the consent of that site only. There
 * Arianna reads and acts, on that site only (`outside-access` elsewhere);
 * every send of hers to the site (a form, a POST of the page's scripts) is
 * held by the network until the user approves it: the click or the typing
 * that caused one answers `confirm-send`, and the action after an «Invia»
 * (`sendPermit`, used once) may send. A browser with an access is never
 * taken over by another conversation.
 *
 * The saved private values of the user (D-283): the address of a page and a
 * typed text are compared by the gateway with the clients and contacts the
 * user saved, instead of the second scanner (which is no longer started for
 * the browser). An action that would let one out answers `confirm-private`
 * with its references, and the chat asks «Apri / No». The values the user
 * let go hold for this browser until it closes (`saved` of the scope, merged
 * into the browser it was read for); every request of the browser, the
 * user's included while driving, is compared with the others.
 */

export const TAKE_OVER_MS = 2 * 60_000;
export const MAX_ELEMENTS = 80;
export const MAX_TYPED = 200;
/** Text of the page the script returns; the tool cuts it again for the model. */
const MAX_SCRIPT_TEXT = 20_000;
const ACTION_MS = 5_000;
/** How long the check of a login form on the screen of the user may take (D-287): it runs every few seconds. */
const LOGIN_CHECK_MS = 1_000;
const LOAD_MS = 15_000;
const NAVIGATION_START_MS = 1_500;
/** Longest an action may take: a load and the redirects followed after it, with a margin. */
export const ACTION_LIMIT_MS = 45_000;
export const REF_ATTRIBUTE = 'data-arianna-ref';

export type ElementKind = 'link' | 'button' | 'field' | 'password' | 'choice' | 'select';

export interface PageElement {
  ref: number;
  kind: ElementKind;
  label: string;
  /** link: the whole address, for the consent of the core; the model reads only its site. */
  href?: string;
  /** field: the type of the input (text, search, email…), `textarea` for a text area. */
  type?: string;
  /**
   * Where the element is (D-287), from the landmarks of the page: `main` (main,
   * article), `nav`, `aside`, `header` and `footer` of the page; absent when
   * the page marks none around it.
   */
  area?: ElementArea;
  /** A link that is a heading or holds one (D-287), as the title of a search result. */
  heading?: true;
  /** The form the element belongs to, numbered within one reading (D-287): a login is a user field and its button in one form. */
  form?: number;
}

export type ElementArea = 'main' | 'nav' | 'aside' | 'header' | 'footer';
const AREAS: readonly string[] = ['main', 'nav', 'aside', 'header', 'footer'];

export interface PageReading {
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
  /** Percentage of the page scrolled, 0-100. */
  scrolled: number;
}

/** What an action did. `confirm`: a link to a site the consent does not cover, waiting for the user. */
export type ActionResult =
  | { ok: true; page: { url: string; site: string; title: string }; reading?: PageReading; typed?: number }
  | { ok: false; reason: ActionFailure; site?: string; network?: ResourceFailure | RequestOutcome }
  | { ok: false; reason: 'confirm'; url: string; site: string }
  /** The Private chat of an access (D-281): the action tried to send data to the site; the user decides with «Invia / No». */
  | { ok: false; reason: 'confirm-send'; site: string; element: string }
  /** A saved private value of the user would leave (D-283): its references, never the values; the user decides with «Apri / No». */
  | { ok: false; reason: 'confirm-private'; saved: readonly string[]; site?: string; ask?: string };

export type ActionFailure =
  | 'busy'
  /** The user drives the browser (D-264, passo 5): Arianna does nothing in it. */
  | 'paused'
  /** The user gave the browser back: the page must be read again before anything else. */
  | 'reread'
  /**
   * The browser has an access made by the user (D-276): what it shows is
   * Private (L2), above the clearance of a work conversation (rule 9), so
   * Arianna neither reads it nor acts in it; only browser.close.
   */
  | 'authenticated'
  /** The Private chat of an access (D-281): an address or a link outside the site of the access. */
  | 'outside-access'
  | 'not-installed'
  | 'start-failed'
  | 'not-open'
  /** The user closed the browser from the chat: said once, to the next action of that conversation. */
  | 'closed-by-user'
  | 'no-reading'
  /** The tab shows no page (blank, or Chromium's error page after a refused open): nothing to read. */
  | 'no-page'
  | 'unknown-element'
  | 'not-clickable'
  | 'not-a-field'
  | 'password-field'
  | 'too-long'
  | 'typed-blocked'
  | 'navigation-blocked'
  | 'navigation-failed'
  | 'action-failed';

/** A command of the bar above the screen (D-286). `ask`: «Apri» on the question of a saved value, by the token of that question. */
export type UserCommand = { kind: 'back' | 'forward' | 'reload' } | { kind: 'open'; url: string; ask?: string };

/** How long after a click or a key of the user a navigation counts as chosen by the user (D-286). */
export const GESTURE_MS = 1_500;
/** How long a question of the bar about a saved value waits for «Apri» (D-286). */
export const ASK_MS = 5 * 60_000;
/** Conversations whose pages chosen by the user are kept at most (D-286): the oldest go. */
export const MAX_USER_CONVERSATIONS = 50;

/** Addresses the user opened in one conversation kept at most (D-286): the gateway takes 200 in a consent. */
export const MAX_USER_ADDRESSES = 100;

export type BrowserAction =
  | { kind: 'open'; url: string }
  | { kind: 'read' }
  | { kind: 'click'; ref: number }
  | { kind: 'type'; ref: number; text: string; submit: boolean }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'close' };

/** Who drives the browser of a conversation (D-264, passo 5). */
export type Driver = 'agent' | 'user';

/** The answer of takeControl: `waiting` while an action of Arianna ends first; `done` says whether the user drives. */
export interface ControlRequest {
  waiting: boolean;
  done: Promise<boolean>;
}

/** A navigation refused while the user drove, for the chat (D-264, passo 5): its number, never its address. */
export interface BlockedNavigation {
  seq: number;
  outcome: 'blocked' | 'refused' | 'form' | 'limit';
  site?: string;
}

/** The session of the step that acts. */
export interface BrowserScope {
  conversationId: string;
  context: Context;
  consent: PageConsent;
  meta?: GatewayMeta;
  /**
   * The Private chat of an access (D-281): an approval «Invia» of the user,
   * with the element it was asked for. The next click, or typing with Enter,
   * on that same element may send to the site of the access, once.
   */
  sendPermit?: { id: string; element: string };
  /**
   * The saved private values the user let go with «Apri» (D-283), read for
   * the browser opened at `opened` (`openedAt`), or with `opened: null` for
   * the browser this action opens (`savedFor`): merged into that browser
   * only, never into another one. The network of the browser reads the very
   * set it is merged into.
   */
  saved?: { opened: number | null; approved: ReadonlySet<string> };
}

/** The gateway on a typed text: true when it may be typed; the references of saved values to ask the user about (D-283). */
export type TypedVerdict = boolean | { saved: readonly string[] };

export type OpenSession = (browser: BrowserManager, id: string, network: Omit<NetworkJob, 'userAgent'>) => Promise<BrowserSession>;

export interface AgentBrowserOptions {
  sql: Sql;
  manager: BrowserManager;
  session: Omit<SessionOptions, 'network'>;
  /** The gateway on a text to type (target `web` with `typed`), with the saved values the user let go in this browser (D-283). */
  gateTyped: (text: string, scope: BrowserScope, approved: ReadonlySet<string>) => Promise<TypedVerdict>;
  onEvent?: (event: NewEvent) => void;
  /** The browser of `conversationId` was closed for another conversation. */
  onTaken?: (conversationId: string) => void;
  /**
   * The conversation no longer holds the browser (closed, taken, released,
   * or closed by the manager): the screens of passo 4 close at once.
   */
  onReleased?: (conversationId: string) => void;
  now?: () => number;
  takeOverMs?: number;
  /** Tests: opens the session instead of starting a container. */
  openSession?: OpenSession;
  /** Tests: the deadline of an action (ACTION_LIMIT_MS). */
  actionLimitMs?: number;
  /**
   * The saved private values of the user in an address (D-283), not among
   * `approved`: their references, checked before a page is asked (browser.open,
   * the click on a link), so that the card «Apri / No» comes at once; the
   * network refuses the page all the same. Nothing leaves for this check.
   */
  savedIn?: (address: string, approved: ReadonlySet<string>) => readonly string[];
  /** Tests: the network job options the core never sets (fake servers). */
  network?: Pick<NetworkJob, 'unsafeTestAddresses' | 'resolve' | 'fetchResource' | 'timeoutMs'>;
}

interface Held {
  conversationId: string;
  id: string;
  session: BrowserSession;
  lastAction: number;
  /** The elements of the last reading of the current page, by number. */
  elements: Map<number, PageElement>;
  /** The address the reading was made on: a reading of another page does not hold. */
  readAt: string | undefined;
  /** The site of the page after the last action that reached one: the bar of the chat shows it (D-264, passo 4). */
  site?: string;
  /** Who drives (D-264, passo 5). */
  driver: Driver;
  /** The last scope of an action of Arianna: the network of the user goes on with it, without the task. */
  scope: BrowserScope;
  /** Given back by the user: the next action of Arianna must read the page. */
  reread: boolean;
  /** The last navigation decided when the user took the control: what is refused after it is shown in the chat. */
  seqAtTake: number;
  /** The work conversation the browser came from, once handed to a Private chat after an access (D-281). */
  from?: string;
  /** When this browser opened (now()): the cards of saved values asked with it hold for it (D-283). */
  opened: number;
  /** When the browser of this conversation before it opened, if any: the cards asked with that one hold for this one too. */
  previous: number | null;
  /** The saved private values the user let go for this browser (D-283); the network reads this very set. */
  saved: Set<string>;
  /** The last click or key of the user on the screen that drives (D-286), and whether a navigation took it. */
  gestureAt: number;
  gestureUsed: boolean;
}

const defaultOpenSession = (home: Omit<SessionOptions, 'network'>): OpenSession => async (manager, id, network) => {
  const open = await manager.start(id);
  return connectSession(open, { ...home, network });
};

/** Container ids: random, so a new browser never waits for the name of one still being removed. */
function browserId(): string {
  return `chat-${randomBytes(6).toString('hex')}`;
}

export class AgentBrowser {
  readonly #options: AgentBrowserOptions;
  readonly #now: () => number;
  #held: Held | null = null;
  /**
   * The check of a login form under way and its last answer (D-287): the
   * screen asks every few seconds, and a page that hangs never ends the
   * script; while one runs, the next read gets the last answer.
   */
  #loginCheck: { session: BrowserSession; running: boolean; answer: boolean } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #running = false;
  /** Conversations whose browser the user closed: their next action hears it once (D-264, passo 4). */
  readonly #closedByUser = new Set<string>();
  #shutDown = false;
  /** When the last browser of each conversation opened (D-283): a card asked with it holds for the next one. In memory. */
  readonly #lastOpened = new Map<string, number>();
  /** Addresses the user opened while driving or from the bar (D-286), by conversation, newest first. In memory. */
  readonly #userAddresses = new Map<string, string[]>();
  /** Questions of the bar about a saved value (D-286), by token: «Apri» holds only for the one asked. */
  readonly #asks = new Map<string, { conversationId: string; url: string; refs: readonly string[]; at: number }>();
  /** A command of the bar of the user runs (D-286): the chat does not say Arianna is acting. */
  #userRunning = false;
  /** Approvals «Invia» already used (D-281): each lets one action send. */
  readonly #usedPermits = new Set<string>();

  constructor(options: AgentBrowserOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The conversation holding the browser, if any. */
  get holder(): string | null {
    this.#forgetClosed();
    return this.#held?.conversationId ?? null;
  }

  /** When the browser of `conversationId` opened (now()), when it holds one; null otherwise (D-283). */
  openedAt(conversationId: string): number | null {
    const held = this.#held;
    return this.holder === conversationId && held !== null ? held.opened : null;
  }

  /** The browser a card of saved values asked now belongs to (D-283): the one open, or the last one the conversation had; null if none. */
  lastOpenedAt(conversationId: string): number | null {
    return this.openedAt(conversationId) ?? this.#lastOpened.get(conversationId) ?? null;
  }

  /**
   * Which cards of saved values hold for the browser of `conversationId`
   * (D-283): with one open, those asked with it and with the browser before
   * it (`opened` its time); without, those for the browser the next action
   * opens (`opened: null`): asked with the last one, or before any.
   */
  savedFor(conversationId: string): { opened: number | null; browsers: number[]; none: boolean } {
    const held = this.#held;
    if (this.holder === conversationId && held !== null) {
      return { opened: held.opened, browsers: [held.opened, ...(held.previous === null ? [] : [held.previous])], none: held.previous === null };
    }
    const last = this.#lastOpened.get(conversationId);
    return { opened: null, browsers: last === undefined ? [] : [last], none: last === undefined };
  }

  /** The site the browser of `conversationId` is on, when it holds the browser and an action reached a page. */
  siteOf(conversationId: string): string | null {
    const held = this.#held;
    if (this.holder !== conversationId || held === null) return null;
    // The page the tab shows now (D-286: back and forward from the cache of Chromium have no navigation of the network).
    // For the bar and the label of the screen only: no decision of consent is made on it.
    const shown = held.session.currentUrl();
    if (shown !== null && /^https?:/i.test(shown)) {
      const site = siteOf(shown);
      if (site !== undefined && site !== '') return site;
    }
    // While the user drives the page changes without actions of Arianna: the network knows the last one.
    if (held.driver === 'user') {
      const last = held.session.network?.lastNavigation();
      if (last !== undefined && last.seq > held.seqAtTake && last.site !== undefined && (last.outcome === 'ok' || last.outcome === 'http-error')) return last.site;
    }
    return held.site ?? null;
  }

  /** The site of the access made by the user in the browser of `conversationId` (D-276); null when none. */
  accessOf(conversationId: string): string | null {
    const held = this.#held;
    if (this.holder !== conversationId || held === null) return null;
    return held.session.network?.authenticated() ?? null;
  }

  /** The Private chat holding the browser that came from the work conversation `conversationId` (D-281); null when none. */
  movedFrom(conversationId: string): string | null {
    const held = this.#held;
    if (held === null || this.holder === null || held.from !== conversationId) return null;
    return held.conversationId;
  }

  /**
   * «Nuova chat Privata» (D-281): the browser of `from`, with an access made
   * by the user and Arianna driving, passes to the Private chat `to`, after
   * the action under way (the queue), never in the middle of one. Its scope
   * becomes that chat's: a context marked with the site of the access, the
   * consent of that site only; the next action must read the page. The
   * screens of `from` close (onReleased). The site of the access, or null
   * when `from` no longer holds such a browser.
   */
  handOver(from: string, to: string): Promise<string | null> {
    const run = this.#queue.then(() => {
      this.#forgetClosed();
      const held = this.#held;
      if (held?.conversationId !== from || held.driver !== 'agent' || held.from !== undefined) return null;
      const site = held.session.network?.authenticated() ?? null;
      if (site === null) return null;
      const scope: BrowserScope = { conversationId: to, context: createContext('L2', 'L2', { browserSite: site }), consent: { from: 'sites', sites: [site] } };
      held.conversationId = to;
      held.from = from;
      held.scope = scope;
      held.reread = true;
      held.elements.clear();
      held.readAt = undefined;
      held.session.network?.rescope(networkScope(scope, 'agent', held.saved));
      this.#touch(held);
      this.#safely(() => { this.#options.onReleased?.(from); });
      return site;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Who drives the browser of `conversationId`; null when it holds none. */
  driverOf(conversationId: string): Driver | null {
    return this.holder === conversationId ? (this.#held?.driver ?? null) : null;
  }

  /** The last main page refused while the user drove (D-264, passo 5), for the chat; null when none. */
  blockedOf(conversationId: string): BlockedNavigation | null {
    const held = this.#held;
    if (this.holder !== conversationId || held === null || held.driver !== 'user') return null;
    const last = held.session.network?.lastNavigation();
    if (last === undefined || last.seq <= held.seqAtTake) return null;
    if (last.outcome !== 'blocked' && last.outcome !== 'refused' && last.outcome !== 'form' && last.outcome !== 'limit') return null;
    return { seq: last.seq, outcome: last.outcome, ...(last.site === undefined ? {} : { site: last.site }) };
  }

  /**
   * «Prendi il controllo» (D-264, passo 5): after the action under way, if
   * any (`waiting`), never in the middle of one. `done` is false when the
   * conversation does not hold the browser, then or once its turn came.
   */
  takeControl(conversationId: string): ControlRequest {
    if (this.holder !== conversationId) return { waiting: false, done: Promise.resolve(false) };
    const waiting = this.#running;
    const run = this.#queue.then(() => {
      this.#forgetClosed();
      const held = this.#held;
      if (held?.conversationId !== conversationId) return false;
      if (held.driver === 'user') return true;
      held.driver = 'user';
      held.reread = false;
      held.seqAtTake = held.session.network?.lastNavigation()?.seq ?? 0;
      // The requests of the user carry no task of Arianna in gateway_log.
      held.gestureUsed = true;
      held.session.network?.rescope(networkScope(held.scope, 'user', held.saved, held, this.#now));
      this.#touch(held);
      return true;
    });
    this.#queue = run.catch(() => undefined);
    return { waiting, done: run };
  }

  /**
   * «Restituisci ad Arianna», the screen closed, or no input for a while:
   * Arianna drives again, and reads the page first. False when the user did
   * not drive the browser of that conversation.
   */
  returnControl(conversationId: string): boolean {
    const held = this.#held;
    if (this.holder !== conversationId || held === null || held.driver !== 'user') return false;
    held.driver = 'agent';
    held.reread = true;
    held.elements.clear();
    held.readAt = undefined;
    held.session.network?.rescope(networkScope(held.scope, 'agent', held.saved));
    this.#touch(held);
    return true;
  }

  /** Input of the user on the screen that drives: counts as activity for the 15 minutes (never for the 30). */
  userInput(conversationId: string): void {
    const held = this.#held;
    if (held !== null && held.conversationId === conversationId && held.driver === 'user') this.#touch(held);
  }

  /**
   * A click or a key of the user on the screen that drives (D-286, from the
   * filter of the screen): the first navigation of the agent's tab to a new
   * site within GESTURE_MS counts as chosen by the user. A move of the mouse
   * is none.
   */
  userGesture(conversationId: string): void {
    const held = this.#held;
    if (held === null || held.conversationId !== conversationId || held.driver !== 'user') return;
    held.gestureAt = this.#now();
    held.gestureUsed = false;
  }

  /**
   * The addresses the user opened in the browser of `conversationId` while
   * driving or from the bar of the screen (D-286): written by the user for
   * the consent, as long as the core runs. Newest first.
   */
  userAddressesOf(conversationId: string): readonly string[] {
    return this.#userAddresses.get(conversationId) ?? [];
  }

  /**
   * Whether the element `ref` of the last reading is still the same on the
   * page (D-286: before the core makes a click or a typed text again after
   * «Apri»): the page is the one read, the page is read again in its place,
   * and the element at that number has the same kind, label and address (the
   * address of the card of a link, `href`, too). The new reading takes the
   * place of the old one. False otherwise, or when the browser is not this
   * conversation's with Arianna driving. In the queue of the actions.
   */
  sameElement(conversationId: string, ref: number, href?: string): Promise<boolean> {
    if (this.#shutDown || this.holder !== conversationId) return Promise.resolve(false);
    const run = this.#queue.then(async () => {
      const held = this.#held;
      if (held?.conversationId !== conversationId || held.driver !== 'agent' || held.reread) return false;
      const before = held.elements.get(ref);
      const page = await held.session.currentPage();
      if (before === undefined || held.readAt === undefined || held.readAt !== page.url()) return false;
      let reading: PageReading;
      try {
        reading = await withLimit(readPage(page), ACTION_MS);
      } catch {
        return false;
      }
      held.elements = new Map(reading.elements.map((element) => [element.ref, element]));
      held.readAt = page.url();
      const after = held.elements.get(ref);
      if (after === undefined || after.kind !== before.kind || after.label !== before.label || after.href !== before.href) return false;
      return href === undefined || (after.href !== undefined && withoutFragment(after.href) === withoutFragment(href));
    });
    this.#queue = run.catch(() => undefined);
    return run.catch(() => false);
  }

  /** Whether an action of Arianna runs now in the browser of `conversationId` (D-286: the bar of the screen is off meanwhile). */
  actingFor(conversationId: string): boolean {
    return this.#running && !this.#userRunning && this.#held?.conversationId === conversationId && this.#held.driver === 'agent';
  }

  /** The address of the page the browser of `conversationId` shows, for the bar of the screen (D-286); null when none. */
  urlOf(conversationId: string): string | null {
    const held = this.#held;
    if (this.holder !== conversationId || held === null) return null;
    const url = held.session.currentUrl();
    return url !== null && /^https?:/i.test(url) ? url : null;
  }

  /**
   * Whether the page the user drives shows a login form now (D-287): the
   * screen shows the note on what a login form does only then. LOGIN_SCRIPT,
   * outside the queue (it reads, it acts on nothing) and within a second;
   * false when the user does not drive the browser of `conversationId`, or
   * when the page does not answer. Never two at once: while the script of an
   * earlier check has not ended, the last answer of this browser.
   */
  async loginFormOf(conversationId: string): Promise<boolean> {
    const held = this.#held;
    if (this.#shutDown || this.holder !== conversationId || held === null || held.driver !== 'user') return false;
    const page = held.session.peekPage?.() ?? null;
    if (page === null || !/^https?:/i.test(page.url())) return false;
    const last = this.#loginCheck?.session === held.session ? this.#loginCheck : null;
    if (last?.running === true) return last.answer;
    const check = { session: held.session, running: true, answer: last?.answer ?? false };
    this.#loginCheck = check;
    // The script itself, not the deadline, ends the check: a hung page keeps it running.
    const script = page.evaluate(LOGIN_SCRIPT).finally(() => { check.running = false; });
    try {
      check.answer = asksLogin(parseReading(await withLimit(script, LOGIN_CHECK_MS)));
    } catch {
      check.answer = false;
    }
    return check.answer;
  }

  /**
   * Closes the browser after an answer of Arianna that says she closes it
   * (D-287: the local model wrote «chiudo il browser» without browser.close).
   * In the queue, as browser.close: only the browser of `conversationId`, and
   * never while the user drives it. True when it closed one.
   */
  closeAfterReply(conversationId: string): Promise<boolean> {
    if (this.#shutDown || this.holder !== conversationId) return Promise.resolve(false);
    const run = this.#queue.then(async () => {
      this.#forgetClosed();
      const held = this.#held;
      if (held?.conversationId !== conversationId || held.driver !== 'agent') return false;
      await this.#drop();
      return true;
    });
    this.#queue = run.catch(() => undefined);
    return run.catch(() => false);
  }

  /**
   * A command of the bar above the screen (D-286): ← Indietro, → Avanti,
   * ↻ Ricarica, or an address written in its field, which counts as written
   * by the user in the chat (a saved value asks first: `confirm-private`, and
   * `confirmed` lets it go for this browser). Never during an action of
   * Arianna (`agent-busy`); in the queue of the actions. The navigations go as
   * the user's (driver `user` for the network). If Arianna drove, her next
   * action reads the page first.
   */
  async userCommand(conversationId: string, command: UserCommand): Promise<ActionResult | { ok: false; reason: 'agent-busy' }> {
    if (this.#shutDown || this.holder !== conversationId) return { ok: false, reason: 'not-open' };
    if (this.#running) return { ok: false, reason: 'agent-busy' };
    const run = this.#queue.then(async () => {
      this.#forgetClosed();
      const held = this.#held;
      if (this.#shutDown || held?.conversationId !== conversationId) return { ok: false, reason: 'not-open' } satisfies ActionResult;
      /** Values let go by «Apri» for this command: taken back if the page does not go. */
      const lent: string[] = [];
      let written: string | undefined;
      if (command.kind === 'open') {
        let url: URL;
        try {
          url = new URL(command.url);
        } catch {
          return { ok: false, reason: 'navigation-failed' } satisfies ActionResult;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'navigation-failed' } satisfies ActionResult;
        const asked = this.#savedRefs(url.href, held.scope, held.saved);
        if (asked.length > 0) {
          // «Apri» only on the question asked for this very address in this conversation, and only once.
          const question = command.ask === undefined ? undefined : this.#asks.get(command.ask);
          if (command.ask !== undefined) this.#asks.delete(command.ask);
          const answered = question !== undefined && question.conversationId === conversationId && question.url === url.href && this.#now() - question.at <= ASK_MS;
          if (!answered || asked.some((ref) => !question.refs.includes(ref))) {
            const token = randomBytes(16).toString('hex');
            this.#pruneAsks();
            this.#asks.set(token, { conversationId, url: url.href, refs: asked, at: this.#now() });
            const site = siteOf(url.href);
            return { ok: false, reason: 'confirm-private', saved: asked, ask: token, ...(site === undefined ? {} : { site }) } satisfies ActionResult;
          }
          for (const ref of asked) if (!held.saved.has(ref)) { held.saved.add(ref); lent.push(ref); }
        }
        written = url.href;
      }
      const wasAgent = held.driver === 'agent';
      this.#running = true;
      this.#userRunning = true;
      // A command of the bar is no click on the page: a gesture before it is gone, and none is left after it.
      const commandStart = this.#now();
      held.gestureUsed = true;
      // As the user's, without a gesture: only the address written in the bar counts as written (back, forward and reload never choose a site).
      const userScope = networkScope({ ...held.scope, consent: withWritten(held.scope.consent, written) }, 'user', held.saved);
      held.session.network?.rescope(userScope);
      let result: ActionResult = { ok: false, reason: 'action-failed' };
      try {
        result = await this.#bounded(held, this.#command(held, command));
        // A new site only: one the consent already covered needs no note.
        if (result.ok && written !== undefined && !coveredBy(held.scope.consent, written)) this.#noteUserAddress(written, conversationId);
        return result;
      } catch {
        return result;
      } finally {
        // The values of «Apri» stay only if the page went.
        if (!result.ok) for (const ref of lent) held.saved.delete(ref);
        this.#running = false;
        this.#userRunning = false;
        // A click of the user during the command keeps its gesture; an older one is gone.
        if (held.gestureAt < commandStart) held.gestureUsed = true;
        if (this.#held === held) {
          this.#touch(held);
          if (wasAgent && held.driver === 'agent') {
            held.session.network?.rescope(networkScope(held.scope, 'agent', held.saved));
            held.reread = true;
            held.elements.clear();
            held.readAt = undefined;
          } else if (held.driver === 'user') {
            held.session.network?.rescope(networkScope(held.scope, 'user', held.saved, held, this.#now));
          }
        }
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #command(held: Held, command: UserCommand): Promise<ActionResult> {
    const { session } = held;
    const before = session.network?.lastNavigation()?.seq;
    try {
      if (command.kind === 'open') {
        held.elements.clear();
        held.readAt = undefined;
        const page = await session.openPage(new URL(command.url).href, LOAD_MS);
        return { ok: true, page: pageOf(page.url, page.title) };
      }
      const page = await session.history(command.kind, LOAD_MS);
      if (page === null) return { ok: false, reason: 'no-page' };
      return { ok: true, page: pageOf(page.url, page.title) };
    } catch {
      const last = session.network?.lastNavigation();
      if (last !== undefined && last.seq !== before) return navigationFailure(session);
      return { ok: false, reason: 'navigation-failed' };
    }
  }

  /** One action, after the ones already running. Never throws. */
  async act(scope: BrowserScope, action: BrowserAction): Promise<ActionResult> {
    // Shut down: no browser opens any more.
    if (this.#shutDown) return { ok: false, reason: 'not-open' };
    // Another conversation while an action runs: «occupato» at once, never a wait behind it.
    if (this.#running && this.#held !== null && this.#held.conversationId !== scope.conversationId) return { ok: false, reason: 'busy' };
    const run = this.#queue.then(async () => {
      this.#running = true;
      try {
        return await this.#act(scope, action);
      } catch {
        return { ok: false, reason: 'action-failed' } satisfies ActionResult;
      } finally {
        this.#running = false;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Closes the browser of a conversation (it became private, or it was deleted); nothing when it holds none. */
  async release(conversationId: string): Promise<void> {
    // It became private or was deleted: the pages the user chose there go too (D-286).
    this.#userAddresses.delete(conversationId);
    // Closed for a reason of the core: a later action of this conversation hears «not open», not «closed by the user».
    this.#closedByUser.delete(conversationId);
    // The session first: an action under way on it then fails at once instead of being waited for.
    if (this.#held?.conversationId === conversationId) await this.#drop();
    await this.#queue;
    if (this.#held?.conversationId === conversationId) await this.#drop();
  }

  /**
   * «Chiudi» in the chat (D-264, passo 4): closes the browser of the
   * conversation, after the action under way if any (the queue), never in the
   * middle of one. False when the conversation does not hold it, then or once
   * its turn came (also while its first browser.open is still starting: the
   * chat asks again at the next line). While it closes, an action of another
   * conversation waits behind it instead of «occupato»: the close is short.
   */
  closeByUser(conversationId: string): Promise<boolean> {
    if (this.holder !== conversationId) return Promise.resolve(false);
    const run = this.#queue.then(async () => {
      this.#forgetClosed();
      if (this.#held?.conversationId !== conversationId) return false;
      this.#closedByUser.add(conversationId);
      await this.#drop();
      return true;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** At the shutdown of the core. */
  async close(): Promise<void> {
    this.#shutDown = true;
    await this.#drop();
    await this.#queue;
    await this.#drop();
  }

  async #act(scope: BrowserScope, action: BrowserAction): Promise<ActionResult> {
    this.#forgetClosed();
    const held = this.#held;
    // The user drives: nothing of Arianna, in this conversation or another (D-264, passo 5).
    if (held !== null && held.driver === 'user') return { ok: false, reason: held.conversationId === scope.conversationId ? 'paused' : 'busy' };
    // Closed by the user: the next action hears why, once; browser.open opens it again.
    const userClosed = this.#closedByUser.delete(scope.conversationId) && held?.conversationId !== scope.conversationId;
    if (userClosed && action.kind !== 'open' && action.kind !== 'close') return { ok: false, reason: 'closed-by-user' };
    if (action.kind === 'close') {
      if (held?.conversationId === scope.conversationId) await this.#drop();
      return { ok: true, page: { url: '', site: '', title: '' } };
    }
    if (held !== null && held.conversationId === scope.conversationId) {
      const access = held.session.network?.authenticated() ?? null;
      const chat = scope.context.browserSite;
      // The Private chat of an access acts only on the browser of that very access (D-281).
      if (chat !== undefined && access !== chat) return { ok: false, reason: 'not-open' };
      held.scope = scope;
      // The values the user let go while this very browser was open (D-283): never those of an older one.
      if (scope.saved !== undefined && scope.saved.opened === held.opened) for (const ref of scope.saved.approved) held.saved.add(ref);
      held.session.network?.rescope(networkScope(scope, 'agent', held.saved));
      // An access made by the user: its pages are Private, never read in a work conversation (rule 9); closing is allowed.
      // A refused action does not keep the browser alive.
      if (access !== null && chat === undefined) return { ok: false, reason: 'authenticated' };
      // Given back by the user: the page is read again before anything else.
      if (held.reread && action.kind !== 'read') return { ok: false, reason: 'reread' };
      if (chat !== undefined && outsideAccess(chat, action, held.elements)) return { ok: false, reason: 'outside-access', site: chat };
      held.lastAction = this.#now();
      if (action.kind === 'read') held.reread = false;
      if (chat !== undefined && (action.kind === 'click' || (action.kind === 'type' && action.submit))) return this.#sending(held, scope, action, chat);
      return this.#bounded(held, this.#run(held, scope, action));
    }
    // The Private chat of an access opens no browser of its own (D-281): its browser came with the access.
    if (scope.context.browserSite !== undefined) return { ok: false, reason: 'not-open' };
    if (action.kind !== 'open') return { ok: false, reason: 'not-open' };
    const unwritten = openOutsideConsent(scope.consent, action.url);
    if (unwritten !== undefined) return unwritten;
    if (held !== null) {
      // A browser with an access made by the user is never taken over: closing it would lose the access.
      if (held.session.network?.authenticated() != null) return { ok: false, reason: 'busy' };
      if (this.#now() - held.lastAction < (this.#options.takeOverMs ?? TAKE_OVER_MS)) return { ok: false, reason: 'busy' };
    } else if (this.#options.manager.state !== 'free') {
      return { ok: false, reason: 'busy' };
    }
    // A new browser (D-283): the values let go for it before it opened (cards asked with the last browser of
    // the conversation, or before any), read by the caller for `opened: null`; never those of another browser.
    const saved = new Set<string>(scope.saved !== undefined && scope.saved.opened === null ? scope.saved.approved : []);
    // A saved value in the address (D-283): the card before any container starts or another browser is taken; once.
    const savedFirst = this.#savedIn(action.url, scope, saved);
    if (savedFirst !== undefined) return savedFirst;
    if (held !== null) {
      await this.#drop();
      this.#safely(() => { this.#options.onTaken?.(held.conversationId); });
    }
    if (this.#options.manager.state !== 'free') return { ok: false, reason: 'busy' };
    const id = browserId();
    const previous = this.#lastOpened.get(scope.conversationId) ?? null;
    let session: BrowserSession;
    try {
      const open = this.#options.openSession ?? defaultOpenSession(this.#options.session);
      session = await open(this.#options.manager, id, {
        sql: this.#options.sql,
        context: scope.context,
        consent: scope.consent,
        meta: { ...scope.meta, saved: { approved: saved } },
        ...(this.#options.onEvent === undefined ? {} : { onEvent: this.#options.onEvent }),
        // A page the user opens while driving is the conversation's (D-286).
        onUserAddress: (address: string, conversationId: string | undefined) => { this.#noteUserAddress(address, conversationId); },
        ...this.#options.network,
        // Diagnostics of a page that does not load (D-281 trial): counts by stage and the lag of the event loop, never an address.
        ...(process.env.ARIANNA_BROWSER_DEBUG === '1' ? { debug: (line: string) => { console.warn(line); } } : {}),
      });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'busy') return { ok: false, reason: 'busy' };
      if (error instanceof BrowserError && (error.code === 'no-lock' || error.code === 'image-mismatch' || error.code === 'bad-image')) return { ok: false, reason: 'not-installed' };
      return { ok: false, reason: 'start-failed' };
    }
    const opened = this.#now();
    this.#lastOpened.set(scope.conversationId, opened);
    const next: Held = { conversationId: scope.conversationId, id, session, lastAction: this.#now(), elements: new Map(), readAt: undefined, driver: 'agent', scope, reread: false, seqAtTake: 0, opened, previous, saved, gestureAt: 0, gestureUsed: true };
    this.#held = next;
    return this.#bounded(next, this.#run(next, scope, action, true));
  }

  /**
   * A click, or typing with Enter, in the Private chat of an access (D-281):
   * with an «Invia» not used yet the network lets this one action send to the
   * site; without, a send it caused is held and the action asks the user.
   */
  async #sending(held: Held, scope: BrowserScope, action: Extract<BrowserAction, { kind: 'click' | 'type' }>, site: string): Promise<ActionResult> {
    const network = held.session.network;
    const element = held.elements.get(action.ref);
    const label = (element?.label ?? '').trim() || (action.kind === 'type' ? 'campo di testo' : 'elemento senza nome');
    const named = sendElement(action.kind === 'type' ? `${label} (Invio)` : label);
    // Only the element the user approved, and only once: «Invia» on «Rinnova» never sends «Elimina».
    const asked = scope.sendPermit;
    const permit = asked !== undefined && asked.element === named && !this.#usedPermits.has(asked.id) ? asked.id : undefined;
    if (permit !== undefined) {
      this.#usedPermits.add(permit);
      network?.rescope({ ...networkScope(scope, 'agent', held.saved), send: true });
    }
    const before = network?.heldSends() ?? 0;
    try {
      const result = await this.#bounded(held, this.#run(held, scope, action));
      if ((network?.heldSends() ?? 0) > before) return { ok: false, reason: 'confirm-send', site, element: named };
      return result;
    } finally {
      if (permit !== undefined && this.#held === held) network?.rescope(networkScope(held.scope, 'agent', held.saved));
    }
  }

  /** One action on the browser. `savedChecked`: the address of an open was compared with the saved values already (D-283). */
  async #run(held: Held, scope: BrowserScope, action: Exclude<BrowserAction, { kind: 'close' }>, savedChecked = false): Promise<ActionResult> {
    const { session } = held;
    switch (action.kind) {
      case 'open': {
        const unwritten = openOutsideConsent(scope.consent, action.url);
        if (unwritten !== undefined) return unwritten;
        // A saved value in the address (D-283): the card at once, before any navigation.
        const savedHere = savedChecked ? undefined : this.#savedIn(action.url, scope, held.saved);
        if (savedHere !== undefined) return savedHere;
        held.elements.clear();
        held.readAt = undefined;
        try {
          await session.openPage(action.url, LOAD_MS);
        } catch (error) {
          // Only the kind of the failure, never the address: what to look at when a page "did not open" (D-281 trial).
          console.warn(`browser: open failed (${openFailureKind(error)})`);
          return towards(navigationFailure(session), siteOf(action.url));
        }
        return this.#state(held);
      }
      case 'read': {
        const page = await session.currentPage();
        // No page yet (a refused open leaves a blank tab, or Chromium's error page): nothing to read, and no
        // script is run there (an evaluate on such a tab may never answer and cost the browser, D-283 trial).
        if (!/^https?:/i.test(page.url())) {
          held.elements.clear();
          held.readAt = undefined;
          return { ok: false, reason: 'no-page' };
        }
        const parsed = await readPage(page);
        // The address and the title from Playwright: the script runs in the world of the page, which may lie.
        const reading = { ...parsed, url: page.url(), title: await page.title().catch(() => parsed.title) };
        held.elements = new Map(reading.elements.map((element) => [element.ref, element]));
        held.readAt = reading.url;
        return { ok: true, page: pageOf(reading.url, reading.title), reading };
      }
      case 'scroll': {
        const page = await session.currentPage();
        await page.evaluate(scrollScript(action.direction));
        return this.#state(held);
      }
      case 'click': {
        const element = await this.#element(held, action.ref);
        if (typeof element === 'string') return { ok: false, reason: element };
        if (element.kind === 'password' || element.kind === 'select') return { ok: false, reason: 'not-clickable' };
        if (element.kind === 'link' && element.href !== undefined) {
          const outside = outsideConsent(scope.consent, element.href);
          if (outside !== undefined) return { ok: false, reason: 'confirm', url: element.href, site: outside };
          const savedHere = this.#savedIn(element.href, scope, held.saved);
          if (savedHere !== undefined) return savedHere;
        }
        const page = await session.currentPage();
        const done = await withNavigation(page, session, () => page.locator(refSelector(action.ref)).first().click({ timeout: ACTION_MS }));
        // Where the value would go: the site of the link, or of the page a button sends from.
        return done === undefined ? this.#state(held) : towards(done, (element.kind === 'link' && element.href !== undefined ? siteOf(element.href) : undefined) ?? siteOf(page.url()));
      }
      case 'type': {
        // Counted in characters as the gateway counts them (code points), not in UTF-16 units.
        if (Array.from(action.text).length > MAX_TYPED) return { ok: false, reason: 'too-long' };
        const element = await this.#element(held, action.ref);
        if (typeof element === 'string') return { ok: false, reason: element };
        if (element.kind === 'password') return { ok: false, reason: 'password-field' };
        if (element.kind !== 'field') return { ok: false, reason: 'not-a-field' };
        const verdict = await this.#options.gateTyped(action.text, scope, held.saved).catch(() => false);
        if (typeof verdict === 'object') {
          const site = siteOf((await session.currentPage()).url());
          return { ok: false, reason: 'confirm-private', saved: verdict.saved, ...(site === undefined ? {} : { site }) };
        }
        if (!verdict) return { ok: false, reason: 'typed-blocked' };
        const page = await session.currentPage();
        const field = page.locator(refSelector(action.ref)).first();
        // Checked again on the element itself: the page may have changed its type since the reading.
        if (!(await field.evaluate(isTypableScript, undefined, { timeout: ACTION_MS }).catch(() => false))) return { ok: false, reason: 'not-a-field' };
        await field.fill(action.text, { timeout: ACTION_MS });
        if (action.submit) {
          const done = await withNavigation(page, session, () => field.press('Enter', { timeout: ACTION_MS }));
          if (done) return towards(done, siteOf(page.url()));
        }
        const state = await this.#state(held);
        return state.ok ? { ...state, typed: Array.from(action.text).length } : state;
      }
    }
  }

  /**
   * Notes a page the user chose, as its site, for the conversation whose
   * scope navigated (D-286), and widens the consent of the browser at once:
   * the pages of that site (a script that goes on to /login, a redirect of
   * its own) then go without another click.
   */
  #noteUserAddress(address: string, conversationId: string | undefined): void {
    if (conversationId === undefined) return;
    let site: string;
    try {
      const url = new URL(address);
      site = `${url.protocol}//${url.host}/`;
    } catch {
      return;
    }
    const known = this.#userAddresses.get(conversationId) ?? [];
    this.#userAddresses.delete(conversationId);
    this.#userAddresses.set(conversationId, [site, ...known.filter((other) => other !== site)].slice(0, MAX_USER_ADDRESSES));
    while (this.#userAddresses.size > MAX_USER_CONVERSATIONS) this.#userAddresses.delete(this.#userAddresses.keys().next().value ?? '');
    const held = this.#held;
    if (held?.conversationId !== conversationId || held.scope.consent.from !== 'user') return;
    held.scope = { ...held.scope, consent: withWritten(held.scope.consent, site) };
    // The scope of who drives now, the same as before but for the site: the gesture of the user goes on as it was.
    if (held.driver === 'user' && !this.#userRunning) held.session.network?.rescope(networkScope(held.scope, 'user', held.saved, held, this.#now));
    else if (held.driver === 'agent' && !this.#userRunning) held.session.network?.rescope(networkScope(held.scope, 'agent', held.saved));
  }

  #pruneAsks(): void {
    const now = this.#now();
    for (const [token, question] of this.#asks) if (now - question.at > ASK_MS) this.#asks.delete(token);
    while (this.#asks.size > 20) this.#asks.delete(this.#asks.keys().next().value ?? '');
  }

  /** The references of saved values in an address not let go (D-283); none in the Private chat of an access, or when the check fails. */
  #savedRefs(address: string, scope: BrowserScope, approved: ReadonlySet<string>): readonly string[] {
    if (scope.context.browserSite !== undefined) return [];
    try {
      return this.#options.savedIn?.(address, approved) ?? [];
    } catch (error) {
      console.warn(`browser: the check of saved values before a page failed (${error instanceof Error ? error.name : typeof error})`);
      return [];
    }
  }

  /** The card of saved values for an address (D-283), when it has some not let go for this browser; undefined otherwise. */
  #savedIn(address: string, scope: BrowserScope, approved: ReadonlySet<string>): ActionResult | undefined {
    // The Private chat of an access (D-281) is never compared by the gateway: no card there.
    if (scope.context.browserSite !== undefined) return undefined;
    // Not loaded, or broken: none here, and the gateway of the network decides the page.
    const saved = this.#savedRefs(address, scope, approved);
    if (saved.length === 0) return undefined;
    const site = siteOf(address);
    return { ok: false, reason: 'confirm-private', saved, ...(site === undefined ? {} : { site }) };
  }

  /**
   * An action within ACTION_LIMIT_MS: past it the browser is closed (a page
   * that hangs in a script would hold the queue), and the action fails.
   */
  async #bounded(held: Held, work: Promise<ActionResult>): Promise<ActionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => { resolve('late'); }, this.#options.actionLimitMs ?? ACTION_LIMIT_MS);
    });
    try {
      const result = await Promise.race([work, late]);
      if (result !== 'late') {
        if (result.ok && result.page.site !== '') held.site = result.page.site;
        return result;
      }
      work.catch(() => undefined);
      if (this.#held === held) await this.#drop();
      return { ok: false, reason: 'action-failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** An element of the last reading, on the page it was read on. */
  async #element(held: Held, ref: number): Promise<PageElement | 'no-reading' | 'unknown-element'> {
    const page = await held.session.currentPage();
    if (held.readAt === undefined || held.readAt !== page.url()) return 'no-reading';
    return held.elements.get(ref) ?? 'unknown-element';
  }

  async #state(held: Held): Promise<ActionResult> {
    const page = await held.session.currentPage();
    // A new page: its numbers are not those of the last reading.
    if (held.readAt !== page.url()) held.elements.clear();
    return { ok: true, page: pageOf(page.url(), await page.title().catch(() => '')) };
  }

  /** The manager closed the browser (idle, max, disconnected): the conversation holds nothing any more. */
  #forgetClosed(): void {
    const held = this.#held;
    if (held !== null && this.#options.manager.active?.id !== held.id) {
      this.#held = null;
      this.#released(held);
    }
  }

  async #drop(): Promise<void> {
    const held = this.#held;
    this.#held = null;
    if (held === null) return;
    // The approvals «Invia» were for this browser only.
    this.#usedPermits.clear();
    // The screens first: they show nothing of a browser that is going.
    this.#released(held);
    await held.session.close().catch(() => undefined);
  }

  #touch(held: Held): void {
    held.lastAction = this.#now();
    held.session.touch?.();
  }

  #released(held: Held): void {
    this.#safely(() => { this.#options.onReleased?.(held.conversationId); });
  }

  #safely(callback: () => void): void {
    try {
      callback();
    } catch {
      console.warn('browser: a callback of the agent browser failed');
    }
  }
}

/**
 * The kind of a failed open, for the log of the core: a Chromium network code
 * (`net::ERR_ABORTED`), a timeout, an interrupted navigation, or the class of
 * the error; never its message, which carries the address.
 */
export function openFailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = /net::ERR_[A-Z_]+/.exec(message)?.[0];
  if (code !== undefined) return code;
  if (/interrupted by another navigation/i.test(message)) return 'interrupted by another navigation';
  if (/frame was detached/i.test(message)) return 'frame detached';
  if (/Timeout \d+ms exceeded/i.test(message)) return 'timeout';
  if (/Target page, context or browser has been closed/i.test(message)) return 'closed';
  return error instanceof Error ? error.name : typeof error;
}

/** The name of the element of a card «Invia / No» (D-281), as stored and as compared: one line, at most 120 characters. */
export function sendElement(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Whether an action of the Private chat of an access leaves its site (D-281):
 * an address to open, or a link of the last reading, that is not https on
 * the site of the access or a subdomain. A link the page moved since the
 * reading is stopped by the network all the same (L2 towards another site).
 */
export function outsideAccess(site: string, action: BrowserAction, elements: ReadonlyMap<number, PageElement>): boolean {
  const off = (address: string): boolean => {
    try {
      const url = new URL(address);
      const host = url.hostname.toLowerCase().replace(/[.]$/, '');
      return url.protocol !== 'https:' || !(host === site || host.endsWith('.' + site));
    } catch {
      return true;
    }
  };
  if (action.kind === 'open') return off(action.url);
  if (action.kind === 'click') {
    const element = elements.get(action.ref);
    if (element?.kind !== 'link' || element.href === undefined) return false;
    // Not a page (a fragment, javascript:, mailto:): the click stays on this page, the network refuses the rest.
    try {
      const protocol = new URL(element.href).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') return false;
    } catch {
      return false;
    }
    return off(element.href);
  }
  return false;
}

/**
 * The scope of the network for who drives: the user's requests carry no task
 * of Arianna; both are compared with the saved values (D-283), with those the
 * user let go for this browser.
 */
function networkScope(scope: BrowserScope, driver: Driver, saved: ReadonlySet<string>, gesture?: Held, now: () => number = Date.now): NetworkScope {
  const meta: GatewayMeta = driver === 'agent' ? { ...scope.meta, saved: { approved: saved } } : { saved: { approved: saved } };
  // The user driving from the screen (D-286): a click or a key of theirs, taken once, chooses a page.
  const takeGesture =
    gesture === undefined
      ? undefined
      : (): boolean => {
          if (gesture.gestureUsed || now() - gesture.gestureAt > GESTURE_MS) return false;
          gesture.gestureUsed = true;
          return true;
        };
  return { context: scope.context, consent: scope.consent, driver, meta, conversationId: scope.conversationId, ...(takeGesture === undefined ? {} : { takeGesture }) };
}

function pageOf(url: string, title: string): { url: string; site: string; title: string } {
  return { url, site: siteOf(url) ?? '', title };
}

function refSelector(ref: number): string {
  return `[${REF_ATTRIBUTE}="${String(Math.trunc(ref))}"]`;
}

/** A card of saved values (D-283) with the site the value would go to; any other result as it is. */
function towards(result: ActionResult, site: string | undefined): ActionResult {
  if (result.ok || result.reason !== 'confirm-private' || site === undefined || site === '') return result;
  return { ...result, site };
}

/** `work` within `ms`, or a rejection: a script of the page that never answers holds nothing. */
async function withLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('late')); }, ms); })]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
  }
}

function withoutFragment(address: string): string {
  try {
    const url = new URL(address);
    url.hash = '';
    return url.href;
  } catch {
    return address;
  }
}

/** Why the last navigation failed, from the network of the job. */
function navigationFailure(session: BrowserSession): ActionResult {
  const last = session.network?.lastNavigation();
  // A saved private value of the user in the address (D-283): the user decides.
  if (last?.reason === 'saved-private' && last.saved !== undefined && last.saved.length > 0) return { ok: false, reason: 'confirm-private', saved: last.saved };
  if (last?.outcome === 'blocked' || last?.outcome === 'refused' || last?.outcome === 'form' || last?.outcome === 'limit') {
    return { ok: false, reason: 'navigation-blocked', network: last.reason ?? last.outcome, ...(last.site === undefined ? {} : { site: last.site }) };
  }
  return { ok: false, reason: 'navigation-failed', ...(last?.reason === undefined ? {} : { network: last.reason }), ...(last?.site === undefined ? {} : { site: last.site }) };
}

/**
 * Runs a click or a key that may start a navigation: waits briefly for one
 * to start, then for its load and the redirects the core follows. A refused
 * navigation is reported; undefined when the action ended on a page.
 */
async function withNavigation(page: Page, session: BrowserSession, action: () => Promise<void>): Promise<ActionResult | undefined> {
  const before = session.network?.lastNavigation();
  const started = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame(), timeout: NAVIGATION_START_MS }).then(() => true, () => false);
  await action();
  if (!(await started)) {
    const after = session.network?.lastNavigation();
    // The navigation was refused before it could start (the gateway or a form).
    if (after !== undefined && after.seq !== before?.seq && after.outcome !== 'ok' && after.outcome !== 'http-error') return navigationFailure(session);
    return undefined;
  }
  await page.waitForLoadState('load', { timeout: LOAD_MS }).catch(() => undefined);
  await session.network?.settle(page, LOAD_MS);
  // Refused by the network after it started: Chromium shows its error page, which would interrupt the next navigation.
  const after = session.network?.lastNavigation();
  if (after !== undefined && after.seq !== before?.seq && after.outcome !== 'ok' && after.outcome !== 'http-error') {
    const failed = navigationFailure(session);
    await session.resetPage();
    return failed;
  }
  return undefined;
}

/**
 * The site of a link the consent does not cover («Clic solo nello stesso
 * sito»), as the network decides a main page after the first; undefined when
 * the click may go. With `public` every public page may go.
 */
export function outsideConsent(consent: PageConsent, href: string): string | undefined {
  if (consent.from === 'public') return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  // Not a page: the click stays on this page (a fragment, javascript:, mailto: refused by the network anyway).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const allowed = navigationConsent(consent, url.href, 0);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const site = siteOf(url.href) ?? host;
  if (allowed.from === 'user') {
    const key = (address: string): string => { try { const parsed = new URL(address); parsed.hash = ''; return parsed.href; } catch { return address; } };
    return allowed.addresses.some((written) => key(written) === key(url.href)) ? undefined : site;
  }
  if (allowed.from === 'sites') return allowed.sites.some((name) => host === name || host.endsWith(`.${name}`)) ? undefined : site;
  return undefined;
}

/**
 * `browser.open` with a `user` consent: an address on a site of the consent
 * (D-286, «Il sito approvato vale tutto»), as web.fetch; one of a new site
 * waits for the user on the card «Apri / No». Undefined when it may go.
 */
export function openOutsideConsent(consent: PageConsent, address: string): ActionResult | undefined {
  if (consent.from !== 'user') return undefined;
  // A site of the conversation (written by the user, chosen with a click of theirs, or opened from a card)
  // holds for every address of it (choice of the user, 2026-10-22, «Il sito approvato vale tutto», D-286).
  if (coveredBy(consent, address)) return undefined;
  return { ok: false, reason: 'confirm', url: address, site: siteOf(address) ?? address };
}

/** Whether an element still takes typed text: an input of a text kind or a text area, never password, file or hidden. */
const isTypableScript = (element: unknown): boolean => {
  const node = element as { tagName?: string; type?: string; readOnly?: boolean; disabled?: boolean };
  if (node.disabled === true || node.readOnly === true) return false;
  if (node.tagName === 'TEXTAREA') return true;
  return node.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number', ''].includes((node.type ?? '').toLowerCase());
};

function scrollScript(direction: 'up' | 'down'): string {
  return `window.scrollBy({ top: ${direction === 'down' ? '' : '-'}Math.round(window.innerHeight * 0.85), behavior: 'instant' })`;
}

/**
 * The helpers of the scripts of the core in the page (READ_SCRIPT,
 * LOGIN_SCRIPT). Only parents, children and attributes, never `closest` nor
 * a selector inside an element: the tests run them on a page made of plain
 * objects (D-287).
 *
 * `shown`: a box of some size, visible, and not wholly outside the document
 * (D-287: ferramentalombardi.it keeps a real login form in a drop-down
 * parked at x = -9296; left of 0, above 0, or right of the width one can
 * scroll to).
 * `clipped`: an element outside the box of a parent that cuts what overflows
 * (`overflow: hidden` or `clip`: a menu closed by `max-height: 0`, a panel
 * slid away, a slide of a carousel), D-287: it is not on screen, so it is not
 * listed, and a closed mini login does not make a login page. A box that
 * scrolls (`auto`, `scroll`) does not cut: its elements stay listed. A fixed
 * element (or one inside a fixed box) is never taken as cut: the overflow of
 * the parents above it does not hold it. An absolute element whose container
 * is above the parent that cuts may still be taken as cut (a known limit).
 * `areaOf`: the first landmark around the element; a header or footer inside
 * a section (an article, a sidebar) is the section's, not the page's.
 */
const PAGE_HELPERS = `
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    // Wholly outside the document (a menu parked at left: -9999px): never on screen, however far one scrolls.
    const left = box.left + (window.scrollX || 0);
    const top = box.top + (window.scrollY || 0);
    const width = Math.max((document.documentElement && document.documentElement.scrollWidth) || 0, window.innerWidth || 0);
    if (left + box.width <= 0 || top + box.height <= 0 || left >= width) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
  };
  const cuts = new Map();
  const cutOf = (node) => {
    if (!cuts.has(node)) {
      const style = getComputedStyle(node);
      const cut = (value) => value === 'hidden' || value === 'clip';
      const x = style.display !== 'contents' && cut(style.overflowX);
      const y = style.display !== 'contents' && cut(style.overflowY);
      cuts.set(node, x || y ? { x, y, box: node.getBoundingClientRect() } : null);
    }
    return cuts.get(node);
  };
  const clipped = (element) => {
    const box = element.getBoundingClientRect();
    // A fixed element is not cut by the overflow of its parents (a dialog, a banner).
    if (getComputedStyle(element).position === 'fixed') return false;
    for (let node = element.parentElement; node && node.tagName !== 'HTML' && node.tagName !== 'BODY'; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return false;
      const cut = cutOf(node);
      if (!cut) continue;
      if (cut.x && (box.right <= cut.box.left || box.left >= cut.box.right)) return true;
      if (cut.y && (box.bottom <= cut.box.top || box.top >= cut.box.bottom)) return true;
    }
    return false;
  };
  const textOf = (element) => clean(element.getAttribute('aria-label') || (element.labels && element.labels[0] ? element.labels[0].innerText : '') || element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('alt') || (element.tagName === 'INPUT' ? '' : element.innerText) || element.getAttribute('name') || '');
  const kindOf = (element) => {
    const tag = element.tagName;
    const role = element.getAttribute('role');
    if (tag === 'A' || role === 'link') return 'link';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'field';
    // A text box made of other elements (contenteditable): not typed into, so not listed.
    if ((role === 'textbox' || role === 'searchbox') && tag !== 'INPUT') return null;
    if (tag === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden' || type === 'file') return null;
      if (type === 'password') return 'password';
      if (type === 'checkbox' || type === 'radio') return 'choice';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      return 'field';
    }
    return 'button';
  };
  const labelOf = (element, kind) => (kind === 'button' && element.tagName === 'INPUT' ? clean(element.getAttribute('value') || textOf(element)) : textOf(element));
  const SECTIONS = ['ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'SECTION'];
  const inSection = (node) => {
    for (let up = node.parentElement; up; up = up.parentElement) if (SECTIONS.includes(up.tagName)) return true;
    return false;
  };
  const areaOf = (element) => {
    for (let node = element; node && node.getAttribute; node = node.parentElement) {
      const tag = node.tagName;
      const role = node.getAttribute('role');
      if (tag === 'MAIN' || role === 'main' || tag === 'ARTICLE' || role === 'article') return 'main';
      if (tag === 'NAV' || role === 'navigation') return 'nav';
      if (tag === 'ASIDE' || role === 'complementary') return 'aside';
      if (role === 'banner' || (tag === 'HEADER' && !inSection(node))) return 'header';
      if (role === 'contentinfo' || (tag === 'FOOTER' && !inSection(node))) return 'footer';
    }
    return undefined;
  };
  const HEADINGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
  const isHeading = (node) => HEADINGS.includes(node.tagName) || (node.getAttribute && node.getAttribute('role') === 'heading');
  const holdsHeading = (node, depth) => {
    if (depth > 6 || !node.children) return false;
    for (const child of node.children) if (isHeading(child) || holdsHeading(child, depth + 1)) return true;
    return false;
  };
  const headingOf = (element) => {
    for (let node = element.parentElement; node; node = node.parentElement) if (isHeading(node)) return true;
    return holdsHeading(element, 0);
  };
  const forms = [];
  const formOf = (element) => {
    let form = element.form || null;
    for (let node = element.parentElement; !form && node; node = node.parentElement) if (node.tagName === 'FORM') form = node;
    if (!form) return undefined;
    if (!forms.includes(form)) forms.push(form);
    return forms.indexOf(form);
  };
  const describe = (element, kind, ref) => {
    const entry = { ref, kind, label: labelOf(element, kind) };
    if (kind === 'link' && element.href) entry.href = String(element.href);
    if (kind === 'field') entry.type = element.tagName === 'TEXTAREA' ? 'textarea' : (element.getAttribute('type') || 'text').toLowerCase();
    const area = areaOf(element);
    if (area) entry.area = area;
    if (kind === 'link' && headingOf(element)) entry.heading = true;
    if (kind !== 'link') {
      const form = formOf(element);
      if (form !== undefined) entry.form = form;
    }
    return entry;
  };
`;

/**
 * The fixed script of the reading (runs in the page): numbers the visible
 * elements, the ones on screen first, and returns the visible text. It never
 * reads the value of a field: labels come from aria-label, the label
 * element, placeholder, title, alt, or the text of the element; the value
 * attribute only of a button. An element cut away by a parent is not
 * listed (D-287). Each element says where it is (`area`), a link whether it
 * is a heading (`heading`), the others their form (`form`), D-287.
 */
export const READ_SCRIPT = `(() => {
  const MAX = ${String(MAX_ELEMENTS)};
  const ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
  for (const old of document.querySelectorAll('[' + ATTR + ']')) old.removeAttribute(ATTR);
  ${PAGE_HELPERS}
  const height = window.innerHeight;
  const near = [];
  const far = [];
  for (const element of document.querySelectorAll('a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=textbox], [role=searchbox]')) {
    if (!shown(element)) continue;
    const kind = kindOf(element);
    if (kind === null || clipped(element)) continue;
    const box = element.getBoundingClientRect();
    (box.bottom >= 0 && box.top <= height ? near : far).push([element, kind]);
  }
  const chosen = near.concat(far).slice(0, MAX);
  const order = new Map(chosen.map((entry, index) => [entry[0], index]));
  const elements = [];
  let ref = 0;
  for (const element of document.querySelectorAll('[href], button, input, textarea, select, summary, [role]')) {
    if (!order.has(element)) continue;
    const kind = chosen[order.get(element)][1];
    ref += 1;
    element.setAttribute(ATTR, String(ref));
    elements.push(describe(element, kind, ref));
  }
  const top = window.scrollY;
  const max = Math.max(0, document.documentElement.scrollHeight - height);
  // The main content when the page marks it, without menus; from the top of the screen once scrolled.
  const root = document.querySelector('main, [role=main], article') || document.body;
  let text = root ? root.innerText : '';
  if (root && top > 0 && document.caretRangeFromPoint) {
    let from = null;
    for (const y of [4, 40, 120]) {
      const caret = document.caretRangeFromPoint(Math.round(window.innerWidth / 2), y);
      if (caret && root.contains(caret.startContainer)) { from = caret; break; }
    }
    if (from) {
      const range = document.createRange();
      range.setStart(from.startContainer, from.startOffset);
      range.setEnd(root, root.childNodes.length);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
        const rest = selection.toString();
        selection.removeAllRanges();
        if (rest.trim() !== '') text = rest;
      }
    }
  }
  return {
    title: document.title,
    url: location.href,
    text: String(text || '').slice(0, ${String(MAX_SCRIPT_TEXT)}),
    elements,
    scrolled: max === 0 ? 100 : Math.min(100, Math.round((top / max) * 100)),
  };
})()`;

/**
 * The fixed script that tells whether the page shows a login form (D-287),
 * for the screen of the user who drives: the visible fields and buttons with
 * their form, never a value, never the text of the page, and no number left
 * on the page (Arianna's reading stays as it was). The core keeps only the
 * answer of asksLogin.
 */
export const LOGIN_SCRIPT = `(() => {
  const MAX = ${String(MAX_ELEMENTS)};
  ${PAGE_HELPERS}
  const elements = [];
  for (const element of document.querySelectorAll('input, button, [role=button]')) {
    if (elements.length >= MAX) break;
    if (!shown(element)) continue;
    const kind = kindOf(element);
    if ((kind !== 'password' && kind !== 'field' && kind !== 'button') || clipped(element)) continue;
    elements.push(describe(element, kind, elements.length + 1));
  }
  return { elements };
})()`;

/** Words of a button that signs in, as a whole label (D-276). */
const LOGIN_WORDS = /^(accedi|entra|login|log in|sign in|signin|accesso|area riservata|continua con la password)$/i;
/** The label of a field for the user of an account (D-287): not a search box, not the name of a newsletter. */
const USER_FIELD = /\b(e-?mail|utente|username|user|login|account|codice cliente)\b/i;

/**
 * Whether a page shows a login form (D-276, narrowed by D-287): a password
 * field on screen, or one form with a field for the user (an email, or a
 * text field named as a user) and a button named as a sign in (the first
 * page of a login in two steps). A link «Accedi» in the header, a search box
 * next to it or a cookie banner are not a login. Read on what the scripts of
 * the core return, which a hostile page may shape: it only adds a hint.
 */
export function asksLogin(reading: Pick<PageReading, 'elements'>): boolean {
  if (reading.elements.some((element) => element.kind === 'password')) return true;
  const userForms = new Set<number>();
  for (const element of reading.elements) {
    if (element.kind !== 'field' || element.form === undefined) continue;
    if (element.type === 'email' || ((element.type === 'text' || element.type === 'tel') && USER_FIELD.test(element.label))) userForms.add(element.form);
  }
  return reading.elements.some((element) => element.kind === 'button' && element.form !== undefined && userForms.has(element.form) && LOGIN_WORDS.test(element.label.trim()));
}

const KINDS: readonly string[] = ['link', 'button', 'field', 'password', 'choice', 'select'];

/** Reads the current page with READ_SCRIPT; what the page returns is checked, it is untrusted. */
export async function readPage(page: Page): Promise<PageReading> {
  const raw: unknown = await page.evaluate(READ_SCRIPT);
  return parseReading(raw);
}

/** The answer of READ_SCRIPT, from a page that may have changed the script's globals: only the expected shape. */
export function parseReading(raw: unknown): PageReading {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (input: unknown, max: number): string => (typeof input === 'string' ? input.slice(0, max) : '');
  const elements: PageElement[] = [];
  if (Array.isArray(value.elements)) {
    for (const item of value.elements.slice(0, MAX_ELEMENTS) as unknown[]) {
      const entry = (item ?? {}) as Record<string, unknown>;
      if (typeof entry.ref !== 'number' || !Number.isInteger(entry.ref) || entry.ref < 1 || typeof entry.kind !== 'string' || !KINDS.includes(entry.kind)) continue;
      elements.push({
        ref: entry.ref,
        kind: entry.kind as ElementKind,
        label: text(entry.label, 120),
        ...(entry.kind === 'link' && typeof entry.href === 'string' ? { href: entry.href.slice(0, 2_000) } : {}),
        ...(entry.kind === 'field' && typeof entry.type === 'string' ? { type: entry.type.slice(0, 20) } : {}),
        ...(typeof entry.area === 'string' && AREAS.includes(entry.area) ? { area: entry.area as ElementArea } : {}),
        ...(entry.kind === 'link' && entry.heading === true ? { heading: true as const } : {}),
        ...(entry.kind !== 'link' && typeof entry.form === 'number' && Number.isInteger(entry.form) && entry.form >= 0 && entry.form < 1_000 ? { form: entry.form } : {}),
      });
    }
  }
  const scrolled = typeof value.scrolled === 'number' && Number.isFinite(value.scrolled) ? Math.max(0, Math.min(100, Math.round(value.scrolled))) : 0;
  return { title: text(value.title, 300), url: text(value.url, 2_000), text: text(value.text, MAX_SCRIPT_TEXT), elements, scrolled };
}

/**
 * The gateway on a text browser.type would type (target `web` with `typed`,
 * D-264): vault, scanner and the second check, as a page. In the Private
 * chat of an access (D-281) `typed: 'session'` with the site of the access:
 * vault and scanner, towards that site only. True only when the exact text
 * was allowed and spent here.
 */
export function gatewayTyped(sql: Sql): AgentBrowserOptions['gateTyped'] {
  return async (text, scope, approved) => {
    const site = scope.context.browserSite;
    const target: Target = site === undefined ? { kind: 'web', typed: scope.consent.from } : { kind: 'web', typed: 'session', site };
    const decision = await passGateway(sql, [{ value: text, label: scope.context.effective, source: 'browser:typed' }], scope.context, target, { ...scope.meta, summary: 'browser typed text', saved: { approved } });
    // A saved private value of the user (D-283): the user decides with «Apri / No».
    if (decision.decision === 'block' && decision.rule === 'saved-private' && decision.saved !== undefined) return { saved: decision.saved };
    if (decision.decision !== 'allow') return false;
    const spent = spendAllowed(decision);
    return spent?.target.kind === 'web' && spent.target.typed !== undefined && spent.texts[0] === text;
  };
}
