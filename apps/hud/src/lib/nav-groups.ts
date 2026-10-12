/**
 * The areas of the left bar in three groups that fold (readability pass of
 * 2026-10-12): with eleven areas above the conversations, finding a chat meant
 * scrolling past the menu. The group of the page in view is always open.
 */

export type NavGroupId = 'work' | 'personal' | 'system';

export type NavArea =
  | 'secretary'
  | 'projects'
  | 'clients'
  | 'cardwall'
  | 'studio'
  | 'thoughts'
  | 'knowledge'
  | 'finance'
  | 'god'
  | 'office'
  | 'settings';

export interface NavGroup {
  id: NavGroupId;
  title: string;
  areas: readonly NavArea[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'work', title: 'Lavoro', areas: ['secretary', 'projects', 'clients', 'cardwall', 'studio'] },
  { id: 'personal', title: 'Personale', areas: ['thoughts', 'knowledge', 'finance'] },
  { id: 'system', title: 'Sistema', areas: ['god', 'office', 'settings'] },
];

/** Only "Lavoro" open the first time. */
export const DEFAULT_OPEN: readonly NavGroupId[] = ['work'];

export const NAV_STORAGE_KEY = 'arianna.nav-groups';

/** The group holding an area, or null for an area outside the menu (the chat). */
export function groupOf(area: NavArea | null): NavGroupId | null {
  if (area === null) return null;
  return NAV_GROUPS.find((group) => group.areas.includes(area))?.id ?? null;
}

/** Whether a group shows its areas: chosen open, or holding the page in view. */
export function isOpen(group: NavGroupId, chosen: readonly NavGroupId[], current: NavArea | null): boolean {
  return chosen.includes(group) || groupOf(current) === group;
}

/** Folds or unfolds a group, keeping the order of NAV_GROUPS. */
export function toggle(chosen: readonly NavGroupId[], group: NavGroupId): NavGroupId[] {
  const next = chosen.includes(group) ? chosen.filter((id) => id !== group) : [...chosen, group];
  return NAV_GROUPS.map((item) => item.id).filter((id) => next.includes(id));
}

/** Reads what localStorage kept; anything unexpected gives the default. */
export function parseOpen(raw: string | null): NavGroupId[] {
  if (raw === null) return [...DEFAULT_OPEN];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [...DEFAULT_OPEN];
    const ids = NAV_GROUPS.map((group) => group.id);
    return ids.filter((id) => value.includes(id));
  } catch {
    return [...DEFAULT_OPEN];
  }
}
