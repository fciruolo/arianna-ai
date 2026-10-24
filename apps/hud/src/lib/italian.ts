import { ApiError } from './api.ts';
import type { CopyResult } from './clipboard.ts';
import { ACTION_TEXT, EXECUTOR_TEXT, MODEL_TEXT } from './labels.ts';
import type { ModelEvalStatus } from './model-evals.ts';
import type { Activity, EditTool, FileChangeKind, FileDiffError, LiveEditError, MessageCredit, RecentDelegation, SavedActivity } from './types.ts';

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

/** A kind the scanner found (`iban`, `tax-code`…), in Italian. */
export function scannerKindText(kind: string): string {
  return SCANNER_KIND_TEXT[kind] ?? 'dati riservati';
}

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
  // The secretary (D-144).
  'the agent asked for an invalid confirmation': 'l’agente ha chiesto una conferma non valida',
  'approval needed: commitment.add': 'aspetta la tua conferma per segnare l’impegno',
  'approval needed: commitment.done': 'aspetta la tua conferma per segnare l’impegno come fatto',
  'approval needed: commitment.move': 'aspetta la tua conferma per spostare l’impegno',
  'approval needed: commitment.report': 'aspetta la tua conferma per annotare il resoconto',
  'the secretary answers only in its conversation': 'la segretaria risponde solo nella sua conversazione',
  'the confirmation of the secretary is no longer readable': 'la conferma della segretaria non è più leggibile',
  // The cardwall (D-159).
  'approval needed: task.plan': 'aspetta che tu approvi le card del piano',
  // The IM of a project (D-167).
  'approval needed: im.add': 'aspetta la tua conferma per scrivere la voce nell’IM',
  'the confirmation of the IM item is no longer readable': 'la conferma della voce dell’IM non è più leggibile',
  'approval needed: card.executor': 'aspetta che tu scelga con chi lavora',
  'the plan is no longer readable': 'il piano non è più leggibile',
  'a plan is answered only in its conversation': 'un piano si approva solo nella sua conversazione',
};

/** The waits of a card of an agent (D-159): the agent's name, then why. */
const CARD_REASONS: [RegExp, (agent: string) => string][] = [
  [/^the user did not choose where ([a-z0-9-]+) works/, () => 'non hai scelto con chi lavora: «Riprendi» per scegliere di nuovo'],
  [/^no way for ([a-z0-9-]+) to work on this card now$/, (agent) => `${agentTitle(agent)} non ha una strada per lavorarci ora (esecutori spenti o nessun modello locale)`],
  [/^(claude|codex|local) can no longer take this card/, () => 'la strada scelta non è più ammessa: «Riprendi» per scegliere di nuovo'],
  // The card «Piano» of «/progetta» (D-235).
  [/^the plan was not written: /, () => 'il piano non è stato scritto: «Riprendi» per riprovare'],
  [/^the planner wrote an invalid plan: /, () => 'il pianificatore ha scritto un piano non valido: «Riprendi» per riprovare'],
  [/^the local model gave no plan$/, () => 'il modello locale non ha scritto un piano: «Riprendi» per riprovare'],
  [/^the local model cannot read this request: /, () => 'il modello locale non può leggere questa richiesta'],
];

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
  for (const [pattern, text] of CARD_REASONS) {
    const match = pattern.exec(reason);
    if (match !== null) return text(match[1] ?? '');
  }
  // Why in the core's words stays out (never English here): the card says only who did not finish.
  const unfinished = /^([a-z0-9-]+) could not finish the card: /.exec(reason);
  if (unfinished !== null) return `${agentTitle(unfinished[1] ?? '')} non ha finito la card: «Riprendi» per riprovare`;
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
  // «Server dei modelli (oMLX)» (D-265).
  'a check of oMLX is already running': 'Un controllo di oMLX è già in corso.',
  'the message is empty': 'Il messaggio è vuoto.',
  // «@nome» and «/giro» (D-107, tappa B2, D-219).
  'write what you ask the agents after /giro': 'Scrivi dopo /giro la domanda per gli agenti.',
  'no agent is in this conversation yet: /giro asks those already here': 'In questa chat non c’è ancora nessun agente: /giro chiede a chi è già entrato. Chiamane uno con @nome.',
  // «/progetta» and the plans edited in their card (D-235).
  'write after /progetta the work to plan': 'Scrivi dopo /progetta il lavoro da pianificare.',
  '/progetta needs a work conversation with a project': '/progetta, in una conversazione di lavoro, vuole un progetto: aprine una con il progetto.',
  '/progetta works only in a conversation with Arianna': '/progetta funziona solo in una conversazione con Arianna.',
  '/progetta does not work in incognito: nothing of it would outlive the conversation': '/progetta non funziona in incognito: le card resterebbero dopo la conversazione.',
  'only a plan is edited': 'Si modifica solo un piano.',
  'starts must be a list of card numbers': 'Le card da avviare non sono valide.',
  'starts are only for a plan': 'Le card da avviare valgono solo per un piano.',
  // The queue and «Ferma» (D-218).
  'this message is no longer in the queue': 'Questo messaggio non è più in coda.',
  'an answer is still at work: wait for it, or stop it': 'Una risposta è ancora in corso: aspetta che finisca, o premi Ferma.',
  // Incognito (D-136): the saves are off, "Termina" only for an incognito conversation.
  incognito: 'In una conversazione incognita non si salva niente in Arianna.',
  'not incognito': 'Questa conversazione non è incognita: non si termina.',
  busy: 'Il lavoro in corso non si è ancora fermato: riprova fra qualche secondo.',
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
  'project is not among the approved projects': 'Questo progetto non è fra quelli approvati: aggiungilo in Impostazioni → Progetti.',
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
  'note not found': 'Nota non trovata: forse è stata spostata o è sopra Privato.',
  'the note is too large to read': 'La nota è troppo grande per essere letta qui.',
  'the note is already organized': 'La nota è già stata riordinata.',
  'the note has no link': 'La nota non contiene un link da scaricare.',
  'the link is already downloaded': 'Il contenuto del link è già nella nota.',
  'the note cannot be organized again': 'Questa nota non si può riordinare di nuovo.',
  'notes cannot be organized now': 'Il riordino delle note non è disponibile adesso: manca il modello locale.',
  'status must be new or organized': 'Filtro di stato non valido.',
  // Images and files attached in the chat (D-247).
  'attachments go only in a private conversation: they never leave the Mac':
    'Gli allegati restano sul Mac: qui potrebbero leggerli Claude o ChatGPT. Allegali in una conversazione privata.',
  'attachments are off in incognito: nothing of it may stay': 'In incognito non si allega niente: non resterebbe nulla della conversazione.',
  'attachments go only in a private conversation with Arianna or the local model': 'Gli allegati vanno solo in una conversazione privata con Arianna o con il modello locale.',
  'an attachment cannot wait in the queue: send it when the answer is done': 'Gli allegati non si mettono in coda: mandali quando la risposta in corso è finita.',
  'no local model reads images: assign the vision role in the settings':
    'Nessun modello locale legge le immagini: in Impostazioni → Modelli scegli chi «Guarda le immagini allegate».',
  'an image is 10 MB at most': 'Un’immagine può essere al massimo di 10 MB.',
  'a text file is 256 KiB at most': 'Un file di testo può essere al massimo di 256 KiB: un testo più lungo va in una nota.',
  'the file must be a PNG, JPEG, WebP or GIF image, or a .txt, .md, .csv or .json text': 'Si allegano solo immagini PNG, JPEG, WebP o GIF e testi .txt, .md, .csv o .json.',
  'the text file is not UTF-8': 'Il file di testo non è in UTF-8.',
  'the text file contains a NUL character': 'Il file di testo contiene caratteri non validi.',
  'the text file is empty': 'Il file di testo è vuoto.',
  'an attachment was already sent or removed: attach it again': 'Un allegato è già stato mandato o tolto: allegalo di nuovo.',
  'the attachment was sent: it goes with its message': 'L’allegato è già nel messaggio: se ne va solo con la conversazione.',
  'a message carries 4 attachments at most': 'Al massimo 4 allegati per messaggio.',
  'the file of the attachment is missing': 'Il file dell’allegato non c’è più.',
  // Trials of a model (D-081).
  'the model is not in the catalog': 'Il modello non è nel catalogo.',
  'the catalog does not list this role for the model': 'Il catalogo non indica questo modello per l’orchestratore.',
  'the files of the model are not on the disk': 'I file del modello non sono sul disco: scaricali con pnpm arianna:models pull.',
  'no local endpoint in arianna.toml': 'Nessun server locale in arianna.toml: aggiungilo nelle impostazioni.',
  'a trial of this model is already queued or running': 'Una prova di questo modello è già in coda o in corso.',
};

/** A plan refused by the core (D-235: the edit in its card, the rows to start), in Italian; undefined for another error. */
export function planErrorText(message: string): string | undefined {
  const work = /^a work conversation cannot hold this plan \(([^)]*)\)/.exec(message);
  if (work?.[1] !== undefined) {
    const kinds = work[1].split(', ').map((kind) => SCANNER_KIND_TEXT[kind] ?? 'dati riservati');
    return `Il piano di una conversazione di lavoro non può contenere ${[...new Set(kinds)].join(', ')}: scrivilo in una conversazione privata.`;
  }
  const card = /^card (\d+)(:| )/.exec(message);
  if (card?.[1] !== undefined) {
    const which = `Card ${card[1]}`;
    if (/"blocked_by"/.test(message)) return `${which}: «bloccata da» può indicare solo card precedenti.`;
    if (/"assignee"/.test(message)) return `${which}: chi la fa dev’essere tu o un agente che Arianna può chiamare.`;
    if (/needs a title/.test(message)) return `${which}: manca il titolo (al massimo 120 caratteri).`;
    if (/needs a goal/.test(message)) return `${which}: manca l’obiettivo (al massimo 500 caratteri).`;
    if (/"criteria"/.test(message)) return `${which}: manca il criterio di completamento (al massimo 500 caratteri).`;
    if (/"complexity"/.test(message)) return `${which}: la complessità è S, M o L.`;
    return `${which} non è valida.`;
  }
  if (/^the plan needs a title/.test(message)) return 'Il piano vuole un titolo (al massimo 120 caratteri).';
  const size = /^a plan has (\d+) to (\d+) cards/.exec(message);
  if (size !== null) return `Un piano ha da ${size[1] ?? ''} a ${size[2] ?? ''} card.`;
  const mine = /^starts: card (\d+) is yours/.exec(message);
  if (mine?.[1] !== undefined) return `La card ${mine[1]} è tua: non parte da sola.`;
  if (/^starts: /.test(message)) return 'Le card da avviare non sono valide.';
  return undefined;
}

/**
 * «@name» refused by the core (D-299): a name nobody has, or an agent Arianna
 * cannot call here, with the reason; undefined for another error. The name is
 * as the user wrote it.
 */
function mentionErrorText(message: string): string | undefined {
  const unknown = /^no agent is called ([a-z][a-z0-9-]*)$/i.exec(message);
  if (unknown?.[1] !== undefined) return `Non conosco l’agente @${unknown[1]}: controlla il nome (il menu di @ mostra chi puoi chiamare), o scrivi senza @ per parlare con Arianna.`;
  const blocked = /^the agent ([a-z][a-z0-9-]*) (is off|answers only in its own chat|takes no delegated step)$/i.exec(message);
  const name = blocked?.[1];
  if (name === undefined) return undefined;
  if (blocked?.[2] === 'is off') return `L’agente @${name} è spento: accendilo in Impostazioni → Agenti per chiamarlo.`;
  if (blocked?.[2] === 'answers only in its own chat') return `@${name} risponde solo nella sua chat, non in una conversazione con Arianna.`;
  return `@${name} non prende lavori da Arianna: non ha un esecutore per i passi delegati.`;
}

/** An error of the API (or of the network) as the user reads it. */
export function errorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    // fetch fails with a TypeError when the core does not answer.
    return cause instanceof TypeError ? 'Arianna non risponde: controlla che sia avviata.' : 'Errore imprevisto.';
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
  const plan = planErrorText(cause.message);
  if (plan !== undefined) return plan;
  const mention = /^write what you ask ([a-z][a-z0-9-]*) after its name$/.exec(cause.message);
  if (mention?.[1] !== undefined) return `Scrivi dopo @${mention[1]} cosa gli chiedi.`;
  const blocked = mentionErrorText(cause.message);
  if (blocked !== undefined) return blocked;
  const queueFull = /^the queue already holds (\d+) messages/.exec(cause.message);
  if (queueFull?.[1] !== undefined) return `La coda ha già ${queueFull[1]} messaggi: aspetta le risposte.`;
  const length = /^the message is longer than (\d+) characters$/.exec(cause.message);
  if (length?.[1] !== undefined) return `Il messaggio supera ${length[1]} caratteri.`;
  if (/^the approval is already/.test(cause.message)) return 'Questa richiesta è già stata decisa.';
  if (/^the trial is already /.test(cause.message)) return 'Questa prova è già finita.';
  const note = /^text is longer than (\d+) KiB$/.exec(cause.message);
  if (note?.[1] !== undefined) return `La nota supera ${note[1]} KiB.`;
  if (/^kb\/inbox is labeled L\d: captures stop at L2$/.test(cause.message)) return 'La cartella kb/inbox è sopra Privato: la nota non è stata salvata.';
  if (cause.status === 403) return 'Arianna ha rifiutato la richiesta: apri la chat dal suo indirizzo.';
  if (cause.status >= 500) return 'Errore di Arianna: riprova fra poco.';
  return 'Richiesta non valida.';
}

// Errors of the orchestrator's tools (apps/core/src/orchestrator/kb.ts): fixed
// texts around a path the model chose.
const TOOL_ERRORS: [RegExp, (path: string) => string][] = [
  // web.fetch (D-262): the reason is already Italian, written by the core.
  [/^web · (.+)$/, (reason) => `pagina non letta: ${reason.charAt(0).toLowerCase()}${reason.slice(1).replace(/\.$/, '')}`],
  // The browser of Arianna (D-264): the reason is already Italian, written by the core.
  [/^browser · (.+)$/, (reason) => `browser: ${sentence(reason)}`],
  [/^(\S+) does not take delegated steps$/, (agent) => `${agentName(agent)} non accetta passi delegati`],
  [/^the user did not approve sending the brief to the cloud/, () => 'il brief non è stato approvato per il cloud'],
  [/^the user did not approve the budget for (\S+)/, (model) => `il budget per ${MODEL_TEXT[model] ?? model} non è stato approvato`],
  [/^the user did not want the Coder to work over uncommitted changes/, () => 'hai preferito non far lavorare il Coder sopra le tue modifiche non committate'],
  [/^the folder of (\S+) cannot be opened/, (repo) => `la cartella di ${repo} non si apre come repository git`],
  [/^no project for the Coder/, () => 'nessun progetto per il Coder: apri una conversazione di lavoro con un progetto approvato'],
  // D-303: the Coder in a private conversation, a work conversation without its project.
  [/^(\S+) does not work in a private conversation/, (agent) => `${agentName(agent)} non lavora nelle conversazioni Private: apri una conversazione di Lavoro con il progetto`],
  [/^this work conversation has no project/, () => 'questa conversazione di Lavoro non ha un progetto'],
  [/^the project of this work conversation is not among the approved projects/, () => 'il progetto di questa conversazione non è fra quelli approvati in cui l’agente può lavorare'],
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

/** A sentence of the core inside a line: lower-case initial, no final full stop. */
function sentence(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.$/, '')}`;
}

// The verbs of the browser lines (D-264): `browser · clic · <site>` reads «clic su <site>».
const BROWSER_VERB: Record<string, string> = { apre: 'apre', legge: 'legge', clic: 'clic su', scorre: 'scorre' };

/**
 * A line of Arianna's browser (D-264): `browser · apre · <site>`,
 * `browser · scrive 12 caratteri`, `browser · chiude`. Only the site is known,
 * never the whole address: no link.
 */
function browserLine(detail: string): string | undefined {
  const match = /^browser · (.+)$/.exec(detail);
  if (match?.[1] === undefined) return undefined;
  const [verb = '', ...rest] = match[1].split(' · ');
  const known = Object.hasOwn(BROWSER_VERB, verb) ? BROWSER_VERB[verb] : undefined;
  if (known !== undefined && rest.length > 0) return `browser: ${known} ${rest.join(' ')}`;
  return `browser: ${sentence([verb, ...rest].join(' '))}`;
}

function toolError(detail: string): string {
  for (const [pattern, text] of TOOL_ERRORS) {
    const match = pattern.exec(detail);
    if (match !== null) return text(match[1] ?? '');
  }
  return 'uno strumento ha restituito un errore';
}

/**
 * A page read with `web.fetch` (D-262): the detail is `web · <address>`, or
 * `web · <address> · <title>`. The address is a link only when it is whole
 * (the core cuts a long detail with «…») and http or https.
 */
function webPage(detail: string): { site: string; title?: string; url?: string } | undefined {
  const match = /^web · (\S+)(?: · (.+))?$/.exec(detail);
  if (match === null) return undefined;
  const [, address = '', title] = match;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const site = url.hostname.replace(/^www\./, '');
  const whole = !address.endsWith('…');
  return { site, ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }), ...(whole ? { url: url.href } : {}) };
}

/** The link of an activity line: the page a `web.fetch` read (D-262); none for every other line. */
export function activityLink(activity: Activity | SavedActivity): string | undefined {
  return activity.kind === 'read' ? webPage(activity.detail)?.url : undefined;
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
    case 'read': {
      const browser = browserLine(activity.detail);
      if (browser !== undefined) return browser;
      const page = webPage(activity.detail);
      if (page !== undefined) return page.title === undefined ? `Ho letto ${page.site}` : `Ho letto ${page.site} — ${page.title}`;
      return `Leggo ${activity.detail}`;
    }
    case 'write':
      return `Scrivo ${activity.detail}`;
    case 'card':
      return `Creo la card «${activity.detail}»`;
    case 'plan':
      return `Piano: ${activity.detail}`;
    case 'error':
      return `Errore: ${toolError(activity.detail)}, provo un’altra strada`;
    // An error that ends the task (D-250): the direct chat or a card, where no other way is tried.
    case 'stop':
      return `Errore: ${toolError(activity.detail)}`;
    case 'delegate':
      return delegateText(activity.detail);
    case 'tool':
      return browserLine(activity.detail) ?? `Il Coder usa ${TOOL_TEXT[activity.detail] ?? activity.detail}`;
    case 'wait':
      return waitText(activity.detail);
  }
}

// The kinds of tool a Codex run reports (D-140): it names no tool, only what it did.
const TOOL_TEXT: Record<string, string> = { command: 'il terminale', file_change: 'la modifica dei file' };

// `coder` when the step is handed over, `coder · claude/sonnet` when it starts.
function delegateText(detail: string): string {
  // `coder · skills-skipped · 2` (D-161): skills assigned that did not reach the delivery.
  const skipped = /^(\S+) · skills-skipped · (\d+)$/.exec(detail);
  if (skipped !== null) {
    const [, agent = '', count = '0'] = skipped;
    return count === '1'
      ? `1 skill del ${agentName(agent)} non entra nella consegna (oltre il limite o non più nel catalogo)`
      : `${count} skill del ${agentName(agent)} non entrano nella consegna (oltre il limite o non più nel catalogo)`;
  }
  // `coder · project-notes · 3 · 1` (D-166): notes of the project given to the run as a read-only copy, and those left local.
  const notes = /^(\S+) · project-notes · (\d+) · (\d+)$/.exec(detail);
  if (notes !== null) {
    const [, agent = '', given = '0', held = '0'] = notes;
    const read = given === '0' ? `Il ${agentName(agent)} non riceve note del progetto` : given === '1' ? `Il ${agentName(agent)} può leggere 1 nota interna del progetto` : `Il ${agentName(agent)} può leggere ${given} note interne del progetto`;
    return held === '0' ? read : `${read}; ${held === '1' ? '1 nota resta' : `${held} note restano`} sul Mac`;
  }
  // `designer · style-skipped · <slug>` (D-163): the style chosen on the card did not reach the delivery.
  const style = /^(\S+) · style-skipped · (\S+)$/.exec(detail);
  if (style !== null) {
    const [, agent = '', slug = ''] = style;
    return `Lo stile «${slug}» non entra nella consegna del ${agentName(agent)} (oltre il limite o non più nel catalogo): lavora senza`;
  }
  const started = /^(\S+) · (\w+)\/(\S+)$/.exec(detail);
  if (started === null) return `Passo delegato al ${agentName(detail)}`;
  const [, agent = '', executor = '', model = ''] = started;
  return `Il ${agentName(agent)} lavora su ${EXECUTOR_TEXT[executor] ?? executor} (${MODEL_TEXT[model] ?? model})`;
}

// `budget · fable`, or `claude · <ISO time>` for a quota.
function waitText(detail: string): string {
  const browser = browserLine(detail);
  if (browser !== undefined) return browser;
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

// «Con chi parli» (D-111, tappa B): the local model and the plain chats are named for what they are.
const AGENT_TEXT: Record<string, string> = { coder: 'Coder', arianna: 'Arianna', designer: 'Designer', god: 'GOD', finanze: 'Finanze', 'local-chat': 'Modello locale', claude: 'Claude', codex: 'ChatGPT' };

/** The agent as the user reads it. */
export function agentName(agent: string): string {
  return AGENT_TEXT[agent] ?? agent;
}

/** The agent as a title (D-158): its name with a capital initial, the id unchanged ("oroscopo" → "Oroscopo"). */
export function agentTitle(agent: string): string {
  const name = agentName(agent);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The descriptions of the official cards of `agents/` in Italian, for the
 * chat (D-158): the cards keep their English text, which the router reads.
 * Only the exact text of the card is translated: a description the user
 * changed is shown as it is.
 */
const OFFICIAL_DESCRIPTION: Record<string, { en: string; it: string }> = {
  arianna: { en: "Plans, assigns and reports; the user's main contact", it: 'Pianifica, assegna e riferisce; è la tua interlocutrice principale' },
  coder: { en: 'Writes and changes code in a worktree, with tests', it: 'Scrive e modifica il codice in un worktree, con i test' },
  'local-chat': {
    en: 'Chats on the local model with the knowledge base read only; nothing leaves this computer',
    it: 'Chat con il modello locale, con la base di conoscenza in sola lettura: niente esce dal Mac',
  },
  reviewer: { en: 'Reviews changes and their tests in a project, without changing files', it: 'Rivede le modifiche e i loro test in un progetto, senza cambiare file' },
  designer: { en: 'Designs pages and screens as self-contained HTML mockups in the project', it: 'Disegna pagine e schermate come mockup HTML autonomi nel progetto' },
  god: { en: 'Develops Arianna from inside Arianna, in a clone of its code', it: 'Sviluppa Arianna da dentro Arianna, in un clone del suo codice' },
};

/** The Italian text of an official card's description, while the card keeps its own; undefined otherwise. */
export function officialDescriptionIt(agent: string, description: string): string | undefined {
  const official = Object.hasOwn(OFFICIAL_DESCRIPTION, agent) ? OFFICIAL_DESCRIPTION[agent] : undefined;
  return official !== undefined && official.en === description.trim() ? official.it : undefined;
}

/** The description of an agent's card as the chat shows it: the Italian text of an official card, the card's own otherwise. */
export function agentDescription(agent: string, description: string): string {
  return officialDescriptionIt(agent, description) ?? description;
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
  interrupted: 'interrotta dal riavvio di Arianna',
  'lock-lost': 'interrotta: Arianna ha perso il controllo della coda',
  'not-in-catalog': 'il modello non è più nel catalogo',
  role: 'il catalogo non indica più il modello per l’orchestratore',
  'files-missing': 'i file del modello non sono sul disco',
  'no-endpoint': 'nessun server locale in arianna.toml',
};

/** Why a trial ended without an outcome; a code not listed gets a generic text. */
export function modelEvalErrorText(code: string | null): string | undefined {
  if (code === null) return undefined;
  const known = MODEL_EVAL_ERRORS[code];
  if (known !== undefined) return known;
  if (code.startsWith('LocalModelError')) return 'il modello locale non ha risposto';
  return 'errore di Arianna';
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

/** Above a diff: what it is compared against (D-117); the Coder may have changed files already changed before. */
export function baseCommitText(commit: string): string {
  return `Rispetto all’ultimo commit (${commit.slice(0, 7)}): se il file era già modificato prima del lavoro del Coder, si vedono anche quelle modifiche.`;
}

/** "+12 −3": lines added and removed (D-117). */
export function diffCountText(added: number, removed: number): string {
  return `+${String(added)} −${String(removed)}`;
}

/** What a live change of the Coder is (D-117, second stage). */
export const EDIT_TOOL_TEXT: Record<EditTool, string> = {
  Edit: 'modifica',
  MultiEdit: 'più modifiche',
  Write: 'scritto per intero',
};

/** Why the lines of a live change are not shown. */
export const LIVE_EDIT_ERROR_TEXT: Record<LiveEditError, string> = {
  'too-large': 'Modifica troppo grande da mostrare qui: il diff completo arriva a fine lavoro.',
  refused: 'Modifica non mostrata: contiene un valore del vault.',
};

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
export const MESSAGE_ABOVE_L2_TEXT = 'Il messaggio è Segreto: kb/inbox arriva fino a Privato, non l’ho salvato.';
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

/** Why an upload of a character sheet failed (D-118), in Italian; the reasons of the core are never shown as they are. */
export function uploadErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  const message = cause.message;
  if (cause.status === 413 || /KiB/.test(message)) return 'Il file supera 256 KiB: un foglio di personaggio è molto più piccolo.';
  if (/112×96 or 112×128/.test(message)) return 'Il foglio deve misurare 112×96 o 112×128 pixel (7 colonne di fotogrammi 16×32).';
  if (/^not a PNG$/.test(message)) return 'Il file non è un PNG.';
  if (/interlaced/.test(message)) return 'Il PNG è interlacciato: salvalo di nuovo senza interlacciamento.';
  if (/^name:/.test(message)) return 'Nome non valido: una riga di 1-40 caratteri, con almeno una lettera o una cifra.';
  if (/holds at most/.test(message)) return 'I tuoi personaggi sono già 32, il massimo del pacchetto miei: togline uno da data/characters/miei prima di caricarne un altro.';
  if (/belongs to another character/.test(message)) return 'Nel pacchetto miei un altro personaggio usa già il file di questo nome: scegli un nome diverso.';
  if (cause.status === 409) return 'La cartella data/characters/miei non è leggibile o il suo pack.json non è valido: controllala a mano.';
  if (cause.status === 400) return 'Il PNG è danneggiato o contiene parti non standard: esportalo di nuovo dall’editor come PNG semplice.';
  return errorText(cause);
}

/** The model of `[sprites]` (D-123), in the words of the page. */
export const SPRITE_MODEL_TEXT: Readonly<Record<string, string>> = { sonnet: 'Claude Sonnet', opus: 'Claude Opus', local: 'modello locale' };

/** Why a model cannot draw now, from the reason the core gives (D-123). */
export function spriteReasonText(reason: string): string {
  if (/not on in \[cloud\] executors/.test(reason)) return 'Claude non è attivo fra gli esecutori cloud (Impostazioni → Esecutori): attivalo o scegli il modello locale per i personaggi.';
  if (/is off in \[cloud\.models\]/.test(reason)) return 'Il modello scelto per i personaggi è spento in Impostazioni → Modelli: riaccendilo o scegline un altro.';
  if (/cannot run on this installation/.test(reason)) return 'Claude non può partire su questa installazione (sandbox rifiutata): scegli il modello locale per i personaggi.';
  if (/no local server serves/.test(reason)) return 'Nessun server dei modelli ha la mente di Arianna: configuralo in Server dei modelli o scegli Claude per i personaggi.';
  return 'Il modello scelto per i personaggi non è disponibile ora.';
}

/** A drawing refused or failed, in Italian; the core's message is never shown as it is (D-123). */
export function spriteErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  const message = cause.message;
  if (code === 'unavailable') return spriteReasonText(message);
  if (code === 'busy') return 'Sto già disegnando un personaggio: aspetta che finisca.';
  if (code === 'quota') {
    const resets = 'resetsAt' in cause && typeof cause.resetsAt === 'string' ? new Date(cause.resetsAt) : undefined;
    const when = resets === undefined || Number.isNaN(resets.getTime()) ? '' : ` Riprova dopo le ${resets.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.`;
    return `La quota di Claude è esaurita.${when}`;
  }
  if (code === 'blocked') return 'Il gateway ha fermato i testi verso il modello: togli dati personali o valori del vault dal nome, dalla descrizione, dal prompt o dal suggerimento.';
  if (code === 'bad-reply') return 'Il modello ha risposto con un disegno non valido: premi «Rigenera».';
  if (code === 'failed') return 'Il modello non ha risposto: riprova fra poco.';
  const personal = /^(name|description|prompt|hint) (looks like personal data|holds a value of the vault)/.exec(message);
  if (personal !== null) {
    const field: Record<string, string> = { name: 'Il nome', description: 'La descrizione', prompt: 'Il prompt', hint: 'Il suggerimento' };
    return `${field[personal[1] ?? ''] ?? 'Un testo'} sembra contenere dati personali o un valore del vault: non lo mando al modello.`;
  }
  if (/^(name|description): required/.test(message)) return 'Servono nome e descrizione dell’agente per disegnarlo.';
  if (/at most \d+ characters/.test(message)) return 'Un testo è troppo lungo: nome al massimo 40 caratteri, descrizione 200, prompt 4000, suggerimento 300.';
  if (/^(name|description): one line/.test(message)) return 'Nome e descrizione vanno su una riga sola.';
  // Fields or types the page never sends: a generic message, never the core's words.
  return 'La richiesta del disegno non è valida: ricarica la pagina e riprova.';
}

/**
 * The line of the thinking before an answer (D-249), as Claude Code writes
 * it: "Sta pensando… 7 s" while it thinks, then "Ha ragionato per 12 s".
 */
export function thoughtLineText(ms: number | null | undefined, live: boolean): string {
  // Never "0 s": a thought shorter than a second still took one.
  const shown = ms === null || ms === undefined ? undefined : durationText(Math.max(1000, ms));
  if (live) return shown === undefined ? 'Sta pensando…' : `Sta pensando… ${shown}`;
  return shown === undefined ? 'Ha ragionato' : `Ha ragionato per ${shown}`;
}
