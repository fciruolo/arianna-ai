import { APPROVAL_ACTIONS, type ApprovalAction } from '@arianna/agents';

/**
 * The fixed texts of the bot (D-044). They are L0: written here, they quote
 * nothing but names from closed lists. Only `approvalNotice` may carry a task
 * title, and the channel labels it with the task's label.
 */
export const TEXTS = {
  start:
    'Ciao, sono Arianna. Qui parli con me nella conversazione di Lavoro: ciò che è Privato resta nella chat web.',
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
  return `Questo messaggio non può stare nella conversazione di lavoro (${kinds.join(', ')}): scrivilo nella chat web, in una conversazione Privata.`;
}

/**
 * The kinds of approval decided in the web chat only: a declassification, a
 * commitment of the secretary (D-144), a plan and the choice of an executor
 * (D-159), an IM item, a fact, a routine (D-256), a link of the browser (D-264), the closing of a milestone (D-313), a folder of the Mac (D-314; the database refuses them from Telegram too).
 */
export const WEB_ONLY_KINDS = ['declassify', 'commitment', 'plan', 'executor', 'im', 'fact', 'routine', 'browser', 'milestone', 'mac'] as const;

export function isWebOnly(kind: string): boolean {
  return (WEB_ONLY_KINDS as readonly string[]).includes(kind);
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
        ? 'Approvazione richiesta: il Coder lavorerebbe in una cartella con modifiche non ancora committate.'
        : kind === 'budget'
          ? 'Approvazione richiesta: usare un modello che costa oltre il piano.'
          : kind === 'commitment'
            ? 'La segretaria aspetta una conferma: si dà solo dalla chat web.'
            : kind === 'plan'
              ? 'Arianna propone un piano di card: si approva solo dalla chat web.'
              : kind === 'executor'
                ? 'Un lavoro di un agente aspetta che tu scelga chi lo fa (Claude, ChatGPT o modello locale): si sceglie solo dalla chat web.'
                : kind === 'im'
                  ? 'Arianna chiede di scrivere una voce in un IM: si conferma solo dalla chat web.'
                  : kind === 'fact'
                    ? 'Arianna propone di ricordare un dato su di te: si conferma solo dalla chat web.'
                    : kind === 'routine'
                      ? 'Arianna propone una routine: si attiva solo dalla chat web o dalla pagina Routine.'
                      : kind === 'milestone'
                        ? 'Arianna chiede se chiudere una milestone: si decide solo dalla chat web.'
                        : `Approvazione richiesta: ${actionName(action)}.`;
  const task = title === undefined || oneLine(title) === '' ? '' : `\nTask: ${oneLine(title)}`;
  const tail = isWebOnly(kind) ? '' : '\nIl dettaglio è nella chat web.';
  return `${head}${task}${tail}`;
}
