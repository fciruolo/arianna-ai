import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { RawData, WebSocket } from 'ws';

import type { Sql } from '../db/client.ts';
import type { NewEvent } from '../events.ts';
import { openDockerChannel, type Channel, type OpenChannel } from './channel.ts';
import { VNC_SOCKET } from './container.ts';
import type { BlockedNavigation, ControlRequest, Driver, UserCommand } from './agent-browser.ts';
import { createRfbFilter, type FilterClose, type InputCounts, type RfbFilter } from './rfb-filter.ts';

/**
 * The screen of the browser in the chat (D-264, passo 4): view only, only
 * the browser of Arianna. A page asks a token for the conversation that
 * holds the browser (POST /api/browser/screen), then opens the WebSocket
 * /api/browser/screen?t=<token>; the core bridges its bytes to Xvnc in the
 * container through `docker exec` (openChannel on VNC_SOCKET), every byte
 * toward Xvnc read by the RFB filter.
 *
 * A token is 32 random bytes; only its sha256 is kept, bound to the
 * conversation and to the container that conversation holds. It dies with
 * that browser: closed, taken by another chat, or the core stopping. No
 * token for a Private or incognito conversation (the browser tools are off
 * there anyway), except the Private chat of an access (`browser`, D-281),
 * which the browser passed to: the screen and the control follow it. A token opens one screen (passo 5: it is consumed at the
 * connection, and then names that screen for «Prendi il controllo»), at most
 * MAX_SCREENS at once per browser (the Mac and the phone).
 *
 * «Prendi il controllo» (D-264, passo 5): `take` with the token of a screen
 * open now asks AgentBrowser.takeControl (after the action under way), then
 * only that screen's filter forwards keys and pointer. The last screen that
 * asks gets it («Passa all'ultimo che lo chiede»): the one before goes back
 * to view and reads «il controllo è passato a un altro schermo» in the
 * status. The control goes back to Arianna with «Restituisci» (`user`), when
 * that screen closes (`screen-closed`: at once, or at the missing pong of a
 * locked phone, 30-60 s), after CONTROL_IDLE_MS without input (`idle`), or
 * with the browser (`browser-closed`). Event `browser.control`, L0: taken;
 * returned with the reason, the duration, keys and clicks counted, never
 * their values.
 */

/** Without input on the screen that drives for this long, the control goes back to Arianna («5 minuti senza input»). */
export const CONTROL_IDLE_MS = 5 * 60_000;
const CONTROL_CHECK_MS = 15_000;

export type ControlEnd = 'user' | 'screen-closed' | 'idle' | 'browser-closed';

/** «Prendi il controllo»: taken now, after the action of Arianna under way, or why not. */
export type TakeResult = { ok: true; waiting: boolean; done: Promise<boolean> } | { ok: false; reason: 'not-found' | 'no-browser' | 'no-screen' };

/** Who drives, for the status: `you` is the screen of the token asked with, `other` another screen. */
export type ControlState = 'agent' | 'you' | 'other' | 'user';

export const MAX_SCREENS = 3;
/** Tokens kept at once; the oldest goes first. */
const MAX_TOKENS = 16;
/** Above this the channel pauses until the page has read what is queued. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
/** What the page sends and Xvnc has not taken yet: a page past it is dropped. */
const MAX_INBOUND_QUEUE = 256 * 1024;
const PING_MS = 30_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** WebSocket close codes of a screen, with their reason; the chat reads the code. */
export const SCREEN_CLOSE = {
  /** The browser closed, passed to another chat, or the token no longer holds. */
  browserClosed: { code: 4001, reason: 'browser-closed' },
  /** A fourth screen of the same browser. */
  tooMany: { code: 4002, reason: 'too-many-screens' },
  /** The page sent a message the filter does not let through (or a text frame). */
  refused: { code: 4003, reason: 'refused-message' },
  /** The channel to Xvnc ended or failed while the browser was still open. */
  vncClosed: { code: 4004, reason: 'vnc-closed' },
  /**
   * The page sends more than Xvnc takes (MAX_INBOUND_QUEUE waiting), or a
   * frame past the maxPayload of the route (then `ws` itself closes with 1009
   * and the event says `frame-too-long`). A page that reads slowly is never
   * closed for it: the channel pauses.
   */
  overflow: { code: 4005, reason: 'overflow' },
  /** The core is stopping. */
  stopping: { code: 1001, reason: 'core-stopping' },
} as const;

export type ScreenCloseKey = keyof typeof SCREEN_CLOSE;

/** `browser`: the Private chat of an access, which the browser passed to (D-281). */
export type ConversationKind = 'work' | 'browser' | 'private' | 'incognito';

/** The kinds whose browser has a screen: a work conversation, and the Private chat of an access. */
function screened(kind: ConversationKind): boolean {
  return kind === 'work' || kind === 'browser';
}

/** «Chiudi» of the chat: closed, no browser held by that conversation, or no such conversation. */
export type CloseResult = 'closed' | 'no-browser' | 'not-found';

/** What a command of the bar did (D-286), for the chat: never an address but the one the page is on now. */
export type CommandOutcome =
  | { ok: true; url: string; site: string }
  /** `values`: for a saved value (`confirm-private`), what it is and whose, never the value nor its reference. */
  | { ok: false; reason: string; site?: string; values?: readonly { kind: string; client: string }[]; ask?: string };
/** A command of the bar as the chat asks it, checked: `NavigateResult` adds why it was refused before the browser. */
export type NavigateResult = CommandOutcome | { ok: false; reason: 'not-found' | 'no-browser' | 'no-screen' };

export type IssueResult = { ok: true; token: string } | { ok: false; reason: 'not-found' | 'private' | 'incognito' | 'no-browser' | 'too-many-screens' };

/** A WebSocket of `ws`, just upgraded. */
export type ScreenSocket = WebSocket;

const OPEN = 1;

export interface ScreensOptions {
  /** The conversation holding the browser of Arianna (AgentBrowser.holder). */
  holder: () => string | null;
  /** The container of the open browser (BrowserManager.active). */
  container: () => string | null;
  /** The kind of a conversation; null when there is none. */
  conversation: (conversationId: string) => Promise<ConversationKind | null>;
  /**
   * Closes the browser of a conversation for the user («Chiudi», after the
   * action under way): true when it held it (AgentBrowser.closeByUser).
   */
  closeBrowser?: (conversationId: string) => Promise<boolean>;
  /** The site the browser of a conversation is on (AgentBrowser.siteOf), for the bar of the chat. */
  site?: (conversationId: string) => string | null;
  /** The address of the page the browser shows (AgentBrowser.urlOf), for the field of the bar of the screen (D-286). */
  url?: (conversationId: string) => string | null;
  /** Whether Arianna is acting in the browser of a conversation now (AgentBrowser.actingFor): the bar is off meanwhile (D-286). */
  acting?: (conversationId: string) => boolean;
  /** A command of the bar of the screen (D-286): AgentBrowser.userCommand. */
  command?: (conversationId: string, command: UserCommand) => Promise<CommandOutcome>;
  /** The Private chat the browser of a work conversation passed to after an access (AgentBrowser.movedFrom, D-281). */
  movedTo?: (conversationId: string) => string | null;
  /** «Prendi il controllo» (D-264, passo 5): AgentBrowser's takeControl, returnControl, userInput, driverOf, blockedOf. */
  control?: {
    take: (conversationId: string) => ControlRequest;
    give: (conversationId: string) => boolean;
    input: (conversationId: string) => void;
    /** A click or a key of the user on the screen that drives (D-286): AgentBrowser.userGesture; a move of the mouse is none. */
    gesture?: (conversationId: string) => void;
    driver: (conversationId: string) => Driver | null;
    blocked: (conversationId: string) => BlockedNavigation | null;
    /** The site of an access made by the user (D-276), for the chat. */
    access?: (conversationId: string) => string | null;
  };
  /** The control was taken or went back (the system lines of the chat). */
  onControl?: (conversationId: string, change: { state: 'taken' } | { state: 'returned'; reason: ControlEnd }) => void;
  /** Tests: CONTROL_IDLE_MS and how often it is checked. */
  controlIdleMs?: number;
  controlCheckMs?: number;
  openChannel?: OpenChannel;
  onEvent?: (event: NewEvent) => void;
  now?: () => number;
  pingMs?: number;
  maxScreens?: number;
  /** Tests: the thresholds of the backpressure and of the queue toward Xvnc. */
  limits?: { highWater?: number; lowWater?: number; maxInbound?: number };
}

interface Binding {
  hash: Buffer;
  conversationId: string;
  container: string;
  /** Consumed by the screen it opened: it opens no other. */
  used: boolean;
}

interface Screen {
  /** The sha256 of its token: names the screen for the control. */
  hash: Buffer;
  filter: RfbFilter | null;
  /** When keys or pointer of the user last went through, in control. */
  lastInput: number;
  /** Counts of the filter when this screen got the control. */
  countsAtControl: InputCounts;
  socket: ScreenSocket;
  channel: Channel | null;
  conversationId: string;
  container: string;
  openedAt: number;
  closed: boolean;
  ping: ReturnType<typeof setInterval> | undefined;
}

function sha256(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class BrowserScreens {
  readonly #options: ScreensOptions;
  readonly #open: OpenChannel;
  readonly #now: () => number;
  #tokens: Binding[] = [];
  readonly #screens = new Set<Screen>();
  #stopped = false;
  /** The screen that drives, and the control under way. */
  #controller: Screen | null = null;
  #control: { conversationId: string; container: string; since: number; keys: number; clicks: number; timer: ReturnType<typeof setInterval> } | null = null;

  constructor(options: ScreensOptions) {
    this.#options = options;
    this.#open = options.openChannel ?? openDockerChannel;
    this.#now = options.now ?? Date.now;
  }

  /** Screens open now. */
  get open(): number {
    return this.#screens.size;
  }

  /** A token for the screen of the browser `conversationId` holds now. */
  async issue(conversationId: string): Promise<IssueResult> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return { ok: false, reason: 'not-found' };
    if (kind === 'private' || kind === 'incognito') return { ok: false, reason: kind };
    const container = this.#current(conversationId);
    if (this.#stopped || container === null) return { ok: false, reason: 'no-browser' };
    // Refused here too, so the chat can say why: noVNC does not pass on the close code of the stream (4002 stays for two screens opened at once)
    const sameBrowser = [...this.#screens].filter((screen) => screen.container === container).length;
    if (sameBrowser >= (this.#options.maxScreens ?? MAX_SCREENS)) return { ok: false, reason: 'too-many-screens' };
    this.#prune();
    const token = randomBytes(32).toString('base64url');
    this.#tokens.push({ hash: sha256(token), conversationId, container, used: false });
    if (this.#tokens.length > MAX_TOKENS) this.#tokens.shift();
    return { ok: true, token };
  }

  /**
   * Whether the browser of `conversationId` is open now, for the bar of the
   * chat («Browser aperto · Guarda · Chiudi»); null when there is no such
   * conversation. Never open for a Private or incognito one.
   */
  async status(
    conversationId: string,
    token?: string,
  ): Promise<{ open: boolean; site?: string; url?: string; acting?: true; control?: ControlState; blocked?: BlockedNavigation; access?: string; movedTo?: string; chat?: true } | null> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return null;
    const open = screened(kind) && !this.#stopped && this.#current(conversationId) !== null;
    if (!open) {
      // The browser passed to the Private chat of an access (D-281): the work conversation shows where.
      const movedTo = kind === 'work' && !this.#stopped ? (this.#options.movedTo?.(conversationId) ?? null) : null;
      return movedTo === null ? { open } : { open, movedTo };
    }
    const site = this.#options.site?.(conversationId) ?? null;
    // The address only to a screen open now (its token): the field of its bar (D-286).
    const url = token !== undefined && this.#screenOf(conversationId, token) !== null ? (this.#options.url?.(conversationId) ?? null) : null;
    const driver = this.#options.control?.driver(conversationId) ?? null;
    let control: ControlState | undefined;
    if (driver === 'agent') control = 'agent';
    else if (driver === 'user') {
      const here = token === undefined || !TOKEN_PATTERN.test(token) ? null : sha256(token);
      const controller = this.#controller;
      control = here === null || controller === null ? 'user' : timingSafeEqual(here, controller.hash) ? 'you' : 'other';
    }
    const blocked = this.#options.control?.blocked(conversationId) ?? null;
    const access = this.#options.control?.access?.(conversationId) ?? null;
    return {
      open,
      ...(site === null ? {} : { site }),
      ...(url === null ? {} : { url }),
      ...(this.#options.acting?.(conversationId) === true ? { acting: true as const } : {}),
      ...(control === undefined ? {} : { control }),
      ...(blocked === null ? {} : { blocked }),
      ...(access === null ? {} : { access }),
      // The Private chat of an access (D-281): there Arianna reads the pages, with the local model.
      ...(kind === 'browser' ? { chat: true } : {}),
    };
  }

  /**
   * «Prendi il controllo» from the screen of `token` (open now, of the
   * browser `conversationId` holds): after the action of Arianna under way
   * (`waiting`), never in the middle of one. The screen that drove before,
   * if another, goes back to view.
   */
  async take(conversationId: string, token: string): Promise<TakeResult> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return { ok: false, reason: 'not-found' };
    const control = this.#options.control;
    if (!screened(kind) || control === undefined || this.#current(conversationId) === null) return { ok: false, reason: 'no-browser' };
    const screen = this.#screenOf(conversationId, token);
    if (screen === null) return { ok: false, reason: 'no-screen' };
    const request = control.take(conversationId);
    const done = request.done.then((taken) => {
      if (!taken) return false;
      // The screen closed, or the browser went, while Arianna finished her action.
      if (screen.closed || !this.#holds(screen.conversationId, screen.container)) {
        if (this.#controller === null) this.#returnAgent(conversationId, 'screen-closed');
        return false;
      }
      this.#handTo(screen);
      return true;
    });
    return { ok: true, waiting: request.waiting, done };
  }

  /**
   * A command of the bar of the screen of `token` (D-286): open now, of the
   * browser `conversationId` holds. Event `browser.control` L0 with the
   * command and its outcome, never an address nor a site.
   */
  async navigate(conversationId: string, token: string, command: UserCommand): Promise<NavigateResult> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return { ok: false, reason: 'not-found' };
    const run = this.#options.command;
    if (!screened(kind) || run === undefined || this.#current(conversationId) === null) return { ok: false, reason: 'no-browser' };
    if (this.#screenOf(conversationId, token) === null) return { ok: false, reason: 'no-screen' };
    const outcome = await run(conversationId, command);
    this.#options.onEvent?.({ kind: 'browser.control', label: 'L0', payload: { conversationId, command: command.kind, outcome: outcome.ok ? 'ok' : outcome.reason } });
    return outcome;
  }

  /** «Restituisci ad Arianna»: false when the user did not drive that browser. */
  async giveBack(conversationId: string): Promise<'returned' | 'not-driving' | 'not-found'> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return 'not-found';
    if (this.#options.control?.driver(conversationId) !== 'user') return 'not-driving';
    this.#endControl('user');
    // No screen held it (a state left by a race): the browser is Arianna's again all the same.
    if (this.#options.control.driver(conversationId) === 'user') this.#returnAgent(conversationId, 'user');
    return 'returned';
  }

  /**
   * «Chiudi» in the chat (D-264, passo 4): only the conversation holding the
   * browser closes it; its screens close with it. Event `browser.close`, L0,
   * reason `user`, without content.
   */
  async closeByUser(conversationId: string): Promise<CloseResult> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return 'not-found';
    const close = this.#options.closeBrowser;
    if (close === undefined || this.#options.holder() !== conversationId) return 'no-browser';
    if (!(await close(conversationId))) return 'no-browser';
    this.revoke();
    this.#options.onEvent?.({ kind: 'browser.close', label: 'L0', payload: { conversationId, reason: 'user' } });
    return 'closed';
  }

  /** Whether a token holds now and opened no screen yet: checked before the upgrade, so a wrong one never gets a WebSocket. */
  valid(token: string): boolean {
    return this.#binding(token) !== null;
  }

  /** The open screen of a token, of the browser `conversationId` holds now. */
  #screenOf(conversationId: string, token: string): Screen | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const hash = sha256(token);
    let found: Screen | null = null;
    for (const screen of this.#screens) {
      if (timingSafeEqual(screen.hash, hash) && screen.conversationId === conversationId && !screen.closed && this.#holds(screen.conversationId, screen.container)) found = screen;
    }
    return found;
  }

  /** The control goes to `screen`: its filter forwards keys and pointer, the one before goes back to view. */
  #handTo(screen: Screen): void {
    const before = this.#controller;
    if (before === screen) return;
    if (before !== null) this.#release(before);
    this.#controller = screen;
    screen.filter?.setMode('control');
    screen.countsAtControl = screen.filter?.counts ?? { keys: 0, clicks: 0 };
    screen.lastInput = this.#now();
    if (this.#control === null || this.#control.conversationId !== screen.conversationId || this.#control.container !== screen.container) {
      if (this.#control !== null) clearInterval(this.#control.timer);
      const timer = setInterval(() => { this.#checkIdle(); }, this.#options.controlCheckMs ?? CONTROL_CHECK_MS);
      timer.unref();
      this.#control = { conversationId: screen.conversationId, container: screen.container, since: this.#now(), keys: 0, clicks: 0, timer };
      this.#controlEvent({ state: 'taken', conversationId: screen.conversationId });
      this.#safely(() => { this.#options.onControl?.(screen.conversationId, { state: 'taken' }); });
    }
  }

  /** A screen that drove goes back to view; its keys and clicks are added to the control. */
  #release(screen: Screen): void {
    screen.filter?.setMode('view');
    const counts = screen.filter?.counts ?? screen.countsAtControl;
    if (this.#control !== null) {
      this.#control.keys += counts.keys - screen.countsAtControl.keys;
      this.#control.clicks += counts.clicks - screen.countsAtControl.clicks;
    }
    if (this.#controller === screen) this.#controller = null;
  }

  /** The control ends for `reason`: the screen goes back to view, Arianna drives again (unless the browser went). */
  #endControl(reason: ControlEnd): void {
    const controller = this.#controller;
    if (controller !== null) this.#release(controller);
    const control = this.#control;
    if (control === null) return;
    this.#control = null;
    clearInterval(control.timer);
    if (reason !== 'browser-closed') this.#options.control?.give(control.conversationId);
    this.#controlEvent({ state: 'returned', conversationId: control.conversationId, reason, ms: Math.max(0, this.#now() - control.since), keys: control.keys, clicks: control.clicks });
    this.#safely(() => { this.#options.onControl?.(control.conversationId, { state: 'returned', reason }); });
  }

  /** Arianna drives again without a control under way here (it was never handed to a screen). */
  #returnAgent(conversationId: string, reason: ControlEnd): void {
    if (this.#options.control?.give(conversationId) !== true) return;
    this.#controlEvent({ state: 'returned', conversationId, reason, ms: 0, keys: 0, clicks: 0 });
    this.#safely(() => { this.#options.onControl?.(conversationId, { state: 'returned', reason }); });
  }

  #checkIdle(): void {
    const controller = this.#controller;
    if (controller === null) {
      // The screen went without ending the control (it cannot, but a timer must never run alone).
      if (this.#control !== null) this.#endControl(this.#holds(this.#control.conversationId, this.#control.container) ? 'screen-closed' : 'browser-closed');
      return;
    }
    if (this.#now() - controller.lastInput >= (this.#options.controlIdleMs ?? CONTROL_IDLE_MS)) this.#endControl('idle');
  }

  #controlEvent(payload: NonNullable<NewEvent['payload']>): void {
    try {
      this.#options.onEvent?.({ kind: 'browser.control', label: 'L0', payload });
    } catch {
      console.warn('browser: the event of the control failed');
    }
  }

  #safely(callback: () => void): void {
    try {
      callback();
    } catch {
      console.warn('browser: a callback of the screens failed');
    }
  }

  /** Bridges a WebSocket just upgraded with `token` to Xvnc; closes it when the token no longer holds. */
  attach(token: string, socket: ScreenSocket): void {
    const binding = this.#binding(token);
    if (binding === null) {
      socket.close(SCREEN_CLOSE.browserClosed.code, SCREEN_CLOSE.browserClosed.reason);
      return;
    }
    const sameBrowser = [...this.#screens].filter((screen) => screen.container === binding.container).length;
    if (sameBrowser >= (this.#options.maxScreens ?? MAX_SCREENS)) {
      socket.close(SCREEN_CLOSE.tooMany.code, SCREEN_CLOSE.tooMany.reason);
      return;
    }
    // One screen per token: the token now names it.
    binding.used = true;
    const screen: Screen = { hash: binding.hash, filter: null, lastInput: 0, countsAtControl: { keys: 0, clicks: 0 }, socket, channel: null, conversationId: binding.conversationId, container: binding.container, openedAt: this.#now(), closed: false, ping: undefined };
    // An oversized frame or a broken socket: reported here, or it would stop the process.
    socket.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') this.#end(screen, 'overflow', true, 'frame-too-long');
      else this.#end(screen, 'refused', true, 'socket-error');
    });
    socket.on('close', () => { this.#end(screen, 'browserClosed', false, 'page-closed'); });
    let channel: Channel;
    try {
      channel = this.#open(binding.container, VNC_SOCKET);
    } catch {
      socket.close(SCREEN_CLOSE.vncClosed.code, SCREEN_CLOSE.vncClosed.reason);
      return;
    }
    screen.channel = channel;
    this.#screens.add(screen);
    this.#event(screen, 'opened');
    this.#bridge(screen, channel);
  }

  /** Closes the screens and forgets the tokens of a browser no longer held as they were bound. */
  revoke(): void {
    this.#prune();
    if (this.#control !== null && !this.#holds(this.#control.conversationId, this.#control.container)) this.#endControl('browser-closed');
    for (const screen of [...this.#screens]) {
      if (!this.#holds(screen.conversationId, screen.container)) this.#end(screen, 'browserClosed', true);
    }
  }

  /** At the shutdown of the core: every screen closes, every token dies. */
  close(): void {
    if (this.#control !== null) this.#endControl('browser-closed');
    this.#stopped = true;
    this.#tokens = [];
    for (const screen of [...this.#screens]) this.#end(screen, 'stopping', true);
  }

  #bridge(screen: Screen, channel: Channel): void {
    const { socket } = screen;
    const { stream } = channel;
    const filter = createRfbFilter('view');
    screen.filter = filter;
    const highWater = this.#options.limits?.highWater ?? HIGH_WATER;
    const lowWater = this.#options.limits?.lowWater ?? LOW_WATER;
    const maxInbound = this.#options.limits?.maxInbound ?? MAX_INBOUND_QUEUE;
    let paused = false;
    stream.on('data', (chunk: Buffer) => {
      if (screen.closed || socket.readyState !== OPEN) return;
      socket.send(chunk, { binary: true }, () => {
        if (paused && !screen.closed && socket.bufferedAmount < lowWater) {
          paused = false;
          stream.resume();
        }
      });
      if (!paused && socket.bufferedAmount > highWater) {
        paused = true;
        stream.pause();
      }
    });
    stream.on('end', () => { this.#end(screen, this.#reasonOfChannelEnd(screen), true); });
    stream.on('close', () => { this.#end(screen, this.#reasonOfChannelEnd(screen), true); });
    stream.on('error', () => { this.#end(screen, this.#reasonOfChannelEnd(screen), true); });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (screen.closed) return;
      if (!isBinary) {
        this.#end(screen, 'refused', true, 'text-frame');
        return;
      }
      const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const before = filter.mode === 'control' ? filter.counts : undefined;
      const activationsBefore = filter.activations;
      const step = filter.push(chunk);
      for (const part of step.forward) stream.write(part);
      // Input of the user on the screen that drives: activity for the browser and for the 5 minutes.
      if (before !== undefined && this.#controller === screen) {
        const after = filter.counts;
        if (after.keys !== before.keys || after.clicks !== before.clicks || step.forward.some((part) => part[0] === 4 || part[0] === 5)) {
          screen.lastInput = this.#now();
          this.#safely(() => { this.#options.control?.input(screen.conversationId); });
          // A click, Enter or Space chooses a page (D-286); a key of a text never.
          if (after.clicks !== before.clicks || filter.activations !== activationsBefore) this.#safely(() => { this.#options.control?.gesture?.(screen.conversationId); });
        }
      }
      if (step.close !== undefined) {
        this.#end(screen, 'refused', true, step.close);
        return;
      }
      if (stream.writableLength > maxInbound) this.#end(screen, 'overflow', true);
    });
    // A page that went away without closing: found by its missing pong.
    let alive = true;
    socket.on('pong', () => { alive = true; });
    screen.ping = setInterval(() => {
      if (!alive) {
        this.#end(screen, 'browserClosed', false, 'no-pong');
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, this.#options.pingMs ?? PING_MS);
    screen.ping.unref();
  }

  /** The channel ended: because the browser went, or on its own. */
  #reasonOfChannelEnd(screen: Screen): ScreenCloseKey {
    return this.#holds(screen.conversationId, screen.container) ? 'vncClosed' : 'browserClosed';
  }

  /** Ends a screen once: the channel, the socket (when `closeSocket`), the event. */
  #end(screen: Screen, key: ScreenCloseKey, closeSocket: boolean, detail?: FilterClose | 'text-frame' | 'page-closed' | 'frame-too-long' | 'socket-error' | 'no-pong'): void {
    if (screen.closed) return;
    screen.closed = true;
    if (screen.ping !== undefined) clearInterval(screen.ping);
    // The screen that drove: the control goes back to Arianna at once (or ends with the browser).
    if (this.#controller === screen) this.#endControl(this.#holds(screen.conversationId, screen.container) ? 'screen-closed' : 'browser-closed');
    const wasOpen = this.#screens.delete(screen);
    screen.channel?.close();
    if (closeSocket && screen.socket.readyState === OPEN) {
      const { code, reason } = SCREEN_CLOSE[key];
      screen.socket.close(code, reason);
    }
    if (wasOpen) this.#event(screen, 'closed', detail ?? SCREEN_CLOSE[key].reason);
  }

  #event(screen: Screen, state: 'opened' | 'closed', reason?: string): void {
    const payload: NonNullable<NewEvent['payload']> =
      state === 'opened'
        ? { state, conversationId: screen.conversationId }
        : { state, conversationId: screen.conversationId, ms: Math.max(0, this.#now() - screen.openedAt), reason: reason ?? 'closed' };
    try {
      this.#options.onEvent?.({ kind: 'browser.screen', label: 'L0', payload });
    } catch {
      console.warn('browser: the event of a screen failed');
    }
  }

  /** The container `conversationId` holds now, if any. */
  #current(conversationId: string): string | null {
    if (this.#options.holder() !== conversationId) return null;
    return this.#options.container();
  }

  #holds(conversationId: string, container: string): boolean {
    return !this.#stopped && this.#current(conversationId) === container;
  }

  /** Forgets the tokens of browsers no longer held as they were bound. */
  #prune(): void {
    this.#tokens = this.#tokens.filter((binding) => this.#holds(binding.conversationId, binding.container));
  }

  /** The binding of a token that holds now and opened no screen yet; every kept hash is compared, in constant time. */
  #binding(token: string): Binding | null {
    if (this.#stopped || !TOKEN_PATTERN.test(token)) return null;
    const hash = sha256(token);
    let found: Binding | null = null;
    for (const binding of this.#tokens) {
      if (timingSafeEqual(binding.hash, hash)) found = binding;
    }
    if (found === null || found.used || !this.#holds(found.conversationId, found.container)) return null;
    return found;
  }
}

/** The kind of a conversation, from its mode, its incognito flag and the work conversation its browser came from (D-281). */
export function conversationKindOf(sql: Sql): ScreensOptions['conversation'] {
  return async (conversationId) => {
    const [row] = await sql<{ mode: string; incognito: boolean; browserChat: boolean }[]>`
      SELECT mode, incognito, browser_of IS NOT NULL AS "browserChat" FROM conversations WHERE id = ${conversationId}`;
    if (row === undefined) return null;
    if (row.incognito) return 'incognito';
    if (row.browserChat) return 'browser';
    return row.mode === 'work' ? 'work' : 'private';
  };
}
