// The only exit (docs/PRIVACY-POLICY-SPEC.md, rules 4, 9 and 10). Pure: it
// decides, the core writes the decision to gateway_log before anything is sent.
import { canUseCloud, isContext, isFinanceSource, labelOf, type Context, type Labeled } from './context.ts';
import { canSendTo, maxLabel, type Label, type Locality } from './labels.ts';
import { payloadText, scanParts } from './payload.ts';
import { piiExemptions, piiScanTexts } from './catalog-texts.ts';
import { piiVerdict, type PiiCheck, type PiiFinding } from './pii.ts';
import { scanText, type Finding } from './scanner.ts';
import type { KnownSecrets } from './secrets.ts';

// `voice`: a call from the web chat to apps/voice, on this machine (D-066);
// `push`: the notification of a call, through Apple, Google or Mozilla.
export type ChannelId = 'web' | 'telegram' | 'phone' | 'voice' | 'push';

/**
 * Why the user allowed a link to be downloaded (D-154): its site is in
 * `[capture] fetch_sites` (`list`), or the user pressed "Scarica e riassumi"
 * on that note (`click`), or approved «Riassumi il video» for that one video
 * of YouTube (`video`, D-273).
 */
export type LinkConsent = 'list' | 'click' | 'video';

/**
 * The only address a `video` consent takes (D-273): one video of YouTube,
 * normalized by the core, without any other parameter.
 */
export const VIDEO_ADDRESS = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;

/**
 * Why a public page may be read (D-262, P7): the session is Public (`public`,
 * any public address, the model may follow links), the address was written by
 * the user in the conversation or in the brief (`user`, `addresses` as the
 * caller read them), or its site is in the list of the user (`sites`, for the
 * Coder: `[web] coder_sites`, and a redirect of a `user` address within its
 * own site). The caller declares where the addresses and sites come from;
 * the gateway guarantees one address, checked against them and scanned.
 */
export type PageConsent =
  | { from: 'public' }
  | { from: 'user'; addresses: readonly string[] }
  | { from: 'sites'; sites: readonly string[] };

/**
 * What a resource of a page of the agent's browser is (D-264): the frame of
 * an iframe (`document`), a style sheet, a script, an image, a font, or a
 * call of the page's scripts (`fetch`, fetch and XMLHttpRequest).
 */
export const RESOURCE_TYPES = ['document', 'stylesheet', 'script', 'image', 'font', 'fetch'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export const RESOURCE_METHODS = ['GET', 'HEAD', 'POST'] as const;
export type ResourceMethod = (typeof RESOURCE_METHODS)[number];
/** Bytes of a POST body in UTF-8 a resource may carry at most (D-264). */
export const MAX_RESOURCE_BODY = 64 * 1024;

/**
 * A resource requested by a page of the agent's browser (D-264): `of` is the
 * consent the page of the job was opened with (D-262). The payload is the
 * address, and for a POST its body: `[address]` or `[address, body]`.
 */
export interface ResourceRequest {
  of: PageConsent['from'];
  type: ResourceType;
  method: ResourceMethod;
}

/**
 * Characters (Unicode code points) the agent's browser may type in one field
 * of a public page at most (D-264, `browser.type`).
 */
export const MAX_TYPED_TEXT = 200;

export type Target =
  | { kind: 'executor'; id: string; locality: Locality }
  | { kind: 'channel'; id: ChannelId }
  /** Without `page`: a query to a fixed service (catalogs, Hugging Face). With `page`: one public page to read (D-262). */
  | { kind: 'web'; page?: PageConsent; resource?: never; typed?: never }
  /** One resource of a page of the agent's browser (D-264): never with `page`. */
  | { kind: 'web'; resource: ResourceRequest; page?: never; typed?: never }
  /**
   * The text the agent's browser types in a field of a public page (D-264,
   * `browser.type`): `typed` is the consent the page was opened with (D-262).
   * The payload is one text of at most `MAX_TYPED_TEXT` characters, checked
   * as a page: never with `page` or `resource`.
   */
  | { kind: 'web'; typed: PageConsent['from']; page?: never; resource?: never }
  /**
   * The address of a link saved by the user, to its own site (D-154). With
   * `list`, `sites` are the sites of the list the caller read: the address
   * must be on one of them (or a subdomain). The consent is declared by the
   * caller (only organize.ts, for the url the capture code wrote): what the
   * gateway guarantees is one address, checked and scanned, never other text.
   */
  | { kind: 'link'; consent: 'list'; sites: readonly string[] }
  | { kind: 'link'; consent: 'click' }
  /**
   * One video of YouTube approved by the user with «Riassumi il video»
   * (D-273): the address must be `https://www.youtube.com/watch?v=<id>`
   * exactly. What leaves after it (yt-dlp through the proxy of the core,
   * towards a closed list of hosts of YouTube and Google) is that video only.
   */
  | { kind: 'link'; consent: 'video' };

/** Which rule decided; stored in `gateway_log.rule`. */
export type GatewayRule =
  | 'invalid-input'
  | 'finance'
  | 'secret'
  | 'contaminated'
  | 'cloud-label'
  | 'unscannable'
  | 'scanner'
  | 'pii'
  | 'pii-unavailable'
  | 'link-invalid'
  | 'page-consent'
  | 'resource-invalid'
  | 'typed-invalid'
  | 'local'
  | 'cloud'
  | 'link'
  | 'page'
  | 'resource'
  | 'typed';

/**
 * What the caller does after a block. `notify-reference`: a channel gets a
 * notice that points to the web chat instead of the content. `wait-user`: the
 * task stops in "Attende te". `stay-local`: the work stays on a local model,
 * or the user approves the exact text (declassify) and it is checked again.
 */
export type NextStep = 'notify-reference' | 'wait-user' | 'stay-local';

export type Decision =
  | {
      decision: 'allow';
      rule: 'local' | 'cloud' | 'link' | 'page' | 'resource' | 'typed';
      label: Label;
      reason: string;
      /** The exact text checked for each fragment, frozen: this is what is sent. */
      texts: readonly string[];
    }
  | {
      decision: 'block';
      rule: Exclude<GatewayRule, 'local' | 'cloud' | 'link' | 'page' | 'resource' | 'typed'>;
      label: Label;
      reason: string;
      next: NextStep;
      /** Scanner matches, without the matched text. */
      findings?: Finding[];
      /** Kinds the second scanner found (D-113), without text or position. */
      pii?: readonly PiiFinding[];
    };

const CHANNELS: readonly string[] = ['web', 'telegram', 'phone', 'voice', 'push'];
/** Sites a `list` consent may name (the list of arianna.toml holds 100 at most, plus publish.twitter.com). */
const MAX_LINK_SITES = 200;
const MAX_LINK = 2_000;
/** Addresses a `user` page consent may name: those written in one conversation or brief. */
const MAX_PAGE_ADDRESSES = 200;
const X_HOSTS = ['x.com', 'twitter.com', 'publish.twitter.com'];

/**
 * The address of a link as the scanner reads it: the numeric id of a post of
 * X, alone or inside the oEmbed address, is masked, since a post id passes the
 * card check (Luhn) about once in ten. Everything else of the address is read.
 */
export function linkScanText(address: string): string {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
  } catch {
    return address;
  }
  if (!X_HOSTS.includes(host)) return address;
  return address.replace(/(status(?:\/|%2F))\d{1,25}/gi, (_match, prefix: string) => `${prefix}0`);
}

/** A host name of the list: lowercase, at least two labels, no scheme, port or path (`com` would cover every .com site). */
function isSiteName(site: string): boolean {
  if (site.length > 253) return false;
  const labels = site.split('.');
  return labels.length >= 2 && labels.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) && !/^\d+$/.test(labels.at(-1) ?? '');
}

/** One address only: http(s), normalized, no credentials, no space. The URL, or the reason of the refusal. */
function singleAddress(payload: readonly Labeled<unknown>[], texts: readonly string[]): URL | string {
  const [text] = texts;
  if (payload.length !== 1 || typeof payload[0]?.value !== 'string' || text === undefined) return 'the target takes exactly one address';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'not an address';
  }
  if (text.length > MAX_LINK || /[\s\p{Cc}]/u.test(text) || url.href !== text) return 'not a single normalized address';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https addresses';
  if (url.username !== '' || url.password !== '') return 'no credentials in an address';
  return url;
}

/** Whether the host of `url` is one of `sites` or a subdomain of one. */
function onSites(url: URL, sites: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Scanner matches in an address, read as written and decoded (decodable: checked before). */
function addressFindings(text: string): Finding[] {
  // Values in an address are often %-encoded.
  const masked = linkScanText(text);
  return [...scanText(masked), ...scanText(decodeURIComponent(masked))];
}

/** A link target allows one address only: http(s), normalized, no credentials, no space; with `list`, on a site of the list. */
function checkLink(payload: readonly Labeled<unknown>[], texts: readonly string[], label: Label, target: Extract<Target, { kind: 'link' }>): Decision {
  const url = singleAddress(payload, texts);
  if (typeof url === 'string') return block('link-invalid', label, url, 'stay-local');
  if (target.consent === 'list' && !onSites(url, target.sites)) return block('link-invalid', label, 'the site is not in the list of the user', 'stay-local');
  if (target.consent === 'video' && !VIDEO_ADDRESS.test(url.href)) return block('link-invalid', label, 'a video consent takes one normalized YouTube video address only', 'stay-local');
  const findings = addressFindings(url.href);
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
    return block('scanner', label, `scanner matched: ${kinds}`, 'stay-local', findings);
  }
  return allow({ decision: 'allow', rule: 'link', label, reason: `${label} address to its site, ${target.consent} consent, scan clean`, texts }, target);
}

/** An address as compared with those of a `user` consent: normalized, without the fragment (never sent). */
function pageKey(address: string): string | undefined {
  try {
    const url = new URL(address);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * A page to read (D-262): one address as for a link, and the consent must
 * cover it: a Public session (L0 context and L0 address), an address written
 * by the user, or a site of the list. What the gateway cannot know is checked
 * by the cloud rules before and the two scanners after.
 */
function checkPage(payload: readonly Labeled<unknown>[], texts: readonly string[], label: Label, context: Context, page: PageConsent): Decision | undefined {
  const url = singleAddress(payload, texts);
  if (typeof url === 'string') return block('link-invalid', label, url, 'stay-local');
  switch (page.from) {
    case 'public':
      if (context.effective !== 'L0' || label !== 'L0') return block('page-consent', label, `any public page only from a public session, not ${maxLabel(context.effective, label)}`, 'stay-local');
      break;
    case 'user': {
      const key = pageKey(url.href);
      if (!page.addresses.some((address) => pageKey(address) === key)) return block('page-consent', label, 'the address was not written by the user', 'stay-local');
      break;
    }
    case 'sites':
      if (!onSites(url, page.sites)) return block('page-consent', label, 'the site is not in the list of the user', 'stay-local');
      break;
  }
  const findings = addressFindings(url.href);
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
    return block('scanner', label, `scanner matched: ${kinds}`, 'stay-local', findings);
  }
  return undefined;
}

function isResourceRequest(value: unknown): value is ResourceRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  return (
    Object.keys(resource).every((key) => key === 'of' || key === 'type' || key === 'method') &&
    (resource.of === 'public' || resource.of === 'user' || resource.of === 'sites') &&
    RESOURCE_TYPES.some((type) => type === resource.type) &&
    RESOURCE_METHODS.some((method) => method === resource.method)
  );
}

/**
 * The shape of a resource (D-264), before any text is read: one normalized
 * address, and a body only with POST, a string of at most 64 KB in UTF-8.
 */
function checkResourceShape(payload: readonly Labeled<unknown>[], label: Label, resource: ResourceRequest): Decision | undefined {
  if (payload.length !== 1 && payload.length !== 2) return block('resource-invalid', label, 'a resource is an address, and a body only with POST', 'stay-local');
  const [address, body] = payload;
  if (typeof address?.value !== 'string') return block('resource-invalid', label, 'the address of a resource is a text', 'stay-local');
  const url = singleAddress([address], [address.value]);
  if (typeof url === 'string') return block('resource-invalid', label, url, 'stay-local');
  if (body === undefined) return undefined;
  if (resource.method !== 'POST') return block('resource-invalid', label, `a ${resource.method} resource has no body`, 'stay-local');
  if (typeof body.value !== 'string') return block('resource-invalid', label, 'the body of a resource is a text', 'stay-local');
  if (new TextEncoder().encode(body.value).length > MAX_RESOURCE_BODY) return block('resource-invalid', label, `the body of a resource is larger than ${String(MAX_RESOURCE_BODY)} bytes`, 'stay-local');
  return undefined;
}

/**
 * What else a body says when read as a form or as JSON: %-escapes decoded one
 * by one (a stray `%` must not hide the rest), `+` as a space, and every key
 * and string of a JSON body, whose `\u` escapes would hide a value.
 */
function bodyReadings(body: string): string[] {
  const readings: string[] = [];
  const unescaped = body.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
  if (unescaped !== body) readings.push(unescaped);
  if (body.includes('+')) readings.push(unescaped.replace(/\+/g, ' '));
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      readings.push(...scanParts(JSON.stringify(JSON.parse(trimmed)), true));
    } catch {
      // Not JSON: read as it is.
    }
  }
  return readings;
}

/**
 * The shape of a typed text (D-264), before any text is read: exactly one
 * string of at most `MAX_TYPED_TEXT` characters, without control characters
 * (a newline or a tab would submit the form or move to another field, which
 * is the caller's `submit`, never the text's).
 */
function checkTypedShape(payload: readonly Labeled<unknown>[], label: Label): Decision | undefined {
  if (payload.length !== 1) return block('typed-invalid', label, 'a typed text is exactly one fragment', 'stay-local');
  const [text] = payload;
  if (typeof text?.value !== 'string') return block('typed-invalid', label, 'a typed text is a text', 'stay-local');
  if (Array.from(text.value).length > MAX_TYPED_TEXT) return block('typed-invalid', label, `a typed text is longer than ${String(MAX_TYPED_TEXT)} characters`, 'stay-local');
  if (/\p{Cc}/u.test(text.value)) return block('typed-invalid', label, 'a typed text has no control characters', 'stay-local');
  return undefined;
}

function isPageConsent(value: unknown): value is PageConsent {
  if (typeof value !== 'object' || value === null) return false;
  const page = value as Record<string, unknown>;
  switch (page.from) {
    case 'public':
      return true;
    case 'user':
      return Array.isArray(page.addresses) && page.addresses.length > 0 && page.addresses.length <= MAX_PAGE_ADDRESSES && (page.addresses as unknown[]).every((address) => typeof address === 'string' && address !== '' && address.length <= MAX_LINK);
    case 'sites':
      return Array.isArray(page.sites) && page.sites.length > 0 && page.sites.length <= MAX_LINK_SITES && (page.sites as unknown[]).every((site) => typeof site === 'string' && isSiteName(site));
    default:
      return false;
  }
}

/**
 * Executors whose inference is always in the cloud: declaring them local is a
 * bug or an attack, not a configuration. Whether any other executor is really
 * local (its endpoint in `local_endpoints`) is checked by its adapter.
 */
const CLOUD_EXECUTORS: readonly string[] = ['claude', 'codex'];

/** Runtime check: targets also come from configuration and model output. */
export function isTarget(value: unknown): value is Target {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  switch (target.kind) {
    case 'executor':
      return (
        typeof target.id === 'string' &&
        target.id !== '' &&
        (target.locality === 'local' || target.locality === 'cloud')
      );
    case 'channel':
      return CHANNELS.includes(target.id as string);
    case 'web':
      if (target.typed !== undefined) return target.page === undefined && target.resource === undefined && (target.typed === 'public' || target.typed === 'user' || target.typed === 'sites');
      if (target.resource !== undefined) return target.page === undefined && isResourceRequest(target.resource);
      return target.page === undefined || isPageConsent(target.page);
    case 'link':
      if (target.consent === 'click' || target.consent === 'video') return true;
      return (
        target.consent === 'list' &&
        Array.isArray(target.sites) &&
        target.sites.length > 0 &&
        target.sites.length <= MAX_LINK_SITES &&
        (target.sites as unknown[]).every((site) => typeof site === 'string' && isSiteName(site))
      );
    default:
      return false;
  }
}

/**
 * Where inference or delivery happens. The web chat, reached over the VPN,
 * and the internet call to apps/voice (D-066) are local channels; Telegram,
 * the phone and push notifications are cloud (D-016).
 */
export function localityOf(target: Target): Locality {
  if (target.kind === 'executor') return target.locality;
  if (target.kind === 'channel' && (target.id === 'web' || target.id === 'voice')) return 'local';
  return 'cloud';
}

/** `gateway_log.target`: e.g. `claude`, `telegram`, `web-search`, `link-list`, `web-typed-public`; never the address nor the site of a link, nor a typed text. */
export function targetName(target: Target): string {
  if (target.kind === 'web') {
    if (target.typed !== undefined) return `web-typed-${target.typed}`;
    if (target.resource !== undefined) return `web-resource-${target.resource.of}`;
    return target.page === undefined ? 'web-search' : `web-page-${target.page.from}`;
  }
  if (target.kind === 'link') return `link-${target.consent}`;
  return target.id;
}

/** What a decision allowed, as recorded when it was made; see `allowedBy`. */
export interface Allowed {
  readonly target: Readonly<Target>;
  readonly label: Label;
  readonly texts: readonly string[];
}

// Decisions made here, and only these, can be spent by an adapter: an object
// literal could claim `allow` for any text, and a real decision could be edited.
const allowed = new WeakMap<object, Allowed & { logged: boolean }>();

function allow(decision: Extract<Decision, { decision: 'allow' }>, target: Target): Decision {
  allowed.set(decision, {
    target: Object.freeze({ ...target }),
    label: decision.label,
    texts: decision.texts,
    logged: false,
  });
  return decision;
}

/**
 * What `decision` allowed, and towards which target, when it is an `allow`
 * made by `gatewayCheck` and not yet spent; undefined otherwise. Read-only:
 * adapters use `spendAllowed`.
 */
export function allowedBy(decision: unknown): Allowed | undefined {
  const record = typeof decision === 'object' && decision !== null ? allowed.get(decision) : undefined;
  return record === undefined ? undefined : Object.freeze({ target: record.target, label: record.label, texts: record.texts });
}

/**
 * Marks an allow as written to gateway_log. The core's `passGateway` calls it
 * after the INSERT; evals and tests, which have no log, call it themselves.
 * False for anything that is not an unspent allow of `gatewayCheck`.
 */
export function markLogged(decision: unknown): boolean {
  const record = typeof decision === 'object' && decision !== null ? allowed.get(decision) : undefined;
  if (record === undefined) return false;
  record.logged = true;
  return true;
}

/**
 * Takes what an allow permits, once: an adapter sends `texts` from here, never
 * from the decision object, and checks the target is its own. Undefined when
 * the decision is not an allow of `gatewayCheck`, was not logged, or was
 * already spent: one row in gateway_log, one exit.
 */
export function spendAllowed(decision: unknown): Allowed | undefined {
  const record = typeof decision === 'object' && decision !== null ? allowed.get(decision) : undefined;
  if (record?.logged !== true) return undefined;
  allowed.delete(decision as object);
  return Object.freeze({ target: record.target, label: record.label, texts: record.texts });
}

function block(
  rule: Exclude<GatewayRule, 'local' | 'cloud' | 'link' | 'page' | 'resource' | 'typed'>,
  label: Label,
  reason: string,
  next: NextStep,
  findings?: Finding[],
  pii?: readonly PiiFinding[],
): Decision {
  const decision: Decision = { decision: 'block', rule, label, reason, next };
  if (findings !== undefined) decision.findings = findings;
  if (pii !== undefined) decision.pii = pii;
  return decision;
}

/**
 * Decides whether a payload may go to a target. Checks, in order:
 * 1. inputs are well formed (a context made by the policy, a known target whose
 *    locality matches what is known about it, a list of fragments);
 * 2. nothing goes to a cloud target (cloud executor, Telegram, phone, push,
 *    web query, page, resource or typed text, link) when a fragment is finance data (`finance:*` source)
 *    or the context has read some (D-183), whatever the labels;
 * 3. no fragment is L3, whatever the target;
 * 4. every fragment has a text form (text or plain JSON);
 * 5. no fragment contains the value of a secret revealed by the vault
 *    (`secrets`), whatever its label and the target;
 * 6. local targets take up to L2;
 * 7. cloud targets (cloud executors, Telegram, phone, web search) need a context
 *    that has read at most L1, a payload of at most L1, and a clean scan;
 * 8. and then a clean second scan (`pii`, D-113): what Rizzo-PII found in these
 *    exact texts, a text of the adopted catalogs marked by the core in its own
 *    fragment read as empty (`markCatalogText`, D-250). A kind that points at a person blocks; no answer blocks too,
 *    except on a development installation (`piiUnavailable(…, true)`), where
 *    the allow says the check was skipped. A link is one address chosen by the
 *    user, checked by its own rules: the second scan does not read it. Nor
 *    does it read a resource of a page of the agent's browser (D-264): its
 *    shape is checked right after rule 3, then rules 4-7 and the scanner on
 *    its address and body, decoded too, decide. A text the agent's browser
 *    types in a field (`typed`, D-264) is checked as a page: its shape right
 *    after rule 3 (one text of at most `MAX_TYPED_TEXT` characters), then
 *    rules 4-7, its consent (`public` only from an L0 session and an L0
 *    text), the scanner and the second scan.
 *
 * `context` is the session the payload belongs to on the sending side: the run
 * for a brief to a cloud executor, the task for a channel message or a web query.
 * Fragments without a valid label count as L2, finance fragments at least L2. Reasons name labels and rules,
 * never content, so they can be logged.
 *
 * An allowed decision carries `texts`, the exact text checked for each fragment:
 * adapters send those, never a new serialization of the original values.
 *
 * `secrets` is required, so no caller can skip the check by forgetting it:
 * the core passes the vault's registry, evals and tests `secretMatcher([])` or
 * their fake values. `pii` is required for the same reason: the core passes
 * the answer of apps/guard, evals and tests `piiReport` of a fake recognizer.
 */
export function gatewayCheck(
  payload: readonly Labeled<unknown>[],
  context: Context,
  target: Target,
  secrets: KnownSecrets,
  pii: PiiCheck,
): Decision {
  // Types do not hold at runtime: payloads also come from model output and JSON.
  const fragments: readonly unknown[] = payload;
  if (!Array.isArray(fragments) || !fragments.every((fragment) => typeof fragment === 'object' && fragment !== null)) {
    return block('invalid-input', 'L2', 'payload is not a list of labeled fragments', 'stay-local');
  }
  const label = maxLabel(...payload.map(labelOf));
  if (!isContext(context)) return block('invalid-input', label, 'context was not created by the policy', 'stay-local');
  if (!isTarget(target)) return block('invalid-input', label, 'unknown target', 'stay-local');
  // Types do not hold at runtime: a missing matcher must not mean "no secrets".
  if (typeof (secrets as Partial<KnownSecrets> | undefined)?.find !== 'function') {
    return block('invalid-input', label, 'the known secrets were not given', 'stay-local');
  }
  if (target.kind === 'executor' && CLOUD_EXECUTORS.includes(target.id) && target.locality !== 'cloud') {
    return block('invalid-input', label, `executor ${target.id} is a cloud executor, not ${target.locality}`, 'stay-local');
  }

  const locality = localityOf(target);
  const onBlock: NextStep = target.kind === 'channel' && locality === 'cloud' ? 'notify-reference' : 'stay-local';

  // Finance data never leaves this machine (D-183): no label, approval or scan changes this.
  if (locality === 'cloud') {
    if (payload.some((fragment) => isFinanceSource(fragment.source))) {
      return block('finance', label, 'finance data goes to local targets only', onBlock);
    }
    if (context.finance === true) {
      return block('finance', label, 'the session has read finance data: it stays local', onBlock);
    }
  }

  if (label === 'L3') return block('secret', label, 'L3 never leaves the vault: send a vault:// reference', onBlock);

  // A resource of the browser (D-264): its shape first, so that no oversized body is ever read.
  const resource = target.kind === 'web' ? target.resource : undefined;
  if (resource !== undefined) {
    const refused = checkResourceShape(payload, label, resource);
    if (refused !== undefined) return refused;
  }

  // A typed text (D-264): its shape first, as for a resource.
  const typed = target.kind === 'web' ? target.typed : undefined;
  if (typed !== undefined) {
    const refused = checkTypedShape(payload, label);
    if (refused !== undefined) return refused;
  }

  const texts: string[] = [];
  const parts: string[] = [];
  for (const fragment of payload) {
    const text = payloadText(fragment.value);
    if (text === undefined) {
      return block('unscannable', label, 'a fragment is not text or plain JSON', onBlock === 'notify-reference' ? onBlock : 'wait-user');
    }
    texts.push(text);
    parts.push(...scanParts(text, typeof fragment.value !== 'string'));
  }
  Object.freeze(texts);
  // An address carries its values %-encoded: the vault and the scanner read it decoded too (D-154).
  if (target.kind === 'link' || (target.kind === 'web' && target.page !== undefined)) {
    for (const text of texts) {
      try {
        parts.push(decodeURIComponent(text));
      } catch {
        return block('link-invalid', label, 'an address with a broken escape', 'stay-local');
      }
    }
  }
  // A resource (D-264): its address the same way, its body decoded as a form and as JSON too.
  let bodyParts: string[] = [];
  if (resource !== undefined) {
    const [address = '', body] = texts;
    try {
      parts.push(decodeURIComponent(address));
    } catch {
      return block('resource-invalid', label, 'an address with a broken escape', 'stay-local');
    }
    if (body !== undefined) {
      bodyParts = [body, ...bodyReadings(body)];
      parts.push(...bodyParts.slice(1));
    }
  }

  let refs: string[];
  try {
    refs = parts.flatMap((part) => secrets.find(part));
  } catch {
    return block('invalid-input', label, 'the known secrets could not be checked', 'stay-local');
  }
  if (refs.length > 0) {
    // References name secrets, they are not secrets: the reason can be logged.
    return block('secret', label, `payload contains the value of ${[...new Set(refs)].join(', ')}`, onBlock === 'notify-reference' ? onBlock : 'wait-user');
  }

  // The address of a link (D-154): chosen by the user, checked by its own rules whatever the label of its note.
  if (target.kind === 'link') return checkLink(payload, texts, label, target);

  if (locality === 'local') {
    // L3 is out already: local targets take everything else.
    return allow({ decision: 'allow', rule: 'local', label, reason: `${label} to a local target`, texts }, target);
  }

  if (!canUseCloud(context)) {
    return block('contaminated', label, `the session has read ${context.effective}: it stays local`, onBlock);
  }
  if (!canSendTo('cloud', label)) {
    return block('cloud-label', label, `${label} cannot go to a cloud target; at most L1`, onBlock);
  }

  // A resource (D-264): the consent of its page, then the scanner on the address and the body; never the second scanner.
  if (resource !== undefined) {
    if (resource.of === 'public' && (context.effective !== 'L0' || label !== 'L0')) {
      return block('page-consent', label, `a resource of a public page only from a public session, not ${maxLabel(context.effective, label)}`, 'stay-local');
    }
    const findings = [...addressFindings(texts[0] ?? ''), ...bodyParts.flatMap((part) => scanText(part))];
    if (findings.length > 0) {
      const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
      return block('scanner', label, `scanner matched: ${kinds}`, 'stay-local', findings);
    }
    const body = texts.length === 2 ? ', with a body' : '';
    return allow({ decision: 'allow', rule: 'resource', label, reason: `${label} ${resource.type} ${resource.method} of a page, ${resource.of} consent${body}, scan clean, no second check`, texts }, target);
  }

  // A page (D-262): one address the consent covers, scanned as written and decoded.
  if (target.kind === 'web' && target.page !== undefined) {
    const refused = checkPage(payload, texts, label, context, target.page);
    if (refused !== undefined) return refused;
  }

  // A typed text (D-264): the consent of its page, as for a page; nothing else to check before the scanners.
  if (typed === 'public' && (context.effective !== 'L0' || label !== 'L0')) {
    return block('page-consent', label, `text in a public page only from a public session, not ${maxLabel(context.effective, label)}`, 'stay-local');
  }

  const findings = parts.flatMap((part) => scanText(part));
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
    const next: NextStep = typed !== undefined ? 'stay-local' : onBlock === 'notify-reference' ? onBlock : 'wait-user';
    return block('scanner', label, `scanner matched: ${kinds}`, next, findings);
  }

  // The second scanner (D-113): only upwards, after every deterministic rule.
  // A text of the adopted catalogs, marked by the core in its own fragment, is
  // read by it as an empty text (D-250): every rule above read it as always.
  const exempt = piiExemptions(payload);
  const second = piiVerdict(pii, piiScanTexts(texts, exempt));
  const afterScan = onBlock === 'notify-reference' ? onBlock : 'wait-user';
  if (second.verdict === 'found') {
    const kinds = [...new Set(second.findings.map((finding) => finding.kind))].join(', ');
    return block('pii', label, `second scanner found personal data: ${kinds}`, afterScan, undefined, second.findings);
  }
  if (second.verdict === 'unavailable') {
    return block('pii-unavailable', label, `second check not available (${second.reason})`, afterScan);
  }
  const skipped = second.verdict === 'skipped' ? `, second check skipped on a development installation (${second.reason})` : '';
  const catalog = exempt.filter(Boolean).length;
  const unread = catalog === 0 ? '' : `, ${String(catalog)} catalog text${catalog === 1 ? '' : 's'} not read by the second check`;
  if (typed !== undefined) {
    return allow({ decision: 'allow', rule: 'typed', label, reason: `${label} text typed in a page, ${typed} consent, scan clean${skipped}${unread}`, texts }, target);
  }
  if (target.kind === 'web' && target.page !== undefined) {
    return allow({ decision: 'allow', rule: 'page', label, reason: `${label} page address, ${target.page.from} consent, scan clean${skipped}`, texts }, target);
  }
  return allow({ decision: 'allow', rule: 'cloud', label, reason: `${label} to a cloud target, scan clean${skipped}${unread}`, texts }, target);
}
