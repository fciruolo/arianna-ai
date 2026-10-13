import { ApiError } from './api.ts';
import { errorText, scannerKindText } from './italian.ts';

/**
 * "Fai uscire una volta" of a Private note (I-11 P5, D-187): the texts of the
 * panel. The core answers in English with a code in front of a refusal
 * (`wrong-password: …`); here it becomes Italian. A text not listed gets the
 * generic message of `errorText`.
 */

const RELEASE_TEXT: Record<string, string> = {
  'wrong-password': 'Master password sbagliata. Dopo cinque tentativi sbagliati di fila l’uscita resta bloccata per dieci minuti.',
  locked: 'Troppe password sbagliate: l’uscita è bloccata per qualche minuto. Riprova più tardi.',
  'no-password':
    'Non c’è ancora una master password nel vault, oppure il vault non si apre. Lanciala in un terminale: pnpm vault:master, poi incolla la riga che stampa con pnpm vault:edit.',
  'not-private': 'Questa nota non è Privata: da qui esce solo una nota Privata, una Riservata non esce mai.',
  changed: 'La nota è cambiata dopo che l’hai aperta: chiudi e riaprila, poi rifai la proposta.',
  target: 'Scegli una conversazione di lavoro di questo progetto.',
  busy: 'Sto già controllando un’altra uscita: aspetta un momento e riprova.',
  invalid: 'Il testo da far uscire è vuoto o troppo lungo (al massimo 20 000 caratteri).',
};

const PROPOSAL_TEXT: Record<number, string> = {
  403: 'Il gateway ha fermato la nota: non è arrivata al modello locale.',
  409: 'Il modello locale sta già scrivendo un’altra versione anonima: aspetta che finisca.',
  413: 'La nota è troppo lunga per la proposta (al massimo 20 000 caratteri): scrivi tu il testo da far uscire.',
  502: 'Il modello locale non ha dato una risposta valida: riprova, oppure scrivi tu il testo da far uscire.',
  503: 'Il modello locale non è disponibile: controlla oMLX, oppure scrivi tu il testo da far uscire.',
  504: 'Il modello locale non ha risposto in tempo: riprova, oppure scrivi tu il testo da far uscire.',
};

/** Why the anonymous version is missing. */
export function proposalErrorText(cause: unknown): string {
  if (cause instanceof ApiError && PROPOSAL_TEXT[cause.status] !== undefined) return PROPOSAL_TEXT[cause.status] ?? '';
  return errorText(cause);
}

/** Why the text did not leave. */
export function releaseErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  const code = /^([a-z-]+): /.exec(cause.message)?.[1];
  if (code !== undefined && RELEASE_TEXT[code] !== undefined) return RELEASE_TEXT[code] ?? '';
  if (cause.status === 422) {
    return 'La conversazione di lavoro rifiuta questo testo: lo scanner ci trova ancora un dato come un IBAN o un codice fiscale. Toglilo e riprova.';
  }
  if (cause.status === 409 && /busy|still working/.test(cause.message)) return 'Il Coder sta ancora lavorando in quella conversazione: aspetta la risposta, poi riprova.';
  if (cause.status === 409 && /archived/.test(cause.message)) return 'La conversazione è archiviata: ripristinala o scegline un’altra.';
  return errorText(cause);
}

/** "Ancora un IBAN e un codice fiscale": what the scanner still finds in the proposal, in Italian. */
export function warningText(kinds: readonly string[]): string | null {
  if (kinds.length === 0) return null;
  const names = kinds.map(scannerKindText);
  const list = names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} e ${names.at(-1) ?? ''}`;
  return `Nel testo c’è ancora: ${list}. Toglilo prima di farlo uscire: la conversazione di lavoro rifiuterebbe il testo.`;
}

/** What the select shows for a conversation: its title, or the project when it has none yet. */
export function targetText(target: { title: string | null; workspace: string; agent: string | null }): string {
  const title = target.title?.trim() || `Senza titolo (${target.workspace})`;
  return target.agent === null ? title : `${title} · chat diretta`;
}

/**
 * The project whose Private notes "Allega nota privata" offers in a chat: a
 * work conversation on a project or one of its parts (`<project>:<part>`),
 * never archived, incognito or of the finances; null elsewhere. The core
 * checks the same when the text leaves.
 */
export function releaseProject(conversation: { mode: string; workspace: string | null; incognito?: boolean; finance?: boolean; archivedAt?: string | null }): string | null {
  if (conversation.mode !== 'work' || conversation.incognito === true || conversation.finance === true) return null;
  if (conversation.archivedAt !== undefined && conversation.archivedAt !== null) return null;
  const project = conversation.workspace?.split(':')[0] ?? '';
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(project) ? project : null;
}
