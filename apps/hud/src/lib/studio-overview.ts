// The Studio without a project (D-194): one card per project with up to
// three thumbnails of its mockups, how many there are and the latest one.
import type { Mockup } from './studio.ts';

/** Thumbnails on a card. */
export const THUMBS_MAX = 3;
/**
 * Thumbnails on the whole page: the core keeps at most 32 frames for every
 * page of the chat (MAX_FRAMES of apps/core/src/studio-frames.ts), so the
 * cards leave room for the Studio open elsewhere.
 */
export const THUMBS_PAGE_MAX = 24;
/** The page a thumbnail draws, before it is scaled down: a desktop window. */
export const THUMB_PAGE = { width: 1280, height: 960 } as const;

export interface ProjectOverview {
  count: number;
  /** The mockup changed last, or undefined without mockups. */
  latest: Mockup | undefined;
  /** The mockups changed last, newest first, at most THUMBS_MAX. */
  thumbs: Mockup[];
}

function time(file: Mockup): number {
  const value = Date.parse(file.modified);
  return Number.isNaN(value) ? 0 : value;
}

/** Newest first; at equal times by name, so the order never jumps between readings. */
export function overviewOf(files: readonly Mockup[]): ProjectOverview {
  const sorted = [...files].sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
  return { count: files.length, latest: sorted[0], thumbs: sorted.slice(0, THUMBS_MAX) };
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

/** «5 mockup · ultimo landing-4, 12 ott», «1 mockup · 10 ott», or the invitation to ask one. */
export function overviewText(overview: ProjectOverview): string {
  const latest = overview.latest;
  if (overview.count === 0 || latest === undefined) return 'Nessun mockup: chiedine uno al Designer';
  const when = shortDate(latest.modified);
  const name = latest.name.replace(/\.html$/i, '');
  if (overview.count === 1) return when === '' ? `1 mockup · ${name}` : `1 mockup · ${name}, ${when}`;
  return `${String(overview.count)} mockup · ultimo ${name}${when === '' ? '' : `, ${when}`}`;
}

/** How much a page of THUMB_PAGE.width shrinks to fit a box this wide; 0 for a box not measured yet. */
export function thumbScale(boxWidth: number): number {
  if (!Number.isFinite(boxWidth) || boxWidth <= 0) return 0;
  return Math.min(1, boxWidth / THUMB_PAGE.width);
}

/** The thumbnails each card may show, in the order of the cards, within THUMBS_PAGE_MAX in all. */
export function allotThumbs(counts: readonly number[], max = THUMBS_PAGE_MAX): number[] {
  let left = Math.max(0, max);
  return counts.map((count) => {
    const given = Math.min(Math.max(0, count), left);
    left -= given;
    return given;
  });
}
