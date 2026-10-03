import { ApiError } from './api.ts';
import { ACTION_TEXT, EXECUTOR_TEXT, MODEL_TEXT } from './labels.ts';
import type { Activity } from './types.ts';

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
  'the local model did not give a valid answer': 'il modello locale non ha dato una risposta valida',
  'no local model serves the orchestrator: assign one in [roles] (pnpm arianna:init)':
    'nessun modello locale per l’orchestratore: assegnalo in [roles] (pnpm arianna:init)',
  'the gateway blocked the answer': 'il gateway ha fermato la risposta',
  'the answer is above what the conversation may hold': 'la risposta supera il livello di questa conversazione',
  'the task has no request to work on': 'il task non ha una richiesta su cui lavorare',
  'the local model asked for a tool it does not have': 'il modello locale ha chiesto uno strumento che non ha',
  'approval needed: budget': 'serve la tua approvazione per il budget del modello',
  'approval needed: workspace': 'la cartella del progetto ha modifiche non committate: serve il tuo via libera',
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

// Errors of the orchestrator's tools (apps/core/src/orchestrator/kb.ts): fixed
// texts around a path the model chose.
const TOOL_ERRORS: [RegExp, (path: string) => string][] = [
  [/^(\S+) does not take delegated steps$/, (agent) => `${agentName(agent)} non accetta passi delegati`],
  [/^the user did not approve sending the brief to the cloud/, () => 'il brief non è stato approvato per il cloud'],
  [/^the user did not approve the budget for (\S+)/, (model) => `il budget per ${MODEL_TEXT[model] ?? model} non è stato approvato`],
  [/^the user did not want the Coder to work over uncommitted changes/, () => 'hai preferito non far lavorare il Coder sopra le tue modifiche non committate'],
  [/^the folder of (\S+) cannot be opened/, (repo) => `la cartella di ${repo} non si apre come repository git`],
  [/^no repository for the Coder/, () => 'nessun repository per il Coder: apri una conversazione di lavoro con un repository ammesso'],
  [/^the gateway refused the brief/, () => 'il gateway ha fermato il brief'],
  [/^no executor can take this step now/, () => 'nessun esecutore può prendere questo passo adesso'],
  [/^the Coder runs delegated steps on Claude Code only/, () => 'il Coder lavora solo su Claude Code, che non è disponibile per questo passo'],
  [/^the repository (\S+) cannot go to the cloud/, (repo) => `il repository ${repo} non può andare nel cloud`],
  [/^the workspace of (\S+) could not be prepared$/, (repo) => `non sono riuscita a preparare la cartella di lavoro di ${repo}`],
  [/^claude: ([a-z-]+)$/, (kind) => `Claude Code si è fermato (${kind})`],
  [/^"(.*)" is not a page path/, (path) => `${path} non è un percorso di pagina valido (kb/cartella/nome.md)`],
  [/^page (\S+) not found$/, (path) => `pagina ${path} non trovata`],
  [/^page (\S+) is above what this conversation may read/, (path) => `${path} è sopra il livello di questa conversazione`],
  [/^with autonomy A1 pages can only be written under (\S+)\/$/, (path) => `può scrivere solo in ${path}/`],
  [/^page (\S+) already exists/, (path) => `la pagina ${path} esiste già`],
  [/^page (\S+) is too large to read$/, (path) => `la pagina ${path} è troppo grande`],
];

function toolError(detail: string): string {
  for (const [pattern, text] of TOOL_ERRORS) {
    const match = pattern.exec(detail);
    if (match !== null) return text(match[1] ?? '');
  }
  return 'uno strumento ha restituito un errore';
}

/** One line of what a task is doing, in Italian (D-054). */
export function activityText(activity: Activity): string {
  switch (activity.kind) {
    case 'thinking':
      return `Sto ragionando (passo ${String(activity.step)})…`;
    case 'search':
      return `Cerco nella knowledge base: «${activity.detail}»`;
    case 'read':
      return `Leggo ${activity.detail}`;
    case 'write':
      return `Scrivo ${activity.detail}`;
    case 'card':
      return `Creo la carta «${activity.detail}»`;
    case 'plan':
      return `Piano: ${activity.detail}`;
    case 'error':
      return `Errore: ${toolError(activity.detail)}, provo un’altra strada`;
    case 'delegate':
      return delegateText(activity.detail);
    case 'tool':
      return `Il Coder usa ${activity.detail}`;
    case 'wait':
      return waitText(activity.detail);
  }
}

// `coder` when the step is handed over, `coder · claude/sonnet` when it starts.
function delegateText(detail: string): string {
  const started = /^(\S+) · (\w+)\/(\S+)$/.exec(detail);
  if (started === null) return `Passo delegato al ${agentName(detail)}`;
  const [, agent = '', executor = '', model = ''] = started;
  return `Il ${agentName(agent)} lavora su ${EXECUTOR_TEXT[executor] ?? executor} (${MODEL_TEXT[model] ?? model})`;
}

// `budget · fable`, or `claude · <ISO time>` for a quota.
function waitText(detail: string): string {
  const workspace = /^workspace · (\S+)$/.exec(detail);
  if (workspace?.[1] !== undefined) return `La cartella ${workspace[1]} ha modifiche non committate: aspetto il tuo via libera`;
  const budget = /^budget · (\S+)$/.exec(detail);
  if (budget?.[1] !== undefined) return `Serve la tua approvazione del budget per ${MODEL_TEXT[budget[1]] ?? budget[1]}`;
  const quota = /^(\w+) · (\S+)$/.exec(detail);
  if (quota?.[2] !== undefined && !Number.isNaN(Date.parse(quota[2]))) {
    const at = new Date(quota[2]).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const executor = quota[1] ?? '';
    return `${EXECUTOR_TEXT[executor] ?? executor} ha esaurito la quota: riprovo alle ${at}`;
  }
  return 'In attesa dell’esecutore';
}

const AGENT_TEXT: Record<string, string> = { coder: 'Coder', arianna: 'Arianna' };

/** The agent as the user reads it. */
export function agentName(agent: string): string {
  return AGENT_TEXT[agent] ?? agent;
}
