/**
 * «Affianca» (D-234, idea 7 of OpenWork, D-093): a second conversation beside
 * the open one in the chat page. Each one keeps its own state (messages,
 * field, draft of D-231, queue of D-218), its clearance and who answers: the
 * page only puts them side by side, nothing of one reaches the other.
 *
 * The address carries both: `/c/<left>?affianca=<right>`, so a reload or a
 * link comes back to the two of them.
 */
import type { Conversation } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query parameter of the conversation beside. */
export const SPLIT_PARAM = 'affianca';

/**
 * From this width of the window (CSS pixels) the two conversations stand side
 * by side; below it the page shows one at a time, with a switch between them
 * (the proposal of D-093: two columns from 1280 px).
 */
export const SPLIT_MIN_PX = 1280;

/** Whether the two conversations fit side by side at this window width. */
export function splitFits(width: number): boolean {
  return width >= SPLIT_MIN_PX;
}

/** The conversation beside in the query of the address, or undefined. */
export function splitFromSearch(search: string): string | undefined {
  const id = new URLSearchParams(search).get(SPLIT_PARAM)?.trim();
  return id !== undefined && UUID.test(id) ? id.toLowerCase() : undefined;
}

/** The address of a conversation with the one beside, or the path alone when there is none. */
export function withSplit(path: string, beside: string | null): string {
  if (beside === null) return path;
  return `${path}?${SPLIT_PARAM}=${encodeURIComponent(beside)}`;
}

/** The fields of a conversation that decide whether it may stand beside another. */
type SplitFields = Pick<Conversation, 'id'> & Partial<Pick<Conversation, 'incognito' | 'secretary' | 'sideOf'>>;

/**
 * Whether a conversation may stand on either side: never an incognito one
 * (its address never names it, D-136), the secretary's (its own page and
 * address, D-156) or a side thread (it lives in the panel of its mother, D-232).
 */
export function splittable(conversation: SplitFields | undefined): boolean {
  if (conversation === undefined) return false;
  return conversation.incognito !== true && conversation.secretary !== true && (conversation.sideOf ?? null) === null;
}

/** Whether «Affianca» is offered on `candidate` with `left` open in the chat page. */
export function canSplit(left: SplitFields | undefined, candidate: SplitFields): boolean {
  return left !== undefined && left.id !== candidate.id && splittable(left) && splittable(candidate);
}

/** Which pane a ChatView is: none when it is alone in the page. */
export type Pane = 'left' | 'right';

/**
 * Whether a pane answers a key that is not typed in a field of its own, such
 * as the keys for the models (D-231): the pane holding the focus, or the one
 * in front when the focus is in neither (the left one side by side, the one
 * shown on a narrow window). A ChatView alone always answers.
 */
export function paneOwnsKey(pane: Pane | undefined, focused: Pane | null, front: Pane = 'left'): boolean {
  if (pane === undefined) return true;
  return focused === null ? pane === front : focused === pane;
}

/** The ids of a ChatView's own elements, unique when two stand in the page. */
export function paneId(pane: Pane | undefined, id: string): string {
  return pane === 'right' ? `${id}-right` : id;
}
