/**
 * Bringing an element of a conversation into view (D-091): the "Decisioni in
 * attesa" window asks for the approval card (`approval-<id>`) or the message
 * (`message-<id>`) of what it lists; the chat scrolls to it once it is on the
 * page and lights it up for a moment. A fragment of the address with the same
 * id (`/c/<id>#message-42`) asks the same when the page loads. An element that
 * never shows up (an older message, a decided card) is simply not found.
 */

/** How long the element stays lit. */
export const HIGHLIGHT_MS = 2000;
/** How long a request waits for its element (the conversation and its approvals load). */
export const FOCUS_WAIT_MS = 10_000;
/** Sent on `window` when a request is made: an open chat looks at once. */
export const FOCUS_EVENT = 'arianna:focus';
/** Classes that light the element up (Tailwind, written whole so that they are generated). */
export const HIGHLIGHT_CLASSES: readonly string[] = ['ring-2', 'ring-warn', 'ring-offset-4', 'ring-offset-bg', 'transition-shadow'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^\d{1,19}$/;

/** The element id of an approval card. */
export function approvalAnchor(approvalId: string): string {
  return `approval-${approvalId}`;
}

/** The element id of a message. */
export function messageAnchor(messageId: string): string {
  return `message-${messageId}`;
}

/** The element id a fragment (`#approval-<uuid>`, `#message-<n>`) names, or undefined for any other. */
export function parseAnchor(hash: string): string | undefined {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const approval = /^approval-(.+)$/.exec(value)?.[1];
  if (approval !== undefined) return UUID.test(approval) ? approvalAnchor(approval.toLowerCase()) : undefined;
  const message = /^message-(.+)$/.exec(value)?.[1];
  if (message !== undefined) return MESSAGE_ID.test(message) ? messageAnchor(message) : undefined;
  return undefined;
}

interface FocusRequest {
  conversationId: string;
  anchor: string;
  at: number;
}

let request: FocusRequest | null = null;

/** Asks the chat of `conversationId` to bring `anchor` into view; replaces an earlier request. */
export function requestFocus(conversationId: string, anchor: string, now = Date.now()): void {
  request = { conversationId, anchor, at: now };
}

/** The anchor waiting for this conversation, if any and not too old; an expired request is dropped. */
export function pendingFocus(conversationId: string | null, now = Date.now()): string | undefined {
  if (request === null) return undefined;
  if (now - request.at > FOCUS_WAIT_MS) {
    request = null;
    return undefined;
  }
  return request.conversationId === conversationId ? request.anchor : undefined;
}

/** The request was carried out. */
export function clearFocus(): void {
  request = null;
}
