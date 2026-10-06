import { ApiError } from './api.ts';
import { messageNote } from './capture.ts';
import { errorText } from './italian.ts';
import type { Label } from './types.ts';

/**
 * The actions shown over a message of the chat when the pointer passes on it
 * (or the keyboard reaches it, or always on a touch screen): "Copia" and
 * "Salva in inbox" (D-099). A message is saved once (D-089): the core
 * answers 409 when kb/inbox already has a note with `source: message:<id>`,
 * and `GET /api/conversations/:id/saved` gives the ids already saved, so
 * "Salvato" survives a reload.
 */

export const SAVED_TEXT = 'Salvato';
export const SAVED_HINT = 'Questo messaggio è già una nota in kb/inbox';
export const SAVING_TEXT = 'Salvo…';
export const COPY_HINT = 'Copia il testo del messaggio così come è stato scritto';
/**
 * Every 404 of a message's save (D-099). The core answers 404 both for a
 * message that no longer exists and when it has no capture configured; the
 * page does not tell them apart by the English text, so the sentence covers both.
 */
export const MESSAGE_GONE_TEXT = 'Il messaggio non c’è più, o il nucleo non salva note: non l’ho salvato.';

/** What the page sends to POST /api/capture: the text is read by the core from the message itself. */
export interface MessageCapture {
  messageId: string;
  kind: 'note';
  title?: string;
  from: Label;
}

/**
 * The request for "Salva in inbox" on a message, or why it is not sent (in
 * Italian): the same checks as before D-089 (L3, too long, empty), now with
 * the message id, so the core can refuse a second save.
 */
export function messageCapture(message: { id: string; body: string; label: Label }): { capture: MessageCapture } | { error: string } {
  const checked = messageNote(message.body, message.label);
  if ('error' in checked) return checked;
  const { title, from } = checked.note;
  return { capture: { messageId: message.id, kind: 'note', ...(title === undefined ? {} : { title }), from } };
}

export type SaveOutcome =
  /** Written now: `note` is the file name of the note in kb/inbox. */
  | { kind: 'saved'; note: string | null }
  /** Already in kb/inbox (409): `note` is the file name, null when the note is above L2. */
  | { kind: 'already'; note: string | null }
  /** Not saved: the reason in Italian. */
  | { kind: 'failed'; text: string };

/** Whether an outcome means the message is in kb/inbox (the button then says "Salvato" for good). */
export function isSaved(outcome: SaveOutcome): outcome is Exclude<SaveOutcome, { kind: 'failed' }> {
  return outcome.kind !== 'failed';
}

/** The core's answer to POST /api/capture with a messageId, as an outcome. */
export function captureOutcome(status: number, data: unknown): SaveOutcome {
  const body = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  if (status === 201 || status === 200) {
    const name = typeof body.path === 'string' ? body.path.split('/').at(-1) : undefined;
    return { kind: 'saved', note: name === undefined || name === '' ? null : name };
  }
  if (status === 409) return { kind: 'already', note: typeof body.note === 'string' ? body.note : null };
  if (status === 404) return { kind: 'failed', text: MESSAGE_GONE_TEXT };
  return { kind: 'failed', text: errorText(new ApiError(status, typeof body.error === 'string' ? body.error : `HTTP ${String(status)}`)) };
}

/** Same signature as the part of `fetch` used here, so tests can stand in for the core. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Pick<Response, 'status' | 'ok' | 'json'>>;

const defaultFetch: Fetcher = (input, init) => fetch(input, init);

/** "Salva in inbox": the outcome, never an exception. */
export async function saveMessage(message: { id: string; body: string; label: Label }, fetcher: Fetcher = defaultFetch): Promise<SaveOutcome> {
  const checked = messageCapture(message);
  if ('error' in checked) return { kind: 'failed', text: checked.error };
  try {
    const response = await fetcher('/api/capture', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checked.capture),
    });
    const data: unknown = await response.json().catch(() => ({}));
    return captureOutcome(response.status, data);
  } catch (cause) {
    return { kind: 'failed', text: errorText(cause) };
  }
}

/** The note of the whole conversation: whether there is one, and its path when the core names it (up to L2). */
export interface ConversationNote {
  saved: boolean;
  path: string | null;
}

/** What GET /api/conversations/:id/saved says, read once per conversation opened. */
export interface SavedState {
  /** The saved messages: id → file name of the note, null when the core does not name it (above L2). */
  messages: Map<string, string | null>;
  conversation: ConversationNote;
}

/**
 * What of a conversation is already in kb/inbox. Nothing saved when the core
 * cannot say (no capture configured, core down): the buttons then offer the
 * save, and a second save of a message gets 409, which also ends in "Salvato".
 */
export async function loadSaved(conversationId: string, fetcher: Fetcher = defaultFetch): Promise<SavedState> {
  const none: SavedState = { messages: new Map(), conversation: { saved: false, path: null } };
  try {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(conversationId)}/saved`, { credentials: 'same-origin' });
    if (!response.ok) return none;
    const data = (await response.json().catch(() => ({}))) as { messageIds?: unknown; notes?: unknown; conversation?: unknown; conversationNote?: unknown };
    const names = typeof data.notes === 'object' && data.notes !== null ? (data.notes as Record<string, unknown>) : {};
    const ids = Array.isArray(data.messageIds) ? data.messageIds.filter((id): id is string => typeof id === 'string') : [];
    const saved = data.conversation === true;
    return {
      messages: new Map(ids.map((id) => [id, typeof names[id] === 'string' ? names[id] : null])),
      conversation: { saved, path: saved && typeof data.conversationNote === 'string' ? data.conversationNote : null },
    };
  } catch {
    return none;
  }
}

/**
 * The messages known to be saved on the page: id → file name of the note, or
 * null when it is not known (read from GET .../saved, which gives only ids)
 * or not shown (a note above L2).
 */
export type SavedNotes = ReadonlyMap<string, string | null>;

/** A new map with the message saved (the page replaces the ref, so Vue sees the change). */
export function withSaved(saved: SavedNotes, id: string, note: string | null): Map<string, string | null> {
  const next = new Map(saved);
  next.set(id, note ?? saved.get(id) ?? null);
  return next;
}

/**
 * The saved messages once GET /api/conversations/:id/saved has answered.
 * `asked` is the conversation the read was for, `open` the one on screen now:
 * when they differ the answer is dropped and `current` stays. Otherwise the
 * notes read are added to `current`, which keeps the saves made on the page
 * while the read was in flight, with their file names.
 */
export function mergeSavedNotes(current: SavedNotes, read: SavedNotes, asked: string, open: string): SavedNotes {
  if (asked !== open) return current;
  const next = new Map(current);
  for (const [id, note] of read) if (next.get(id) == null) next.set(id, note);
  return next;
}

/** "Apri nella Conoscenza" after a save: the note in the graph of kb/ (D-090), selected. */
export const OPEN_IN_KNOWLEDGE_TEXT = 'Apri nella Conoscenza';
export const OPEN_IN_KNOWLEDGE_HINT = 'Apri la nota salvata nella pagina Conoscenza';

/** The node of the graph of a note of kb/inbox, from its path (`kb/inbox/x.md`) or its file name (`x.md`): `inbox/x.md`. */
export function inboxNodeId(note: string): string {
  return note.startsWith('kb/') ? note.slice(3) : `inbox/${note}`;
}

/** "Salva in inbox" of the whole conversation (I-7, D-131): the label of the button, before and after a first save. */
export const SAVE_CONVERSATION_TEXT = 'Salva in inbox';
export const UPDATE_CONVERSATION_TEXT = 'Aggiorna in inbox';
export const SAVE_CONVERSATION_HINT =
  'Salva tutta la conversazione come una nota in kb/inbox (i tuoi messaggi, quelli di Arianna e i rapporti degli agenti, senza le righe di sistema); il modello locale le dà titolo e riassunto.';
export const UPDATE_CONVERSATION_HINT = 'Riscrive la nota di questa conversazione in kb/inbox con tutti i messaggi di adesso: una modifica fatta a mano alla nota si perde.';

/** Saves the whole conversation; what the chat says after it and the note's path, never an exception. */
export async function saveConversation(
  conversationId: string,
  fetcher: Fetcher = defaultFetch,
): Promise<{ ok: true; text: string; path: string } | { ok: false; text: string }> {
  try {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(conversationId)}/save`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = (await response.json().catch(() => ({}))) as { path?: unknown; replaced?: unknown; error?: unknown };
    if (response.status === 201 && typeof data.path === 'string') {
      return { ok: true, text: `${data.replaced === true ? 'Nota aggiornata' : 'Conversazione salvata'} in ${data.path}`, path: data.path };
    }
    return { ok: false, text: errorText(new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`)) };
  } catch (cause) {
    return { ok: false, text: errorText(cause) };
  }
}
