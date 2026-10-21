// The live screen of Arianna's browser (D-264, passo 4): browser lines, the tabs of the panel, the refused token, the view-only screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applyActivity, emptyChat } from '../src/lib/chat-state.ts';
import { browserSite, canRetry, isBrowserLine, latestBrowserSite, SCREEN_HINT, SCREEN_TEXT, screenRefusal, screenUrl } from '../src/lib/browser-screen.ts';
import { COMPUTER_TABS, computerTabs, shownTab } from '../src/lib/computer.ts';
import type { Activity } from '../src/lib/types.ts';

const C = 'c1';
const line = (detail: string, extra: Partial<Activity> = {}): Activity => ({ conversationId: C, taskId: 't1', step: 1, kind: 'tool', detail, ...extra });

describe('browser lines', () => {
  it('a line of the browser carries «Guarda», a failure or another tool does not', () => {
    assert.equal(isBrowserLine(line('browser · apre · example.com')), true);
    assert.equal(isBrowserLine(line('browser · legge · example.com', { kind: 'read' })), true);
    assert.equal(isBrowserLine(line('browser · scrive 12 caratteri')), true);
    assert.equal(isBrowserLine(line('browser · Il sito non risponde.', { kind: 'error' })), false);
    assert.equal(isBrowserLine(line('browser · Il sito non risponde.', { kind: 'stop' })), false);
    assert.equal(isBrowserLine(line('web · https://example.com/', { kind: 'read' })), false);
    assert.equal(isBrowserLine(line('browserless')), false);
  });

  it('the site is the third part; a line without a site has none', () => {
    assert.equal(browserSite(line('browser · clic · example.com')), 'example.com');
    assert.equal(browserSite(line('browser · chiude')), undefined);
    assert.equal(browserSite(line('browser · scrive 12 caratteri')), undefined);
    assert.equal(browserSite(line('browser · apre · example.com', { kind: 'error' })), undefined);
  });

  it('the newest site of the conversation, across its tasks; none without browser lines', () => {
    let chat = emptyChat(C);
    assert.equal(latestBrowserSite(chat), undefined);
    chat = applyActivity(chat, line('browser · apre · example.com'));
    chat = applyActivity(chat, line('browser · scrive 3 caratteri', { step: 2 }));
    assert.equal(latestBrowserSite(chat), 'example.com');
    chat = applyActivity(chat, line('browser · clic · example.org', { taskId: 't2', step: 1 }));
    assert.equal(latestBrowserSite(chat), 'example.org');
    assert.equal(latestBrowserSite(applyActivity(emptyChat(C), line('browser · apre · altro.it', { conversationId: 'c2' }))), undefined);
  });
});

describe('tabs of the Computer panel', () => {
  it('without a task of the Coder only the browser; with one every tab, the browser last', () => {
    assert.deepEqual(computerTabs(undefined), ['browser']);
    assert.deepEqual(computerTabs('t1'), COMPUTER_TABS);
    assert.equal(COMPUTER_TABS.at(-1), 'browser');
  });

  it('the tab asked is shown when offered, otherwise the first offered', () => {
    assert.equal(shownTab('browser', computerTabs('t1')), 'browser');
    assert.equal(shownTab('files', computerTabs('t1')), 'files');
    assert.equal(shownTab('terminal', computerTabs(undefined)), 'browser');
  });
});

describe('the token of the screen', () => {
  it('maps a refused POST to the state of the screen', () => {
    assert.equal(screenRefusal(409, 'no-browser'), 'closed');
    assert.equal(screenRefusal(409, 'too-many-screens'), 'too-many');
    assert.equal(screenRefusal(429, undefined), 'error');
    assert.equal(screenRefusal(403, 'private'), 'refused');
    assert.equal(screenRefusal(500, 'HTTP 500'), 'error');
    assert.equal(screenRefusal(404, 'not found'), 'error');
  });

  it('«Riprova» for a closed browser, too many screens or an error; never for a Private conversation or while live', () => {
    assert.equal(canRetry('closed'), true);
    assert.equal(canRetry('ended'), true);
    assert.equal(canRetry('too-many'), true);
    assert.equal(canRetry('error'), true);
    assert.equal(canRetry('refused'), false);
    assert.equal(canRetry('live'), false);
    assert.equal(canRetry('connecting'), false);
  });

  it('a screen closed after it was live explains neutrally: the browser closed or the connection broke', () => {
    assert.equal(SCREEN_TEXT.ended, 'Schermo chiuso');
    assert.equal(SCREEN_HINT.ended, 'Lo schermo si è chiuso: il browser è stato chiuso o il collegamento si è interrotto. Premi «Riprova».');
  });

  it('the stream goes to the same host as the page, wss under https, the token encoded', () => {
    assert.equal(screenUrl({ protocol: 'http:', host: '127.0.0.1:5173' }, 'a+b/c'), 'ws://127.0.0.1:5173/api/browser/screen?t=a%2Bb%2Fc');
    assert.equal(screenUrl({ protocol: 'https:', host: 'mac.local' }, 'x'), 'wss://mac.local/api/browser/screen?t=x');
  });
});

describe('BrowserScreen.vue', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'BrowserScreen.vue'), 'utf8');

  it('is view only: viewOnly on, no focus on click, no clipboard handler, no field', () => {
    assert.match(source, /\.viewOnly = true;/);
    assert.match(source, /\.focusOnClick = false;/);
    assert.match(source, /\.resizeSession = false;/);
    assert.doesNotMatch(source, /clipboard['"]/);
    assert.doesNotMatch(source, /clipboardPasteFrom|sendKey|sendCtrlAltDel/);
    const template = source.slice(source.indexOf('<template>'));
    assert.doesNotMatch(template, /<(input|textarea|select|form)\b/i);
  });

  it('disconnects when it goes away', () => {
    assert.match(source, /onBeforeUnmount\([^)]*\)/);
    assert.match(source, /\.disconnect\(\)/);
  });
});
