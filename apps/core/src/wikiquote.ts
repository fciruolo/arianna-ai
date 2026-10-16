// The real lines of the people of the series from Italian Wikiquote (D-224):
// the core downloads the public page of the series from it.wikiquote.org,
// through the API of MediaWiki (`action=parse`, the wikitext), and takes the
// lines of one character from it, in the words of the Italian dub, with the
// episode. No model: a parser of the markup the pages use. What leaves is the
// name of the page only (for example «Scrubs - Medici ai primi ferri (prima
// stagione)»): GET only, HTTPS only, the host written here, no token, no
// cookie, a fixed user agent that says nothing about the user or the machine,
// no HTTP redirect followed (`redirects=1` lets the wiki itself resolve a
// renamed page on its own server), its own agent (no proxy variable applies).
// The answer is untrusted text anyone can edit: only lines that pass
// `lineText` of series-lines survive, and they reach a model as quotations of
// the character, never as instructions.

import http from 'node:http';
import https from 'node:https';

/** The only site: written in the code, no setting. */
export const WIKIQUOTE_HOST = 'it.wikiquote.org';
/** A page of a season is about 40 KB of wikitext; the JSON around it adds little. */
export const WIKIQUOTE_MAX_BYTES = 1024 * 1024;
/** Between two pages of the same import: Wikiquote answers «too many requests» to a quick burst (seen on 2026-10-16). */
export const WIKIQUOTE_PAUSE_MS = 1500;
/** Fixed: Wikimedia asks for one, and it must not say who the user is. */
const USER_AGENT = 'arianna-series-lines/1.0 (personal assistant; Italian quotes of a TV series for personal use)';

export interface WikiquotePage {
  /** The title of the page, as in its address: all that leaves. */
  title: string;
  /** The season the whole page is about; a page of the whole series has «==Stagione N==» headings instead. */
  season?: number;
}

/**
 * The pages of each series of the personas (D-224), by the `show` of
 * `SERIES_PERSONAS`, verified on 2026-10-16: Scrubs has a page per season (the
 * page of the series only lists them), The Office one page for the whole
 * series, with a few episodes per season.
 */
const SCRUBS = 'Scrubs - Medici ai primi ferri';
const SCRUBS_SEASONS = ['prima', 'seconda', 'terza', 'quarta', 'quinta', 'sesta', 'settima', 'ottava', 'nona'];
export const WIKIQUOTE_PAGES: Readonly<Record<string, readonly WikiquotePage[]>> = {
  Scrubs: SCRUBS_SEASONS.map((ordinal, at) => ({ title: `${SCRUBS} (${ordinal} stagione)`, season: at + 1 })),
  'The Office (US)': [{ title: 'The Office' }],
  // D-237: the page of the whole series, as for The Office; not verified with the network (the wiki resolves a renamed page itself, `redirects=1`).
  'I Simpson': [{ title: 'I Simpson' }],
  // I Griffin (D-238): one page for the whole series, as The Office; title and «==Stagione N==» headings not verified (no network while building).
  'Family Guy': [{ title: 'I Griffin' }],
};

/** The short name of the pages of a series, for the confirmation: «Scrubs - Medici ai primi ferri». */
export function wikiquoteName(show: string): string | undefined {
  if (!Object.hasOwn(WIKIQUOTE_PAGES, show)) return undefined;
  return show === 'Scrubs' ? SCRUBS : WIKIQUOTE_PAGES[show]?.[0]?.title;
}

/** How each character is written before its lines on Wikiquote, by the id of `SERIES_PERSONAS`. */
export const WIKIQUOTE_SPEAKERS: Readonly<Record<string, readonly string[]>> = {
  jd: ['J.D.', 'J.D', 'JD'],
  turk: ['Turk', 'Christopher Turk'],
  elliot: ['Elliot', 'Elliot Reid'],
  carla: ['Carla', 'Carla Espinosa'],
  cox: ['Dott. Cox', 'Dr. Cox', 'Cox', 'Perry Cox', 'Perry'],
  // Seen on the pages of the first season on 2026-10-16: «Dott. Kelso» and «Kelso», «Inserviente», «Ted», «Laverne».
  kelso: ['Dott. Kelso', 'Dr. Kelso', 'Kelso', 'Bob Kelso'],
  janitor: ['Inserviente', 'L’inserviente', "L'inserviente"],
  ted: ['Ted', 'Ted Buckland'],
  laverne: ['Laverne', 'Laverne Roberts'],
  michael: ['Michael Scott', 'Michael'],
  dwight: ['Dwight', 'Dwight Schrute'],
  jim: ['Jim', 'Jim Halpert'],
  pam: ['Pam', 'Pam Beesly', 'Pam Beesley', 'Pam Halpert'],
  // On 2026-10-16 the page had lines of Kevin, Angela and Creed, none yet of Oscar and Andy: their import says so.
  oscar: ['Oscar', 'Oscar Martinez'],
  andy: ['Andy', 'Andy Bernard'],
  kevin: ['Kevin', 'Kevin Malone'],
  angela: ['Angela', 'Angela Martin'],
  creed: ['Creed'],
  // D-237, the names of the Italian dub first (Boe for Moe, «Signor Burns»); not verified on the page.
  marge: ['Marge', 'Marge Simpson'],
  homer: ['Homer', 'Homer Simpson', 'Homer J. Simpson'],
  burns: ['Mr. Burns', 'Signor Burns', 'Montgomery Burns', 'Monty Burns', 'Burns'],
  lisa: ['Lisa', 'Lisa Simpson'],
  smithers: ['Smithers', 'Waylon Smithers'],
  bart: ['Bart', 'Bart Simpson'],
  boe: ['Boe', 'Boe Szyslak', 'Moe', 'Moe Szyslak'],
  // I Griffin (D-238): the names of the Italian dub, not yet seen on the page.
  lois: ['Lois', 'Lois Griffin'],
  peter: ['Peter', 'Peter Griffin'],
  stewie: ['Stewie', 'Stewie Griffin'],
  brian: ['Brian', 'Brian Griffin'],
  meg: ['Meg', 'Meg Griffin'],
  chris: ['Chris', 'Chris Griffin'],
  cleveland: ['Cleveland', 'Cleveland Brown'],
};

export interface WikiquoteLine {
  text: string;
  /** «1x04» when the line sits under a heading of an episode. */
  episode?: string;
}

/** Codes only: a message never carries a response body. */
export class WikiquoteError extends Error {
  override name = 'WikiquoteError';
  readonly code: 'missing' | 'limited' | 'upstream';

  constructor(code: WikiquoteError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** The wikitext of a page by its title. */
export type WikiquoteGet = (title: string, signal?: AbortSignal) => Promise<string>;

const TITLE = /^[\p{L}\p{N} .,'’()\-–:!?&]{1,200}$/u;

export interface WikiquoteClientOptions {
  /** Without an answer for this long the request fails. 20 seconds by default. */
  timeoutMs?: number;
  /** The whole request, body included, ends after this long. 60 seconds by default. */
  deadlineMs?: number;
  /** Plain HTTP and another host: only tests against a local server set them. */
  allowHttp?: boolean;
  host?: string;
}

export function createWikiquoteClient(options: WikiquoteClientOptions = {}): WikiquoteGet {
  const plain = options.allowHttp === true;
  const agent = plain ? new http.Agent({ keepAlive: false }) : new https.Agent({ keepAlive: false });
  const client = plain ? http : https;
  const timeout = options.timeoutMs ?? 20_000;
  const deadline = options.deadlineMs ?? 60_000;
  const host = options.host ?? WIKIQUOTE_HOST;
  return async (title, signal) => {
    if (!TITLE.test(title)) throw new WikiquoteError('upstream', 'invalid title of a page');
    const query = new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext', format: 'json', formatversion: '2', redirects: '1' });
    const url = new URL(`${plain ? 'http' : 'https'}://${host}/w/api.php?${query.toString()}`);
    const late = AbortSignal.timeout(deadline);
    const bounded = signal === undefined ? late : AbortSignal.any([signal, late]);
    const body = await new Promise<Buffer>((resolve, reject) => {
      const request = client.get(url, { agent, headers: { accept: 'application/json', 'user-agent': USER_AGENT }, timeout, signal: bounded }, (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          reject(status === 429 ? new WikiquoteError('limited', 'Wikiquote chiede di rallentare: riprova fra qualche minuto') : new WikiquoteError('upstream', `${WIKIQUOTE_HOST} ha risposto ${String(status)}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > WIKIQUOTE_MAX_BYTES) {
            response.destroy(new WikiquoteError('upstream', 'la pagina di Wikiquote è più grande del previsto'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => {
          reject(error instanceof WikiquoteError ? error : new WikiquoteError('upstream', 'la risposta di Wikiquote si è interrotta'));
        });
        response.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });
      request.on('timeout', () => request.destroy(new WikiquoteError('upstream', 'Wikiquote non risponde')));
      request.on('error', (error) => {
        if (error instanceof WikiquoteError) reject(error);
        else if (late.aborted) reject(new WikiquoteError('upstream', 'Wikiquote non ha risposto in tempo: riprova più tardi'));
        else if (bounded.aborted) reject(new WikiquoteError('upstream', 'scaricamento interrotto'));
        else reject(new WikiquoteError('upstream', 'Wikiquote non si raggiunge: c’è la rete?'));
      });
    });
    return wikitextOf(body.toString('utf8'));
  };
}

/** The wikitext in an answer of `action=parse`; a missing page and anything else are errors. */
export function wikitextOf(answer: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    // The API answers in plain text when it limits («You are making too many requests», seen on 2026-10-16).
    throw /too many requests/i.test(answer.slice(0, 200)) ? new WikiquoteError('limited', 'Wikiquote chiede di rallentare: riprova fra qualche minuto') : new WikiquoteError('upstream', 'la risposta di Wikiquote non si legge');
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { parse?: { wikitext?: unknown }; error?: { code?: unknown } };
  if (record.error?.code === 'missingtitle') throw new WikiquoteError('missing', 'la pagina non c’è su Wikiquote');
  if (record.error?.code === 'ratelimited') throw new WikiquoteError('limited', 'Wikiquote chiede di rallentare: riprova fra qualche minuto');
  const text = record.parse?.wikitext;
  if (typeof text !== 'string') throw new WikiquoteError('upstream', 'la risposta di Wikiquote non si legge');
  return text;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', hellip: '…', laquo: '«', raquo: '»', ndash: '–', mdash: '—' };

/** The words of a piece of wikitext: links to their label, no bold, no italics, no templates, no notes, no tags. */
export function plainOf(wikitext: string): string {
  let text = wikitext
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ' ');
  // Templates, the inner ones first ({{NDR|...}} is a stage direction: not the character's words).
  for (let round = 0; round < 5 && /\{\{[^{}]*\}\}/.test(text); round += 1) text = text.replace(/\{\{[^{}]*\}\}/g, '');
  text = text
    .replace(/\[\[(?:[^\]]*\|)?([^\]|]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#')) {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        // Printable only: no controls (C0, DEL, C1) and no lone surrogates.
        return (code > 31 && code < 127) || (code > 159 && code < 0xd800) || (code > 0xdfff && code < 0x110000) ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** The words of a long line cut at the end of a sentence within `max` characters; undefined when the first sentence is already longer. */
export function cutAtSentence(text: string, max: number): string | undefined {
  if (Array.from(text).length <= max) return text;
  let kept = '';
  for (const sentence of text.split(/(?<=[.!?…])\s+/u)) {
    const next = kept === '' ? sentence : `${kept} ${sentence}`;
    if (Array.from(next).length > max) break;
    kept = next;
  }
  return kept === '' ? undefined : kept;
}

const SAID_AT_END = /^(.*)\(\s*'''([^']+?)'''\s*\)\s*$/s;
const TURN = /^\s*'''([^']+?)'''\s*:\s*(.*)$/s;

/**
 * The lines of a character in the wikitext of a page: a quote ends with the
 * speaker in brackets («… ('''J.D.''')»), a dialogue is a list of turns
 * («'''J.D.''': …<br />'''Turk''': …»), each turn a line of its speaker. The
 * episode comes from the last heading «Episodio N, …» and the season from
 * the page or the last «Stagione N»; other sections of level 2 (Note, Altri
 * progetti, Citazioni su …) are not lines of the series. Raw text: the caller
 * passes each through `lineText`.
 */
export function parseWikiquote(wikitext: string, speakers: readonly string[], page: Pick<WikiquotePage, 'season'> = {}): WikiquoteLine[] {
  const names = new Set(speakers.map((name) => name.trim().toLowerCase()));
  const isSpeaker = (name: string): boolean => names.has(plainOf(name).toLowerCase());
  let season = page.season;
  // A page of a season holds its episodes from the top; a page of the whole series only under «Stagione N».
  let inSeries = page.season !== undefined;
  let episode: string | undefined;
  const found: WikiquoteLine[] = [];
  const push = (raw: string): void => {
    const text = plainOf(raw).replace(/^[-–—:\s]+/, '');
    if (text === '') return;
    found.push({ text, ...(episode === undefined ? {} : { episode }) });
  };
  for (const line of wikitext.split('\n')) {
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 0;
      const title = plainOf(heading[2] ?? '');
      const seasonOf = /^Stagione\s+(\d+)/i.exec(title);
      const episodeOf = /^Episodio\s+(\d+)/i.exec(title);
      if (level === 2) {
        inSeries = seasonOf !== null;
        if (seasonOf !== null) season = Number(seasonOf[1]);
        episode = undefined;
      } else if (episodeOf !== null) {
        const number = String(Number(episodeOf[1])).padStart(2, '0');
        episode = season === undefined ? `ep. ${number}` : `${String(season)}x${number}`;
      } else {
        episode = undefined;
      }
      continue;
    }
    // A quote is an item of the first level only; «**» and «:» are notes or continuations.
    if (!inSeries || !/^\*[^*:#]/.test(line)) continue;
    // Notes and templates out first ({{NDR|…}} the stage directions, {{Cfr}} after the speaker): the speaker is then at the end.
    let item = line.slice(1).replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
    for (let round = 0; round < 5 && /\{\{[^{}]*\}\}/.test(item); round += 1) item = item.replace(/\{\{[^{}]*\}\}/g, '');
    item = item.trim();
    if (TURN.test(item)) {
      for (const turn of item.split(/<br\s*\/?>/i)) {
        const said = TURN.exec(turn);
        if (said !== null && isSpeaker(said[1] ?? '')) push(said[2] ?? '');
      }
      continue;
    }
    const said = SAID_AT_END.exec(item);
    if (said !== null && isSpeaker(said[2] ?? '')) push(said[1] ?? '');
  }
  return found;
}
