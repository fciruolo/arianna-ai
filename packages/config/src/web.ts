import { checkFetchSites } from './capture.ts';
import { asArray, asString, asTable, onlyKeys } from './validate.ts';

/**
 * Public pages read by agents (D-262, P7): `[web] coder_sites` of
 * arianna.toml. The sites whose pages the Coder on Claude may read by itself
 * through Arianna's MCP server (`web_fetch`), besides the addresses the user
 * wrote in the request. The same rules as `[capture] fetch_sites`: lowercase
 * host names, a site covers its subdomains, at most 100. Absent: none, the
 * default-deny of privacy. Reading a page sends its address to its site: a
 * privacy section, changed from the settings page only with the confirmation
 * step. Applies without a restart.
 */
export interface WebConfig {
  /** Lowercase host names, each once, in the order given. */
  coderSites: string[];
}

export const DEFAULT_WEB: WebConfig = { coderSites: [] };

/** Checks the Coder's list of sites however it came (the file, the settings page); duplicates go. */
export function checkCoderSites(value: readonly string[], where = 'web.coder_sites'): string[] {
  return checkFetchSites(value, where);
}

export function parseWeb(value: unknown): WebConfig {
  if (value === undefined) return structuredClone(DEFAULT_WEB);
  const table = asTable(value, 'web');
  onlyKeys(table, ['coder_sites'], 'web');
  if (table.coder_sites === undefined) return structuredClone(DEFAULT_WEB);
  const sites = asArray(table.coder_sites, 'web.coder_sites').map((site) => asString(site, 'web.coder_sites'));
  return { coderSites: checkCoderSites(sites) };
}
