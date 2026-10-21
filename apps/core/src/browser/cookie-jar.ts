/**
 * The cookies of the site of an access made by the user (D-276, D-264 passo
 * 5): kept by the core in memory, for one browser, never written anywhere,
 * gone with the browser. Only the site of the access (`site`, a host name as
 * the browser names a site: without `www.`) and its subdomains: a cookie of
 * another host, or with a Domain outside the site, is never kept, and the
 * header is never built for a host outside it. Chromium in the container
 * never sees a cookie (network.ts drops Set-Cookie on the way in and builds
 * the headers that leave): the core adds `Cookie` itself, after the gateway.
 *
 * A small part of RFC 6265: name and value, Domain, Path, Secure, Max-Age,
 * Expires, and the prefixes `__Secure-` and `__Host-`. HttpOnly and SameSite
 * change nothing here (no script of the page reads these cookies, and every
 * request of an authenticated browser goes to the site of the access or
 * nowhere). Values are never logged nor given to a model.
 */

export const MAX_COOKIES = 50;
/** Bytes of one Set-Cookie line read at most (name, value and attributes). */
export const MAX_COOKIE_LINE = 4096;

interface Cookie {
  name: string;
  value: string;
  /** The host it goes to: exactly (hostOnly) or with its subdomains. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  /** Milliseconds since the epoch; undefined for a cookie of the session (of the browser). */
  expires: number | undefined;
  created: number;
}

/** Whether `host` is `site` or one of its subdomains. */
export function onSite(host: string, site: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === site || name.endsWith(`.${site}`);
}

/** The default path of a cookie: the folder of the path of the address (RFC 6265, 5.1.4). */
function defaultPath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith('/') || path.lastIndexOf('/') === 0) return '/';
  return path.slice(0, path.lastIndexOf('/'));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Printable ASCII without `;`, `,` (a value) or `=` too (a name); a value may be quoted. */
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE = /^"?[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"?$/;

export class CookieJar {
  readonly site: string;
  #cookies: Cookie[] = [];

  constructor(site: string) {
    this.site = site.toLowerCase();
  }

  get size(): number {
    return this.#cookies.length;
  }

  /**
   * Keeps the cookies of the Set-Cookie lines of an answer from `url`; an
   * answer of a host outside the site keeps nothing. How many were kept or
   * removed (an expired one removes its old value).
   */
  store(lines: readonly string[], url: URL, now: number): number {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!onSite(host, this.site) || (url.protocol !== 'https:' && url.protocol !== 'http:')) return 0;
    let changed = 0;
    for (const line of lines) {
      const cookie = this.#parse(line, url, host, now);
      if (cookie === undefined) continue;
      const same = (item: Cookie): boolean => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path && item.hostOnly === cookie.hostOnly;
      const before = this.#cookies.length;
      this.#cookies = this.#cookies.filter((item) => !same(item));
      if (cookie.expires !== undefined && cookie.expires <= now) {
        if (this.#cookies.length !== before) changed += 1;
        continue;
      }
      this.#cookies.push(cookie);
      changed += 1;
      // The oldest go first past the limit.
      if (this.#cookies.length > MAX_COOKIES) this.#cookies.sort((a, b) => a.created - b.created).splice(0, this.#cookies.length - MAX_COOKIES);
    }
    return changed;
  }

  /** The `Cookie` header for a request to `url`; undefined when none goes (or the host is outside the site). */
  header(url: URL, now: number): string | undefined {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!onSite(host, this.site)) return undefined;
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now);
    const chosen = this.#cookies
      .filter((cookie) => (cookie.hostOnly ? host === cookie.domain : onSite(host, cookie.domain)))
      .filter((cookie) => pathMatches(url.pathname || '/', cookie.path))
      .filter((cookie) => !cookie.secure || url.protocol === 'https:')
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    if (chosen.length === 0) return undefined;
    return chosen.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  #parse(line: string, url: URL, host: string, now: number): Cookie | undefined {
    if (line.length > MAX_COOKIE_LINE) return undefined;
    const [pair = '', ...attributes] = line.split(';');
    const equals = pair.indexOf('=');
    if (equals <= 0) return undefined;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!NAME.test(name) || !VALUE.test(value)) return undefined;
    let domain: string | undefined;
    let path: string | undefined;
    let secure = false;
    let maxAge: number | undefined;
    let expires: number | undefined;
    for (const attribute of attributes) {
      const at = attribute.indexOf('=');
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const argument = at < 0 ? '' : attribute.slice(at + 1).trim();
      if (key === 'domain' && argument !== '') domain = argument.replace(/^\./, '').toLowerCase();
      else if (key === 'path' && argument.startsWith('/')) path = argument;
      else if (key === 'secure') secure = true;
      else if (key === 'max-age' && /^-?\d{1,10}$/.test(argument)) maxAge = Number(argument);
      else if (key === 'expires') {
        const parsed = Date.parse(argument);
        if (!Number.isNaN(parsed)) expires = parsed;
      }
    }
    // A Domain must cover the host of the answer and stay within the site of the access.
    if (domain !== undefined && (!onSite(host, domain) || !onSite(domain, this.site))) return undefined;
    // A Secure cookie only from https (RFC 6265bis); the prefixes as Chromium checks them.
    if (secure && url.protocol !== 'https:') return undefined;
    if (name.startsWith('__Secure-') && !secure) return undefined;
    if (name.startsWith('__Host-') && (!secure || domain !== undefined || path !== '/')) return undefined;
    const lifetime = maxAge !== undefined ? now + maxAge * 1000 : expires;
    return {
      name,
      value,
      domain: domain ?? host,
      hostOnly: domain === undefined,
      path: path ?? defaultPath(url),
      secure,
      expires: lifetime,
      created: now,
    };
  }
}
