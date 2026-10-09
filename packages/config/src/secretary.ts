import { asArray, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * The secretary (I-12, D-144): `[secretary]` of arianna.toml. Whether its
 * reminders are on, the three moments of the day (morning: the commitments
 * of the day; after lunch: those still open; end of the day: the report of
 * those not done) and the days they run. Absent: on, 09:00, 14:30 and
 * 18:30, every day, weekend included (the user's choice of 2026-10-09).
 * The times are local time and come in that order. Not a privacy setting:
 * a reminder never carries the text of a commitment outside this machine.
 * Applies without a restart; the reminders themselves come with tappa S2.
 */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export interface SecretaryConfig {
  enabled: boolean;
  /** "HH:MM", local time; morning < afternoon < evening. */
  morning: string;
  afternoon: string;
  evening: string;
  /** The days the reminders run, Monday first; at least one. */
  days: WeekdayKey[];
}

export const DEFAULT_SECRETARY: SecretaryConfig = {
  enabled: true,
  morning: '09:00',
  afternoon: '14:30',
  evening: '18:30',
  days: [...WEEKDAY_KEYS],
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClock(text: string): boolean {
  return CLOCK.test(text);
}

/**
 * Checks a secretary configuration however it came (the file, the settings
 * page): the error names what is wrong. Days are kept Monday first, once each.
 */
export function checkSecretary(value: SecretaryConfig, where = 'secretary'): SecretaryConfig {
  for (const key of ['morning', 'afternoon', 'evening'] as const) {
    if (!isClock(value[key])) throw new ConfigError(`${where}.${key}: expected "HH:MM", e.g. "09:00"`);
  }
  if (!(value.morning < value.afternoon && value.afternoon < value.evening)) {
    throw new ConfigError(`${where}: morning, afternoon and evening must come in this order during the day`);
  }
  const unknown = value.days.filter((day) => !(WEEKDAY_KEYS as readonly string[]).includes(day));
  if (unknown.length > 0) throw new ConfigError(`${where}.days: unknown day(s) ${unknown.join(', ')}; use ${WEEKDAY_KEYS.join(', ')}`);
  const days = WEEKDAY_KEYS.filter((day) => value.days.includes(day));
  if (days.length === 0) throw new ConfigError(`${where}.days: at least one day; to stop the reminders set enabled = false`);
  return { enabled: value.enabled, morning: value.morning, afternoon: value.afternoon, evening: value.evening, days };
}

export function parseSecretary(value: unknown): SecretaryConfig {
  if (value === undefined) return structuredClone(DEFAULT_SECRETARY);
  const table = asTable(value, 'secretary');
  onlyKeys(table, ['enabled', 'morning', 'afternoon', 'evening', 'days'], 'secretary');
  if (table.enabled !== undefined && typeof table.enabled !== 'boolean') throw new ConfigError('secretary.enabled: expected true or false');
  const clock = (key: 'morning' | 'afternoon' | 'evening'): string => (table[key] === undefined ? DEFAULT_SECRETARY[key] : asString(table[key], `secretary.${key}`));
  const days = table.days === undefined ? [...DEFAULT_SECRETARY.days] : asArray(table.days, 'secretary.days').map((day) => asString(day, 'secretary.days') as WeekdayKey);
  return checkSecretary({
    enabled: table.enabled ?? DEFAULT_SECRETARY.enabled,
    morning: clock('morning'),
    afternoon: clock('afternoon'),
    evening: clock('evening'),
    days,
  });
}
