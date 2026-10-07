/**
 * The actions of Impostazioni → Modelli on a local model (I-3, stage M4,
 * D-137): download, verify, unload from the memory, remove from the disk
 * into the bin, empty the bin. Every one asks for a confirmation that says
 * what happens (how much, which folder); a removal needs the id typed. The
 * rules of the buttons and the texts are here; the page draws them.
 */
import { ApiError } from './api.ts';
import { errorText } from './italian.ts';
import { ROLE_NAME, sizeText, type LocalModelView } from './models-page.ts';

/** A role as the core names it, in Italian; an unknown one as it is. */
function roleText(role: string): string {
  return (ROLE_NAME as Record<string, string | undefined>)[role] ?? role;
}

export type ActionKind = 'download' | 'verify';
export type ActionStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** A download or verification, as GET /api/models/overview gives it (model-actions.ts in the core). */
export interface ModelAction {
  modelId: string;
  kind: ActionKind;
  status: ActionStatus;
  bytesDone: number;
  bytesTotal: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  bad: string[];
}

export interface TrashView {
  folder: string;
  entries: { name: string; sizeBytes: number }[];
  sizeBytes: number;
}

export type ButtonKind = 'download' | 'verify' | 'unload' | 'remove' | 'cancel';

export interface ActionButton {
  kind: ButtonKind;
  text: string;
  /** Why it cannot be pressed now; undefined: it can. */
  blocked?: string;
  danger?: true;
}

/** What a confirmation shows: the title, what happens, the button, and the word to type when there is one. */
export interface Confirmation {
  kind: ButtonKind | 'empty-trash';
  modelId: string | null;
  title: string;
  lines: string[];
  button: string;
  danger: boolean;
  /** The text the user must type to confirm (the model id for a removal). */
  typed?: string;
}

const folderOf = (id: string): string => `data/models/${id}`;
const TRASH = 'data/models/eliminati';

/** The action running anywhere, which holds every other download or verification. */
export function runningAction(local: readonly LocalModelView[]): ModelAction | undefined {
  return local.map((view) => view.action).find((action): action is ModelAction => action?.status === 'running');
}

/** The last verification found wrong files and they are still to replace. */
function wrongFiles(view: LocalModelView): string[] {
  return view.action?.kind === 'verify' && view.action.status === 'done' ? view.action.bad : [];
}

function roleNames(view: LocalModelView): string {
  return view.roles.map(roleText).join(', ');
}

/** The buttons of the card of a local model, in order, with the reason when one cannot be pressed. */
export function actionButtons(view: LocalModelView, running?: ModelAction): ActionButton[] {
  if (view.action?.status === 'running') {
    return [{ kind: 'cancel', text: view.action.kind === 'download' ? 'Ferma lo scaricamento' : 'Ferma la verifica' }];
  }
  const other = running === undefined ? undefined : `Aspetta la fine: ${running.kind === 'download' ? 'sto scaricando' : 'sto verificando'} ${running.modelId}.`;
  const buttons: ActionButton[] = [];
  const wrong = wrongFiles(view);
  if (view.missingBytes > 0 || wrong.length > 0) {
    const text = wrong.length > 0 && view.missingBytes === 0 ? 'Riscarica i file sbagliati' : view.hasFiles && view.missingBytes < view.sizeBytes ? 'Riprendi lo scaricamento' : 'Scarica';
    buttons.push({ kind: 'download', text, ...(other === undefined ? {} : { blocked: other }) });
  }
  if (view.present) buttons.push({ kind: 'verify', text: 'Verifica', ...(other === undefined ? {} : { blocked: other }) });
  if (view.loaded.length > 0) {
    const busy = view.loaded.some((place) => place.busy);
    buttons.push({ kind: 'unload', text: 'Scarica dalla memoria', ...(busy ? { blocked: 'Una richiesta lo sta usando adesso.' } : {}) });
  }
  if (view.hasFiles) {
    const blocked =
      view.roles.length > 0
        ? `Ha il ruolo ${roleNames(view)}: prima assegna il ruolo a un altro modello e salva.`
        : view.loaded.length > 0
          ? 'È in memoria: prima scaricalo dalla memoria.'
          : undefined;
    buttons.push({ kind: 'remove', text: 'Togli dal disco…', danger: true, ...(blocked === undefined ? {} : { blocked }) });
  }
  return buttons;
}

/** Why some buttons cannot be pressed, each reason once. */
export function blockedReasons(buttons: readonly ActionButton[]): string[] {
  return [...new Set(buttons.map((button) => button.blocked).filter((reason): reason is string => reason !== undefined))];
}

/** The size of what is on the disk for a model, from the catalog and what is missing. */
function onDisk(view: LocalModelView): number {
  return Math.max(0, view.sizeBytes - view.missingBytes);
}

/** The confirmation of an action on a model: what happens, how much, where. */
export function confirmationOf(kind: ButtonKind, view: LocalModelView): Confirmation {
  const id = view.id;
  switch (kind) {
    case 'download': {
      const wrong = wrongFiles(view);
      const lines = [
        `Scarica ${sizeText(Math.max(view.missingBytes, 1))}${view.missingBytes < view.sizeBytes && view.missingBytes > 0 ? ` (di ${sizeText(view.sizeBytes)}: il resto è già sul disco)` : ''} in ${folderOf(id)}, solo dagli indirizzi del catalogo.`,
        'Ogni file si controlla con lo sha256 del catalogo; se si interrompe, riprende da dove era arrivato.',
        'Dal Mac esce solo la richiesta dei file pubblici del modello, nessun tuo dato.',
      ];
      if (wrong.length > 0) lines.splice(1, 0, `I file sbagliati (${wrong.join(', ')}) vanno nel cestino ${TRASH} e si riscaricano.`);
      return { kind, modelId: id, title: `Scaricare ${id}?`, lines, button: 'Scarica', danger: false };
    }
    case 'verify':
      return {
        kind,
        modelId: id,
        title: `Verificare ${id}?`,
        lines: [`Rilegge ${sizeText(view.sizeBytes)} in ${folderOf(id)} e confronta lo sha256 di ogni file con il catalogo.`, 'Con file grandi il disco lavora per qualche minuto; non cambia nulla.'],
        button: 'Verifica',
        danger: false,
      };
    case 'unload': {
      const gib = view.loaded.reduce((total, place) => total + (place.gib ?? 0), 0);
      const where = view.loaded.map((place) => place.endpoint).join(', ');
      return {
        kind,
        modelId: id,
        title: `Scaricare ${id} dalla memoria?`,
        lines: [
          `Il server locale (${where}) lo toglie dalla memoria${gib > 0 ? `: si liberano circa ${gib.toLocaleString('it-IT', { maximumFractionDigits: 1 })} GiB` : ''}. I file restano sul disco.`,
          view.roles.length > 0 ? `Ha il ruolo ${roleNames(view)}: la prossima richiesta lo ricarica, e la prima risposta arriva più lenta.` : 'Nessun ruolo lo usa: resta fuori dalla memoria finché non serve.',
        ],
        button: 'Scarica dalla memoria',
        danger: false,
      };
    }
    case 'remove':
      return {
        kind,
        modelId: id,
        title: `Togliere ${id} dal disco?`,
        lines: [
          `Sposta ${sizeText(Math.max(onDisk(view), 1))} da ${folderOf(id)} al cestino ${TRASH}: non cancella niente.`,
          'Lo spazio si libera solo con «Svuota il cestino». Per riaverlo si riscarica, o si rimette a mano dal cestino.',
        ],
        button: 'Togli dal disco',
        danger: true,
        typed: id,
      };
    case 'cancel':
      return {
        kind,
        modelId: id,
        title: view.action?.kind === 'verify' ? `Fermare la verifica di ${id}?` : `Fermare lo scaricamento di ${id}?`,
        lines: view.action?.kind === 'verify' ? ['La verifica si ferma; si può rifare quando vuoi.'] : ['Quello già scaricato resta sul disco: «Riprendi lo scaricamento» parte da lì.'],
        button: 'Ferma',
        danger: false,
      };
  }
}

/** The confirmation of "Svuota il cestino": how many folders, how much, never undone. */
export function emptyTrashConfirmation(trash: TrashView): Confirmation {
  const count = trash.entries.length === 1 ? '1 cartella' : `${String(trash.entries.length)} cartelle`;
  return {
    kind: 'empty-trash',
    modelId: null,
    title: 'Svuotare il cestino dei modelli?',
    lines: [`Cancella per sempre ${count} in ${trash.folder}: ${sizeText(Math.max(trash.sizeBytes, 1))}.`, 'Non si può annullare: per riavere un modello bisogna riscaricarlo.'],
    button: 'Svuota il cestino',
    danger: true,
  };
}

/** The confirm button can be pressed: the typed word matches when one is asked. */
export function canConfirm(confirmation: Confirmation, typed: string): boolean {
  return confirmation.typed === undefined || typed.trim() === confirmation.typed;
}

/** "4,1 GB di 16,1 GB · 25%". */
export function progressOf(action: ModelAction): { ratio: number; text: string } {
  const ratio = action.bytesTotal > 0 ? Math.min(1, action.bytesDone / action.bytesTotal) : 0;
  const verb = action.kind === 'download' ? 'Scarico' : 'Verifico';
  return { ratio, text: `${verb}: ${sizeText(Math.max(action.bytesDone, 1))} di ${sizeText(Math.max(action.bytesTotal, 1))} · ${String(Math.floor(ratio * 100))}%` };
}

/** Codes of a failed download or verification (ModelError in the core), in Italian. */
const FAILURE_TEXT: Record<string, string> = {
  network: 'la connessione si è interrotta; quello scaricato resta e si riprende da lì',
  'http-status': 'il server dei modelli ha rifiutato la richiesta',
  'wrong-hash': 'lo sha256 non corrisponde al catalogo: file scartato',
  'wrong-size': 'il file è arrivato incompleto; si riprende da lì',
  'too-large': 'il file è più grande di quanto dice il catalogo: scartato',
  redirects: 'troppi rimandi del server dei modelli',
  'insecure-url': 'un indirizzo non HTTPS è stato rifiutato',
  cancelled: 'fermato da te',
  aborted: 'fermato',
};

/** What the last action of a model ended with; undefined while it runs or with none. */
export function outcomeText(action: ModelAction | null): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } | undefined {
  if (action === null || action.status === 'running') return undefined;
  if (action.kind === 'download') {
    if (action.status === 'done') return { text: 'Scaricato: tutti i file corrispondono al catalogo.', tone: 'ok' };
    if (action.status === 'cancelled') return { text: 'Scaricamento fermato: quello già scaricato resta sul disco.', tone: 'muted' };
    return { text: `Scaricamento non riuscito: ${FAILURE_TEXT[action.error ?? ''] ?? 'errore del nucleo'}.`, tone: 'danger' };
  }
  if (action.status === 'done') {
    return action.bad.length === 0
      ? { text: 'Verifica riuscita: ogni file corrisponde allo sha256 del catalogo.', tone: 'ok' }
      : { text: `Verifica: ${action.bad.length === 1 ? 'un file non corrisponde' : `${String(action.bad.length)} file non corrispondono`} al catalogo (${action.bad.join(', ')}). Riscaricali.`, tone: 'warn' };
  }
  if (action.status === 'cancelled') return { text: 'Verifica fermata.', tone: 'muted' };
  return { text: `Verifica non riuscita: ${FAILURE_TEXT[action.error ?? ''] ?? 'il nucleo non ha potuto leggere i file'}.`, tone: 'danger' };
}

/** The refusals of the core (model-actions.ts, in English), in Italian; anything else as errorText says it. */
const REFUSALS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^the model has the role (.+): give the role to another model first$/, (match) => `Il modello ha il ruolo ${(match[1] ?? '').split(', ').map(roleText).join(', ')}: prima assegna il ruolo a un altro modello e salva.`],
  [/^a (download|verification) of (\S+) is running/, (match) => `Aspetta la fine: ${match[1] === 'download' ? 'sto scaricando' : 'sto verificando'} ${match[2] ?? ''}.`],
  [/^every file is already on the disk/, () => 'I file sono già tutti sul disco: se ne dubiti, verificali.'],
  [/^not enough free space/, () => 'Non c’è abbastanza spazio libero sul disco per scaricarlo.'],
  [/^some files are missing or partial/, () => 'Mancano dei file o sono a metà: prima scaricali.'],
  [/^nothing is running for this model/, () => 'Non c’è niente in corso per questo modello.'],
  [/^removal needs the id of the model/, () => 'Per confermare scrivi l’id esatto del modello.'],
  [/^a download or verification of the model is running/, () => 'Prima ferma lo scaricamento o la verifica in corso.'],
  [/^the model is loaded in memory/, () => 'Il modello è in memoria: prima scaricalo dalla memoria.'],
  [/^a trial of the model is queued or running/, () => 'Una prova del modello è in coda o in corso: prima annullala.'],
  [/^the model has no files on the disk/, () => 'Sul disco non c’è niente di questo modello.'],
  [/^the model is not in the catalog/, () => 'Il modello non è nel catalogo.'],
  [/^the model is not loaded by Arianna/, () => 'Arianna non ha questo modello in memoria.'],
  [/^a request (or a call )?is using the model now/, () => 'Una richiesta o una chiamata lo sta usando adesso: riprova quando finisce.'],
  [/^emptying the bin needs the confirmation/, () => 'Svuotare il cestino chiede la tua conferma.'],
  [/ is not a folder$/, () => 'data/models/eliminati non è una cartella: sistemala a mano.'],
];

export function actionErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of REFUSALS) {
      const match = pattern.exec(cause.message);
      if (match !== null) return text(match);
    }
  }
  return errorText(cause);
}

/** "Il cestino è vuoto", "2 cartelle, 16,1 GB". */
export function trashText(trash: TrashView): string {
  if (trash.entries.length === 0) return 'Il cestino è vuoto.';
  const count = trash.entries.length === 1 ? '1 cartella' : `${String(trash.entries.length)} cartelle`;
  return `${count}, ${sizeText(Math.max(trash.sizeBytes, 1))}`;
}
