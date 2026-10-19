import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import type { ReportData, ReportItem, ReportList } from '../routines.ts';
import { wallOf } from '../routine-schedule.ts';
import { speakable } from './turns.ts';

/**
 * The call of a routine (D-110, tappa B; D-259), pure: what Arianna says, all
 * of it written here by code, never by a model. First a greeting with the
 * counts only («hai 5 cose da fare e 2 decisioni in attesa»), then «Vuoi che
 * ti legga i titoli?». The titles come only after a «sì» of the user, which is
 * a gate of the interface (who answers may not be alone): up to the routine's
 * `voice_max_label`, never above Privato (L2); a card above it is counted,
 * never read. The local voice admits L2 in a private conversation (D-066,
 * choice 1): the gateway still checks every text towards `voice`.
 */

/** Titles said per list: the rest is counted, the whole report is in the chat. */
export const VOICE_MAX_ITEMS = 5;

/** The labels a routine may say aloud: never L3 (a CHECK of 0082 too). */
export const VOICE_LABELS: readonly Label[] = ['L0', 'L1', 'L2'];

export function isVoiceLabel(value: unknown): value is Label {
  return typeof value === 'string' && (VOICE_LABELS as readonly string[]).includes(value);
}

/** How the call starts: on time, late after the Mac was off (sorry, risposta 7), or the second ring (risposta 6). */
export type RoutineCallOpening = { kind: 'on-time' } | { kind: 'late'; due: Date } | { kind: 'retry' };

export const ROUTINE_CALL_TEXT = {
  question: 'Vuoi che ti legga i titoli?',
  inChat: 'Il resoconto completo è nella chat della routine.',
  nothing: 'Non c’è niente da segnalare.',
  no: 'Va bene: trovi tutto nella chat della routine. Se vuoi altro dimmelo, altrimenti puoi chiudere.',
  again: 'Scusa, non ho capito: vuoi che ti legga i titoli? Dimmi sì o no.',
  end: 'Il resoconto completo è nella chat della routine. Vuoi altro?',
  /** The end of a delegation in a routine's call: the task read the whole chat, so its answer stays written. */
  delegatedDone: 'Ho finito: il risultato è nella chat della routine.',
} as const;

function clockOf(instant: Date, timezone: string): string {
  const wall = wallOf(instant.getTime(), timezone);
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/** «Buongiorno» until 13, «Buon pomeriggio» until 18, then «Buonasera»; «Ciao» in the night. */
export function salutation(now: Date, timezone: string): string {
  const { hour } = wallOf(now.getTime(), timezone);
  if (hour < 5) return 'Ciao';
  if (hour < 13) return 'Buongiorno';
  if (hour < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

function total(list: ReportList): number {
  return list.shown.length + list.more + list.secret;
}

/** «una cosa», «5 cose»: one in words, as it is said. */
function counted(count: number, one: string, many: string): string {
  return count === 1 ? one : `${String(count)} ${many}`;
}

/** The counts of the report as one sentence, zeros left out. */
export function countsText(data: ReportData): string {
  const parts: string[] = [];
  if (data.todo !== undefined && total(data.todo) > 0) parts.push(counted(total(data.todo), 'una cosa da fare', 'cose da fare'));
  if (data.waiting !== undefined && data.waiting > 0) parts.push(counted(data.waiting, 'una decisione in attesa', 'decisioni in attesa'));
  if (data.cards !== undefined) {
    const running = total(data.cards.running);
    if (running > 0) parts.push(counted(running, 'una carta al lavoro', 'carte al lavoro'));
    if (data.cards.toVerify > 0) parts.push(counted(data.cards.toVerify, 'una carta da verificare', 'carte da verificare'));
  }
  if (data.done !== undefined && total(data.done) > 0) parts.push(`${counted(total(data.done), 'una cosa fatta', 'cose fatte')} dall’ultimo resoconto`);
  if (data.failed !== undefined && total(data.failed) > 0) parts.push(`${counted(total(data.failed), 'una cosa fallita', 'cose fallite')} dall’ultimo resoconto`);
  if (data.notes !== undefined && data.notes > 0) parts.push(counted(data.notes, 'un pensiero da riordinare', 'pensieri da riordinare'));
  if (parts.length === 0) return ROUTINE_CALL_TEXT.nothing;
  const last = parts.pop() ?? '';
  return `Hai ${parts.length === 0 ? last : `${parts.join(', ')} e ${last}`}.`;
}

/** The items of a list that may be said at `ceiling`, and how many are only counted. */
function readable(list: ReportList, ceiling: Label): { said: ReportItem[]; more: number; reserved: number } {
  const allowed = list.shown.filter((item) => isAtMost(item.label, ceiling));
  return {
    said: allowed.slice(0, VOICE_MAX_ITEMS),
    more: Math.max(0, allowed.length - VOICE_MAX_ITEMS) + list.more,
    reserved: list.shown.length - allowed.length + list.secret,
  };
}

/** The lists whose titles a call may read, in the order of the report. */
function lists(data: ReportData): { name: string; list: ReportList; withDue: boolean }[] {
  return [
    ...(data.todo === undefined ? [] : [{ name: 'Da fare', list: data.todo, withDue: true }]),
    ...(data.cards === undefined ? [] : [{ name: 'In corso', list: data.cards.running, withDue: false }]),
    ...(data.done === undefined ? [] : [{ name: 'Fatto dall’ultimo resoconto', list: data.done, withDue: false }]),
    ...(data.failed === undefined ? [] : [{ name: 'Fallito dall’ultimo resoconto', list: data.failed, withDue: false }]),
  ];
}

/** Whether anything may be read after the «sì»: without titles at `ceiling` the call asks nothing. */
export function hasTitles(data: ReportData, ceiling: Label): boolean {
  return lists(data).some(({ list }) => readable(list, ceiling).said.length > 0);
}

/**
 * The greeting of the call: counts only, never a title, then the question
 * when there are titles to read. Its label is L2 at least: counts of private
 * rows are the user's (reportLabel of the report).
 */
export function routineGreeting(data: ReportData, opening: RoutineCallOpening, ceiling: Label, timezone: string, now: Date): { text: string; label: Label; asks: boolean } {
  const start =
    opening.kind === 'late'
      ? `Scusa il ritardo: la routine era per le ${clockOf(opening.due, timezone)}, ma il Mac era spento o non ero attiva.`
      : opening.kind === 'retry'
        ? 'Ti richiamo per la routine di prima.'
        : 'È l’ora della tua routine.';
  const asks = hasTitles(data, ceiling);
  const text = `${salutation(now, timezone)}, sono Arianna. ${start} ${countsText(data)} ${asks ? ROUTINE_CALL_TEXT.question : ROUTINE_CALL_TEXT.inChat}`;
  return { text, label: 'L2', asks };
}

/** The deadline as it is said: the date in brackets of the written report is left out. */
export function spokenDue(due: Date, timezone: string, today: Date): string {
  const a = wallOf(today.getTime(), timezone);
  const b = wallOf(due.getTime(), timezone);
  const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
  if (days < -1) return `scaduta da ${String(-days)} giorni`;
  if (days === -1) return 'scaduta ieri';
  if (days === 0) return 'scade oggi';
  if (days === 1) return 'scade domani';
  return `scade fra ${String(days)} giorni`;
}

/**
 * The titles said after the «sì»: up to VOICE_MAX_ITEMS per list, at most at
 * `ceiling`, the rest counted; the label is the highest of what is read, L2
 * at least. Null when there is nothing to read.
 */
export function routineDetails(data: ReportData, ceiling: Label, timezone: string, today: Date): { text: string; label: Label } | null {
  if (!hasTitles(data, ceiling)) return null;
  const sentences: string[] = [];
  let label: Label = 'L2';
  for (const { name, list, withDue } of lists(data)) {
    const { said, more, reserved } = readable(list, ceiling);
    if (said.length === 0 && more === 0 && reserved === 0) continue;
    const items = said.map((item) => {
      label = maxLabel(label, item.label);
      const title = speakable(item.title).replace(/[;.]+$/, '');
      return withDue && item.due !== null ? `${title}, ${spokenDue(item.due, timezone, today)}` : title;
    });
    const tail = [
      ...(more > 0 ? [more === 1 ? 'e un’altra' : `e altre ${String(more)}`] : []),
      ...(reserved > 0 ? [reserved === 1 ? 'una riservata, che non leggo' : `${String(reserved)} riservate, che non leggo`] : []),
    ];
    if (items.length === 0) {
      sentences.push(`${name}: ${tail.join('; ')}.`);
      continue;
    }
    sentences.push(`${name}: ${items.join('; ')}${tail.length === 0 ? '' : `; ${tail.join('; ')}`}.`);
  }
  return { text: `${sentences.join(' ')} ${ROUTINE_CALL_TEXT.end}`, label };
}

const YES = new Set(['si', 'certo', 'certamente', 'sicuro', 'ok', 'okay', 'dai', 'volentieri', 'dimmi', 'dimmeli', 'leggi', 'leggili', 'leggimeli', 'vai', 'bene', 'perfetto', 'esatto', 'yes']);
const NO = new Set(['no', 'non', 'nessuno', 'niente', 'basta', 'dopo', 'stop', 'lascia', 'nope']);
/** Words that change nothing in a short answer («sì grazie», «va bene», «no grazie Arianna»). */
const NEUTRAL = new Set(['grazie', 'pure', 'per', 'favore', 'va', 'allora', 'beh', 'ehm', 'mah', 'arianna', 'ciao', 'titoli', 'i', 'li', 'me', 'tutto', 'tutti', 'ora', 'adesso', 'stare', 'e', 'certo']);
/** A longer sentence is a question of its own, never a «sì». */
const MAX_ANSWER_WORDS = 6;

/**
 * The user's answer to «Vuoi che ti legga i titoli?», by code: «sì» only for
 * a short answer made of yes words and neutral ones; any no word makes it a
 * «no» (when in doubt, nothing is read); anything else is unclear.
 */
export function gateAnswer(words: string): 'yes' | 'no' | 'unclear' {
  const tokens = words
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0 || tokens.length > MAX_ANSWER_WORDS) return 'unclear';
  if (tokens.some((token) => NO.has(token))) return tokens.some((token) => YES.has(token) && token !== 'bene') ? 'unclear' : 'no';
  if (tokens.some((token) => YES.has(token)) && tokens.every((token) => YES.has(token) || NEUTRAL.has(token))) return 'yes';
  return 'unclear';
}
