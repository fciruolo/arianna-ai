/**
 * The address of the open conversation, as on Claude and ChatGPT: `/c/<id>`,
 * so a reload or a bookmark comes back to it. The core and Vite answer any
 * unknown path with index.html, so the page reads the id from here.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation id in a path, or undefined for any other path. */
export function conversationFromPath(pathname: string): string | undefined {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1];
  return id !== undefined && UUID.test(id) ? id.toLowerCase() : undefined;
}

/** The path of a conversation, or the root when none is open. */
export function pathFor(conversationId: string | null): string {
  return conversationId === null ? '/' : `/c/${conversationId}`;
}

/** The tab title: the conversation's title, then the app's name. */
export function documentTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed === undefined || trimmed === '' ? 'Arianna' : `${trimmed} · Arianna`;
}
