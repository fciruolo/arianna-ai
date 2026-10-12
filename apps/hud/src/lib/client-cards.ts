import type { DashboardSummary } from './client-dashboard.ts';
import type { ClientSummary } from './clients.ts';

/**
 * The list of the clients as cards (D-190): three numbers of the year on each
 * card, from the same dashboard of the client (summarize of client-dashboard.ts,
 * this year, every project, competenza), and the order of the cards. Private
 * (L2): everything stays on this computer.
 */

export interface CardMoney {
  currency: string;
  /** Money of the IM closed this year. */
  earned: number;
  closed: number;
  toInvoice: number;
  /** Invoiced and not paid yet, with how many invoices are past due. */
  awaiting: number;
  overdue: number;
}

/** The numbers of a card from the summary of its dashboard. */
export function cardMoney(summary: DashboardSummary, currency: string): CardMoney {
  return {
    currency,
    earned: summary.earned,
    closed: summary.closed,
    toInvoice: summary.toInvoice.cents,
    awaiting: summary.awaiting.cents,
    overdue: summary.awaiting.overdue,
  };
}

export type CardOrder = 'due' | 'name' | 'earned' | 'updated';

export const CARD_ORDER_TEXT: Readonly<Record<CardOrder, string>> = {
  due: 'Da incassare',
  name: 'Nome',
  earned: 'Guadagno',
  updated: 'Ultima modifica',
};

const byName = (a: ClientSummary, b: ClientSummary): number => a.displayName.localeCompare(b.displayName, 'it', { sensitivity: 'base' });

/**
 * The cards in the order chosen. "Da incassare": past due first, then the
 * most awaited and to invoice; "Guadagno": the most earned this year. A client
 * whose numbers are not read yet goes after the others; ties by name.
 */
export function sortCards(clients: readonly ClientSummary[], order: CardOrder, money: ReadonlyMap<string, CardMoney>): ClientSummary[] {
  const list = [...clients];
  if (order === 'name') return list.sort(byName);
  if (order === 'updated') return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || byName(a, b));
  const key = (client: ClientSummary): number[] | null => {
    const found = money.get(client.id);
    if (found === undefined) return null;
    return order === 'earned' ? [found.earned] : [found.overdue > 0 ? 1 : 0, found.awaiting + found.toInvoice];
  };
  return list.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === null || right === null) return left === right ? byName(a, b) : left === null ? 1 : -1;
    for (let at = 0; at < left.length; at += 1) {
      const diff = (right[at] ?? 0) - (left[at] ?? 0);
      if (diff !== 0) return diff;
    }
    return byName(a, b);
  });
}
