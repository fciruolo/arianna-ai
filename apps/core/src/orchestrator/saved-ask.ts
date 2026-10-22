import type { Queryable } from '../db/client.ts';
import { isSavedKind, savedEntry, type SavedKind } from '../saved-private.ts';

/**
 * The card «Apri / No» of a saved private value (D-283): the agent's browser
 * (browser.open, the click that opens a page, browser.type) or web.fetch
 * would let out a value the user saved for a client or a contact. Nothing
 * leaves before «Apri»; with «Apri» those values (the values themselves: a
 * field of the client changed since asks again) hold for the browser of the
 * conversation until it closes, and for web.fetch for SAVED_WINDOW_MS in the
 * conversation (also, while the browser is open, for as long as it is). The
 * approval: kind `browser`, action `browser.private`, label L2 (it names the
 * client), detail with the references, the kind of each value, the name of
 * its client and the site it would go to, never a value. Its event carries
 * the action only. Which value each reference had when the card was asked is
 * kept here, in memory, as a hash (`asked`): never in the database; after a
 * restart of the core an «Apri» of before holds no more, and the card comes
 * back.
 */

export const SAVED_ACTION = 'browser.private';
/** How long an «Apri» holds for web.fetch without a browser of the conversation. */
export const SAVED_WINDOW_MS = 15 * 60_000;
/** References on one card at most: an address with more is asked about by its first ones. */
export const MAX_SAVED_REFS = 20;

/** The result of a step while the user decides: replaced, in what the model reads, by the decision. */
export const WAITING_PRIVATE = 'waiting for the user to decide in the chat whether saved private data may leave';

/** One value of the card: its reference, its kind and its client; never the value. */
export interface SavedAskValue {
  ref: string;
  kind: SavedKind;
  client: string;
}

/** What the card names of each reference: from the saved values as they are now; a reference gone keeps its kind. */
export function savedAskValues(refs: readonly string[]): SavedAskValue[] {
  return [...new Set(refs)].slice(0, MAX_SAVED_REFS).map((ref) => {
    const entry = savedEntry(ref);
    const tail = ref.split(':').at(-1);
    const kind: SavedKind = entry?.kind ?? (isSavedKind(tail) ? tail : 'name');
    return { ref, kind, client: entry?.client ?? '' };
  });
}

/** Cards whose values are remembered at most; the oldest go (their «Apri» then asks again). */
const MAX_ASKED = 500;
/** Approval id → reference → hash of the value it had when the card was asked. In memory only. */
const asked = new Map<string, Map<string, string>>();

/** Remembers the values of a card as they are now (the core, and tests without a database). */
export function rememberAsked(approvalId: string, refs: readonly string[]): void {
  const hashes = new Map<string, string>();
  for (const ref of refs) {
    const hash = savedEntry(ref)?.hash;
    if (hash !== undefined) hashes.set(ref, hash);
  }
  asked.delete(approvalId);
  asked.set(approvalId, hashes);
  while (asked.size > MAX_ASKED) asked.delete(asked.keys().next().value ?? '');
}

/** The card, written with the turn in the transaction of the step. `site`: where the value would go, the name of a site only. */
export async function requestSavedPrivate(
  tx: Queryable,
  options: { taskId: string; step: number; tool: string; refs: readonly string[]; browser?: number | null; site?: string | null },
): Promise<string> {
  const values = savedAskValues(options.refs);
  if (values.length === 0) throw new Error('a card of saved values needs at least one reference');
  const site = typeof options.site === 'string' && options.site.trim() !== '' ? options.site.trim().slice(0, 253) : undefined;
  const detail = {
    values: values.map((value) => ({ ref: value.ref, kind: value.kind, client: value.client })),
    tool: options.tool,
    step: options.step,
    ...(options.browser == null ? {} : { browser: options.browser }),
    ...(site === undefined ? {} : { site }),
  };
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'browser', ${SAVED_ACTION}, ${tx.json(detail)}, 'L2'::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('the approval of the saved values was not written');
  rememberAsked(row.id, values.map((value) => value.ref));
  return row.id;
}

/** Steps of the task whose card of saved values the user approved: the same web.fetch may run again after them, never after a «No». */
export async function approvedPrivateSteps(sql: Queryable, taskId: string): Promise<Set<number>> {
  const rows = await sql<{ step: number | null }[]>`
    SELECT (detail ->> 'step')::int AS step FROM approvals
    WHERE task_id = ${taskId} AND kind = 'browser' AND action = ${SAVED_ACTION} AND state = 'approved'`;
  return new Set(rows.map((row) => row.step).filter((step): step is number => typeof step === 'number'));
}

/**
 * The references the user let go with «Apri» in the conversation: those of
 * the cards asked for the browser open now (`browser`, when it opened: the
 * card keeps it, so neither a late decision nor the clock of the database
 * moves it to another browser), and with `recent` also those decided in the
 * last SAVED_WINDOW_MS by the clock of the database (web.fetch).
 */
export async function approvedSaved(sql: Queryable, conversationId: string, options: { browser?: number | null; recent?: boolean }): Promise<Set<string>> {
  const browser = options.browser == null ? null : String(options.browser);
  const recent = options.recent === true ? SAVED_WINDOW_MS / 1000 : null;
  if (browser === null && recent === null) return new Set();
  const rows = await sql<{ id: string; ref: string | null }[]>`
    SELECT a.id::text AS id, value ->> 'ref' AS ref
    FROM approvals a JOIN tasks t ON t.id = a.task_id, jsonb_array_elements(a.detail -> 'values') AS value
    WHERE a.kind = 'browser' AND a.action = ${SAVED_ACTION} AND a.state = 'approved' AND t.conversation_id = ${conversationId}
      AND a.decided_at IS NOT NULL
      AND ((${browser}::text IS NOT NULL AND a.detail ->> 'browser' = ${browser}::text)
        OR (${recent}::float8 IS NOT NULL AND a.decided_at >= now() - make_interval(secs => ${recent}::float8)))`;
  // Only a value still as it was when the user decided: a field changed since asks again.
  const approved = new Set<string>();
  for (const row of rows) {
    if (typeof row.ref !== 'string' || row.ref === '') continue;
    const hash = asked.get(row.id)?.get(row.ref);
    if (hash !== undefined && hash === savedEntry(row.ref)?.hash) approved.add(row.ref);
  }
  return approved;
}

/** What the model reads once the user decided; the same bytes at every later step (the prefix cache). Never a value nor a name. */
export function savedResultText(state: string): string {
  if (state === 'approved') return 'the user agreed that the saved data may leave for this: call the same tool again (browser.read first if the page changed).';
  if (state === 'pending') return WAITING_PRIVATE;
  return 'error: the user did not want saved data of a client or a contact to leave here. Do not try it again with that data; go on without it, or tell the user.';
}
