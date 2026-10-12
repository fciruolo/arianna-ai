import { formatCents, formatMonth, type Budget, type CategoryTotal, type Month, type MonthTotal } from './finance.ts';

/**
 * The finances as a dashboard (D-189): the numbers at the top of "Riepilogo",
 * the descriptions of the bank made readable in "Movimenti", the budgets with
 * what was spent and the changes saved together in "Categorie e budget". Pure
 * helpers; everything stays private (L2, rule `finance`) as in finance.ts.
 */

const MINUS = '−';

/** The month before: `2026-01` → `2025-12`. */
export function previousMonth(month: Month): Month {
  const [year = 0, number = 1] = month.split('-').map(Number);
  const before = number === 1 ? { year: year - 1, number: 12 } : { year, number: number - 1 };
  return `${String(before.year)}-${String(before.number).padStart(2, '0')}`;
}

export interface MonthPair {
  current: MonthTotal;
  previous: MonthTotal;
}

function emptyMonth(month: Month): MonthTotal {
  return { month, income: 0, expenses: 0, net: 0, count: 0 };
}

/**
 * The newest month with movements and the month before it (zero when it had
 * none), for the numbers at the top; null without movements.
 */
export function latestMonths(months: readonly MonthTotal[]): MonthPair | null {
  const withRows = months.filter((month) => month.count > 0).sort((a, b) => a.month.localeCompare(b.month));
  const current = withRows[withRows.length - 1];
  if (current === undefined) return null;
  const before = previousMonth(current.month);
  return { current, previous: months.find((month) => month.month === before) ?? emptyMonth(before) };
}

/** `−42% rispetto ad agosto`, `uguali a ottobre`, `agosto: 0,00 €` («ad» only before an «a»). */
export function monthChangeText(current: number, previous: number, previousMonthName: Month): string {
  const name = formatMonth(previousMonthName, true).split(' ')[0] ?? '';
  const against = name.startsWith('a') ? `ad ${name}` : `a ${name}`;
  if (previous === 0) return `${name}: ${formatCents(0)}`;
  if (current === previous) return `uguali ${against}`;
  const percent = Math.round(((current - previous) * 100) / previous);
  const sign = percent > 0 ? '+' : percent < 0 ? MINUS : '';
  return `${sign}${String(Math.abs(percent))}% rispetto ${against}`;
}

/** The balance of every account as one text per currency: `2.844,24 €`, or `1.000,00 € · 50,00 USD`. */
export function balanceText(balances: readonly { balance: number; currency: string }[]): string {
  const totals = new Map<string, number>();
  for (const item of balances) totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.balance);
  return [...totals.entries()].map(([currency, cents]) => formatCents(cents, { currency })).join(' · ');
}

// ---------------------------------------------------------------------------
// Descriptions of the bank, readable

/** How a bank opens a description, longest first, as it is written in the row. */
const PAYMENT_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^PAGAMENTO\s+POS\b/i, 'Pagamento POS'],
  [/^PAGAMENTO\s+CARTA\b/i, 'Pagamento con carta'],
  [/^PAGAMENTO\s+BOLLETTA\b/i, 'Pagamento bolletta'],
  [/^PAGAMENTO\s+F24\b/i, 'Pagamento F24'],
  [/^ADDEBITO\s+SDD\b/i, 'Addebito SDD'],
  [/^ADDEBITO\s+DIRETTO\b/i, 'Addebito diretto'],
  [/^SDD\b/i, 'Addebito SDD'],
  [/^BONIFICO\s+(SEPA\s+)?(ISTANTANEO\s+)?A\s+VOSTRO\s+FAVORE\b/i, 'Bonifico in entrata'],
  [/^BONIFICO\s+(SEPA\s+)?(ISTANTANEO\s+)?DISPOSTO\b/i, 'Bonifico in uscita'],
  [/^BONIFICO\s+(SEPA\s+)?(ISTANTANEO\b)?/i, 'Bonifico'],
  [/^PRELIEVO\s+(BANCOMAT|ATM|CONTANTI)\b/i, 'Prelievo'],
  [/^PRELIEVO\b/i, 'Prelievo'],
  [/^RICARICA\b/i, 'Ricarica'],
  [/^COMMISSIONI\b/i, 'Commissioni'],
  [/^STIPENDIO\b/i, 'Stipendio'],
];

/** Words kept in capitals: acronyms. */
const KEEP_UPPER = new Set(['IVA', 'ATM', 'POS', 'SDD', 'F24', 'IBAN', 'USA', 'UK', 'EU']);
/** Legal forms after the name, as they are usually written. */
const LEGAL_FORMS: Readonly<Record<string, string>> = { SRL: 'Srl', SRLS: 'Srls', SPA: 'SpA', SAS: 'Sas', SNC: 'Snc' };
/** Small words in lower case after the first. */
const KEEP_LOWER = new Set(['di', 'da', 'del', 'della', 'dei', 'delle', 'e', 'a', 'al', 'alla', 'in', 'per', 'con', 'su', 'the', 'of', 'and']);

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word, index) => {
      // Punctuation at the end ("SRL,") stays where it is.
      const core = word.replace(/[.,;:]+$/, '');
      const tail = word.slice(core.length);
      const upper = core.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper + tail;
      const legal = LEGAL_FORMS[upper];
      if (index > 0 && legal !== undefined) return legal + tail;
      const lower = core.toLowerCase();
      if (index > 0 && KEEP_LOWER.has(lower)) return lower + tail;
      // Words with digits or symbols (codes, cards, URLs) stay as they are.
      if (/[\d*@/]/.test(core)) return word;
      // A capital at the start and after an apostrophe: DELL'ORTO → Dell'Orto.
      return lower.replace(/(^|['’])(\p{L})/gu, (_match: string, before: string, letter: string) => before + letter.toUpperCase()) + tail;
    })
    .join(' ');
}

export interface ReadableDescription {
  /** The merchant or the counterpart, in normal case. */
  title: string;
  /** How it was paid and the card, or empty. */
  detail: string;
}

/**
 * A description of the bank as a title and a detail: `PAGAMENTO POS
 * SUPERMERCATO ALFA MILANO CARTA ****1234` → `Supermercato Alfa Milano` and
 * `Pagamento POS · carta ****1234`. Only shapes it, never drops a word that is
 * not a known payment kind or card; a text already in mixed case keeps it.
 */
export function readableDescription(text: string): ReadableDescription {
  let rest = text.trim().replace(/\s+/g, ' ');
  const details: string[] = [];
  for (const [pattern, name] of PAYMENT_KINDS) {
    const match = pattern.exec(rest);
    if (match !== null) {
      details.push(name);
      rest = rest.slice(match[0].length).trim();
      break;
    }
  }
  // The card, with its word or right after "PAGAMENTO CARTA" has taken it.
  const card = /(?:\b(?:CARTA|CARD)\s+)?(\*{2,}\s?\d{3,4}|\b\d{4}\*+\d{3,4})\b/i.exec(rest);
  if (card !== null) {
    details.push(`carta ${card[1] ?? ''}`);
    rest = `${rest.slice(0, card.index)} ${rest.slice(card.index + card[0].length)}`.trim().replace(/\s+/g, ' ');
  }
  // Separators left at the start by what was taken ("PAGAMENTO POS. BAR").
  rest = rest.replace(/^[\s.,:;·-]+/, '');
  const shouting = rest === rest.toUpperCase() && /\p{Lu}/u.test(rest);
  const title = rest === '' ? (details[0] ?? text.trim()) : shouting ? titleCase(rest) : rest;
  return { title, detail: rest === '' ? details.slice(1).join(' · ') : details.join(' · ') };
}

// ---------------------------------------------------------------------------
// Budgets

export interface BudgetRow {
  category: string;
  limit: number;
  spent: number;
  /** Rounded down, never above 100 for the bar; `over` says when it is past. */
  percent: number;
  over: boolean;
}

/** Each budget with what its category spent in the month (expenses, in cents). */
export function budgetRows(budgets: readonly Budget[], month: readonly CategoryTotal[]): BudgetRow[] {
  return budgets.map((budget) => {
    const spent = month.find((total) => total.category === budget.category)?.expenses ?? 0;
    const percent = budget.monthly <= 0 ? 0 : Math.floor((spent * 100) / budget.monthly);
    return { category: budget.category, limit: budget.monthly, spent, percent: Math.min(100, percent), over: spent > budget.monthly };
  });
}

export type BudgetChange = { category: string; monthly: number } | { category: string; monthly: null };

export interface BudgetDraft {
  changes: BudgetChange[];
  /** The categories whose text is not an amount above zero. */
  invalid: string[];
}

/**
 * What the single "Salva" of the budgets sends: a new or different amount
 * sets the budget, an emptied field removes it, an unchanged one is left out.
 * `parse` reads the text of a field as cents (parseEuroInput).
 */
export function budgetDraft(budgets: readonly Budget[], texts: Readonly<Record<string, string>>, parse: (text: string) => number | null): BudgetDraft {
  const changes: BudgetChange[] = [];
  const invalid: string[] = [];
  for (const [category, text] of Object.entries(texts)) {
    const saved = budgets.find((budget) => budget.category === category)?.monthly ?? null;
    if (text.trim() === '') {
      if (saved !== null) changes.push({ category, monthly: null });
      continue;
    }
    const cents = parse(text);
    if (cents === null || cents <= 0) {
      invalid.push(category);
      continue;
    }
    if (cents !== saved) changes.push({ category, monthly: cents });
  }
  return { changes, invalid };
}
