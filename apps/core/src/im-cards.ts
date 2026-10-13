import type { Project } from '@arianna/config';

import { CardError, createCard, moveCard, type CardNames } from './cardwall.ts';
import type { Queryable, Sql } from './db/client.ts';
import { parseIm, rewriteItem, type ImItem } from './im-format.ts';
import { cardStillOpen, changeIm, ImError, readIm, type ImView } from './im.ts';
import type { KnowledgeEnv } from './project-knowledge.ts';

/**
 * Each item of an IM has its card (D-167, P4b): the card holds the details
 * (description, checklist, links, files, priority, who does it), the file
 * keeps the list and carries `#card-<short id>` on the item's line. The card
 * is made the first time the user opens the item; the state goes both ways:
 * an item checked moves its card to "Fatto", a card in "Fatto" checks its
 * items (im-watch.ts).
 */

/** The short id of a card on the line of an item: the first 8 hex digits of its uuid. */
export function shortCardId(id: string): string {
  return id.slice(0, 8).toLowerCase();
}

/** The card of a project with this short id, when exactly one has it. */
export async function cardOfShortId(sql: Queryable, project: string, short: string): Promise<{ id: string; status: string } | undefined> {
  if (!/^[0-9a-f]{8}$/.test(short)) return undefined;
  const rows = await sql<{ id: string; status: string }[]>`
    SELECT id::text, status::text FROM tasks
    WHERE project = ${project} AND conversation_id IS NULL AND id::text LIKE ${`${short}%`}
    LIMIT 2`;
  return rows.length === 1 ? rows[0] : undefined;
}

/** The title of the card of an item: its title, with the part when it has one. */
function cardTitle(item: ImItem): string {
  return item.part === null ? item.title : `${item.title} — Parte ${String(item.part)}`;
}

/**
 * The card of the item on `line` of the IM `number`: the one it names, or a
 * new card in the inbox of the project, written on the item's line. The item
 * is named by line, title and part, as the user saw it.
 */
export async function itemCard(
  sql: Sql,
  projects: readonly Project[],
  env: KnowledgeEnv,
  names: CardNames,
  project: string,
  number: number,
  ref: { line: number; title: string; part: number | null },
): Promise<{ cardId: string; im: ImView }> {
  // One card at a time per IM: two clicks on the same item make one card.
  const key = `${project}/${String(number)}`;
  const run = (making.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => makeItemCard(sql, projects, env, names, project, number, ref));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  making.set(key, tail);
  try {
    return await run;
  } finally {
    if (making.get(key) === tail) making.delete(key);
  }
}

const making = new Map<string, Promise<void>>();

async function makeItemCard(
  sql: Sql,
  projects: readonly Project[],
  env: KnowledgeEnv,
  names: CardNames,
  project: string,
  number: number,
  ref: { line: number; title: string; part: number | null },
): Promise<{ cardId: string; im: ImView }> {
  const same = (item: ImItem): boolean => item.line === ref.line && item.title === ref.title && item.part === ref.part;
  const im = readIm(projects, project, env, number);
  const item = im.items.find(same);
  if (item === undefined) throw new ImError('changed', 'the item changed in the file');
  if (item.card !== null) {
    const card = await cardOfShortId(sql, project, item.card);
    if (card !== undefined) return { cardId: card.id, im };
    // A short id that names no card, or more than one: the item gets its own card.
  }
  let created;
  try {
    created = await createCard(sql, { title: cardTitle(item), project }, names);
  } catch (error) {
    if (error instanceof CardError) throw new ImError('invalid', error.message);
    throw error;
  }
  const short = shortCardId(created.id);
  const after = changeIm(projects, project, env, number, (text) => parseIm(text).items.some((candidate) => same(candidate) && candidate.card === item.card), (text) =>
    rewriteItem(text, ref.line, { title: item.title, state: item.state, part: item.part, card: short }),
  );
  return { cardId: created.id, im: after };
}

/**
 * An item checked in an IM (by the user in the cardwall or at the closing):
 * its card goes to "Fatto" when it can by hand and no other open item carries
 * it; an agent's card that is not in "Da verificare", or one at work, stays
 * where it is.
 */
export async function completeItemCard(sql: Sql, projects: readonly Project[], env: KnowledgeEnv, project: string, short: string | null): Promise<void> {
  if (short === null) return;
  // A work in parts: the card goes on while its next part is open (D-167).
  if (cardStillOpen(projects, project, env, short)) return;
  const card = await cardOfShortId(sql, project, short);
  if (card === undefined || card.status === 'done') return;
  try {
    await moveCard(sql, card.id, 'done');
  } catch (error) {
    if (!(error instanceof CardError)) throw error;
  }
}
