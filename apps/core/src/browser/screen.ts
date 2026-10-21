import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { RawData, WebSocket } from 'ws';

import type { Sql } from '../db/client.ts';
import type { NewEvent } from '../events.ts';
import { openDockerChannel, type Channel, type OpenChannel } from './channel.ts';
import { VNC_SOCKET } from './container.ts';
import { createRfbFilter, type FilterClose } from './rfb-filter.ts';

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
 * there anyway). One token may open several screens while it holds (the Mac
 * and the phone), at most MAX_SCREENS at once per browser.
 */

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

export type ConversationKind = 'work' | 'private' | 'incognito';

/** «Chiudi» of the chat: closed, no browser held by that conversation, or no such conversation. */
export type CloseResult = 'closed' | 'no-browser' | 'not-found';

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
}

interface Screen {
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
    if (kind !== 'work') return { ok: false, reason: kind };
    const container = this.#current(conversationId);
    if (this.#stopped || container === null) return { ok: false, reason: 'no-browser' };
    // Refused here too, so the chat can say why: noVNC does not pass on the close code of the stream (4002 stays for two screens opened at once)
    const sameBrowser = [...this.#screens].filter((screen) => screen.container === container).length;
    if (sameBrowser >= (this.#options.maxScreens ?? MAX_SCREENS)) return { ok: false, reason: 'too-many-screens' };
    this.#prune();
    const token = randomBytes(32).toString('base64url');
    this.#tokens.push({ hash: sha256(token), conversationId, container });
    if (this.#tokens.length > MAX_TOKENS) this.#tokens.shift();
    return { ok: true, token };
  }

  /**
   * Whether the browser of `conversationId` is open now, for the bar of the
   * chat («Browser aperto · Guarda · Chiudi»); null when there is no such
   * conversation. Never open for a Private or incognito one.
   */
  async status(conversationId: string): Promise<{ open: boolean; site?: string } | null> {
    const kind = await this.#options.conversation(conversationId);
    if (kind === null) return null;
    const open = kind === 'work' && !this.#stopped && this.#current(conversationId) !== null;
    const site = open ? (this.#options.site?.(conversationId) ?? null) : null;
    return site === null ? { open } : { open, site };
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

  /** Whether a token holds now: checked before the upgrade, so a wrong one never gets a WebSocket. */
  valid(token: string): boolean {
    return this.#binding(token) !== null;
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
    const screen: Screen = { socket, channel: null, conversationId: binding.conversationId, container: binding.container, openedAt: this.#now(), closed: false, ping: undefined };
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
    for (const screen of [...this.#screens]) {
      if (!this.#holds(screen.conversationId, screen.container)) this.#end(screen, 'browserClosed', true);
    }
  }

  /** At the shutdown of the core: every screen closes, every token dies. */
  close(): void {
    this.#stopped = true;
    this.#tokens = [];
    for (const screen of [...this.#screens]) this.#end(screen, 'stopping', true);
  }

  #bridge(screen: Screen, channel: Channel): void {
    const { socket } = screen;
    const { stream } = channel;
    const filter = createRfbFilter('view');
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
      const step = filter.push(chunk);
      for (const part of step.forward) stream.write(part);
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

  /** The binding of a token that holds now; every kept hash is compared, in constant time. */
  #binding(token: string): Binding | null {
    if (this.#stopped || !TOKEN_PATTERN.test(token)) return null;
    const hash = sha256(token);
    let found: Binding | null = null;
    for (const binding of this.#tokens) {
      if (timingSafeEqual(binding.hash, hash)) found = binding;
    }
    if (found === null || !this.#holds(found.conversationId, found.container)) return null;
    return found;
  }
}

/** The kind of a conversation, from its mode and incognito flag. */
export function conversationKindOf(sql: Sql): ScreensOptions['conversation'] {
  return async (conversationId) => {
    const [row] = await sql<{ mode: string; incognito: boolean }[]>`SELECT mode, incognito FROM conversations WHERE id = ${conversationId}`;
    if (row === undefined) return null;
    if (row.incognito) return 'incognito';
    return row.mode === 'work' ? 'work' : 'private';
  };
}
