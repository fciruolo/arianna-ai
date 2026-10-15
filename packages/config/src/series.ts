import { parseSeriesOverride, SeriesOverrideError, type SeriesOverride } from '@arianna/agents';

import { CHARACTER_ID } from './characters.ts';
import { asTable, ConfigError } from './validate.ts';

/**
 * What the user rewrote of the people of the series (D-223): `[series.<id>]`
 * of arianna.toml, character id of the pack `serie` → personality, scene and
 * catchphrases. The user's text, Interno (L1) by declaration as the persona of
 * D-107; a character without a table keeps the repository's text. An id the
 * pack does not have is kept and never used.
 */
export type SeriesOverrides = Record<string, SeriesOverride>;

export function parseSeries(value: unknown): SeriesOverrides {
  if (value === undefined) return {};
  const table = asTable(value, 'series');
  const series: SeriesOverrides = {};
  for (const [id, raw] of Object.entries(table)) {
    if (!CHARACTER_ID.test(id)) throw new ConfigError('series: a character id is lowercase letters, digits, - and _');
    try {
      const override = parseSeriesOverride(raw, `series.${id}`);
      if (Object.keys(override).length > 0) series[id] = override;
    } catch (error) {
      // The message names the field, never the user's text.
      if (error instanceof SeriesOverrideError) throw new ConfigError(error.message);
      throw error;
    }
  }
  return series;
}
