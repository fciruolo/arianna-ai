import { ApiError } from './api.ts';
import { errorText } from './italian.ts';
import { LABEL_TEXT } from './labels.ts';
import type { Label } from './types.ts';

/**
 * The section "IM" of the cardwall (D-167, I-11 tappa P4a): the Iteration
 * Meetings of a project, one file `IM-<n>.md` each, read and written by the
 * core. Pure helpers: the types of `GET /api/browse/:project/im` and
 * `GET /api/browse/:project/im/:number`, the five columns of the items, the
 * Italian words and dates, the IM chosen by default and the user's choice in
 * this browser.
 */

export type ImItemState = 'todo' | 'doing' | 'done' | 'postponed' | 'cancelled';
export const IM_ITEM_STATES: readonly ImItemState[] = ['todo', 'doing', 'done', 'postponed', 'cancelled'];

export const IM_STATE_TEXT: Record<ImItemState, string> = {
  todo: 'Da fare',
  doing: 'In corso',
  done: 'Fatto',
  postponed: 'Rimandato',
  cancelled: 'Annullato',
};

export type ImStatus = 'previsto' | 'in corso' | 'chiuso';

export const IM_STATUS_TEXT: Record<ImStatus, string> = { previsto: 'Previsto', 'in corso': 'In corso', chiuso: 'Chiuso' };

export type ImCounts = Record<ImItemState, number>;

/**
 * One IM in the list of a project. `date` and `call` are "YYYY-MM-DD HH:MM",
 * local time; `date` is null for a file written by hand without a valid `data`.
 */
export interface ImSummary {
  number: number;
  date: string | null;
  call: string | null;
  status: ImStatus;
  label: Label;
  path: string;
  counts: ImCounts;
}

export interface ImItem {
  /** The line of the file: the address of the item for a change. */
  line: number;
  state: ImItemState;
  title: string;
  part: number | null;
  card: string | null;
}

/** One IM in full; `version` goes back with every write (409 when the file changed meanwhile). */
export interface ImDetail extends Omit<ImSummary, 'counts'> {
  version: string;
  items: ImItem[];
  /** The text of the section `## Report` (D-167, P4c); empty when there is none. */
  report: string;
}

/** The items by column, in the order of the file. */
export function groupItems(items: readonly ImItem[]): Record<ImItemState, ImItem[]> {
  const groups: Record<ImItemState, ImItem[]> = { todo: [], doing: [], done: [], postponed: [], cancelled: [] };
  for (const item of items) groups[item.state].push(item);
  return groups;
}

export function countItems(items: readonly ImItem[]): ImCounts {
  const counts: ImCounts = { todo: 0, doing: 0, done: 0, postponed: 0, cancelled: 0 };
  for (const item of items) counts[item.state] += 1;
  return counts;
}

/** The entry of the list for an IM just read or written: the counts follow its items. */
export function summaryOf(im: ImDetail): ImSummary {
  return { number: im.number, date: im.date, call: im.call, status: im.status, label: im.label, path: im.path, counts: countItems(im.items) };
}

/** The list with `im` in its place (added when new), ordered by number. */
export function withSummary(ims: readonly ImSummary[], im: ImDetail): ImSummary[] {
  return [...ims.filter((entry) => entry.number !== im.number), summaryOf(im)].sort((a, b) => a.number - b.number);
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

function parts(stamp: string): { day: string; time: string | undefined } | undefined {
  const match = STAMP.exec(stamp);
  if (match === null) return undefined;
  const [, year, month, date, hour, minute] = match;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)));
  if (at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(date)) return undefined;
  return {
    day: `${WEEKDAYS[at.getUTCDay()] ?? ''} ${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''}`,
    time: hour === undefined || minute === undefined ? undefined : `${hour}:${minute}`,
  };
}

export const NO_DATE_TEXT = 'senza data';

/** "2026-10-15 10:00" → "gio 15 ott, 10:00"; a stamp it does not understand stays as it is; no date → "senza data". */
export function imDateText(stamp: string | null): string {
  if (stamp === null) return NO_DATE_TEXT;
  const read = parts(stamp);
  if (read === undefined) return stamp;
  return read.time === undefined ? read.day : `${read.day}, ${read.time}`;
}

/** "2026-10-15 10:00" → "gio 15 ott"; no date → "senza data". */
export function imDayText(stamp: string | null): string {
  if (stamp === null) return NO_DATE_TEXT;
  return parts(stamp)?.day ?? stamp;
}

/** The entry of the IM menu: "IM-33 · gio 15 ott · Previsto". */
export function imOptionText(im: Pick<ImSummary, 'number' | 'date' | 'status'>): string {
  return `IM-${String(im.number)} · ${imDayText(im.date)} · ${IM_STATUS_TEXT[im.status]}`;
}

/** The moved call (D-167): "call spostata a ven 16 ott, 10:00"; nothing when it was not moved. */
export function callText(call: string | null): string | undefined {
  return call === null ? undefined : `call spostata a ${imDateText(call)}`;
}

/** The header of an IM: "IM-33 · gio 15 ott, 10:00", "IM-3 · senza data". */
export function imTitleText(im: Pick<ImSummary, 'number' | 'date'>): string {
  return `IM-${String(im.number)} · ${imDateText(im.date)}`;
}

/**
 * "Nuovo IM" asks a day and hour when the core cannot count from the last IM:
 * the project has none, or the last one (highest number) has no date.
 */
export function needsFirstDate(ims: readonly Pick<ImSummary, 'number' | 'date'>[]): boolean {
  if (ims.length === 0) return true;
  const last = ims.reduce((top, entry) => (entry.number > top.number ? entry : top));
  return last.date === null;
}

/** The IM shown at first: the first one not closed, else the last; undefined when there is none. */
export function defaultIm(ims: readonly Pick<ImSummary, 'number' | 'status'>[]): number | undefined {
  return (ims.find((im) => im.status !== 'chiuso') ?? ims.at(-1))?.number;
}

/** The IM to show: the one chosen before when it still exists, else the default. */
export function pickIm(ims: readonly Pick<ImSummary, 'number' | 'status'>[], saved: number | undefined): number | undefined {
  return saved !== undefined && ims.some((im) => im.number === saved) ? saved : defaultIm(ims);
}

/** The value of an `<input type="datetime-local">` ("2026-10-15T10:00") as the core wants it ("2026-10-15 10:00"); undefined when not valid. */
export function fromDateTimeInput(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (match === null) return undefined;
  const stamp = `${match[1] ?? ''} ${match[2] ?? ''}`;
  if (parts(stamp) === undefined) return undefined;
  const [hour, minute] = (match[2] ?? '').split(':').map(Number);
  return hour !== undefined && minute !== undefined && hour < 24 && minute < 60 ? stamp : undefined;
}

export const IM_CHANGED_TEXT = 'L’IM è cambiato nel file: ricaricato';

/** The file changed on disk since it was read (edited in Obsidian, for example): read it again. */
export function isStale(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && !isEnded(cause);
}

/** The IM of the project have ended (D-169): no new IM after the last day of the calendar. */
export function isEnded(cause: unknown): boolean {
  return cause instanceof ApiError && cause.message === 'the IM of the project have ended';
}

export const IM_ENDED_TEXT = 'Gli IM del progetto sono terminati: c’è una data di fine nel calendario (Progetti → IM). Toglila per crearne di nuovi.';

export function imErrorText(cause: unknown): string {
  if (isEnded(cause)) return IM_ENDED_TEXT;
  if (cause instanceof ApiError && cause.status === 404) return 'Questo IM non c’è più: ricarica la pagina.';
  return errorText(cause);
}

// The user's choice, a convenience of this browser (localStorage): the project, and the IM chosen in each project.
const KEY = 'arianna.cardwall.im';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ImPrefs {
  project: string | null;
  ims: Record<string, number>;
}

const PROJECT = /^[A-Za-z0-9._-]{1,120}$/;

export function loadImPrefs(storage: StorageLike | undefined): ImPrefs {
  const prefs: ImPrefs = { project: null, ims: {} };
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return prefs;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return prefs;
    const saved = value as Record<string, unknown>;
    if (typeof saved.project === 'string' && PROJECT.test(saved.project)) prefs.project = saved.project;
    if (typeof saved.ims === 'object' && saved.ims !== null) {
      for (const [project, number] of Object.entries(saved.ims as Record<string, unknown>)) {
        if (PROJECT.test(project) && typeof number === 'number' && Number.isSafeInteger(number) && number > 0) prefs.ims[project] = number;
      }
    }
    return prefs;
  } catch {
    return { project: null, ims: {} };
  }
}

export function saveImPrefs(storage: StorageLike | undefined, prefs: ImPrefs): void {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}

// I-11 tappa P4b (D-167): every item has its card, and the closing of an IM
// asked by the secretary in its conversation, item by item.

/** The answer to an item of a closing: done, done in part (the next IM gets the next part), not done (it moves to the next IM). */
export type ImOutcome = 'done' | 'part' | 'not-done';
export const IM_OUTCOMES: readonly ImOutcome[] = ['done', 'part', 'not-done'];

export const IM_OUTCOME_TEXT: Record<ImOutcome, string> = { done: 'Fatta', part: 'In parte', 'not-done': 'Non fatta' };

/** The address of an item for a write: its line, its title and its part, checked by the core against the file (409 when changed). */
export interface ImItemRef {
  line: number;
  title: string;
  part: number | null;
}

export function itemRef(item: Pick<ImItem, 'line' | 'title' | 'part'>): ImItemRef {
  return { line: item.line, title: item.title, part: item.part };
}

/** A closing of an IM, as `GET /api/im/closings` lists it: `messageId` is the message of the secretary it shows under. */
export interface ImClosing {
  id: string;
  project: string;
  im: number;
  messageId: string | null;
  openedAt: string;
  closedAt: string | null;
}

/** The items a closing still asks about: those not checked yet (Da fare, In corso), in the order of the file. */
export function openItems(items: readonly ImItem[]): ImItem[] {
  return items.filter((item) => item.state === 'todo' || item.state === 'doing');
}

const ANSWERED_TEXT: Partial<Record<ImItemState, string>> = { done: 'Fatta', postponed: 'Passa all’IM successivo', cancelled: 'Annullata' };

/** What an item already answered shows in the closing; undefined for an item still open. */
export function answeredText(item: Pick<ImItem, 'state'>): string | undefined {
  return ANSWERED_TEXT[item.state];
}

/** The small line under the buttons of an item: what "In parte" and "Non fatta" do to the next IM. */
export function closingHint(item: Pick<ImItem, 'part'>): string {
  return `In parte: nell’IM successivo nasce «Parte ${String((item.part ?? 1) + 1)}». Non fatta: passa all’IM successivo.`;
}

/** "IM-33 · progetto-test", the header of the closing. */
export function closingTitle(closing: Pick<ImClosing, 'project' | 'im'>): string {
  return `IM-${String(closing.im)} · ${closing.project}`;
}

/** "Chiudere l’IM-33 di progetto-test", the line of "Decisioni in attesa". */
export function closingAskText(closing: Pick<ImClosing, 'project' | 'im'>): string {
  return `Chiudere l’IM-${String(closing.im)} di ${closing.project}`;
}

/** The closings still waiting for the user's answers. */
export function openClosings<T extends Pick<ImClosing, 'closedAt'>>(closings: readonly T[]): T[] {
  return closings.filter((closing) => closing.closedAt === null);
}

/** The closings by the message they show under; one without a message shows nowhere in the chat. The first (most recent) wins. */
export function closingsByMessage(closings: readonly ImClosing[]): Map<string, ImClosing> {
  const byMessage = new Map<string, ImClosing>();
  for (const closing of closings) if (closing.messageId !== null && !byMessage.has(closing.messageId)) byMessage.set(closing.messageId, closing);
  return byMessage;
}

export const CLOSING_CHANGED_TEXT = 'La voce è cambiata nel file o la chiusura è già finita: ho ricaricato l’IM.';

// I-11 tappa P4c (D-167): "Scrivi il report" for the client, by the agent the
// user picks each time; the core writes it into `## Report`.

export type ReportAgent = 'arianna' | 'claude';
export const REPORT_AGENTS: readonly ReportAgent[] = ['arianna', 'claude'];

export const REPORT_AGENT_TEXT: Record<ReportAgent, string> = { arianna: 'Arianna (sul Mac)', claude: 'Claude (nel cloud, consuma quota)' };

export const REPORT_AGENT_HINT: Record<ReportAgent, string> = {
  arianna: 'Il modello locale: niente esce dal Mac.',
  claude: 'Passa dal gateway: solo dati Interni, mai prezzi né dati privati.',
};

export type ReportErrorCode = 'invalid' | 'not-found' | 'has-report' | 'busy' | 'above-label' | 'unavailable' | 'blocked' | 'quota' | 'failed' | 'empty' | 'changed';

/** The job of a report, as `GET/POST /api/browse/:project/im/:number/report` gives it. */
export interface ImReportJob {
  id: string;
  project: string;
  number: number;
  agent: ReportAgent;
  language: ReportLanguage;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: { code: ReportErrorCode; message: string; detail: string | null } | null;
  left: number;
  resetsAt: string | null;
}

export const REPORT_REPLACE_TEXT = 'C’è già un report: lo sostituisco?';
export const REPORT_RUNNING_TEXT = 'Scrivo il report…';

/** The language of the report, chosen every time like the agent (D-167). */
export type ReportLanguage = 'it' | 'en';
export const REPORT_LANGUAGES: readonly ReportLanguage[] = ['it', 'en'];
export const REPORT_LANGUAGE_TEXT: Record<ReportLanguage, string> = { it: 'Italiano', en: 'English' };

/** "Scrivo il report in inglese…": the line while the report is written. */
export function reportRunningText(language: ReportLanguage): string {
  return language === 'en' ? 'Scrivo il report in inglese…' : REPORT_RUNNING_TEXT;
}

// The last language chosen in each project, a convenience of this browser.
const LANGUAGE_KEY = 'arianna.cardwall.im.report-language';

export function loadReportLanguage(storage: StorageLike | undefined, project: string | null): ReportLanguage {
  if (project === null) return 'it';
  try {
    const raw = storage?.getItem(LANGUAGE_KEY);
    if (raw === null || raw === undefined) return 'it';
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return 'it';
    const saved = (value as Record<string, unknown>)[project];
    return saved === 'en' ? 'en' : 'it';
  } catch {
    return 'it';
  }
}

export function saveReportLanguage(storage: StorageLike | undefined, project: string, language: ReportLanguage): void {
  if (!PROJECT.test(project)) return;
  try {
    let saved: Record<string, unknown> = {};
    try {
      const raw = storage?.getItem(LANGUAGE_KEY);
      const value: unknown = raw === null || raw === undefined ? {} : JSON.parse(raw);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) saved = value as Record<string, unknown>;
    } catch {
      // A broken value is written again from scratch.
    }
    const kept = Object.fromEntries(Object.entries(saved).filter(([name, choice]) => PROJECT.test(name) && (choice === 'it' || choice === 'en')));
    storage?.setItem(LANGUAGE_KEY, JSON.stringify({ ...kept, [project]: language }));
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}
/** How often the page asks how the report is going. */
export const REPORT_POLL_MS = 2000;

/** The answer to "Scrivi il report" when the section already has text: ask before replacing it. */
export function isReportConflict(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && cause.body.code === 'has-report';
}

const MONTHS_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function longDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return day;
  return `${String(Number(match[3]))} ${MONTHS_LONG[Number(match[2]) - 1] ?? ''}`;
}

function labelWord(code: string | undefined): string {
  return code === 'L0' || code === 'L1' || code === 'L2' || code === 'L3' ? `${LABEL_TEXT[code]} (${code})` : 'sopra Interno';
}

function resetText(resetsAt: string | null): string {
  if (resetsAt === null) return '';
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return '';
  return ` fino alle ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Why a report was not written, in Italian, from the core's code and detail (never its text). */
export function reportErrorText(error: { code: string; detail: string | null }, agent: ReportAgent, resetsAt: string | null = null): string {
  const detail = error.detail ?? '';
  switch (error.code) {
    case 'has-report':
      return REPORT_REPLACE_TEXT;
    case 'busy':
      return 'Sto già scrivendo il report di questo IM: aspetta che finisca.';
    case 'above-label': {
      const [what, a, b] = detail.split(':');
      if (what === 'diary') {
        return `Il diario dei lavori del ${longDay(a ?? '')} è ${labelWord(b)}: Claude non può leggerlo e non ho mandato niente nel cloud. Scegli Arianna (sul Mac).`;
      }
      if (agent === 'claude') return `L’IM è ${labelWord(a)}: Claude non può leggerlo e non ho mandato niente nel cloud. Scegli Arianna (sul Mac).`;
      return `L’IM è ${labelWord(a)}: nemmeno il modello locale può leggerlo.`;
    }
    case 'unavailable':
      if (detail === 'claude') return 'Claude non è disponibile ora: va acceso in Impostazioni (esecutori e modelli del cloud).';
      if (detail === 'arianna' || detail === 'no-endpoint') return 'Arianna non può scrivere ora: nessun server locale ha il modello dell’orchestratore (local-large).';
      return agent === 'claude' ? 'Claude non è disponibile ora: riprova più tardi.' : 'Il modello locale non risponde: controlla che il server locale sia avviato.';
    case 'blocked':
      return 'Il gateway ha fermato i dati del report (contengono qualcosa che non può uscire, per esempio dati personali o un segreto): non è partito niente.';
    case 'quota':
      return `Claude ha finito la quota${resetText(resetsAt)}: riprova dopo o scegli Arianna (sul Mac).`;
    case 'empty':
      return 'Il modello non ha scritto niente: riprova.';
    case 'changed':
      return 'Il report o l’intestazione dell’IM sono cambiati nel file mentre scrivevo: non ho sovrascritto niente. Riprova.';
    case 'invalid':
      return 'L’IM non ha una data valida nell’intestazione: aggiungila e riprova.';
    case 'not-found':
      return 'Questo IM non c’è più: ricarica la pagina.';
    default:
      return 'Il modello non è riuscito a scrivere il report: riprova.';
  }
}

/** The error of a refused POST (the code is in the body) or of a failed job. */
export function reportStartErrorText(cause: unknown, agent: ReportAgent): string {
  if (cause instanceof ApiError && typeof cause.body.code === 'string') {
    return reportErrorText({ code: cause.body.code, detail: typeof cause.body.detail === 'string' ? cause.body.detail : null }, agent, typeof cause.body.resetsAt === 'string' ? cause.body.resetsAt : null);
  }
  return imErrorText(cause);
}

/** What a finished job says under the header; undefined while it runs. */
export function reportDoneText(job: Pick<ImReportJob, 'state' | 'agent' | 'left' | 'language'>): string | undefined {
  if (job.state !== 'done') return undefined;
  const who = job.agent === 'claude' ? 'Claude' : 'Arianna';
  const language = job.language === 'en' ? ' in inglese' : '';
  const left = job.left === 0 ? '' : ` ${job.left === 1 ? 'Un giorno del diario non è entrato' : `${String(job.left)} giorni del diario non sono entrati`} (sopra l’etichetta dell’IM o illeggibili).`;
  return `${who} ha scritto il report${language}: rileggilo prima di mandarlo al cliente.${left}`;
}
