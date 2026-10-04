/**
 * Which side bars the user collapsed on a wide screen: the conversations on
 * the left, the status panel on the right. Like the theme, a convenience of
 * this browser only (localStorage): a missing or blocked storage means both
 * open.
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
 * The grid columns of the page for each pair of collapsed bars. Written out
 * in full because Tailwind only generates classes it finds as whole strings.
 */
export function gridColumns(layout: Layout): string {
  const md = layout.sidebar ? 'md:grid-cols-[56px_minmax(0,1fr)]' : 'md:grid-cols-[56px_248px_minmax(0,1fr)]';
  const xl = layout.sidebar
    ? layout.panel
      ? 'xl:grid-cols-[56px_minmax(0,1fr)]'
      : 'xl:grid-cols-[56px_minmax(0,1fr)_300px]'
    : layout.panel
      ? 'xl:grid-cols-[56px_248px_minmax(0,1fr)]'
      : 'xl:grid-cols-[56px_248px_minmax(0,1fr)_300px]';
  return `${md} ${xl}`;
}
