import { asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * Notifications of the web chat (I-1): `[notifications]` of arianna.toml.
 * Which kinds notify (a reply, an approval waiting, a failed task) and the
 * quiet hours, when nothing notifies. A notification never carries text or
 * title of a conversation: only a fixed sentence and the link. Absent: every
 * kind on, no quiet hours; nothing reaches a browser until the user allows
 * it there. Applies without a restart.
 */
export interface NotificationsConfig {
  replies: boolean;
  approvals: boolean;
  failures: boolean;
  /** Quiet hours, "HH:MM" local time; `from` after `to` spans midnight. Absent: none. */
  quiet?: QuietHours;
}

export interface QuietHours {
  from: string;
  to: string;
}

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = { replies: true, approvals: true, failures: true };

const CLOCK = '([01]\\d|2[0-3]):[0-5]\\d';
const QUIET = new RegExp(`^(${CLOCK})-(${CLOCK})$`);

/** "22:00-07:00" → { from, to }; undefined when it is not that shape or the two ends are equal. */
export function parseQuiet(text: string): QuietHours | undefined {
  const match = QUIET.exec(text.trim());
  const from = match?.[1];
  const to = match?.[3];
  if (from === undefined || to === undefined || from === to) return undefined;
  return { from, to };
}

export function quietText(quiet: QuietHours): string {
  return `${quiet.from}-${quiet.to}`;
}

function flag(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`${where}: expected true or false`);
  return value;
}

export function parseNotifications(value: unknown): NotificationsConfig {
  if (value === undefined) return { ...DEFAULT_NOTIFICATIONS };
  const table = asTable(value, 'notifications');
  onlyKeys(table, ['replies', 'approvals', 'failures', 'quiet'], 'notifications');
  const config: NotificationsConfig = {
    replies: flag(table.replies, 'notifications.replies', DEFAULT_NOTIFICATIONS.replies),
    approvals: flag(table.approvals, 'notifications.approvals', DEFAULT_NOTIFICATIONS.approvals),
    failures: flag(table.failures, 'notifications.failures', DEFAULT_NOTIFICATIONS.failures),
  };
  if (table.quiet !== undefined) {
    const quiet = parseQuiet(asString(table.quiet, 'notifications.quiet'));
    if (quiet === undefined) throw new ConfigError('notifications.quiet: expected "HH:MM-HH:MM" with two different times, e.g. "22:00-07:00"; remove the key for no quiet hours');
    config.quiet = quiet;
  }
  return config;
}

function minutes(clock: string): number {
  const [hours = '0', mins = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(mins);
}

/** Inside the quiet hours at `now` (local time)? `from` after `to` spans midnight. */
export function inQuiet(now: Date, quiet: QuietHours | undefined): boolean {
  if (quiet === undefined) return false;
  const start = minutes(quiet.from);
  const end = minutes(quiet.to);
  if (start === end) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return start < end ? at >= start && at < end : at >= start || at < end;
}
