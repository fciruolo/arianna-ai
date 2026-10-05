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

/** The voice trial page (D-066): a page of its own, not a conversation. */
export const VOICE_TRIAL_PATH = '/voce/provino';

export function isVoiceTrialPath(pathname: string): boolean {
  return pathname === VOICE_TRIAL_PATH || pathname === `${VOICE_TRIAL_PATH}/`;
}

/** The settings page (D-071). */
export const SETTINGS_PATH = '/impostazioni';

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_PATH || pathname === `${SETTINGS_PATH}/`;
}

/** The knowledge page (D-087): the graph of kb/. */
export const KNOWLEDGE_PATH = '/conoscenza';

export function isKnowledgePath(pathname: string): boolean {
  return pathname === KNOWLEDGE_PATH || pathname === `${KNOWLEDGE_PATH}/`;
}

/** The page of the thoughts (D-090). */
export const THOUGHTS_PATH = '/pensieri';

export function isThoughtsPath(pathname: string): boolean {
  return pathname === THOUGHTS_PATH || pathname === `${THOUGHTS_PATH}/`;
}

/** The knowledge page with a node selected (D-090): `/conoscenza?nota=inbox/x.md`. */
export function knowledgePathFor(nodeId: string): string {
  return `${KNOWLEDGE_PATH}?${new URLSearchParams({ nota: nodeId }).toString()}`;
}

/** The node the address of the knowledge page selects, or undefined. */
export function knowledgeFocus(search: string): string | undefined {
  const id = new URLSearchParams(search).get('nota')?.trim();
  return id === undefined || id === '' ? undefined : id;
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
