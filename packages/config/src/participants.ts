import { asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * How many messages of the user, with no delegation to an agent in between,
 * before it leaves the conversation by itself (I-8, D-130): ten, the user's
 * choice. 0 means never. The Coder never leaves by itself.
 */
export const DEFAULT_LEAVE_AFTER = 10;
export const MAX_LEAVE_AFTER = 100;

/** `[participants]` of arianna.toml: `leave_after` only. */
export interface ParticipantsConfig {
  leaveAfter: number;
}

export function isLeaveAfter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LEAVE_AFTER;
}

export function parseParticipants(value: unknown): ParticipantsConfig {
  if (value === undefined) return { leaveAfter: DEFAULT_LEAVE_AFTER };
  const table = asTable(value, 'participants');
  onlyKeys(table, ['leave_after'], 'participants');
  if (table.leave_after === undefined) return { leaveAfter: DEFAULT_LEAVE_AFTER };
  if (!isLeaveAfter(table.leave_after)) throw new ConfigError(`participants.leave_after: a whole number from 0 (never) to ${String(MAX_LEAVE_AFTER)}`);
  return { leaveAfter: table.leave_after };
}
