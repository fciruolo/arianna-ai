import type { ChatState } from './chat-state.ts';
import type { Conversation, Message, SideThread, Task } from './types.ts';

/**
 * «Chiedi a lato» (D-232, idea 8 of OpenWork): a question apart on one answer
 * of the chat, in a panel on the right. The side thread is a conversation of
 * its own in the core, born from the answer, hidden from the list: what is
 * asked and answered there never enters the conversation the model rereads.
 * Who answers is the same as in the conversation (Arianna, the local model,
 * Claude or ChatGPT), with the same clearance. Pure helpers: the tests need
 * no browser.
 */

export const SIDE_ACTION_TEXT = 'Chiedi a lato';
/** The same action on an answer that has a side thread already: it opens that one again. */
export const SIDE_REOPEN_TEXT = 'Riprendi a lato';
export const SIDE_HINT = 'Una domanda a parte su questa risposta: domande e risposte restano nel pannello, fuori dalla conversazione';
export const SIDE_TITLE = 'A lato';
export const SIDE_CLOSE_TEXT = 'Chiudi il pannello (Esc)';
export const SIDE_ABOUT_TEXT = 'Sulla risposta';
export const SIDE_EMPTY_TEXT = 'Chiedi qualcosa su questa risposta. Domande e risposte restano qui: la conversazione non le rilegge.';
export const SIDE_PLACEHOLDER = 'Chiedi a lato…';
export const SIDE_SEND_TEXT = 'Invia';
export const SIDE_WORKING_TEXT = 'Sta rispondendo…';
export const SIDE_QUEUED_TEXT = 'In coda: parte quando finisce la risposta in corso.';
export const SIDE_FAILED_TEXT = 'Risposta non riuscita: riprova scrivendo di nuovo la domanda.';
export const SIDE_WAITING_TEXT = 'Aspetta una tua decisione: la trovi fra le decisioni in sospeso.';
export const SIDE_BLOCKED_TEXT = 'Ora non può rispondere: chi risponde è spento, oppure la domanda è stata fermata. Riprova più tardi.';
export const SIDE_LOAD_ERROR = 'Non riesco ad aprire il filo a lato.';

/** Who answers a side thread: as the core allows (conversations_side_guard, migration 0071). */
const SIDE_AGENTS: readonly (string | null)[] = [null, 'local-chat', 'claude', 'codex'];

/** Whether the answers of this conversation offer «Chiedi a lato». */
export function sideAllowed(conversation: Conversation | undefined): boolean {
  if (conversation === undefined) return false;
  if (conversation.incognito === true || conversation.secretary === true || (conversation.trialModel ?? null) !== null) return false;
  if ((conversation.sideOf ?? null) !== null) return false;
  if (conversation.origin !== 'user' || conversation.archivedAt !== null) return false;
  // The chat with a character of the series (D-225) takes none: see sideRefusal in the core.
  if ((conversation.seriesCharacter ?? null) !== null) return false;
  return SIDE_AGENTS.includes(conversation.agent);
}

/** Whether «Chiedi a lato» shows on this message: an answer, in a conversation that allows it. */
export function canAskAside(conversation: Conversation | undefined, message: Pick<Message, 'role'>): boolean {
  return message.role === 'assistant' && sideAllowed(conversation);
}

/** The side threads by the answer they are about. */
export function sidesByMessage(list: readonly SideThread[]): Map<string, string> {
  return new Map(list.map((side) => [side.messageId, side.conversationId]));
}

/** The start of the answer, one paragraph of plain text, shown above the side thread. */
export function sideExcerpt(body: string, max = 280): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' […] ')
    .replace(/[#>*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Esc closes the panel, but not while a word is being composed (an IME). */
export function closesPanel(event: { key: string; isComposing?: boolean }): boolean {
  return event.key === 'Escape' && event.isComposing !== true;
}

/** What the side thread is doing now, from its latest task. */
export type SideStatus = 'idle' | 'working' | 'waiting' | 'failed';

export function sideStatus(chat: ChatState | null, tasks: Readonly<Record<string, Task>>): SideStatus {
  if (chat === null) return 'idle';
  const last = [...chat.messages].reverse().find((message) => message.role === 'user' && message.taskId !== null);
  const task = last?.taskId == null ? undefined : tasks[last.taskId];
  if (task === undefined) return chat.streaming.length > 0 ? 'working' : 'idle';
  if (task.status === 'ready' || task.status === 'running') return 'working';
  if (task.status === 'failed') return 'failed';
  // Waiting for the user without an answer: an approval to decide, or a reason the core gave.
  if (task.status === 'waiting_user' && !chat.messages.some((message) => message.taskId === task.id && message.role === 'assistant')) return 'waiting';
  return 'idle';
}

/** The messages the panel shows: the questions and their answers, never the lines of the system. */
export function sideMessages(chat: ChatState | null): Message[] {
  return chat === null ? [] : chat.messages.filter((message) => message.role !== 'system');
}

/** Who answers in the side thread: the same as in its conversation. */
export function sideWho(agent: string | null | undefined): string {
  if (agent === 'local-chat') return 'il modello locale';
  if (agent === 'claude') return 'Claude';
  if (agent === 'codex') return 'ChatGPT';
  return 'Arianna';
}
