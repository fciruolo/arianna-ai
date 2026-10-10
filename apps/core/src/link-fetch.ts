import { lookup as dnsLookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * Downloading the content of a link saved in kb/inbox (D-154), so that the
 * local model can summarize it. Only the core calls this, only for the `url`
 * of a note written by the capture code (never an address written by a
 * model), and only after the user chose it: the site is in `[capture]
 * fetch_sites`, or the user pressed "Scarica e riassumi".
 *
 * What leaves is the request for that address, to its own site (for a post
 * of X, to publish.twitter.com, the official oEmbed of X): no cookie, no
 * credentials, an honest User-Agent. Never towards this machine or the local
 * network: every address a name resolves to is checked before connecting,
 * at the moment of connecting (the check is the `lookup` of the socket, so a
 * name cannot answer differently between the check and the connection), and
 * again at every redirect. What comes back is untrusted data: plain text
 * extracted here without any library, cut to a size, and given to the model
 * as content to summarize, never as instructions.
 */

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
/** Characters of extracted text kept at most. */
export const MAX_TEXT = 20_000;
const MAX_META = 300;

const ACCEPTED_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'] as const;

/** Why a link was not downloaded: a closed list, safe for an event or a header. */
export const FETCH_FAILURES = [
  'invalid-url',
  'private-address',
  'dns',
  'timeout',
  'http-error',
  'too-many-redirects',
  'unsupported-type',
  'too-large',
  'empty',
  'bad-response',
  'network',
  'blocked',
  'interrupted',
  'other-site',
] as const;
export type FetchFailure = (typeof FETCH_FAILURES)[number];

export function isFetchFailure(value: unknown): value is FetchFailure {
  return FETCH_FAILURES.some((failure) => failure === value);
}

/** The reasons in Italian, as the note says them. */
export const FETCH_FAILURE_TEXT: Record<FetchFailure, string> = {
  'invalid-url': 'l’indirizzo non è un link http o https scaricabile',
  'private-address': 'l’indirizzo porta a questa macchina o alla rete locale',
  dns: 'il nome del sito non si risolve',
  timeout: 'il sito non ha risposto in tempo',
  'http-error': 'il sito ha risposto con un errore',
  'too-many-redirects': 'troppi rimandi verso altri indirizzi',
  'unsupported-type': 'il tipo di contenuto non è supportato (per ora solo pagine e testo)',
  'too-large': 'il contenuto è troppo grande',
  empty: 'la pagina non ha testo leggibile',
  'bad-response': 'la risposta del sito non è leggibile',
  network: 'errore di rete',
  blocked: 'il gateway ha fermato l’indirizzo',
  interrupted: 'scaricamento interrotto',
  'other-site': 'il link rimanda a un sito che non è nell’elenco',
};

export interface FetchedLink {
  /** The address the content came from, after the redirects (for X, the post without tracking parameters). */
  url: string;
  /** Host of the link without `www.`. */
  site: string;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  published?: string;
  text: string;
  /** The page was larger than the limit, or its text longer than MAX_TEXT. */
  truncated: boolean;
}

export type FetchResult = { ok: true; link: FetchedLink } | { ok: false; reason: FetchFailure };

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Default: the system resolver (dns.lookup, every address). */
  resolve?: Resolver;
  /**
   * Tests only: these exact addresses count as public and any port is
   * allowed, for a fake server on this machine reached through a fake
   * resolver. Every other private address stays refused. Never set by the core.
   */
  unsafeTestAddresses?: readonly string[];
  /** Tests only: where the oEmbed of X is asked. Default https://publish.twitter.com/oembed. */
  xOembedEndpoint?: string;
  userAgent?: string;
  /**
   * The gateway (D-154): asked for every address before it is requested, the
   * first one, each redirect and the oEmbed of X. It answers with the exact
   * address it allowed, or undefined: anything else is not requested.
   */
  authorize: (address: string) => Promise<string | undefined>;
  /** Whether a redirect may lead to this host (D-154: a link downloaded by itself stays on the sites of the list). Default: any public one. */
  allowRedirect?: (host: string) => boolean;
}

let version: string | undefined;
function ariannaVersion(): string {
  if (version !== undefined) return version;
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    version = typeof parsed.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(parsed.version) ? parsed.version : '0';
  } catch {
    version = '0';
  }
  return version;
}

export function userAgent(): string {
  return `Arianna/${ariannaVersion()} (+link preview)`;
}

class FetchError extends Error {
  readonly reason: FetchFailure;
  constructor(reason: FetchFailure) {
    super(reason);
    this.reason = reason;
  }
}

// --- Addresses -------------------------------------------------------------

// Two lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const PRIVATE = new BlockList();
const PRIVATE6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // IPv4-compatible (::a.b.c.d, :: and ::1 among them), IPv4-mapped and IPv4-translated: never, whatever IPv4 they carry.
  ['::', 96],
  ['::ffff:0:0', 96],
  ['::ffff:0:0:0', 96],
  // NAT64, 6to4 and Teredo may lead to any IPv4, private ones included.
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['2001::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
] as const) {
  PRIVATE6.addSubnet(net, prefix, 'ipv6');
}

/** IPv4 inside IPv6 (::ffff:a.b.c.d, ::a.b.c.d): the IPv4 address it carries. */
function embeddedIpv4(address: string): string | undefined {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
  }
  return undefined;
}

/** Loopback, private, link-local, unique-local, multicast, reserved or documentation: never fetched. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 4) return PRIVATE.check(bare, 'ipv4');
  // An IPv4 written inside IPv6 is never fetched, public or not: DNS gives IPv4 as IPv4.
  if (embeddedIpv4(bare) !== undefined) return true;
  return PRIVATE6.check(bare, 'ipv6');
}

/** Names that are this machine or the local network by themselves. */
export function isPrivateName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === '' || !name.includes('.')) return true;
  return name === 'localhost' || /\.(localhost|local|internal|lan|home|arpa|test|invalid|example)$/.test(name);
}

/**
 * The address checked before any request: http(s) only, no credentials, no
 * port other than the default one, no private name nor literal address.
 */
export function checkFetchUrl(value: string, options: Pick<FetchOptions, 'unsafeTestAddresses'> = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FetchError('invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('invalid-url');
  if (url.username !== '' || url.password !== '') throw new FetchError('invalid-url');
  const testing = options.unsafeTestAddresses !== undefined;
  if (url.port !== '' && !testing) throw new FetchError('invalid-url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host) && options.unsafeTestAddresses?.includes(host) !== true) throw new FetchError('private-address');
  } else if (isPrivateName(host)) {
    throw new FetchError('private-address');
  }
  return url;
}

const systemResolve: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/** The `lookup` of the socket: resolves, refuses the whole name if any address is private, connects to the checked one. */
function checkedLookup(resolve: Resolver, allowed: readonly string[]) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback): void => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) throw new FetchError('dns');
        if (addresses.some((entry) => isPrivateAddress(entry.address) && !allowed.includes(entry.address))) throw new FetchError('private-address');
        const all = typeof options === 'object' && options.all === true;
        const first = addresses[0];
        if (all) callback(null, addresses);
        else if (first !== undefined) callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        const wrapped = (error instanceof FetchError ? error : new FetchError('dns')) as FetchError & NodeJS.ErrnoException;
        callback(wrapped, '', 0);
      });
  };
}

// --- One request ------------------------------------------------------------

interface Response {
  status: number;
  location?: string;
  type: string;
  charset?: string;
  body: Buffer;
  truncated: boolean;
}

function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  if (encoding === '' || encoding === 'identity') return response;
  throw new FetchError('bad-response');
}

function requestOnce(url: URL, options: Required<Pick<FetchOptions, 'maxBytes'>> & FetchOptions, signal: AbortSignal, accept: string): Promise<Response> {
  return new Promise<Response>((resolvePromise, reject) => {
    const requestOptions: RequestOptions = {
      method: 'GET',
      headers: {
        'user-agent': options.userAgent ?? userAgent(),
        accept,
        'accept-language': 'it,en;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
      },
      agent: false,
      lookup: checkedLookup(options.resolve ?? systemResolve, options.unsafeTestAddresses ?? []) as unknown as RequestOptions['lookup'],
      signal,
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (error instanceof FetchError) reject(error);
      else if (signal.aborted) reject(new FetchError('timeout'));
      else reject(new FetchError('network'));
    };
    const req = send(url, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === 'string' ? response.headers.location : undefined;
      const [type = '', ...params] = (response.headers['content-type'] ?? '').split(';').map((part) => part.trim());
      const charset = params.map((param) => /^charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})"?$/i.exec(param)?.[1]).find((value) => value !== undefined);
      if (status < 200 || status >= 300) {
        response.resume();
        settled = true;
        resolvePromise({ status, ...(location === undefined ? {} : { location }), type: type.toLowerCase(), body: Buffer.alloc(0), truncated: false });
        return;
      }
      const declared = Number(response.headers['content-length']);
      // Larger than allowed and not a page: stop before reading. A page is read up to the limit and cut.
      if (Number.isFinite(declared) && declared > options.maxBytes && !type.toLowerCase().startsWith('text/')) {
        response.destroy();
        fail(new FetchError('too-large'));
        return;
      }
      if (!ACCEPTED_TYPES.some((accepted) => accepted === type.toLowerCase())) {
        response.destroy();
        fail(new FetchError('unsupported-type'));
        return;
      }
      let stream: Readable;
      try {
        stream = decoded(response);
      } catch (error) {
        response.destroy();
        fail(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolvePromise({ status, type: type.toLowerCase(), ...(charset === undefined ? {} : { charset }), body: Buffer.concat(chunks), truncated });
      };
      stream.on('data', (chunk: Buffer) => {
        if (settled || truncated) return;
        const room = options.maxBytes - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          truncated = true;
          finish();
          // Both: a compressed body stops being inflated too.
          stream.destroy();
          response.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', finish);
      stream.on('error', fail);
      response.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

function decodeBody(body: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** GET with the redirects followed by hand, each checked as the first address. */
async function get(start: URL, options: FetchOptions, signal: AbortSignal, accept: string): Promise<{ url: URL; response: Response }> {
  const settings = { ...options, maxBytes: options.maxBytes ?? FETCH_MAX_BYTES };
  let url = start;
  for (let hop = 0; ; hop += 1) {
    // Every address passes the gateway, and only the address it allowed is requested.
    // A gateway that cannot decide (its log not writable) is a refusal, never a network error.
    let allowed: string | undefined;
    try {
      allowed = await options.authorize(url.href);
    } catch {
      throw new FetchError('blocked');
    }
    if (allowed !== url.href) throw new FetchError('blocked');
    const response = await requestOnce(new URL(allowed), settings, signal, accept);
    if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
      if (hop >= MAX_REDIRECTS) throw new FetchError('too-many-redirects');
      let next: URL;
      try {
        next = new URL(response.location, url);
      } catch {
        throw new FetchError('invalid-url');
      }
      // Never from https down to http, and checked as the first address.
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new FetchError('invalid-url');
      url = checkFetchUrl(next.href, options);
      if (options.allowRedirect !== undefined && !options.allowRedirect(url.hostname.toLowerCase())) throw new FetchError('other-site');
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new FetchError('http-error');
    return { url, response };
  }
}

// --- Text out of HTML --------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®',
  trade: '™', euro: '€', deg: '°', times: '×', agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é', igrave: 'ì', iacute: 'í',
  ograve: 'ò', oacute: 'ó', ugrave: 'ù', uacute: 'ú', Agrave: 'À', Egrave: 'È', Eacute: 'É', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  ccedil: 'ç', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED[entity] ?? match;
  });
}

/** Control and format characters out, spaces folded: a value fit for one line. */
export function oneLine(text: string, max = MAX_META): string {
  const clean = decodeEntities(text)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Attributes of one tag, read with indexOf and loops only: no regular expression runs on what the page sends. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  const length = tag.length;
  const space = (char: string | undefined): boolean => char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
  let at = 1;
  // Past the name of the tag.
  while (at < length && !space(tag[at]) && tag[at] !== '>' && tag[at] !== '/') at += 1;
  while (at < length) {
    while (at < length && (space(tag[at]) || tag[at] === '/')) at += 1;
    if (at >= length || tag[at] === '>') break;
    const nameStart = at;
    while (at < length && !space(tag[at]) && tag[at] !== '=' && tag[at] !== '>' && tag[at] !== '/') at += 1;
    const name = tag.slice(nameStart, at).toLowerCase();
    while (at < length && space(tag[at])) at += 1;
    if (tag[at] !== '=') {
      if (at === nameStart) at += 1;
      continue;
    }
    at += 1;
    while (at < length && space(tag[at])) at += 1;
    const quote = tag[at];
    let value: string;
    if (quote === '"' || quote === "'") {
      const close = tag.indexOf(quote, at + 1);
      const stop = close < 0 ? length : close;
      value = tag.slice(at + 1, stop);
      at = stop + 1;
    } else {
      const valueStart = at;
      while (at < length && !space(tag[at]) && tag[at] !== '>') at += 1;
      value = tag.slice(valueStart, at);
    }
    if (name !== '' && !found.has(name)) found.set(name, value);
  }
  return found;
}

/** Elements whose content is never text of the page. */
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'object', 'canvas', 'button', 'select', 'head']);
/** Elements whose content is raw text up to their own closing tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'iframe']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'tr', 'table', 'blockquote', 'pre', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'hr', 'br']);
const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
/** The part of a tag kept for its attributes (only meta tags are read). */
const MAX_TAG_READ = 4_000;

export type HtmlToken = { kind: 'text'; text: string } | { kind: 'open'; name: string; raw: string; selfClosing: boolean } | { kind: 'close'; name: string };

const TAG_NAME = /<(\/?)([A-Za-z][A-Za-z0-9-]{0,40})/y;

/**
 * The tokens of a page in one pass, linear in its length: every search moves
 * forward with indexOf, and a tag, a comment or a raw text element left open
 * ends the page. A `<` that starts no tag is text.
 */
export function tokenize(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const length = html.length;
  let at = 0;
  let text = 0;
  const flush = (until: number): void => {
    if (until > text) tokens.push({ kind: 'text', text: html.slice(text, until) });
  };
  while (at < length) {
    const lt = html.indexOf('<', at);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      flush(lt);
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return tokens;
      at = text = end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      flush(lt);
      const end = html.indexOf('>', lt + 2);
      if (end < 0) return tokens;
      at = text = end + 1;
      continue;
    }
    TAG_NAME.lastIndex = lt;
    const match = TAG_NAME.exec(html);
    if (match === null) {
      at = lt + 1;
      continue;
    }
    const end = html.indexOf('>', lt + match[0].length);
    flush(lt);
    if (end < 0) return tokens;
    const name = (match[2] ?? '').toLowerCase();
    at = text = end + 1;
    if (match[1] === '/') {
      tokens.push({ kind: 'close', name });
      continue;
    }
    const selfClosing = html[end - 1] === '/' || VOID.has(name);
    tokens.push({ kind: 'open', name, raw: html.slice(lt, Math.min(end + 1, lt + MAX_TAG_READ)), selfClosing });
    if (RAW_TEXT.has(name) && !selfClosing) {
      // Up to its own closing tag, whatever is inside; left open to the end of the page: nothing more.
      const closer = new RegExp(`</${name}[\\s/>]`, 'gi');
      closer.lastIndex = at;
      const found = closer.exec(html);
      const keep = name === 'title' || name === 'textarea';
      if (found === null) {
        if (keep) tokens.push({ kind: 'text', text: html.slice(at) });
        return tokens;
      }
      if (keep) tokens.push({ kind: 'text', text: html.slice(at, found.index) });
      tokens.push({ kind: 'close', name });
      const close = html.indexOf('>', found.index);
      if (close < 0) return tokens;
      at = text = close + 1;
    }
  }
  flush(length);
  return tokens;
}

function cleanText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => (char === '\n' || char === '\t' ? char : ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(\n|- \n)+/, '')
    .trim();
}

/** Plain text out of tokens: blocks become lines, tags go, entities are decoded, spaces folded. */
function tokensToText(tokens: readonly HtmlToken[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') parts.push(token.text);
    else if (token.name === 'li' && token.kind === 'open') parts.push('\n- ');
    else if (BLOCKS.has(token.name) || token.name === 'li') parts.push('\n');
    else parts.push(' ');
  }
  return cleanText(decodeEntities(parts.join('')));
}

/** HTML to plain text, in one linear pass. */
export function htmlToText(html: string): string {
  return tokensToText(tokenize(html));
}

function cut(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT ? { text: `${text.slice(0, MAX_TEXT)} […]`, truncated: true } : { text, truncated: false };
}

export interface PageParts {
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  published?: string;
  text: string;
  truncated: boolean;
}

type Region = 'article' | 'main' | 'body';
const REGIONS: readonly Region[] = ['article', 'main', 'body'];

/** Title, meta data and readable text of a page, without any library and in linear time. */
export function extractPage(html: string): PageParts {
  const meta = new Map<string, string>();
  let titleText: string | undefined;
  // The text inside the first article, the first main and the body, without the dropped elements.
  const regions: Record<Region | 'all', HtmlToken[]> = { article: [], main: [], body: [], all: [] };
  const depth: Record<Region, number> = { article: 0, main: 0, body: 0 };
  const done: Record<Region, boolean> = { article: false, main: false, body: false };
  let dropped = 0;
  let inTitle = false;
  for (const token of tokenize(html)) {
    if (token.kind === 'open' && token.name === 'meta') {
      const attrs = attributes(token.raw);
      const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop'))?.toLowerCase();
      const content = attrs.get('content');
      if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content);
      continue;
    }
    if (token.kind !== 'text' && token.name === 'title') {
      inTitle = token.kind === 'open';
      continue;
    }
    if (inTitle) {
      if (token.kind === 'text' && titleText === undefined) titleText = token.text;
      continue;
    }
    if (token.kind !== 'text' && DROPPED.has(token.name)) {
      if (token.kind === 'open' && !token.selfClosing) dropped += 1;
      else if (token.kind === 'close') dropped = Math.max(0, dropped - 1);
      continue;
    }
    if (token.kind !== 'text') {
      const region = REGIONS.find((name) => name === token.name);
      if (region !== undefined) {
        if (token.kind === 'open' && !done[region]) depth[region] += 1;
        else if (token.kind === 'close' && depth[region] > 0) {
          depth[region] -= 1;
          if (depth[region] === 0) done[region] = true;
        }
      }
    }
    if (dropped > 0) continue;
    regions.all.push(token);
    for (const region of REGIONS) if (depth[region] > 0) regions[region].push(token);
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value !== undefined) {
        const clean = oneLine(value);
        if (clean !== '') return clean;
      }
    }
    return undefined;
  };
  const title = pick('og:title', 'twitter:title') ?? (titleText === undefined ? undefined : oneLine(titleText) || undefined);
  const chosen = [regions.article, regions.main, regions.body].map(tokensToText).find((text) => text !== '') ?? tokensToText(regions.all);
  const { text, truncated } = cut(chosen);
  const parts: PageParts = { text, truncated };
  const description = pick('og:description', 'description', 'twitter:description');
  const siteName = pick('og:site_name', 'application-name');
  const author = pick('author', 'article:author', 'twitter:creator');
  const published = pick('article:published_time', 'datepublished', 'date', 'pubdate');
  if (title !== undefined) parts.title = title;
  if (description !== undefined) parts.description = description;
  if (siteName !== undefined) parts.siteName = siteName;
  if (author !== undefined) parts.author = author;
  if (published !== undefined) parts.published = published;
  return parts;
}

// --- Posts of X ----------------------------------------------------------------

const X_HOSTS = ['x.com', 'twitter.com'];

/** A post of X or Twitter: `https://x.com/<user>/status/<id>` without tracking parameters; undefined for anything else. */
export function xPostUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
  if (!X_HOSTS.includes(host)) return undefined;
  const match = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/.*)?$/.exec(url.pathname) ?? /^\/i\/web\/status\/(\d{1,25})\/?$/.exec(url.pathname);
  if (match === null) return undefined;
  return match.length === 3 ? `https://x.com/${match[1] ?? ''}/status/${match[2] ?? ''}` : `https://x.com/i/web/status/${match[1] ?? ''}`;
}

export const X_OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';

export function xOembedUrl(post: string, endpoint = X_OEMBED_ENDPOINT): string {
  return `${endpoint}?url=${encodeURIComponent(post)}&omit_script=true&dnt=true`;
}

/** Author, text and date of a post from the answer of oEmbed: the text is in the `<p>` of the blockquote. */
export function readXOembed(json: unknown, post: string): FetchedLink | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const { html, author_name: authorName, author_url: authorUrl } = json as Record<string, unknown>;
  if (typeof html !== 'string') return undefined;
  const tokens = tokenize(html);
  // The text of the post: the first <p>; the date: the text of the last <a>.
  const open = tokens.findIndex((token) => token.kind === 'open' && token.name === 'p');
  if (open < 0) return undefined;
  const close = tokens.findIndex((token, index) => index > open && token.kind === 'close' && token.name === 'p');
  const text = cut(tokensToText(tokens.slice(open + 1, close < 0 ? undefined : close))).text;
  if (text === '') return undefined;
  const lastAnchor = tokens.findLastIndex((token) => token.kind === 'open' && token.name === 'a');
  const anchorEnd = tokens.findIndex((token, index) => index > lastAnchor && token.kind === 'close' && token.name === 'a');
  const date = lastAnchor < 0 || anchorEnd < 0 ? undefined : tokensToText(tokens.slice(lastAnchor + 1, anchorEnd));
  const handle = typeof authorUrl === 'string' ? /\/([A-Za-z0-9_]{1,15})\/?$/.exec(authorUrl)?.[1] : undefined;
  const name = typeof authorName === 'string' ? oneLine(authorName) : '';
  const author = name === '' ? (handle === undefined ? undefined : `@${handle}`) : handle === undefined ? name : `${name} (@${handle})`;
  const published = date === undefined ? undefined : oneLine(date) || undefined;
  return {
    url: post,
    site: 'x.com',
    title: author === undefined ? 'Post su X' : `Post di ${author} su X`,
    siteName: 'X',
    ...(author === undefined ? {} : { author }),
    ...(published === undefined ? {} : { published }),
    text,
    truncated: false,
  };
}

// --- The fetch ----------------------------------------------------------------------

/** The site of a link as the note names it: its host without `www.`. */
export function siteOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * The content of a link: for a post of X its text through oEmbed, for any
 * other site the page itself. Never throws: a failure is a reason.
 */
export async function fetchLink(value: string, options: FetchOptions, signal?: AbortSignal): Promise<FetchResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const all = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const original = checkFetchUrl(value, options);
    const site = original.hostname.toLowerCase().replace(/^www\./, '');
    const post = xPostUrl(original.href);
    if (post !== undefined) {
      const { response } = await get(checkFetchUrl(xOembedUrl(post, options.xOembedEndpoint), options), options, all, 'application/json');
      if (response.truncated || response.type !== 'application/json') throw new FetchError('bad-response');
      let json: unknown;
      try {
        json = JSON.parse(decodeBody(response.body, response.charset));
      } catch {
        throw new FetchError('bad-response');
      }
      const link = readXOembed(json, post);
      if (link === undefined) throw new FetchError('bad-response');
      return { ok: true, link };
    }
    const { url, response } = await get(original, options, all, 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8');
    const body = decodeBody(response.body, response.charset);
    if (response.type === 'application/json') throw new FetchError('unsupported-type');
    const parts: PageParts =
      response.type === 'text/plain' ? { ...cut(body.replace(/\r\n/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ' ')).trim()) } : extractPage(body);
    if (parts.text === '' && parts.description === undefined) throw new FetchError('empty');
    return { ok: true, link: { url: url.href, site, ...parts, truncated: parts.truncated || response.truncated } };
  } catch (error) {
    if (error instanceof FetchError) {
      if (signal?.aborted === true) return { ok: false, reason: 'interrupted' };
      return { ok: false, reason: error.reason };
    }
    if (signal?.aborted === true) return { ok: false, reason: 'interrupted' };
    if (timeout.aborted) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network' };
  }
}
