import type { ConversationMode } from './types.ts';

/**
 * A new conversation as in Claude Code (D-108): "Nuovo" opens a draft that
 * lives only in the page, with an empty chat and the field ready. The core
 * creates the conversation only with the first message, so an empty
 * conversation never reaches the list. Pure: the store and the page use it.
 */
export interface Draft {
  /** A new number for each draft opened: the page starts a fresh field for each. */
  key: number;
  mode: ConversationMode;
  /** The approved project of a work conversation, by name. */
  project?: string | undefined;
  /**
   * Set once the core created the conversation but the first message did not
   * go through: a retry sends to it, never creates a second one.
   */
  conversationId: string | null;
}

export const DRAFT_PATH = '/nuova';

const MODE_WORD: Record<ConversationMode, string> = { private: 'privata', work: 'lavoro' };

/** `/nuova?tipo=privata`, `/nuova?tipo=lavoro&progetto=arianna`: a reload comes back to the draft. */
export function draftPath(mode: ConversationMode, project?: string): string {
  const params = new URLSearchParams({ tipo: MODE_WORD[mode] });
  if (mode === 'work' && project !== undefined && project !== '') params.set('progetto', project);
  return `${DRAFT_PATH}?${params.toString()}`;
}

/** The draft an address asks for, or undefined for any other address. An unknown type is a private one. */
export function draftFromAddress(pathname: string, search: string): Pick<Draft, 'mode' | 'project'> | undefined {
  if (pathname !== DRAFT_PATH && pathname !== `${DRAFT_PATH}/`) return undefined;
  const params = new URLSearchParams(search);
  if (params.get('tipo') !== 'lavoro') return { mode: 'private' };
  const project = params.get('progetto')?.trim();
  return project === undefined || project === '' ? { mode: 'work' } : { mode: 'work', project };
}

/** What the first message may be: a text for Arianna; the "/" commands work once the conversation exists. */
export function firstMessageProblem(text: string, goesToArianna: (draft: string) => boolean): string | undefined {
  if (text.trim() === '') return 'Scrivi il primo messaggio.';
  if (!goesToArianna(text)) return 'I comandi con "/" funzionano dopo il primo messaggio: scrivi prima ad Arianna.';
  return undefined;
}

/** What the first "Invia" does: create the conversation, or send to the one already created by a failed attempt. */
export function draftStep(draft: Pick<Draft, 'conversationId'>): { kind: 'create' } | { kind: 'send'; conversationId: string } {
  return draft.conversationId === null ? { kind: 'create' } : { kind: 'send', conversationId: draft.conversationId };
}

/** Why the project of a work draft cannot be used, said before the first message; undefined when it can, or while the list is unknown. */
export function draftProjectProblem(draft: Pick<Draft, 'mode' | 'project'>, approved: readonly string[] | undefined): string | undefined {
  if (draft.mode !== 'work' || draft.project === undefined || approved === undefined) return undefined;
  return approved.includes(draft.project)
    ? undefined
    : `Il progetto "${draft.project}" non è fra quelli approvati: apri "Nuovo" e scegline un altro, o lascia la conversazione senza progetto.`;
}
