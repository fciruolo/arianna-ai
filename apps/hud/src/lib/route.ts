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

/** `/impostazioni`, or one of its sections (D-105): `/impostazioni/<slug>`. */
export function isSettingsPath(pathname: string): boolean {
  return /^\/impostazioni(?:\/[a-z0-9-]+)?\/?$/.test(pathname);
}

/** The section the address names (D-105), or undefined for the page alone. */
export function settingsSlug(pathname: string): string | undefined {
  return /^\/impostazioni\/([a-z0-9-]+)\/?$/.exec(pathname)?.[1];
}

/** The address of a section of the settings, or of the page alone. */
export function settingsPathFor(slug: string | undefined): string {
  return slug === undefined ? SETTINGS_PATH : `${SETTINGS_PATH}/${slug}`;
}

/** "Sviluppo di Arianna" (D-102): progress of the development and the open questions, reached from the settings. */
export const DEV_PATH = '/sviluppo';

export function isDevPath(pathname: string): boolean {
  return pathname === DEV_PATH || pathname === `${DEV_PATH}/`;
}

/** The knowledge page (D-087): the graph of kb/. */
export const KNOWLEDGE_PATH = '/conoscenza';

export function isKnowledgePath(pathname: string): boolean {
  return pathname === KNOWLEDGE_PATH || pathname === `${KNOWLEDGE_PATH}/`;
}

/** The office (D-106): the agents in a pixel office. */
export const OFFICE_PATH = '/ufficio';

export function isOfficePath(pathname: string): boolean {
  return pathname === OFFICE_PATH || pathname === `${OFFICE_PATH}/`;
}

/** The page of GOD (D-127): Arianna developed from inside Arianna. */
export const GOD_PATH = '/god';

export function isGodPath(pathname: string): boolean {
  return pathname === GOD_PATH || pathname === `${GOD_PATH}/`;
}

/** The page of the thoughts (D-090). */
export const THOUGHTS_PATH = '/pensieri';

export function isThoughtsPath(pathname: string): boolean {
  return pathname === THOUGHTS_PATH || pathname === `${THOUGHTS_PATH}/`;
}

/** The routines (D-110 tappa A, D-254): recurring reports in their own chats. */
export const ROUTINES_PATH = '/routine';

export function isRoutinesPath(pathname: string): boolean {
  return pathname === ROUTINES_PATH || pathname === `${ROUTINES_PATH}/`;
}

/** «Seguiti» (D-272): projects, accounts, oMLX, Open Design and the catalogs followed, in one page. */
export const FOLLOWED_PATH = '/seguiti';

export function isFollowedPath(pathname: string): boolean {
  return pathname === FOLLOWED_PATH || pathname === `${FOLLOWED_PATH}/`;
}

/** The Wiki (D-280): pages proposed by the local model from the notes, approved by the user. */
export const WIKI_PATH = '/wiki';

export function isWikiPath(pathname: string): boolean {
  return pathname === WIKI_PATH || pathname === `${WIKI_PATH}/`;
}

/** «Attende te» on the phone (D-293): the decisions that wait for the user and the agents at work. */
export const PENDING_PATH = '/attende-te';

export function isPendingPath(pathname: string): boolean {
  return pathname === PENDING_PATH || pathname === `${PENDING_PATH}/`;
}

/** «Altro» on the phone (D-293): every other area, the theme and the state of the link. */
export const MORE_PATH = '/altro';

export function isMorePath(pathname: string): boolean {
  return pathname === MORE_PATH || pathname === `${MORE_PATH}/`;
}

/** Inside the page: the address changes and the app follows it, as with "back" (MockupLink does the same). */
export function goTo(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** A plain click on a link inside the app goes there with goTo; with a modifier key the browser does what it does. */
export function openInside(event: MouseEvent, path: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  goTo(path);
}

/** The Dashboard (D-248): the answers pinned from the chat. */
export const DASHBOARD_PATH = '/dashboard';
/** Its first address, before the user renamed the page (2026-10-17): it leads to the new one. */
export const OLD_DASHBOARD_PATH = '/cruscotto';

export function isDashboardPath(pathname: string): boolean {
  return [DASHBOARD_PATH, `${DASHBOARD_PATH}/`, OLD_DASHBOARD_PATH, `${OLD_DASHBOARD_PATH}/`].includes(pathname);
}

/** What the knowledge page shows: the user's notes (kb/) or Arianna's own documents (D-155). */
export type KnowledgeSource = 'kb' | 'arianna';

/**
 * The knowledge page with a node selected (D-090): `/conoscenza?nota=inbox/x.md`;
 * with Arianna's documents (D-155) `fonte=arianna` comes first.
 */
export function knowledgePathFor(nodeId?: string, source: KnowledgeSource = 'kb'): string {
  const params = new URLSearchParams();
  if (source === 'arianna') params.set('fonte', 'arianna');
  if (nodeId !== undefined) params.set('nota', nodeId);
  const query = params.toString();
  return query === '' ? KNOWLEDGE_PATH : `${KNOWLEDGE_PATH}?${query}`;
}

/** The source the address of the knowledge page asks for: anything but `fonte=arianna` is the notes. */
export function knowledgeSource(search: string): KnowledgeSource {
  return new URLSearchParams(search).get('fonte')?.trim().toLowerCase() === 'arianna' ? 'arianna' : 'kb';
}

/** The node the address of the knowledge page selects, or undefined. */
export function knowledgeFocus(search: string): string | undefined {
  const id = new URLSearchParams(search).get('nota')?.trim();
  return id === undefined || id === '' ? undefined : id;
}

/** The secretary's one conversation (D-156): its own address instead of `/c/<id>`. */
export const SECRETARY_PATH = '/segretaria';

export function isSecretaryPath(pathname: string): boolean {
  return pathname === SECRETARY_PATH || pathname === `${SECRETARY_PATH}/`;
}

/** The path of a conversation (`/segretaria` for the secretary's, D-156), or the root when none is open. */
export function pathFor(conversationId: string | null, secretary = false): string {
  if (conversationId === null) return '/';
  return secretary ? SECRETARY_PATH : `/c/${conversationId}`;
}

/** The tab title: the conversation's title, then the app's name. */
export function documentTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed === undefined || trimmed === '' ? 'Arianna' : `${trimmed} · Arianna`;
}

/** "Novità": the register of the versions, reached from the settings. */
export const CHANGELOG_PATH = '/novita';

export function isChangelogPath(pathname: string): boolean {
  return pathname === CHANGELOG_PATH || pathname === `${CHANGELOG_PATH}/`;
}

/** "Nuovo agente" (D-119, tappa T3): a page of its own under the Agents section of the settings. */
export const NEW_AGENT_PATH = '/impostazioni/agenti/nuovo';

export function isNewAgentPath(pathname: string): boolean {
  return pathname === NEW_AGENT_PATH || pathname === `${NEW_AGENT_PATH}/`;
}

/**
 * The screen of Arianna's browser in a tab of its own (D-264, passo 4):
 * `/browser/<conversationId>`, opened from «Apri in una nuova scheda». The
 * page shows that screen alone, with its own token (one of the 3 screens).
 */
export function browserPathFor(conversationId: string): string {
  return `/browser/${encodeURIComponent(conversationId)}`;
}

/** The conversation of a `/browser/<id>` address, or undefined for any other path. */
export function browserConversationFromPath(pathname: string): string | undefined {
  const id = /^\/browser\/([^/]+)\/?$/.exec(pathname)?.[1];
  return id !== undefined && UUID.test(id) ? id.toLowerCase() : undefined;
}
