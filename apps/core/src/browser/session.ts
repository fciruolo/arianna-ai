import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type ConnectOverCDPOptions, type ConnectOverCDPTransport, type Page } from 'playwright-core';

import { attachNetwork, type NetworkHandle, type NetworkJob } from './network.ts';
import { cdpTransport } from './transport.ts';
import type { OpenBrowser } from './manager.ts';

/**
 * Playwright on the browser of the container (D-264): connectOverCDP over
 * the CDP pipe of the container, the context Chromium already has, downloads
 * refused, and with `network` every request decided by the core (network.ts,
 * step 2). Open a page, take a screenshot. Closing
 * the session closes the browser: the container has one session only.
 */

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  /** The network of the job (D-264, passo 2), when the session was opened with one. */
  network?: NetworkHandle;
  openPage(url: string, timeoutMs?: number): Promise<{ title: string; url: string }>;
  /** The tab the agent acts on: the last one opened (a popup of a click becomes it), a new one when none is left. */
  currentPage(): Promise<Page>;
  /** After a refused navigation: a fresh tab in place of the current one, left on Chromium's error page. */
  resetPage(): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** Activity without an action of the agent (the user drives, D-264 passo 5): the idle time starts again. */
  touch?(): void;
  close(): Promise<void>;
}

/** How long a tab the agent leaves is waited for to close (D-283 review): it is retired anyway. */
export const RETIRE_MS = 2_000;

/** Where Playwright keeps its artifacts (traces, videos: none used), inside the data folder, never the temp folder of the Mac. */
export const ARTIFACTS_SUBDIR = join('tmp', 'browser');

export type ConnectCdp = (transport: ConnectOverCDPTransport, options: ConnectOverCDPOptions) => Promise<Browser>;

export interface SessionOptions {
  home: string;
  /** The data folder of the installation (config.paths.data), when the caller knows it; else data/ of home. */
  dataDir?: string;
  /** chromium.connectOverCDP; injectable for tests. */
  connect?: ConnectCdp;
  /**
   * The network of the job (D-264, passo 2): attached before the first
   * navigation, with the User-Agent of this Chromium (Browser.getVersion).
   * Without it the browser has no network at all (step 1).
   */
  network?: Omit<NetworkJob, 'userAgent'>;
}

export function artifactsDir(options: SessionOptions): string {
  return join(options.dataDir ?? join(options.home, 'data'), ARTIFACTS_SUBDIR);
}

export async function connectSession(open: OpenBrowser, options: SessionOptions): Promise<BrowserSession> {
  const artifacts = artifactsDir(options);
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const connect: ConnectCdp = options.connect ?? ((transport, connectOptions) => chromium.connectOverCDP(transport, connectOptions));
  // noDefaults: Playwright leaves the default context as Chromium has it, so it
  // does not ask for downloads saved into a folder of the Mac (allowAndName);
  // the refusal below is ours.
  let browser: Browser;
  try {
    browser = await connect(cdpTransport(open.cdp), { timeout: 15_000, noDefaults: true, artifactsDir: artifacts });
  } catch (error) {
    await open.close();
    throw error;
  }
  // Playwright lost the browser: the container goes too. A close of ours is
  // marked first, so that it stays `stopped` and never becomes `disconnected`.
  let closing = false;
  browser.on('disconnected', () => {
    if (!closing) void open.close('disconnected');
  });
  let context: BrowserContext | undefined;
  let network: NetworkHandle | undefined;
  /**
   * Tabs the agent left (D-283 review): being closed, or that would not close.
   * The tabs Chromium has at the start, on its error page and outside the
   * window (no network), never finish closing (tried on 2026-10-22: no
   * request was under way, the close itself does not end). Such a tab stays
   * alive in the same context: the network refuses the requests of its frames
   * (those Playwright attributes to a frame; a service worker's are not), its
   * navigations are not the agent's, and a tab it opens is never the agent's.
   */
  const retired = new WeakSet<Page>();
  /** Tabs the agent opened itself (`fresh`): never retired as an orphan when Chromium tells of them. */
  const known = new WeakSet<Page>();
  /** The new tab being opened by `fresh`, if any: a tab without opener is judged once it is known. */
  let creating: Promise<unknown> = Promise.resolve();
  try {
    context = browser.contexts()[0];
    if (!context) throw new Error('the browser has no context');
    // The session stays attached: Chromium forgets the behavior when the session that set it detaches.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    if (options.network) {
      const { userAgent } = await cdp.send('Browser.getVersion');
      network = await attachNetwork(context, { ...options.network, userAgent: reducedUserAgent(userAgent), isRetired: (tab) => retired.has(tab) });
    }
  } catch (error) {
    closing = true;
    await network?.close();
    // The manager first: closing Playwright closes the CDP pipe, which the manager would take for a disconnection.
    await open.close();
    await browser.close().catch(() => undefined);
    throw error;
  }
  const shared = context;

  /**
   * The tab of the agent. None at the start: the tabs Chromium has then are
   * not the agent's (D-283, third trial, 2026-10-22: the first one listed
   * was on the error page and outside the window, so the agent opened its
   * page where the screen of the chat never shows it). The first action
   * opens a new tab, in the window, in front (`fresh`).
   */
  let page: Page | undefined;
  /** Leaves a tab: retired at once, closed with a short bound (a tab of the kiosk window never closes). */
  const retire = async (tab: Page): Promise<void> => {
    retired.add(tab);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      tab.close().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, RETIRE_MS); }),
    ]);
    clearTimeout(timer);
    // Still open: out of sight at least, on an empty page (not waited for, as its close).
    if (!closed && !tab.isClosed()) void tab.goto('about:blank').catch(() => undefined);
    // The screen shows the tab in front: the agent's again.
    if (page !== undefined && page !== tab && !page.isClosed()) await page.bringToFront().catch(() => undefined);
  };
  // A link with target=_blank opens a tab: the agent goes on there, as a person would. Only a tab its own
  // tab opened: one with no opener (its opener closed meanwhile, or opened otherwise) or a left tab's is retired.
  shared.on('page', (opened) => {
    void opened.opener().then(
      (opener) => {
        if (opener !== null && opener === page && !retired.has(opener)) {
          page = opened;
          return;
        }
        if (opener !== null) {
          void retire(opened);
          return;
        }
        // No opener: the agent's own new tab (known once newPage answers), or one nobody of the agent opened.
        void creating.then(() => new Promise((resolve) => setImmediate(resolve))).then(() => {
          if (!known.has(opened)) void retire(opened);
        });
      },
      () => { void retire(opened); },
    );
  });
  /**
   * A new tab for the agent, in front, and the empty tabs behind it closed: when the first tab of
   * Chromium was not listed yet at the connection, the window kept showing it and the screen of
   * the chat stayed white while the agent read its own tab (D-281 trial). Opened first, so the
   * window never has no tab.
   */
  const fresh = async (): Promise<Page> => {
    const making = shared.newPage();
    creating = making.catch(() => undefined);
    const created = await making;
    // The agent's from now on: a tab it is opening is not retired as an orphan by the listener above.
    known.add(created);
    await created.bringToFront().catch(() => undefined);
    // Every other tab is left: the empty ones waited for (a short bound), the others (Chromium's own, on the
    // error page since the start) retired at once and closed behind.
    const others = shared.pages().filter((other) => other !== created && !retired.has(other));
    for (const other of others) if (other.url() !== 'about:blank') { retired.add(other); void other.close().catch(() => undefined); }
    await Promise.all(others.filter((other) => other.url() === 'about:blank').map((other) => retire(other)));
    await created.bringToFront().catch(() => undefined);
    return created;
  };
  const current = async (): Promise<Page> => {
    if (!page || page.isClosed()) page = await fresh();
    return page;
  };
  return {
    browser,
    context: shared,
    ...(network === undefined ? {} : { network }),
    async openPage(url, timeoutMs = 15_000) {
      open.touch();
      const target = await current();
      // The screen of the chat shows the window: the page the agent opens is the tab in front.
      await target.bringToFront().catch(() => undefined);
      try {
        await target.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
      } catch (error) {
        // A failed navigation goes on to Chromium's error page, which would interrupt the next goto:
        // the next action gets a fresh tab (opened first, so the window never has none).
        // If even the new tab fails, the error of the navigation is the one that counts.
        // The old tab is left at once, whatever happens to the new one: nothing of it is the agent's any more.
        retired.add(target);
        page = await fresh().catch(() => undefined);
        // Closed with a bound: a tab of the kiosk window may never finish closing (D-283 trial, 2026-10-22),
        // which held the action until its deadline of 45 s and lost the browser.
        await retire(target);
        throw error;
      }
      // A redirect followed by the core moves the frame to its final address: wait for it.
      await network?.settle(target, timeoutMs);
      return { title: await target.title(), url: target.url() };
    },
    // Every action of the agent reads the page through here: the idle time starts again.
    async currentPage() {
      open.touch();
      return current();
    },
    async resetPage() {
      const old = page;
      // Left at once, as in openPage, whatever happens to the new tab.
      if (old) retired.add(old);
      page = await fresh().catch(() => undefined);
      if (old && !old.isClosed()) await retire(old);
    },
    touch() {
      open.touch();
    },
    async screenshot() {
      open.touch();
      return (await current()).screenshot({ type: 'png' });
    },
    async close() {
      closing = true;
      await network?.close();
      // The manager first, with `stopped`: closing Playwright closes the CDP
      // pipe, and the manager would record that as `disconnected`.
      await open.close('stopped');
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Chromium sends its User-Agent with the minor version zeroed
 * ("Chrome/155.0.0.0"), while Browser.getVersion gives the full one: the
 * requests of the core use the same reduced form, so they look like the
 * browser's own and do not add a detail that tells them apart.
 */
export function reducedUserAgent(userAgent: string): string {
  return userAgent.replace(/\b(Chrome|HeadlessChrome)\/(\d+)\.\d+\.\d+\.\d+/g, 'Chrome/$2.0.0.0');
}
