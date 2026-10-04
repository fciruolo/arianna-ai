import type { CloudModel, ConversationMode, TaskFailure } from './types.ts';

/**
 * Why a task failed, in Italian (D-064): the core stores a code and a few
 * scalar details (apps/core/src/failures.ts), this page explains them from its
 * own catalog. A code not listed here gets a generic text, never the code's
 * own words as an explanation.
 */
export interface FailureText {
  title: string;
  explanation: string;
  steps: string[];
}

type Details = TaskFailure['details'];

function text(details: Details, key: string): string | undefined {
  const value = details[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** "il server omlx (porta 7001)", or a plainer form with what is known. */
function server(details: Details): string {
  const endpoint = text(details, 'endpoint');
  const port = text(details, 'port');
  if (endpoint !== undefined && port !== undefined) return `il server ${endpoint} (porta ${port})`;
  if (endpoint !== undefined) return `il server ${endpoint}`;
  if (port !== undefined) return `il server sulla porta ${port}`;
  return 'il server del modello locale';
}

function attempts(details: Details): string {
  const count = text(details, 'attempts');
  return count === undefined ? '' : ` Ho provato ${count} ${count === '1' ? 'volta' : 'volte'}.`;
}

const RETRY = 'Quando hai sistemato, premi «Riprova»: il task riparte dal passo che non è riuscito.';
const START_SERVER = 'Avvia oMLX con il comando che trovi nell’esempio di config/arianna.toml (sezione [[local.endpoints]]).';
const CHAT_SAME_MODEL = 'La chat di sistema usa lo stesso modello locale: finché non risponde, segui questi passi.';
const CHAT_CLAUDE = 'Se ti serve aiuto, apri la chat di sistema: lì risponde Claude, che non usa il modello locale.';

const CATALOG: Record<string, (details: Details) => FailureText> = {
  'local-model.unavailable': (details) => ({
    title: 'Il modello locale non risponde',
    explanation: `Non riesco a raggiungere ${server(details)}: probabilmente è spento.${attempts(details)}`,
    steps: [START_SERVER, `Controlla che l’indirizzo di ${text(details, 'endpoint') ?? 'questo server'} in config/arianna.toml sia quello giusto.`, CHAT_SAME_MODEL, RETRY],
  }),
  'local-model.timeout': (details) => ({
    title: 'Il modello locale è troppo lento',
    explanation: `${capital(server(details))} non ha risposto in tempo: può essere bloccato o con poca memoria libera.${attempts(details)}`,
    steps: ['Controlla che oMLX sia ancora vivo; se è bloccato, riavvialo.', 'Chiudi i programmi che occupano molta memoria.', RETRY],
  }),
  'local-model.http': (details) => ({
    title: 'Il modello locale ha risposto con un errore',
    explanation: `${capital(server(details))} ha risposto con lo stato HTTP ${text(details, 'status') ?? 'sconosciuto'}.${attempts(details)}`,
    steps: ['Guarda il log di oMLX: di solito dice quale modello non ha caricato.', 'Controlla che il nome del modello in config/arianna.toml sia uno di quelli che oMLX elenca.', RETRY],
  }),
  'local-model.bad-response': (details) => ({
    title: 'Il modello locale ha risposto in modo illeggibile',
    explanation: `${capital(server(details))} ha mandato una risposta che non è nel formato atteso.${attempts(details)}`,
    steps: ['Capita con un modello non adatto al ruolo o con un server di versione diversa: controlla il modello assegnato in [roles].', RETRY],
  }),
  'local-model.no-endpoint': () => ({
    title: 'Nessun modello locale per questo ruolo',
    explanation: 'Nessun server in config/arianna.toml offre il modello che serve ad Arianna.',
    steps: ['Assegna un modello al ruolo con pnpm arianna:init --reconfigure.', RETRY],
  }),
  'local-model.cancelled': (details) => ({
    title: 'La richiesta al modello locale è stata interrotta',
    explanation: `La chiamata al modello è stata annullata prima della risposta.${attempts(details)}`,
    steps: [RETRY],
  }),
  'tool.workspace': (details) => ({
    title: 'Non sono riuscita a preparare la cartella di lavoro',
    explanation: `La cartella del progetto non si è potuta aprire o preparare per il Coder.${attempts(details)}`,
    steps: ['Controlla che il progetto in config/arianna.toml esista e sia un repository git.', RETRY],
  }),
  'tool.kb': (details) => ({
    title: 'Errore nella base di conoscenza',
    explanation: `Uno strumento della base di conoscenza si è fermato.${attempts(details)}`,
    steps: ['Controlla che la cartella kb/ esista e sia leggibile.', RETRY],
  }),
  'engine.lock-expired': () => ({
    title: 'Il nucleo si è fermato mentre lavorava',
    explanation: 'Il processo che eseguiva il task si è interrotto più volte (riavvio, arresto o crollo del nucleo).',
    steps: ['Controlla che il nucleo sia avviato (pnpm start) e che non si riavvii da solo.', RETRY],
  }),
  'engine.step-failed': (details) => ({
    title: 'Il passo non è riuscito',
    explanation: `L’esecutore ${text(details, 'executor') ?? ''} ha chiuso il passo come fallito.`.replace('  ', ' '),
    steps: ['Apri la chat di sistema per capire insieme cosa è successo.', RETRY],
  }),
  'engine.database': (details) => ({
    title: 'Errore del database',
    explanation: `PostgreSQL ha rifiutato un’operazione (codice ${text(details, 'sqlstate') ?? 'sconosciuto'}).${attempts(details)}`,
    steps: ['Controlla che il database sia avviato (pnpm db:up) e aggiornato (pnpm arianna:doctor).', RETRY],
  }),
};

function capital(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Title, explanation and steps for a failure. `claudeAnswers` says whether
 * Claude can answer the task's system chat (claudeAnswersSystemChat): then the
 * chat helps even when the local model is down.
 */
export function failureText(failure: Pick<TaskFailure, 'code' | 'details'>, claudeAnswers = false): FailureText {
  const known = CATALOG[failure.code];
  if (known !== undefined) {
    const result = known(failure.details);
    return claudeAnswers ? { ...result, steps: result.steps.map((step) => (step === CHAT_SAME_MODEL ? CHAT_CLAUDE : step)) } : result;
  }
  if (failure.code.startsWith('claude.')) {
    return {
      title: 'Claude Code si è fermato',
      explanation: 'Il lavoro delegato a Claude Code non è finito.',
      steps: ['Controlla di essere collegato all’abbonamento (claude in un terminale).', RETRY],
    };
  }
  return {
    title: 'Errore imprevisto',
    explanation: 'Il task si è fermato per un errore che non so ancora spiegare.',
    steps: ['Apri la chat di sistema per capire insieme cosa è successo.', RETRY],
  };
}

/** Claude models that answer a work system chat directly (D-064). Same list as DIRECT_MODELS in apps/core/src/conversations.ts. */
export const DIRECT_MODELS: readonly string[] = ['sonnet', 'opus'];

/**
 * Whether Claude answers the system chat opened from a conversation in this
 * mode: work only (L1), and Sonnet or Opus turned on, the models the core
 * gives a new system chat (route POST /api/tasks/:id/system-chat in
 * apps/core/src/server/http.ts, D-064 and D-071).
 */
export function claudeAnswersSystemChat(mode: ConversationMode | undefined, models: readonly CloudModel[]): boolean {
  return mode === 'work' && models.some((entry) => entry.executor === 'claude' && DIRECT_MODELS.includes(entry.model));
}

/**
 * Whether the system chat can help: on the local model it cannot when the
 * failure is the local model itself, unless Claude can answer it (D-064).
 */
export function chatCanHelp(failure: Pick<TaskFailure, 'origin'>, claudeAnswers = false): boolean {
  return claudeAnswers || failure.origin !== 'local-model';
}
