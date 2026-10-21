import { taskIds, type ChatState } from './chat-state.ts';
import type { Activity, SavedActivity } from './types.ts';

/**
 * The live screen of Arianna's browser (D-264, passo 4): view only, in the
 * "Browser" tab of the Computer panel. Pure logic of the chat, tested without
 * a browser; the component is BrowserScreen.vue.
 *
 * The core gives a token for the conversation that holds the browser
 * (POST /api/browser/screen), and the screen is an RFB stream over
 * /api/browser/screen?t=<token>, through the core only.
 */

/** What the screen shows. */
export type ScreenState =
  /** Asking the token or opening the stream. */
  | 'connecting'
  /** The stream is open: the page as Arianna sees it. */
  | 'live'
  /** No browser for this conversation (the core refused the token). */
  | 'closed'
  /** The stream was live and closed: the browser closed or the connection broke (noVNC does not give the close code). */
  | 'ended'
  /** Three screens are already open on this browser. */
  | 'too-many'
  /** A Private or incognito conversation: never a screen. */
  | 'refused'
  /** Anything else: the core answered with an error, or the network failed. */
  | 'error';

export const SCREEN_TEXT: Record<ScreenState, string> = {
  connecting: 'In collegamento',
  live: 'In diretta',
  closed: 'Browser chiuso',
  ended: 'Schermo chiuso',
  'too-many': 'Troppi schermi aperti',
  refused: 'Non disponibile qui',
  error: 'Non collegato',
};

/** A longer line under the state, when there is something to explain. */
export const SCREEN_HINT: Partial<Record<ScreenState, string>> = {
  closed: 'Arianna non ha un browser aperto in questa conversazione. Quando lo apre, premi «Riprova».',
  ended: 'Lo schermo si è chiuso: il browser è stato chiuso o il collegamento si è interrotto. Premi «Riprova».',
  'too-many': 'Lo stesso browser si guarda al più da 3 schermi insieme: chiudine uno, poi premi «Riprova».',
  refused: 'Lo schermo non si apre nelle conversazioni Private né in incognito.',
  error: 'Lo schermo non si è collegato. Riprova fra poco.',
};

/** Whether the user can ask again: not while connecting or live, never for a Private conversation. */
export function canRetry(state: ScreenState): boolean {
  return state === 'closed' || state === 'ended' || state === 'too-many' || state === 'error';
}

/** The state for a refused POST /api/browser/screen: its HTTP status and the `error` of its body. */
export function screenRefusal(status: number, error: string | undefined): ScreenState {
  if (error === 'too-many-screens') return 'too-many';
  if (status === 409) return 'closed';
  if (status === 403) return 'refused';
  return 'error';
}

/** The address of the stream: same host as the page, like /api/ws (the Vite proxy forwards /api with its WebSocket). */
export function screenUrl(location: { protocol: string; host: string }, token: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/browser/screen?t=${encodeURIComponent(token)}`;
}

/**
 * A line of Arianna's browser that shows the «Guarda» button: its detail is
 * `browser · …` (D-268) and it is not a failure. A failure (`error`, `stop`)
 * has the same prefix but no page to look at.
 */
export function isBrowserLine(line: Pick<Activity | SavedActivity, 'kind' | 'detail'>): boolean {
  return line.detail.startsWith('browser · ') && line.kind !== 'error' && line.kind !== 'stop';
}

/** The site of a browser line, `browser · <verb> · <site>`; none for `browser · chiude` or `browser · scrive 12 caratteri`. */
export function browserSite(line: Pick<Activity | SavedActivity, 'kind' | 'detail'>): string | undefined {
  if (!isBrowserLine(line)) return undefined;
  const parts = line.detail.split(' · ');
  if (parts.length < 3) return undefined;
  const site = parts.slice(2).join(' · ').trim();
  return site === '' ? undefined : site;
}

/** The site of the newest browser line in the live activity of the conversation; none when no line names one. */
export function latestBrowserSite(chat: ChatState): string | undefined {
  const ids = taskIds(chat);
  for (const id of Object.keys(chat.activity)) if (!ids.includes(id)) ids.push(id);
  let found: string | undefined;
  for (const id of ids) {
    for (const line of chat.activity[id] ?? []) {
      const site = browserSite(line);
      if (site !== undefined) found = site;
    }
  }
  return found;
}

/** How often the bar «Browser aperto» asks the core again while it shows (and the page of its own, for the site). */
export const BROWSER_POLL_MS = 30_000;

/**
 * What the bar «Browser aperto» above the composer follows in the chat: a
 * key that changes with every new browser line or message (then it asks the
 * core again), and whether the newest browser line closed the browser
 * (`browser · chiude`: the bar goes at once).
 */
export function browserSignal(chat: ChatState): { key: string; closed: boolean } {
  const ids = taskIds(chat);
  for (const id of Object.keys(chat.activity)) if (!ids.includes(id)) ids.push(id);
  let count = 0;
  let last: string | undefined;
  for (const id of ids) {
    for (const line of chat.activity[id] ?? []) {
      if (!isBrowserLine(line)) continue;
      count += 1;
      last = line.detail;
    }
  }
  return { key: `${chat.conversationId}:${String(count)}:${String(chat.messages.length)}`, closed: last === 'browser · chiude' };
}
