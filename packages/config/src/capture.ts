import { asArray, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * Links fetched and summarized (D-154): `[capture] fetch_sites` of
 * arianna.toml. The sites whose links the organizer of kb/inbox downloads by
 * itself before the local model summarizes them; a link of any other site
 * stays a link, with a "Scarica e riassumi" button for a single download
 * asked by the user. A site covers its subdomains (`x.com` also
 * `mobile.x.com`), never a name that only ends the same way (`notx.com`).
 * Absent: none, the default-deny of privacy: every exit is chosen by the user.
 * Downloading sends the address of the link to its site: a privacy section,
 * changed from the settings page only with the confirmation step.
 */
export interface CaptureConfig {
  /** Lowercase host names, each once, in the order given. */
  fetchSites: string[];
}

export const DEFAULT_CAPTURE: CaptureConfig = { fetchSites: [] };
export const MAX_FETCH_SITES = 100;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host name as the list takes it: lowercase, at least two labels, no address, no scheme, port or path. */
export function isFetchSite(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false;
  const labels = value.split('.');
  if (!labels.every((label) => LABEL.test(label))) return false;
  // The last label is a name, never a number: no IPv4 literal.
  return !/^\d+$/.test(labels.at(-1) ?? '');
}

/** Checks a list of sites however it came (the file, the settings page); duplicates go. */
export function checkFetchSites(value: readonly string[], where = 'capture.fetch_sites'): string[] {
  if (value.length > MAX_FETCH_SITES) throw new ConfigError(`${where}: at most ${String(MAX_FETCH_SITES)} sites`);
  for (const site of value) {
    if (!isFetchSite(site)) throw new ConfigError(`${where}: each site is a lowercase host name like "example.com", without scheme, port or path`);
  }
  return [...new Set(value)];
}

/** Whether `host` is one of the sites or a subdomain of one: `mobile.x.com` yes, `x.com.evil.com` and `notx.com` no. */
export function siteListed(sites: readonly string[], host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return sites.some((site) => name === site || name.endsWith(`.${site}`));
}

export function parseCapture(value: unknown): CaptureConfig {
  if (value === undefined) return structuredClone(DEFAULT_CAPTURE);
  const table = asTable(value, 'capture');
  onlyKeys(table, ['fetch_sites'], 'capture');
  if (table.fetch_sites === undefined) return structuredClone(DEFAULT_CAPTURE);
  const sites = asArray(table.fetch_sites, 'capture.fetch_sites').map((site) => asString(site, 'capture.fetch_sites'));
  return { fetchSites: checkFetchSites(sites) };
}
