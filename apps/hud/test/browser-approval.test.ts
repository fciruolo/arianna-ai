// The browser of Arianna (D-264, passo 3): the card of a link to another site
// and the activity lines, without a browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BROWSER_NO, BROWSER_YES, browserClick } from '../src/lib/browser-approval.ts';
import { activityLink, activityText } from '../src/lib/italian.ts';
import { ACTION_TEXT } from '../src/lib/labels.ts';
import { pendingAskText } from '../src/lib/pending-text.ts';

const DETAIL = { url: 'https://it.wikipedia.org/wiki/Pagina_finta?x=1', site: 'wikipedia.org', step: 3 };

test('the card of a link: the site, the whole address as text, «Apri» and «No»', () => {
  assert.deepEqual(browserClick({ kind: 'browser', detail: DETAIL }), { site: 'wikipedia.org', url: DETAIL.url });
  assert.equal(browserClick({ kind: 'browser', detail: { ...DETAIL, url: 'http://example.com/' } })?.url, 'http://example.com/');
  assert.deepEqual([BROWSER_YES, BROWSER_NO], ['Apri', 'No']);
  assert.equal(ACTION_TEXT['browser.click'], 'Apro questo indirizzo?');
  assert.equal(pendingAskText({ kind: 'browser', action: 'browser.click', detail: DETAIL }), 'Aprire un indirizzo su wikipedia.org');
});

test('not a card of a link: another kind, an address that is not http(s), a malformed detail', () => {
  assert.equal(browserClick({ kind: 'routine', detail: DETAIL }), undefined);
  assert.equal(browserClick({ kind: 'browser', detail: { purged: true } }), undefined);
  assert.equal(browserClick({ kind: 'browser', detail: { ...DETAIL, url: 'javascript:alert(1)' } }), undefined);
  assert.equal(browserClick({ kind: 'browser', detail: { ...DETAIL, url: 'file:///etc/passwd' } }), undefined);
  assert.equal(browserClick({ kind: 'browser', detail: { ...DETAIL, url: 'non un indirizzo' } }), undefined);
  assert.equal(browserClick({ kind: 'browser', detail: { ...DETAIL, url: 42 } }), undefined);
  assert.equal(browserClick({ kind: 'browser', detail: { ...DETAIL, site: ' ' } }), undefined);
});

test('the browser lines read as Italian and are never links', () => {
  const line = (kind: 'tool' | 'read' | 'error' | 'wait', detail: string) => ({ conversationId: 'c', taskId: 't', step: 2, kind, detail });
  assert.equal(activityText(line('tool', 'browser · apre · wikipedia.org')), 'browser: apre wikipedia.org');
  assert.equal(activityText(line('read', 'browser · legge · wikipedia.org')), 'browser: legge wikipedia.org');
  assert.equal(activityText(line('tool', 'browser · clic · wikipedia.org')), 'browser: clic su wikipedia.org');
  assert.equal(activityText(line('tool', 'browser · scorre · wikipedia.org')), 'browser: scorre wikipedia.org');
  assert.equal(activityText(line('tool', 'browser · scrive 12 caratteri')), 'browser: scrive 12 caratteri');
  assert.equal(activityText(line('tool', 'browser · chiude')), 'browser: chiude');
  assert.equal(activityLink(line('read', 'browser · legge · wikipedia.org')), undefined);
  assert.equal(
    activityText(line('error', 'browser · Il gateway ha fermato il testo: non lo scrivo.')),
    'Errore: browser: il gateway ha fermato il testo: non lo scrivo, provo un’altra strada',
  );
  assert.equal(activityText(line('wait', 'browser · Questo indirizzo non l’hai scritto tu: chiedo a te se aprirlo.')), 'browser: questo indirizzo non l’hai scritto tu: chiedo a te se aprirlo');
  // The other lines stay as they were.
  assert.equal(activityText(line('tool', 'command')), 'Il Coder usa il terminale');
});
