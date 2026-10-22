// The browser of Arianna (D-264, passo 3): the card of a link to another site
// and the activity lines, without a browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BROWSER_NO, BROWSER_YES, browserClick, browserPrivate, browserSend, PRIVATE_NO, PRIVATE_NOTE, PRIVATE_YES, SEND_NO, SEND_NOTE, SEND_YES } from '../src/lib/browser-approval.ts';
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

test('the card «Invia / No» of the Private chat of an access (D-281): site and element, only for browser.send', () => {
  const card = (action: string, detail: Record<string, unknown>) => browserSend({ kind: 'browser', action, detail });
  assert.deepEqual(card('browser.send', { site: 'biblioteca-finta.it', element: 'Rinnova', step: 2 }), { site: 'biblioteca-finta.it', element: 'Rinnova' });
  assert.deepEqual(card('browser.send', { site: 'biblioteca-finta.it', element: '  ', step: 2 }), { site: 'biblioteca-finta.it', element: 'elemento senza nome' });
  assert.equal(card('browser.send', { element: 'Rinnova' }), undefined);
  assert.equal(card('browser.click', { site: 'biblioteca-finta.it', element: 'Rinnova' }), undefined);
  assert.equal(browserSend({ kind: 'action', action: 'browser.send', detail: { site: 'x.it', element: 'y' } }), undefined);
  // A send is never read as a link card.
  assert.equal(browserClick({ kind: 'browser', detail: { site: 'biblioteca-finta.it', element: 'Rinnova', step: 2 } }), undefined);
  assert.equal([SEND_YES, SEND_NO].join(' / '), 'Invia / No');
  assert.match(SEND_NOTE, /una volta sola/);
  assert.equal(ACTION_TEXT['browser.send'], 'Invio questi dati al sito?');
});

test('the card «Apri / No» of a saved value (D-283): what it is and whose, never the value, only for browser.private', () => {
  const card = (action: string, detail: Record<string, unknown>) => browserPrivate({ kind: 'browser', action, detail });
  const values = [
    { ref: 'client:c1:name', kind: 'name', client: 'Ferramenta Lunardi Srl' },
    { ref: 'contact:k1:contact-email', kind: 'contact-email', client: 'Ferramenta Lunardi Srl' },
  ];
  assert.deepEqual(card('browser.private', { values, tool: 'browser.open', step: 3 }), {
    lines: ['il nome di Ferramenta Lunardi Srl', 'l’email di un contatto di Ferramenta Lunardi Srl'],
    web: false,
  });
  assert.equal(card('browser.private', { values, tool: 'web.fetch', step: 3 })?.web, true);
  // The site it would go to, the name only; none when missing or empty.
  assert.equal(card('browser.private', { values, tool: 'browser.open', step: 3, site: 'cerca.example' })?.site, 'cerca.example');
  assert.equal(card('browser.private', { values, tool: 'browser.open', step: 3, site: '  ' })?.site, undefined);
  assert.equal(card('browser.private', { values: [{ ref: 'client:c1:eu-vat-number', kind: 'eu-vat-number', client: 'X' }], step: 1 })?.lines[0], 'la partita IVA europea di X');
  // A reference whose client is gone, or a kind the chat does not know.
  assert.deepEqual(card('browser.private', { values: [{ ref: 'client:c9:iban', kind: 'iban', client: '' }, { ref: 'x', kind: 'nuovo' }], step: 1 })?.lines, ['l’IBAN di un cliente', 'un dato salvato di un cliente']);
  assert.equal(card('browser.private', { values: [], step: 1 }), undefined);
  assert.equal(card('browser.private', { values: [{ ref: 'x' }], step: 1 }), undefined);
  assert.equal(card('browser.send', { values, step: 1 }), undefined);
  // Never read as a link card.
  assert.equal(browserClick({ kind: 'browser', detail: { values, step: 1 } }), undefined);
  assert.equal([PRIVATE_YES, PRIVATE_NO].join(' / '), 'Apri / No');
  assert.match(PRIVATE_NOTE, /finché lo chiudi/);
  assert.match(PRIVATE_NOTE, /la richiesta può tornare/);
  assert.equal(ACTION_TEXT['browser.private'], 'Lascio uscire questo dato salvato?');
});
