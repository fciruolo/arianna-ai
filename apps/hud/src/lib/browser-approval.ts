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

// The card of a saved private value (D-283): Arianna's browser or web.fetch
// would let out a value the user saved for a client or a contact (in an
// address or in a text to type). Nothing leaves before «Apri».

export const PRIVATE_YES = 'Apri';
export const PRIVATE_NO = 'No';
export const PRIVATE_NOTE =
  'Con Apri questo dato può uscire dal browser di questa conversazione finché lo chiudi (per una pagina letta senza browser, per 15 minuti); con No Arianna prosegue senza. Password e chiavi non escono mai.';

/** What each kind of saved value is, in Italian. */
export const SAVED_KIND_TEXT: Record<string, string> = {
  name: 'il nome',
  'legal-name': 'la ragione sociale',
  person: 'nome e cognome',
  'registered-address': 'l’indirizzo della sede',
  'billing-address': 'l’indirizzo di fatturazione',
  'shipping-address': 'l’indirizzo di consegna',
  email: 'l’email',
  pec: 'la PEC',
  'billing-email': 'l’email di fatturazione',
  phone: 'il telefono',
  mobile: 'il cellulare',
  'vat-number': 'la partita IVA',
  'tax-code': 'il codice fiscale',
  iban: 'l’IBAN',
  'contact-name': 'il nome di un contatto',
  'contact-email': 'l’email di un contatto',
  'contact-phone': 'il telefono di un contatto',
  'contact-mobile': 'il cellulare di un contatto',
};

export interface BrowserPrivateCard {
  /** One line per value: what it is and whose, never the value («l’email di Ferramenta Lunardi Srl»). */
  lines: string[];
  /** Where it would go: the browser or a page read by web.fetch. */
  web: boolean;
}

/** The card of a `browser.private` approval (kind `browser`), or undefined when it is not a whole one. */
export function browserPrivate(approval: { kind: string; action: string; detail: Record<string, unknown> }): BrowserPrivateCard | undefined {
  if (approval.kind !== 'browser' || approval.action !== 'browser.private') return undefined;
  const { values, tool } = approval.detail;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const lines: string[] = [];
  for (const value of values as unknown[]) {
    if (typeof value !== 'object' || value === null) return undefined;
    const { kind, client } = value as Record<string, unknown>;
    if (typeof kind !== 'string') return undefined;
    const what = SAVED_KIND_TEXT[kind] ?? 'un dato salvato';
    const whose = typeof client === 'string' && client.trim() !== '' ? ` di ${client.trim()}` : ' di un cliente';
    lines.push(`${what}${whose}`);
  }
  return { lines: [...new Set(lines)], web: tool === 'web.fetch' };
}
