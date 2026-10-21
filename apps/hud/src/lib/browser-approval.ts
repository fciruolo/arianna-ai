// The card of a link Arianna's browser would open on another site (D-264,
// passo 3): the site, the whole address as plain text (it comes from a page
// that is not trusted, so it is never a link here), «Apri» or «No».

export const BROWSER_YES = 'Apri';
export const BROWSER_NO = 'No';
export const BROWSER_NOTE =
  'Arianna vuole aprire un indirizzo che non hai scritto tu: con Apri lo apre nel suo browser e da lì vale come scritto da te in questa conversazione.';

export interface BrowserClickCard {
  /** The site as the core names it ("wikipedia.org"). */
  site: string;
  /** The whole address, http or https, shown as text. */
  url: string;
}

/** The card of a `browser.click` approval (kind `browser`), or undefined when it is not a whole one. */
export function browserClick(approval: { kind: string; detail: Record<string, unknown> }): BrowserClickCard | undefined {
  if (approval.kind !== 'browser') return undefined;
  const { url, site } = approval.detail;
  if (typeof url !== 'string' || typeof site !== 'string' || site.trim() === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return { site: site.trim(), url };
}

// The card of a send in the Private chat of an access (D-281): Arianna would
// send data to the site where the user signed in (a form, or what the page
// sends after her click); nothing leaves before «Invia».

export const SEND_YES = 'Invia';
export const SEND_NO = 'No';
export const SEND_NOTE =
  'Con Invia Arianna ripete quel clic una volta sola e il sito riceve i dati, a tuo nome; con No non lo rifà. Solo verso questo sito: è quello dove hai fatto l’accesso.';

export interface BrowserSendCard {
  /** The site of the access ("biblioteca-finta.it"). */
  site: string;
  /** The label of the element Arianna clicked, as the page names it: text, never a link. */
  element: string;
}

/** The card of a `browser.send` approval (kind `browser`), or undefined when it is not a whole one. */
export function browserSend(approval: { kind: string; action: string; detail: Record<string, unknown> }): BrowserSendCard | undefined {
  if (approval.kind !== 'browser' || approval.action !== 'browser.send') return undefined;
  const { site, element } = approval.detail;
  if (typeof site !== 'string' || site.trim() === '' || typeof element !== 'string') return undefined;
  return { site: site.trim(), element: element.trim() || 'elemento senza nome' };
}
