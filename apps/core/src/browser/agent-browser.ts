import { randomBytes } from 'node:crypto';

import { createContext, spendAllowed, type Context, type PageConsent, type Target } from '@arianna/policy';
import type { Page } from 'playwright-core';

import type { Sql } from '../db/client.ts';
import type { NewEvent } from '../events.ts';
import { passGateway, type GatewayMeta } from '../gateway.ts';
import { siteOf } from '../link-fetch.ts';
import { BrowserError } from './container.ts';
import type { BrowserManager } from './manager.ts';
import { navigationConsent, type NetworkJob, type NetworkScope, type RequestOutcome } from './network.ts';
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
 */

export const TAKE_OVER_MS = 2 * 60_000;
export const MAX_ELEMENTS = 80;
export const MAX_TYPED = 200;
/** Text of the page the script returns; the tool cuts it again for the model. */
const MAX_SCRIPT_TEXT = 20_000;
const ACTION_MS = 5_000;
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
}

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
  | { ok: false; reason: 'confirm-send'; site: string; element: string };

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
  | 'unknown-element'
  | 'not-clickable'
  | 'not-a-field'
  | 'password-field'
  | 'too-long'
  | 'typed-blocked'
  | 'navigation-blocked'
  | 'navigation-failed'
  | 'action-failed';

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
}

export type OpenSession = (browser: BrowserManager, id: string, network: Omit<NetworkJob, 'userAgent'>) => Promise<BrowserSession>;

export interface AgentBrowserOptions {
  sql: Sql;
  manager: BrowserManager;
  session: Omit<SessionOptions, 'network'>;
  /** The gateway on a text to type (target `web` with `typed`): true when it may be typed. */
  gateTyped: (text: string, scope: BrowserScope) => Promise<boolean>;
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
  #queue: Promise<unknown> = Promise.resolve();
  #running = false;
  /** Conversations whose browser the user closed: their next action hears it once (D-264, passo 4). */
  readonly #closedByUser = new Set<string>();
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

  /** The site the browser of `conversationId` is on, when it holds the browser and an action reached a page. */
  siteOf(conversationId: string): string | null {
    const held = this.#held;
    if (this.holder !== conversationId || held === null) return null;
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
      held.session.network?.rescope(networkScope(scope, 'agent'));
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
      held.session.network?.rescope(networkScope(held.scope, 'user'));
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
    held.session.network?.rescope(networkScope(held.scope, 'agent'));
    this.#touch(held);
    return true;
  }

  /** Input of the user on the screen that drives: counts as activity for the 15 minutes (never for the 30). */
  userInput(conversationId: string): void {
    const held = this.#held;
    if (held !== null && held.conversationId === conversationId && held.driver === 'user') this.#touch(held);
  }

  /** One action, after the ones already running. Never throws. */
  act(scope: BrowserScope, action: BrowserAction): Promise<ActionResult> {
    // Another conversation while an action runs: «occupato» at once, never a wait behind it.
    if (this.#running && this.#held !== null && this.#held.conversationId !== scope.conversationId) return Promise.resolve({ ok: false, reason: 'busy' });
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
      held.session.network?.rescope(networkScope(scope, 'agent'));
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
      await this.#drop();
      this.#safely(() => { this.#options.onTaken?.(held.conversationId); });
    }
    if (this.#options.manager.state !== 'free') return { ok: false, reason: 'busy' };
    const id = browserId();
    let session: BrowserSession;
    try {
      const open = this.#options.openSession ?? defaultOpenSession(this.#options.session);
      session = await open(this.#options.manager, id, {
        sql: this.#options.sql,
        context: scope.context,
        consent: scope.consent,
        ...(scope.meta === undefined ? {} : { meta: scope.meta }),
        ...(this.#options.onEvent === undefined ? {} : { onEvent: this.#options.onEvent }),
        ...this.#options.network,
      });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'busy') return { ok: false, reason: 'busy' };
      if (error instanceof BrowserError && (error.code === 'no-lock' || error.code === 'image-mismatch' || error.code === 'bad-image')) return { ok: false, reason: 'not-installed' };
      return { ok: false, reason: 'start-failed' };
    }
    const next: Held = { conversationId: scope.conversationId, id, session, lastAction: this.#now(), elements: new Map(), readAt: undefined, driver: 'agent', scope, reread: false, seqAtTake: 0 };
    this.#held = next;
    return this.#bounded(next, this.#run(next, scope, action));
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
      network?.rescope({ ...networkScope(scope, 'agent'), send: true });
    }
    const before = network?.heldSends() ?? 0;
    try {
      const result = await this.#bounded(held, this.#run(held, scope, action));
      if ((network?.heldSends() ?? 0) > before) return { ok: false, reason: 'confirm-send', site, element: named };
      return result;
    } finally {
      if (permit !== undefined && this.#held === held) network?.rescope(networkScope(held.scope, 'agent'));
    }
  }

  async #run(held: Held, scope: BrowserScope, action: Exclude<BrowserAction, { kind: 'close' }>): Promise<ActionResult> {
    const { session } = held;
    switch (action.kind) {
      case 'open': {
        const unwritten = openOutsideConsent(scope.consent, action.url);
        if (unwritten !== undefined) return unwritten;
        held.elements.clear();
        held.readAt = undefined;
        try {
          await session.openPage(action.url, LOAD_MS);
        } catch {
          return navigationFailure(session);
        }
        return this.#state(held);
      }
      case 'read': {
        const page = await session.currentPage();
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
        }
        const page = await session.currentPage();
        const done = await withNavigation(page, session, () => page.locator(refSelector(action.ref)).first().click({ timeout: ACTION_MS }));
        return done ?? this.#state(held);
      }
      case 'type': {
        // Counted in characters as the gateway counts them (code points), not in UTF-16 units.
        if (Array.from(action.text).length > MAX_TYPED) return { ok: false, reason: 'too-long' };
        const element = await this.#element(held, action.ref);
        if (typeof element === 'string') return { ok: false, reason: element };
        if (element.kind === 'password') return { ok: false, reason: 'password-field' };
        if (element.kind !== 'field') return { ok: false, reason: 'not-a-field' };
        if (!(await this.#options.gateTyped(action.text, scope).catch(() => false))) return { ok: false, reason: 'typed-blocked' };
        const page = await session.currentPage();
        const field = page.locator(refSelector(action.ref)).first();
        // Checked again on the element itself: the page may have changed its type since the reading.
        if (!(await field.evaluate(isTypableScript, undefined, { timeout: ACTION_MS }).catch(() => false))) return { ok: false, reason: 'not-a-field' };
        await field.fill(action.text, { timeout: ACTION_MS });
        if (action.submit) {
          const done = await withNavigation(page, session, () => field.press('Enter', { timeout: ACTION_MS }));
          if (done) return done;
        }
        const state = await this.#state(held);
        return state.ok ? { ...state, typed: Array.from(action.text).length } : state;
      }
    }
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

/** The scope of the network for who drives: the user's requests carry no task of Arianna. */
function networkScope(scope: BrowserScope, driver: Driver): NetworkScope {
  return { context: scope.context, consent: scope.consent, driver, ...(driver === 'agent' && scope.meta !== undefined ? { meta: scope.meta } : {}) };
}

function pageOf(url: string, title: string): { url: string; site: string; title: string } {
  return { url, site: siteOf(url) ?? '', title };
}

function refSelector(ref: number): string {
  return `[${REF_ATTRIBUTE}="${String(Math.trunc(ref))}"]`;
}

/** Why the last navigation failed, from the network of the job. */
function navigationFailure(session: BrowserSession): ActionResult {
  const last = session.network?.lastNavigation();
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
 * `browser.open` with a `user` consent: only an address of the consent, as
 * web.fetch (the sites of those addresses are for clicks and redirects); any
 * other waits for the user on the card «Apri / No». Undefined when it may go.
 */
export function openOutsideConsent(consent: PageConsent, address: string): ActionResult | undefined {
  if (consent.from !== 'user') return undefined;
  const key = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return undefined;
    }
  };
  const wanted = key(address);
  if (wanted !== undefined && consent.addresses.some((written) => key(written) === wanted)) return undefined;
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
 * The fixed script of the reading (runs in the page): numbers the visible
 * elements, the ones on screen first, and returns the visible text. It never
 * reads the value of a field: labels come from aria-label, the label
 * element, placeholder, title, alt, or the text of the element; the value
 * attribute only of a button.
 */
export const READ_SCRIPT = `(() => {
  const MAX = ${String(MAX_ELEMENTS)};
  const ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
  for (const old of document.querySelectorAll('[' + ATTR + ']')) old.removeAttribute(ATTR);
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
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
  const height = window.innerHeight;
  const near = [];
  const far = [];
  for (const element of document.querySelectorAll('a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=textbox], [role=searchbox]')) {
    if (!shown(element)) continue;
    const kind = kindOf(element);
    if (kind === null) continue;
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
    let label = textOf(element);
    if (kind === 'button' && element.tagName === 'INPUT') label = clean(element.getAttribute('value') || label);
    const entry = { ref, kind, label };
    if (kind === 'link' && element.href) entry.href = String(element.href);
    if (kind === 'field') entry.type = element.tagName === 'TEXTAREA' ? 'textarea' : (element.getAttribute('type') || 'text').toLowerCase();
    elements.push(entry);
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
  return async (text, scope) => {
    const site = scope.context.browserSite;
    const target: Target = site === undefined ? { kind: 'web', typed: scope.consent.from } : { kind: 'web', typed: 'session', site };
    const decision = await passGateway(sql, [{ value: text, label: scope.context.effective, source: 'browser:typed' }], scope.context, target, { ...scope.meta, summary: 'browser typed text' });
    if (decision.decision !== 'allow') return false;
    const spent = spendAllowed(decision);
    return spent?.target.kind === 'web' && spent.target.typed !== undefined && spent.texts[0] === text;
  };
}
