import { ApiError } from './api.ts';
import { ACTION_TEXT } from './labels.ts';

/**
 * The page is in Italian; the core writes its reasons and errors in English,
 * like the rest of the code. Here they become Italian before being shown.
 * A text not listed here is never shown as it is: it gets a generic message.
 */

const SCANNER_KIND_TEXT: Record<string, string> = {
  iban: 'IBAN',
  'tax-code': 'codice fiscale',
  'card-number': 'numero di carta',
  'private-key': 'chiave privata',
  token: 'token o chiave di accesso',
};

const LIMIT_UNIT_TEXT: Record<string, string> = { steps: 'passi', minutes: 'minuti', euro: 'euro' };

const REASONS: Record<string, string> = {
  'the orchestrator is not available yet (task 1.10)': 'l’orchestratore non è ancora disponibile (task 1.10)',
  'finished without evidence': 'finito senza prove',
  'the agent asked for an action it is not allowed': 'l’agente ha chiesto un’azione che non gli è consentita',
  'the agent asked for an invalid declassification': 'l’agente ha chiesto un declassamento non valido',
  'the executor reported an invalid usage': 'l’esecutore ha riportato un consumo non valido',
  'invalid limits': 'limiti non validi',
  'no step or time cap set': 'manca un limite di passi o di tempo',
};

function actionName(action: string): string {
  return (ACTION_TEXT[action] ?? 'un’azione').toLowerCase();
}

/**
 * Why a task waits for the user, in Italian; undefined for a reason this page
 * does not know (an executor's own words): then only "Attende te" is shown.
 */
export function reasonText(reason: string | null): string | undefined {
  if (reason === null) return undefined;
  const known = REASONS[reason];
  if (known !== undefined) return known;
  const approval = /^approval needed: ([a-z_]+)$/.exec(reason);
  if (approval?.[1] !== undefined) return `serve la tua approvazione (${actionName(approval[1])})`;
  const limit = /^limit reached: ([\d.]+) of ([\d.]+) (steps|minutes|euro)$/.exec(reason);
  if (limit !== null) {
    const [, used = '', max = '', unit = ''] = limit;
    return `limite raggiunto: ${used.replace('.', ',')} su ${max.replace('.', ',')} ${LIMIT_UNIT_TEXT[unit] ?? unit}`;
  }
  const minutes = /^limit reached: (\d+) minutes$/.exec(reason);
  if (minutes?.[1] !== undefined) return `limite raggiunto: ${minutes[1]} minuti`;
  return undefined;
}

const ERRORS: Record<string, string> = {
  'the message is empty': 'Il messaggio è vuoto.',
  'the message contains a NUL character': 'Il messaggio contiene un carattere non valido.',
  'only a work conversation has a workspace': 'Solo una conversazione di lavoro può avere un repository.',
  'workspace must be a relative path inside ARIANNA_HOME': 'Il repository dev’essere un percorso relativo dentro la cartella di Arianna.',
  'workspace is not in cloud.allowlist': 'Questo repository non è fra quelli ammessi (cloud.allowlist in arianna.toml).',
  'body too large': 'Il messaggio è troppo grande.',
  'not found': 'Non trovato: forse è stato cancellato o l’indirizzo è sbagliato.',
  'the task cannot do this now': 'Il task non può farlo adesso.',
};

/** An error of the API (or of the network) as the user reads it. */
export function errorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    // fetch fails with a TypeError when the core does not answer.
    return cause instanceof TypeError ? 'Il nucleo non risponde: controlla che sia avviato.' : 'Errore imprevisto.';
  }
  const known = ERRORS[cause.message];
  if (known !== undefined) return known;
  const scanner = /^a work conversation cannot hold this message \(([^)]*)\)/.exec(cause.message);
  if (scanner?.[1] !== undefined) {
    const kinds = scanner[1].split(', ').map((kind) => SCANNER_KIND_TEXT[kind] ?? 'dati riservati');
    return `Una conversazione di lavoro non può contenere questo messaggio (${[...new Set(kinds)].join(', ')}): aprine una privata.`;
  }
  const length = /^the message is longer than (\d+) characters$/.exec(cause.message);
  if (length?.[1] !== undefined) return `Il messaggio supera ${length[1]} caratteri.`;
  if (/^the approval is already/.test(cause.message)) return 'Questa richiesta è già stata decisa.';
  if (cause.status === 403) return 'Il nucleo ha rifiutato la richiesta: apri la chat dal suo indirizzo.';
  if (cause.status >= 500) return 'Errore del nucleo: riprova fra poco.';
  return 'Richiesta non valida.';
}
