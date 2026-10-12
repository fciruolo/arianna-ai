import { calendarText, invoiceAmount, type ImOverview, type Money } from './im-billing.ts';
import { imDayText } from './im.ts';
import { nextIm, overdueInvoices, paidInYear } from './projects-page.ts';
import type { BrowsableContainer } from './projects.ts';

/**
 * The list of the projects as cards (D-191, after the user's trial), as the
 * clients (D-190): on each card the client, the parts, the calendar and the
 * next IM, three numbers read from the IM of the project. Pure helpers.
 * Prices and invoices stay Privati (L2) between the page and the core.
 */

export interface ProjectCardMoney {
  /** The currency of the project's price, for a number with nothing in it. */
  currency: string;
  toInvoice: Money[];
  /** Invoiced and not paid yet, with how many invoices are past due. */
  awaiting: Money[];
  overdue: number;
  paid: Money[];
}

/** What a card shows of its IM: the calendar, the next IM and the three numbers. */
export interface ProjectCardIm {
  calendar: string | null;
  next: string | null;
  /** null: the project has no IM and no invoice yet. */
  money: ProjectCardMoney | null;
}

function sumByCurrency(items: readonly Money[]): Money[] {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.cents);
  return [...sums.entries()].map(([currency, cents]) => ({ currency, cents }));
}

/** The card's part of the IM overview of a project, on `today` (`YYYY-MM-DD`) and in `year`. */
export function projectCardIm(overview: ImOverview, today: string, year: number): ProjectCardIm {
  const calendar = overview.calendar.calendar;
  const next = nextIm(overview.ims);
  const empty = overview.ims.length === 0 && overview.invoices.length === 0;
  const open = overview.invoices.filter((invoice) => invoice.paidOn === null);
  return {
    calendar: calendar === null ? null : `IM ${calendarText(calendar)}`,
    next: next === null ? null : `IM-${String(next.number)} · ${imDayText(next.date)}`,
    money: empty
      ? null
      : {
          currency: overview.price?.currency ?? overview.ims[0]?.currency ?? overview.invoices[0]?.currency ?? 'EUR',
          toInvoice: sumByCurrency(overview.totals.toInvoice),
          awaiting: sumByCurrency(open.map((invoice) => ({ currency: invoice.currency, cents: invoiceAmount(invoice) }))),
          overdue: overdueInvoices(overview.invoices, today).length,
          paid: paidInYear(overview.invoices, year),
        },
  };
}

/** "1.200 €", "1.200 € · 300 $"; "0 €" in the project's currency when there is nothing. */
export function cardMoneyText(list: readonly Money[], currency: string): string {
  const symbol: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
  const one = (cents: number, code: string): string => {
    const whole = Math.round(cents / 100);
    return `${whole < 0 ? '−' : ''}${String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ${symbol[code] ?? code}`;
  };
  const shown = list.filter((item) => item.cents !== 0);
  return shown.length === 0 ? one(0, currency) : shown.map((item) => one(item.cents, item.currency)).join(' · ');
}

/** "1 scaduta", "2 scadute". */
export function overdueShortText(count: number): string {
  return count === 1 ? '1 scaduta' : `${String(count)} scadute`;
}

/** "2 parti", "1 parte", "nessuna parte con git"; null for a project that is one git. */
export function partsText(container: Pick<BrowsableContainer, 'single' | 'parts'>): string | null {
  if (container.single) return null;
  return container.parts.length === 0 ? 'nessuna parte con git' : container.parts.length === 1 ? '1 parte' : `${String(container.parts.length)} parti`;
}

/** The letters on a card without the client's logo: "progetto-test" → "PT". */
export function projectInitials(name: string): string {
  const parts = name.split(/[-_ .:]+/).filter((part) => part !== '');
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

/**
 * The cards in order: the projects with invoices past due first, then by
 * name; a project whose numbers are not read yet counts as none past due.
 */
export function sortProjectCards<T extends Pick<BrowsableContainer, 'name'>>(containers: readonly T[], overdue: ReadonlyMap<string, number>): T[] {
  return [...containers].sort((a, b) => {
    const late = Number((overdue.get(b.name) ?? 0) > 0) - Number((overdue.get(a.name) ?? 0) > 0);
    return late !== 0 ? late : a.name.localeCompare(b.name, 'it', { sensitivity: 'base' });
  });
}
