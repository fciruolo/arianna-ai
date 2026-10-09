import { APPROVAL_ACTIONS, type ApprovalAction } from '@arianna/agents';

/**
 * The fixed texts of the bot (D-044). They are L0: written here, they quote
 * nothing but names from closed lists. Only `approvalNotice` may carry a task
 * title, and the channel labels it with the task's label.
 */
export const TEXTS = {
  start:
    'Ciao, sono Arianna. Qui parli con me nella conversazione di lavoro: ciò che è privato resta nella chat web.',
  notText: 'Qui leggo solo messaggi di testo.',
  invalid: 'Questo messaggio è vuoto o troppo lungo: scrivilo nella chat web.',
  replyReference: 'La risposta è pronta nella chat web.',
  approvalReference: 'Hai una richiesta di approvazione: aprila nella chat web.',
  approve: 'Approva',
  reject: 'Rifiuta',
  approved: 'Approvata',
  rejected: 'Rifiutata',
  alreadyDecided: 'Questa richiesta è già stata decisa.',
  webOnly: 'Questa richiesta si decide solo dalla chat web.',
  unknown: 'Richiesta non trovata.',
} as const;

const ACTION_NAMES: Record<ApprovalAction, string> = {
  delete: 'cancellazione',
  send_external: "invio all'esterno",
  payment: 'pagamento',
  call: 'telefonata',
};

function actionName(action: string): string {
  const known = APPROVAL_ACTIONS.find((candidate) => candidate === action);
  return known === undefined ? 'azione' : ACTION_NAMES[known];
}

/** A one-line title can hold no line break that would fake another field. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The scanner refused a message: the kinds it found are names, not content. */
export function scannerRefusal(kinds: readonly string[]): string {
  return `Questo messaggio non può stare nella conversazione di lavoro (${kinds.join(', ')}): scrivilo nella chat web, in una conversazione privata.`;
}

/**
 * The notice of an approval: the action and, when given, the task title.
 * Never the detail: it is read in the web chat.
 */
export function approvalNotice(kind: string, action: string, title?: string): string {
  const head =
    kind === 'declassify'
      ? 'Richiesta di declassamento: si decide solo dalla chat web.'
      : kind === 'workspace'
        ? 'Approvazione richiesta: il Coder lavorerebbe in una cartella con modifiche non committate.'
        : kind === 'budget'
          ? 'Approvazione richiesta: budget per un modello che costa oltre il piano.'
          : kind === 'commitment'
            ? 'La segretaria aspetta una conferma: si dà solo dalla chat web.'
            : `Approvazione richiesta: ${actionName(action)}.`;
  const task = title === undefined || oneLine(title) === '' ? '' : `\nTask: ${oneLine(title)}`;
  const tail = kind === 'declassify' || kind === 'commitment' ? '' : '\nIl dettaglio è nella chat web.';
  return `${head}${task}${tail}`;
}
