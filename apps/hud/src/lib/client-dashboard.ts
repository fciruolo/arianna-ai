import { invoiceAmount, type ImInvoice } from './im-billing.ts';

/**
 * The dashboard of a client (I-16 tappa C3, D-170). The core splits the
 * total of the document of each invoice on the months of its IM and groups
 * the money by month, project and currency (`apps/core/src/client-dashboard.ts`);
 * here only sums of those groups, for the year, the project and the view
 * chosen: competenza (the month of the IM) or cassa (the month of the
 * payment). The totals are in the currency of the client; money in other
 * currencies is counted apart and named. Private (L2): it stays on this
 * computer.
 */

export interface MonthBucket {
  month: string;
  project: string;
  currency: string;
  toInvoice: number;
  invoiced: number;
  paid: number;
  closed: number;
}

export interface CashBucket {
  month: string;
  project: string;
  currency: string;
  cents: number;
  invoices: number;
}

export interface DashboardIm {
  number: number;
  date: string | null;
  cents: number | null;
  currency: string;
}

export interface DashboardProject {
  name: string;
  price: { amountCents: number | null; currency: string } | null;
  closed: number;
  notBilled: DashboardIm[];
  noPrice: DashboardIm[];
  toInvoice: DashboardIm[];
  next: { number: number; date: string | null } | null;
}

export interface DashboardInvoice extends ImInvoice {
  project: string;
  overdue: boolean;
}

export interface ClientDashboard {
  currency: string;
  today: string;
  projects: DashboardProject[];
  missing: string[];
  months: MonthBucket[];
  cash: CashBucket[];
  invoices: DashboardInvoice[];
}

export type Basis = 'accrual' | 'cash';
/** A year, or every year. */
export type YearChoice = number | 'all';

export interface DashboardFilter {
  year: YearChoice;
  /** A project of the client, or `all` for all of them. */
  project: string;
  basis: Basis;
}

/** One bar of the chart: competenza stacks the three kinds, cassa has only the paid. */
export interface ChartBar {
  /** `YYYY-MM`, or `YYYY` when the chart shows every year. */
  key: string;
  label: string;
  paid: number;
  invoiced: number;
  toInvoice: number;
}

export interface DashboardSummary {
  /** Competenza: the money of the IM closed in the period; cassa: what came in. */
  earned: number;
  closed: number;
  /** The same for the year before, when one year is chosen. */
  previous: number | null;
  toInvoice: { cents: number; ims: { project: string; number: number; date: string | null }[] };
  awaiting: { cents: number; invoices: number; overdue: number; firstDue: string | null };
  collected: { cents: number; lastPaid: string | null };
  chart: ChartBar[];
  projects: { name: string; cents: number; closed: number }[];
  years: { year: number; closed: number; cents: number }[];
  /** Money of the period in a currency other than the client's, by currency. */
  others: { currency: string; cents: number }[];
  /** To invoice and waiting today in another currency: out of the boxes, named apart. */
  othersWaiting: { currency: string; cents: number }[];
}

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'] as const;

/** The years with any money or closed IM, the most recent first; this year always. */
export function dashboardYears(dashboard: Pick<ClientDashboard, 'months' | 'cash' | 'today'>): number[] {
  const years = new Set<number>([Number(dashboard.today.slice(0, 4))]);
  for (const item of [...dashboard.months, ...dashboard.cash]) years.add(Number(item.month.slice(0, 4)));
  return [...years].filter((year) => Number.isInteger(year) && year > 0).sort((a, b) => b - a);
}

const inYear = (month: string, year: YearChoice): boolean => year === 'all' || month.startsWith(`${String(year)}-`);
const inProject = (project: string, filter: DashboardFilter): boolean => filter.project === 'all' || project === filter.project;
const monthTotal = (item: MonthBucket): number => item.toInvoice + item.invoiced + item.paid;

function addTo(list: { currency: string; cents: number }[], currency: string, cents: number): void {
  if (cents === 0) return;
  const found = list.find((item) => item.currency === currency);
  if (found === undefined) list.push({ currency, cents });
  else found.cents += cents;
}

/** Every sum the page shows, for the filter chosen. */
export function summarize(dashboard: ClientDashboard, filter: DashboardFilter): DashboardSummary {
  const own = (currency: string): boolean => currency === dashboard.currency;
  const months = dashboard.months.filter((item) => inProject(item.project, filter));
  const cash = dashboard.cash.filter((item) => inProject(item.project, filter));
  const others: { currency: string; cents: number }[] = [];

  const earnedIn = (year: YearChoice): number =>
    filter.basis === 'accrual'
      ? months.filter((item) => own(item.currency) && inYear(item.month, year)).reduce((sum, item) => sum + monthTotal(item), 0)
      : cash.filter((item) => own(item.currency) && inYear(item.month, year)).reduce((sum, item) => sum + item.cents, 0);
  if (filter.basis === 'accrual') for (const item of months) if (!own(item.currency) && inYear(item.month, filter.year)) addTo(others, item.currency, monthTotal(item));
  if (filter.basis === 'cash') for (const item of cash) if (!own(item.currency) && inYear(item.month, filter.year)) addTo(others, item.currency, item.cents);

  const closed = months.filter((item) => inYear(item.month, filter.year)).reduce((sum, item) => sum + item.closed, 0);

  // What is waiting is a state of today, not of the year chosen.
  const projects = dashboard.projects.filter((project) => inProject(project.name, filter));
  const toInvoice = projects.flatMap((project) => project.toInvoice.filter((im) => own(im.currency)).map((im) => ({ project: project.name, number: im.number, date: im.date, cents: im.cents ?? 0 })));
  const invoices = dashboard.invoices.filter((invoice) => inProject(invoice.project, filter) && own(invoice.currency));
  const unpaid = invoices.filter((invoice) => invoice.paidOn === null);
  const dues = unpaid.map((invoice) => invoice.due).filter((due): due is string => due !== null).sort();
  const paidInYear = invoices.filter((invoice) => invoice.paidOn !== null && inYear(invoice.paidOn, filter.year));

  const othersWaiting: { currency: string; cents: number }[] = [];
  for (const project of projects) for (const im of project.toInvoice) if (!own(im.currency)) addTo(othersWaiting, im.currency, im.cents ?? 0);
  for (const invoice of dashboard.invoices) if (inProject(invoice.project, filter) && !own(invoice.currency) && invoice.paidOn === null) addTo(othersWaiting, invoice.currency, invoiceAmount(invoice));

  const chart: ChartBar[] = [];
  if (filter.year === 'all') {
    for (const year of dashboardYears(dashboard).reverse()) chart.push(barOf(String(year), String(year), months, cash, filter.basis, own));
  } else {
    for (let index = 0; index < 12; index += 1) {
      const key = `${String(filter.year)}-${String(index + 1).padStart(2, '0')}`;
      chart.push(barOf(key, MONTHS[index] ?? key, months, cash, filter.basis, own));
    }
  }

  const byProject = dashboard.projects
    .filter((project) => inProject(project.name, filter))
    .map((project) => ({
      name: project.name,
      cents:
        filter.basis === 'accrual'
          ? months.filter((item) => item.project === project.name && own(item.currency) && inYear(item.month, filter.year)).reduce((sum, item) => sum + monthTotal(item), 0)
          : cash.filter((item) => item.project === project.name && own(item.currency) && inYear(item.month, filter.year)).reduce((sum, item) => sum + item.cents, 0),
      closed: months.filter((item) => item.project === project.name && inYear(item.month, filter.year)).reduce((sum, item) => sum + item.closed, 0),
    }));

  const years = dashboardYears(dashboard).map((year) => ({
    year,
    closed: months.filter((item) => inYear(item.month, year)).reduce((sum, item) => sum + item.closed, 0),
    cents: earnedIn(year),
  }));

  return {
    earned: earnedIn(filter.year),
    closed,
    previous: filter.year === 'all' ? null : earnedIn(filter.year - 1),
    toInvoice: { cents: toInvoice.reduce((sum, im) => sum + im.cents, 0), ims: toInvoice.map(({ project, number, date }) => ({ project, number, date })) },
    awaiting: { cents: unpaid.reduce((sum, invoice) => sum + invoiceAmount(invoice), 0), invoices: unpaid.length, overdue: unpaid.filter((invoice) => invoice.overdue).length, firstDue: dues[0] ?? null },
    collected: { cents: paidInYear.reduce((sum, invoice) => sum + invoiceAmount(invoice), 0), lastPaid: paidInYear.map((invoice) => invoice.paidOn ?? '').sort().at(-1) ?? null },
    chart,
    projects: byProject,
    years: years.filter((item) => item.closed > 0 || item.cents > 0),
    others,
    othersWaiting,
  };
}

function barOf(key: string, label: string, months: readonly MonthBucket[], cash: readonly CashBucket[], basis: Basis, own: (currency: string) => boolean): ChartBar {
  const match = (month: string): boolean => month === key || month.startsWith(`${key}-`);
  if (basis === 'cash') return { key, label, paid: cash.filter((item) => own(item.currency) && match(item.month)).reduce((sum, item) => sum + item.cents, 0), invoiced: 0, toInvoice: 0 };
  const items = months.filter((item) => own(item.currency) && match(item.month));
  return {
    key,
    label,
    paid: items.reduce((sum, item) => sum + item.paid, 0),
    invoiced: items.reduce((sum, item) => sum + item.invoiced, 0),
    toInvoice: items.reduce((sum, item) => sum + item.toInvoice, 0),
  };
}

/** The top of the scale of the chart: a round number over the highest bar. */
export function chartScale(bars: readonly ChartBar[]): number {
  const top = Math.max(0, ...bars.map((bar) => bar.paid + bar.invoiced + bar.toInvoice));
  if (top === 0) return 100_000;
  const step = 10 ** Math.floor(Math.log10(top));
  return Math.ceil(top / step) * step;
}

/** Whole euros for the KPI and the axis: 2115000 cents → "21.150 €". */
export function roundMoneyText(cents: number, currency: string): string {
  const whole = Math.round(cents / 100);
  const grouped = String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const symbol: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
  return `${whole < 0 ? '−' : ''}${grouped} ${symbol[currency] ?? currency}`;
}
