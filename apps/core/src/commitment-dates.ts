/**
 * The days of the secretary (I-12, D-144), computed by the code and not by
 * the model: the local model passes the words of the user ("domani",
 * "giovedì", "15 ottobre", "tra tre giorni") and this module turns them into
 * a date, from today in the local time of this machine (the user's time
 * zone). The user sees the date and confirms it before anything is saved.
 *
 * A day is "YYYY-MM-DD"; arithmetic runs on UTC midnights, so no daylight
 * saving change moves a day.
 */

export const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'] as const;
export const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'] as const;

/** Today in the local time of this machine. */
export function localDay(now: Date = new Date()): string {
  return dayOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** The start of today in the local time of this machine. */
export function localMidnight(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function dayOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parts(day: string): { year: number; month: number; day: number } {
  const [year = 0, month = 0, date = 0] = day.split('-').map(Number);
  return { year, month, day: date };
}

function utc(day: string): Date {
  const { year, month, day: date } = parts(day);
  return new Date(Date.UTC(year, month - 1, date));
}

export function addDays(day: string, count: number): string {
  const at = utc(day);
  at.setUTCDate(at.getUTCDate() + count);
  return dayOf(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/** 0 Sunday … 6 Saturday. */
export function weekdayOf(day: string): number {
  return utc(day).getUTCDay();
}

/** A real date of the calendar ("2026-02-30" is not). */
export function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const { year, month, day } = parts(text);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/** "giovedì 15 ottobre 2026". */
export function dayText(day: string): string {
  const { year, month, day: date } = parts(day);
  return `${WEEKDAYS[weekdayOf(day)] ?? ''} ${String(date)} ${MONTHS[month - 1] ?? ''} ${String(year)}`;
}

/** "oggi", "domani" or "giovedì 15 ottobre 2026", for the chat. */
export function relativeDayText(day: string, today: string): string {
  if (day === today) return `oggi, ${dayText(day)}`;
  if (day === addDays(today, 1)) return `domani, ${dayText(day)}`;
  return dayText(day);
}

/** Lower case, without accents and extra spaces. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  quindici: 15,
  venti: 20,
  trenta: 30,
};

function count(word: string): number | undefined {
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return NUMBER_WORDS[word];
}

const PLAIN_WEEKDAYS = WEEKDAYS.map((name) => plain(name));

/** The first day of the month of `day`. */
function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}
const PLAIN_MONTHS = MONTHS.map((name) => plain(name));

/** Words around a day that say nothing about which day it is. */
const FILLER = /\b(il|lo|la|di|del|della|entro|per|a|ad|in|e|questo|questa|prossimo|prossima|mattina|mattino|pomeriggio|sera|dopo pranzo|pranzo|presto|tardi)\b/g;

/** "alle 15", "ore 9.30", "15:00" inside a text: the clock and the text without it. A bare "15.10" is a date, not a clock. */
function takeTime(text: string): { time?: string; rest: string } {
  const match = /\b(?:alle|ore|per le|verso le)\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (match === null) return { rest: text };
  const hours = match[1] ?? match[3] ?? '';
  const minutes = match[2] ?? match[4] ?? '00';
  return { time: `${hours.padStart(2, '0')}:${minutes}`, rest: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.replace(/\s+/g, ' ').trim() };
}

/** A clock as the user or the model wrote it: "15", "15:30", "9.00", "alle 15". Undefined when it is not one. */
export function parseTime(text: string): string | undefined {
  const words = plain(text).replace(/^(alle|ore|per le|verso le)\s*/, '');
  const match = /^([01]?\d|2[0-3])(?:[:.]([0-5]\d))?$/.exec(words);
  if (match === null) return undefined;
  return `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? '00'}`;
}

export interface ParsedDay {
  day: string;
  /** The clock found in the same words, when they had one ("giovedì alle 15"). */
  time?: string;
}

/**
 * The day the user's words name, from `today`, or undefined when the code
 * cannot tell. A weekday is the next one after today ("giovedì" said on a
 * Thursday is the next week's); a date without the year is the next one from
 * today; "la settimana prossima" is next Monday. Never a day before today.
 */
export function parseDay(words: string, today: string): ParsedDay | undefined {
  const found = takeTime(plain(words));
  const text = found.rest;
  // A clock the code cannot read ("alle 25"): refused, never dropped in silence.
  if (/\b(alle|ore|per le|verso le)\s*\d/.test(text) || /\b\d{1,2}:\d{2}\b/.test(text)) return undefined;
  const day = dayFrom(text, today);
  if (day === undefined || day < today) return undefined;
  return found.time === undefined ? { day } : { day, time: found.time };
}

function dayFrom(text: string, today: string): string | undefined {
  // An ISO date, as the model may write it.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) return isDay(text) ? text : undefined;

  const cleaned = text.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  const all = ` ${text} `;

  if (/\bdopodomani\b/.test(text)) return addDays(today, 2);
  if (/\bdomani\b/.test(text)) return addDays(today, 1);
  if (/\b(oggi|stasera|stamattina|stanotte)\b/.test(text)) return today;
  if (cleaned === '') return undefined;

  // "tra 3 giorni", "fra una settimana", "tra due settimane".
  const after = /\b(?:tra|fra)\s+(\S+)\s+(giorno|giorni|settimana|settimane|mese|mesi)\b/.exec(text);
  if (after !== null) {
    const amount = count(after[1] ?? '');
    if (amount === undefined) return undefined;
    const unit = after[2] ?? '';
    if (unit.startsWith('giorn')) return addDays(today, amount);
    if (unit.startsWith('settiman')) return addDays(today, amount * 7);
    return addMonths(today, amount);
  }

  const weekday = PLAIN_WEEKDAYS.findIndex((name) => all.includes(` ${name} `));
  // "la settimana prossima": next Monday; "giovedì della settimana prossima": that day of next week.
  if (/\bsettimana prossima\b|\bprossima settimana\b/.test(text)) {
    const monday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
    return weekday === -1 ? monday : addDays(monday, (weekday + 6) % 7);
  }

  // A weekday: the next one after today.
  if (weekday !== -1 && !/\d/.test(cleaned.replace(PLAIN_WEEKDAYS[weekday] ?? '', ''))) {
    const ahead = (weekday - weekdayOf(today) + 7) % 7 || 7;
    return addDays(today, ahead);
  }

  // "15/10", "15-10-2026", "15.10.26".
  const numeric = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\b/.exec(cleaned);
  if (numeric !== null) return dateOf(Number(numeric[1]), Number(numeric[2]), numeric[3], today);

  // "15 ottobre", "giovedì 15 ottobre 2026".
  const named = new RegExp(`\\b(\\d{1,2})\\s+(${PLAIN_MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`).exec(cleaned);
  if (named !== null) return dateOf(Number(named[1]), PLAIN_MONTHS.indexOf(named[2] ?? '') + 1, named[3], today);

  // "il 15": this month, or the next one when the 15th has passed.
  const alone = /^(\d{1,2})$/.exec(cleaned);
  if (alone !== null) {
    const date = Number(alone[1]);
    const { year, month } = parts(today);
    const here = dayOf(year, month, date);
    if (isDay(here) && here >= today) return here;
    const next = month === 12 ? dayOf(year + 1, 1, date) : dayOf(year, month + 1, date);
    return isDay(next) ? next : undefined;
  }
  return undefined;
}

function dateOf(date: number, month: number, yearText: string | undefined, today: string): string | undefined {
  const current = parts(today).year;
  if (yearText !== undefined) {
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const day = dayOf(year, month, date);
    return isDay(day) ? day : undefined;
  }
  const day = dayOf(current, month, date);
  if (!isDay(day)) return undefined;
  if (day >= today) return day;
  const next = dayOf(current + 1, month, date);
  return isDay(next) ? next : undefined;
}

function addMonths(day: string, amount: number): string {
  const { year, month, day: date } = parts(day);
  const index = month - 1 + amount;
  const target = { year: year + Math.floor(index / 12), month: (index % 12) + 1 };
  // The 31st of a shorter month becomes its last day.
  for (let last = date; last > 27; last -= 1) {
    const candidate = dayOf(target.year, target.month, last);
    if (isDay(candidate)) return candidate;
  }
  return dayOf(target.year, target.month, date);
}

export interface DayRange {
  from: string;
  to: string;
  /** How the chat names it: "domani, venerdì 10 ottobre 2026", "questa settimana". */
  text: string;
}

/**
 * The days a question names, for "cosa ho domani?": one day, or this week
 * (today to Sunday), or next week (Monday to Sunday). Undefined when the
 * words name none: the caller lists every open commitment.
 */
export function parseRange(words: string, today: string): DayRange | undefined {
  const text = plain(words);
  // A weekday named with the week is one day ("giovedì della settimana prossima").
  const day = PLAIN_WEEKDAYS.some((name) => ` ${text} `.includes(` ${name} `));
  // "i prossimi 7 giorni", "nei prossimi giorni" (a week), "prossime due settimane": from today on.
  const next = /\bprossim[ie] (?:(\S+) )?(giorni|settimane)\b/.exec(text);
  if (!day && next !== null) {
    const amount = next[1] === undefined ? (next[2] === 'giorni' ? 7 : 2) : count(next[1]);
    const days = amount === undefined ? undefined : next[2] === 'giorni' ? amount : amount * 7;
    if (days === undefined || days < 1 || days > 92) return undefined;
    return { from: today, to: addDays(today, days - 1), text: `i prossimi ${String(days)} giorni` };
  }
  if (!day && /\b(?:mese prossimo|prossimo mese)\b/.test(text)) {
    const [year, month] = today.split('-').map(Number) as [number, number];
    const from = `${String(month === 12 ? year + 1 : year)}-${String((month % 12) + 1).padStart(2, '0')}-01`;
    return { from, to: addDays(monthStart(addDays(from, 31)), -1), text: 'il mese prossimo' };
  }
  if (!day && /\bquesto mese\b/.test(text)) {
    return { from: today, to: addDays(monthStart(addDays(monthStart(today), 31)), -1), text: 'questo mese' };
  }
  if (!day && /\bsettimana prossima\b|\bprossima settimana\b/.test(text)) {
    const from = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
    return { from, to: addDays(from, 6), text: 'la settimana prossima' };
  }
  if (!day && /\bsettimana\b/.test(text)) {
    const toSunday = (7 - weekdayOf(today)) % 7;
    return { from: today, to: addDays(today, toSunday), text: 'questa settimana' };
  }
  const parsed = parseDay(words, today);
  if (parsed === undefined) return undefined;
  return { from: parsed.day, to: parsed.day, text: relativeDayText(parsed.day, today) };
}
