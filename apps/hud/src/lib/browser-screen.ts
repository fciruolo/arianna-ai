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

/** The id of the Private chat the browser of a work conversation passed to (D-281), from the status of the core; null when none. */
export function parseMovedTo(value: unknown): string | null {
  const body = (typeof value === 'object' && value !== null ? value : {}) as { movedTo?: unknown };
  return typeof body.movedTo === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.movedTo) ? body.movedTo : null;
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

/**
 * «Prendi il controllo» (D-264, passo 5): who drives the browser, as the core
 * says it for this screen (`you`) or another one (`other`); `user` when the
 * core was asked without a screen (the bar above the composer).
 */
export type ControlState = 'agent' | 'you' | 'other' | 'user';

/** A main page refused while the user drove: its number, never its address. */
export interface BlockedNavigation {
  seq: number;
  outcome: 'blocked' | 'refused' | 'form' | 'limit';
  site?: string;
}

/** The fixed warning above the screen while the user drives. */
export const CONTROL_WARNING = 'Non scrivere dati personali: la pagina è pubblica e il sito li riceve.';
/** The fixed warning while the user drives after an access (D-276): the pages are no longer public. */
export function accessWarning(site: string): string {
  return `Sei dentro ${site} con il tuo accesso: quello che scrivi va solo a ${site}, mai ad altri siti, e Arianna non lo legge.`;
}
export const CONTROL_PASSED = 'Il controllo è passato a un altro schermo.';
/** How often a live screen asks the core who drives and what was refused. */
export const CONTROL_POLL_MS = 2_500;

/** What the chat says of a navigation the core refused while the user drove (choice of the user, 2026-10-21). */
export function blockedText(blocked: Pick<BlockedNavigation, 'outcome'>, access?: string | null): string {
  // After an access (D-276) only the site of the access opens.
  if (access !== undefined && access !== null && (blocked.outcome === 'blocked' || blocked.outcome === 'form')) return `Dopo l’accesso il browser apre e invia solo verso ${access}: chiudi il browser per andare altrove.`;
  switch (blocked.outcome) {
    case 'form':
      return 'Modulo non inviato: da questo browser un modulo parte solo verso il sito della pagina, mentre guidi tu.';
    case 'blocked':
      // D-286: a page the user clicks opens on any site; what stops it is the gateway.
      return 'Pagina non aperta: il gateway l’ha fermata (un dato privato, una chiave o un dato salvato nell’indirizzo, oppure la conversazione ha letto dati Privati).';
    case 'limit':
      return 'Pagina non aperta: il browser ha raggiunto il limite di pagine o di dati di questo lavoro.';
    case 'refused':
      return 'Pagina non aperta: l’indirizzo non è raggiungibile da questo browser.';
  }
}

const OUTCOMES: readonly BlockedNavigation['outcome'][] = ['blocked', 'refused', 'form', 'limit'];

/**
 * The line under the screen once the user signed in (D-276). `chat`: the
 * screen of the Private chat the browser passed to (D-281), where Arianna
 * reads the pages with the local model.
 */
export function accessText(site: string, chat = false): string {
  const who = chat
    ? `Arianna le legge solo in questa chat Privata, col modello locale, e prima di inviare dati a ${site} ti chiede «Invia / No»`
    : 'Arianna non le legge in questa conversazione: restituito il browser, passa a una nuova chat Privata';
  return `Accesso fatto su ${site}: le sue pagine sono Private. ${who}; i cookie restano solo per ${site}, nella memoria del core, e spariscono con il browser. Da ora immagini e script di altri siti non si caricano: la pagina può sembrare rotta.`;
}

/**
 * «Nuova chat Privata» (D-281): the line the core writes in the work
 * conversation when the browser passes to the Private chat of an access
 * (the same bytes as HANDOFF_LINE of apps/core/src/browser/handoff.ts).
 */
export const HANDOFF_LINE =
  'Hai fatto l’accesso a un sito: il browser è passato a una nuova chat Privata, dove lavora solo il modello locale. Qui Arianna non usa più quel browser.';

/** How far the line of a hand over may come after the birth of its chat (the core writes it right after). */
const HANDOFF_SKEW_MS = 60_000;

/**
 * The Private chat a line of a hand over points to: the newest chat of the
 * access born from this conversation before the line (or within a minute
 * after it, for clocks); undefined for any other message.
 */
export function browserChatOf(chats: readonly { id: string; createdAt: string }[] | undefined, message: { role: string; body: string; ts: string }): string | undefined {
  if (message.role !== 'system' || message.body !== HANDOFF_LINE || chats === undefined) return undefined;
  const at = Date.parse(message.ts);
  let found: string | undefined;
  for (const chat of chats) {
    const born = Date.parse(chat.createdAt);
    if (Number.isNaN(at) || Number.isNaN(born) || born <= at + HANDOFF_SKEW_MS) found = chat.id;
  }
  return found;
}

/** The second line of the warning while the user drives: what a form does (D-276); only when the page shows a login form (D-287). */
export const FORM_NOTE = 'Unica eccezione, l’accesso: utente e password scrivili solo nel modulo d’accesso del sito che conosci. Partono solo verso quel sito; Arianna non li vede né li salva.';

/** The status of the core as the chat reads it: anything unexpected is dropped. */
export function parseControl(value: unknown): { control: ControlState | null; blocked: BlockedNavigation | null; access: string | null; chat: boolean; login: boolean } {
  const body = (typeof value === 'object' && value !== null ? value : {}) as { control?: unknown; blocked?: unknown; access?: unknown; chat?: unknown; login?: unknown };
  const control = body.control === 'agent' || body.control === 'you' || body.control === 'other' || body.control === 'user' ? body.control : null;
  const raw = (typeof body.blocked === 'object' && body.blocked !== null ? body.blocked : null) as { seq?: unknown; outcome?: unknown; site?: unknown } | null;
  const outcome = OUTCOMES.find((item) => item === raw?.outcome);
  let blocked: BlockedNavigation | null = null;
  if (raw !== null && typeof raw.seq === 'number' && outcome !== undefined) {
    blocked = typeof raw.site === 'string' && raw.site !== '' ? { seq: raw.seq, outcome, site: raw.site } : { seq: raw.seq, outcome };
  }
  const access = typeof body.access === 'string' && body.access !== '' && body.access.length <= 253 ? body.access : null;
  // A login form on the page the user drives (D-287): only for the screen that drives.
  return { control, blocked, access, chat: body.chat === true, login: control === 'you' && body.login === true };
}

/**
 * Where Esc goes while the user drives the browser (D-287): to the page, as
 * a key of the screen, never to the panel around it (whose Esc would close
 * the screen and give the browser back). `screen`: the screen of the browser
 * holds the keyboard (noVNC sends Esc itself); `free`: nothing else of the
 * chat holds it (the page, or a button of the screen's own bar). A field
 * keeps its Esc, a dialog of the chat too, and a word being composed (IME)
 * is not a key.
 */
export function escapeTarget(event: { key: string; isComposing?: boolean }, state: { driving: boolean; screen: boolean; free: boolean; field: boolean }): 'page' | 'screen' | 'chat' {
  if (event.key !== 'Escape' || event.isComposing === true || !state.driving || state.field) return 'chat';
  if (state.screen) return 'screen';
  return state.free ? 'page' : 'chat';
}

// The bar above the screen (D-286): ← Indietro, → Avanti, ↻ Ricarica and the address of the page.
// Chromium runs as a kiosk, without a bar of its own: these commands go through the core, as the user's.

export type BarCommand = 'back' | 'forward' | 'reload' | 'open';

/** What the bar says of a command the core did not carry out, in Italian; undefined when it went. */
export function commandText(reason: string): string {
  switch (reason) {
    case 'agent-busy':
      return 'Arianna sta usando il browser: riprova fra un attimo.';
    case 'no-page':
      return 'Non c’è una pagina da quella parte.';
    case 'navigation-blocked':
      return 'Pagina non aperta: il gateway l’ha fermata.';
    case 'navigation-failed':
      return 'La pagina non si è aperta: controlla l’indirizzo.';
    case 'not-open':
      return 'Il browser non è aperto.';
    default:
      return 'Il comando non è riuscito.';
  }
}

/**
 * The address written in the field, as the core takes it: with a scheme, or
 * https in front of something that looks like a host. Undefined for what is
 * not an address (the field does not search).
 */
export function barAddress(text: string): string | undefined {
  const value = text.trim();
  if (value === '' || /\s/.test(value)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.')) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
