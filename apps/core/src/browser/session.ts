import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { cdpTransport } from './transport.ts';
import type { OpenBrowser } from './manager.ts';

/**
 * Playwright on the browser of the container (D-264): connectOverCDP over
 * the docker exec channel, the context Chromium already has, downloads
 * refused. Only what step 1 needs: open a page, take a screenshot.
 */

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  openPage(url: string, timeoutMs?: number): Promise<{ title: string; url: string }>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Where Playwright keeps its artifacts (traces, videos: none used), instead of the temp folder of the Mac. */
export const ARTIFACTS_DIR = 'data/tmp/browser';

export async function connectSession(open: OpenBrowser, home: string): Promise<BrowserSession> {
  const artifactsDir = join(home, ARTIFACTS_DIR);
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  const transport = cdpTransport(open.devtoolsPath, open.cdpChannel());
  try {
    await transport.ready;
  } catch (error) {
    transport.close();
    throw error;
  }
  // noDefaults: Playwright leaves the default context as Chromium has it, so it
  // does not ask for downloads saved into a folder of the Mac (allowAndName);
  // the refusal below is ours.
  const browser = await chromium.connectOverCDP(transport, { timeout: 15_000, noDefaults: true, artifactsDir });
  let context: BrowserContext | undefined;
  try {
    context = browser.contexts()[0];
    if (!context) throw new Error('the browser has no context');
    // The session stays attached: Chromium forgets the behavior when the session that set it detaches.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
  const shared = context;

  let page: Page | undefined = shared.pages()[0];
  const current = async (): Promise<Page> => {
    if (!page || page.isClosed()) page = await shared.newPage();
    return page;
  };
  return {
    browser,
    context: shared,
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
      return { title: await target.title(), url: target.url() };
    },
    async screenshot() {
      open.touch();
      return (await current()).screenshot({ type: 'png' });
    },
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}
