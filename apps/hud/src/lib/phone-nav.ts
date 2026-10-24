/**
 * The navigation of the phone (D-293, tappa 2): below `md` a bar at the
 * bottom with five entries takes the place of the left bar. «Chat» and
 * «Attende te» are why one opens Arianna away from the Mac; «Pensieri»
 * catches an idea on the way; «Dashboard» is the state at a glance; «Altro»
 * holds every other area of the left bar, in its groups, with the settings.
 * Pure: App.vue and the components ask, this decides.
 */
import type { IconName } from '../icons.ts';
import { NAV_GROUPS, type NavArea, type NavGroup } from './nav-groups.ts';

export type PhoneTab = 'chat' | 'pending' | 'thoughts' | 'dashboard' | 'more';

export interface PhoneTabInfo {
  id: PhoneTab;
  label: string;
  icon: IconName;
}

export const PHONE_TABS: readonly PhoneTabInfo[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'pending', label: 'Attende te', icon: 'bell' },
  { id: 'thoughts', label: 'Pensieri', icon: 'thoughts' },
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'more', label: 'Altro', icon: 'more' },
];

/** The pages of App.vue: those of the left bar, the chat, and the two of the phone. */
export type AppPage =
  | 'chat'
  | 'voice-trial'
  | 'settings'
  | 'knowledge'
  | 'thoughts'
  | 'god'
  | 'office'
  | 'new-agent'
  | 'projects'
  | 'clients'
  | 'finance'
  | 'cardwall'
  | 'studio'
  | 'dashboard'
  | 'routines'
  | 'followed'
  | 'wiki'
  | 'gateway'
  | 'pending'
  | 'more';

/** The areas that are an entry of the bar: «Altro» does not repeat them. */
export const TAB_AREAS: readonly NavArea[] = ['thoughts', 'dashboard'];

/** The entry of the bar lit for a page: every page that is no entry of its own lives under «Altro». */
export function tabOf(page: AppPage): PhoneTab {
  switch (page) {
    case 'chat':
      return 'chat';
    case 'pending':
      return 'pending';
    case 'thoughts':
      return 'thoughts';
    case 'dashboard':
      return 'dashboard';
    default:
      return 'more';
  }
}

export interface TabBarState {
  page: AppPage;
  /** A conversation, a draft or the card of a closed incognito one fills the chat page. */
  conversationOpen: boolean;
  keyboard: boolean;
}

/** The bar steps aside inside a conversation (it has «‹» to go back) and while the keyboard is open. */
export function tabBarShown(state: TabBarState): boolean {
  if (state.keyboard) return false;
  return !(state.page === 'chat' && state.conversationOpen);
}

/** The groups of «Altro»: those of the left bar without the areas already in the bar at the bottom; an empty group goes. */
export function moreGroups(groups: readonly NavGroup[] = NAV_GROUPS): NavGroup[] {
  return groups.map((group) => ({ ...group, areas: group.areas.filter((area) => !TAB_AREAS.includes(area)) })).filter((group) => group.areas.length > 0);
}

/**
 * What waits for the user, as the panel counts it before its own reading
 * (StatusPanel.vue): the tasks waiting for an answer plus the approvals
 * without a task, never fewer than the approvals listed (review of D-293).
 */
export function pendingCountOf(waiting: number | undefined, approvals: readonly { taskId: string | null }[]): number {
  const tasks = Number.isFinite(waiting) && (waiting ?? 0) > 0 ? Math.floor(waiting ?? 0) : 0;
  return Math.max(tasks + approvals.filter((approval) => approval.taskId === null).length, approvals.length);
}

/** The number on «Attende te»: nothing at zero, «9+» beyond nine so it stays a small badge. */
export function tabBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}

/**
 * What a section of the settings can do from the phone, read from the remote
 * door of the core (`LOCAL_ONLY_PATHS` in apps/core/src/server/remote.ts, D-292):
 * `/api/devices` refuses the phone, so «Dispositivi» is only on the Mac; the
 * sections that let data out save through `/api/settings/privacy/`, refused
 * too, so from the phone they can be read, not changed. Keep in step with it.
 */
export type RemoteLimit = 'mac-only' | 'read-only';

export const REMOTE_LIMIT_TEXT: Record<RemoteLimit, string> = {
  'mac-only': 'Solo sul Mac',
  'read-only': 'Si cambia dal Mac',
};

export const REMOTE_LIMIT_NOTE: Record<RemoteLimit, string> = {
  'mac-only': 'Questa sezione si apre solo dal Mac: dal telefono Arianna non la mostra, per sicurezza.',
  'read-only': 'Dal telefono puoi leggere questa sezione; le modifiche fanno uscire dati dal Mac e si salvano solo dal Mac.',
};

export function remoteLimit(section: { id: string; privacy?: boolean }): RemoteLimit | undefined {
  // Devices and the folders of the Mac (D-314): the core refuses them from the phone.
  if (section.id === 'devices' || section.id === 'mac-folders') return 'mac-only';
  if (section.privacy === true) return 'read-only';
  return undefined;
}
