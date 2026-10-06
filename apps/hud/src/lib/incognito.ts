import { MODEL_TEXT } from './labels.ts';
import type { ConversationMode } from './types.ts';

/** Bytes as the page says them ("3,2 kB"), as `sizeText` of projects.ts, which this module cannot import (api.ts imports this one). */
function sizeText(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace('.', ',')} kB`;
  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Incognito conversations (D-136, docs/I-4-incognito.md): a normal chat whose
 * texts the core deletes when it closes. The page keeps the id only in memory
 * and in the state of one history entry, always at the same address, so the
 * history never names the conversation. Pure: the store and the components use it.
 */
export const INCOGNITO_PATH = '/incognito';

export function isIncognitoPath(pathname: string): boolean {
  return pathname === INCOGNITO_PATH || pathname === `${INCOGNITO_PATH}/`;
}

/** Why an incognito conversation closed: "Termina", 10 minutes without a page, a restart of the core. */
export type CloseCause = 'user' | 'idle' | 'restart';

/**
 * What the history entry of `/incognito` holds: the choice of a draft not yet
 * sent, or the id of the conversation once created. Never a text.
 */
export type IncognitoEntry = { draft: { mode: ConversationMode; project?: string } } | { conversationId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The state written in the history entry (`history.state`). */
export function incognitoState(entry: IncognitoEntry): { incognito: IncognitoEntry } {
  return { incognito: entry };
}

/** The entry an `history.state` holds, or undefined for anything else (another page's state, a forged one). */
export function entryFromState(state: unknown): IncognitoEntry | undefined {
  if (!isRecord(state) || !isRecord(state.incognito)) return undefined;
  const entry = state.incognito;
  if (typeof entry.conversationId === 'string' && UUID.test(entry.conversationId)) return { conversationId: entry.conversationId.toLowerCase() };
  if (isRecord(entry.draft)) {
    const { mode, project } = entry.draft;
    if (mode === 'private') return { draft: { mode } };
    if (mode === 'work') return { draft: { mode, ...(typeof project === 'string' && project.trim() !== '' ? { project: project.trim() } : {}) } };
  }
  return undefined;
}

/** What the core says before the first message (GET /api/incognito/notice): whether anything may reach the cloud, and the project. */
export interface IncognitoNotice {
  cloud: boolean;
  project: string | null;
}

export function parseNotice(body: unknown): IncognitoNotice | undefined {
  if (!isRecord(body) || typeof body.cloud !== 'boolean') return undefined;
  const { project } = body;
  if (project !== null && typeof project !== 'string') return undefined;
  return { cloud: body.cloud, project: project === null || project.trim() === '' ? null : project };
}

/**
 * The notice while the core has not answered (or cannot): a work conversation
 * is taken as one that reaches Claude, so the card never says less than true.
 */
export function assumedNotice(mode: ConversationMode, project: string | undefined): IncognitoNotice {
  return { cloud: mode === 'work', project: mode === 'work' && project !== undefined && project !== '' ? project : null };
}

const DELETED = 'Alla chiusura Arianna cancella testi, riassunti e attività.';
const AUDIT =
  "Restano: l'ora e il numero dei passi nel registro di sicurezza, senza testo; nel database i byte cancellati restano illeggibili ad Arianna finché non vengono sovrascritti (il disco cifrato li protegge).";

/** "Cosa resta fuori da Arianna", before the first message: the sentences of docs/I-4-incognito.md, by mode. */
export function noticeLines(notice: IncognitoNotice): string[] {
  const lines = [notice.cloud ? 'Ciò che il Coder riceve va a Claude (Anthropic) e resta presso di loro secondo il tuo abbonamento.' : 'Niente esce dal Mac.', DELETED];
  if (notice.project !== null) lines.push(`I file che il Coder cambia nel progetto ${notice.project} restano.`);
  if (notice.cloud) lines.push('Claude Code non salva la sessione.');
  lines.push(AUDIT);
  return lines;
}

/** The answer of POST /api/conversations/:id/end. */
export interface EndResult {
  deleted: { messages: number; tasks: number; summaries: number };
  remains: { files: { project: string; path: string }[]; cloud: { model: string; bytes: number }[] };
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The answer of "Termina", or undefined when it is not the shape of the contract (the card then says less). */
export function parseEndResult(body: unknown): EndResult | undefined {
  if (!isRecord(body) || !isRecord(body.deleted) || !isRecord(body.remains)) return undefined;
  const { messages, tasks, summaries } = body.deleted;
  if (!count(messages) || !count(tasks) || !count(summaries)) return undefined;
  const { files, cloud } = body.remains;
  if (!Array.isArray(files) || !Array.isArray(cloud)) return undefined;
  const parsedFiles: EndResult['remains']['files'] = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.project !== 'string' || typeof file.path !== 'string' || file.path === '') return undefined;
    parsedFiles.push({ project: file.project, path: file.path });
  }
  const parsedCloud: EndResult['remains']['cloud'] = [];
  for (const sent of cloud) {
    if (!isRecord(sent) || typeof sent.model !== 'string' || !count(sent.bytes)) return undefined;
    parsedCloud.push({ model: sent.model, bytes: sent.bytes });
  }
  return { deleted: { messages, tasks, summaries }, remains: { files: parsedFiles, cloud: parsedCloud } };
}

function counted(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** "Cancellati: 14 messaggi, 3 passi, 1 riassunto." */
export function deletedText(deleted: EndResult['deleted']): string {
  return `Cancellati: ${counted(deleted.messages, 'messaggio', 'messaggi')}, ${counted(deleted.tasks, 'passo', 'passi')}, ${counted(deleted.summaries, 'riassunto', 'riassunti')}.`;
}

/** How many paths of one project the card names before "e altri N". */
const MAX_PATHS = 6;

/**
 * "Restano fuori: 2 file cambiati in sito-demo (index.html, style.css); 1 invio
 * a Claude Opus (3,2 kB)." Files grouped by project, sends by model; nothing
 * left outside is said as such.
 */
export function remainsText(remains: EndResult['remains']): string {
  const parts: string[] = [];
  const byProject = new Map<string, string[]>();
  for (const file of remains.files) {
    const paths = byProject.get(file.project) ?? [];
    if (!paths.includes(file.path)) paths.push(file.path);
    byProject.set(file.project, paths);
  }
  for (const [project, paths] of byProject) {
    const shown = paths.slice(0, MAX_PATHS).join(', ');
    const more = paths.length > MAX_PATHS ? ` e altri ${String(paths.length - MAX_PATHS)}` : '';
    const where = project === '' ? '' : ` in ${project}`;
    parts.push(`${counted(paths.length, 'file cambiato', 'file cambiati')}${where} (${shown}${more})`);
  }
  const byModel = new Map<string, { sends: number; bytes: number }>();
  for (const sent of remains.cloud) {
    const total = byModel.get(sent.model) ?? { sends: 0, bytes: 0 };
    byModel.set(sent.model, { sends: total.sends + 1, bytes: total.bytes + sent.bytes });
  }
  for (const [model, total] of byModel) {
    parts.push(`${counted(total.sends, 'invio', 'invii')} a ${MODEL_TEXT[model] ?? model} (${sizeText(total.bytes)})`);
  }
  return parts.length === 0 ? 'Fuori da Arianna non resta niente di questa conversazione.' : `Restano fuori: ${parts.join('; ')}.`;
}

/** The lines of the closing card, from the core's answer; without one, what is sure. */
export function closingLines(result: EndResult | undefined): string[] {
  if (result === undefined) return ['La conversazione è chiusa e i suoi testi cancellati.', AUDIT];
  const lines = [deletedText(result.deleted), remainsText(result.remains)];
  if (result.remains.files.length > 0) lines.push('Se il Coder è stato fermato a metà, i file sono come li ha lasciati: guarda git status nel progetto.');
  lines.push("Restano anche l'ora e il numero dei passi nel registro di sicurezza, senza testo.");
  return lines;
}

/**
 * What the page says of an incognito conversation it can no longer show (its
 * texts are already gone from the page). `gone`: found closed (back, reload);
 * `lost`: found closed when the link came back, so the page cannot tell
 * whether the core restarted or waited 10 minutes.
 */
export function closedText(cause: CloseCause | 'gone' | 'lost'): string {
  switch (cause) {
    case 'lost':
      return 'Conversazione incognita chiusa mentre la pagina era scollegata (riavvio di Arianna o 10 minuti senza pagina): Arianna ne ha cancellato i testi.';
    case 'idle':
      return 'Conversazione incognita chiusa dopo 10 minuti senza una pagina aperta: Arianna ne ha cancellato i testi.';
    case 'restart':
      return 'Conversazione incognita chiusa al riavvio di Arianna: Arianna ne ha cancellato i testi.';
    case 'user':
    case 'gone':
      return 'Questa conversazione incognita è chiusa.';
  }
}

/** The warning a minute before the closing for inactivity. */
export function closingSoonText(seconds: number): string {
  const when = seconds <= 90 ? 'fra 1 minuto' : `fra ${String(Math.round(seconds / 60))} minuti`;
  return `Questa conversazione incognita si chiude ${when} se nessuna pagina la tiene aperta: questa pagina l'ha appena segnalata ad Arianna.`;
}

/**
 * The cause the core gives with the 404 of an incognito conversation it
 * deleted (`closed` in the body); undefined for any other 404.
 */
export function closedCause(body: unknown): CloseCause | undefined {
  if (!isRecord(body)) return undefined;
  const { closed } = body;
  return closed === 'user' || closed === 'idle' || closed === 'restart' ? closed : undefined;
}

/** What an approval says of its conversation (D-136): optional, a core without incognito sends neither. */
interface ApprovalPlace {
  taskId: string | null;
  incognito?: boolean | undefined;
  conversationId?: string | null | undefined;
}

/** Approvals with no incognito ones: for every place outside the page of their conversation ("Decisioni in attesa", the office, the notes). */
export function withoutIncognito<T extends ApprovalPlace>(approvals: readonly T[]): T[] {
  return approvals.filter((approval) => approval.incognito !== true);
}

/**
 * The approvals of the open conversation (by its tasks, or by the id the core
 * gives) and those shown elsewhere: an incognito one is never elsewhere, nor
 * counted there.
 */
export function splitApprovals<T extends ApprovalPlace>(
  approvals: readonly T[],
  openTasks: ReadonlySet<string>,
  openConversation: string | null | undefined,
): { inChat: T[]; elsewhere: T[] } {
  const inChat: T[] = [];
  const elsewhere: T[] = [];
  for (const approval of approvals) {
    const here =
      (approval.taskId !== null && openTasks.has(approval.taskId)) ||
      (openConversation !== null && openConversation !== undefined && approval.conversationId === openConversation);
    if (here) inChat.push(approval);
    else if (approval.incognito !== true) elsewhere.push(approval);
  }
  return { inChat, elsewhere };
}

/** How many times "Termina" is asked again while the core stops the work, and how long it waits each time. */
export const END_RETRIES = 4;
export const END_RETRY_MS = 1500;

/**
 * Whether "Termina" is asked again after a failure, and after how long: only
 * for the 409 of a conversation still stopping its work, a few times; any
 * other error is said at once.
 */
export function endRetryDelay(status: number, message: string, attempt: number): number | undefined {
  if (status !== 409 || !message.startsWith('the conversation is still at work') || attempt >= END_RETRIES) return undefined;
  return END_RETRY_MS;
}

/** Why "Salva in inbox" and "/nota" are off in incognito: said over the button, and as the error of the command. */
export const SAVE_OFF_HINT = 'Spento in incognito: niente di questa conversazione si salva in Arianna. "Copia" funziona.';
export const NOTE_OFF_TEXT = 'In una conversazione incognita /nota è spento: niente si salva in kb/inbox. Usa "Copia" per tenere un testo.';

/** Why a draft is not sent from an incognito conversation: "/nota" would write in kb/inbox. */
export function noteRefusal(isNote: boolean, incognito: boolean): string | undefined {
  return isNote && incognito ? NOTE_OFF_TEXT : undefined;
}

/** The confirmation of "Termina". */
export const END_CONFIRM_TEXT = 'Terminare la conversazione incognita? Arianna ferma il lavoro in corso e cancella testi, riassunti e attività. Non si può annullare.';

/**
 * What a frame of the live feed about incognito means for the page: the open
 * conversation (or the one the draft created) closed, closes soon, or nothing.
 */
export type IncognitoSignal =
  | { type: 'conversation.incognito-closed'; conversationId: string; cause: CloseCause }
  | { type: 'conversation.incognito-closing'; conversationId: string; inSeconds: number };

export function incognitoAction(signal: IncognitoSignal, ours: readonly (string | null | undefined)[], ended: ReadonlySet<string>): 'closed' | 'closing' | 'ignore' {
  if (!ours.includes(signal.conversationId)) return 'ignore';
  // "Termina" on this page: its card with the counts stays, the feed only confirms.
  if (ended.has(signal.conversationId)) return 'ignore';
  return signal.type === 'conversation.incognito-closed' ? 'closed' : 'closing';
}

/** The frame of the live feed, or undefined when malformed. */
export function parseIncognitoFrame(value: Record<string, unknown>): IncognitoSignal | undefined {
  const { type, conversationId } = value;
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return undefined;
  const id = conversationId.toLowerCase();
  if (type === 'conversation.incognito-closed') {
    const { cause } = value;
    if (cause !== 'user' && cause !== 'idle' && cause !== 'restart') return undefined;
    return { type, conversationId: id, cause };
  }
  if (type === 'conversation.incognito-closing') {
    const { inSeconds } = value;
    if (!count(inSeconds)) return undefined;
    return { type, conversationId: id, inSeconds };
  }
  return undefined;
}
