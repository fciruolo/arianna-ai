import { reasonText } from './italian.ts';
import { ACTION_TEXT, declassifyLabels, EXECUTOR_TEXT, MODEL_TEXT } from './labels.ts';
import type { Approval } from './types.ts';

// The Italian texts of the "Decisioni in attesa" window (D-091).

export type PendingKind = 'declassify' | 'budget' | 'workspace' | 'setting' | 'action' | 'question' | 'stopped';

export const PENDING_KIND_TEXT: Record<PendingKind, string> = {
  declassify: 'Privacy · declassamento',
  budget: 'Budget',
  workspace: 'Cartella di lavoro',
  setting: 'Impostazione',
  action: 'Azione da approvare',
  question: 'Domanda di Arianna',
  stopped: 'Task fermo',
};

export const PENDING_TITLE = 'Decisioni in attesa';
export const PENDING_EMPTY = 'Niente da decidere';
export const PENDING_OPEN = 'Arianna aspetta una tua decisione';
export const PENDING_NO_CONVERSATION = 'Senza conversazione';
export const PENDING_UNTITLED = 'Conversazione senza titolo';

/** The kind of an approval as the window shows it. */
export function pendingKind(approval: Pick<Approval, 'kind'>): PendingKind {
  switch (approval.kind) {
    case 'declassify':
    case 'budget':
    case 'workspace':
    case 'setting':
    case 'action':
      return approval.kind;
    default:
      return 'action';
  }
}

/** The label of the kind; an action approval names its action when known. */
export function pendingKindText(approval: Pick<Approval, 'kind' | 'action'>): string {
  const kind = pendingKind(approval);
  if (kind === 'action') return ACTION_TEXT[approval.action] ?? PENDING_KIND_TEXT.action;
  return PENDING_KIND_TEXT[kind];
}

/**
 * What the approval asks, in one short line. Never more than ApprovalCard
 * shows, and less: the declassified text stays in the card of the chat.
 */
export function pendingAskText(approval: Pick<Approval, 'kind' | 'action' | 'detail'>): string {
  const detail = approval.detail;
  switch (approval.kind) {
    case 'declassify': {
      const labels = declassifyLabels(detail);
      return labels === undefined ? 'Far uscire un testo declassato dalla macchina' : `Far uscire un testo declassato (${labels}) dalla macchina`;
    }
    case 'workspace':
      return typeof detail.repo === 'string'
        ? `Lavorare in ${detail.repo} sopra modifiche non ancora committate`
        : 'Lavorare in una cartella con modifiche non ancora committate';
    case 'budget':
      return typeof detail.executor === 'string' && typeof detail.model === 'string'
        ? `Usare ${MODEL_TEXT[detail.model] ?? detail.model} su ${EXECUTOR_TEXT[detail.executor] ?? detail.executor}, oltre il piano`
        : 'Usare un modello che costa oltre il piano';
    case 'setting':
      return 'Applicare un cambio alle impostazioni';
    // The cardwall (D-159): a plan of Arianna, the choice of where a card runs.
    case 'plan': {
      const count = Array.isArray(detail.cards) ? detail.cards.length : 0;
      return typeof detail.title === 'string' && count > 0 ? `Creare ${String(count)} card per «${detail.title}»` : 'Creare le card di un piano';
    }
    case 'executor':
      return typeof detail.title === 'string' ? `Scegliere con chi lavora la card «${detail.title}»` : 'Scegliere con chi lavora una card';
    default: {
      const action = ACTION_TEXT[approval.action];
      return action === undefined ? 'Serve la tua approvazione per un’azione' : `Serve la tua approvazione: ${action.toLowerCase()}`;
    }
  }
}

/** How long it has been waiting: "da adesso", "da 3 min", "da 2 h", "da ieri", "da 4 giorni"; '' for a bad date. */
export function waitingSinceText(at: string, now: Date): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.floor((now.getTime() - time) / 1000));
  if (seconds < 60) return 'da adesso';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `da ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `da ${String(hours)} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'da ieri' : `da ${String(days)} giorni`;
}

/** A waiting task that is neither a question nor behind a listed approval: why it stopped, in Italian. */
export function stoppedText(waitingReason: string | null): string {
  const reason = reasonText(waitingReason);
  return reason === undefined ? 'Si è fermato e aspetta una tua risposta' : `Si è fermato: ${reason}`;
}

/** A task behind an approval the window does not list (decided meanwhile, or not readable). */
export const PENDING_APPROVAL_ELSEWHERE = 'Serve la tua approvazione: la trovi nella conversazione';

/** The waiting tasks above L2: counted, never shown. */
export function hiddenText(count: number): string {
  return count === 1
    ? 'Un altro task in attesa riguarda dati Segreti: non è mostrato qui.'
    : `Altri ${String(count)} task in attesa riguardano dati Segreti: non sono mostrati qui.`;
}

// "Chiudi" on a row (D-109).
export const PENDING_DISMISS = 'Chiudi';
export const PENDING_DISMISS_CONFIRM = 'Sicuro?';
export const PENDING_DISMISS_HINT = 'Chiude questa attesa: il task passa a fatto.';
export const PENDING_DISMISS_CONFIRM_HINT = 'C’è un’approvazione in attesa: chiudendo scade e il task passa a fatto. Serve un secondo clic per confermare.';
export const PENDING_DISMISS_ARMED = 'Sicuro? Premi di nuovo Chiudi entro 5 secondi per confermare.';
export const PENDING_DISMISSED = 'Attesa chiusa.';

/** The accessible name of a row's "Chiudi", distinct from the window's own close button. */
export function pendingDismissLabel(conversationTitle: string, armed: boolean): string {
  return armed ? `Sicuro? Conferma la chiusura dell’attesa: ${conversationTitle}` : `Chiudi l’attesa: ${conversationTitle}`;
}
