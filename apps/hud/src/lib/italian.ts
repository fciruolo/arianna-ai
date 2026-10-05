import { ApiError } from './api.ts';
import type { CopyResult } from './clipboard.ts';
import { ACTION_TEXT, EXECUTOR_TEXT, MODEL_TEXT } from './labels.ts';
import type { ModelEvalStatus } from './model-evals.ts';
import type { Activity, FileChangeKind, FileDiffError, MessageCredit, RecentDelegation, SavedActivity } from './types.ts';

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
  'the local model keeps repeating the same call': 'il modello locale ripete la stessa chiamata',
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
  // The capture of "/nota" (D-080, apps/core/src/capture.ts).
  'text is empty': 'La nota è vuota.',
  'text holds a NUL character': 'La nota contiene un carattere non valido.',
  'url must be http or https': 'Il link deve essere un indirizzo http o https.',
  'url must be a single http(s) address': 'Il link deve essere un indirizzo http o https.',
  'there is no kb/ folder': 'Manca la cartella kb/: la nota non è stata salvata.',
  'kb/inbox is not a folder': 'kb/inbox non è una cartella vera: la nota non è stata salvata.',
  'cannot create the note': 'Non sono riuscita a creare la nota.',
  'cannot create kb/inbox': 'Non sono riuscita a creare la cartella kb/inbox.',
  'a link needs an url': 'Un link richiede un indirizzo.',
  'title must be one line of at most 200 characters': 'Il titolo deve stare su una riga di al massimo 200 caratteri.',
  'too many notes with the same name in this second': 'Troppe note con lo stesso nome in questo secondo: riprova.',
  'the message contains a NUL character': 'Il messaggio contiene un carattere non valido.',
  'only a work conversation has a project': 'Solo una conversazione di lavoro può avere un progetto.',
  'project is not among the approved projects': 'Questo progetto non è fra quelli approvati: aggiungilo con pnpm arianna:init --reconfigure.',
  'project must be a string': 'Il progetto non è valido.',
  'body too large': 'Il messaggio è troppo grande.',
  'not found': 'Non trovato: forse è stato cancellato o l’indirizzo è sbagliato.',
  'the task cannot do this now': 'Il task non può farlo adesso.',
  'the title is empty': 'Il titolo è vuoto.',
  'the title must be one line': 'Il titolo dev’essere su una riga.',
  'the title contains a NUL character': 'Il titolo contiene un carattere non valido.',
  'the title is longer than 200 characters': 'Il titolo supera 200 caratteri.',
  'the conversation is archived: restore it to write': 'La conversazione è archiviata: ripristinala per scrivere.',
  'the conversation of Telegram cannot be archived': 'La conversazione di Telegram non si può archiviare: il bot scrive lì.',
  'only an archived conversation can be deleted': 'Si elimina definitivamente solo una conversazione archiviata.',
  'a task of the conversation is still at work: wait for it to finish':
    'Un task di questa conversazione sta ancora lavorando: aspetta che finisca, poi eliminala.',
  'the conversation is in use: try again in a moment': 'La conversazione è in uso in questo momento: riprova fra poco.',
  'the task has no recorded error': 'Per questo task non è stato salvato un errore: la chat di sistema non ha niente da spiegare.',
  'the conversation of the task was deleted': 'La conversazione di questo task è stata eliminata.',
  'the question is already attached': 'La domanda è già allegata.',
  'the task is not failed': 'Il task non è fallito (forse è già stato riprovato): non c’è un errore da spiegare.',
  'a system chat about this conversation is still at work: wait for it to finish':
    'Una chat di sistema su questa conversazione sta ancora lavorando: aspetta che finisca, poi eliminala (sparisce insieme).',
  'only a system chat takes the question of a task': 'Solo una chat di sistema può allegare la domanda di un task.',
  'the task has no question to attach': 'Questo task non ha una domanda da allegare.',
  // The notes of kb/inbox (D-086, the "Pensieri" page of D-090).
  'note not found': 'Nota non trovata: forse è stata spostata o è sopra L2.',
  'the note is too large to read': 'La nota è troppo grande per essere letta qui.',
  'the note is already organized': 'La nota è già stata riordinata.',
  'notes cannot be organized now': 'Il riordino delle note non è disponibile adesso: manca il modello locale.',
  'status must be new or organized': 'Filtro di stato non valido.',
  // Trials of a model (D-081).
  'the model is not in the catalog': 'Il modello non è nel catalogo.',
  'the catalog does not list this role for the model': 'Il catalogo non indica questo modello per l’orchestratore.',
  'the files of the model are not in data/models': 'I file del modello non sono in data/models: scaricali con pnpm arianna:models pull.',
  'no local endpoint in arianna.toml': 'Nessun server locale in arianna.toml: aggiungilo nelle impostazioni.',
  'a trial of this model is already queued or running': 'Una prova di questo modello è già in coda o in corso.',
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
  const title = /^a work conversation cannot hold this title \(([^)]*)\)/.exec(cause.message);
  if (title?.[1] !== undefined) {
    const kinds = title[1].split(', ').map((kind) => SCANNER_KIND_TEXT[kind] ?? 'dati riservati');
    return `Il titolo di una conversazione di lavoro non può contenere ${[...new Set(kinds)].join(', ')}.`;
  }
  const length = /^the message is longer than (\d+) characters$/.exec(cause.message);
  if (length?.[1] !== undefined) return `Il messaggio supera ${length[1]} caratteri.`;
  if (/^the approval is already/.test(cause.message)) return 'Questa richiesta è già stata decisa.';
  if (/^the trial is already /.test(cause.message)) return 'Questa prova è già finita.';
  const note = /^text is longer than (\d+) KiB$/.exec(cause.message);
  if (note?.[1] !== undefined) return `La nota supera ${note[1]} KiB.`;
  if (/^kb\/inbox is labeled L\d: captures stop at L2$/.test(cause.message)) return 'La cartella kb/inbox è sopra L2: la nota non è stata salvata.';
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
  [/^no project for the Coder/, () => 'nessun progetto per il Coder: apri una conversazione di lavoro con un progetto approvato'],
  [/^the project (\S+) is no longer among the projects the user approved/, (name) => `il progetto ${name} non è più fra quelli approvati`],
  [/^the gateway refused the brief/, () => 'il gateway ha fermato il brief'],
  [/^the same call as step (\d+)/, (step) => `la stessa chiamata del passo ${step}, non rifatta`],
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

/** One line of what a task is doing, in Italian (D-054), live or saved (D-083). */
export function activityText(activity: Activity | SavedActivity): string {
  switch (activity.kind) {
    case 'thinking':
      // Step 0: nothing known yet, as after a reload before the first saved line.
      if (activity.step > 0) return `Sto ragionando (passo ${String(activity.step)})…`;
      return activity.detail === 'queued' ? 'In coda…' : 'Sto lavorando…';
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

/** The fixed name of a known agent; undefined for any other id (never the id itself). */
export function knownAgentName(agent: string): string | undefined {
  return Object.hasOwn(AGENT_TEXT, agent) ? AGENT_TEXT[agent] : undefined;
}

/** The state of a trial of a model (D-081). */
export const MODEL_EVAL_STATUS_TEXT: Record<ModelEvalStatus, string> = {
  queued: 'in coda',
  running: 'in corso',
  passed: 'soglie superate',
  failed: 'soglie mancate',
  error: 'errore',
  cancelled: 'annullata',
};

// The closed codes of a trial of a model (D-081, apps/core/src/model-evals.ts).
const MODEL_EVAL_ERRORS: Record<string, string> = {
  user: 'annullata da te',
  preempted: 'annullata: chiamate e task hanno avuto la precedenza troppe volte sullo stesso caso',
  interrupted: 'interrotta dal riavvio del nucleo',
  'lock-lost': 'interrotta: il nucleo ha perso la coda',
  'not-in-catalog': 'il modello non è più nel catalogo',
  role: 'il catalogo non indica più il modello per l’orchestratore',
  'files-missing': 'i file del modello non sono in data/models',
  'no-endpoint': 'nessun server locale in arianna.toml',
};

/** Why a trial ended without an outcome; a code not listed gets a generic text. */
export function modelEvalErrorText(code: string | null): string | undefined {
  if (code === null) return undefined;
  const known = MODEL_EVAL_ERRORS[code];
  if (known !== undefined) return known;
  if (code.startsWith('LocalModelError')) return 'il modello locale non ha risposto';
  return 'errore del nucleo';
}

/** How a file changed in the run of a delegation (D-082). */
export const CHANGE_TEXT: Record<FileChangeKind, string> = {
  added: 'aggiunto',
  modified: 'modificato',
  deleted: 'cancellato',
  renamed: 'rinominato',
};

/** How a delegation ended, in "Deleghe recenti". */
export const DELEGATION_STATUS_TEXT: Record<RecentDelegation['status'], string> = {
  pending: 'in attesa',
  running: 'al lavoro',
  ok: 'fatto',
  failed: 'fallito',
  refused: 'rifiutato',
};

/** "45 s", "2 min 5 s", "1 h 3 min". */
export function durationText(ms: number | null): string | undefined {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
}

/** Euro beyond the subscription, Italian style; undefined when nothing was paid. */
export function costText(cost: number | null): string | undefined {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return undefined;
  return `${cost.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** "Claude Code / Claude Sonnet (claude-sonnet-4-5)": executor, alias and the model that ran. */
export function runnerText(credit: Pick<MessageCredit, 'executor' | 'alias' | 'model'>): string {
  const executor = credit.executor === null ? 'cloud' : (EXECUTOR_TEXT[credit.executor] ?? credit.executor);
  const alias = credit.alias === null ? undefined : (MODEL_TEXT[credit.alias] ?? credit.alias);
  const model = credit.model !== null && credit.model !== credit.alias ? ` (${credit.model})` : '';
  return alias === undefined ? `${executor}${model}` : `${executor} / ${alias}${model}`;
}

/** The small line under a cloud answer (D-082): who, on what, in how long, at what cost. */
export function creditText(credit: MessageCredit): string {
  const who = credit.agent === null ? 'Risposta diretta' : agentName(credit.agent);
  return [`${who} · ${runnerText(credit)}`, durationText(credit.durationMs), costText(credit.cost)].filter((part) => part !== undefined).join(' · ');
}

/** "File modificati (3)". */
export function filesTitle(count: number): string {
  return count === 1 ? 'File modificato (1)' : `File modificati (${String(count)})`;
}

/** "+12 −3": lines added and removed (D-117). */
export function diffCountText(added: number, removed: number): string {
  return `+${String(added)} −${String(removed)}`;
}

/** Why the diff of a changed file is not shown (D-117). */
export const DIFF_ERROR_TEXT: Record<FileDiffError, string> = {
  'not-found': 'Questo file non è fra quelli della delega.',
  deleted: 'Il file non c’è più nella cartella del progetto.',
  'not-approved': 'Il progetto non è più fra quelli approvati: niente diff.',
  refused: 'Il file esce dal progetto, contiene un valore del vault o non si può leggere: niente diff.',
  'too-large': 'Il file supera 256 KiB, o il diff è troppo lungo per la chat: guardalo dalla cartella del progetto.',
  binary: 'Non è un file di testo UTF-8: niente diff.',
  archived: 'La conversazione è archiviata: ripristinala per vedere i file.',
  busy: 'Il Coder sta lavorando su questo progetto: il diff si vede quando ha finito.',
  'too-many': 'Troppi file in questa delega: il diff si mostra per i primi 100.',
  'no-base': 'Manca la versione di partenza (una delega di prima del diff, o il file non era nel commit): apri la versione attuale.',
  unreadable: 'Non riesco a leggere la versione di partenza dal repository (cartella o commit cambiati): apri la versione attuale.',
};

/** Why the preview of a changed file is not shown. */
export function previewErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  if (cause.status === 410) return 'Il file non c’è più: cancellato dal run o dopo.';
  if (cause.status === 413) return 'Il file supera 256 KiB: aprilo dalla cartella del progetto.';
  if (cause.status === 415) return 'Non è un file di testo UTF-8: niente anteprima.';
  if (cause.status === 403 && /no longer among the approved projects|above L1/.test(cause.message)) return 'Il progetto non è più fra quelli approvati: niente anteprima.';
  if (cause.status === 403 && /not the approved path|does not exist/.test(cause.message)) return 'La cartella del progetto non è più quella approvata: niente anteprima.';
  if (cause.status === 403 && /value of the vault/.test(cause.message)) return 'Il file contiene un valore del vault: niente anteprima.';
  if (cause.status === 403) return 'Il file esce dal progetto o non si può leggere: niente anteprima.';
  if (cause.status === 409 && /is working on/.test(cause.message)) return 'Il Coder sta lavorando su questo progetto: il diff si vede quando ha finito.';
  if (cause.status === 409) return 'La conversazione è archiviata: ripristinala per vedere i file.';
  if (cause.status === 404) return 'Questo file non è fra quelli della delega.';
  return errorText(cause);
}

/** The button that opens the saved lines of a finished task (D-083). */
export function stepsButtonText(count: number, open: boolean): string {
  return open ? 'Nascondi i passi' : `Mostra i passi (${String(count)})`;
}

/** How long ago, in Italian: "adesso", "3 min fa", "2 h fa", "ieri", "4 giorni fa". */
export function relativeTimeText(at: string, now: Date): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.floor((now.getTime() - time) / 1000));
  if (seconds < 60) return 'adesso';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h fa`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'ieri' : `${String(days)} giorni fa`;
}

/** The button on a code block (D-084): before the click, then for two seconds after it. */
export const COPY_TEXT: Record<'idle' | CopyResult, string> = {
  idle: 'Copia',
  copied: 'Copiato',
  unavailable: 'Copia non disponibile',
};

/** "Salva in inbox" under a message (D-084). */
export const SAVE_TO_INBOX_TEXT = 'Salva in inbox';
export const SAVE_TO_INBOX_HINT = 'Salva il testo di questo messaggio come nota in kb/inbox, senza modello';
export const MESSAGE_TOO_LARGE_TEXT = 'Il messaggio è più lungo di 64 KiB: troppo per una nota, non l’ho salvato.';
export const MESSAGE_ABOVE_L2_TEXT = 'Il messaggio è L3: kb/inbox arriva fino a L2, non l’ho salvato.';
export const MESSAGE_EMPTY_TEXT = 'Il messaggio è vuoto: non c’è niente da salvare.';

/** The "Pensieri" page (D-090). */
export const THOUGHT_EMPTY_TEXT = 'Il pensiero è vuoto: scrivi qualcosa prima di salvarlo.';
export const THOUGHT_TOO_LARGE_TEXT = 'Il pensiero supera 64 KiB: accorcialo o dividilo in due.';
export const THOUGHT_PLACEHOLDER = 'Scrivi un pensiero…';
export const THOUGHT_MIC_HINT = 'La voce arriva presto';
export const THOUGHT_SAVED_TEXT = 'Pensiero salvato: lo riordino in background.';
export const THOUGHT_SAVED_UNQUEUED_TEXT = 'Pensiero salvato, ma il riordino non è partito: riprova dal pannello della nota.';
export const THOUGHT_STATE_TEXT: Record<'organizing' | 'stuck' | 'organized', string> = {
  organizing: 'In riordino…',
  stuck: 'Non riordinato',
  organized: 'Riordinato',
};
export const THOUGHT_STATE_HINT: Record<'organizing' | 'stuck' | 'organized', string> = {
  organizing: 'Il modello locale sta scrivendo titolo, riassunto, collegamenti e tag',
  stuck: 'Il riordino non è arrivato: puoi chiederlo di nuovo',
  organized: 'Titolo, riassunto, collegamenti e tag scritti dal modello locale; il testo originale è in fondo',
};
