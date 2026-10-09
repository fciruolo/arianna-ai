/**
 * Which side bars the user collapsed on a wide screen (D-097): the left bar
 * (search, areas, agents, conversations) and the right bar (agents and
 * status). A collapsed bar leaves only the icon that opens it again, in the top bar. Like the
 * theme, a convenience of this browser only (localStorage): a missing or
 * blocked storage means both open.
 */
export interface Layout {
  sidebar: boolean;
  panel: boolean;
}

const KEY = 'arianna.layout';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const OPEN_LAYOUT: Layout = { sidebar: false, panel: false };

/** Reads the collapsed bars; anything unexpected counts as open. */
export function loadLayout(storage: StorageLike | undefined): Layout {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return { ...OPEN_LAYOUT };
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return { ...OPEN_LAYOUT };
    const record = value as Record<string, unknown>;
    return { sidebar: record.sidebar === true, panel: record.panel === true };
  } catch {
    return { ...OPEN_LAYOUT };
  }
}

export function saveLayout(storage: StorageLike | undefined, layout: Layout): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ sidebar: layout.sidebar, panel: layout.panel }));
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
}

/**
 * From this width (CSS pixels, the `3xl` breakpoint of style.css: 100rem) the
 * right bar is a column beside the page (D-150). Below it, as on a laptop
 * (MacBook Pro 14": about 1512 px), the bar starts closed and opens over the
 * page from its button, so the chat, the projects and the knowledge keep the
 * width. Keep it equal to `--breakpoint-3xl`; App.vue reads it with matchMedia
 * in rem (PANEL_COLUMN_PX / 16), like the CSS, so a bigger browser font moves both.
 */
export const PANEL_COLUMN_PX = 1600;

/** Whether the right bar is a column at this window width (true) or a drawer that starts closed (false). */
export function panelIsColumn(width: number): boolean {
  return width >= PANEL_COLUMN_PX;
}

/**
 * The grid columns of the page for each pair of collapsed bars: a collapsed
 * bar takes no column at all, the page takes the whole width and only the
 * icon that opens the bar again stays, in the top bar. The right bar is a
 * column only from `3xl` (D-150); below it is a drawer. Written out in full
 * because Tailwind only generates classes it finds as whole strings.
 */
export function gridColumns(layout: Layout): string {
  const md = layout.sidebar ? 'md:grid-cols-[minmax(0,1fr)]' : 'md:grid-cols-[264px_minmax(0,1fr)]';
  const wide = layout.sidebar
    ? layout.panel
      ? '3xl:grid-cols-[minmax(0,1fr)]'
      : '3xl:grid-cols-[minmax(0,1fr)_300px]'
    : layout.panel
      ? '3xl:grid-cols-[264px_minmax(0,1fr)]'
      : '3xl:grid-cols-[264px_minmax(0,1fr)_300px]';
  return `${md} ${wide}`;
}
