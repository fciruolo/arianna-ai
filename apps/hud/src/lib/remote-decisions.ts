import { payloadString } from './protocol.ts';
import type { LiveEvent } from './types.ts';

/**
 * An approval decided away from the web chat (Telegram, later the phone). Its
 * card leaves "Attende te" as soon as it is decided: this note says where the
 * decision came from, so that it does not just vanish.
 */
export interface RemoteDecision {
  approvalId: string;
  state: 'approved' | 'rejected';
  via: 'telegram' | 'phone';
  /** The approval's action, if the page still had its card. */
  action: string | undefined;
  ts: string;
}

/** How many notes are kept; the oldest go first. */
export const MAX_REMOTE_DECISIONS = 5;

export function remoteDecision(event: LiveEvent, action?: string): RemoteDecision | undefined {
  if (event.kind !== 'approval.decided') return undefined;
  const approvalId = payloadString(event, 'approvalId');
  const state = payloadString(event, 'state');
  const via = payloadString(event, 'via');
  if (approvalId === undefined || (state !== 'approved' && state !== 'rejected') || (via !== 'telegram' && via !== 'phone')) return undefined;
  return { approvalId, state, via, action, ts: event.ts };
}

/** Newest first, one note per approval, at most `max`. */
export function addRemoteDecision(list: readonly RemoteDecision[], decision: RemoteDecision, max = MAX_REMOTE_DECISIONS): RemoteDecision[] {
  return [decision, ...list.filter((item) => item.approvalId !== decision.approvalId)].slice(0, max);
}
