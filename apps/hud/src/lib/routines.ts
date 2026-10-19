/**
 * Routines (D-110, tappa A; D-254): recurring appointments with Arianna. At
 * their days and time the core writes a report in each routine's own chat.
 * Pure helpers and the texts of the page «Routine»: the tests need no browser.
 */

export type IsoDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type RoutineSource = 'todo' | 'waiting' | 'cards' | 'done-since' | 'failed-since' | 'notes';
export type RoutineStatus = 'proposed' | 'active' | 'paused' | 'retired';
export type RunStatus = 'done' | 'missed-offline' | 'skipped' | 'failed';
export type RunReason = 'late' | 'blocked' | 'archived' | 'purged' | 'error';
export type SummaryState = 'none' | 'queued' | 'done' | 'unavailable' | 'failed';

export interface RunView {
  id: string;
  scheduledFor: string;
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  reason: RunReason | null;
  summaryState: SummaryState;
  createdAt: string;
}

/** A routine as GET /api/routines gives it (dates as text). */
export interface Routine {
  id: string;
  title: string;
  conversationId: string;
  days: IsoDay[];
  at: string;
  timezone: string;
  sources: RoutineSource[];
  summary: boolean;
  channel: 'chat';
  status: RoutineStatus;
  pausedBy: 'user' | 'archived' | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  conversationArchived: boolean;
  lastRun: RunView | null;
}

/** What the form sends: closed choices and one line of title, nothing else. */
export interface RoutineForm {
  title: string;
  days: IsoDay[];
  at: string;
  sources: RoutineSource[];
  summary: boolean;
}

export const ROUTINES_TITLE = 'Routine';
export const ROUTINES_INTRO = 'Appuntamenti ricorrenti: all’ora scelta Arianna scrive il resoconto nella chat della routine, preparato dal codice. La sintesi la scrive il modello locale; niente esce verso il cloud.';
export const ROUTINES_EMPTY_TITLE = 'Nessuna routine';
export const ROUTINES_EMPTY_TEXT = 'Crea la prima, per esempio «ogni giorno alle 18: resoconto». Il resoconto arriva in una chat sua, segnata con una R nella barra a sinistra.';
export const ROUTINES_LOAD_ERROR = 'Non riesco a leggere le routine.';
export const NEW_TEXT = 'Nuova routine';
export const TRY_TEXT = 'Prova adesso';
export const TRY_HINT = 'Scrive subito il resoconto nella chat della routine, senza spostare il prossimo';
export const RETIRE_CONFIRM_TEXT = 'Togliere la routine? Non partirà più; la sua chat resta, con i resoconti già scritti.';
export const TITLE_MAX = 80;
/** A routine Arianna proposed in the chat (D-256): nothing runs before «Attiva». */
export const PROPOSED_BADGE = 'Da approvare';
export const PROPOSED_HINT = 'Proposta da Arianna in chat: non parte finché non la attivi.';
export const APPROVE_TEXT = 'Attiva';
export const DISCARD_TEXT = 'Scarta';

export const DAY_LETTERS: readonly { day: IsoDay; letter: string; name: string }[] = [
  { day: 1, letter: 'L', name: 'lunedì' },
  { day: 2, letter: 'M', name: 'martedì' },
  { day: 3, letter: 'M', name: 'mercoledì' },
  { day: 4, letter: 'G', name: 'giovedì' },
  { day: 5, letter: 'V', name: 'venerdì' },
  { day: 6, letter: 'S', name: 'sabato' },
  { day: 7, letter: 'D', name: 'domenica' },
];

export const SOURCE_CHOICES: readonly { id: RoutineSource; label: string; hint: string }[] = [
  { id: 'todo', label: 'Da fare', hint: 'Le tue card aperte, per scadenza e priorità (al massimo 7)' },
  { id: 'waiting', label: 'Decisioni in attesa', hint: 'Quante cose aspettano una tua risposta' },
  { id: 'cards', label: 'In corso', hint: 'Le card al lavoro e quante sono da verificare' },
  { id: 'done-since', label: 'Fatto', hint: 'Le card chiuse dall’ultimo resoconto' },
  { id: 'failed-since', label: 'Fallito', hint: 'Le card fallite dall’ultimo resoconto' },
  { id: 'notes', label: 'Pensieri', hint: 'Quanti pensieri aspettano di essere riordinati (solo il numero)' },
];

export const SOURCE_TEXT: Record<RoutineSource, string> = Object.fromEntries(SOURCE_CHOICES.map((choice) => [choice.id, choice.label])) as Record<RoutineSource, string>;

const SHORT: Record<IsoDay, string> = { 1: 'lun', 2: 'mar', 3: 'mer', 4: 'gio', 5: 'ven', 6: 'sab', 7: 'dom' };

/** "ogni giorno", "lun-ven", "sab e dom", "lun, mer e ven", "ogni martedì": as the core writes them. */
export function daysText(days: readonly IsoDay[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'ogni giorno';
  if (sorted.join() === '1,2,3,4,5') return 'lun-ven';
  if (sorted.join() === '6,7') return 'sab e dom';
  if (sorted.length === 1) return `ogni ${DAY_LETTERS.find((item) => item.day === sorted[0])?.name ?? ''}`;
  const names = sorted.map((day) => SHORT[day]);
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1] ?? ''}`;
}

/** "lun-ven alle 18:00". */
export function scheduleText(routine: Pick<Routine, 'days' | 'at'>): string {
  return `${daysText(routine.days)} alle ${routine.at}`;
}

/** "lunedì 20 ottobre, 18:00" in the zone of the routine. */
export function dateText(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('it-IT', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString('it-IT');
  }
}

/** The state of the card in words. */
export function statusText(routine: Pick<Routine, 'status' | 'pausedBy'>): string {
  if (routine.status === 'active') return 'Attiva';
  if (routine.status === 'paused') return routine.pausedBy === 'archived' ? 'In pausa: chat archiviata' : 'In pausa';
  if (routine.status === 'proposed') return PROPOSED_BADGE;
  return 'Tolta';
}

/** The last run in words, or null before the first. */
export function lastRunText(run: RunView | null, timezone: string): string | null {
  if (run === null) return null;
  const when = dateText(run.trigger === 'manual' ? run.createdAt : run.scheduledFor, timezone);
  const what =
    run.status === 'missed-offline'
      ? 'persa: il Mac era spento'
      : run.status === 'failed'
        ? 'non riuscita'
        : run.status === 'skipped'
          ? 'saltata'
          : run.trigger === 'manual'
            ? 'prova fatta'
            : run.reason === 'late'
              ? 'fatta in ritardo'
              : 'fatta';
  const summary = run.status !== 'done' ? '' : run.summaryState === 'queued' ? ' · sintesi in attesa del modello locale' : run.summaryState === 'unavailable' ? ' · senza sintesi: modello non pronto' : run.summaryState === 'failed' ? ' · sintesi non riuscita' : '';
  return `Ultima: ${what}, ${when}${summary}`;
}

/** A new form: every day at 18:00, the todo and the decisions waiting, with the summary. */
export function emptyForm(): RoutineForm {
  return { title: '', days: [1, 2, 3, 4, 5, 6, 7], at: '18:00', sources: ['todo', 'waiting', 'cards', 'done-since', 'failed-since', 'notes'], summary: true };
}

export function formOf(routine: Routine): RoutineForm {
  return { title: routine.title, days: [...routine.days], at: routine.at, sources: [...routine.sources], summary: routine.summary };
}

/** Why the form cannot be saved yet, or null. */
export function formProblem(form: RoutineForm): string | null {
  const title = form.title.trim();
  if (title === '') return 'Scrivi un titolo.';
  if (Array.from(title).length > TITLE_MAX) return `Il titolo è più lungo di ${String(TITLE_MAX)} caratteri.`;
  if (form.days.length === 0) return 'Scegli almeno un giorno.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.at)) return 'Scegli un’ora.';
  if (form.sources.length === 0) return 'Scegli almeno una cosa da mettere nel resoconto.';
  return null;
}

/** Adds or removes an item, keeping the order of `all`. */
export function toggled<T>(chosen: readonly T[], item: T, all: readonly T[]): T[] {
  const next = chosen.includes(item) ? chosen.filter((value) => value !== item) : [...chosen, item];
  return all.filter((value) => next.includes(value));
}

/** The message of a refusal of the core, for the page. */
export function routineErrorText(status: number, fallback: string): string {
  if (status === 404) return 'La routine non c’è più.';
  if (status === 409) return 'La routine è cambiata nel frattempo (archiviata, già decisa o da approvare): ricarica la pagina.';
  if (status === 400) return 'Controlla i campi: qualcosa non va.';
  return fallback;
}
