import { FINANCE_LABEL, recordFinanceRead, type Context, type Label } from '@arianna/policy';
import type { FinanceAlert } from '@arianna/finance';

import type { Queryable } from './db/client.ts';
import { alerts, listCategories, listTransactions, summary, type Category } from './finance.ts';
import { dayParam, euro, FinanceError, lastDayOf, monthParam } from './finance-format.ts';
import { markTask } from './finance-mark.ts';

/**
 * The read-only tools of the agent «Finanze» (I-18, D-183, F4): the core
 * computes every figure from the database with @arianna/finance, and the
 * model reads it as the result of the call, so that it never has to invent
 * one. Each read marks the task (and through it its conversation) for good:
 * the result is finance data, L2, and nothing of the task goes to the cloud.
 */
export type FinanceToolId = 'finance.summary' | 'finance.search' | 'finance.alerts';

export interface FinanceToolEnv {
  sql: Queryable;
  taskId: string;
  context: Context;
  now?: Date;
}

export interface FinanceToolResult {
  text: string;
  label: Label;
}

/** Movements shown by one search when the model asks for no number. */
const DEFAULT_SEARCH = 20;
const MAX_SEARCH = 50;
const MAX_DESCRIPTION = 120;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export async function runFinanceTool(tool: FinanceToolId, args: Record<string, unknown>, env: FinanceToolEnv): Promise<FinanceToolResult> {
  // Finance data is read only where L2 may be read; the read marks the context (recordFinanceRead).
  const read = recordFinanceRead(env.context);
  if (!read.allowed) return { text: `error: ${tool}: finance data is read only in a private conversation`, label: 'L0' };
  await markTask(env.sql, env.taskId);
  try {
    switch (tool) {
      case 'finance.summary':
        return { text: await summaryText(env, args), label: FINANCE_LABEL };
      case 'finance.search':
        return { text: await searchText(env, args), label: FINANCE_LABEL };
      case 'finance.alerts':
        return { text: await alertsText(env, args), label: FINANCE_LABEL };
    }
  } catch (error) {
    if (error instanceof FinanceError) return { text: `error: ${tool}: ${error.message}`, label: FINANCE_LABEL };
    throw error;
  }
}

function namesOf(categories: readonly Category[]): Map<string, string> {
  return new Map(categories.map((category) => [category.id, category.name]));
}

async function summaryText(env: FinanceToolEnv, args: Record<string, unknown>): Promise<string> {
  const fromMonth = monthParam(text(args.from), 'from');
  const toMonth = monthParam(text(args.to), 'to');
  const from = fromMonth === undefined ? undefined : `${fromMonth}-01`;
  const to = toMonth === undefined ? undefined : lastDayOf(toMonth);
  const result = await summary(env.sql, { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }, env.now);
  const names = namesOf(await listCategories(env.sql));
  const first = result.months[0]?.month ?? '';
  const last = result.months.at(-1)?.month ?? '';
  const income = result.months.reduce((sum, month) => sum + month.income, 0);
  const expenses = result.months.reduce((sum, month) => sum + month.expenses, 0);
  const count = result.months.reduce((sum, month) => sum + month.count, 0);
  if (count === 0) return `Nessun movimento dal ${first} al ${last}, in tutti i conti.`;
  const lines = [
    `Periodo ${first} – ${last}, tutti i conti: entrate ${euro(income)}, uscite ${euro(expenses)}, netto ${euro(income - expenses)} (${String(count)} movimenti).`,
    'Per mese:',
    ...result.months.map((month) => `- ${month.month}: entrate ${euro(month.income)}, uscite ${euro(month.expenses)}, netto ${euro(month.net)} (${String(month.count)} movimenti)`),
    'Per categoria, dalla più costosa:',
    ...result.categories.map(
      (total) =>
        `- ${total.category === null ? 'Senza categoria' : (names.get(total.category) ?? 'Categoria tolta')}: uscite ${euro(total.expenses)}, entrate ${euro(total.income)} (${String(total.count)} movimenti)`,
    ),
  ];
  const yoy = result.yearOverYear;
  if (yoy !== null) {
    lines.push(
      `${yoy.current.month} contro ${yoy.previous.month}: uscite ${euro(yoy.current.expenses)} contro ${euro(yoy.previous.expenses)} (differenza ${euro(yoy.expensesChange)}), entrate ${euro(yoy.current.income)} contro ${euro(yoy.previous.income)}.`,
    );
  }
  return lines.join('\n');
}

async function searchText(env: FinanceToolEnv, args: Record<string, unknown>): Promise<string> {
  const categories = await listCategories(env.sql);
  const asked = text(args.category);
  let category: string | undefined;
  if (asked !== null) {
    const found = categories.find((item) => item.name.toLowerCase() === asked.toLowerCase());
    if (found === undefined) {
      throw new FinanceError('invalid', 400, `no category is named so; the categories are: ${categories.map((item) => item.name).join(', ')}`);
    }
    category = found.id;
  }
  const from = dayParam(text(args.from), 'from', 'from');
  const to = dayParam(text(args.to), 'to', 'to');
  const q = text(args.text);
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), MAX_SEARCH) : DEFAULT_SEARCH;
  const found = await listTransactions(env.sql, {
    ...(category === undefined ? {} : { category }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(q === null ? {} : { q }),
    limit,
  });
  if (found.total === 0) return 'Nessun movimento trovato.';
  const names = namesOf(categories);
  const total = found.transactions.reduce((sum, row) => sum + row.amount, 0);
  const shown = found.transactions.length;
  return [
    `${String(found.total)} movimenti trovati${shown < found.total ? `, mostrati i ${String(shown)} più recenti` : ''}; somma dei mostrati ${euro(total)}.`,
    ...found.transactions.map((row) => {
      const description = Array.from(row.description).length > MAX_DESCRIPTION ? `${Array.from(row.description).slice(0, MAX_DESCRIPTION - 1).join('')}…` : row.description;
      const name = row.category === null ? 'senza categoria' : (names.get(row.category) ?? 'senza categoria');
      return `- ${row.booked} · ${euro(row.amount, row.currency)} · ${name} · ${description}`;
    }),
  ].join('\n');
}

function alertLine(alert: FinanceAlert, names: ReadonlyMap<string, string>): string {
  switch (alert.kind) {
    case 'duplicate':
      return `- Possibile doppio addebito: ${alert.merchant}, ${String(alert.fingerprints.length)} volte ${euro(alert.amount)} fra il ${alert.firstDay} e il ${alert.lastDay}.`;
    case 'budget':
      return `- Budget ${alert.state === 'over' ? 'superato' : 'quasi esaurito'}: ${names.get(alert.category) ?? 'categoria tolta'}, spesi ${euro(alert.spent)} su ${euro(alert.limit)} (${String(alert.percent)}%) nel ${alert.month}.`;
    case 'unusual':
      return `- Spesa insolita: ${alert.merchant}, ${euro(alert.amount)}, contro una mediana di ${euro(alert.median)} ${alert.basis === 'merchant' ? 'allo stesso esercente' : 'nella stessa categoria'}.`;
    case 'recurring':
      return `- Addebito ricorrente cambiato: ${alert.merchant}, ora ${euro(alert.lastAmount)} invece di ${euro(alert.amount)} (${alert.cadence === 'monthly' ? 'mensile' : alert.cadence === 'weekly' ? 'settimanale' : 'annuale'}, ultimo il ${alert.lastDay}).`;
  }
}

async function alertsText(env: FinanceToolEnv, args: Record<string, unknown>): Promise<string> {
  const month = monthParam(text(args.month), 'month');
  const found = await alerts(env.sql, month, env.now);
  const names = namesOf(await listCategories(env.sql));
  const asked = month ?? 'questo mese';
  if (found.length === 0) return `Nessun avviso per ${asked}.`;
  return [`${String(found.length)} avvisi per ${asked}:`, ...found.map((alert) => alertLine(alert, names))].join('\n');
}
