/**
 * The bar of Impostazioni → Personaggi (request of the user of 2026-10-16):
 * with seven series and more than fifty people, each series folds and a
 * search finds a person by name or by series. The series of the person in
 * view opens by itself; what the user opens or folds is kept in the browser.
 */

export interface SeriesPerson {
  id: string;
  name: string;
}

export interface SeriesGroup<T extends SeriesPerson> {
  show: string;
  members: T[];
}

export const SERIES_SIDEBAR_KEY = 'arianna.series-sidebar';

/** Lowercase, without accents and with single spaces: «Élliot» and «elliot» match. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The groups a search shows: every word of the query must be in the name, the
 * id or the series of the person («dr cox», «simpson homer»). An empty query
 * shows every group whole; a group without matches is left out.
 */
export function searchGroups<T extends SeriesPerson>(groups: readonly SeriesGroup<T>[], query: string): SeriesGroup<T>[] {
  const words = foldText(query).split(' ').filter((word) => word !== '');
  if (words.length === 0) return groups.map((group) => ({ show: group.show, members: [...group.members] }));
  return groups
    .map((group) => ({
      show: group.show,
      members: group.members.filter((person) => {
        const text = foldText(`${person.name} ${person.id} ${group.show}`);
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.members.length > 0);
}

/** Whether a group shows its people: opened, or found by a search. */
export function isSeriesOpen(show: string, opened: readonly string[], searching: boolean): boolean {
  return searching || opened.includes(show);
}

/** Opens the series of the person in view (the first time, or a person picked from a search); the user may fold it again. */
export function withSeries(opened: readonly string[], show: string | null): string[] {
  return show === null || opened.includes(show) ? [...opened] : [...opened, show];
}

/** Opens or folds one series. */
export function toggleSeries(opened: readonly string[], show: string): string[] {
  return opened.includes(show) ? opened.filter((item) => item !== show) : [...opened, show];
}

/** Reads what the browser kept: a list of names of series; anything else is nothing open. */
export function parseOpenSeries(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}
