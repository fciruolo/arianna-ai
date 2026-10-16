import type { Conversation, Label } from '../types.ts';
import { containerOf, type OfficeInput, type RoomClaim } from './snapshot.ts';
import type { RunningWork } from './talk.ts';

/**
 * Which projects have a room in the office (D-229, the user's choice of
 * 2026-10-15, question 8 of D-106): first the ones the user pinned, then
 * those active in the last ACTIVE_DAYS days; the others behind the archive.
 * Worked out in the chat from what it already reads, nothing new from the
 * core: a project is pinned when one of its work conversations is pinned
 * (D-089), active when one of them had a message (or was born) in the last
 * days, or when an agent works on it now. Only conversations up to L2 count,
 * as for "Parla con" (talk.ts): one above L2 never says anything here. What
 * leaves is only the project's name, at most L1 (D-058).
 */
export const ACTIVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const VISIBLE: readonly Label[] = ['L0', 'L1', 'L2'];

type ConversationRef = Pick<Conversation, 'mode' | 'workspace' | 'archivedAt' | 'pinnedAt' | 'lastMessageAt' | 'createdAt' | 'effectiveLabel'>;

/** The project a repository named by the core belongs to: by name, path or the last folder of the path (as placeOfRepo). */
function projectOfRepo(repo: string, projects: OfficeInput['projects']): string | undefined {
  const project = projects.find((item) => item.name === repo || item.path === repo || item.path.split('/').at(-1) === repo);
  return project === undefined ? undefined : containerOf(project.name);
}

export function roomClaims(
  projects: OfficeInput['projects'],
  conversations: readonly ConversationRef[],
  work: readonly Pick<RunningWork, 'repo'>[],
  now: number,
): Map<string, RoomClaim> {
  const known = new Set(projects.map((item) => containerOf(item.name)));
  const claims = new Map<string, RoomClaim>();
  const claim = (name: string, kind: RoomClaim): void => {
    if (!known.has(name) || claims.get(name) === 'pinned') return;
    claims.set(name, kind);
  };
  for (const item of conversations) {
    if (item.mode !== 'work' || item.workspace === null || item.archivedAt !== null || !VISIBLE.includes(item.effectiveLabel)) continue;
    const name = containerOf(item.workspace);
    if (item.pinnedAt !== null) {
      claim(name, 'pinned');
      continue;
    }
    const at = Date.parse(item.lastMessageAt ?? item.createdAt);
    if (!Number.isNaN(at) && now - at <= ACTIVE_DAYS * DAY_MS) claim(name, 'active');
  }
  for (const item of work) {
    const name = item.repo === null ? undefined : projectOfRepo(item.repo, projects);
    if (name !== undefined) claim(name, 'active');
  }
  return claims;
}
