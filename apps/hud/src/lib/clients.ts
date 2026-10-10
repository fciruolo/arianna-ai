import { ApiError } from './api.ts';
import { areaOf, clean, clientIssues, EMAIL, PHONE, tooLong, VAT_NATURES, type Address, type ClientArea, type ClientForm, type ClientKind, type ClientStatus, type Issue, type IssueCode, type PaymentMethod } from './client-codes.ts';
import { errorText } from './italian.ts';

export * from './client-codes.ts';

/**
 * The page "Clienti" (I-16, D-168, tappa C1): pure helpers. The types of the
 * API, the address of the page, the same checks as the core
 * (apps/core/src/clients-format.ts, repeated: the page does not import the
 * core; a test of the core keeps the two in step) with their messages in
 * Italian, the fields each kind and country of client shows, what is still
 * missing to send an invoice, the words of the page. Everything here is
 * private (L2): it stays in the web chat and the core of this Mac.
 */

export const CLIENTS_PATH = '/clienti';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/clienti`, or a client: `/clienti/<id>`. */
export function isClientsPath(pathname: string): boolean {
  return /^\/clienti(?:\/[0-9a-f-]{36})?\/?$/i.test(pathname);
}

/** The client the address names, or undefined for the list. */
export function clientFromPath(pathname: string): string | undefined {
  const id = /^\/clienti\/([^/]+)\/?$/.exec(pathname)?.[1];
  return id !== undefined && UUID.test(id) ? id.toLowerCase() : undefined;
}

export function clientPathFor(id: string | null): string {
  return id === null ? CLIENTS_PATH : `${CLIENTS_PATH}/${id}`;
}

// ---------------------------------------------------------------------------
// Types of the API
// ---------------------------------------------------------------------------

export interface ClientLogo {
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  version: string;
}

export interface ClientContact {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  notes: string | null;
  primary: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ContactForm = Omit<ClientContact, 'id' | 'createdAt' | 'updatedAt'>;

export interface ClientProject {
  id: string;
  project: string;
  approved: boolean;
  createdAt: string;
}

export interface Client extends Omit<ClientForm, 'status'> {
  id: string;
  status: ClientStatus;
  area: ClientArea;
  sdiEffective: string;
  logo: ClientLogo | null;
  label: string;
  contacts: ClientContact[];
  projects: ClientProject[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ClientSummary {
  id: string;
  kind: ClientKind;
  status: ClientStatus;
  displayName: string;
  legalName: string | null;
  country: string;
  area: ClientArea;
  vatNumber: string | null;
  email: string | null;
  tags: string[];
  logo: ClientLogo | null;
  projects: string[];
  primaryContact: { name: string; email: string | null; phone: string | null } | null;
  updatedAt: string;
}

export const EMPTY_FORM: Readonly<ClientForm> = {
  kind: 'company',
  status: 'active',
  displayName: '',
  legalName: null,
  firstName: null,
  lastName: null,
  sector: null,
  website: null,
  notes: null,
  tags: [],
  country: 'IT',
  vatNumber: null,
  taxCode: null,
  euVatNumber: null,
  foreignTaxId: null,
  vatRate: null,
  vatNature: null,
  splitPayment: false,
  withholdingAgent: false,
  sdiCode: null,
  pec: null,
  ipaCode: null,
  cig: null,
  cup: null,
  registeredAddress: null,
  billingAddress: null,
  shippingAddress: null,
  billingEmail: null,
  paymentMethod: null,
  paymentDays: null,
  paymentEndOfMonth: false,
  currency: 'EUR',
  invoiceLanguage: 'it',
  purchaseOrder: null,
  iban: null,
  email: null,
  phone: null,
  mobile: null,
};

export const EMPTY_CONTACT: Readonly<ContactForm> = { name: '', role: null, email: null, phone: null, mobile: null, notes: null, primary: false };

/** The fields of a client, from what the core sent: a copy the form edits. */
export function formOf(client: Client | null): ClientForm {
  if (client === null) return { ...EMPTY_FORM, tags: [] };
  const form = {} as Record<keyof ClientForm, unknown>;
  for (const key of Object.keys(EMPTY_FORM) as (keyof ClientForm)[]) {
    const value = (client as unknown as Record<string, unknown>)[key];
    form[key] = value !== null && typeof value === 'object' ? (JSON.parse(JSON.stringify(value)) as typeof value) : value;
  }
  form.status = client.status === 'prospect' ? 'prospect' : 'active';
  return form as ClientForm;
}

export function emptyAddress(country: string): Address {
  return { street: null, number: null, postalCode: null, city: null, province: null, country };
}

const FIELD_TEXT: Record<string, string> = {
  displayName: 'il nome',
  legalName: 'la ragione sociale',
  firstName: 'il nome',
  lastName: 'il cognome',
  sector: 'il settore',
  website: 'il sito',
  notes: 'le note',
  tags: 'le etichette',
  country: 'il paese',
  vatNumber: 'la partita IVA',
  taxCode: 'il codice fiscale',
  euVatNumber: 'la partita IVA UE',
  foreignTaxId: 'l’identificativo fiscale',
  vatRate: 'l’aliquota IVA',
  vatNature: 'la natura IVA',
  splitPayment: 'lo split payment',
  withholdingAgent: 'la ritenuta d’acconto',
  sdiCode: 'il codice SDI',
  pec: 'la PEC',
  ipaCode: 'il codice IPA',
  cig: 'il CIG',
  cup: 'il CUP',
  billingEmail: 'l’email per le fatture',
  paymentMethod: 'il metodo di pagamento',
  paymentDays: 'i giorni di pagamento',
  currency: 'la valuta',
  invoiceLanguage: 'la lingua delle fatture',
  purchaseOrder: 'il riferimento ordine',
  iban: 'l’IBAN',
  email: 'l’email',
  phone: 'il telefono',
  mobile: 'il cellulare',
  name: 'il nome',
  role: 'il ruolo',
  project: 'il progetto',
  logo: 'il logo',
};

/** Precise messages for the forms that are easy to get wrong. */
const FORMAT_TEXT: Record<string, string> = {
  vatNumber: 'La partita IVA ha 11 cifre.',
  taxCode: 'Il codice fiscale ha 16 caratteri (persona) o 11 cifre (società o ente).',
  euVatNumber: 'Scrivi la partita IVA con il prefisso del paese (per esempio DE123456789; la Grecia usa EL).',
  sdiCode: 'Il codice SDI ha 7 caratteri, lettere e cifre.',
  ipaCode: 'Il codice univoco ufficio (IPA) ha 6 caratteri.',
  cig: 'Il CIG ha 10 caratteri.',
  cup: 'Il CUP ha 15 caratteri.',
  pec: 'Non sembra un indirizzo PEC: nome@dominio.it',
  email: 'Non sembra un indirizzo email.',
  billingEmail: 'Non sembra un indirizzo email.',
  phone: 'Solo cifre, spazi e il + davanti.',
  mobile: 'Solo cifre, spazi e il + davanti.',
  website: 'Scrivi un sito http o https, per esempio rossi.example.',
  vatRate: 'L’aliquota va da 0 a 100, con al più due decimali.',
  vatNature: 'Scegli una natura dall’elenco.',
  paymentDays: 'I giorni vanno da 0 a 365.',
  currency: 'La valuta ha 3 lettere (EUR, USD, CHF…).',
  invoiceLanguage: 'La lingua ha 2 lettere (it, en, de…).',
  iban: 'L’IBAN comincia con il paese e due cifre (IT60…).',
  country: 'Scegli un paese.',
  postalCode: 'Il CAP italiano ha 5 cifre.',
  province: 'La provincia è la sigla di 2 lettere (MI, RM…).',
  foreignTaxId: 'Lettere, cifre, spazi, punti, trattini e barre; al più 30 caratteri.',
};

const NOT_ALLOWED_TEXT: Record<string, string> = {
  sdiCode: 'Il codice SDI non va qui: un cliente estero ha sempre XXXXXXX, una pubblica amministrazione il codice IPA.',
  vatNature: 'Con una natura IVA l’aliquota è 0.',
  splitPayment: 'Lo split payment vale per le pubbliche amministrazioni e le società italiane.',
};

/** The message of one issue, in Italian. */
export function issueText(issue: Issue): string {
  const part = issue.field.split('.').at(-1) ?? issue.field;
  const what = FIELD_TEXT[issue.field] ?? FIELD_TEXT[part] ?? 'il campo';
  switch (issue.code) {
    case 'required':
      return issue.field === 'displayName' ? 'Serve un nome: il nome del cliente, la ragione sociale o nome e cognome.' : `Manca ${what}.`;
    case 'checksum':
      return issue.field === 'iban' ? 'L’IBAN non torna: controlla le cifre.' : `Il carattere di controllo non torna: controlla ${what}.`;
    case 'too-long':
      return `Troppo lungo: accorcia ${what}.`;
    case 'not-allowed':
      return NOT_ALLOWED_TEXT[issue.field] ?? `Per questo tipo di cliente o paese non si scrive ${what}.`;
    case 'unknown':
      return 'Campo sconosciuto.';
    case 'type':
    case 'format':
      if (part === 'postalCode' && issue.field !== 'postalCode') return issue.code === 'format' ? 'Il CAP non è nella forma giusta (5 cifre in Italia).' : 'CAP non valido.';
      return FORMAT_TEXT[issue.field] ?? FORMAT_TEXT[part] ?? `Controlla ${what}.`;
  }
}

/** The messages by field, the first problem of each: what the form shows under each field. */
export function clientProblems(form: ClientForm): Record<string, string> {
  return Object.fromEntries(clientIssues(form).map((issue) => [issue.field, issueText(issue)]));
}

export function contactProblems(form: ContactForm): Record<string, string> {
  const problems: Record<string, string> = {};
  const name = clean(form.name);
  if (name === '') problems.name = 'Serve il nome della persona.';
  else if (Array.from(name).length > 200) problems.name = 'Troppo lungo: accorcia il nome.';
  if (tooLong(form.role, 100)) problems.role = 'Troppo lungo: accorcia il ruolo.';
  const email = clean(form.email);
  if (email !== '' && (tooLong(email, 254) || !EMAIL.test(email))) problems.email = 'Non sembra un indirizzo email.';
  for (const key of ['phone', 'mobile'] as const) {
    const value = clean(form[key]);
    if (value !== '' && (tooLong(value, 30) || !PHONE.test(value))) problems[key] = 'Solo cifre, spazi e il + davanti.';
  }
  if (Array.from((form.notes ?? '').trim()).length > 2000) problems.notes = 'Troppo lungo: accorcia le note.';
  return problems;
}

/** The issues the core sent with a 400 (`issues`), as messages by field. */
export function problemsFromError(cause: unknown): Record<string, string> {
  if (!(cause instanceof ApiError) || !Array.isArray(cause.body.issues)) return {};
  const problems: Record<string, string> = {};
  for (const item of cause.body.issues as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { field, code } = item as { field?: unknown; code?: unknown };
    if (typeof field === 'string' && typeof code === 'string' && problems[field] === undefined) problems[field] = issueText({ field, code: code as IssueCode });
  }
  return problems;
}

/** An error of the page in Italian. */
export function clientErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  if (cause.status === 404) return 'Questo cliente non c’è più.';
  if (cause.status === 413) return 'Il logo è troppo grande: al più 1 MB.';
  if (cause.status === 409 && /archived/.test(cause.message)) return 'Il cliente è archiviato: ripristinalo prima di cambiarlo.';
  if (cause.status === 409 && /partita IVA/.test(cause.message)) return 'Un altro cliente ha già questa partita IVA.';
  if (cause.status === 409 && /another client/.test(cause.message)) return 'Questo progetto è già di un altro cliente.';
  if (cause.status === 409 && /at most/.test(cause.message)) return 'Hai raggiunto il numero massimo per questo cliente.';
  if (cause.status === 409 && /changed on disk/.test(cause.message)) return 'Il file del logo è cambiato sul disco: caricalo di nuovo.';
  if (cause.status === 400 && /PNG, JPEG or WebP/.test(cause.message)) return 'Il logo deve essere un’immagine PNG, JPEG o WebP (niente SVG).';
  if (cause.status === 400 && /unknown project/.test(cause.message)) return 'Il progetto non è fra quelli approvati.';
  if (cause.status === 400) return 'Alcuni campi non vanno: guarda i messaggi accanto.';
  return errorText(cause);
}

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_LOGO_BYTES = 1024 * 1024;

/** Before reading a file chosen for the logo: its type and size, or why not. */
export function logoFileProblem(file: { type: string; size: number }): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'Il logo deve essere un’immagine PNG, JPEG o WebP (niente SVG).';
  if (file.size > MAX_LOGO_BYTES) return 'Il logo è troppo grande: al più 1 MB.';
  if (file.size === 0) return 'Il file è vuoto.';
  return null;
}

/** The address of the logo: the version changes it when the logo changes. */
export function logoUrl(id: string, logo: ClientLogo | null): string | null {
  return logo === null ? null : `/api/clients/${encodeURIComponent(id)}/logo?v=${encodeURIComponent(logo.version)}`;
}

/** Two letters for a client without a logo. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/\b(srl|srls|spa|sas|snc|ltd|gmbh|sarl|inc)\b\.?/gi, '')
    .split(/[\s.,&'-]+/)
    .filter((word) => word !== '');
  const first = words[0] ?? name;
  return ((first[0] ?? '') + (words[1]?.[0] ?? first[1] ?? '')).toUpperCase();
}

// ---------------------------------------------------------------------------
// Words of the page
// ---------------------------------------------------------------------------

export const KIND_TEXT: Record<ClientKind, string> = {
  company: 'Società',
  individual: 'Privato',
  freelancer: 'Professionista',
  public_administration: 'Pubblica amministrazione',
};

export const STATUS_TEXT: Record<ClientStatus, string> = { active: 'Attivo', prospect: 'Potenziale', archived: 'Archiviato' };

export const AREA_TEXT: Record<ClientArea, string> = { IT: 'Italia', EU: 'UE', 'extra-EU': 'Extra UE' };

export const PAYMENT_TEXT: Record<PaymentMethod, string> = {
  bank_transfer: 'Bonifico',
  riba: 'RiBa',
  card: 'Carta',
  paypal: 'PayPal',
  cash: 'Contanti',
  other: 'Altro',
};

/** A short description of each nature of FatturaPA, for the menu. */
export const VAT_NATURE_TEXT: Record<(typeof VAT_NATURES)[number], string> = {
  N1: 'Escluse ex art. 15',
  'N2.1': 'Non soggette, artt. 7-7septies',
  'N2.2': 'Non soggette, altri casi (es. forfettario)',
  'N3.1': 'Non imponibili, esportazioni',
  'N3.2': 'Non imponibili, cessioni intracomunitarie',
  'N3.3': 'Non imponibili, verso San Marino',
  'N3.4': 'Non imponibili, assimilate alle esportazioni',
  'N3.5': 'Non imponibili, dichiarazione d’intento',
  'N3.6': 'Non imponibili, altre operazioni',
  N4: 'Esenti',
  N5: 'Regime del margine',
  'N6.1': 'Reverse charge, rottami',
  'N6.2': 'Reverse charge, oro e argento',
  'N6.3': 'Reverse charge, subappalto edile',
  'N6.4': 'Reverse charge, fabbricati',
  'N6.5': 'Reverse charge, telefoni cellulari',
  'N6.6': 'Reverse charge, prodotti elettronici',
  'N6.7': 'Reverse charge, comparto edile',
  'N6.8': 'Reverse charge, settore energetico',
  'N6.9': 'Reverse charge, altri casi',
  N7: 'IVA assolta in altro stato UE',
};

/** The countries of the menu: Italy, the EU, then the most frequent outside it; a code not listed is shown as it is. */
export const COUNTRIES: readonly { code: string; name: string }[] = [
  { code: 'IT', name: 'Italia' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgio' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'CY', name: 'Cipro' },
  { code: 'HR', name: 'Croazia' },
  { code: 'DK', name: 'Danimarca' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finlandia' },
  { code: 'FR', name: 'Francia' },
  { code: 'DE', name: 'Germania' },
  { code: 'GR', name: 'Grecia' },
  { code: 'IE', name: 'Irlanda' },
  { code: 'LV', name: 'Lettonia' },
  { code: 'LT', name: 'Lituania' },
  { code: 'LU', name: 'Lussemburgo' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Paesi Bassi' },
  { code: 'PL', name: 'Polonia' },
  { code: 'PT', name: 'Portogallo' },
  { code: 'CZ', name: 'Repubblica Ceca' },
  { code: 'RO', name: 'Romania' },
  { code: 'SK', name: 'Slovacchia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spagna' },
  { code: 'SE', name: 'Svezia' },
  { code: 'HU', name: 'Ungheria' },
  { code: 'CH', name: 'Svizzera' },
  { code: 'SM', name: 'San Marino' },
  { code: 'VA', name: 'Città del Vaticano' },
  { code: 'GB', name: 'Regno Unito' },
  { code: 'NO', name: 'Norvegia' },
  { code: 'US', name: 'Stati Uniti' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'AE', name: 'Emirati Arabi Uniti' },
  { code: 'CN', name: 'Cina' },
  { code: 'JP', name: 'Giappone' },
  { code: 'BR', name: 'Brasile' },
];

export function countryName(code: string): string {
  return COUNTRIES.find((country) => country.code === code)?.name ?? code;
}

/** "Bonifico · 30 gg fine mese", or null when nothing is said. */
export function paymentText(method: PaymentMethod | null, days: number | null, endOfMonth: boolean): string | null {
  const parts: string[] = [];
  if (method !== null) parts.push(PAYMENT_TEXT[method]);
  if (days !== null) parts.push(days === 0 ? `a vista${endOfMonth ? ' fine mese' : ''}` : `${String(days)} gg${endOfMonth ? ' fine mese' : ' data fattura'}`);
  else if (endOfMonth) parts.push('fine mese');
  return parts.length === 0 ? null : parts.join(' · ');
}

/** One line of an address: "Via Finta 1, 20100 Milano (MI)", plus the country when abroad. */
export function addressText(address: Address | null, clientCountry: string): string | null {
  if (address === null) return null;
  const street = [clean(address.street), clean(address.number)].filter((part) => part !== '').join(' ');
  const city = [clean(address.postalCode), clean(address.city)].filter((part) => part !== '').join(' ');
  const province = clean(address.province);
  const place = province === '' ? city : `${city} (${province})`.trim();
  const parts = [street, place].filter((part) => part !== '');
  if (address.country !== clientCountry || address.country !== 'IT') parts.push(countryName(address.country));
  const text = parts.join(', ');
  return text === '' ? null : text;
}

/**
 * What is still missing to send this client an electronic invoice: the
 * Italian codes for an Italian client, the VAT number of the EU for one of
 * the EU, the registered office for all. Empty when nothing is missing.
 */
export function billingGaps(form: ClientForm): string[] {
  const gaps: string[] = [];
  const italian = form.country === 'IT';
  const area = areaOf(form.country);
  const person = form.kind === 'individual';
  if (italian) {
    if (form.kind === 'public_administration') {
      if (clean(form.ipaCode) === '') gaps.push('codice IPA');
      if (clean(form.taxCode) === '' && clean(form.vatNumber) === '') gaps.push('codice fiscale');
    } else if (person) {
      if (clean(form.taxCode) === '') gaps.push('codice fiscale');
    } else {
      if (clean(form.vatNumber) === '') gaps.push('partita IVA');
      if (clean(form.sdiCode) === '' && clean(form.pec) === '') gaps.push('codice SDI o PEC');
    }
  } else if (area === 'EU' && !person) {
    if (clean(form.euVatNumber) === '') gaps.push('partita IVA UE');
  }
  // A rate of 0 says why there is no VAT with its nature (FatturaPA wants it).
  if (form.vatRate === 0 && clean(form.vatNature) === '') gaps.push('natura IVA per l’aliquota 0');
  if (form.kind !== 'individual' && clean(form.legalName) === '' && form.kind !== 'freelancer') gaps.push('ragione sociale');
  if (form.kind === 'freelancer' && (clean(form.firstName) === '' || clean(form.lastName) === '')) gaps.push('nome e cognome');
  const office = form.registeredAddress;
  if (office === null || clean(office.street) === '' || clean(office.city) === '' || (office.country === 'IT' && (clean(office.postalCode) === '' || clean(office.province) === ''))) gaps.push('indirizzo della sede');
  return gaps;
}

export type StatusFilter = 'current' | ClientStatus | 'all';

export const STATUS_FILTER_TEXT: Record<StatusFilter, string> = { current: 'Attivi e potenziali', active: 'Attivi', prospect: 'Potenziali', archived: 'Archiviati', all: 'Tutti' };

/** The list as the filter and the search show it: name, legal name, partita IVA, contact, project, tag. */
export function filterClients(list: readonly ClientSummary[], status: StatusFilter, query: string): ClientSummary[] {
  const needle = query.trim().toLowerCase();
  return list.filter((client) => {
    if (status === 'current' ? client.status === 'archived' : status !== 'all' && client.status !== status) return false;
    if (needle === '') return true;
    const haystack = [client.displayName, client.legalName, client.vatNumber, client.email, client.primaryContact?.name, ...client.projects, ...client.tags].filter((part) => part !== null && part !== undefined).join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

/** The approved projects a client may still take: not its own, not another client's. */
export function freeProjects(approved: readonly string[], all: readonly ClientSummary[], clientId: string): string[] {
  const taken = new Set(all.flatMap((client) => (client.id === clientId ? [] : client.projects)));
  const own = new Set(all.find((client) => client.id === clientId)?.projects ?? []);
  return approved.filter((project) => !taken.has(project) && !own.has(project));
}

/** A number typed in a field: empty is null, the Italian comma is a decimal point, anything else NaN (which the checks refuse). */
export function numberField(text: string | number | null | undefined): number | null {
  if (typeof text === 'number') return text;
  const clean = (text ?? '').trim().replace(',', '.');
  if (clean === '') return null;
  return /^-?\d+(\.\d+)?$/.test(clean) ? Number(clean) : Number.NaN;
}

/** Tags written as "web, grafica": trimmed, without doubles. */
export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const part of text.split(',')) {
    const tag = part.replace(/\s+/g, ' ').trim();
    if (tag !== '' && !tags.some((other) => other.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}
