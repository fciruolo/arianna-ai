import type { ConversationAgent, ConversationMode } from './types.ts';

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
  /** Who answers in place of Arianna (D-111): the direct chat with the Coder, a work conversation with a project. */
  agent?: ConversationAgent | undefined;
  /**
   * Set once the core created the conversation but the first message did not
   * go through: a retry sends to it, never creates a second one.
   */
  conversationId: string | null;
}

export const DRAFT_PATH = '/nuova';

/** What "Nuovo" chose: the mode, the project, and who answers. */
export type DraftChoice = Pick<Draft, 'mode' | 'project' | 'agent'>;

const MODE_WORD: Record<ConversationMode, string> = { private: 'privata', work: 'lavoro' };

/** `/nuova?tipo=privata`, `/nuova?tipo=lavoro&progetto=arianna`, `/nuova?tipo=coder&progetto=arianna`: a reload comes back to the draft. */
export function draftPath(choice: DraftChoice): string {
  const coder = choice.agent === 'coder' && choice.mode === 'work';
  const params = new URLSearchParams({ tipo: coder ? 'coder' : MODE_WORD[choice.mode] });
  if (choice.mode === 'work' && choice.project !== undefined && choice.project !== '') params.set('progetto', choice.project);
  return `${DRAFT_PATH}?${params.toString()}`;
}

/**
 * The draft an address asks for, or undefined for any other address. An
 * unknown type is a private one; the Coder without a project is a work
 * conversation, since the direct chat needs one (D-111).
 */
export function draftFromAddress(pathname: string, search: string): DraftChoice | undefined {
  if (pathname !== DRAFT_PATH && pathname !== `${DRAFT_PATH}/`) return undefined;
  const params = new URLSearchParams(search);
  const kind = params.get('tipo');
  if (kind !== 'lavoro' && kind !== 'coder') return { mode: 'private' };
  const project = params.get('progetto')?.trim();
  if (project === undefined || project === '') return { mode: 'work' };
  return kind === 'coder' ? { mode: 'work', project, agent: 'coder' } : { mode: 'work', project };
}

/** Who answers in a draft of this choice: the Coder only in a work conversation with a project (D-111). */
export function choiceAgent(choice: DraftChoice): ConversationAgent | undefined {
  return choice.mode === 'work' && choice.project !== undefined && choice.project.trim() !== '' ? choice.agent : undefined;
}

/** The same choice: the page does not open a draft again for it. */
export function sameChoice(a: DraftChoice, b: DraftChoice): boolean {
  return a.mode === b.mode && a.project === b.project && a.agent === b.agent;
}

/** What stays out of Arianna's hands in a direct chat (D-111): also said where such a conversation is deleted. */
export const SESSION_COPY = 'Claude Code tiene una copia della sessione nella tua home: eliminare la conversazione qui non la cancella.';

/** The warning of a direct chat with the Coder, plain and never hidden (D-111). */
export function coderWarning(project: string | undefined): string {
  const files = project === undefined || project === '' ? 'ai file del progetto' : `ai file del progetto ${project}`;
  return `Ogni messaggio va così com'è a Claude (Anthropic), insieme ${files} che il Coder apre. Arianna non lo filtra. Per dati personali usa una conversazione privata. ${SESSION_COPY}`;
}

/** Above this many characters a message of the direct chat asks before it goes to Claude (D-111, risposta 5). */
export const LONG_TO_CLAUDE = 4000;

/** Whether a message of the direct chat asks "Va davvero a Claude?" first. */
export function asksBeforeClaude(agent: ConversationAgent | null | undefined, text: string): boolean {
  return agent === 'coder' && text.length > LONG_TO_CLAUDE;
}

/** What the first message may be: a text for Arianna or the Coder; the "/" commands work once the conversation exists. */
export function firstMessageProblem(text: string, goesToArianna: (draft: string) => boolean, agent?: ConversationAgent): string | undefined {
  if (text.trim() === '') return 'Scrivi il primo messaggio.';
  if (!goesToArianna(text)) return `I comandi con "/" funzionano dopo il primo messaggio: scrivi prima ${agent === 'coder' ? 'al Coder' : 'ad Arianna'}.`;
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

/**
 * What "Invia" does with a message of the direct chat (D-111): `send`, `ask`
 * "Va davvero a Claude?" first, or `wait` while the question is open. Only
 * the button of the question confirms: Enter again, or a held key, never does.
 * A text that does not go to Claude (a note, a command) never asks.
 */
export function longMessageStep(
  agent: ConversationAgent | null | undefined,
  text: string,
  goesToClaude: boolean,
  state: { asking: boolean; confirmed: boolean },
): 'send' | 'ask' | 'wait' {
  if (!goesToClaude || !asksBeforeClaude(agent, text) || state.confirmed) return 'send';
  return state.asking ? 'wait' : 'ask';
}
