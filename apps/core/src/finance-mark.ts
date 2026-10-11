import { createContext, FINANCE_DERIVED_SOURCE, FINANCE_LABEL, type Context, type Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { isUuid } from './conversations.ts';

/**
 * The finance mark of the core (I-18, D-183): a conversation, task or run
 * that has read finance data is marked in the database (migration 0056: the
 * column never goes back to false), and every context the core makes again
 * from it carries the mark, so that the gateway sends nothing of it to the
 * cloud (rule finance) and nothing of it is declassified.
 */
export interface Marked {
  clearance: Label;
  /** The `finance` column of the conversation or task. */
  finance: boolean;
}

/**
 * The context of a conversation or task that has read `effective`: marked
 * when the row is, and then at L2 (finance data is L2, whatever was read
 * besides). Dropping the mark here would be the bug the mark exists against.
 */
export function contextOf(row: Marked, effective: Label): Context {
  return row.finance ? createContext(row.clearance, FINANCE_LABEL, { finance: true }) : createContext(row.clearance, effective);
}

/**
 * The source of what a model or tool wrote for a marked row: `finance:derived`
 * (deriveSource of the policy), so that the mark follows the text; `source`
 * otherwise.
 */
export function outputSource(row: Pick<Marked, 'finance'>, source: string): string {
  return row.finance ? FINANCE_DERIVED_SOURCE : source;
}

/**
 * Saves the mark on a task that has read finance data: it has read L2 too.
 * Its conversation is marked by the database (tasks_finance_to_conversation).
 * Refused by the database for a task not cleared for L2.
 */
export async function markTask(sql: Queryable, taskId: string): Promise<void> {
  await sql`UPDATE tasks SET finance = true, effective_label = ${FINANCE_LABEL}::privacy_label, updated_at = now() WHERE id = ${taskId} AND NOT finance`;
}

/**
 * The conversation is marked (I-18, D-183): nothing of it is saved in kb/,
 * whole or a message at a time, nor found by the search.
 */
export async function isFinanceConversation(sql: Queryable, conversationId: string): Promise<boolean> {
  if (!isUuid(conversationId)) return false;
  const [row] = await sql<{ finance: boolean }[]>`SELECT finance FROM conversations WHERE id = ${conversationId}`;
  return row?.finance === true;
}
