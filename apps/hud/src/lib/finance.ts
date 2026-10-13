import { ApiError } from './api.ts';

/**
 * The page "Finanze" (I-18, D-183): pure helpers. The shapes of the API of
 * docs/FINANCE-API.md (repeated here: the page does not import the core nor
 * @arianna/finance), the address, amounts from integer cents in Italian, the
 * codes of the import in Italian, the bank profile edited by hand, the
 * sentences of the checks and the movements each check points at. Everything
 * here is private (L2, rule `finance`): it never leaves this Mac.
 */

export const FINANCE_PATH = '/finanze';

export type FinanceTab = 'conti' | 'importa' | 'movimenti' | 'categorie' | 'riepilogo' | 'avvisi';

export const FINANCE_TABS: readonly (readonly [FinanceTab, string])[] = [
  ['riepilogo', 'Riepilogo'],
  ['movimenti', 'Movimenti'],
  ['importa', 'Importa'],
  ['conti', 'Conti'],
  ['categorie', 'Categorie e budget'],
  ['avvisi', 'Avvisi'],
];

const TAB_SLUGS = new Set<string>(FINANCE_TABS.map(([slug]) => slug));

/** `/finanze`, or one of its tabs: `/finanze/<tab>`. */
export function isFinancePath(pathname: string): boolean {
  const match = /^\/finanze(?:\/([a-z]+))?\/?$/.exec(pathname);
  return match !== null && (match[1] === undefined || TAB_SLUGS.has(match[1]));
}

/** The tab the address names; undefined for the bare address. */
export function financeTabFromPath(pathname: string): FinanceTab | undefined {
  const slug = /^\/finanze\/([a-z]+)\/?$/.exec(pathname)?.[1];
  return slug !== undefined && TAB_SLUGS.has(slug) ? (slug as FinanceTab) : undefined;
}

export function financePathFor(tab: FinanceTab | undefined): string {
  return tab === undefined ? FINANCE_PATH : `${FINANCE_PATH}/${tab}`;
}

// ---------------------------------------------------------------------------
// Shapes of the API (docs/FINANCE-API.md)
// ---------------------------------------------------------------------------

export type Day = string;
export type Month = string;

export type DateFormat = 'dd/mm/yyyy' | 'dd-mm-yyyy' | 'dd.mm.yyyy' | 'yyyy-mm-dd' | 'dd/mm/yy' | 'serial';
export type DecimalMark = ',' | '.';
export type AmountColumns = { kind: 'single'; column: string } | { kind: 'split'; debit: string; credit: string };

export interface BankProfile {
  booked: string;
  value: string | null;
  description: string[];
  amount: AmountColumns;
  balance: string | null;
  currency: string | null;
  dateFormat: DateFormat;
  decimal: DecimalMark;
}

export interface Account {
  id: string;
  name: string;
  currency: string;
  profile: BankProfile | null;
  archived: boolean;
  transactions: number;
  lastBooked: Day | null;
}

export type RejectReason = 'missing-date' | 'bad-date' | 'missing-amount' | 'bad-amount' | 'both-amounts';

export interface PreviewRow {
  line: number;
  booked: Day;
  value: Day | null;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
}

export interface Preview {
  kind: 'csv' | 'xlsx';
  sheets: string[] | null;
  sheet: string | null;
  profile: BankProfile | null;
  guessed: boolean;
  headerLine: number | null;
  header: string[];
  newestFirst: boolean;
  rows: PreviewRow[];
  duplicates: number;
  rejected: { line: number; code: string }[];
  totals: { count: number; income: number; expenses: number };
}

export interface ImportRecord {
  id: string;
  account: string;
  name: string;
  at: string;
  imported: number;
  duplicates: number;
  rejected: number;
}

export interface Tx {
  id: string;
  account: string;
  booked: Day;
  value: Day | null;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
  category: string | null;
  by: 'rule' | 'user' | null;
  importId: string | null;
  /** The fingerprint the checks name the row by. */
  fingerprint: string;
}

export interface Category {
  id: string;
  name: string;
  kind: 'out' | 'in';
}

export interface Rule {
  id: string;
  match: string;
  category: string;
}

export interface Budget {
  category: string;
  monthly: number;
}

export interface MonthTotal {
  month: Month;
  income: number;
  expenses: number;
  net: number;
  count: number;
}

export interface CategoryTotal {
  category: string | null;
  expenses: number;
  income: number;
  count: number;
}

export interface BalancePoint {
  day: Day;
  balance: number;
  source: 'bank' | 'computed';
}

export interface YearOverYear {
  current: MonthTotal;
  previous: MonthTotal;
  expensesChange: number;
  incomeChange: number;
}

export interface Summary {
  months: MonthTotal[];
  categories: CategoryTotal[];
  balance: BalancePoint[];
  yearOverYear: YearOverYear | null;
}

export type Cadence = 'weekly' | 'monthly' | 'yearly';

export interface RecurringAlert {
  kind: 'recurring';
  account: string;
  merchant: string;
  direction: 'out' | 'in';
  cadence: Cadence;
  fingerprints: string[];
  amount: number;
  lastAmount: number;
  amountChanged: boolean;
  lastDay: Day;
  nextExpected: Day;
}

export interface UnusualAlert {
  kind: 'unusual';
  fingerprint: string;
  account: string;
  merchant: string;
  category: string | null;
  amount: number;
  basis: 'merchant' | 'category';
  median: number;
  historyCount: number;
  ratioPercent: number;
}

export interface DuplicateAlert {
  kind: 'duplicate';
  account: string;
  merchant: string;
  amount: number;
  fingerprints: string[];
  firstDay: Day;
  lastDay: Day;
  recurring: boolean;
}

export interface BudgetAlert {
  kind: 'budget';
  category: string;
  month: Month;
  spent: number;
  limit: number;
  percent: number;
  state: 'over' | 'near';
  fingerprints: string[];
}

export type FinanceAlert = RecurringAlert | UnusualAlert | DuplicateAlert | BudgetAlert;

/** The filters of "Movimenti", as the query of `GET /api/finance/transactions`. */
export interface TxFilter {
  account: string;
  /** A day, `''` for no bound. */
  from: Day;
  /** A day, `''` for no bound. */
  to: Day;
  /** A category id, `''` for any. */
  category: string;
  uncategorized: boolean;
  q: string;
  /** The rows of a check, by fingerprint; empty for none. */
  fingerprints: readonly string[];
}

export const EMPTY_FILTER: Readonly<TxFilter> = { account: '', from: '', to: '', category: '', uncategorized: false, q: '', fingerprints: [] };

/** The query string of the filters; empty values are left out. */
export function filterQuery(filter: TxFilter, limit: number, offset: number): string {
  const params = new URLSearchParams();
  if (filter.account !== '') params.set('account', filter.account);
  if (filter.from !== '') params.set('from', filter.from);
  if (filter.to !== '') params.set('to', filter.to);
  if (filter.uncategorized) params.set('uncategorized', '1');
  else if (filter.category !== '') params.set('category', filter.category);
  if (filter.q.trim() !== '') params.set('q', filter.q.trim());
  if (filter.fingerprints.length > 0) params.set('fingerprints', filter.fingerprints.slice(0, MAX_FINGERPRINTS).join(','));
  params.set('limit', String(limit));
  if (offset > 0) params.set('offset', String(offset));
  return params.toString();
}

// ---------------------------------------------------------------------------
// Amounts and days in Italian
// ---------------------------------------------------------------------------

const MINUS = '−';

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Integer cents as an amount in Italian: `1.234,56 €`, `−12,50 €`; other
 * currencies by their code (`10,00 USD`). With `sign`, a plus on positive
 * amounts. Computed on integers, never through a float.
 */
export function formatCents(cents: number, options: { currency?: string; sign?: boolean } = {}): string {
  const currency = options.currency ?? 'EUR';
  const value = Math.round(cents);
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = groupThousands(String(Math.floor(absolute / 100)));
  const fraction = String(absolute % 100).padStart(2, '0');
  const prefix = negative ? MINUS : options.sign === true && value > 0 ? '+' : '';
  return `${prefix}${whole},${fraction} ${currency === 'EUR' ? '€' : currency}`;
}

/** A short amount for the axes of the charts: `850 €`, `1,2k €`, `-3k €`. */
export function formatCompact(cents: number): string {
  const euros = Math.round(cents / 100);
  const sign = euros < 0 ? MINUS : '';
  const absolute = Math.abs(euros);
  if (absolute < 1000) return `${sign}${String(absolute)} €`;
  const thousands = Math.round(absolute / 100) / 10;
  const text = Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1).replace('.', ',');
  return `${sign}${text}k €`;
}

/**
 * What the user writes in euro (`12`, `12,5`, `1.234,56`, `12.50`) as cents;
 * null when it is not an amount. With a comma, points group thousands; without,
 * a point followed by one or two digits is the decimal mark.
 */
export function parseEuroInput(text: string): number | null {
  let value = text.trim().replace(/\s|€/g, '');
  if (value === '') return null;
  if (value.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(value)) return null;
    value = value.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+\.\d{1,2}$/.test(value)) {
    // decimal point
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    value = value.replace(/\./g, '');
  } else if (!/^\d+$/.test(value)) {
    return null;
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Cents as the text of an input field: `1234,5` → `1234,50`. */
export function centsInput(cents: number): string {
  return `${String(Math.floor(Math.abs(cents) / 100))},${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

/** `2026-10-11` → `11/10/2026`; anything else as it is. */
export function formatDay(day: Day | null): string {
  if (day === null) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match === null ? day : `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''}`;
}

const MONTH_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MONTH_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** `2026-10` → `ott 2026` (short) or `ottobre 2026`. */
export function formatMonth(month: Month, long = false): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const names = long ? MONTH_LONG : MONTH_SHORT;
  return `${names[Number(match[2]) - 1] ?? ''} ${match[1] ?? ''}`;
}

/** An ISO 8601 moment as `11/10/2026 14:05`, in local time. */
export function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The day as `YYYY-MM-DD` in local time. */
export function dayOf(date: Date): Day {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The month of a day, or of a date. */
export function monthOfDay(day: Day): Month {
  return day.slice(0, 7);
}

/** The last day of a month: `2026-02` → `2026-02-28`. */
export function lastDayOf(month: Month): Day {
  const [year = 0, number = 1] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

/** Entrate in green, uscite in the normal colour. */
export function amountClass(cents: number): string {
  return cents > 0 ? 'text-ok' : '';
}

// ---------------------------------------------------------------------------
// Codes of the import, in Italian
// ---------------------------------------------------------------------------

/** `ImportErrorCode` of @arianna/finance (packages/finance/src/table.ts). */
export const IMPORT_ERROR_TEXT: Readonly<Record<string, string>> = {
  empty: 'Il file è vuoto.',
  'too-large': 'Il file è troppo grande: al massimo 10 MB.',
  'too-many-rows': 'Il file ha troppe righe (più di 50.000): dividilo in più file.',
  'too-many-columns': 'Il file ha troppe colonne (più di 200).',
  'cell-too-long': 'Una cella del file è troppo lunga.',
  'unterminated-quote': 'Nel CSV c’è una cella fra virgolette che non viene mai chiusa.',
  'unsupported-encoding': 'La codifica del file non è supportata: salvalo come CSV UTF-8.',
  'unsupported-type': 'Si possono importare solo file .csv e .xlsx.',
  'type-mismatch': 'Il contenuto del file non corrisponde alla sua estensione (per esempio un .xlsx rinominato in .csv).',
  xls: 'I file .xls del vecchio Excel non si leggono: aprilo in Excel e salvalo come .xlsx o come CSV.',
  'bad-zip': 'Il file Excel è rovinato o non è un vero .xlsx.',
  encrypted: 'Il file è protetto da password: toglila in Excel e riprova.',
  zip64: 'Il file Excel è in un formato troppo grande (Zip64) che non si legge: salvalo come CSV.',
  'bad-path': 'Il file Excel contiene un percorso non valido: non viene letto.',
  'unzipped-too-large': 'Il file Excel, aperto, è troppo grande.',
  'bad-xlsx': 'Il file Excel non è leggibile.',
  'bad-xml': 'Il file Excel contiene dati non leggibili.',
  'no-sheet': 'Il foglio scelto non c’è nel file Excel.',
  'no-header': 'Nessuna riga del file ha le colonne di un estratto conto (data, descrizione, importo).',
  'unknown-columns': 'Non riconosco le colonne del file: sceglile a mano.',
  'profile-mismatch': 'Le colonne scelte non ci sono nel file: correggi il profilo.',
};

/** Why one row was not imported (`RejectReason` of packages/finance/src/import.ts). */
export const REJECT_TEXT: Readonly<Record<string, string>> = {
  'missing-date': 'manca la data',
  'bad-date': 'data non leggibile con il formato scelto',
  'missing-amount': 'manca l’importo',
  'bad-amount': 'importo non leggibile con il separatore scelto',
  'both-amounts': 'ha sia dare sia avere',
};

export function rejectText(code: string): string {
  return REJECT_TEXT[code] ?? 'riga non valida';
}

/**
 * An error of the finance API in Italian: the codes of the import, a file
 * too large, a page newer than the core (404 on the routes), the core off.
 */
export function financeErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof TypeError ? 'Il nucleo non risponde: controlla che sia avviato.' : 'Errore imprevisto.';
  }
  const known = IMPORT_ERROR_TEXT[cause.message];
  if (known !== undefined) {
    const line = cause.body.line;
    return typeof line === 'number' ? `${known.replace(/\.$/, '')} (riga ${String(line)}).` : known;
  }
  if (cause.status === 413) return IMPORT_ERROR_TEXT['too-large'] ?? '';
  if (cause.status === 404) return 'Non trovato: forse il nucleo non ha ancora le Finanze, o l’elemento è stato tolto. Aggiorna e riavvia il nucleo.';
  if (cause.status === 409) return 'C’è già un elemento con questi dati.';
  if (cause.status === 403) return 'Il nucleo ha rifiutato la richiesta: apri la chat dal suo indirizzo.';
  if (cause.status >= 500) return 'Errore del nucleo: riprova fra poco.';
  return 'Richiesta non valida.';
}

// ---------------------------------------------------------------------------
// The file chosen in the browser
// ---------------------------------------------------------------------------

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What the page does with a file by its name: send it, or explain why not. */
export function fileProblem(name: string, size: number): string | null {
  const extension = /\.([^.]+)$/.exec(name.toLowerCase())?.[1] ?? '';
  if (extension === 'xls') return IMPORT_ERROR_TEXT.xls ?? null;
  if (!['csv', 'xlsx', 'tsv', 'txt'].includes(extension)) return IMPORT_ERROR_TEXT['unsupported-type'] ?? null;
  if (size === 0) return IMPORT_ERROR_TEXT.empty ?? null;
  if (size > MAX_FILE_BYTES) return IMPORT_ERROR_TEXT['too-large'] ?? null;
  return null;
}

/** Bytes as base64, in chunks so a large file does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// The bank profile, edited by hand
// ---------------------------------------------------------------------------

export const DATE_FORMAT_TEXT: Readonly<Record<DateFormat, string>> = {
  'dd/mm/yyyy': '31/12/2026',
  'dd-mm-yyyy': '31-12-2026',
  'dd.mm.yyyy': '31.12.2026',
  'yyyy-mm-dd': '2026-12-31',
  'dd/mm/yy': '31/12/26',
  serial: 'Numero di Excel (46022)',
};

export const DECIMAL_TEXT: Readonly<Record<DecimalMark, string>> = {
  ',': 'Virgola (1.234,56)',
  '.': 'Punto (1,234.56)',
};

/** The profile as the selects hold it: `''` is "nessuna colonna". */
export interface ProfileDraft {
  booked: string;
  value: string;
  description: string;
  description2: string;
  amountKind: 'single' | 'split';
  amount: string;
  debit: string;
  credit: string;
  balance: string;
  currency: string;
  dateFormat: DateFormat;
  decimal: DecimalMark;
}

export function draftOf(profile: BankProfile | null): ProfileDraft {
  if (profile === null) {
    return { booked: '', value: '', description: '', description2: '', amountKind: 'single', amount: '', debit: '', credit: '', balance: '', currency: '', dateFormat: 'dd/mm/yyyy', decimal: ',' };
  }
  return {
    booked: profile.booked,
    value: profile.value ?? '',
    description: profile.description[0] ?? '',
    description2: profile.description[1] ?? '',
    amountKind: profile.amount.kind,
    amount: profile.amount.kind === 'single' ? profile.amount.column : '',
    debit: profile.amount.kind === 'split' ? profile.amount.debit : '',
    credit: profile.amount.kind === 'split' ? profile.amount.credit : '',
    balance: profile.balance ?? '',
    currency: profile.currency ?? '',
    dateFormat: profile.dateFormat,
    decimal: profile.decimal,
  };
}

/** What is still missing in the draft, in Italian; empty when it is complete. */
export function draftProblems(draft: ProfileDraft): string[] {
  const problems: string[] = [];
  if (draft.booked === '') problems.push('Scegli la colonna della data.');
  if (draft.description === '') problems.push('Scegli la colonna della descrizione.');
  if (draft.amountKind === 'single' && draft.amount === '') problems.push('Scegli la colonna dell’importo.');
  if (draft.amountKind === 'split') {
    if (draft.debit === '' || draft.credit === '') problems.push('Scegli le colonne di dare e avere.');
    else if (draft.debit === draft.credit) problems.push('Dare e avere devono essere due colonne diverse.');
  }
  return problems;
}

/** The profile of a complete draft; null while something is missing. */
export function profileOf(draft: ProfileDraft): BankProfile | null {
  if (draftProblems(draft).length > 0) return null;
  const description = [draft.description, ...(draft.description2 !== '' && draft.description2 !== draft.description ? [draft.description2] : [])];
  return {
    booked: draft.booked,
    value: draft.value === '' ? null : draft.value,
    description,
    amount: draft.amountKind === 'single' ? { kind: 'single', column: draft.amount } : { kind: 'split', debit: draft.debit, credit: draft.credit },
    balance: draft.balance === '' ? null : draft.balance,
    currency: draft.currency === '' ? null : draft.currency,
    dateFormat: draft.dateFormat,
    decimal: draft.decimal,
  };
}

/** The header names to choose from: the non-empty ones, each once. */
export function headerChoices(header: readonly string[]): string[] {
  return [...new Set(header.map((name) => name.trim()).filter((name) => name !== ''))];
}

// ---------------------------------------------------------------------------
// The checks of the month, in Italian
// ---------------------------------------------------------------------------

export interface NameLookup {
  account: (id: string) => string;
  category: (id: string | null) => string;
}

export interface AlertText {
  title: string;
  detail: string;
  /** `danger` for what needs a look now, `warn` for the rest. */
  tone: 'danger' | 'warn';
}

const CADENCE_TEXT: Record<Cadence, string> = { weekly: 'settimanale', monthly: 'mensile', yearly: 'annuale' };

function quoted(merchant: string): string {
  return `«${merchant}»`;
}

/** The sentence of a check, composed here: the core sends only kinds and numbers. */
export function alertText(alert: FinanceAlert, names: NameLookup): AlertText {
  switch (alert.kind) {
    case 'recurring': {
      const what = alert.direction === 'out' ? 'L’addebito' : 'L’accredito';
      const change = alert.lastAmount > alert.amount ? 'è salito' : 'è sceso';
      return {
        title: `${what} ${CADENCE_TEXT[alert.cadence]} di ${quoted(alert.merchant)} ${change} da ${formatCents(alert.amount)} a ${formatCents(alert.lastAmount)}`,
        detail: `Ultimo il ${formatDay(alert.lastDay)}, prossimo atteso verso il ${formatDay(alert.nextExpected)} · ${names.account(alert.account)}`,
        tone: alert.direction === 'out' && alert.lastAmount > alert.amount ? 'danger' : 'warn',
      };
    }
    case 'unusual': {
      const basis = alert.basis === 'merchant' ? `delle altre ${String(alert.historyCount)} spese da ${quoted(alert.merchant)}` : `delle altre ${String(alert.historyCount)} spese in ${names.category(alert.category)}`;
      const times = (alert.ratioPercent / 100).toFixed(1).replace('.', ',').replace(/,0$/, '');
      return {
        title: `Spesa insolita da ${quoted(alert.merchant)}: ${formatCents(alert.amount)}`,
        detail: `Circa ${times} volte la cifra abituale (${formatCents(alert.median)}, la mediana ${basis}) · ${names.account(alert.account)}`,
        tone: 'warn',
      };
    }
    case 'duplicate': {
      const count = alert.fingerprints.length;
      const when = alert.firstDay === alert.lastDay ? `il ${formatDay(alert.firstDay)}` : `fra il ${formatDay(alert.firstDay)} e il ${formatDay(alert.lastDay)}`;
      return {
        title: `Possibile doppio addebito da ${quoted(alert.merchant)}: ${String(count)} volte ${formatCents(alert.amount)}`,
        detail: `${when}${alert.recurring ? ', oltre all’addebito abituale' : ''} · ${names.account(alert.account)}. Controlla con la banca prima di fare altro.`,
        tone: 'danger',
      };
    }
    case 'budget': {
      const over = alert.state === 'over';
      return {
        title: `${over ? 'Budget superato' : 'Budget quasi esaurito'}: ${names.category(alert.category)}`,
        detail: `Spesi ${formatCents(alert.spent)} su ${formatCents(alert.limit)} (${String(alert.percent)}%) in ${formatMonth(alert.month, true)}`,
        tone: over ? 'danger' : 'warn',
      };
    }
  }
}

/** The most fingerprints `GET /api/finance/transactions` takes in one query. */
export const MAX_FINGERPRINTS = 50;

/**
 * The movements a check is about, as the filters of "Movimenti": its rows by
 * their fingerprints (the most recent 50 when there are more). A budget is
 * about a whole category in a month: category and days, which may hold more.
 */
export function alertFilter(alert: FinanceAlert): TxFilter {
  switch (alert.kind) {
    case 'unusual':
      return { ...EMPTY_FILTER, fingerprints: [alert.fingerprint] };
    case 'recurring':
    case 'duplicate':
      return { ...EMPTY_FILTER, fingerprints: alert.fingerprints.slice(-MAX_FINGERPRINTS) };
    case 'budget':
      return { ...EMPTY_FILTER, category: alert.category, from: `${alert.month}-01`, to: lastDayOf(alert.month) };
  }
}

/** The names the sentences and tables show, from the lists of the page. */
export function nameLookup(accounts: readonly Account[], categories: readonly Category[]): NameLookup {
  return {
    account: (id) => accounts.find((account) => account.id === id)?.name ?? 'conto non più presente',
    category: (id) => (id === null ? 'Senza categoria' : (categories.find((category) => category.id === id)?.name ?? 'categoria non più presente')),
  };
}

/** A name of one line, 1-80 characters, as the core wants; the problem in Italian, or null. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Scrivi un nome.';
  if (trimmed.length > 80) return 'Il nome supera 80 caratteri.';
  if (/[\r\n]/.test(trimmed)) return 'Il nome sta su una riga.';
  return null;
}

/** Change against the same month of the year before, in words. */
export function changeText(change: number, previous: number): string {
  if (change === 0) return 'uguale';
  const amount = formatCents(change, { sign: true });
  if (previous === 0) return amount;
  const percent = Math.round((change * 100) / previous);
  return `${amount} (${percent > 0 ? '+' : percent < 0 ? MINUS : ''}${String(Math.abs(percent))}%)`;
}
