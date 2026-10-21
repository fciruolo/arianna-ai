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
  close(): Promise<void>;
}

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
  try {
    context = browser.contexts()[0];
    if (!context) throw new Error('the browser has no context');
    // The session stays attached: Chromium forgets the behavior when the session that set it detaches.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    if (options.network) {
      const { userAgent } = await cdp.send('Browser.getVersion');
      network = await attachNetwork(context, { ...options.network, userAgent: reducedUserAgent(userAgent) });
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

  let page: Page | undefined = shared.pages()[0];
  // A link with target=_blank opens a tab: the agent goes on there, as a person would.
  shared.on('page', (opened) => {
    page = opened;
  });
  const current = async (): Promise<Page> => {
    if (!page || page.isClosed()) page = await shared.newPage();
    return page;
  };
  return {
    browser,
    context: shared,
    ...(network === undefined ? {} : { network }),
    async openPage(url, timeoutMs = 15_000) {
      open.touch();
      const target = await current();
      try {
        await target.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
      } catch (error) {
        // A failed navigation goes on to Chromium's error page, which would interrupt the next goto:
        // the next action gets a fresh tab (opened first, so the window never has none).
        // If even the new tab fails, the error of the navigation is the one that counts.
        page = await shared.newPage().catch(() => undefined);
        if (page) await target.close().catch(() => undefined);
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
      page = await shared.newPage().catch(() => undefined);
      if (page && old && !old.isClosed()) await old.close().catch(() => undefined);
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
