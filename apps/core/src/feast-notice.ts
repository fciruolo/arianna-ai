import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BASE_THEME } from '@arianna/config';

import { readSmallSync } from './characters.ts';
import { windowOf, type CalendarDay } from './feasts.ts';
import { feastNotSkipped, periodOf, type Theme } from './themes.ts';

/**
 * The notice of an automatic change of theme (D-315): when a feast takes the
 * place of Base, or Base comes back at its end, the chat shows a window the
 * first time it opens, on whichever device comes first. What the user
 * answered is kept by the core, so it holds on every device:
 *
 * - `seen`: the last automatic state answered, the key of a period of a
 *   feast (`<theme>@<first day>`) or `base`; none means `base`.
 * - `skip`: the period whose feast the user sent away («Torna a Base»): in
 *   those days Base stays, and the next period of a feast counts again.
 *
 * Nothing private: only ids of themes and days of the calendar.
 */
export interface FeastNoticeState {
  seen?: string;
  skip?: string;
}

/** What the chat shows: the start of a feast (with its last day) or its end. */
export type FeastNotice = { kind: 'start'; key: string; theme: string; until: string } | { kind: 'end'; key: string; theme: string };

/** The answers of the window: «Va bene», or «Torna a Base» at the start of a feast. */
export const FEAST_ANSWERS = ['ok', 'back'] as const;
export type FeastAnswer = (typeof FEAST_ANSWERS)[number];

const PERIOD_KEY = /^[a-z0-9][a-z0-9-]{0,39}@\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 1024;
/** How many days after the last day of a feast its end is still said (D-315). */
export const END_NOTICE_DAYS = 7;

export class FeastNoticeError extends Error {
  override name = 'FeastNoticeError';
}

/**
 * The notice to show now, or null: only when Base is the theme chosen (a
 * feast never replaces a theme chosen by hand) and the feasts are on, and
 * the automatic state differs from the one the user answered last.
 */
export function feastNotice(chosen: string, themes: readonly Theme[], feasts: { on: boolean; today: CalendarDay }, state: FeastNoticeState): FeastNotice | null {
  const served = themes.some((theme) => theme.id === chosen) ? chosen : BASE_THEME;
  if (!feasts.on || served !== BASE_THEME) return null;
  const feast = feastNotSkipped(themes, feasts.today, state.skip);
  const period = feast === undefined ? undefined : periodOf(feast, feasts.today);
  const seen = state.seen ?? BASE_THEME;
  if (feast !== undefined && period !== undefined) {
    return period.key === seen ? null : { kind: 'start', key: period.key, theme: feast.id, until: period.until };
  }
  if (seen === BASE_THEME) return null;
  // The feast seen has ended: said once, if its theme is still there to be named and its last day is
  // recent, so feasts switched off for months do not bring back the end of one long gone.
  const [ended = '', first = ''] = seen.split('@');
  const theme = themes.find((entry) => entry.id === ended);
  if (theme?.dates === undefined) return null;
  const [year = 0, month = 0, day = 0] = first.split('-').map(Number);
  const window = windowOf(theme.dates, { year, month, day });
  if (window === undefined) return null;
  const since = (Date.UTC(feasts.today.year, feasts.today.month - 1, feasts.today.day) - Date.UTC(window.to.year, window.to.month - 1, window.to.day)) / 86_400_000;
  return since > 0 && since <= END_NOTICE_DAYS ? { kind: 'end', key: BASE_THEME, theme: ended } : null;
}

/** The state after an answer to `notice`: «Va bene» marks it seen, «Torna a Base» skips the period. */
export function answerNotice(notice: FeastNotice, answer: FeastAnswer, state: FeastNoticeState): FeastNoticeState {
  if (answer === 'back') {
    if (notice.kind !== 'start') throw new FeastNoticeError('only the start of a feast can be sent away');
    return { seen: BASE_THEME, skip: notice.key };
  }
  return { ...state, seen: notice.key };
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && (value === BASE_THEME || PERIOD_KEY.test(value));
}

/** The answers kept in `data/themes/notice.json`; a missing or broken file is no answer yet. */
export interface FeastNoticeStore {
  read(): FeastNoticeState;
  write(state: FeastNoticeState): void;
}

export function feastNoticeStore(dataDir: string): FeastNoticeStore {
  const dir = join(dataDir, 'themes');
  const path = join(dir, 'notice.json');
  return {
    read() {
      try {
        // A regular file of at most 1 KB, never through a link.
        const raw = readSmallSync(path, MAX_BYTES);
        const value: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof value !== 'object' || value === null) return {};
        const { seen, skip } = value as Record<string, unknown>;
        return { ...(validKey(seen) ? { seen } : {}), ...(validKey(skip) && skip !== BASE_THEME ? { skip } : {}) };
      } catch {
        return {};
      }
    },
    write(state) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = join(dir, `.notice-${randomUUID()}.json`);
      try {
        writeFileSync(temporary, `${JSON.stringify({ seen: state.seen, skip: state.skip })}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          // Already renamed or never written.
        }
        throw error;
      }
    },
  };
}
