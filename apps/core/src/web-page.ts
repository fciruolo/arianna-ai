import { spendAllowed, type Context, type Label, type PageConsent, type Target } from '@arianna/policy';

import { linkInText } from './capture.ts';
import type { Sql } from './db/client.ts';
import { passGateway, type GatewayMeta } from './gateway.ts';
import { fetchLink, siteOf, xPostUrl, type FetchOptions, type FetchResult } from './link-fetch.ts';

/**
 * Reading one public page (D-262, P7) for a tool: Arianna's `web.fetch` in a
 * chat, or the Coder's through Arianna's MCP server. The network part is the
 * downloader of links (D-154): never towards this machine or the local
 * network, DNS fixed at the moment of connecting, redirects checked again.
 * Every address, the first one and each redirect, passes the gateway towards
 * a page target with the consent of the caller:
 *
 * - `public`: the session is Public (L0), any public page;
 * - `user`: the addresses the user wrote; a redirect stays on the site of the
 *   address (and, for a post of X, publish.twitter.com, its oEmbed);
 * - `sites`: the sites of the user's list.
 *
 * What comes back is untrusted public content: the caller gives it to a model
 * as data, never as instructions, labelled L0.
 *
 * With `meta.saved` (D-283, web.fetch of a chat) the gateway compares each
 * address with the private values the user saved instead of the second
 * scanner: an address with one not approved is refused, and the result
 * carries its references (`saved`) for the card «Apri / No».
 */

/** The fragment of an address: the label of the session, never above it (an address the model wrote in a Public session is L0). */
function addressFragment(address: string, label: Label) {
  return [{ value: address, label, source: 'web:page' }];
}

/** The consent for the redirects of a first address allowed with `consent`. */
export function redirectConsent(consent: PageConsent, first: string): PageConsent {
  if (consent.from === 'public') return consent;
  // A post of X on a listed site: its oEmbed too, the only way it is read.
  if (consent.from === 'sites') return xPostUrl(first) === undefined || consent.sites.includes('publish.twitter.com') ? consent : { from: 'sites', sites: [...consent.sites, 'publish.twitter.com'] };
  const site = siteOf(first);
  const sites = site === undefined ? [] : [site];
  if (xPostUrl(first) !== undefined) sites.push('publish.twitter.com');
  return sites.length === 0 ? consent : { from: 'sites', sites };
}

export interface ReadPageInput {
  sql: Sql;
  address: string;
  /** The context of the session that asks: the gateway refuses anything above Internal (L1) or with finance data. */
  context: Context;
  consent: PageConsent;
  meta?: GatewayMeta;
  signal?: AbortSignal;
  /** Tests: the downloader, with fake servers. */
  fetchLink?: (address: string, options: FetchOptions, signal?: AbortSignal) => Promise<FetchResult>;
}

/** What readPage gives: the page, or why not; `saved` with a refusal for saved private values (D-283). */
export type ReadPageResult = FetchResult & { saved?: readonly string[]; savedSite?: string };

/** Downloads one page through the gateway. Never throws for a refusal: it is a reason (`blocked` for the gateway). */
export async function readPage(input: ReadPageInput): Promise<ReadPageResult> {
  const { sql, address, context, consent } = input;
  let saved: readonly string[] | undefined;
  let savedSite: string | undefined;
  const allowed = async (page: PageConsent, next: string): Promise<string | undefined> => {
    const target: Target = { kind: 'web', page };
    const decision = await passGateway(sql, addressFragment(next, context.effective), context, target, input.meta);
    if (decision.decision === 'block' && decision.rule === 'saved-private' && decision.saved !== undefined) {
      saved = decision.saved;
      savedSite = siteOf(next);
    }
    if (decision.decision !== 'allow') return undefined;
    const spent = spendAllowed(decision);
    return spent?.target.kind === 'web' && spent.target.page !== undefined ? spent.texts[0] : undefined;
  };
  // For a post of X the first address asked is its oEmbed, not the post: the consent is checked on the post first.
  let first = true;
  if (xPostUrl(address) !== undefined) {
    let normalized: string;
    try {
      normalized = new URL(address).href;
    } catch {
      return { ok: false, reason: 'invalid-url' };
    }
    if ((await allowed(consent, normalized)) !== normalized) return { ok: false, reason: 'blocked', ...(saved === undefined ? {} : { saved }), ...(savedSite === undefined ? {} : { savedSite }) };
    first = false;
  }
  const authorize = async (next: string): Promise<string | undefined> => {
    const page = first ? consent : redirectConsent(consent, address);
    first = false;
    return allowed(page, next);
  };
  const download = input.fetchLink ?? fetchLink;
  const result = await download(address, { authorize }, input.signal);
  return !result.ok && saved !== undefined ? { ...result, saved, ...(savedSite === undefined ? {} : { savedSite }) } : result;
}

/** Every http(s) address written in a text (the user's messages, a brief), normalized, at most `limit`. */
export function addressesInText(text: string, limit = 200): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const address = linkInText(match[0]);
    if (address !== undefined) found.add(address);
    if (found.size >= limit) break;
  }
  return [...found];
}
