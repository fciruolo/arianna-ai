import type { Conversation } from './types.ts';

/**
 * "Elimina" for good (D-157): of a conversation from its list, of a note of
 * the Conoscenza, of the Pensieri or of a project. The words of the
 * confirmations and when the button is there, pure so that they are tested.
 */

export const ERASE_QUESTION = 'Eliminare per sempre?';

/** What goes and what stays when a conversation is erased: the user reads it before the click. */
export const ERASE_CONVERSATION_TEXT =
  'Sparisce tutto quello che la conversazione ha lasciato in Arianna: messaggi, passi, deleghe del Coder, schede, chat di sistema sui suoi task e il registro di cosa è uscito verso il cloud. I lavori in corso si fermano. Restano le card create da qui (senza il legame), le note salvate nella Conoscenza, i file cambiati dal Coder nei progetti e ciò che un fornitore cloud ha già ricevuto. Non si può annullare.';

/** The same for a note: its file goes from the disk. */
export const DELETE_NOTE_TEXT = 'Il file della nota si cancella dal disco: non si recupera. I collegamenti dei Pensieri che la nominano diventano “nota eliminata”.';

/** The same for a note of a project. */
export const DELETE_PROJECT_NOTE_TEXT = 'Il file della nota si cancella dalla cartella del progetto: non si recupera.';

/**
 * Whether "Elimina" is offered for a conversation of a list: never for the
 * secretary's (it goes on in time), Telegram's (the bot writes there) nor an
 * incognito one (it ends with "Termina"). The core refuses them too.
 */
export function canErase(conversation: Pick<Conversation, 'telegram' | 'secretary' | 'incognito'>): boolean {
  return !conversation.telegram && conversation.secretary !== true && conversation.incognito !== true;
}

/** What the page says when the core refused: a step that did not stop in time, or anything else. */
export function eraseFailedText(status: number | undefined): string {
  if (status === 409) return 'La conversazione sta ancora lavorando: riprova fra un momento.';
  if (status === 404) return 'La conversazione non c’è più.';
  return 'Non è stato possibile eliminarla.';
}
