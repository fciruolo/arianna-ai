/**
 * Progetti on the phone (D-293): below `md` (768 px) the tabs File and Git
 * put their two panes one under the other, the list first. A file or a
 * commit chosen in the list then opens below it, out of sight: the page
 * scrolls to it. From `md` up the panes sit side by side and nothing moves.
 */
export const PANES_SIDE_BY_SIDE = 768;

/** Whether the panes of File and Git are stacked at this window width. */
export function panesStacked(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < PANES_SIDE_BY_SIDE;
}
