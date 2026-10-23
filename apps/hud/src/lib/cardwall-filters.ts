/**
 * The filters of the cardwall on the phone (D-294, after the user's try on
 * the iPhone: «i filtri si incasinano»): six chips of 44 px wrapped on three
 * lines. As in the apps of the phone (iOS Mail and Settings, GitHub,
 * Airbnb) the bar keeps one line, «Filtri» with the number of the active
 * ones, «Ordina» and «Colonne»; the active filters show as one row of chips
 * that scrolls sideways; «Filtri» opens a sheet with one row per filter, and
 * a row opens the choices of that filter. Pure: the page passes the fields
 * with their options, this says what to show.
 */
import type { IconName } from '../icons.ts';
import { ALL_FILTERS, type CardFilters } from './cardwall.ts';

export type FilterKey = keyof CardFilters;

export interface FilterOption {
  value: string;
  text: string;
}

/** One filter of the wall: its key, its name, its icon and its choices (the first is «every one»). */
export interface FilterField {
  key: FilterKey;
  label: string;
  icon: IconName;
  options: readonly FilterOption[];
}

/** One active filter as a chip: «Progetto: rossi». */
export interface ActiveFilter {
  key: FilterKey;
  label: string;
  value: string;
  text: string;
}

/** The text of the value chosen in a field; when no option has it (a project gone), the name without its `p:` or `a:`. */
export function chosenText(field: FilterField, value: string): string {
  return field.options.find((option) => option.value === value)?.text ?? value.replace(/^[pa]:/, '');
}

/** The filters that are not «every one», in the order of the fields. */
export function activeFilters(fields: readonly FilterField[], filters: CardFilters): ActiveFilter[] {
  return fields
    .filter((field) => filters[field.key] !== ALL_FILTERS[field.key])
    .map((field) => ({ key: field.key, label: field.label, value: filters[field.key], text: chosenText(field, filters[field.key]) }));
}

/** The label of the button of the bar: «Filtri», with the number in a dot beside it. */
export function filtersButtonLabel(count: number): string {
  if (count <= 0) return 'Filtri';
  return count === 1 ? 'Filtri, 1 attivo' : `Filtri, ${String(count)} attivi`;
}

/** The filters with one put back to «every one». */
export function withoutFilter(filters: CardFilters, key: FilterKey): CardFilters {
  return { ...filters, [key]: ALL_FILTERS[key] };
}

/**
 * The filters with one value chosen in a field: only a value among the
 * field's options counts (the narrow types of CardFilters hold only those);
 * anything else leaves the filters as they are.
 */
export function withFilter(filters: CardFilters, field: FilterField, value: string): CardFilters {
  if (!field.options.some((option) => option.value === value)) return filters;
  return { ...filters, [field.key]: value };
}

/** The button at the bottom of the sheet: how many cards the filters leave. */
export function showCardsText(count: number): string {
  if (count <= 0) return 'Chiudi · nessuna card';
  return `Mostra ${String(count)} card`;
}
