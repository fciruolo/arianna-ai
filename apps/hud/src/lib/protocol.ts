import { parseIncognitoFrame, type IncognitoSignal } from './incognito.ts';
import type { Activity, ActivityKind, Delta, EditPiece, EditTool, LiveEvent } from './types.ts';

/** What the core's WebSocket sends (apps/core/src/live.ts and server/http.ts). */
export type ServerMessage =
  | { type: 'event'; event: LiveEvent }
  | ({ type: 'delta' } & Delta)
  | ({ type: 'activity'; incognito?: true } & Activity)
  | ({ type: 'edit' } & EditPiece)
  /** A notification (I-1): a kind and a conversation, never text; the page decides whether to show it. */
  | { type: 'notice'; kind: NoticeKind; conversationId: string | null; trial?: true; helper?: true }
  /** An incognito conversation closed, or closes in a minute (D-136): its id and the cause, never text. */
  | IncognitoSignal
  | { type: 'ready' };

export type NoticeKind = 'reply' | 'approval' | 'failure' | 'reminder';
const NOTICE_KINDS: readonly NoticeKind[] = ['reply', 'approval', 'failure', 'reminder'];

const ACTIVITY_KINDS: readonly ActivityKind[] = ['thinking', 'search', 'read', 'write', 'card', 'plan', 'error', 'delegate', 'tool', 'wait'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DIGITS = /^\d{1,19}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The same list as FILE_EDIT_TOOLS of @arianna/executors, repeated: the page does not import the core's packages.
const EDIT_TOOLS: readonly EditTool[] =['Edit', 'MultiEdit', 'Write'];
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A piece of a live change (D-117): only L0 and L1, a known tool, a piece within its total. */
function parseEdit(value: Record<string, unknown>): ({ type: 'edit' } & EditPiece) | undefined {
  const { editId, conversationId, taskId, step, path, tool, label, added, removed, error, seq, total, text } = value;
  const known = EDIT_TOOLS.find((item) => item === tool);
  if (
    typeof editId !== 'string' ||
    typeof conversationId !== 'string' ||
    typeof taskId !== 'string' ||
    !count(step) ||
    typeof path !== 'string' ||
    path === '' ||
    known === undefined ||
    (label !== 'L0' && label !== 'L1') ||
    !count(added) ||
    !count(removed) ||
    (error !== undefined && error !== 'too-large' && error !== 'refused') ||
    !count(seq) ||
    !count(total) ||
    seq >= total ||
    typeof text !== 'string'
  ) {
    return undefined;
  }
  return { type: 'edit', editId, conversationId, taskId, step, path, tool: known, label, added, removed, ...(error === undefined ? {} : { error }), seq, total, text };
}

/** Parses one frame; anything malformed is dropped rather than trusted. */
export function parseServerMessage(raw: string): ServerMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'ready':
      return { type: 'ready' };
    case 'delta': {
      const { replyId, conversationId, taskId, seq, text } = value;
      if (
        typeof replyId !== 'string' ||
        typeof conversationId !== 'string' ||
        typeof taskId !== 'string' ||
        typeof seq !== 'number' ||
        !Number.isInteger(seq) ||
        seq < 0 ||
        typeof text !== 'string'
      ) {
        return undefined;
      }
      return { type: 'delta', replyId, conversationId, taskId, seq, text };
    }
    case 'activity': {
      const { conversationId, taskId, step, kind, detail } = value;
      const known = ACTIVITY_KINDS.find((item) => item === kind);
      if (
        typeof conversationId !== 'string' ||
        typeof taskId !== 'string' ||
        typeof step !== 'number' ||
        !Number.isInteger(step) ||
        known === undefined ||
        typeof detail !== 'string'
      ) {
        return undefined;
      }
      // `incognito: true` from the core (D-136): the office leaves it out even when this page does not know the conversation.
      return { type: 'activity', conversationId, taskId, step, kind: known, detail, ...(value.incognito === true ? { incognito: true as const } : {}) };
    }
    case 'edit':
      return parseEdit(value);
    case 'conversation.incognito-closed':
    case 'conversation.incognito-closing':
      return parseIncognitoFrame(value);
    case 'notice': {
      const kind = NOTICE_KINDS.find((item) => item === value.kind);
      const { conversationId } = value;
      if (kind === undefined || (conversationId !== null && (typeof conversationId !== 'string' || !UUID.test(conversationId)))) return undefined;
      return {
        type: 'notice',
        kind,
        conversationId,
        ...(value.trial === true ? { trial: true as const } : {}),
        // The helper of the Mac shows it (D-128): no notification of the browser.
        ...(value.helper === true ? { helper: true as const } : {}),
      };
    }
    case 'event': {
      const event = value.event;
      if (!isRecord(event) || typeof event.id !== 'string' || !DIGITS.test(event.id) || typeof event.kind !== 'string') return undefined;
      return {
        type: 'event',
        event: {
          id: event.id,
          ts: typeof event.ts === 'string' ? event.ts : '',
          taskId: typeof event.taskId === 'string' ? event.taskId : null,
          runId: typeof event.runId === 'string' ? event.runId : null,
          agent: typeof event.agent === 'string' ? event.agent : null,
          kind: event.kind,
          label: event.label === 'L0' || event.label === 'L1' || event.label === 'L3' ? event.label : 'L2',
          payload: isRecord(event.payload) ? event.payload : {},
        },
      };
    }
    default:
      return undefined;
  }
}

/** A string field of an event payload, if present. */
export function payloadString(event: LiveEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

/** Later of two event ids (bigint strings), for resuming after a reconnection. */
export function laterId(a: string | undefined, b: string): string {
  return a === undefined || BigInt(b) > BigInt(a) ? b : a;
}
