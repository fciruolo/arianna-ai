import type { Approval } from './types.ts';

/**
 * Approvals decided away from the web chat (Telegram, later the phone). Their
 * card leaves "Attende te" as soon as they are decided: a note says where the
 * decision came from. Notes come from the API, so a reload keeps them, and
 * they show decisions taken while the page was closed.
 */
export interface RemoteDecision {
  approvalId: string;
  state: 'approved' | 'rejected';
  via: 'telegram' | 'phone';
  action: string;
  /** When it was decided (ISO). */
  ts: string;
}

/** How long a note stays. */
export const REMOTE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many notes are shown, newest first. */
export const MAX_REMOTE_DECISIONS = 5;

/** The notes for decided approvals, newest first, without the dismissed ones. */
export function remoteDecisions(
  decided: readonly Approval[],
  now: number,
  dismissed: ReadonlySet<string>,
  max = MAX_REMOTE_DECISIONS,
): RemoteDecision[] {
  const notes: RemoteDecision[] = [];
  for (const approval of decided) {
    const { state, decidedVia: via, decidedAt } = approval;
    if (state !== 'approved' && state !== 'rejected') continue;
    if (via !== 'telegram' && via !== 'phone') continue;
    const at = decidedAt === null ? Number.NaN : Date.parse(decidedAt);
    if (!(now - at <= REMOTE_WINDOW_MS) || dismissed.has(approval.id)) continue;
    notes.push({ approvalId: approval.id, state, via, action: approval.action, ts: decidedAt ?? '' });
  }
  return notes.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, max);
}

const DISMISSED_KEY = 'arianna.dismissedDecisions';

/** Notes closed with ×, remembered in this browser only. Storage may be missing or full. */
export function loadDismissed(storage: Pick<Storage, 'getItem'> | undefined): Set<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Keeps only ids that may still show up, so the list does not grow forever. */
export function saveDismissed(storage: Pick<Storage, 'setItem'> | undefined, dismissed: ReadonlySet<string>, keep: ReadonlySet<string>): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify([...dismissed].filter((id) => keep.has(id))));
  } catch {
    // Not remembered: the note comes back after a reload.
  }
}
