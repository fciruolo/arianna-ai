import { spendAllowed, type Context, type Labeled, type PageConsent, type Target } from '@arianna/policy';

import type { Sql } from '../db/client.ts';
import { passGateway, type GatewayMeta } from '../gateway.ts';
import { onSite } from './cookie-jar.ts';
import { checkRequest, fetchResource, resourceUrl, type ResourceInput, type ResourceOptions, type ResourceResult } from './resource-fetch.ts';

/**
 * One request of a page of the agent's browser through the gateway (D-264,
 * passo 2), as `readPage` of `web-page.ts` does for a page: what the
 * interception of the browser (`context.route`) calls for every request that
 * is not the main page of a tab. Before the gateway, here, what would never
 * be requested anyway (a private address, a method other than GET, HEAD or
 * POST, a body too large or not text): nothing is asked nor logged. Then the
 * address and the body pass the gateway towards a resource target with the
 * consent of the page of the job (`web-resource-<consent>` in gateway_log,
 * never the address nor the site), and only the exact texts it allowed are
 * requested. The answer is untrusted public content: it goes to the browser
 * only, never to a model.
 */

export interface ResourceGateInput {
  sql: Sql;
  /** The context of the session of the job: the gateway refuses anything above Internal (L1) or with finance data. */
  context: Context;
  /** The consent the page of the job was opened with (D-262). */
  consent: PageConsent | PageConsent['from'];
  /**
   * The site of an access made by the user (D-276), once the browser has
   * one: a request of that site goes as `session` (L2, with the cookies the
   * core set in `request.cookie`); any other carries L2 with the consent of
   * the page, which the gateway refuses.
   */
  session?: string;
  request: ResourceInput;
  network: ResourceOptions;
  meta?: GatewayMeta;
  signal?: AbortSignal;
  /** Tests: the network part, with fake servers. */
  fetchResource?: typeof fetchResource;
}

/** The text of a body as the gateway reads it and as it is sent again: UTF-8 only, its bytes unchanged. */
function bodyText(body: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return undefined;
  }
}

/** Requests one resource through the gateway. Never throws for a refusal: it is a reason (`blocked` for the gateway). */
export async function gateResource(input: ResourceGateInput): Promise<ResourceResult> {
  const { request, context } = input;
  const checked = checkRequest(request);
  if (typeof checked === 'string') return { ok: false, reason: checked };
  const url = resourceUrl(request.url, input.network);
  if (typeof url === 'string') return { ok: false, reason: url };
  const body = checked.body === undefined ? undefined : bodyText(checked.body);
  if (checked.body !== undefined && body === undefined) return { ok: false, reason: 'unreadable-body' };

  const of = typeof input.consent === 'string' ? input.consent : input.consent.from;
  const onSession = input.session !== undefined && onSite(url.hostname, input.session);
  const target: Target =
    onSession && input.session !== undefined ? { kind: 'web', session: { site: input.session, type: request.type, method: checked.method } } : { kind: 'web', resource: { of, type: request.type, method: checked.method } };
  // The label of the session, never above it, as for a page; L2 once the browser has an access (D-276).
  const label = input.session === undefined ? context.effective : 'L2';
  const payload: Labeled<unknown>[] = [{ value: url.href, label, source: 'web:resource' }];
  if (body !== undefined) payload.push({ value: body, label, source: 'web:resource' });
  let spent;
  try {
    const decision = await passGateway(input.sql, payload, context, target, input.meta);
    if (decision.decision !== 'allow') return { ok: false, reason: 'blocked' };
    spent = spendAllowed(decision);
  } catch {
    // A gateway that cannot decide (its log not writable) is a refusal, never a network error.
    return { ok: false, reason: 'blocked' };
  }
  if (spent?.target.kind !== 'web' || (spent.target.resource === undefined && spent.target.session === undefined)) return { ok: false, reason: 'blocked' };
  const [address, text] = spent.texts;
  if (address !== url.href || text !== body) return { ok: false, reason: 'blocked' };
  const download = input.fetchResource ?? fetchResource;
  // The cookies only for a request the gateway allowed as one of the site of the access.
  const cookie = spent.target.session !== undefined ? request.cookie : undefined;
  return download(
    { url: address, method: checked.method, headers: request.headers, type: request.type, ...(text === undefined ? {} : { body: Buffer.from(text, 'utf8') }), ...(cookie === undefined ? {} : { cookie }) },
    input.network,
    input.signal,
  );
}
