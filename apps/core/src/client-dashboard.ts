import type { Project } from '@arianna/config';

import { readClient } from './clients.ts';
import type { Queryable } from './db/client.ts';
import { readImMoney, type ImBillingRow, type ImInvoice, type ImPrice } from './im-billing.ts';
import type { KnowledgeEnv } from './project-knowledge.ts';

/**
 * The dashboard of a client (I-16 tappa C3, D-170): what the client brought
 * in, from the IM of its projects (D-169), computed by the code, never by a
 * model. Two views of the same money:
 * - competenza: each closed IM in the month of its meeting; an IM in an
 *   invoice is worth its share of the total of the document, split among the
 *   IM of the invoice in proportion to their taxable amount (the cents left
 *   over go to the last one), so the shares always add up to the invoice; an
 *   IM still to invoice is worth its taxable amount;
 * - cassa: each paid invoice, whole, in the month of its payment.
 * An invoice registered before D-170 has no total of the document: its
 * taxable amount counts instead, and the invoice says so.
 * Everything is private (L2): read by the local web chat only.
 */

export type MoneyKind = 'toInvoice' | 'invoiced' | 'paid';

/** Competenza: the money of one project in one month and currency. */
export interface MonthBucket {
  /** `YYYY-MM`. */
  month: string;
  project: string;
  currency: string;
  toInvoice: number;
  invoiced: number;
  paid: number;
  /** IM closed in the month (not billed and without a price too). */
  closed: number;
}

/** Cassa: the paid invoices of one project in one month and currency. */
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
  price: ImPrice | null;
  closed: number;
  notBilled: DashboardIm[];
  noPrice: DashboardIm[];
  toInvoice: DashboardIm[];
  /** The first IM not closed yet. */
  next: { number: number; date: string | null } | null;
}

export interface DashboardInvoice extends ImInvoice {
  project: string;
  /** Not paid and past its due date. */
  overdue: boolean;
}

export interface ClientDashboard {
  /** The currency of the client: the one the totals are shown in. */
  currency: string;
  today: string;
  projects: DashboardProject[];
  /** Projects of the client that are not among the approved containers now. */
  missing: string[];
  months: MonthBucket[];
  cash: CashBucket[];
  invoices: DashboardInvoice[];
}

export interface ProjectMoney {
  name: string;
  price: ImPrice | null;
  ims: readonly ImBillingRow[];
  invoices: readonly ImInvoice[];
}

/**
 * The total of the document split among weights (the taxable amounts of the
 * IM): floor of each share, the cents left over to the last; equal parts
 * when the weights are all zero.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  // BigInt: cents times cents goes past the safe integers of a number.
  const shares = weights.map((weight) => (sum === 0 ? Math.floor(total / weights.length) : Number((BigInt(total) * BigInt(weight)) / BigInt(sum))));
  const rest = total - shares.reduce((acc, share) => acc + share, 0);
  shares[shares.length - 1] = (shares.at(-1) ?? 0) + rest;
  return shares;
}

const monthOf = (day: string | null): string | null => (day !== null && /^\d{4}-\d{2}/.test(day) ? day.slice(0, 7) : null);

const imOf = (row: ImBillingRow): DashboardIm => ({ number: row.number, date: row.date, cents: row.amountCents, currency: row.currency });

/** The dashboard from the money of each project of the client; pure. */
export function buildDashboard(currency: string, today: string, money: readonly ProjectMoney[], missing: readonly string[] = []): ClientDashboard {
  const months = new Map<string, MonthBucket>();
  const bucket = (month: string, project: string, coin: string): MonthBucket => {
    const key = `${month}|${project}|${coin}`;
    let found = months.get(key);
    if (found === undefined) {
      found = { month, project, currency: coin, toInvoice: 0, invoiced: 0, paid: 0, closed: 0 };
      months.set(key, found);
    }
    return found;
  };
  const cash = new Map<string, CashBucket>();
  const invoices: DashboardInvoice[] = [];
  const projects: DashboardProject[] = [];

  for (const project of money) {
    const closed = project.ims.filter((row) => row.status === 'chiuso');
    for (const row of closed) {
      const month = monthOf(row.date);
      if (month !== null) bucket(month, project.name, row.currency).closed += 1;
    }
    for (const row of closed.filter((item) => item.state === 'to-invoice')) {
      const month = monthOf(row.date);
      if (month !== null) bucket(month, project.name, row.currency).toInvoice += row.amountCents ?? 0;
    }
    const rows = new Map(project.ims.map((row) => [row.number, row]));
    for (const invoice of project.invoices) {
      const kind: MoneyKind = invoice.paidOn === null ? 'invoiced' : 'paid';
      const document = invoice.documentCents ?? invoice.totalCents;
      // The IM of the invoice still in a file; one renamed or gone keeps its money, in the month of the invoice.
      const found = invoice.ims.map((number) => rows.get(number)).filter((row): row is ImBillingRow => row !== undefined && monthOf(row.date) !== null);
      const foundTaxable = found.reduce((acc, row) => acc + (row.amountCents ?? 0), 0);
      const lost = invoice.ims.length - found.length;
      const lostShare = lost === 0 ? 0 : invoice.totalCents === 0 ? Math.round((document * lost) / invoice.ims.length) : Number((BigInt(document) * BigInt(Math.max(0, invoice.totalCents - foundTaxable))) / BigInt(invoice.totalCents));
      const shares = apportion(document - lostShare, found.map((row) => row.amountCents ?? 0));
      found.forEach((row, index) => {
        bucket(monthOf(row.date) ?? '', project.name, invoice.currency)[kind] += shares[index] ?? 0;
      });
      const issued = monthOf(invoice.issuedOn);
      if (found.length === 0 && issued !== null) bucket(issued, project.name, invoice.currency)[kind] += document;
      else if (lostShare !== 0 && issued !== null) bucket(issued, project.name, invoice.currency)[kind] += lostShare;
      const paid = monthOf(invoice.paidOn);
      if (paid !== null) {
        const key = `${paid}|${project.name}|${invoice.currency}`;
        const item = cash.get(key) ?? { month: paid, project: project.name, currency: invoice.currency, cents: 0, invoices: 0 };
        item.cents += document;
        item.invoices += 1;
        cash.set(key, item);
      }
      invoices.push({ ...invoice, project: project.name, overdue: invoice.paidOn === null && invoice.due !== null && invoice.due < today });
    }
    const next = project.ims.find((row) => row.status !== 'chiuso');
    projects.push({
      name: project.name,
      price: project.price,
      closed: closed.length,
      notBilled: closed.filter((row) => row.state === 'not-billed').map(imOf),
      noPrice: closed.filter((row) => row.state === 'no-price').map(imOf),
      toInvoice: closed.filter((row) => row.state === 'to-invoice').map(imOf),
      next: next === undefined ? null : { number: next.number, date: next.date },
    });
  }

  const byMonth = (a: { month: string; project: string }, b: { month: string; project: string }): number => a.month.localeCompare(b.month) || a.project.localeCompare(b.project);
  invoices.sort((a, b) => b.issuedOn.localeCompare(a.issuedOn) || b.createdAt.localeCompare(a.createdAt));
  return { currency, today, projects, missing: [...missing], months: [...months.values()].sort(byMonth), cash: [...cash.values()].sort(byMonth), invoices };
}

/** Today on this computer, `YYYY-MM-DD`. */
export function localDay(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The dashboard of the client `id`: its projects among the approved containers, their IM and invoices. */
export async function readClientDashboard(sql: Queryable, containers: readonly Project[], env: KnowledgeEnv, id: string): Promise<ClientDashboard> {
  const client = await readClient(sql, id);
  const known = new Set(containers.map((project) => project.name));
  const money: ProjectMoney[] = [];
  const missing: string[] = [];
  for (const { project } of client.projects) {
    if (!known.has(project)) {
      missing.push(project);
      continue;
    }
    money.push({ name: project, ...(await readImMoney(sql, containers, env, project)) });
  }
  return buildDashboard(client.currency, localDay(), money, missing);
}
