import type { Activity, ActivityKind, Delta, LiveEvent } from './types.ts';

/** What the core's WebSocket sends (apps/core/src/live.ts and server/http.ts). */
export type ServerMessage =
  | { type: 'event'; event: LiveEvent }
  | ({ type: 'delta' } & Delta)
  | ({ type: 'activity' } & Activity)
  | { type: 'ready' };

const ACTIVITY_KINDS: readonly ActivityKind[] = ['thinking', 'search', 'read', 'write', 'card', 'plan', 'error'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DIGITS = /^\d{1,19}$/;

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
      return { type: 'activity', conversationId, taskId, step, kind: known, detail };
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
