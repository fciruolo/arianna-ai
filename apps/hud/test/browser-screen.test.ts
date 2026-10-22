// The live screen of Arianna's browser (D-264, passo 4): browser lines, the tabs of the panel, the refused token, the view-only screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applyActivity, emptyChat } from '../src/lib/chat-state.ts';
import { barAddress, blockedText, browserSignal, browserSite, canRetry, commandText, isBrowserLine, latestBrowserSite, SCREEN_HINT, SCREEN_TEXT, screenRefusal, screenUrl } from '../src/lib/browser-screen.ts';
import { COMPUTER_TABS, computerTabs, shownTab } from '../src/lib/computer.ts';
import { browserConversationFromPath, browserPathFor, conversationFromPath } from '../src/lib/route.ts';
import type { Activity } from '../src/lib/types.ts';

const C = 'c1';
const line = (detail: string, extra: Partial<Activity> = {}): Activity => ({ conversationId: C, taskId: 't1', step: 1, kind: 'tool', detail, ...extra });
const ID = '11111111-1111-4111-8111-111111111111';

describe('the bar «Browser aperto» and the page of its own (prova dell’utente)', () => {
  it('the signal changes with every browser line and message; «chiude» as the newest browser line hides the bar', () => {
    let chat = emptyChat(C);
    const empty = browserSignal(chat);
    assert.equal(empty.closed, false);
    chat = applyActivity(chat, line('browser · apre · example.com'));
    const opened = browserSignal(chat);
    assert.notEqual(opened.key, empty.key);
    assert.equal(opened.closed, false);
    // A line of another tool does not count.
    chat = applyActivity(chat, line('kb/note.md', { kind: 'read', step: 2 }));
    assert.equal(browserSignal(chat).key, opened.key);
    chat = applyActivity(chat, line('browser · chiude', { step: 3 }));
    assert.equal(browserSignal(chat).closed, true);
    // Opened again after: no longer closed.
    chat = applyActivity(chat, line('browser · apre · example.org', { step: 4 }));
    assert.equal(browserSignal(chat).closed, false);
    // A failure is not a browser line: it neither counts nor closes.
    const failed = browserSignal(applyActivity(chat, line('browser · chiude', { kind: 'error', step: 5 })));
    assert.deepEqual(failed, browserSignal(chat));
  });

  it('/browser/<id> is the screen alone, of that conversation; any other path is not', () => {
    assert.equal(browserPathFor(ID), `/browser/${ID}`);
    assert.equal(browserConversationFromPath(browserPathFor(ID)), ID);
    assert.equal(browserConversationFromPath(`/browser/${ID}/`), ID);
    assert.equal(browserConversationFromPath(`/browser/${ID.toUpperCase()}`), ID);
    assert.equal(browserConversationFromPath('/browser/x'), undefined);
    assert.equal(browserConversationFromPath(`/c/${ID}`), undefined);
    assert.equal(browserConversationFromPath(`/browser/${ID}/altro`), undefined);
    assert.equal(conversationFromPath(browserPathFor(ID)), undefined);
  });
});

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

  it('starts view only: viewOnly on, no focus on click, no clipboard handler; keys only while it drives (passo 5)', () => {
    assert.match(source, /\.viewOnly = true;/);
    assert.match(source, /\.focusOnClick = false;/);
    assert.match(source, /\.resizeSession = false;/);
    assert.doesNotMatch(source, /clipboard['"]/);
    assert.doesNotMatch(source, /clipboardPasteFrom|sendCtrlAltDel/);
    // sendKey only behind driving(): the keyboard of a phone while this screen drives.
    for (const at of [...source.matchAll(/\.sendKey\(/g)].map((match) => match.index)) assert.match(source.slice(Math.max(0, at - 200), at), /driving\(\)/);
    const template = source.slice(source.indexOf('<template>'));
    assert.doesNotMatch(template, /<(textarea|select)\b/i);
    // The one form is the bar of the browser (D-286), whose field is the address; the other field is the
    // hidden keyboard, only while this screen drives on a phone.
    assert.equal([...template.matchAll(/<form\b/gi)].length, 1);
    assert.match(template, /<form [^>]*role="toolbar"/);
    assert.equal([...template.matchAll(/<input\b/gi)].length, 2);
    assert.match(template, /<input\s+v-model="address"/);
    assert.match(template, /<input\s+v-if="control === 'you' && touch"/);
  });

  it('gives the keyboard to the screen only when the control passes to it, never on the reads of the status nor while the bar is written in (D-286)', () => {
    assert.match(source, /function applyControl\(focus = false\)/);
    assert.match(source, /if \(you && focus && !editing\.value && keyboardIsFree\(\)\) current\.focus/);
    assert.match(source, /applyControl\(before !== 'you' && status\.control === 'you'\)/);
    // The label follows the page of the core, not only the lines of the chat.
    assert.match(source, /liveSite \?\? site/);
  });

  it('disconnects when it goes away', () => {
    assert.match(source, /onBeforeUnmount\([^)]*\)/);
    assert.match(source, /\.disconnect\(\)/);
  });

  it('«Schermo intero» only where the Fullscreen API exists; the new tab without opener', () => {
    assert.match(source, /v-if="canFullscreen"/);
    assert.match(source, /document\.fullscreenEnabled/);
    const link = /<a\b[^>]*browserPathFor[^>]*>/.exec(source)?.[0] ?? '';
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
  });
});

describe('main.ts', () => {
  it('mounts the page of the screen alone on /browser/<id>, the chat otherwise', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    assert.match(source, /browserConversationFromPath\(window\.location\.pathname\)/);
    assert.match(source, /createApp\(BrowserPage/);
    assert.match(source, /createApp\(App\)/);
  });
});

describe('«Prendi il controllo» (D-264, passo 5)', () => {
  it('the status of the core: control and the refused page, anything else dropped', async () => {
    const { parseControl } = await import('../src/lib/browser-screen.ts');
    assert.deepEqual(parseControl({ open: true, control: 'you', blocked: { seq: 4, outcome: 'form' } }), { control: 'you', blocked: { seq: 4, outcome: 'form' }, access: null, chat: false });
    assert.deepEqual(parseControl({ control: 'other', blocked: { seq: 2, outcome: 'blocked', site: 'altro-finto.it' } }), { control: 'other', blocked: { seq: 2, outcome: 'blocked', site: 'altro-finto.it' }, access: null, chat: false });
    assert.deepEqual(parseControl({ control: 'admin', blocked: { seq: '4', outcome: 'form' } }), { control: null, blocked: null, access: null, chat: false });
    assert.deepEqual(parseControl({ blocked: { seq: 1, outcome: 'ok' } }), { control: null, blocked: null, access: null, chat: false });
    assert.deepEqual(parseControl(null), { control: null, blocked: null, access: null, chat: false });
  });

  it('every refused page has its sentence; a page the gateway refused says so (D-286: a click of the user opens any site)', async () => {
    const { blockedText, CONTROL_WARNING } = await import('../src/lib/browser-screen.ts');
    assert.match(blockedText({ outcome: 'blocked' }), /il gateway l’ha fermata/);
    assert.match(blockedText({ outcome: 'form' }), /^Modulo non inviato/);
    for (const outcome of ['refused', 'limit'] as const) assert.ok(blockedText({ outcome }).length > 10);
    assert.equal(CONTROL_WARNING, 'Non scrivere dati personali: la pagina è pubblica e il sito li riceve.');
  });

  it('the keyboard of a phone: Latin-1 as itself, other characters as 0x01000000 plus the code point, control characters left out', async () => {
    const { keysymOf, keysymsOf, SPECIAL_KEYS } = await import('../src/lib/browser-keys.ts');
    assert.equal(keysymOf('a'), 0x61);
    assert.equal(keysymOf('è'), 0xe8);
    assert.equal(keysymOf('€'), 0x010020ac);
    assert.equal(keysymOf('😀'), 0x0101f600);
    assert.equal(keysymOf('\n'), SPECIAL_KEYS.Enter?.keysym);
    assert.equal(keysymOf('\u0007'), undefined);
    assert.equal(keysymOf('ab'), undefined);
    assert.deepEqual(keysymsOf('Ciao è'), [0x43, 0x69, 0x61, 0x6f, 0x20, 0xe8]);
    // No F-key nor Super among the special keys: the core drops them anyway.
    for (const key of Object.values(SPECIAL_KEYS)) assert.ok(!(key.keysym >= 0xffbe && key.keysym <= 0xffe0) && !(key.keysym >= 0xffe7 && key.keysym <= 0xffee));
  });

  it('the screen drives only after the core says so, and keeps the clipboard off', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'BrowserScreen.vue'), 'utf8');
    assert.ok(source.includes('current.viewOnly = !you'));
    assert.ok(!source.includes("addEventListener('clipboard'"));
    assert.ok(source.includes('CONTROL_WARNING'));
  });
});

describe('the access made by the user (D-276)', () => {
  it('the status carries the site of the access; the refused pages say that only that site opens', async () => {
    const { accessText, accessWarning, blockedText, FORM_NOTE, parseControl } = await import('../src/lib/browser-screen.ts');
    assert.equal(parseControl({ control: 'you', access: 'banca-finta.it' }).access, 'banca-finta.it');
    assert.equal(parseControl({ control: 'you', access: 3 }).access, null);
    assert.match(blockedText({ outcome: 'blocked' }, 'banca-finta.it'), /solo verso banca-finta\.it/);
    assert.match(blockedText({ outcome: 'form' }, 'banca-finta.it'), /solo verso banca-finta\.it/);
    assert.match(blockedText({ outcome: 'blocked' }, null), /il gateway l’ha fermata/);
    assert.match(accessText('banca-finta.it'), /Private/);
    assert.match(FORM_NOTE, /Unica eccezione/);
    assert.match(accessWarning('banca-finta.it'), /solo a banca-finta\.it/);
    assert.doesNotMatch(accessWarning('banca-finta.it'), /pubblica/);
    assert.match(FORM_NOTE, /solo verso quel sito/);
  });
});

describe('the Private chat of an access (D-281)', () => {
  it('the status says the chat, and where the browser of a work conversation went', async () => {
    const { accessText, parseControl, parseMovedTo } = await import('../src/lib/browser-screen.ts');
    assert.equal(parseControl({ open: true, chat: true }).chat, true);
    assert.equal(parseControl({ open: true, chat: 'yes' }).chat, false);
    const id = '66666666-6666-4666-8666-666666666666';
    assert.equal(parseMovedTo({ open: false, movedTo: id }), id);
    assert.equal(parseMovedTo({ open: false, movedTo: '../impostazioni' }), null);
    assert.equal(parseMovedTo({ open: false }), null);
    assert.match(accessText('banca-finta.it', true), /solo in questa chat Privata/);
    assert.match(accessText('banca-finta.it', true), /Invia \/ No/);
    assert.match(accessText('banca-finta.it'), /nuova chat Privata/);
  });

  it('the line of the hand over leads to the chat born before it; any other message to none', async () => {
    const { browserChatOf, HANDOFF_LINE } = await import('../src/lib/browser-screen.ts');
    const chats = [
      { id: 'first', createdAt: '2026-10-21T10:00:00.000Z' },
      { id: 'second', createdAt: '2026-10-21T12:00:00.000Z' },
    ];
    const line = (ts: string, body = HANDOFF_LINE, role = 'system') => ({ role, body, ts });
    assert.equal(browserChatOf(chats, line('2026-10-21T10:00:00.500Z')), 'first');
    assert.equal(browserChatOf(chats, line('2026-10-21T12:00:01.000Z')), 'second');
    assert.equal(browserChatOf(chats, line('2026-10-21T10:00:00.500Z', 'Altro')), undefined);
    assert.equal(browserChatOf(chats, line('2026-10-21T10:00:00.500Z', HANDOFF_LINE, 'assistant')), undefined);
    assert.equal(browserChatOf(undefined, line('2026-10-21T10:00:00.500Z')), undefined);
    assert.equal(browserChatOf([], line('2026-10-21T10:00:00.500Z')), undefined);
  });

  it('the line is the one the core writes', async () => {
    const { HANDOFF_LINE } = await import('../src/lib/browser-screen.ts');
    const core = readFileSync(join(import.meta.dirname, '..', '..', 'core', 'src', 'browser', 'handoff.ts'), 'utf8');
    assert.ok(core.includes(`'${HANDOFF_LINE}'`));
  });
});

describe('the bar of the screen (D-286)', () => {
  it('takes an address with or without its scheme, never something else', () => {
    assert.equal(barAddress('wikipedia.org'), 'https://wikipedia.org/');
    assert.equal(barAddress('  https://example.com/a?b=1 '), 'https://example.com/a?b=1');
    assert.equal(barAddress('http://example.com'), 'http://example.com/');
    assert.equal(barAddress(''), undefined);
    assert.equal(barAddress('ferramenta lunardi'), undefined);
    assert.equal(barAddress('javascript:alert(1)'), undefined);
    assert.equal(barAddress('file:///etc/passwd'), undefined);
    assert.equal(barAddress('localhost'), undefined);
  });

  it('says in Italian why a command did not go', () => {
    assert.match(commandText('agent-busy'), /Arianna sta usando il browser/);
    assert.match(commandText('no-page'), /Non c’è una pagina/);
    assert.match(commandText('navigation-blocked'), /gateway/);
    assert.match(commandText('qualcos-altro'), /non è riuscito/);
  });

  it('a page refused while the user drives is the gateway\'s refusal, no longer a site not written (D-286)', () => {
    assert.match(blockedText({ outcome: 'blocked' }), /il gateway l’ha fermata/);
    assert.doesNotMatch(blockedText({ outcome: 'blocked' }), /scrivilo in chat/);
  });
});
