/**
 * A row of tabs that scrolls sideways (D-293): on a phone the row of
 * Finanze or of a client is wider than the screen, and the chosen tab may
 * sit outside the part in view. These place the row so that it shows.
 * Also the count of the folded filters of "Movimenti" on a phone.
 */

export interface StripBox {
  /** The tab's left edge, from the start of the row's content. */
  left: number;
  width: number;
}

export interface StripView {
  /** The visible width of the row. */
  width: number;
  /** The whole width of its content. */
  scrollWidth: number;
  scrollLeft: number;
}

/**
 * Where the row should scroll so the tab is in view: unchanged when it is
 * already whole in view (or the row does not scroll), otherwise the tab in
 * the middle, within the row's limits.
 */
export function stripScrollFor(tab: StripBox, view: StripView): number {
  const max = Math.max(0, view.scrollWidth - view.width);
  if (max === 0) return 0;
  const inView = tab.left >= view.scrollLeft && tab.left + tab.width <= view.scrollLeft + view.width;
  if (inView) return view.scrollLeft;
  const centered = tab.left - (view.width - tab.width) / 2;
  return Math.round(Math.min(max, Math.max(0, centered)));
}

/**
 * How many of the filters of "Movimenti" that fold away on a phone are set
 * (account, dates, category or "Senza categoria"): the count on the button
 * that opens them. The search stays in view and is not counted.
 */
export function foldedFilterCount(filter: { account: string; from: string; to: string; category: string; uncategorized: boolean }): number {
  return [filter.account !== '', filter.from !== '', filter.to !== '', filter.uncategorized || filter.category !== ''].filter(Boolean).length;
}

/** Scrolls a row of tabs to its chosen one (`aria-current`); nothing when the row fits. */
export function revealChosenTab(row: HTMLElement | null): void {
  if (row === null || row.scrollWidth <= row.clientWidth) return;
  const tab = row.querySelector<HTMLElement>('[aria-current]');
  if (tab === null) return;
  const box = tab.getBoundingClientRect();
  const next = stripScrollFor(
    { left: box.left - row.getBoundingClientRect().left + row.scrollLeft, width: box.width },
    { width: row.clientWidth, scrollWidth: row.scrollWidth, scrollLeft: row.scrollLeft },
  );
  if (next !== row.scrollLeft) row.scrollLeft = next;
}
