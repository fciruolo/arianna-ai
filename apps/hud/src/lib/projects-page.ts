import { amountInput, calendarText, dayText, invoiceAmount, MAX_EVERY, moneyText, parseAmount, WEEKDAY_TEXT, type ImBillingRow, type ImCalendar, type ImInvoice, type ImOverview, type Money } from './im-billing.ts';
import { ruleItems, type RuleAudience, type RuleItem } from './rule-audience.ts';
import type { KnowledgeFolder, KnowledgeNote } from './projects.ts';

/**
 * The page "Progetti" revised (D-191): the tabs in one row, the numbers
 * at the top, the one form of calendar and price with its save bar, the
 * prices of single IM edited in their cells, the rules as a list and the
 * notes by folder. Pure helpers: nothing here reads or writes the core.
 * Prices and invoices stay Privati (L2) between the page and the core.
 */

// --- The tabs: one row; File, Git and Servizi read the part chosen, the others the whole container ---

export type ProjectTab = 'file' | 'git' | 'svc' | 'know' | 'im' | 'rules';

export const PROJECT_TABS = [
  { id: 'file', text: 'File' },
  { id: 'git', text: 'Git' },
  { id: 'svc', text: 'Servizi' },
  { id: 'know', text: 'Conoscenza' },
  { id: 'im', text: 'IM' },
  { id: 'rules', text: 'Regole' },
] as const satisfies readonly { id: ProjectTab; text: string }[];

/** File, Git and Servizi read one part; Conoscenza, IM and Regole the whole project. */
export function isPartTab(tab: ProjectTab): boolean {
  return tab === 'file' || tab === 'git' || tab === 'svc';
}

/** A part shows as chosen only in File, Git and Servizi: in IM or Regole no part is in use. */
export function partPressed(tab: ProjectTab, part: string, chosen: string | null): boolean {
  return isPartTab(tab) && part === chosen;
}

// --- The IM: next one, invoices past due, money of the year ---

/** The IM still to hold: the earliest not closed by date (an undated one last); null when all are closed. */
export function nextIm<T extends Pick<ImBillingRow, 'number' | 'date' | 'status'>>(rows: readonly T[]): T | null {
  const open = rows.filter((row) => row.status !== 'chiuso');
  open.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.number - b.number);
  return open[0] ?? null;
}

/** The invoices not paid whose due date is before today. */
export function overdueInvoices<T extends Pick<ImInvoice, 'paidOn' | 'due'>>(invoices: readonly T[], today: string): T[] {
  return invoices.filter((invoice) => invoice.paidOn === null && invoice.due !== null && invoice.due < today);
}

/** What was paid in a year, by currency, at the total of the document. */
export function paidInYear(invoices: readonly Pick<ImInvoice, 'paidOn' | 'currency' | 'documentCents' | 'totalCents'>[], year: number): Money[] {
  const sums = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.paidOn === null || !invoice.paidOn.startsWith(`${String(year)}-`)) continue;
    sums.set(invoice.currency, (sums.get(invoice.currency) ?? 0) + invoiceAmount(invoice));
  }
  return [...sums.entries()].map(([currency, cents]) => ({ currency, cents }));
}

/** "IM-33", "IM-33 e IM-32", "IM-33, IM-32 e IM-31"; more than four: "5 IM". */
export function imListText(numbers: readonly number[]): string {
  if (numbers.length > 4) return `${String(numbers.length)} IM`;
  const names = numbers.map((number) => `IM-${String(number)}`);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1] ?? ''}`;
}

/** "31/10": the day of a date without the year. */
export function shortDay(day: string): string {
  return dayText(day).slice(0, 5);
}

/** "4 voci da fare", "1 voce da fare", "nessuna voce da fare". */
export function todoText(counts: Pick<ImBillingRow['counts'], 'todo' | 'doing'>): string {
  const left = counts.todo + counts.doing;
  return left === 0 ? 'nessuna voce da fare' : left === 1 ? '1 voce da fare' : `${String(left)} voci da fare`;
}

/** "1 fattura scaduta", "2 fatture scadute". */
export function overdueText(count: number): string {
  return count === 1 ? '1 fattura scaduta' : `${String(count)} fatture scadute`;
}

// --- Calendar and price: one form, one save bar ---

export interface ImSettings {
  /** null: no calendar in the file (or one that does not hold); the form gets one with "Crea" or "Correggi qui". */
  calendar: ImCalendar | null;
  /** The last day of the IM, `YYYY-MM-DD`; '' while they go on. */
  end: string;
  /** The price as the field shows it: "450", "450,50"; '' for none. */
  price: string;
  currency: string;
}

/** The form as the core has it now. */
export function settingsOf(overview: Pick<ImOverview, 'calendar' | 'price'>): ImSettings {
  return {
    calendar: overview.calendar.calendar === null ? null : { ...overview.calendar.calendar },
    end: overview.calendar.end ?? '',
    price: amountInput(overview.price?.amountCents ?? null),
    currency: overview.price?.currency ?? 'EUR',
  };
}

/** The calendar a new file starts from: Thursday at 10:00, every week. */
export const NEW_CALENDAR: ImCalendar = { weekday: 4, time: '10:00', every: 1 };

function calendarValid(calendar: ImCalendar): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(calendar.time) && Number.isInteger(calendar.every) && calendar.every >= 1 && calendar.every <= MAX_EVERY;
}

const sameCalendar = (a: ImCalendar | null, b: ImCalendar | null): boolean =>
  a === null || b === null ? a === b : a.weekday === b.weekday && a.time === b.time && a.every === b.every;

/** The writes a save needs, in the order they go: the file (calendar, then end), then the price. */
export function settingsWrites(before: ImSettings, after: ImSettings): { calendar: boolean; end: boolean; price: boolean } {
  const priceBefore = parseAmount(before.price);
  const priceAfter = parseAmount(after.price);
  return {
    calendar: after.calendar !== null && !sameCalendar(before.calendar, after.calendar),
    end: before.end !== after.end,
    price: priceBefore !== priceAfter || (priceAfter !== null && before.currency !== after.currency),
  };
}

const priceShown = (text: string, currency: string): string => {
  const cents = parseAmount(text);
  return cents === null ? 'nessuno' : cents === undefined ? text : moneyText(cents, currency);
};

/** What changed, in words: "ora 10:00 → 11:00", "prezzo 450,00 € → 500,00 €", "calendario nuovo: ogni giovedì alle 10:00". */
export function settingsChanges(before: ImSettings, after: ImSettings): string[] {
  const out: string[] = [];
  if (after.calendar !== null && before.calendar === null) out.push(`calendario nuovo: ${calendarText(after.calendar)}`);
  else if (after.calendar !== null && before.calendar !== null) {
    if (before.calendar.weekday !== after.calendar.weekday) out.push(`giorno ${WEEKDAY_TEXT[before.calendar.weekday] ?? ''} → ${WEEKDAY_TEXT[after.calendar.weekday] ?? ''}`);
    if (before.calendar.time !== after.calendar.time) out.push(`ora ${before.calendar.time} → ${after.calendar.time === '' ? 'nessuna' : after.calendar.time}`);
    if (before.calendar.every !== after.calendar.every) out.push(`ogni ${String(before.calendar.every)} → ${String(after.calendar.every)} settimane`);
  }
  if (before.end !== after.end) out.push(`fine degli IM ${before.end === '' ? 'nessuna' : dayText(before.end)} → ${after.end === '' ? 'nessuna' : dayText(after.end)}`);
  const writes = settingsWrites(before, after);
  if (writes.price) {
    if (parseAmount(before.price) === parseAmount(after.price)) out.push(`valuta ${before.currency} → ${after.currency}`);
    else out.push(`prezzo ${priceShown(before.price, before.currency)} → ${priceShown(after.price, after.currency)}`);
  }
  return out;
}

/** The text of a save bar: "1 modifica: ora 10:00 → 11:00.", "2 modifiche: …". */
export function changesText(changes: readonly string[], noun: [one: string, many: string] = ['modifica', 'modifiche']): string {
  if (changes.length === 0) return '';
  return `${changes.length === 1 ? `1 ${noun[0]}` : `${String(changes.length)} ${noun[1]}`}: ${changes.join(', ')}.`;
}

/** Why the save cannot go yet; null when it can. */
export function settingsProblem(after: ImSettings): string | null {
  if (after.calendar !== null && !calendarValid(after.calendar)) return `L’ora va scritta come 10:00 e ogni va da 1 a ${String(MAX_EVERY)} settimane.`;
  if (parseAmount(after.price) === undefined) return 'Scrivi il prezzo come 450 o 450,50.';
  return null;
}

/** The line under the title: "IM ogni giovedì alle 10:00, senza data di fine · 450,00 € a IM, IVA esclusa". */
export function settingsSummary(overview: Pick<ImOverview, 'calendar' | 'price'>): string {
  const calendar = overview.calendar.calendar;
  const when = calendar === null ? 'Nessun calendario: ogni IM arriva sette giorni dopo l’ultimo' : `IM ${calendarText(calendar)}`;
  const end = overview.calendar.end === null ? (calendar === null ? '' : ', senza data di fine') : `, fino al ${dayText(overview.calendar.end)}`;
  const price = overview.price?.amountCents ?? null;
  return `${when}${end} · ${price === null ? 'nessun prezzo per IM' : `${moneyText(price, overview.price?.currency ?? 'EUR')} a IM, IVA esclusa`}`;
}

// --- The price of one IM, edited in its cell ---

/** The price of an IM can change while it is in no invoice and is billed; in an invoice it is locked. */
export function priceEditable(row: Pick<ImBillingRow, 'invoice' | 'notBilled'>): boolean {
  return row.invoice === null && !row.notBilled;
}

export interface PriceChange {
  number: number;
  /** The amount shown before, in cents; null without one. */
  from: number | null;
  /** The own price of the IM; null: back to the price of the project. */
  to: number | null;
  invalid: boolean;
}

/**
 * The cells changed: the text typed for each IM against its price. An empty
 * cell is the price of the project; the same amount the IM shows already is
 * no change. An IM gone into an invoice or out of billing meanwhile is
 * left out: its price is locked.
 */
export function priceChanges(rows: readonly Pick<ImBillingRow, 'number' | 'amountCents' | 'overrideCents' | 'invoice' | 'notBilled'>[], edits: ReadonlyMap<number, string>): PriceChange[] {
  const out: PriceChange[] = [];
  for (const row of rows) {
    const text = edits.get(row.number);
    if (text === undefined || !priceEditable(row)) continue;
    const cents = parseAmount(text);
    if (cents === undefined) {
      out.push({ number: row.number, from: row.amountCents, to: null, invalid: true });
      continue;
    }
    if (cents === row.overrideCents) continue;
    if (cents !== null && row.overrideCents === null && cents === row.amountCents) continue;
    out.push({ number: row.number, from: row.amountCents, to: cents, invalid: false });
  }
  return out;
}

/**
 * The amount of an IM without its own price, as the core counts it: the one
 * fixed when it closed, else (still open) the price of the project.
 */
export function fallbackCents(row: Pick<ImBillingRow, 'closedCents' | 'status'>, projectCents: number | null): number | null {
  return row.closedCents ?? (row.status === 'chiuso' ? null : projectCents);
}

/** "IM-33 450,00 € → 500,00 €", "IM-32 300,00 € → 450,00 €" (back to the project's), "IM-32 300,00 € → prezzo del progetto". */
export function priceChangeText(change: PriceChange, currency: string, fallback: number | null = null): string {
  const from = change.from === null ? 'nessuno' : moneyText(change.from, currency);
  if (change.invalid) return `IM-${String(change.number)} non è un importo`;
  const to = change.to ?? fallback;
  return `IM-${String(change.number)} ${from} → ${to === null ? 'prezzo del progetto' : moneyText(to, currency)}`;
}

/** An entry of the "⋯" of a row (RowMenu.vue). */
export interface RowMenuItem {
  id: string;
  text: string;
  danger?: boolean;
  disabled?: boolean;
}

export type ImFilter = 'all' | 'to-invoice' | 'invoiced' | 'paid';

export const IM_FILTER_TEXT: Record<ImFilter, string> = { all: 'Tutti', 'to-invoice': 'Da fatturare', invoiced: 'In fattura', paid: 'Pagati' };

export function imFilterMatch(row: Pick<ImBillingRow, 'state'>, filter: ImFilter): boolean {
  return filter === 'all' || row.state === filter;
}

export function imFilterCounts(rows: readonly Pick<ImBillingRow, 'state'>[]): Record<ImFilter, number> {
  return {
    all: rows.length,
    'to-invoice': rows.filter((row) => row.state === 'to-invoice').length,
    invoiced: rows.filter((row) => row.state === 'invoiced').length,
    paid: rows.filter((row) => row.state === 'paid').length,
  };
}

// --- Rules: a list in the normal font, headings between ---

export type RuleRow = { kind: 'head'; line: number; text: string } | { kind: 'rule'; item: RuleItem };

const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The rules of a text with its headings between them ("## Stile"), as the list shows them. */
export function ruleRows(text: string): RuleRow[] {
  const heads: RuleRow[] = [];
  let fence: string | undefined;
  for (const [line, value] of text.split(/\r?\n/).entries()) {
    const opening = FENCE.exec(value);
    if (fence !== undefined) {
      if (value.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    if (opening !== null) {
      fence = (opening[1] ?? '```').slice(0, 3);
      continue;
    }
    const heading = HEADING.exec(value);
    if (heading !== null) heads.push({ kind: 'head', line, text: heading[1] ?? '' });
  }
  const rules: RuleRow[] = ruleItems(text).map((item) => ({ kind: 'rule', item }));
  const lineOf = (row: RuleRow): number => (row.kind === 'head' ? row.line : row.item.line);
  return [...heads, ...rules].sort((a, b) => lineOf(a) - lineOf(b));
}

/** A rule's text split on its `code`: the code goes in the fixed font, the rest in the normal one. */
export function codeParts(text: string): { text: string; code: boolean }[] {
  return text
    .split(/(`[^`]+`)/)
    .filter((part) => part !== '')
    .map((part) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? { text: part.slice(1, -1), code: true } : { text: part, code: false }));
}

const AUDIENCE_AFTER: Record<RuleAudience, string> = { both: 'per entrambi', claude: 'solo per Claude Code', codex: 'solo per Codex' };

const short = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

/**
 * What a save of the rules changes, in words: the mode, who reads a rule
 * («Non toccare public/» ora solo per Codex), or the text itself.
 */
export function ruleChanges(before: { own: boolean; text: string }, after: { own: boolean; text: string }): string[] {
  if (before.own !== after.own) return [after.own ? 'il progetto passa a regole proprie' : 'il progetto torna al modello comune'];
  if (!after.own || before.text === after.text) return [];
  const old = ruleItems(before.text);
  const now = ruleItems(after.text);
  const sameRules = old.length === now.length && old.every((item, at) => {
      const other = now[at];
      return other !== undefined && item.text === other.text && item.line === other.line;
    });
  const rest = (text: string, items: RuleItem[]): string => {
    const lines = text.split('\n');
    for (const item of items) lines[item.line] = '';
    return lines.join('\n');
  };
  if (!sameRules || rest(before.text, old) !== rest(after.text, now)) return ['testo delle regole cambiato'];
  return now.filter((item, at) => item.audience !== old[at]?.audience).map((item) => `«${short(item.text)}» ora ${AUDIENCE_AFTER[item.audience]}`);
}

// --- Conoscenza: folders with how many notes, notes by folder, a search ---

/** "1 nota", "2 note", "nessuna nota". */
export function notesCountText(count: number): string {
  return count === 0 ? 'nessuna nota' : count === 1 ? '1 nota' : `${String(count)} note`;
}

export interface NoteGroup {
  folder: string;
  label: KnowledgeFolder['label'] | undefined;
  notes: KnowledgeNote[];
}

/**
 * The notes by folder, every folder of the project in its order (folders of
 * notes not listed after); with a search, only the notes whose title or path
 * holds it, and only the folders with some.
 */
export function noteGroups(folders: readonly KnowledgeFolder[], notes: readonly KnowledgeNote[], query: string): NoteGroup[] {
  const needle = query.trim().toLocaleLowerCase('it');
  const groups = new Map<string, NoteGroup>();
  for (const folder of folders) groups.set(folder.path, { folder: folder.path, label: folder.label, notes: [] });
  for (const note of notes) {
    if (needle !== '' && !note.title.toLocaleLowerCase('it').includes(needle) && !note.path.toLocaleLowerCase('it').includes(needle)) continue;
    const group = groups.get(note.folder) ?? { folder: note.folder, label: undefined, notes: [] };
    group.notes.push(note);
    groups.set(note.folder, group);
  }
  const out = [...groups.values()];
  return needle === '' ? out : out.filter((group) => group.notes.length > 0);
}

/** How many notes a folder holds, among those read. */
export function folderCounts(notes: readonly KnowledgeNote[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.folder, (counts.get(note.folder) ?? 0) + 1);
  return counts;
}
