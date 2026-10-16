import type { ChartData } from './chart.ts';
import type { Conversation, Label, Message } from './types.ts';

/**
 * Dashboard personale (D-248, idea 6 of OpenWork; «Fisso + Aggiorna a mano»):
 * the answers pinned from the chat, as tiles. «Aggiorna» asks the question of
 * the tile again on the local model only; the label of a tile only goes up.
 * Pure helpers and the texts of the page: the tests need no browser.
 */

export type TileWidth = 'narrow' | 'wide';
export type RefreshState = 'idle' | 'running' | 'failed';
export type RefreshError = 'failed' | 'timeout' | 'question' | 'empty' | 'lost' | 'chart';
export type AnsweredBy = 'local' | 'claude' | 'codex';
/** A tile shows its answer in words or as a chart (migration 0076). */
export type TileKind = 'text' | 'chart';

/** A tile as GET /api/dashboard/tiles gives it (dates as text). */
export interface DashboardTile {
  id: string;
  title: string;
  question: string;
  questionLabel: Label;
  body: string;
  label: Label;
  sourceConversationId: string;
  sourceMessageId: string;
  sourceTitle: string | null;
  sourceArchived: boolean;
  answeredBy: AnsweredBy;
  originCloud: boolean;
  width: TileWidth;
  kind: TileKind;
  chart: ChartData | null;
  position: number;
  refreshedAt: string;
  refreshState: RefreshState;
  refreshError: RefreshError | null;
  refreshStartedAt: string | null;
  createdAt: string;
}

/** What «Fissa» proposes (POST /api/dashboard/suggest). */
export interface Suggestion {
  title: string;
  question: string;
  label: Label;
  fallback: boolean;
}

export const DASHBOARD_TITLE = 'Dashboard';
export const DASHBOARD_PRIVACY = 'La Dashboard si vede solo qui. «Aggiorna» rifà la domanda al modello locale: niente esce verso il cloud.';
export const DASHBOARD_EMPTY_TITLE = 'La Dashboard è vuota';
export const DASHBOARD_EMPTY_TEXT = 'Su una risposta in chat scegli «Fissa alla Dashboard»: la ritrovi qui, con la data e un pulsante per aggiornarla.';
export const DASHBOARD_LOAD_ERROR = 'Non riesco a leggere la Dashboard.';
export const REFRESH_ALL_TEXT = 'Aggiorna tutti';
export const REFRESH_ALL_HINT = 'Rifà al modello locale la domanda di ogni riquadro, uno alla volta';

export const PIN_TEXT = 'Fissa alla Dashboard';
export const PIN_HINT = 'Tieni questa risposta nella Dashboard, con un pulsante per aggiornarla col modello locale';
export const PINNED_TEXT = 'Fissato · Apri nella Dashboard';
export const PIN_DIALOG_TITLE = 'Fissa alla Dashboard';
export const PIN_CONFIRM = 'Fissa';
export const PIN_TITLE_LABEL = 'Titolo';
export const PIN_QUESTION_LABEL = 'Domanda per gli aggiornamenti';
export const PIN_QUESTION_HINT = '«Aggiorna» rifà questa domanda al modello locale, da sola, senza il resto della conversazione: deve capirsi senza contesto.';
export const PIN_SUGGESTING = 'Il modello locale riscrive la domanda perché si capisca da sola…';
export const PIN_FALLBACK = 'Il modello locale non ha riscritto la domanda: è il tuo messaggio, controllalo.';
export const PIN_WIDTH_LABEL = 'Larghezza';
export const PIN_LABEL_NOTE = 'come la risposta; nella Dashboard non si abbassa';

export const WIDTH_TEXT: Record<TileWidth, string> = { narrow: 'Stretta', wide: 'Larga' };
export const KIND_TEXT: Record<TileKind, string> = { text: 'Testo', chart: 'Grafico' };
export const PIN_KIND_LABEL = 'Mostra come';
export const PIN_KIND_HINT = 'Grafico: a ogni «Aggiorna» il modello locale trasforma la risposta in dati (barre, linee o torta).';
export const EDIT_QUESTION_TEXT = 'Modifica la domanda';
export const SAVE_TEXT = 'Salva';
export const SAVE_REFRESH_TEXT = 'Salva e aggiorna';
export const CHART_MISSING_TEXT = 'Il grafico non c’è ancora: «Aggiorna» lo chiede al modello locale.';

export const REFRESH_TEXT = 'Aggiorna';
export const REFRESH_LOCAL_TEXT = 'Aggiorna in locale';
export const RETRY_TEXT = 'Riprova';
export const CANCEL_TEXT = 'Annulla';
export const REFRESHING_TEXT = 'Aggiorno col modello locale…';
export const REMOVE_TEXT = 'Togli dalla Dashboard';
export const REMOVE_CONFIRM_TEXT = 'Togliere il riquadro? La conversazione d’origine resta com’è.';
export const REMOVED_TEXT = 'Riquadro tolto.';
export const SECRET_NO_REFRESH = 'Segreto: nessun modello lo legge, quindi non si aggiorna.';

/** Why a refresh failed, in plain words. */
export const REFRESH_ERROR_TEXT: Record<RefreshError, string> = {
  failed: 'il modello locale non è riuscito a rispondere (spento o in errore)',
  timeout: 'il modello locale non ha risposto in 15 minuti',
  question: 'per rispondere voleva chiederti qualcosa: aggiorna dalla conversazione',
  empty: 'la risposta era vuota',
  lost: 'l’aggiornamento si è interrotto',
  chart: 'il modello locale non ha dato dati validi per il grafico',
};

/** Who wrote the body now, for the foot of the tile. */
export function answeredByText(tile: Pick<DashboardTile, 'answeredBy'>): string {
  return tile.answeredBy === 'claude' ? 'Claude · cloud' : tile.answeredBy === 'codex' ? 'ChatGPT · cloud' : 'Modello locale';
}

/** The line that says a tile born in the cloud is refreshed in local, or null. */
export function cloudNote(tile: Pick<DashboardTile, 'originCloud' | 'answeredBy'>): string | null {
  if (!tile.originCloud) return null;
  return tile.answeredBy === 'local'
    ? 'La prima risposta veniva dal cloud: gli aggiornamenti li fa il modello locale.'
    : `La prima risposta è di ${tile.answeredBy === 'codex' ? 'ChatGPT' : 'Claude'}. «Aggiorna in locale» rifà la domanda al modello locale, senza la sessione cloud: la risposta può essere più breve.`;
}

/** The label of «Aggiorna» on a tile. */
export function refreshButtonText(tile: Pick<DashboardTile, 'originCloud' | 'answeredBy' | 'refreshState'>): string {
  if (tile.refreshState === 'failed') return RETRY_TEXT;
  return tile.originCloud && tile.answeredBy !== 'local' ? REFRESH_LOCAL_TEXT : REFRESH_TEXT;
}

/** Whether a tile can be refreshed now: never Segreto, never twice at once. */
export function canRefresh(tile: Pick<DashboardTile, 'label' | 'refreshState'>): boolean {
  return tile.label !== 'L3' && tile.refreshState !== 'running';
}

/** Whether the answers of this conversation offer «Fissa alla Dashboard»: never incognito, a trial, a character chat, a side thread, a system chat or a refresh. */
export function pinAllowed(conversation: Conversation | undefined): boolean {
  if (conversation === undefined) return false;
  if (conversation.incognito === true || (conversation.trialModel ?? null) !== null) return false;
  if ((conversation.seriesCharacter ?? null) !== null) return false;
  // A side thread and a system chat go with another conversation: their answers are not pinned.
  if ((conversation.sideOf ?? null) !== null || conversation.origin !== 'user') return false;
  return (conversation.dashboardOf ?? null) === null;
}

/** Whether «Fissa alla Dashboard» shows on this message: an answer, in a conversation that allows it. */
export function canPin(conversation: Conversation | undefined, message: Pick<Message, 'role'>): boolean {
  return message.role === 'assistant' && pinAllowed(conversation);
}

const pad = (value: number): string => String(value).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «oggi alle 09:12», «ieri alle 18:40», «14/10 alle 17:05», «14/10/2025» another year. */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (sameDay(at, now)) return `oggi alle ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return `ieri alle ${time}`;
  const day = `${pad(at.getDate())}/${pad(at.getMonth() + 1)}`;
  return at.getFullYear() === now.getFullYear() ? `${day} alle ${time}` : `${day}/${String(at.getFullYear())}`;
}

/** How long a refresh has been at work, as «0:14» or «3:05». */
export function elapsedText(startedIso: string | null, now: Date): string {
  if (startedIso === null) return '0:00';
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(startedIso).getTime()) / 1000));
  return `${String(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** The ids in a new order: `id` one place earlier (-1) or later (+1); unchanged at the ends. */
export function moved(ids: readonly string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** The ids with `id` dropped where `target` is: before it when it came from below, after it when it came from above. */
export function droppedOn(ids: readonly string[], id: string, target: string): string[] {
  const from = ids.indexOf(id);
  const at = ids.indexOf(target);
  if (from < 0 || at < 0 || from === at) return [...ids];
  const next = ids.filter((item) => item !== id);
  const index = next.indexOf(target);
  next.splice(from < at ? index + 1 : index, 0, id);
  return next;
}

/** Whether any tile is at work: the page reads them again every few seconds meanwhile. */
export function anyRunning(tiles: readonly Pick<DashboardTile, 'refreshState'>[]): boolean {
  return tiles.some((tile) => tile.refreshState === 'running');
}

/** The tiles «Aggiorna tutti» asks again, in the order of the page: not Segreto, not already at work. */
export function refreshable(tiles: readonly DashboardTile[]): DashboardTile[] {
  return tiles.filter((tile) => canRefresh(tile));
}

/** «1 riquadro», «4 riquadri». */
export function countText(count: number): string {
  return count === 1 ? '1 riquadro' : `${String(count)} riquadri`;
}

/** The message of a failed call to the core, for the user. */
export function dashboardErrorText(status: number, fallback: string): string {
  if (status === 409) return 'Il riquadro è già in aggiornamento, o questa risposta è già nella Dashboard.';
  if (status === 422) return 'La domanda contiene dati che una conversazione di lavoro non può tenere (IBAN, codice fiscale, carta, chiave).';
  if (status === 404) return 'Il riquadro o la risposta non ci sono più.';
  if (status === 503) return 'Il modello locale ora non è disponibile.';
  return fallback;
}
