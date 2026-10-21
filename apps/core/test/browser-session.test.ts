import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import type { Browser, ConnectOverCDPOptions } from 'playwright-core';

import type { CloseReason, OpenBrowser } from '../src/browser/manager.ts';
import { artifactsDir, connectSession, reducedUserAgent, type ConnectCdp } from '../src/browser/session.ts';
import { CdpPipe } from '../src/browser/transport.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'arianna-browser-session-'));
  roots.push(root);
  return root;
}

interface FakeBrowser {
  sent: [string, unknown][];
  detached: number;
  closed: number;
  disconnect?: () => void;
  browser: Browser;
}

function fakeBrowser(options: { contexts?: number; failSend?: boolean; pages?: unknown[]; newPage?: () => Promise<unknown> } = {}): FakeBrowser {
  const fake: FakeBrowser = { sent: [], detached: 0, closed: 0, browser: undefined as unknown as Browser };
  const context = { pages: () => options.pages ?? [], newPage: options.newPage ?? (() => Promise.reject(new Error('not in this test'))), on: () => undefined };
  fake.browser = {
    contexts: () => (options.contexts === 0 ? [] : [context]),
    newBrowserCDPSession: () => Promise.resolve({
      send: (method: string, params: unknown) => {
        fake.sent.push([method, params]);
        return options.failSend ? Promise.reject(new Error('refused')) : Promise.resolve({});
      },
      detach: () => { fake.detached += 1; return Promise.resolve(); },
    }),
    on: (event: string, listener: () => void) => { if (event === 'disconnected') fake.disconnect = listener; },
    close: () => { fake.closed += 1; return Promise.resolve(); },
  } as unknown as Browser;
  return fake;
}

function openBrowser(): { open: OpenBrowser; closes: (CloseReason | undefined)[] } {
  const closes: (CloseReason | undefined)[] = [];
  const stream = new PassThrough();
  const open: OpenBrowser = {
    id: 'a',
    container: 'arianna-browser-a',
    cdp: new CdpPipe({ stream, close: () => { stream.destroy(); } }),
    touch: () => undefined,
    close: (reason) => { closes.push(reason); return Promise.resolve(); },
  };
  return { open, closes };
}

test('session: downloads refused on a CDP session that stays attached, Playwright without defaults', async () => {
  const home = temporary();
  const fake = fakeBrowser();
  let options: ConnectOverCDPOptions | undefined;
  const connect: ConnectCdp = (_transport, connectOptions) => {
    options = connectOptions;
    return Promise.resolve(fake.browser);
  };
  const { open } = openBrowser();
  await connectSession(open, { home, connect });
  assert.deepEqual(fake.sent, [['Browser.setDownloadBehavior', { behavior: 'deny' }]]);
  // Chromium forgets the behavior when the session that set it detaches.
  assert.equal(fake.detached, 0);
  assert.ok(options);
  assert.equal(options.noDefaults, true);
  assert.equal(options.artifactsDir, join(home, 'data', 'tmp', 'browser'));
  assert.ok(existsSync(join(home, 'data', 'tmp', 'browser')));
});

/** A tab that writes what is done to it, in order; `fails` makes its goto fail. */
function fakeTab(name: string, steps: string[], options: { url?: string; fails?: boolean } = {}) {
  let closed = false;
  return {
    isClosed: () => closed,
    close: () => { closed = true; steps.push(`${name}:close`); return Promise.resolve(); },
    bringToFront: () => { steps.push(`${name}:front`); return Promise.resolve(); },
    goto: (url: string) => { steps.push(`${name}:goto ${url}`); return options.fails ? Promise.reject(new Error('timeout')) : Promise.resolve(null); },
    title: () => Promise.resolve('Pagina'),
    url: () => options.url ?? 'https://comune-finto.it/',
  };
}

test('session: the tab of the agent is in front before it opens a page, and an empty first tab not listed at the connection is closed (D-281)', async () => {
  for (const listed of [true, false]) {
    const steps: string[] = [];
    const first = fakeTab('first', steps, { url: 'about:blank' });
    const created = fakeTab('created', steps);
    // Chromium lists its first tab late: by the time the agent's tab exists, both are there.
    const tabs: unknown[] = listed ? [first] : [];
    const fake = fakeBrowser({ pages: tabs, newPage: () => { steps.push('new'); tabs.push(first, created); return Promise.resolve(created); } });
    const session = await connectSession(openBrowser().open, { home: temporary(), connect: () => Promise.resolve(fake.browser) });
    await session.openPage('https://comune-finto.it/');
    if (listed) assert.deepEqual(steps, ['first:front', 'first:goto https://comune-finto.it/']);
    else assert.deepEqual(steps, ['new', 'created:front', 'first:close', 'created:front', 'created:goto https://comune-finto.it/']);
  }
});

test('session: after a failed page the new tab is in front, never the empty one behind it (D-281)', async () => {
  const steps: string[] = [];
  const failing = fakeTab('failing', steps, { fails: true });
  const created = fakeTab('created', steps, { url: 'about:blank' });
  const tabs: unknown[] = [failing];
  const fake = fakeBrowser({ pages: tabs, newPage: () => { steps.push('new'); tabs.push(created); return Promise.resolve(created); } });
  const session = await connectSession(openBrowser().open, { home: temporary(), connect: () => Promise.resolve(fake.browser) });
  await assert.rejects(session.openPage('https://comune-finto.it/'));
  assert.deepEqual(steps, ['failing:front', 'failing:goto https://comune-finto.it/', 'new', 'created:front', 'failing:close']);
});

test('session: the artifacts go in the configured data folder when it is known', () => {
  assert.equal(artifactsDir({ home: '/h', dataDir: '/h/altrove' }), join('/h/altrove', 'tmp', 'browser'));
  assert.equal(artifactsDir({ home: '/h' }), join('/h', 'data', 'tmp', 'browser'));
});

test('session: a failed setup closes Playwright and the browser', async () => {
  for (const fake of [fakeBrowser({ failSend: true }), fakeBrowser({ contexts: 0 })]) {
    const { open, closes } = openBrowser();
    await assert.rejects(connectSession(open, { home: temporary(), connect: () => Promise.resolve(fake.browser) }));
    assert.equal(fake.closed, 1);
    assert.equal(closes.length, 1);
  }
  const { open, closes } = openBrowser();
  await assert.rejects(connectSession(open, { home: temporary(), connect: () => Promise.reject(new Error('no CDP')) }));
  assert.equal(closes.length, 1);
});

test('session: Playwright disconnected closes the browser', async () => {
  const fake = fakeBrowser();
  const { open, closes } = openBrowser();
  await connectSession(open, { home: temporary(), connect: () => Promise.resolve(fake.browser) });
  assert.deepEqual(closes, []);
  fake.disconnect?.();
  assert.deepEqual(closes, ['disconnected']);
});

test('session: a close of ours stays stopped, even when Playwright reports the disconnection', async () => {
  const fake = fakeBrowser();
  // A real browser reports `disconnected` while it closes.
  (fake.browser as unknown as { close: () => Promise<void> }).close = () => {
    fake.closed += 1;
    fake.disconnect?.();
    return Promise.resolve();
  };
  const { open, closes } = openBrowser();
  const session = await connectSession(open, { home: temporary(), connect: () => Promise.resolve(fake.browser) });
  await session.close();
  assert.equal(fake.closed, 1);
  assert.deepEqual(closes, ['stopped']);
});

test('the User-Agent of the core has the reduced version Chromium itself sends', () => {
  assert.equal(
    reducedUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.79 Safari/537.36'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  );
  // HeadlessChrome would tell the site it is a robot: never sent.
  assert.equal(reducedUserAgent('Mozilla/5.0 HeadlessChrome/155.1.2.3 Safari/537.36'), 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36');
  assert.equal(reducedUserAgent('Chrome/155.0.0.0'), 'Chrome/155.0.0.0');
});
