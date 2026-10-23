/**
 * The areas of the left bar in three groups that fold (readability pass of
 * 2026-10-12): with eleven areas (twelve with the Dashboard, D-248) above the conversations, finding a chat meant
 * scrolling past the menu. The group of the page in view is always open.
 */

import type { IconName } from '../icons.ts';

export type NavGroupId = 'work' | 'personal' | 'system';

export type NavArea =
  | 'dashboard'
  | 'secretary'
  | 'projects'
  | 'clients'
  | 'cardwall'
  | 'studio'
  | 'thoughts'
  | 'routines'
  | 'knowledge'
  | 'wiki'
  | 'finance'
  | 'god'
  | 'followed'
  | 'office'
  | 'gateway'
  | 'settings';

export interface NavGroup {
  id: NavGroupId;
  title: string;
  areas: readonly NavArea[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'work', title: 'Lavoro', areas: ['dashboard', 'secretary', 'projects', 'clients', 'cardwall', 'studio'] },
  { id: 'personal', title: 'Personale', areas: ['thoughts', 'routines', 'knowledge', 'wiki', 'finance'] },
  { id: 'system', title: 'Sistema', areas: ['god', 'followed', 'office', 'gateway', 'settings'] },
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

/** The name, icon and hint of every area: the left bar and «Altro» on the phone (D-293). */
export const AREAS: Record<NavArea, { label: string; icon: IconName; title?: string }> = {
  // The Dashboard (D-248): the answers pinned from the chat, refreshed on the local model.
  dashboard: { label: 'Dashboard', icon: 'dashboard', title: 'Le risposte fissate dalla chat, da aggiornare col modello locale' },
  secretary: { label: 'Segretaria', icon: 'secretary', title: 'Di’ ad Arianna le cose da fare: le segna con il giorno' },
  projects: { label: 'Progetti', icon: 'project' },
  clients: { label: 'Clienti', icon: 'clients' },
  cardwall: { label: 'Cardwall', icon: 'cardwall' },
  // The Studio (I-19, D-184): the Designer's mockups, isolated, with comments and exports.
  studio: { label: 'Studio', icon: 'studio' },
  thoughts: { label: 'Pensieri', icon: 'thoughts' },
  // The routines (D-110 tappa A, D-254): recurring reports, each in its own chat marked «R».
  routines: { label: 'Routine', icon: 'routine', title: 'Appuntamenti ricorrenti: il resoconto arriva nella chat della routine' },
  knowledge: { label: 'Conoscenza', icon: 'knowledge' },
  // The Wiki (D-280): pages the local model proposes from the notes; the user approves them.
  wiki: { label: 'Wiki', icon: 'wiki', title: 'Pagine compilate dal modello locale dalle tue note, da approvare' },
  // The finances (I-18, D-183): private, they never leave this Mac.
  finance: { label: 'Finanze', icon: 'finance' },
  // GOD (D-127): Arianna developed from inside Arianna, in a clone of its code.
  god: { label: 'GOD', icon: 'god', title: 'Sviluppa Arianna da dentro Arianna, in un clone del suo codice' },
  // «Seguiti» (D-272): projects, accounts, oMLX and the catalogs followed on GitHub.
  followed: { label: 'Seguiti', icon: 'followed', title: 'Progetti, account e cataloghi seguiti su GitHub per prendere idee' },
  office: { label: 'Ufficio', icon: 'office' },
  // «Registro del gateway» (D-296): every decision of the gateway, never the text.
  gateway: { label: 'Registro del gateway', icon: 'gateway', title: 'Ogni uscita di Arianna, ammessa o bloccata, senza il testo' },
  settings: { label: 'Impostazioni', icon: 'settings' },
};
