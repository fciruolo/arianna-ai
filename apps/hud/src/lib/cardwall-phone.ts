/**
 * The cardwall on the phone (D-293): one column at a time, chosen from a row
 * of tabs. Pure helpers, so the page only asks which column it shows.
 */

/**
 * The column shown on the phone: the one the user chose while it is still
 * on the wall; otherwise the first with cards, otherwise the first one;
 * null when every column is hidden.
 */
export function phoneColumn<Id extends string>(columns: readonly { id: Id }[], chosen: Id | null, count: (id: Id) => number): Id | null {
  if (chosen !== null && columns.some((column) => column.id === chosen)) return chosen;
  return (columns.find((column) => count(column.id) > 0) ?? columns[0])?.id ?? null;
}

/** The column beside the shown one (`step` -1 or +1), or null at either end. */
export function neighbourColumn<Id extends string>(columns: readonly { id: Id }[], shown: Id | null, step: -1 | 1): Id | null {
  const at = columns.findIndex((column) => column.id === shown);
  if (at === -1) return null;
  return columns[at + step]?.id ?? null;
}
